// E2E: first-run onboarding tour — fresh profile, tour shows, skip works,
// chat view becomes usable. (Runs first alphabetically; later specs seed the
// onboarding flag directly, so they don't depend on this one.)

import { test, expect } from "@playwright/test";
import { launchExtension, seedExtensionConfig } from "./helpers/extension";

test.describe("onboarding (fresh profile)", () => {
  test("tour shows on first run; Skip lands in the chat view", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      // Seed the mock endpoints but NOT the onboarding flag.
      await seedExtensionConfig(serviceWorker, { sync: { cobrowse_onboarding_done: false } });

      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

      await expect(panel.locator("#onboarding-view")).toBeVisible({ timeout: 15_000 });
      await expect(panel.locator("#ob-title")).toContainText("Welcome to Zo Co-browse");

      // #313: walk to step 3 (token step) — it must carry a REAL affordance
      // ("Open settings") and reference NO nonexistent UI.
      await panel.click("#ob-next");
      await panel.click("#ob-next");
      await expect(panel.locator("#ob-title")).toContainText("Add Your API Token");
      await expect(panel.locator("#ob-open-settings")).toBeVisible();
      const body3 = await panel.locator("#ob-body").textContent();
      expect(body3).not.toContain("gear icon");
      await panel.click("#ob-open-settings");
      // openOptionsPage lands on the extension's options page.
      await panel.waitForTimeout(800);
      const pages = panel.context().pages().map((pg) => pg.url());
      expect(pages.some((u) => u.includes("options.html"))).toBe(true);

      // Step 4 likewise (Test Connection lives in options, not the panel).
      await panel.bringToFront();
      await panel.click("#ob-next");
      await expect(panel.locator("#ob-title")).toContainText("Test Your Connection");
      await expect(panel.locator("#ob-open-settings")).toBeVisible();
      const body4 = await panel.locator("#ob-body").textContent();
      expect(body4).not.toContain("Test Connection below");

      // Skip the tour → chat view + composer ready
      await panel.click("#ob-skip");
      await expect(panel.locator("#chat-view")).toBeVisible();
      await expect(panel.locator("#query-input")).toBeEnabled();
      // The flag persisted for future runs
      const flag = await serviceWorker.evaluate(() => new Promise((r) => chrome.storage.sync.get("cobrowse_onboarding_done", (v) => r(v.cobrowse_onboarding_done))));
      expect(flag).toBe(true);
    } finally {
      await context.close();
    }
  });
});
