// E2E: #25 UX — the 📷 Image toggle by the tab strip. Arming it flips the
// MODE dropdown to Visual, the next send rides a REAL captureVisibleTab
// screenshot (data URL in the /zo/ask wire body), and the toggle auto-clears
// (send-once). This is the user-facing path behind the manual
// `!context`+Visual recipe — no bang, no mode hunting.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, waitForTurnComplete, lastAskBody, type ExtensionHarness } from "./helpers/extension";

// Headless Chromium fails image readback for captureVisibleTab unless
// --disable-gpu is passed (with <all_urls> in host_permissions — Chrome
// REQUIRES <all_urls> or an activeTab gesture for captureVisibleTab; scoped
// wildcards like http://*/* + https://*/* do NOT qualify, real Chrome
// included). The unit of interest here is the extension's transport, not the
// compositor, so the service worker's capture is patched with a tiny real
// JPEG and everything downstream (vision gate → prompt embed → wire body)
// stays real.
const FAKE_SHOT =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAoAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlqKKK+mPJCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//9k=";

async function patchCapture(h: ExtensionHarness): Promise<void> {
  await h.serviceWorker.evaluate((dataUrl: string) => {
    (chrome.tabs as any).captureVisibleTab = async () => dataUrl;
  }, FAKE_SHOT);
}

let h: ExtensionHarness;

test.beforeAll(async () => {
  h = await openHarness({ freshProfile: true });
  await patchCapture(h);
});

test.afterAll(async () => {
  await h?.context.close();
});

test.describe("📷 Image toggle (send-once screenshot)", () => {
  test("arm → Visual mode + tier-3 screenshot on the wire → auto-clear", async () => {
    // Arm in-page (Playwright-level click would activate the panel tab).
    await h.panel.evaluate(() => document.querySelector<HTMLElement>("#shot-toggle")?.click());
    await expect(h.panel.locator("#shot-toggle")).toHaveAttribute("aria-pressed", "true");
    // Arming flipped the Mode to Visual.
    await expect(h.panel.locator("#mode-select")).toHaveValue("visual", { timeout: 5_000 });
    // Inspector mirrors the force before the send (preview = send).
    await expect(h.panel.locator("#prompt-inspector-meta")).toContainText("Screenshot", { timeout: 5_000 });

    await sendQuery(h.panel, "what color is the header bar?");
    await waitForTurnComplete(h.panel, 30_000);

    // The wire body carried a real screenshot: the composed prompt embeds the
    // captureVisibleTab data URL (tier 3) and uses the Visual mode's system
    // prompt (effectiveTier/modeId are sidepanel↔background message fields,
    // not wire fields — the prompt IS the observable).
    const body = await lastAskBody();
    expect(String(body.input || "")).toMatch(/data:image\/jpeg;base64,/);
    expect(String(body.input || "")).toContain("what is visible on the user's screen");

    // User bubble shows the 📷 Screenshot pill; assistant footer the 📷 chip.
    await expect(
      h.panel.locator("#messages .msg-user").last().locator(".msg-mention", { hasText: "Screenshot" }),
    ).toBeVisible();
    await expect(h.panel.locator("#messages .msg-assistant").last().locator(".msg-footer-shot")).toBeVisible();

    // Send-once: the toggle auto-cleared; Mode stays Visual (visible choice).
    await expect(h.panel.locator("#shot-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect(h.panel.locator("#mode-select")).toHaveValue("visual");
  });

  test("unchecking before send restores the previous Mode", async () => {
    // Test 1 leaves Mode on Visual (tier 3 — arming won't switch). Pick a
    // non-visual Mode explicitly so restore has something to restore to.
    await h.panel.evaluate(() => {
      const ms = document.querySelector<HTMLSelectElement>("#mode-select");
      if (ms) {
        ms.value = "summarize";
        ms.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await expect(h.panel.locator("#mode-select")).toHaveValue("summarize", { timeout: 5_000 });
    await h.panel.evaluate(() => document.querySelector<HTMLElement>("#shot-toggle")?.click());
    await expect(h.panel.locator("#mode-select")).toHaveValue("visual", { timeout: 5_000 });
    await h.panel.evaluate(() => document.querySelector<HTMLElement>("#shot-toggle")?.click());
    await expect(h.panel.locator("#shot-toggle")).toHaveAttribute("aria-pressed", "false");
    // Test 1 leaves Mode on Visual (tier 3 — arming won't switch). Pick a
    // non-visual Mode explicitly so restore has something to restore to.
    await h.panel.evaluate(() => {
      const ms = document.querySelector<HTMLSelectElement>("#mode-select");
      if (ms) {
        ms.value = "summarize";
        ms.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await expect(h.panel.locator("#mode-select")).toHaveValue("summarize", { timeout: 5_000 });
    await h.panel.evaluate(() => document.querySelector<HTMLElement>("#shot-toggle")?.click());
    await expect(h.panel.locator("#mode-select")).toHaveValue("visual", { timeout: 5_000 });
    await h.panel.evaluate(() => document.querySelector<HTMLElement>("#shot-toggle")?.click());
    await expect(h.panel.locator("#shot-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect(h.panel.locator("#mode-select")).toHaveValue("summarize", { timeout: 5_000 });
    // Inspector back to the unforced decision (no "forced" reason string).
    await expect(h.panel.locator("#prompt-inspector-meta")).not.toContainText("forced", { timeout: 5_000 });
  });

  test("capture failure surfaces an honest warning — no pill, no chip", async () => {
    // Re-create the pre-fix real-Chrome failure inside the SW: the gate
    // passes (unknown → capture) but captureVisibleTab throws the exact
    // permission error the scoped-host_permissions manifest produced.
    await h.serviceWorker.evaluate(() => {
      (chrome.tabs as any).captureVisibleTab = async () => {
        throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
      };
    });

    await h.panel.evaluate(() => document.querySelector<HTMLElement>("#shot-toggle")?.click());
    await expect(h.panel.locator("#shot-toggle")).toHaveAttribute("aria-pressed", "true");
    await sendQuery(h.panel, "what color is the header bar?");
    await waitForTurnComplete(h.panel, 30_000);

    // An honest system warning names the failure — the turn never pretends
    // the image shipped.
    await expect(h.panel.locator("#messages .msg-system").last()).toContainText(
      "Screenshot did not ride this turn", { timeout: 10_000 },
    );
    // The user bubble carries NO 📷 Screenshot pill…
    const pills = await h.panel.locator("#messages .msg-user").last().locator(".msg-mention").allTextContents();
    expect(pills.some((t) => t.includes("Screenshot"))).toBe(false);
    // …and the assistant footer carries no 📷 chip.
    await expect(h.panel.locator("#messages .msg-assistant").last().locator(".msg-footer-shot")).toHaveCount(0);

    // Restore the working capture for any later specs.
    await patchCapture(h);
  });
});
