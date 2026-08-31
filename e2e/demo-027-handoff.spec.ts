// Demo recording: the 0.2.7 round — 🤖 `!handoff` (the flagship: unattended
// read-only digest run with boundary parking + chained turns), chat export,
// the stale-build banner, and the Reconnecting banner.
//
// NOT part of the normal e2e suite — run it explicitly:
//   ZO_DEMO=1 bunx playwright test -c e2e/playwright.config.ts demo-027
// BOTH pages are recorded (site tab = the tab Zo drives, panel = the run);
// webms land in e2e/demo-video/ (finalized on context.close()). Assemble:
//   ffmpeg -i site.webm -i panel.webm -filter_complex hstack -pix_fmt yuv420p \
//     demo/0.2.7-handoff-demo.mp4

import { test, expect } from "@playwright/test";
import { openHarness, E2E_BASE, type ExtensionHarness } from "./helpers/extension";

const DEMO = process.env.ZO_DEMO === "1";
const VIDEO_DIR = new URL("./demo-video/", import.meta.url).pathname;
const SIZE = { width: 1280, height: 800 };

test.describe("demo: 0.2.7 — handoff + daily-use wins", () => {
  test.skip(!DEMO, "demo recording — run with ZO_DEMO=1");
  test.setTimeout(180_000);

  test("handoff digest run → export → update banner → reconnect banner", async () => {
    const h: ExtensionHarness = await openHarness({
      freshProfile: true,
      sitePath: "/",
      viewport: SIZE,
      recordVideo: { dir: VIDEO_DIR, size: SIZE },
    });
    const pause = (ms: number) => h.panel.waitForTimeout(ms);
    // Capture video paths BEFORE close (they finalize on context.close()).
    const panelVideo = h.panel.video();
    const siteVideo = h.site.video();

    try {
      // ── Beat 1: establishing shot ────────────────────────────────────────
      await pause(2500);

      // ── Beat 2: type the handoff goal (visibly) and send ─────────────────
      const goal = "compare the pricing across these fixture pages";
      await h.panel.locator("#query-input").pressSequentially(`!handoff ${goal}`, { delay: 45 });
      await pause(900);
      await h.panel.locator("#send-btn").click();

      // User bubble + the live progress line appear
      await expect(h.panel.locator("#messages .msg-user, #messages .msg-handoff-line").first()).toBeVisible({ timeout: 10_000 });
      await expect(h.panel.locator("#messages .msg-handoff-line")).toBeVisible({ timeout: 15_000 });
      await pause(1500);

      // ── Beat 3: turn 1 — boundary park + navigate, progress ticks ────────
      try {
        await expect(h.panel.locator("#messages .handoff-batch").first()).toBeVisible({ timeout: 40_000 });
      } catch (err) {
        const dump = await h.panel.evaluate(() => document.querySelector("#messages")?.innerText ?? "(no #messages)").catch((e) => `(panel eval failed: ${e.message})`);
        console.log(`[demo-027][dump] messages:\n${dump}`);
        throw err;
      }
      // The click is PARKED (readonly boundary) — the batch card says so…
      await expect(h.panel.locator("#messages .handoff-batch-row", { hasText: "⛔ parked" }).first()).toBeVisible({ timeout: 20_000 });
      // …and the sibling navigate ran (site tab actually moved off the start page).
      await expect(h.site).not.toHaveURL(/127\.0\.0\.1:3179\/$/, { timeout: 20_000 });
      // NOTE: no hover on .msg-handoff-line — it re-renders on every push and
      // hover's element-stability wait never settles (demo-recording gotcha).
      await pause(3500);

      // ── Beat 4: turn 2 chained — second batch card, site navigates again ─
      try {
        await expect(h.panel.locator("#messages .handoff-batch").nth(1)).toBeVisible({ timeout: 40_000 });
        await expect(h.site).toHaveURL(/checkout\.html/, { timeout: 40_000 });
      } catch (err) {
        const dump = await h.panel.evaluate(() => document.querySelector("#messages")?.innerText ?? "(no #messages)").catch(() => "(panel eval failed)");
        console.log(`[demo-027][dump4] messages:\n${dump}`);
        throw err;
      }
      await pause(2500);

      // ── Beat 5: turn 3 — the digest lands + the honest end card ──────────
      try {
        await expect(h.panel.locator("#messages .msg-assistant", { hasText: "Pricing digest" }).first()).toBeVisible({ timeout: 40_000 });
      } catch (err) {
        const dump = await h.panel.evaluate(() => document.querySelector("#messages")?.innerText ?? "(no #messages)").catch(() => "(panel eval failed)");
        console.log(`[demo-027][dump5] messages:\n${dump}`);
        const asks = await fetch(`${E2E_BASE}/__requests`).then((r) => r.json()).then((rs: any[]) => rs.map((r: any) => `${r.url} :: ${String(r.body?.input ?? "").slice(0, 80)}`)).catch((e) => `asks failed: ${e.message}`);
        console.log(`[demo-027][dump5] asks:\n${Array.isArray(asks) ? asks.join("\n") : asks}`);
        const runs = await h.serviceWorker.evaluate(() =>
          new Promise((r) => chrome.storage.session.get("cobrowse_handoff_runs", (v) => r(v.cobrowse_handoff_runs))),
        ).catch(() => null);
        console.log(`[demo-027][dump5] runs: ${JSON.stringify(runs)?.slice(0, 800)}`);
        throw err;
      }
      await expect(h.panel.locator("#messages .msg-system", { hasText: "Handoff done" }).first()).toBeVisible({ timeout: 15_000 });
      // Progress line is gone (run over)
      await expect(h.panel.locator("#messages .msg-handoff-line")).toHaveCount(0);
      await pause(3000);

      // ── Beat 6: history view → ⬇ Markdown export ─────────────────────────
      console.log("[demo-027] beat 6: history/export");
      await h.panel.locator("#history-btn").click();
      const card = h.panel.locator(".history-card").first();
      await expect(card).toBeVisible({ timeout: 10_000 });
      await pause(1200);
      const exportBtn = card.locator("button", { hasText: "⬇" });
      await exportBtn.hover();
      await pause(1200);
      const [download] = await Promise.all([
        h.panel.waitForEvent("download", { timeout: 10_000 }),
        exportBtn.click(),
      ]);
      await download.saveAs("/tmp/027-demo-export.md");
      await pause(1800);
      console.log("[demo-027] beat 6 done, back to chat");
      // The history view is a full overlay (inset:0) — exit via its Back
      // button; the header ☰ is covered and a click would hang forever.
      await h.panel.locator("#back-to-chat-btn").click();

      // ── Beat 7: stale-build banner (simulate an update + reload) ─────────
      console.log("[demo-027] beat 7: update banner");
      await h.serviceWorker.evaluate(() =>
        new Promise<void>((r) => chrome.storage.session.set({ cobrowse_updated_at: Date.now() }, () => r())),
      );
      await h.panel.reload();
      await expect(h.panel.locator("#messages .msg-system", { hasText: "Extension updated" }).first()).toBeVisible({ timeout: 20_000 });
      await pause(2200);
      await h.panel.locator(".update-banner-dismiss").click();
      await expect(h.panel.locator("#messages .msg-system", { hasText: "Extension updated" })).toHaveCount(0);
      await pause(1200);

      // ── Beat 8: transient drop → "➳ Reconnecting…" banner, no error card ─
      console.log("[demo-027] beat 8: reconnect");
      // Arm from Node (page-side fetches raced the reload).
      const armRes = await fetch(`${E2E_BASE}/__flaky/arm`);
      const armText = await armRes.text();
      if (armText !== "armed") throw new Error(`flaky arm failed: ${armRes.status} ${armText}`);
      await h.panel.screenshot({ path: "/tmp/027-before-fill.png" });
      console.log("[demo-027] panel url at beat 8:", h.panel.url());
      await h.panel.locator("#query-input").fill("flaky network check — recover gracefully");
      await h.panel.locator("#send-btn").click();
      // The banner appears ~1s after the drop (backoff) and clears when the
      // retried answer's first chunk lands — assert immediately, hold it, then
      // wait for the recovery.
      await expect(h.panel.locator("#messages .msg-reconnecting")).toBeVisible({ timeout: 15_000 });
      await pause(2200);
      await expect(h.panel.locator("#messages .msg-assistant", { hasText: "Steady answer" }).first()).toBeVisible({ timeout: 30_000 });
      await expect(h.panel.locator("#messages .msg-error")).toHaveCount(0);
      await pause(3000);
    } finally {
      await h.context.close();
      for (const [name, v] of [["panel", panelVideo], ["site", siteVideo]] as const) {
        const p = v ? await v.path().catch(() => null) : null;
        if (p) console.log(`[demo-027] ${name}: ${p}`);
      }
    }
  });
});
