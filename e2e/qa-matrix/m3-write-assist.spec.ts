// QA matrix m3 — write-assist lifecycle variants beyond the scripted e2e
// (16-write-assist covers textarea + contenteditable happy paths):
//   • dismissing the popover (Escape) never wedges the widget — reopening on
//     the same field still enhances + fills
//   • two enhance rounds record two threadless one-shot asks (no conversation
//     threading ever rides the write-assist payload)

import { test, expect } from "@playwright/test";
import { openHarness, recordedAsks, clearRecordedRequests, type ExtensionHarness } from "../helpers/extension";

let h: ExtensionHarness;
test.beforeAll(async () => {
  h = await openHarness({ freshProfile: true, sitePath: "/writing.html" });
});
test.afterAll(async () => {
  await h?.context.close();
});
// The mock server accumulates __requests across runs (reuseExistingServer) —
// scope the ask counts to this run.
test.beforeEach(async () => {
  await clearRecordedRequests();
});

test("Escape dismisses the popover; the widget stays reusable", async () => {
  const ta = h.site.locator("#proj");
  await ta.click();
  await ta.fill("draft one");
  await h.site.locator(".zo-wa-icon").click();
  const pop = h.site.locator(".zo-wa-pop");
  await expect(pop).toBeVisible();
  await h.site.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  // Escape also hides the icon: focus sits in the shadow popover input, so
  // document.activeElement is the host and the widget treats the field as
  // unfocused (content.js waClose). Refocusing the field re-arms the icon —
  // that is the contract, not a bug.
  await ta.click();
  await expect(h.site.locator(".zo-wa-icon")).toBeVisible();

  // Reopen on the same field — full happy path must still work.
  await h.site.locator(".zo-wa-icon").click();
  await expect(pop).toBeVisible();
  await pop.locator(".zo-wa-instr").fill("punch it up");
  await pop.locator("button", { hasText: "Enhance" }).click();
  await expect(pop.locator(".zo-wa-result")).toBeVisible({ timeout: 15_000 });
  await pop.locator("button", { hasText: "Accept" }).click();
  await expect(ta).not.toHaveValue("draft one");
});

test("two enhance rounds record two threadless one-shot asks", async () => {
  await h.site.locator("#proj").click();
  for (let round = 1; round <= 2; round++) {
    await h.site.locator(".zo-wa-icon").click();
    const pop = h.site.locator(".zo-wa-pop");
    await expect(pop).toBeVisible();
    await pop.locator(".zo-wa-instr").fill(`round ${round}`);
    await pop.locator("button", { hasText: "Enhance" }).click();
    await expect(pop.locator(".zo-wa-result")).toBeVisible({ timeout: 15_000 });
    await pop.locator("button", { hasText: "Accept" }).click();
  }
  const asks = await recordedAsks();
  const enhanceAsks = asks.filter((r: any) => String(r.body?.input || "").includes("write-assist"));
  expect(enhanceAsks.length).toBeGreaterThanOrEqual(2);
  for (const a of enhanceAsks) {
    expect(a.body?.conversation_id ?? a.body?.chatId).toBeFalsy();
  }
});
