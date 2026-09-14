// E2E: Recipes (#220) — a full deterministic run against the real extension:
// `!recipe run` loads the artifact from the workspace over MCP read_file, the
// params card collects {{applicant}}, the player drives the run's tab through
// form.html (cue-resolved fill), parks at the mock gateway's HUMAN checkpoint,
// resumes by postcondition after the manual "payment", and lands the
// extracted registration number in the chat as evidence. The mock Zo API is
// never asked for actions — the whole point is determinism.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, type ExtensionHarness } from "./helpers/extension";

let h: ExtensionHarness;

test.beforeAll(async () => {
  h = await openHarness({ sitePath: "/index.html", freshProfile: true });
});

test.afterAll(async () => {
  await h?.context.close();
});

test.describe("recipes player", () => {
  test("params card → fill → human checkpoint → resume → evidence", async () => {
    await sendQuery(h.panel, "!recipe run /home/workspace/recipes/e2e-filing.json");

    // The params card gates the start — one required param.
    const card = h.panel.locator(".recipe-params-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.locator("input").fill("Ada Lovelace");
    await card.locator(".form-review-confirm").click();

    // The run starts and the progress line shows.
    await expect(h.panel.locator(".msg-recipe-line")).toContainText("E2E filing", { timeout: 20_000 });

    // The player drove the tab to the gateway and parked at the checkpoint.
    await expect(h.site).toHaveURL(/gateway\.html/, { timeout: 30_000 });
    const checkpoint = h.panel.locator(".recipe-checkpoint-card");
    await expect(checkpoint).toContainText("Pay ₹10 on the mock gateway", { timeout: 30_000 });

    // The fill step landed through the cue ladder on form.html (param substituted).
    await expect(h.panel.locator(".msg-recipe-line")).toContainText("waiting for you", { timeout: 20_000 });

    // THE HUMAN STEP: the user pays by hand on the gateway page.
    await h.site.locator("#pay-btn").click();
    await expect(h.site).toHaveURL(/paid=1/, { timeout: 15_000 });
    await expect(h.site.locator("#reg-number")).toBeVisible();

    // Back in the panel: verify → postcondition (paid=1) holds → the player
    // extracts the registration number and finishes.
    await checkpoint.locator(".form-review-confirm").click();

    const doneLine = h.panel.locator("#messages .msg-system", { hasText: "Recipe done" });
    await expect(doneLine).toContainText("E2E filing", { timeout: 30_000 });
    await expect(doneLine).toContainText("REG-2026-E2E-777");
    await expect(doneLine).toContainText("Ada Lovelace");

    // The progress line and checkpoint cleared on the terminal push.
    await expect(h.panel.locator(".msg-recipe-line")).toHaveCount(0);
    await expect(h.panel.locator(".recipe-checkpoint-card")).toHaveCount(0);
  });
});
