// Demo recording: the #26 form-fill review-card flow, paced for viewing and
// captured via Playwright's recordVideo (headless new-Chromium). Records BOTH
// the sidepanel (review card → confirm → per-field timeline) and the page
// (fields filling live); stitch the two webms side-by-side with:
//   ffmpeg -i panel.webm -i site.webm -filter_complex "[0:v][1:v]hstack=inputs=2" \
//     -pix_fmt yuv420p demo/fill-form-demo.mp4
//
// NOT part of the normal e2e suite — run it explicitly:
//   ZO_DEMO=1 bunx playwright test -c e2e/playwright.config.ts demo-fill-form
// The webms land in e2e/demo-video/ (finalized on context.close()).

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, type ExtensionHarness } from "./helpers/extension";

const DEMO = process.env.ZO_DEMO === "1";
const VIDEO_DIR = new URL("./demo-video/", import.meta.url).pathname;
const SIZE = { width: 960, height: 800 };

test.describe("demo: form-fill review card (#26)", () => {
  test.skip(!DEMO, "demo recording — run with ZO_DEMO=1");
  test.setTimeout(120_000);

  test("sensitive checkout form → review card → edit → confirm → filled", async () => {
    const h: ExtensionHarness = await openHarness({
      freshProfile: true,
      sitePath: "/checkout.html",
      viewport: SIZE,
      recordVideo: { dir: VIDEO_DIR, size: SIZE },
    });
    const pause = (ms: number) => h.panel.waitForTimeout(ms);
    try {
      // 1. Starting point: the checkout form (password + card = sensitive),
      //    the sidepanel ready.
      await pause(1500);
      await h.site.locator("#checkout-form").hover();
      await pause(800);

      // 2. Ask Zo to fill the form — the batch fill_form parks at the gate.
      await sendQuery(h.panel, "fill the checkout form");
      const card = h.panel.locator(".form-review-card");
      await expect(card).toBeVisible({ timeout: 20_000 });

      // 3. The review card: reason chips, editable Email, "left for you 🔑"
      //    for password + card. Give it a beat, walk the rows with the mouse.
      await pause(1200);
      await card.hover();
      await pause(600);
      const rows = card.locator(".form-review-row");
      const count = await rows.count();
      for (let i = 0; i < count; i++) {
        await rows.nth(i).hover();
        await pause(500);
      }
      await pause(600);

      // 4. Edit the proposed email — typed visibly.
      const email = card.locator("input[data-target='Email']");
      await email.hover();
      await email.fill("");
      await email.pressSequentially("ada@zocomputer.dev", { delay: 55 });
      await pause(700);

      // 5. Confirm — the page fills (secrets untouched), ONE timeline card
      //    with per-field ✓ rows appears.
      await card.locator(".form-review-confirm").hover();
      await pause(400);
      await card.locator(".form-review-confirm").click();
      await expect(h.site.locator("#email")).toHaveValue("ada@zocomputer.dev", { timeout: 20_000 });
      await expect(h.panel.locator(".action-card-fill_form .field-result")).toHaveCount(3, { timeout: 20_000 });
      await h.site.locator("#email").hover();
      await pause(800);
      // The run body starts collapsed — expand it so the per-field rows are
      // on screen (hovering a hidden card would block forever).
      const header = h.panel.locator("#action-run .action-run-header");
      await header.hover();
      await pause(400);
      await header.click();
      await pause(400);
      await h.panel.locator("#action-timeline .action-card-fill_form").hover();
      await pause(3000);
    } finally {
      // Videos finalize on close — resolve both paths before closing.
      const panelVideo = h.panel.video();
      const siteVideo = h.site.video();
      await h.context.close();
      for (const v of [panelVideo, siteVideo]) {
        if (v) {
          const path = await v.path().catch(() => null);
          if (path) console.log(`[demo] video: ${path}`);
        }
      }
    }
  });
});
