// QA matrix m2 — history + options variants beyond the scripted e2e
// (21-history-ops / 05-options cover the basics):
//   • history live-search matches message text (snippets), clears, restores
//   • options pane switching + #card-* deep links land on the right pane
//   • prompts editor: a saved override persists to storage; Reset deletes it

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

test("history live-search matches message text and restores a chat", async () => {
  await sendQuery(h.panel, "history search probe xylophone");
  await waitForTurnComplete(h.panel);
  await h.panel.locator("#history-btn").click();
  await expect(h.panel.locator("#history-view")).toBeVisible();
  await h.panel.locator("#history-search").fill("xylophone");
  const cards = h.panel.locator(".history-card");
  await expect(cards).toHaveCount(1);
  await expect(cards.locator(".history-card-title, .history-card-snippet").first()).toContainText("xylophone");
  await h.panel.locator("#history-search").fill("");
  await expect(await cards.count()).toBeGreaterThanOrEqual(1); // cleared → list restored
  await cards.first().click();
  // Clicking a card lands back in the chat — the history view closes itself.
  await expect(h.panel.locator("#history-view")).toBeHidden();
  await expect(h.panel.locator("#messages .msg")).not.toHaveCount(0);
});

test("options pane switching and #card-write deep link land correctly", async () => {
  const opts = await h.panel.evaluate(() => chrome.runtime.getURL("options.html"));
  await h.panel.goto(`${opts}#card-write`);
  await expect(h.panel.locator(".tab-pane#pane-features")).toBeVisible();
  await expect(h.panel.locator("#card-write")).toBeInViewport();
  await h.panel.locator('#settings-nav .settings-tab[data-pane="pane-prompts"]').click();
  await expect(h.panel.locator(".tab-pane#pane-prompts")).toBeVisible();
  await expect(h.panel.locator(".tab-pane#pane-connection")).toBeHidden();
});

test("prompts editor override persists; Reset deletes it", async () => {
  const opts = await h.panel.evaluate(() => chrome.runtime.getURL("options.html"));
  await h.panel.goto(opts);
  await h.panel.locator('#settings-nav .settings-tab[data-pane="pane-prompts"]').click();
  await h.panel.locator("#prompt-mode-select").selectOption({ index: 4 }); // 🪶 Lean
  await h.panel.locator("#prompt-budget").fill("1234");
  await h.panel.locator("#prompt-save").click();
  await expect(h.panel.locator("#prompt-status")).not.toBeEmpty();
  const override = await h.panel.evaluate(
    () => new Promise((res) => chrome.storage.local.get("cobrowse_mode_overrides", (d: any) => res(d))),
  );
  expect(JSON.stringify(override)).toContain("1234");
  await h.panel.locator("#prompt-reset").click();
  const after = await h.panel.evaluate(
    () => new Promise((res) => chrome.storage.local.get("cobrowse_mode_overrides", (d: any) => res(d))),
  );
  expect(JSON.stringify(after)).not.toContain("1234");
});
