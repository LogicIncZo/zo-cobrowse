// E2E: error & cancel paths — the panel must never hang or lie.
//   • Esc cancels an in-flight stream from ANYWHERE in the panel (#133),
//     not just with the composer focused
//   • 401 renders the error card (non-retriable — no retry loop)
//   • a failed action shows the error class + reason; the turn still completes
//   • conversation threading: follow-up turns carry the conversation_id echo

import { test, expect } from "@playwright/test";
import {
  openHarness,
  sendQuery,
  recordedAsks,
  clearRecordedRequests,
  waitForTurnComplete,
  E2E_BASE,
  type ExtensionHarness,
} from "./helpers/extension";

let h: ExtensionHarness;

test.beforeAll(async () => {
  h = await openHarness({ freshProfile: true });
});

test.afterAll(async () => {
  await h?.context.close();
});

test.describe("error & cancel paths", () => {
  test("Esc cancels mid-stream with the composer focused; panel is not stuck", async () => {
    await sendQuery(h.panel, "answer slowly: long running question");
    await expect(h.panel.locator("#messages .msg-streaming-text").first()).toBeVisible({ timeout: 15_000 });
    await h.panel.evaluate(() => {
      const input = document.querySelector("#query-input") as HTMLTextAreaElement;
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await h.panel.waitForTimeout(400);
    await expect(h.panel.locator("#query-input")).toBeEnabled();
    // The cancelled turn must NOT finalize (no footer = no persisted turn).
    await expect(h.panel.locator("#messages .msg-assistant .msg-footer")).toHaveCount(0);
    // Panel still works: a follow-up completes normally.
    await sendQuery(h.panel, "what is this page?");
    await waitForTurnComplete(h.panel, 20_000);
    await expect(h.panel.locator("#messages .msg-assistant .msg-body").last()).toContainText("mock answer");
  });

  test("Esc cancels mid-stream with focus OUTSIDE the composer (#133)", async () => {
    // Earlier turns in this profile already finalized with footers — snapshot
    // the count and assert the cancel adds NO new one.
    const footersBefore = await h.panel.locator("#messages .msg-assistant .msg-footer").count();
    await sendQuery(h.panel, "answer slowly: another long question");
    await expect(h.panel.locator("#messages .msg-streaming-text").first()).toBeVisible({ timeout: 15_000 });
    // Move focus out of the composer (click a message), then press Esc —
    // the advertised "Press Esc to stop" must still work.
    await h.panel.locator("#messages").click({ position: { x: 30, y: 30 } });
    await h.panel.keyboard.press("Escape");
    await h.panel.waitForTimeout(400);
    await expect(h.panel.locator("#query-input")).toBeEnabled();
    await expect(h.panel.locator("#messages .msg-assistant .msg-footer")).toHaveCount(footersBefore);
  });

  test("401 from the API renders an error card, not a hang", async () => {
    await clearRecordedRequests();
    await sendQuery(h.panel, "please return unauthorized");
    await expect(h.panel.locator(".error-card-title").first()).toContainText("Response interrupted", { timeout: 15_000 });
    await expect(h.panel.locator(".error-card-detail").first()).toContainText("401");
    await expect(h.panel.locator("#query-input")).toBeEnabled();
  });

  test("failed action (missing element) shows the error card state and the turn still completes", async () => {
    // Move the site to form.html — #status-card does not exist there.
    await h.site.goto(`${E2E_BASE}/form.html`);
    await h.panel.waitForTimeout(800);
    await sendQuery(h.panel, "extract the status card");
    await waitForTurnComplete(h.panel, 20_000);
    const timeline = h.panel.locator("#messages .msg-action-run").last();
    await expect(timeline).toBeVisible();
    // Error outcome: the card gets the error class + the reason in its status.
    await expect(timeline.locator(".action-card-extract")).toHaveClass(/error/, { timeout: 10_000 });
    await expect(timeline.locator(".action-card-extract")).toContainText("Element not found");
    // The done answer still lands (the response after a failed action).
    await expect(h.panel.locator("#messages .msg-assistant .msg-body").last()).toContainText("Extracted");
  });

  test("conversation threading: turn 2 carries conversation_id", async () => {
    await clearRecordedRequests();
    await sendQuery(h.panel, "what is this page?");
    await waitForTurnComplete(h.panel, 20_000);
    await sendQuery(h.panel, "and summarize it");
    await waitForTurnComplete(h.panel, 20_000);
    const asks = await recordedAsks();
    expect(asks.length).toBeGreaterThanOrEqual(2);
    const [, second] = asks.slice(-2);
    expect(second.body.conversation_id).toBe("e2e-conv-1");
  });
});
