// E2E ("any form" hardening): a RoboForm-SHAPED classic form — every input
// name starts with a digit (CSS \NN escapes), no labels/ids/placeholders,
// selects, password + card fields — and the mock streams the EXACT broken
// envelope Zo emitted live: key-first {"fill":{...}} actions with UNESCAPED
// double quotes inside the selector strings (invalid JSON). The full pipeline
// under test: SSE → repairJson → normalizeActions (key-first) → sensitivity
// gate parks → ONE review card → confirm → real DOM fills (incl. select by
// visible text) → nothing submitted.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery } from "./helpers/extension";

test.describe("classic digit-name form (#26 hardening)", () => {
  test("broken key-first JSON repairs, parks, confirm fills, select by text, no submit", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/classic-form.html" });
    try {
      await sendQuery(h.panel, "fill the classic form");

      // The repair worked: the raw broken JSON never leaks into the chat
      // (timeline cards legitimately show selectors; the envelope must not).
      await expect(h.panel.locator(".form-review-card")).toBeVisible({ timeout: 20_000 });
      await expect(h.panel.locator("#messages")).not.toContainText('"actions"');
      await expect(h.panel.locator("#messages")).not.toContainText('{"fill"');

      // Nothing filled before confirm — the page stays untouched.
      await expect(h.site.locator('input[name="02frstname"]')).toHaveValue("");

      // The review card: secret rows are "left for you", non-secrets editable.
      // Plain-fill rows are labeled from the captured question/label metadata
      // (the fixture's <label> sits beside each input), not raw selectors.
      const card = h.panel.locator(".form-review-card");
      await expect(card).toContainText(/password/i);
      await expect(card).toContainText("left for you");
      await expect(card.locator("input[data-target='First']")).toHaveValue("Test");

      await card.locator(".form-review-confirm").click();

      // Confirmed: real DOM fills — digit-leading names resolve, and the
      // select was set by VISIBLE TEXT ("Visa (Preferred)" → option value visa).
      await expect(h.site.locator('input[name="02frstname"]')).toHaveValue("Test", { timeout: 20_000 });
      await expect(h.site.locator('input[name="01___title"]')).toHaveValue("Mr.");
      await expect(h.site.locator('input[name="30_user_id"]')).toHaveValue("testuser01");
      await expect(h.site.locator('select[name="40cc__type"]')).toHaveValue("visa");
      await expect(h.site.locator('select[name="42ccexp_mm"]')).toHaveValue("12");

      // Secrets never touched by the assistant.
      await expect(h.site.locator('input[name="31password"]')).toHaveValue("");
      await expect(h.site.locator('input[name="41ccnumber"]')).toHaveValue("");
      await expect(h.site.locator('input[name="43cvc"]')).toHaveValue("");

      // The co-browse contract: the submit button was never auto-clicked.
      await expect(h.site.locator("#classic-result")).toBeEmpty();
      expect(await h.site.evaluate(() => (window as any).__classicSubmitted())).toBe(false);

      // ONE review card consumed the whole batch; timeline shows the fills.
      await expect(card).toHaveCount(0);
    } finally {
      await h.context.close();
    }
  });
});
