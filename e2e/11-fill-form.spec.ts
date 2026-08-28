// E2E (#26): the fill_form review-card flow in a real Chromium — Zo's batch
// fill envelope → background sensitivity gate parks it → editable review card
// in the panel → confirm re-sends with edits → real DOM mutation, secrets
// (password/card) never touched.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery } from "./helpers/extension";

test.describe("form-fill (#26)", () => {
  test("fill_form parks on the sensitive form, confirm fills editable values", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/checkout.html" });
    try {
      await sendQuery(h.panel, "fill the checkout form");

      // The gate parks: editable review card, reasons visible.
      const card = h.panel.locator(".form-review-card");
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card).toContainText(/password/i);
      // Only the non-secret row is editable — password + card are "left for you".
      await expect(card.locator("input")).toHaveCount(1);
      await expect(card.locator("input[data-target='Email']")).toHaveValue("e2e@example.com");

      // Nothing was filled yet — the page stays untouched until confirm.
      await expect(h.site.locator("#email")).toHaveValue("");

      await card.locator("input[data-target='Email']").fill("edited@e2e.dev");
      await card.locator(".form-review-confirm").click();

      // Confirmed: the edited value lands in the real page DOM.
      await expect(h.site.locator("#email")).toHaveValue("edited@e2e.dev", { timeout: 20_000 });
      // Secrets never touched by the assistant.
      await expect(h.site.locator("#pw")).toHaveValue("");
      await expect(h.site.locator("#cc")).toHaveValue("");

      // Card is gone; ONE timeline card with per-field results.
      await expect(card).toHaveCount(0);
      await expect(h.panel.locator(".action-card-fill_form .field-result")).toHaveCount(3, { timeout: 20_000 });
    } finally {
      await h.context.close();
    }
  });

  test("cancel drops the fill without touching the page", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/checkout.html" });
    try {
      await sendQuery(h.panel, "fill the checkout form");
      const card = h.panel.locator(".form-review-card");
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.locator(".form-review-cancel").click();
      await expect(card).toHaveCount(0);
      await expect(h.panel.locator(".msg-assistant").last()).toContainText(/skipped the form fill/i, { timeout: 10_000 });
      await expect(h.site.locator("#email")).toHaveValue("");
    } finally {
      await h.context.close();
    }
  });
});
