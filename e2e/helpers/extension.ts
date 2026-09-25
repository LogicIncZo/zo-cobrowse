// Shared Playwright helpers: launch the real extension, seed its config at
// the mock server, open the sidepanel as a tab, and drive a chat turn.
//
// Sidepanel-as-tab is the documented workaround for Chrome side panels not
// being drivable over CDP; opening the panel tab LAST and calling
// bringToFront() on the fixture page keeps the WEBSITE as the active tab
// (what GET_PAGE_CONTEXT's tabs.query resolves) exactly like real usage.

import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";

export const E2E_BASE = process.env.E2E_BASE || "http://127.0.0.1:3179";
// ZO_E2E_EXT overrides the loaded extension dir — A/B probes against a
// shipped build (e.g. reproduce a regression on the last release tag).
const EXTENSION_DIR = process.env.ZO_E2E_EXT || new URL("../../extension/", import.meta.url).pathname;

export interface ExtensionHarness {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  /** The sidepanel, opened as a tab. */
  panel: Page;
  /** The active website tab (what capture/actions operate on). */
  site: Page;
  askUrl: (path: string) => string;
}

/** Requests the mock Zo server has recorded (see e2e/mock-zo/server.mjs). */
export async function recordedAsks(): Promise<any[]> {
  const res = await fetch(`${E2E_BASE}/__requests`);
  const list = await res.json();
  return list.filter((r: any) => r.url === "/zo/ask");
}

export async function clearRecordedRequests(): Promise<void> {
  await fetch(`${E2E_BASE}/__requests`, { method: "DELETE" });
}

async function resolveExtension(context: BrowserContext): Promise<{ worker: Worker; id: string }> {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const url = worker.url(); // chrome-extension://<id>/background.js
  return { worker, id: new URL(url).host };
}

/** Launch Chromium with the real extension loaded (MV3 new-headless).
 * `viewport`/`recordVideo` pass straight through to the persistent context
 * (config-level `use` options don't reach launchPersistentContext) — used by
 * the demo-recording spec; the video finalizes on context.close(). */
export async function launchExtension(opts: {
  freshProfile?: boolean;
  viewport?: { width: number; height: number };
  recordVideo?: { dir: string; size?: { width: number; height: number } };
} = {}): Promise<{ context: BrowserContext; extensionId: string; serviceWorker: Worker }> {
  const profileDir = opts.freshProfile
    ? `/tmp/zo-e2e-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`
    : "/tmp/zo-e2e-profile-default";
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    // Full Chromium's "new headless" — the only headless that runs MV3
    // extensions (the default headless shell has no extension support).
    channel: "chromium",
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.recordVideo ? { recordVideo: opts.recordVideo } : {}),
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-sandbox",
    ],
  });
  const { worker, id } = await resolveExtension(context);
  return { context, extensionId: id, serviceWorker: worker };
}

/** Seed the extension's config through the real service worker (awaits storage).
 *
 * Storage layout matches background.js:
 *   storage.local (sensitive): zoAccessToken, zoSpaceEndpoint
 *   storage.sync  (non-sensitive): zoApiUrl, zoModel, zoPersonaId, zoActiveMode, ...
 */
export async function seedExtensionConfig(sw: Worker, extra: Record<string, unknown> = {}): Promise<void> {
  await sw.evaluate(
    (cfg: any) =>
      new Promise<void>((resolve) => {
        chrome.storage.local.set(
          {
            zoAccessToken: ["e2e", "token"].join("-"),
            zoSpaceEndpoint: cfg.zoSpaceEndpoint,
          },
          () => {
            chrome.storage.sync.set(
              {
                cobrowse_onboarding_done: true,
                zoApiUrl: cfg.zoApiUrl,
                ...(cfg.sync || {}),
              },
              () => resolve(),
            );
          },
        );
      }),
    { zoApiUrl: `${E2E_BASE}/zo/ask`, zoSpaceEndpoint: E2E_BASE, sync: {}, ...extra },
  );
}

/** Activate the fixture-site tab from INSIDE the panel page (it holds the
 * tabs permission; service-worker evaluate is unreliable from the test
 * runner). Runs entirely in-page, so the panel tab never gains focus. */
async function activateSiteTab(panel: Page): Promise<void> {
  await panel.evaluate(
    (prefix: string) =>
      new Promise<void>((resolve) => {
        chrome.tabs.query({}, (tabs: any[]) => {
          const site = tabs.find((t) => (t.url || "").startsWith(prefix));
          if (site) chrome.tabs.update(site.id, { active: true }, () => resolve());
          else resolve();
        });
      }),
    E2E_BASE,
  );
}

