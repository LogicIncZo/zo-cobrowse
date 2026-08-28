// E2E: the co-browse action loop in a real Chromium — Zo's action envelope
// (mock SSE) → panel timeline → EXECUTE_ACTIONS → real DOM mutation on the
// fixture page → done response rendered.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, waitForTurnComplete } from "./helpers/extension";

test.describe("action turns", () => {
  test("fill envelope mutates the real form without submitting", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      await sendQuery(h.panel, "fill the form for me");
      // Real DOM effects: fields filled, but NOT submitted (co-browse rule).
      await expect(h.site.locator("#name")).toHaveValue("E2E Tester", { timeout: 20_000 });
      await expect(h.site.locator("#email")).toHaveValue("e2e@example.test");
      await expect(h.site.locator("#plan")).toHaveValue("pro");
      // The form was NOT auto-submitted — #form-result stays empty.
      await expect(h.site.locator("#form-result")).toBeEmpty({ timeout: 3000 });

      // Panel: 3 fill cards + done (no click card).
      await expect(h.panel.locator("#action-run .action-run-label")).toContainText("Performed actions", { timeout: 20_000 });
      const cards = h.panel.locator("#action-timeline .action-card");
      await expect(cards).toHaveCount(3, { timeout: 20_000 }); // fills only — no submit click
      await expect(cards.first()).toContainText("Fill");
      // …and the done response WAS persisted for history
      await waitForTurnComplete(h.panel);
      const stored = await h.serviceWorker.evaluate(() => new Promise((r) =>
        chrome.storage.local.get("cobrowse_convos", (v) => r(JSON.stringify(v.cobrowse_convos || {})))));
      expect(stored).toContain("Form filled — review");
    } finally {
      await h.context.close();
    }
  });

  test("click envelope fires the page button", async () => {
    const h = await openHarness({ freshProfile: true });
    try {
      await sendQuery(h.panel, "click the thing");
      await expect(h.site.locator("#status-card")).toContainText("Status: thing done", { timeout: 20_000 });
      await expect(h.panel.locator("#action-run .action-run-label")).toContainText("Performed actions", { timeout: 20_000 });
      await expect(h.panel.locator("#action-timeline .action-card")).toHaveCount(1, { timeout: 20_000 });
    } finally {
      await h.context.close();
    }
  });

  test("scroll envelope moves the viewport", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/long.html" });
    try {
      const before = await h.site.evaluate(() => window.scrollY);
      await sendQuery(h.panel, "scroll down the page");
      await expect(h.panel.locator("#action-run .action-run-label")).toContainText("Performed actions", { timeout: 20_000 });
      await h.site.waitForTimeout(700); // smooth scroll settles
      const after = await h.site.evaluate(() => window.scrollY);
      expect(after).toBeGreaterThan(before);
    } finally {
      await h.context.close();
    }
  });
});
