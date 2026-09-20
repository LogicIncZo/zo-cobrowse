// E2E (#299): failed turns persist — an active-chat stream error renders the
// Zo error card AND writes the {role:'error'} record, so the card survives a
// panel reload (previously the card was DOM-only and reload left an orphaned
// user bubble with no outcome). Retry from the reloaded card re-sends the
// failed turn.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery } from "./helpers/extension";

test.describe("error card persistence (#299)", () => {
  test("error card survives panel reload; Retry re-sends the failed turn", async () => {
    const h = await openHarness({ freshProfile: true });
    try {
      const panel = h.panel;

      // Fail a turn (mock Zo returns 401 for this prompt).
      await sendQuery(panel, "please return unauthorized");
      await expect(panel.locator(".error-card-title").first()).toContainText("Response interrupted", {
        timeout: 15_000,
      });
      await expect(panel.locator(".error-card-detail").first()).toContainText("401");

      // Reload — the card must come back from the persisted record.
      await panel.reload();
      await expect(panel.locator(".error-card-title").first()).toContainText("Response interrupted", {
        timeout: 15_000,
      });
      await expect(panel.locator(".error-card-detail").first()).toContainText("401");
      await expect(panel.locator("#messages .msg-error")).toHaveCount(1); // one record per failed turn

      // Retry from the reloaded card re-sends the failed turn.
      await panel.locator(".error-card-retry").first().click();
      await expect(panel.locator("#messages .msg-user").last()).toContainText("please return unauthorized");
      // The retry fails again (mock still 401s) → the new turn gets its own card.
      await expect(panel.locator("#messages .msg-error")).toHaveCount(2, { timeout: 15_000 });
    } finally {
      await h.context.close();
    }
  });
});
