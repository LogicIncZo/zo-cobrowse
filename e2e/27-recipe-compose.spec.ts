// E2E: recipe compose (0.3.2 C2, #290) — `!recipe compose <goal>` starts a
// compose session: Zo drives the fixture site (mock scenario), the compose
// boundary REFUSES its fill attempt (value park card), the human fills the
// field on the live page (the recorder streams it as the second producer),
// the session completes, the composed draft saves (C1 machinery), and the
// first replay — the mandatory rehearsal — verifies and promotes it.
//
// Boundary proof rides the artifact: the composed draft carries NO Zo-invented
// value and the rehearsal answers the params card like any human would.

import { test, expect } from "@playwright/test";
import { E2E_BASE } from "./helpers/extension";
import { openHarness, sendQuery, recordedAsks, clearRecordedRequests, type ExtensionHarness } from "./helpers/extension";

let h: ExtensionHarness;

test.beforeAll(async () => {
  h = await openHarness({ sitePath: "/index.html", freshProfile: true });
});

test.afterAll(async () => {
  await h?.context.close();
});

test.describe("recipe compose", () => {
  test("compose: value park → human fill → draft save → rehearsal promotes", async () => {
    await sendQuery(h.panel, "!recipe compose compose2 e2e demo form flow");

    // The compose session announces itself.
    await expect(h.panel.locator("#messages .msg-system", { hasText: "Composing" })).toBeVisible({ timeout: 20_000 });

    // Turn 1: Zo navigated to form.html and TRIED to fill #name — the
    // boundary refused it, the loop parked, the value-park card rendered.
    await expect(h.site).toHaveURL(/form\.html/, { timeout: 30_000 });
    const park = h.panel.locator(".recipe-compose-park");
    await expect(park).toBeVisible({ timeout: 30_000 });
    await expect(park).toContainText("Your turn");

    // THE HUMAN STEP: fill the field on the live page (the recorder's change
    // listener streams it into the run's obs as the human producer).
    await h.site.locator("#name").fill("E2E Human Value");
    await h.site.locator("#name").blur();
    await park.locator(".form-review-confirm").click();

    // Turn 2 (continuation): Zo finishes the flow.
    const doneLine = h.panel.locator("#messages .msg-system", { hasText: "Handoff done" });
    await expect(doneLine).toBeVisible({ timeout: 30_000 });

    // C1's save offer auto-surfaces — the name is prefilled from the goal slug.
    const offer = h.panel.locator(".recipe-action-card", { hasText: "Save this run as a recipe?" });
    await expect(offer).toBeVisible({ timeout: 20_000 });
    const runName = await offer.locator("input.recipe-compose-name").inputValue();
    expect(runName).toBeTruthy();
    await offer.locator(".form-review-confirm").click();

    const composed = h.panel.locator("#messages .msg-system", { hasText: "Composed draft" });
    await expect(composed).toContainText("the first run verifies it", { timeout: 20_000 });

    // Rehearsal: the cleaned draft's fill param has NO default (human-only
    // values), so the params card gates the run.
    await sendQuery(h.panel, `!recipe run ${runName}`);
    const card = h.panel.locator(".recipe-params-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("Who is visiting?");
    await card.locator("input").fill("Rehearsed Human");
    await card.locator(".form-review-confirm").click();

    // The rehearsal plays the fill with the human-supplied value and promotes.
    const promoted = h.panel.locator("#messages .msg-system", { hasText: "Recipe done" });
    await expect(promoted.filter({ hasText: runName })).toBeVisible({ timeout: 30_000 });
    await expect(promoted.filter({ hasText: runName })).toContainText("Rehearsal passed");
    await expect(h.site.locator("#name")).toHaveValue("Rehearsed Human");
  });
});

test.describe("compose run-priming fixes (0.3.4.N)", () => {
  test("compose with the DOM toggle OFF still sends full context, and the bang bubble renders once", async () => {
    test.setTimeout(90_000);
    // Own harness + fresh chat: the shared harness's chat already carries
    // compose context for this fixture page, and a same-page second compose
    // would legitimately dedup ("context already sent") — this test needs a
    // first-turn-on-a-page situation to prove the DOM-cap bypass.
    const h2: ExtensionHarness = await openHarness({ sitePath: "/index.html", freshProfile: true });
    try {
      // Sticky DOM cap OFF — a manual chat would go URL-only from here.
      await h2.panel.evaluate(() => (document.getElementById("dom-toggle") as HTMLElement).click());
      await expect(h2.panel.locator("#dom-toggle")).toHaveAttribute("aria-pressed", "false");
      await clearRecordedRequests();
      await sendQuery(h2.panel, "!recipe compose dom-off context check");
      // The compose session announces itself (run armed + priming turn sent).
      await expect(h2.panel.locator(".msg-handoff-line").first()).toBeVisible({ timeout: 30_000 });
      // The run-priming turn carries the FULL element context despite the cap.
      // (The ask lands just after the run line — poll rather than pop.)
      let last: any = null;
      for (let i = 0; i < 30 && !last; i++) {
        const asks = await recordedAsks();
        last = asks[asks.length - 1];
        if (!last) await h2.panel.waitForTimeout(500);
      }
      expect(last?.body?.input || "").toContain("## Elements");
      // Exactly ONE user bubble — the compose bang must not double-add it.
      await expect(
        h2.panel.locator("#messages .msg-user", { hasText: "dom-off context check" }),
      ).toHaveCount(1);
    } finally {
      await h2.context.close();
    }
  });
});
