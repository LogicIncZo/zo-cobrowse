// E2E ("any form" round): a builder-style multi-section application form —
// no labels, no names, one shared placeholder, question text as plain divs,
// advance buttons outside any <form> (the live-probed Typeform shape). Zo
// fills the VISIBLE section per turn (question-text targeting), the user
// reviews and advances, then asks Zo to continue — the co-browse loop.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, waitForTurnComplete, lastAskBody } from "./helpers/extension";

test.describe("any-form co-browse (#26)", () => {
  test("question-text targeting + section-by-section pacing", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/application.html" });
    try {
      // Turn 1 — Zo fills only the visible (first) section, by question text.
      await sendQuery(h.panel, "help me fill this application");
      await expect(h.site.locator("#uuid-a1")).toHaveValue("Ada Lovelace", { timeout: 20_000 });
      await expect(h.site.locator("#uuid-a2")).toHaveValue("ada@example.dev");
      await expect(h.site.locator("#uuid-b1")).toHaveValue(""); // next section untouched
      await expect(h.site.locator("#uuid-b2")).toHaveValue("");
      await waitForTurnComplete(h.panel);
      // The prompt actually showed Zo the question cues (compactForm "—").
      const ask = await lastAskBody();
      expect(String(ask.input)).toContain("— First name*");
      expect(String(ask.input)).toContain("— Work email");
      // One timeline card, per-field rows for the filled section only.
      await expect(h.panel.locator(".action-card-fill_form .field-result")).toHaveCount(2, { timeout: 20_000 });

      // The user reviews, then advances THEMSELVES (co-browse feel).
      await h.site.locator("#block-1 .ok-btn").click();
      await h.site.waitForTimeout(700); // smooth scroll settles

      // Turn 2 — "continue" fills the now-visible section.
      await sendQuery(h.panel, "continue with the next section");
      await expect(h.site.locator("#uuid-b1")).toHaveValue("https://ada.example.dev", { timeout: 20_000 });
      await expect(h.site.locator("#uuid-b2")).toHaveValue("I build browser tooling.");
      // Section 1 keeps its values; nothing was auto-submitted.
      await expect(h.site.locator("#uuid-a1")).toHaveValue("Ada Lovelace");
      await expect(h.site.locator("#app-submitted")).toBeHidden();
      await waitForTurnComplete(h.panel);

      // The user submits after reviewing.
      await h.site.locator("#block-2 .ok-btn").click();
      await expect(h.site.locator("#app-submitted")).toBeVisible();
    } finally {
      await h.context.close();
    }
  });
});
