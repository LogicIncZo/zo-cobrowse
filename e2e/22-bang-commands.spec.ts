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

import fs from "node:fs";

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

test.describe("export delta (#51)", () => {
  test("!export downloads the conversation; the artifact matches the history ⬇ export", async () => {
    // A real streamed turn first, so the transcript has content to export.
    await sendQuery(h.panel, "what does this page say?");
    await waitForTurnComplete(h.panel, 20_000);

    const [bangDownload] = await Promise.all([
      h.panel.waitForEvent("download", { timeout: 10_000 }),
      sendQuery(h.panel, "!export"),
    ]);
    expect(bangDownload.suggestedFilename()).toMatch(/^zo-chat-.*\.md$/);
    const bangMd = fs.readFileSync(await bangDownload.path(), "utf-8");
    expect(bangMd).toContain("mock answer"); // the streamed answer rode the transcript

    // The history ⬇ uses the SAME serializer — same title header + turns.
    await h.panel.locator("#history-btn").click();
    await expect(h.panel.locator("#history-view")).toBeVisible();
    const exportBtn = h.panel
      .locator("#history-list .history-card")
      .first()
      .locator("button[title*='xport'], button[title*='ownload']")
      .first();
    const [histDownload] = await Promise.all([
      h.panel.waitForEvent("download", { timeout: 10_000 }),
      exportBtn.click(),
    ]);
    const histMd = fs.readFileSync(await histDownload.path(), "utf-8");
    // Same chat, same serializer: identical title header and the first real
    // turn. (The bang export snapshots BEFORE persisting its own "!export"
    // exchange, so byte-equality of the tails is not the contract — the
    // shared serializer is.)
    expect(bangMd.split("\n")[0]).toBe(histMd.split("\n")[0]);
    expect(histMd).toContain("mock answer");
    for (const md of [bangMd, histMd]) {
      expect(md).toContain("what does this page say?");
    }
  });

  test("!export page downloads the page note; !export <path> saves the chat to the workspace", async () => {
    const [pageDownload] = await Promise.all([
      h.panel.waitForEvent("download", { timeout: 10_000 }),
      sendQuery(h.panel, "!export page"),
    ]);
    expect(pageDownload.suggestedFilename()).toMatch(/^zo-page-.*\.md$/);
    const pageMd = fs.readFileSync(await pageDownload.path(), "utf-8");
    expect(pageMd).toContain("> **Source:**");

    // Workspace target mirrors !save's agent-write: one non-streaming ask.
    await clearRecordedRequests();
    await sendQuery(h.panel, "!export Documents/research/rti.md");
    await expect
      .poll(async () => (await recordedAsks()).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const asks = await recordedAsks();
    expect(asks[asks.length - 1].body.input).toContain("Write the following content to the file at path");
    expect(asks[asks.length - 1].body.input).toContain("Documents/research/rti.md");
    await expect(h.panel.locator("#messages .msg-assistant .msg-body").last()).toContainText("Conversation saved", { timeout: 10_000 });
  });

  test("!export pdf opens the reader view; its print button invokes window.print", async () => {
    const popupPromise = h.panel.waitForEvent("popup", { timeout: 10_000 });
    await sendQuery(h.panel, "!export pdf");
    const reader = await popupPromise;
    await expect(reader.locator("h1")).toBeVisible();
    // Spy on the reader window's print entry point, then press the button.
    await reader.evaluate(() => {
      (window as any).__printed = false;
      window.print = () => { (window as any).__printed = true; };
    });
    await reader.locator(".print-btn").click();
    expect(await reader.evaluate(() => (window as any).__printed)).toBe(true);
    await reader.close();
  });
});
