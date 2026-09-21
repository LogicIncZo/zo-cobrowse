// E2E: the options page — Test Connection, the Prompts editor's live preview,
// and Reset-to-defaults — against the mock endpoints.
//
// seedExtensionConfig seeds zoApiUrl = ${E2E_BASE}/zo/ask, and Test Connection
// (plus the model/persona loaders) derive from that configured endpoint —
// never the hardcoded prod host (QA finding B). Test 1 asserts prod is
// NEVER hit.

import { test, expect } from "@playwright/test";
import { launchExtension, seedExtensionConfig, E2E_BASE } from "./helpers/extension";

test.describe("options page", () => {
  test("Test Connection hits the CONFIGURED endpoint, not hardcoded prod (QA finding B)", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      const page = await context.newPage();
      // The configured endpoint answers; any prod-host request is a FAILURE
      // signal — the field must drive the fetch.
      let prodHit = false;
      await page.route("https://api.zo.computer/**", (route) => {
        prodHit = true;
        return route.fulfill({ status: 500, contentType: "text/plain", body: "prod must not be called" });
      });
      await page.route(`${E2E_BASE}/zo/ask`, (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "ZO_OK" }),
      );
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // The Connection pane shows the configured endpoint in the new field.
      await expect(page.locator("#access-token")).toHaveValue(/.+/);
      await expect(page.locator("#api-endpoint")).toHaveValue(`${E2E_BASE}/zo/ask`);

      // Test Connection goes green against the configured URL.
      await page.click("#test-btn");
      await expect(page.locator("#status-message")).toContainText("Connection successful", { timeout: 10_000 });
      await expect(page.locator("#status-message")).toHaveClass(/ok/);
      expect(prodHit).toBe(false);

      // Saving persists the endpoint (storage.sync, non-sensitive).
      await page.click("button[type=submit]");
      await expect(page.locator("#status-message")).toContainText("Saved");
      const stored = await serviceWorker.evaluate(() =>
        new Promise((r) => chrome.storage.sync.get("zoApiUrl", (v) => r(v.zoApiUrl))),
      );
      expect(stored).toBe(`${E2E_BASE}/zo/ask`);
    } finally {
      await context.close();
    }
  });

  test("username + token (#339): hosts derive from the slug, Advanced overrides win, no owner-URL default", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      // Simulate a genuinely fresh profile: the harness seeds a space endpoint
      // for other specs; S1's default is NONE until the user picks a username.
      await serviceWorker.evaluate(() =>
        new Promise((r) => chrome.storage.local.remove("zoSpaceEndpoint", () => r(null))),
      );
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // Typing the username derives both hosts live (they sit in Advanced).
      await page.fill("#zo-username", "alice");
      await expect(page.locator("#space-endpoint")).toHaveValue("https://alice.zo.space");
      await expect(page.locator("#zo-web-origin")).toHaveValue("https://alice.zo.computer");

      await page.click("button[type=submit]");
      await expect(page.locator("#status-message")).toContainText("Saved");
      const stored = await serviceWorker.evaluate(
        () =>
          new Promise<any>((r) =>
            chrome.storage.local.get(["zoSpaceEndpoint"], (local) =>
              chrome.storage.sync.get(["zoUsername", "zoWebOrigin"], (sync) => r({ local, sync })),
            ),
          ),
      );
      expect(stored.local.zoSpaceEndpoint).toBe("https://alice.zo.space");
      expect(stored.sync.zoUsername).toBe("alice");
      expect(stored.sync.zoWebOrigin).toBe("https://alice.zo.computer");

      // Reload: username + derived hosts render back from storage.
      await page.reload();
      await expect(page.locator("#zo-username")).toHaveValue("alice");
      await expect(page.locator("#space-endpoint")).toHaveValue("https://alice.zo.space");

      // A hand-edited Advanced origin wins: it survives a username change
      // (the space host follows, the custom origin does not get clobbered).
      await page.locator("#connection-advanced summary").click();
      await page.fill("#zo-web-origin", "https://custom.example.org");
      await page.fill("#zo-username", "bob");
      await expect(page.locator("#space-endpoint")).toHaveValue("https://bob.zo.space");
      await expect(page.locator("#zo-web-origin")).toHaveValue("https://custom.example.org");
      await page.click("button[type=submit]");
      await expect(page.locator("#status-message")).toContainText("Saved");
      const after = await serviceWorker.evaluate(
        () => new Promise<any>((r) => chrome.storage.sync.get(["zoUsername", "zoWebOrigin"], (v) => r(v))),
      );
      expect(after.zoUsername).toBe("bob");
      expect(after.zoWebOrigin).toBe("https://custom.example.org");

      // Invalid slug → honest error, nothing saved.
      await page.fill("#zo-username", "Bad Slug!");
      await page.click("button[type=submit]");
      await expect(page.locator("#status-message")).toContainText("lowercase slug");
      const unbroken = await serviceWorker.evaluate(
        () => new Promise<any>((r) => chrome.storage.sync.get("zoUsername", (v) => r(v.zoUsername))),
      );
      expect(unbroken).toBe("bob");
    } finally {
      await context.close();
    }
  });

  test("Prompts editor previews the built prompt and saves overrides", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // The editor lives in the Prompts tab — open it first.
      await page.click(`#settings-nav .settings-tab[data-pane="pane-prompts"]`);
      await expect(page.locator("#pane-prompts")).toBeVisible();

      // The editor loads Modes via dynamic import; the preview paints
      const pre = page.locator("#prompt-preview-pre");
      await expect(pre).toContainText("You are Zo", { timeout: 10_000 });

      // Editing instructions updates the live preview
      const instr = page.locator("#prompt-instructions");
      await instr.fill("E2E INSTRUCTIONS MARKER");
      await expect(pre).toContainText("E2E INSTRUCTIONS MARKER", { timeout: 5_000 });

      // Save persists a sparse override (original built-ins untouched).
      // (#340: the editor has no scoped Save — the ONE global Save persists
      // the draft.)
      await page.click("button[type=submit]");
      await expect(page.locator("#status-message")).toContainText("Saved", { timeout: 5_000 });
      const stored = await serviceWorker.evaluate(() =>
        new Promise((r) => chrome.storage.local.get("cobrowse_mode_overrides", (v) => r(v.cobrowse_mode_overrides))),
      );
      expect(stored).toBeTruthy();

      // Reset-to-original deletes the override entry
      await page.click("#prompt-reset");
      await expect(page.locator("#prompt-status")).toContainText(/reset|original/i, { timeout: 5_000 });
      const afterReset = await serviceWorker.evaluate(() =>
        new Promise((r) => chrome.storage.local.get("cobrowse_mode_overrides", (v) => r(v.cobrowse_mode_overrides))),
      );
      expect(afterReset ?? {}).toEqual({});
    } finally {
      await context.close();
    }
  });

  test("Jev card (#341): renders dark by default, key stays local-only, Test probes the mocked endpoint", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // The card renders in the Connection pane; ships dark (off, no key).
      await expect(page.locator("#card-jev")).toBeVisible();
      await expect(page.locator("#jev-enabled")).not.toBeChecked();
      await expect(page.locator("#jev-api-key")).toHaveValue("");

      // Enable + key + model persist to the RIGHT storage areas on save.
      await page.check("#jev-enabled");
      await page.fill("#jev-api-key", "apik_e2e_secret");
      await page.fill("#jev-model", "jev-latest");
      await page.click("button[type=submit]");
      await expect(page.locator("#status-message")).toContainText("Saved");
      const areas = await serviceWorker.evaluate(
        () =>
          new Promise<any>((r) =>
            chrome.storage.local.get(["jevApiKey", "jevApiUrl"], (local) =>
              chrome.storage.sync.get(["jevEnabled", "jevModel", "jevPickConfidence", "jevDoneConfidence", "jevApiKey"], (sync) => r({ local, sync })),
            ),
          ),
      );
      expect(areas.local.jevApiKey).toBe("apik_e2e_secret");
      expect(areas.sync.jevApiKey).toBeUndefined(); // never synced
      expect(areas.sync.jevEnabled).toBe(true);
      expect(areas.sync.jevModel).toBe("jev-latest");

      // Test Jev probes the decide endpoint (mock server, seeded URL) and
      // reports latency honestly.
      await serviceWorker.evaluate(
        (base: string) => new Promise((r) => chrome.storage.local.set({ jevApiUrl: `${base}/v1/systemone` }, () => r(null))),
        E2E_BASE,
      );
      await page.click("#jev-test-btn");
      await expect(page.locator("#jev-status")).toContainText(/responded in \d+ms/i, { timeout: 10_000 });
    } finally {
      await context.close();
    }
  });

  test("one save (#340): a single sticky Save from any tab; mode switch persists the outgoing draft", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // Exactly ONE submit button exists, and it is visible from a tab far
      // from the bottom of the page (sticky bar).
      expect(await page.locator("button[type=submit]").count()).toBe(1);
      await page.click(`#settings-nav .settings-tab[data-pane="pane-features"]`);
      await expect(page.locator("button[type=submit]")).toBeVisible();

      // Prompts editor: an edited draft persists on MODE SWITCH (no silent
      // loss) — the override lands without any explicit save.
      await page.click(`#settings-nav .settings-tab[data-pane="pane-prompts"]`);
      const pre = page.locator("#prompt-preview-pre");
      await expect(pre).toContainText("You are Zo", { timeout: 10_000 });
      await page.locator("#prompt-instructions").fill("SWITCH-PERSIST MARKER");
      await page.locator("#prompt-mode-select").selectOption({ index: 1 });
      const stored = await serviceWorker.evaluate(
        () => new Promise((r) => chrome.storage.local.get("cobrowse_mode_overrides", (v) => r(v.cobrowse_mode_overrides))),
      );
      expect(JSON.stringify(stored ?? {})).toContain("SWITCH-PERSIST MARKER");
      // The newly-selected mode is now shown (the switch completed).
      await expect(page.locator("#prompt-mode-select")).not.toHaveValue("cobrowse");
    } finally {
      await context.close();
    }
  });

  test("settings usability: section tabs, token reveal, runtime version, dirty indicator", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // Tabbed UI: every tab button has a pane; clicking shows exactly that
      // pane (others hidden); the last tab persists across a reload.
      const tabButtons = page.locator("#settings-nav .settings-tab");
      await expect(tabButtons.first()).toBeVisible();
      const count = await tabButtons.count();
      expect(count).toBeGreaterThanOrEqual(5);
      await expect(page.locator("#pane-connection")).toBeVisible();
      await tabButtons.nth(3).click(); // Features
      await expect(page.locator("#pane-features")).toBeVisible();
      await expect(page.locator("#pane-connection")).toBeHidden();
      await expect(page.locator("#card-features")).toBeVisible();
      await expect(page.locator("#card-write")).toBeVisible();
      await page.reload();
      await expect(page.locator("#pane-features")).toBeVisible();
      await expect(page.locator("#pane-connection")).toBeHidden();
      // A #card-* deep link still lands on the right pane.
      await page.goto(`chrome-extension://${extensionId}/options.html#card-about`);
      await expect(page.locator("#pane-about")).toBeVisible();
      await expect(page.locator("#card-about")).toBeVisible();

      // Token reveal: password by default, toggles to text and back (the
      // token field lives in the Connection pane — switch back to it).
      await page.click(`#settings-nav .settings-tab[data-pane="pane-connection"]`);
      await expect(page.locator("#access-token")).toHaveAttribute("type", "password");
      await page.click("#token-toggle");
      await expect(page.locator("#access-token")).toHaveAttribute("type", "text");
      await expect(page.locator("#token-toggle")).toHaveText("Hide");
      await page.click("#token-toggle");
      await expect(page.locator("#access-token")).toHaveAttribute("type", "password");

      // Version comes from the live manifest, not a hardcoded string.
      await page.click(`#settings-nav .settings-tab[data-pane="pane-about"]`);
      await expect(page.locator("#ext-version")).toHaveText(/^v\d+\.\d+/, { timeout: 5_000 });

      // Dirty indicator: editing a form-only field flags the Save buttons;
      // saving clears it (and the toast is visible — fixed position).
      // (#339: the endpoint fields live in the Advanced details — open it.)
      await page.click(`#settings-nav .settings-tab[data-pane="pane-connection"]`);
      await expect(page.locator("button[type=submit].save-dirty")).toHaveCount(0);
      await page.locator("#connection-advanced summary").click();
      await page.fill("#space-endpoint", "https://example.zo.space");
      await expect(page.locator("button[type=submit].save-dirty").first()).toBeVisible();
      await page.click("button[type=submit]");
      await expect(page.locator("#status-message")).toContainText("Saved");
      await expect(page.locator("button[type=submit].save-dirty")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("TTS voice picker: honest zero-voice state (#64)", async () => {
    const { context, extensionId } = await launchExtension({ freshProfile: true });
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      await page.click(`#settings-nav .settings-tab[data-pane="pane-features"]`);
      const voice = page.locator("#tts-voice");
      await expect(voice).toBeVisible();
      // Headless Chromium ships zero TTS voices — the picker says so instead
      // of offering a bare "System default" that silently does nothing.
      await expect(voice).toBeDisabled();
      await expect(page.locator("#tts-voice-hint")).toContainText("No TTS voices");
    } finally {
      await context.close();
    }
  });
});
