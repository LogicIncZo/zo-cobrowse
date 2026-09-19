// E2E: Recipes (#220) — a full deterministic run against the real extension:
// `!recipe run` loads the artifact from the workspace over MCP read_file, the
// params card collects {{applicant}}, the player drives the run's tab through
// form.html (cue-resolved fill), parks at the mock gateway's HUMAN checkpoint,
// resumes by postcondition after the manual "payment", and lands the
// extracted registration number in the chat as evidence. The mock Zo API is
// never asked for actions — the whole point is determinism.

import { test, expect } from "@playwright/test";
import { E2E_BASE } from "./helpers/extension";
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

  test("recorder: a manual flow is learned, cleaned, and replayed parameterized", async () => {
    // Test 1 left the run's tab on the gateway — go home to record.
    await h.site.goto(`${E2E_BASE}/`);
    // Arm the recorder.
    await sendQuery(h.panel, "!recipe record e2e-learned");
    await expect(h.panel.locator(".msg-recipe-record-line")).toContainText("Recording recipe", { timeout: 20_000 });

    // THE MANUAL RUN: the user drives the site by hand — one page, one fill.
    await h.site.locator("#nav-form").click();
    await expect(h.site).toHaveURL(/form\.html/);
    await h.site.locator("#name").fill("Recorded Value");

    // Stop → the LLM cleanup (mocked on its marker) learns a cleaned recipe.
    await h.panel.locator(".msg-recipe-record-line .handoff-stop").click();
    const learned = h.panel.locator("#messages .msg-system", { hasText: "Learned recipe" });
    await expect(learned).toContainText("e2e-learned", { timeout: 20_000 });
    await expect(learned).toContainText("Cleaned by Zo");

    // Replay — the recorded value must NOT be used: the cleaned recipe is
    // parameterized, so the params card prompts for a fresh value.
    await sendQuery(h.panel, "!recipe run e2e-learned");
    const card = h.panel.locator(".recipe-params-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.locator("input").fill("Fresh Param Value");
    await card.locator(".form-review-confirm").click();

    const doneLine = h.panel.locator("#messages .msg-system", { hasText: "Recipe done — e2e-learned" });
    await expect(doneLine).toContainText("Fresh Param Value", { timeout: 30_000 });
    // The fill landed through the cue ladder with the PARAM value.
    await expect(h.site.locator("#name")).toHaveValue("Fresh Param Value");
  });

  test("R2 write-back (#256): learn card saves to workspace; the written artifact replays", async () => {
    // Fresh workspace recipe store for this scenario.
    await fetch(`${E2E_BASE}/__recipes`, { method: "DELETE" });

    // Record a one-fill flow by hand.
    await h.site.goto(`${E2E_BASE}/`);
    await sendQuery(h.panel, "!recipe record e2e-saveflow");
    await expect(h.panel.locator(".msg-recipe-record-line")).toContainText("Recording recipe", { timeout: 20_000 });
    await h.site.locator("#nav-form").click();
    await expect(h.site).toHaveURL(/form\.html/);
    await h.site.locator("#name").fill("Recorded Value");
    await h.panel.locator(".msg-recipe-record-line .handoff-stop").click();
    await expect(h.panel.locator("#messages .msg-system", { hasText: 'Learned recipe "e2e-saveflow"' })).toBeVisible({ timeout: 20_000 });

    // The learn card offers the workspace save. The mock's read_file probe
    // answers at every path → the overwrite CONFIRM CARD renders first.
    const offer = h.panel.locator(".recipe-action-card", { hasText: '"e2e-saveflow" lives in this browser' });
    await expect(offer).toBeVisible({ timeout: 10_000 });
    await offer.locator("button", { hasText: "Save to workspace" }).click();
    const overwrite = h.panel.locator(".recipe-action-card", { hasText: "already exists" });
    await expect(overwrite).toBeVisible({ timeout: 15_000 });
    await overwrite.locator("button", { hasText: "Overwrite" }).click();
    await expect(h.panel.locator("#messages .msg-system", { hasText: "Saved" })).toContainText("recipes/e2e-saveflow.json", { timeout: 15_000 });

    // The mock actually stored the artifact — parameterized, value-free.
    const files: Record<string, string> = (await (await fetch(`${E2E_BASE}/__recipes`)).json()).files;
    const written = files["/home/workspace/recipes/e2e-saveflow.json"];
    expect(written).toBeTruthy();
    expect(written).toContain("{{applicant_name}}");
    expect(written).not.toContain("Recorded Value");

    // Replay straight from the WRITTEN workspace file — params card prompts,
    // the player fills through the cue ladder, done carries the fresh value.
    await sendQuery(h.panel, "!recipe run /home/workspace/recipes/e2e-saveflow.json");
    const card = h.panel.locator(".recipe-params-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.locator("input").fill("Workspace Value");
    await card.locator(".form-review-confirm").click();
    const done = h.panel.locator("#messages .msg-system", { hasText: "Recipe done — e2e-saveflow" });
    await expect(done).toContainText("Workspace Value", { timeout: 30_000 });
    await expect(h.site.locator("#name")).toHaveValue("Workspace Value");
  });
});

// C1 (#289): a completed handoff run becomes a composed draft — the panel
// offers "↧ Save as recipe" on the done line, the LLM cleanup (mocked on the
// stable compose marker) prunes it into checkpoints, and the first replay is
// a REHEARSAL (no "Skip check") whose success promotes the library entry.
test("compose save + rehearsal: handoff run → composed draft → verified", async () => {
  await h.site.goto(`${E2E_BASE}/`);
  await sendQuery(h.panel, "!handoff compose-e2e: walk the demo flow and report back");

  // The run completes (parked click + navigation, then done()).
  const doneLine = h.panel.locator("#messages .msg-system", { hasText: "Handoff done" });
  await expect(doneLine).toBeVisible({ timeout: 30_000 });

  // The save offer rides the done line, name prefilled from the goal slug.
  const offer = h.panel.locator(".recipe-action-card", { hasText: "Save this run as a recipe?" });
  await expect(offer).toBeVisible({ timeout: 20_000 });
  const nameInput = offer.locator("input.recipe-compose-name");
  await expect(nameInput).not.toHaveValue("");
  await nameInput.fill("e2e-composed");
  await offer.locator(".form-review-confirm").click();

  const composed = h.panel.locator("#messages .msg-system", { hasText: "Composed draft" });
  await expect(composed).toContainText("e2e-composed", { timeout: 20_000 });
  await expect(composed).toContainText("Cleaned by Zo");
  await expect(composed).toContainText("the first run verifies it");

  // Rehearsal run: the checkpoint card has NO "Skip check" — verify or abort.
  await sendQuery(h.panel, "!recipe run e2e-composed");
  const checkpoint = h.panel.locator(".recipe-checkpoint-card");
  await expect(checkpoint).toBeVisible({ timeout: 30_000 });
  await expect(checkpoint).toContainText("Rehearsal");
  await expect(checkpoint.locator(".form-review-cancel")).toHaveCount(0);

  // Verify (the compose run left the tab on form.html — postcondition holds).
  await checkpoint.locator(".form-review-confirm").click();
  const promotedLine = h.panel.locator("#messages .msg-system", { hasText: "Recipe done — e2e-composed" });
  await expect(promotedLine).toBeVisible({ timeout: 30_000 });
  await expect(promotedLine).toContainText("Rehearsal passed");
});
