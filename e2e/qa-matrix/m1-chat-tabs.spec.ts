// QA matrix m1 — chat-tab lifecycle variants beyond the scripted e2e
// (20-chat-tabs-parking covers parking + pulsing dot):
//   • closing a BACKGROUND tab mid-stream must not orphan the stream — the
//     conversation survives in history with its complete answer
//   • closing the LAST tab hits the one-tab guard (a chat always stays open)

import { test, expect } from "@playwright/test";
import {
  openHarness,
  sendQuery,
  waitForTurnComplete,
  type ExtensionHarness,
} from "../helpers/extension";

let h: ExtensionHarness;
test.beforeAll(async () => {
  h = await openHarness({ freshProfile: true, sitePath: "/" });
});
test.afterAll(async () => {
  await h?.context.close();
});

test("closing a background tab mid-stream keeps the stream alive into history", async () => {
  // Chat 1 streams slowly; move it to the background by opening chat 2.
  await sendQuery(h.panel, "answer slowly: close me mid-stream");
  await expect(h.panel.locator("#messages .msg-streaming-text").first()).toBeVisible({ timeout: 15_000 });
  await h.panel.locator("#new-chat-btn").click();
  await expect(h.panel.locator("#chat-tabs .chat-tab")).toHaveCount(2);
  await expect(h.panel.locator("#chat-tabs .chat-tab-stream-dot").first()).toBeVisible({ timeout: 5_000 });

  // Middle-click closes the backgrounded streaming tab (documented affordance).
  await h.panel.locator("#chat-tabs .chat-tab").first().click({ button: "middle" });
  // One tab remains → the bar hides itself entirely (sidepanel.js renderChatTabs
  // skips rendering at ≤1 open tabs).
  await expect(h.panel.locator("#chat-tabs .chat-tab")).toHaveCount(0);

  // The stream must finish into the closed chat's conversation. Give the slow
  // stream time to complete (the tab bar is hidden at this point, so there is
  // no live completion signal — the persisted record is the oracle).
  await h.panel.waitForTimeout(9_000);
  const convos = await h.panel.evaluate(() =>
    new Promise((res) => {
      chrome.storage.local.get("cobrowse_convos", (d: any) => res(d["cobrowse_convos"] || {}));
    }),
  );
  const closed = Object.values(convos as Record<string, any>).find((c) =>
    String(c.title || "").includes("close me mid-stream"),
  );
  if (!closed) {
    console.log("m1 DEBUG — conversations in storage:", JSON.stringify(convos));
  }
  const saved = (closed?.messages || []).some(
    (m: any) => m.role === "assistant" && String(m.text || "").includes("mock answer"),
  );
  if (!saved) {
    console.log("m1 DEBUG — closed convo record:", JSON.stringify(closed));
  }
  expect(saved).toBe(true);

  await h.panel.locator("#history-btn").click();
  await expect(h.panel.locator("#history-view")).toBeVisible();
  const card = h.panel.locator(".history-card", { hasText: "close me mid-stream" });
  await expect(card).toHaveCount(1);
  await card.click();
  await waitForTurnComplete(h.panel, 20_000);
  await expect(h.panel.locator("#messages .msg-assistant .msg-body").last()).toContainText("mock answer");
});

test("closing tabs down to the last one hides the bar and keeps the chat", async () => {
  // Guarantee the bar is rendered regardless of prior test state, then close
  // tabs one by one. The last-tab guard (lib/chat-tabs.js closeChatTab:
  // openIds.length <= 1 no-ops) plus the ≤1-tab bar hide must stop the loop
  // with a usable chat and no tab elements.
  await h.panel.locator("#new-chat-btn").click();
  await expect(h.panel.locator("#chat-tabs .chat-tab").first()).toBeVisible({ timeout: 5_000 });
  for (let i = 0; i < 12; i++) {
    if ((await h.panel.locator("#chat-tabs .chat-tab").count()) === 0) break;
    await h.panel.locator("#chat-tabs .chat-tab").first().click({ button: "middle" });
    await h.panel.waitForTimeout(150);
  }
  await expect(h.panel.locator("#chat-tabs .chat-tab")).toHaveCount(0);
  await expect(h.panel.locator("#query-input")).toBeVisible();
});
