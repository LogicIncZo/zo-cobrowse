// E2E (#305): same-title tabs are distinguishable everywhere a reference
// appears — strip chips, @ popup rows, and the manifest Zo actually receives
// share one disambiguation helper (path suffix on title+host collision).
// Unique titles render byte-identically to before.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, recordedAsks, clearRecordedRequests, waitForTurnComplete, E2E_BASE } from "./helpers/extension";

test.describe("same-title tab disambiguation (#305)", () => {
  test("two same-title tabs show distinct labels in strip + @ popup + manifest", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      // Second tab on the duplicate-title fixture — a real title+host collision.
      const twin = await h.context.newPage();
      await twin.goto(new URL("/form-copy.html", E2E_BASE).href);
      await h.panel.waitForTimeout(1200); // tabs poll

      const panel = h.panel;
      panel.evaluate(() => {
        document.getElementById("tab-contexts")?.classList.remove("hidden");
      });

      // Strip: two chips, both from the same title, but NOT identical.
      const strip = panel.locator("#tab-strip .tab-chip");
      await expect(strip).toHaveCount(2, { timeout: 10_000 });
      const chipLabels = await strip.allTextContents();
      const distinctChips = new Set(chipLabels.map((c) => c.replace("◈ ", "").trim())).size;
      expect(distinctChips, `chips: ${JSON.stringify(chipLabels)}`).toBe(2);
      expect(chipLabels.some((c) => c.includes("/form.html"))).toBe(true);
      expect(chipLabels.some((c) => c.includes("/form-copy.html"))).toBe(true);

      // @ popup: rows carry the same disambiguation.
      await panel.evaluate(() => {
        const input = document.querySelector("#query-input") as HTMLTextAreaElement;
        input.value = "@";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const popup = panel.locator("#tab-autocomplete");
      await expect(popup).toBeVisible();
      const rows = await popup.locator(".tab-ac-item .tab-ac-name").allTextContents();
      const distinctRows = new Set(rows.map((r) => r.replace("◈ ", "").trim())).size;
      expect(distinctRows, `rows: ${JSON.stringify(rows)}`).toBe(2);
      await panel.keyboard.press("Escape");

      // Manifest: reference both tabs; the prompt Zo receives distinguishes them.
      await panel.evaluate(() => {
        const input = document.querySelector("#query-input") as HTMLTextAreaElement;
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      for (const chip of await strip.all()) await chip.click(); // arm both
      await clearRecordedRequests();
      await sendQuery(panel, "compare these two tabs");
      await waitForTurnComplete(panel, 20_000);
      const asks = await recordedAsks();
      const inputs = asks.map((r) => String(r.body?.input || ""));
      const manifest = inputs.find((i) => i.includes("## Referenced Tabs")) || "";
      expect(manifest).toContain("/form.html");
      expect(manifest).toContain("/form-copy.html");
    } finally {
      await h.context.close();
    }
  });

  test("unique titles render exactly as today (no suffix)", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const twin = await h.context.newPage();
      await twin.goto(new URL("/checkout.html", E2E_BASE).href); // different title
      await h.panel.waitForTimeout(1200);
      const panel = h.panel;
      panel.evaluate(() => {
        document.getElementById("tab-contexts")?.classList.remove("hidden");
      });
      const strip = panel.locator("#tab-strip .tab-chip");
      await expect(strip).toHaveCount(2, { timeout: 10_000 });
      const chipLabels = (await strip.allTextContents()).map((c) => c.replace("◈ ", "").trim());
      expect(chipLabels).toContain("E2E Fixture Form");
      expect(chipLabels).toContain("E2E Fixture Checkout");
      expect(chipLabels.some((c) => c.includes("/"))).toBe(false); // no path suffix
    } finally {
      await h.context.close();
    }
  });
});
