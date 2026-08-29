// E2E ("ux polish" round): user-facing usability additions, verified in the
// real extension on real Chromium —
//   1. empty-state starter chips prefill the composer on a fresh chat
//   2. assistant footer shows the context-tier chip (🔗 URL only …)
//   3. follow-up excerpt dedup: turn 2's prompt carries the T1 manifest line
//      as "already provided above" — the 500-char excerpt is NOT re-sent
//   4. fenced code blocks get a Copy button; clicking really copies
//   5. ⬇ Latest pill appears when scrolled away from the bottom, snaps back
//
// The sidepanel opens as a tab (documented workaround — see helpers).

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, recordedAsks } from "./helpers/extension";

test.describe("ux polish", () => {
  test("empty-state chips, context chip, excerpt dedup, code copy, jump-to-latest", async () => {
    const h = await openHarness({ freshProfile: true, viewport: { width: 480, height: 640 } });
    try {
      const panel = h.panel;

      // 1. Fresh chat: starter chips render; clicking one prefills the composer.
      const chips = panel.locator(".empty-state-chip");
      await expect(chips).toHaveCount(4);
      await chips.first().click();
      await expect(panel.locator("#query-input")).toHaveValue("Summarize this page");

      // 2. Turn 1 (read → tier 0): footer context chip shows "URL only".
      await sendQuery(panel, "Summarize this page");
      await panel
        .locator("#messages .msg-assistant .msg-footer")
        .last()
        .waitFor({ state: "visible", timeout: 20_000 });
      await expect(panel.locator("#messages .msg-assistant .msg-footer-context").last()).toContainText("URL only");

      // 3. Turn 2 (same page): prompt reuses the T1 ref without the excerpt.
      await sendQuery(panel, "Tell me more about the page");
      await panel
        .locator("#messages .msg-assistant .msg-footer")
        .last()
        .waitFor({ state: "visible", timeout: 20_000 });
      const asks = await recordedAsks();
      const inputs = asks.map((r) => String(r.body?.input || ""));
      expect(inputs.some((i) => i.includes("Excerpt:"))).toBe(true); // turn 1 sent the excerpt
      const last = inputs[inputs.length - 1];
      expect(last).toContain("## Referenced Tabs");
      expect(last).toContain("already provided above");
      expect(last).not.toContain("Excerpt:"); // deduped — no duplicate tokens

      // 4. Fenced code answer gets a Copy button; clicking copies for real.
      await sendQuery(panel, "Show me a code sample");
      const copyBtn = panel.locator("#messages .msg-assistant pre .code-copy-btn").last();
      await copyBtn.waitFor({ state: "visible", timeout: 20_000 });
      await h.context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await copyBtn.click();
      await expect(copyBtn).toHaveText("Copied ✓");
      const clip = await panel.evaluate(() => navigator.clipboard.readText());
      expect(clip).toContain("console.log('hello zo');");

      // 5. Scroll away from the bottom → ⬇ Latest appears; click snaps back.
      await panel.evaluate(() => {
        const m = document.querySelector("#messages");
        m.scrollTop = 0;
      });
      await expect(panel.locator("#jump-latest")).toBeVisible();
      await panel.locator("#jump-latest").click();
      await panel.waitForFunction(() => {
        const m = document.querySelector("#messages");
        return m.scrollHeight - m.scrollTop - m.clientHeight < 240;
      });
      await expect(panel.locator("#jump-latest")).toBeHidden();
    } finally {
      await h.context.close();
    }
  }, 45_000);
});
