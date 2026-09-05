// E2E: bang commands — !summarize / !context / !handoff (including the
// #138 regression: the done status line must NOT repeat the deliverable).

import { test, expect } from "@playwright/test";
import {
  openHarness,
  sendQuery,
  recordedAsks,
  clearRecordedRequests,
  waitForTurnComplete,
  type ExtensionHarness,
} from "./helpers/extension";

let h: ExtensionHarness;

test.beforeAll(async () => {
  h = await openHarness({ freshProfile: true });
});

test.afterAll(async () => {
  await h?.context.close();
});

test.describe("bang commands", () => {
  test("!summarize forces the ask Mode and answers in plain markdown", async () => {
    await clearRecordedRequests();
    await sendQuery(h.panel, "!summarize this page for me");
    await waitForTurnComplete(h.panel, 20_000);
    const last = (await recordedAsks()).pop();
    expect(last.body.modeId || "").not.toContain("cobrowse");
    // Plain prose (no action envelope leaked into the chat).
    await expect(h.panel.locator("#messages .msg-assistant .msg-body").last()).toContainText("mock answer");
    await expect(h.panel.locator("#messages .msg-action-run")).toHaveCount(0);
    // Footer mode chip says Ask.
    await expect(h.panel.locator(".msg-footer-mode").last()).toContainText("Ask");
  });

  test("!context attaches full DOM context for one turn (read query)", async () => {
    await clearRecordedRequests();
    await sendQuery(h.panel, "!context what does the status card say?");
    await waitForTurnComplete(h.panel, 20_000);
    const last = (await recordedAsks()).pop();
    // Tier-2 attach: the clickable-elements section must ride this ONE turn.
    expect(last.body.input).toMatch(/clickable|element/i);
  });

  test("!handoff stop (✕) aborts mid-run without stranding the panel", async () => {
    await sendQuery(h.panel, "!handoff compare the pricing across fixture pages");
    await expect(h.panel.locator("#messages .msg-handoff-line").first()).toBeVisible({ timeout: 20_000 });
    await expect(h.panel.locator(".handoff-stop").first()).toBeVisible({ timeout: 10_000 });
    await h.panel.locator(".handoff-stop").first().click();
    await h.panel.waitForTimeout(1500);
    // Input re-enabled, no crash; the panel keeps working.
    await expect(h.panel.locator("#query-input")).toBeEnabled();
  });

  test("handoff done: the digest renders ONCE — the status line stays compact (#138)", async () => {
    await sendQuery(h.panel, "!handoff compare the pricing across fixture pages");
    // The mock's scripted run ends with a done() carrying the pricing digest.
    await expect(h.panel.locator("#messages").first()).toContainText("Handoff done", { timeout: 30_000 });
    // The deliverable renders exactly once (as the turn's markdown answer) —
    // not repeated inside the status line with raw markdown.
    const occurrences = await h.panel.evaluate(
      () => (document.getElementById("messages")?.textContent ?? "").split("value pick").length - 1,
    );
    expect(occurrences).toBe(1);
    // The system status line must be compact — no digest text, no raw markdown.
    const systemLine = h.panel.locator("#messages .msg-system", { hasText: "Handoff done" }).last();
    await expect(systemLine).toBeVisible();
    await expect(systemLine).not.toContainText("Pricing digest");
    await expect(systemLine).not.toContainText("value pick");
  });
});
