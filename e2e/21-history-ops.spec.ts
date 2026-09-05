// E2E: history view — rename, export, delete (including deleting the ACTIVE
// conversation) must all leave the panel in a working state.

import { test, expect } from "@playwright/test";
import {
  openHarness,
  sendQuery,
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

test.describe("history ops", () => {
  test("rename, export (download), and delete work from the history view", async () => {
    await sendQuery(h.panel, "what is this page?");
    await waitForTurnComplete(h.panel, 20_000);
    await h.panel.locator("#new-chat-btn").click();
    await h.panel.waitForTimeout(300);
    await sendQuery(h.panel, "extract the status card");
    await waitForTurnComplete(h.panel, 20_000);

    await h.panel.locator("#history-btn").click();
    await expect(h.panel.locator("#history-view")).toBeVisible();
    const cards = h.panel.locator("#history-list .history-card");
    await expect(cards).toHaveCount(2);

    // Rename the first card inline.
    await cards.first().locator(".history-card-rename").first().click();
    const renameInput = h.panel.locator(".history-rename-input");
    await expect(renameInput).toBeVisible();
    await renameInput.fill("Renamed History Chat");
    await renameInput.press("Enter");
    await h.panel.waitForTimeout(300);
    await expect(cards.first().locator(".history-card-title")).toContainText("Renamed History Chat");

    // Export: buttons share .history-card-rename class — find by title.
    const exportBtn = cards.first().locator("button[title*='xport'], button[title*='ownload']").first();
    const [download] = await Promise.all([
      h.panel.waitForEvent("download", { timeout: 10_000 }),
      exportBtn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^zo-chat-.*\.md$/);
    const fs = await import("node:fs");
    const md = fs.readFileSync(await download.path(), "utf-8");
    expect(md).toContain("Renamed History Chat");
    expect(md).not.toMatch(/^system/im); // no system/error noise lines

    // Delete the second card (accept the confirm dialog).
    h.panel.on("dialog", (d) => d.accept());
    await cards.nth(1).locator(".history-card-delete").click();
    await h.panel.waitForTimeout(400);
    await expect(h.panel.locator("#history-list .history-card")).toHaveCount(1);
  });

  test("deleting the ACTIVE conversation lands you somewhere sane", async () => {
    // The panel is still on the history view from the previous test; the
    // button toggles — only click if the view is not already open.
    if (!(await h.panel.locator("#history-view").isVisible().catch(() => false))) {
      await h.panel.locator("#history-btn").click();
    }
    await expect(h.panel.locator("#history-view")).toBeVisible();
    await h.panel.locator("#history-list .history-card").first().locator(".history-card-delete").click();
    await h.panel.waitForTimeout(600);
    if (await h.panel.locator("#back-to-chat-btn").isVisible().catch(() => false)) {
      await h.panel.locator("#back-to-chat-btn").click();
    }
    await expect(h.panel.locator("#query-input")).toBeEnabled();
    // A fresh send still works after deleting everything.
    await sendQuery(h.panel, "what is this page?");
    await waitForTurnComplete(h.panel, 20_000);
  });
});
