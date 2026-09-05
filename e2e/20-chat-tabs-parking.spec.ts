// E2E: chat tabs — one stream, survives switches, actions never auto-run
// against a page the user isn't watching.
//   • switching to an EXISTING tab keeps the stream running (pulsing dot on
//     the BACKGROUND tab only — #135: never on the active tab)
//   • a backgrounded chat's DOM actions park: page untouched until the user
//     runs them; the Run All / Skip bar re-arms on switch-back

import { test, expect } from "@playwright/test";
import {
  openHarness,
  sendQuery,
  waitForTurnComplete,
  E2E_BASE,
  type ExtensionHarness,
} from "./helpers/extension";

let h: ExtensionHarness;

test.beforeAll(async () => {
  h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
});

test.afterAll(async () => {
  await h?.context.close();
});

/** In-page click on the nth chat tab (doesn't move focus). */
async function clickTab(n: number): Promise<void> {
  await h.panel.evaluate((idx) => {
    (document.querySelectorAll("#chat-tabs .chat-tab")[idx] as HTMLElement | undefined)?.click();
  }, n);
}

test.describe("chat tabs mid-stream", () => {
  test("stream survives switching to an EXISTING tab; dot marks only the background tab", async () => {
    // Chat 2 exists first (no stream), so the tab bar has 2 tabs.
    await h.panel.locator("#new-chat-btn").click();
    await h.panel.waitForTimeout(300);
    await sendQuery(h.panel, "seed chat 2");
    await waitForTurnComplete(h.panel, 20_000);
    // Back to chat 1 (first tab).
    await clickTab(0);
    await h.panel.waitForTimeout(400);
    // Start a slow stream in chat 1, then switch to chat 2 mid-stream.
    await sendQuery(h.panel, "answer slowly: chat one question");
    await expect(h.panel.locator("#messages .msg-streaming-text").first()).toBeVisible({ timeout: 15_000 });
    // While chat 1 is ACTIVE and streaming: no dot (the user is watching).
    await expect(h.panel.locator("#chat-tabs .chat-tab-stream-dot")).toHaveCount(0);
    await clickTab(1);
    await h.panel.waitForTimeout(400);
    // Pulsing dot marks the streaming BACKGROUND tab.
    await expect(h.panel.locator("#chat-tabs .chat-tab-stream-dot").first()).toBeVisible({ timeout: 5_000 });
    // Wait out the stream, switch back to chat 1.
    await h.panel.waitForTimeout(6000);
    await clickTab(0);
    await h.panel.waitForTimeout(500);
    await expect(h.panel.locator("#messages .msg-assistant .msg-body").last()).toContainText("mock answer", { timeout: 15_000 });
    await expect(h.panel.locator("#query-input")).toBeEnabled();
  });

  test("actions in a backgrounded chat park; the page is untouched until the user runs them", async () => {
    // Site is on form.html; chat 1 is active. Arm a SLOW fill turn (~0.7s of
    // streaming) so STREAM_DONE lands after the switch to chat 2.
    await sendQuery(h.panel, "slow fill the form fields");
    await h.panel.waitForTimeout(100);
    await clickTab(1);
    await h.panel.waitForTimeout(5000); // stream must finish while backgrounded
    // The site must NOT have been filled while nobody was watching.
    const nameVal = await h.site.evaluate(() => (document.querySelector("#name") as HTMLInputElement)?.value ?? "");
    expect(nameVal).toBe("");
    // Switch back to chat 1: the parked actions re-arm Run All / Skip.
    await clickTab(0);
    await expect(h.panel.locator("#actions-bar")).toBeVisible({ timeout: 5_000 });
    await expect(h.panel.locator("#run-all-btn")).toBeVisible();
  });
});