/** Open the fixture site + the sidepanel (as a tab), site kept active.
 *
 * Order: site first (it becomes active), then the panel tab (opening a tab
 * makes IT active), then re-activate the site from inside the panel so
 * `chrome.tabs.query({active:true})` resolves to the website — exactly like
 * real usage where the side panel is a docked panel, not a tab.
 */
export async function openHarness(opts: {
  freshProfile?: boolean;
  sitePath?: string;
  viewport?: { width: number; height: number };
  recordVideo?: { dir: string; size?: { width: number; height: number } };
} = {}): Promise<ExtensionHarness> {
  const { context, extensionId, serviceWorker } = await launchExtension(opts);
  await seedExtensionConfig(serviceWorker);

  const site = await context.newPage();
  await site.goto(`${E2E_BASE}${opts.sitePath || "/"}`);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // Wait for finishInit to complete before touching tab activation — the
  // chrome.tabs.onActivated listener (which adopts the site for display)
  // registers late in init (~1.5s, after checkPendingQuery's retry loop), and
  // activating the site earlier would fire an event nobody hears.
  await expect(panel.locator("#prompt-preview")).not.toBeEmpty({ timeout: 20_000 });
  await activateSiteTab(panel); // onActivated → adoptActiveTabDisplay(site)

  await expect(panel.locator("#page-url")).toContainText("Fixture", { timeout: 15_000 });
  return { context, serviceWorker, extensionId, panel, site, askUrl: (p) => `${E2E_BASE}${p}` };
}

/** Type a query and send it — entirely in-page so the panel tab never gains
 * focus (Playwright-level fill/click can activate the panel tab, which would
 * make it the "active tab" the extension captures). Re-activates the site
 * tab first so the send-time refreshPageContext captures the website.
 * Retries the click while the send button is disabled (e.g. a previous
 * action run is still finishing → actionRunning). */
export async function sendQuery(panel: Page, text: string): Promise<void> {
  await panel.evaluate(
    (args: { prefix: string; text: string }) =>
      new Promise<void>((resolve) => {
        const start = () => {
          const input = document.querySelector("#query-input") as HTMLTextAreaElement | null;
          if (!input) { resolve(); return; }
          input.value = args.text;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          // Let syncSendBtn + the debounced inspector react, then click send
          // (retrying while an action run keeps the button disabled).
          const tryClick = (attempt: number) => {
            const btn = document.querySelector("#send-btn") as HTMLButtonElement | null;
            if (btn && !btn.disabled) { btn.click(); resolve(); return; }
            if (attempt >= 80) resolve(); // ~8s give-up
            else setTimeout(() => tryClick(attempt + 1), 100);
          };
          setTimeout(() => tryClick(0), 60);
        };
        chrome.tabs.query({}, (tabs: any[]) => {
          const site = tabs.find((t) => (t.url || "").startsWith(args.prefix));
          if (site) chrome.tabs.update(site.id, { active: true }, start);
          else start();
        });
      }),
    { prefix: E2E_BASE, text },
  );
}

/** Wait until the in-flight turn is fully complete: the assistant footer only
 * renders at STREAM_DONE (after persistence), so this is the "safe to
 * reload / assert history" signal. */
export async function waitForTurnComplete(panel: Page, timeout = 20_000): Promise<void> {
  await panel
    .locator("#messages .msg-assistant .msg-footer")
    .last()
    .waitFor({ state: "visible", timeout });
}

/** The fixture page the extension should capture — used for prompt asserts. */
export async function lastAskBody(): Promise<any> {
  const asks = await recordedAsks();
  return asks[asks.length - 1]?.body ?? null;
}

/**
 * Switch the panel's Mode WITHOUT Playwright selectOption: the panel's
 * native <select> is hidden behind the #304/#62 shim, and selectOption on a
 * hidden select deterministically kills new-headless Chromium (whole window:
 * qa finding qa-mode-switch-page-death, A/B-verified on v0.3.5.0 + dev).
 * Dispatch the change from the page instead — the exact user-visible path.
 */
export async function setPanelMode(panel: Page, modeId: string): Promise<void> {
  await panel.evaluate((id: string) => {
    const s = document.getElementById("mode-select") as HTMLSelectElement | null;
    if (!s) throw new Error("no #mode-select");
    const opt = [...s.options].find((o) => o.value === id);
    if (!opt) throw new Error(`no such mode: ${id}`);
    s.value = opt.value;
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, modeId);
  await panel.waitForTimeout(300);
}
