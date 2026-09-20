// E2E (#312): the Theme card lives in the About pane as "Appearance" — an
// interface-appearance setting, not account config. Select id unchanged;
// changing it still live-updates the open panel without reload (#65).

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";

test.describe("theme card placement (#312)", () => {
  test("theme select lives in About; change live-updates the panel", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const opts = await h.context.newPage();
      await opts.goto(`chrome-extension://${h.extensionId}/options.html`);
      await opts.waitForLoadState("load");

      // Connection pane no longer hosts the theme card (hidden panes keep
      // their DOM, so assert visibility — not count).
      await opts.locator('#settings-nav .settings-tab[data-pane="pane-connection"]').click();
      await expect(opts.locator("#options-theme")).toBeHidden();

      // About pane hosts it as "Appearance".
      await opts.locator('#settings-nav .settings-tab[data-pane="pane-about"]').click();
      await expect(opts.locator("#card-appearance")).toBeVisible();
      await expect(opts.locator("#card-appearance h2")).toContainText("Appearance");
      await expect(opts.locator("#options-theme")).toBeVisible();

      // Changing it live-updates the open PANEL without reload (#65).
      await opts.locator("#options-theme").selectOption("sepia");
      await expect(opts.locator("html")).toHaveAttribute("data-theme", "sepia");
      await expect(h.panel.locator("html")).toHaveAttribute("data-theme", "sepia", { timeout: 10_000 });

      // Deep-link + last-tab persistence machinery still functions: hashchange
      // lands on the right pane and the last tab persists across a reload.
      await opts.evaluate(() => {
        location.hash = "#card-appearance";
      });
      await expect(opts.locator("#pane-about")).toBeVisible();
      await opts.reload();
      await opts.waitForLoadState("load");
      await expect(opts.locator("#pane-about")).toBeVisible(); // last tab restored
    } finally {
      await h.context.close();
    }
  });
});
