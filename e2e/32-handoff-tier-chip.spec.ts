// E2E (#300): unattended turns show what Zo could see — handoff continuation
// turns render the context-tier chip on their footers (tooltip states the
// capture reason), matching ordinary turns. Runs the real chaining loop
// against the mock's scripted handoff sequence (t1 → t2 → t3 done).

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";

test.describe("handoff continuation tier chip (#300)", () => {
  test("chained-turn footers carry the context-tier chip with the capture reason", async () => {
    const h = await openHarness({ freshProfile: true, viewport: { width: 460, height: 720 } });
    test.setTimeout(120_000);
    try {
      const panel = h.panel;

      // Start an unattended run — the mock chains t1 → t2 → t3 (done).
      await panel.locator("#query-input").fill("!handoff compare the pricing across these fixture pages");
      await panel.locator("#send-btn").click();

      // Wait for the run to finish: the run's terminal note lands.
      await expect(panel.locator("#messages").getByText(/Handoff done/).first()).toBeVisible({
        timeout: 90_000,
      });

      // Action-batch cards (→ click/navigate renders) share .msg-assistant —
      // they are execution renders, not Zo turns, and have no tier chip.
      const turns = panel.locator("#messages .msg-assistant").filter({ hasNot: panel.locator(".handoff-batch") });
      const turnCount = await turns.count();
      expect(turnCount).toBeGreaterThanOrEqual(3); // t1 + ≥2 continuations

      // EVERY Zo turn footer carries the context-tier chip — turn 1 via the
      // panel's own decision, continuations via the background's capture
      // stamp. No invisible-capture turns in an unattended run.
      for (let i = 0; i < turnCount; i++) {
        await expect(turns.nth(i).locator(".msg-footer .msg-footer-context")).toBeVisible();
      }

      // A continuation turn's chip states the capture reason in its tooltip.
      const lastChip = turns.nth(turnCount - 1).locator(".msg-footer .msg-footer-context");
      await expect(lastChip).toHaveAttribute("title", /handoff continuation capture/);
    } finally {
      await h.context.close();
    }
  });
});
