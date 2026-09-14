// Demo recording: Recipes (#220) — the two headline flows, paced for viewing:
//   A) `!recipe run` — workspace recipe over MCP → params card → deterministic
//      fill on the fixture form → HUMAN checkpoint at the mock payment
//      gateway → pay by hand → resume-by-postcondition → evidence in chat.
//   B) `!recipe record` — learn a recipe from a manual run (LLM-cleaned),
//      then replay it parameterized (the recorded value is NOT reused).
//
// NOT part of the normal e2e suite — run it explicitly:
//   ZO_DEMO=1 bunx playwright test -c e2e/playwright.config.ts demo-recipes
// BOTH pages are recorded (site = the tab the recipe drives; panel = the
// chat surface). Webms land in e2e/demo-video/ (finalized on close). Assemble:
//   ffmpeg -i site.webm -i panel.webm -filter_complex hstack -pix_fmt yuv420p \
//     demo/recipes-demo.mp4

import { test, expect } from "@playwright/test";
import { openHarness, E2E_BASE, type ExtensionHarness } from "./helpers/extension";

const DEMO = process.env.ZO_DEMO === "1";
const VIDEO_DIR = new URL("./demo-video/", import.meta.url).pathname;
const SIZE = { width: 1280, height: 800 };

test.describe("demo: recipes — deterministic runs + learn-by-recording (#220)", () => {
  test.skip(!DEMO, "demo recording — run with ZO_DEMO=1");
  test.setTimeout(240_000);

  test("params → checkpointed run → evidence; then record → learn → replay", async () => {
    const h: ExtensionHarness = await openHarness({
      freshProfile: true,
      sitePath: "/",
      viewport: SIZE,
      recordVideo: { dir: VIDEO_DIR, size: SIZE },
    });
    const pause = (ms: number) => h.panel.waitForTimeout(ms);
    // Video paths BEFORE close (they finalize on context.close()).
    const panelVideo = h.panel.video();
    const siteVideo = h.site.video();

    try {
      // ── Beat 1: establishing shot ────────────────────────────────────────
      await pause(2500);

      // ── Beat 2: `!recipe run` — typed visibly, sent ──────────────────────
      await h.panel.locator("#query-input").pressSequentially("!recipe run /home/workspace/recipes/e2e-filing.json", { delay: 22 });
      await pause(900);
      await h.panel.locator("#send-btn").click();

      // ── Beat 3: the params card gates the start — type the param ─────────
      const card = h.panel.locator(".recipe-params-card");
      await expect(card).toBeVisible({ timeout: 20_000 });
      await pause(1800);
      await card.locator("input").pressSequentially("Ada Lovelace", { delay: 45 });
      await pause(1200);
      await card.locator(".form-review-confirm").click();

      // ── Beat 4: the deterministic player drives the tab ──────────────────
      await expect(h.panel.locator(".msg-recipe-line")).toContainText("E2E filing", { timeout: 20_000 });
      await expect(h.site).toHaveURL(/form\.html/, { timeout: 30_000 });
      await pause(1500); // the cue-resolved fill lands on the form (visible in the site pane)

      // ── Beat 5: the HUMAN checkpoint — payment is never automated ────────
      await expect(h.site).toHaveURL(/gateway\.html/, { timeout: 30_000 });
      const checkpoint = h.panel.locator(".recipe-checkpoint-card");
      await expect(checkpoint).toContainText("Pay ₹10 on the mock gateway", { timeout: 30_000 });
      await pause(3500); // hold on the checkpoint card + gateway page

      // The user pays BY HAND on the gateway page…
      await h.site.locator("#pay-btn").click();
      await expect(h.site).toHaveURL(/paid=1/, { timeout: 15_000 });
      await expect(h.site.locator("#reg-number")).toBeVisible();
      await pause(2500); // the registration number is on screen

      // …then verifies from the panel: resume → extract → evidence.
      await checkpoint.locator(".form-review-confirm").click();
      await expect(h.panel.locator("#messages .msg-system", { hasText: "Recipe done — E2E filing" })).toBeVisible({ timeout: 30_000 });
      await pause(3500); // hold on the evidence summary

      // ── Beat 6: record mode — learn a recipe from a manual run ───────────
      await h.site.goto(`${E2E_BASE}/`);
      await h.panel.locator("#query-input").pressSequentially("!recipe record demo-learned", { delay: 30 });
      await pause(700);
      await h.panel.locator("#send-btn").click();
      await expect(h.panel.locator(".msg-recipe-record-line")).toBeVisible({ timeout: 20_000 });
      await pause(2000); // the ⏺ line + instructions

      // The user drives the site BY HAND: navigate, then fill the field.
      await h.site.locator("#nav-form").click();
      await expect(h.site).toHaveURL(/form\.html/);
      await h.site.locator("#name").pressSequentially("Recorded Value", { delay: 55 });
      await pause(1800);

      // ── Beat 7: stop → the recipe is learned ─────────────────────────────
      await h.panel.locator(".msg-recipe-record-line .handoff-stop").click();
      await expect(h.panel.locator("#messages .msg-system", { hasText: "Learned recipe" })).toContainText("demo-learned", { timeout: 20_000 });
      await pause(3500); // hold on the learned summary

      // ── Beat 8: replay — parameterized, the recorded value is NOT used ───
      await h.panel.locator("#query-input").pressSequentially("!recipe run demo-learned", { delay: 30 });
      await pause(700);
      await h.panel.locator("#send-btn").click();
      const card2 = h.panel.locator(".recipe-params-card");
      await expect(card2).toBeVisible({ timeout: 20_000 });
      await pause(1200);
      await card2.locator("input").pressSequentially("Fresh Param Value", { delay: 45 });
      await pause(1000);
      await card2.locator(".form-review-confirm").click();

      await expect(h.site.locator("#name")).toHaveValue("Fresh Param Value", { timeout: 30_000 });
      await expect(h.panel.locator("#messages .msg-system", { hasText: "Recipe done — demo-learned" })).toBeVisible({ timeout: 30_000 });
      await pause(4000); // closing shot
    } finally {
      await h.context.close();
      const p = await panelVideo?.path().catch(() => null);
      const s = await siteVideo?.path().catch(() => null);
      if (p) console.log(`[demo-recipes] panel.webm: ${p}`);
      if (s) console.log(`[demo-recipes] site.webm: ${s}`);
    }
  });
});
