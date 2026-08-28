// E2E (feature/textarea-fill): the write-assist floating Zo icon in a real
// Chromium. Focus the job-application textarea → the icon appears at its corner
// → click opens the popover → Enhance sends the first content-initiated
// ENHANCE_TEXT through the real background one-shot → the mock returns the
// improved text → Accept fills the textarea (framework-safe). Asserts the wire
// request is a threadless /zo/ask (write-assist marker, no conversation_id).

import { test, expect } from "@playwright/test";
import { openHarness, recordedAsks } from "./helpers/extension";

const ENHANCED = "I led the migration of 40 dashboards to DuckDB, unifying our analytics stack and cutting p95 query times roughly in half.";

test.describe("write-assist (feature/textarea-fill)", () => {
  test("floating icon enhances a textarea lead and fills it back on Accept", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/writing.html" });
    try {
      const ta = h.site.locator("#proj");
      await expect(ta).toHaveValue("Led migration of 40 dashboards to DuckDB");

      // Focus the textarea → the floating Zo icon appears (shadow-DOM pierced).
      await ta.focus();
      const icon = h.site.locator(".zo-wa-icon");
      await expect(icon).toBeVisible({ timeout: 10_000 });

      // Click the icon → popover opens in the compose state.
      await icon.click();
      const pop = h.site.locator(".zo-wa-pop");
      await expect(pop).toBeVisible({ timeout: 10_000 });
      await expect(pop.locator(".zo-wa-instr")).toBeVisible();

      // Enhance → loading → result preview (the mock's improved text).
      await pop.locator("button", { hasText: "Enhance" }).click();
      const result = pop.locator(".zo-wa-result");
      await expect(result).toBeVisible({ timeout: 20_000 });
      await expect(result).toHaveText(ENHANCED);

      // Nothing written to the page yet — preview gates the fill.
      await expect(ta).toHaveValue("Led migration of 40 dashboards to DuckDB");

      // Accept → the textarea is filled and the popover closes.
      await pop.locator("button", { hasText: "Accept" }).click();
      await expect(ta).toHaveValue(ENHANCED, { timeout: 10_000 });
      await expect(pop).toBeHidden({ timeout: 10_000 });

      // The framework-style binding observed the input event.
      await expect
        .poll(async () => h.site.evaluate(() => (document.getElementById("apply-result") as HTMLElement).dataset.proj))
        .toBe(ENHANCED);

      // Wire contract: a one-shot enhance call, threadless (no conversation_id).
      const asks = await recordedAsks();
      const enhance = asks.filter((r: any) => String(r.body?.input || "").includes("write-assist"));
      expect(enhance.length).toBeGreaterThanOrEqual(1);
      const body = enhance[enhance.length - 1].body;
      expect(body.conversation_id).toBeUndefined();
      expect(body.input).toContain("Led migration of 40 dashboards to DuckDB");
      expect(body.input).toContain("Describe your project");
    } finally {
      await h.context.close();
    }
  });

  test("contenteditable rich editors (GitHub's new issue form) enhance + fill back", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/writing.html" });
    try {
      const rich = h.site.locator("#rich");
      await rich.focus();
      const icon = h.site.locator(".zo-wa-icon");
      await expect(icon).toBeVisible({ timeout: 10_000 });

      await icon.click();
      const pop = h.site.locator(".zo-wa-pop");
      await expect(pop).toBeVisible({ timeout: 10_000 });
      await pop.locator("button", { hasText: "Enhance" }).click();
      const result = pop.locator(".zo-wa-result");
      await expect(result).toBeVisible({ timeout: 20_000 });
      await expect(result).toHaveText(ENHANCED);

      // Preview gates the write here too.
      await expect(rich).toHaveText("Led migration of 40 dashboards to DuckDB");

      // Accept routes through the editor's own input pipeline (select-all +
      // execCommand) — real Chromium exercises the real path here.
      await pop.locator("button", { hasText: "Accept" }).click();
      await expect(rich).toHaveText(ENHANCED, { timeout: 10_000 });
      await expect(pop).toBeHidden({ timeout: 10_000 });
    } finally {
      await h.context.close();
    }
  });

  test("no icon appears when the toggle is disabled", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/writing.html" });
    try {
      // Flip the setting off through the real service worker.
      await h.serviceWorker.evaluate(
        () => new Promise<void>((r) => chrome.storage.sync.set({ enableWriteAssist: false }, () => r())),
      );
      // A fresh focus with the toggle off must not paint the widget. Reload to
      // be certain the content script re-reads the setting from a clean slate.
      await h.site.reload();
      await h.site.locator("#proj").focus();
      await expect(h.site.locator(".zo-wa-icon")).toHaveCount(0);
    } finally {
      await h.context.close();
    }
  });
});
