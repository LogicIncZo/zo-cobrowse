// E2E (user rule): after filling a form, Zo must NEVER click the form's
// action button — on ANY page, not just sensitive ones. The mock model
// proposes fill + click on a plain type=button; the hard backstop has to
// block it: the button never fires, and the timeline shows the block.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, waitForTurnComplete } from "./helpers/extension";

test.describe("no action-button clicks after fill", () => {
  test("post-fill click on the form button is blocked; the user clicks", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      await sendQuery(h.panel, "fill the name then click submit");

      // The fill executed on the real page.
      await expect(h.site.locator("#name")).toHaveValue("Click Block", { timeout: 20_000 });

      // The click on #submit-btn was blocked: the form was never submitted.
      await expect(h.site.locator("#form-result")).toBeEmpty({ timeout: 5000 });

      // The timeline records the block visibly.
      await expect(h.panel.locator("#action-timeline")).toContainText(/blocked action-button/i, { timeout: 20_000 });

      await waitForTurnComplete(h.panel);
    } finally {
      await h.context.close();
    }
  });
});
