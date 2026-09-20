// E2E (#303): composer toggle row — the three set-once toggles (📷 Image,
// 🧩 DOM, 🧾 Recipes) render as one wrapping chip row instead of three
// permanent right-aligned rows. Semantics (aria-pressed, send-once/sticky/
// popup) untouched — layout only. No horizontal overflow at dock widths.

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";

interface ToggleProbe {
  rows: number[];
  barHeight: number;
  overflowX: boolean;
  pressed: Record<string, string>;
}

async function probe(panel: import("@playwright/test").Page): Promise<ToggleProbe> {
  return panel.evaluate((): ToggleProbe => {
    const ids = ["shot-toggle", "dom-toggle", "recipe-lib-btn"];
    const rows = ids.map((id) => {
      const el = document.getElementById(id) as HTMLElement;
      el.style.display = ""; // all three stay visible
      return Math.round(el.getBoundingClientRect().top);
    });
    const bar = document.getElementById("tab-contexts") as HTMLElement;
    return {
      rows,
      barHeight: Math.round(bar.getBoundingClientRect().height),
      overflowX: bar.scrollWidth > bar.clientWidth + 1,
      pressed: Object.fromEntries(
        ids.map((id) => [id, document.getElementById(id)?.getAttribute("aria-pressed") ?? "none"]),
      ),
    };
  });
}

test.describe("composer toggle row (#303)", () => {
  for (const width of [360, 400, 420]) {
    test(`at ${width}px: toggles wrap as one row-band, no horizontal overflow, semantics intact`, async () => {
      const h = await openHarness({ freshProfile: true, viewport: { width, height: 720 } });
      try {
        const panel = h.panel;

        // The toggle row lives inside #tab-contexts — unhide it (the 📎 bar
        // starts collapsed on a fresh profile).
        await panel.evaluate(() => {
          document.getElementById("tab-contexts")?.classList.remove("hidden");
        });
        const probe1 = await probe(panel);

        // ≤2 distinct rows (was 3 permanent rows before #303).
        const distinct = [...new Set(probe1.rows)];
        expect(distinct.length).toBeLessThanOrEqual(2);
        expect(probe1.overflowX).toBe(false);

        // aria-pressed semantics survived the relayout.
        expect(probe1.pressed["dom-toggle"]).toBe("true"); // sticky default
        expect(probe1.pressed["shot-toggle"]).toBe("false"); // send-once, off

        // Collapse the strip: toggles share the 📎 button's single line.
        await panel.locator("#tab-strip-collapse").click();
        const probe2 = await probe(panel);
        expect([...new Set(probe2.rows)].length).toBe(1);
        expect(probe2.overflowX).toBe(false);
      } finally {
        await h.context.close();
      }
    });
  }

  test("semantics: arming 📷 still flips aria-pressed (layout did not touch behavior)", async () => {
    const h = await openHarness({ freshProfile: true, viewport: { width: 420, height: 720 } });
    try {
      const panel = h.panel;
      await panel.evaluate(() => {
        document.getElementById("tab-contexts")?.classList.remove("hidden");
      });
      await panel.locator("#shot-toggle").click();
      await expect(panel.locator("#shot-toggle")).toHaveAttribute("aria-pressed", "true");
      await panel.locator("#shot-toggle").click();
      await expect(panel.locator("#shot-toggle")).toHaveAttribute("aria-pressed", "false");
    } finally {
      await h.context.close();
    }
  });
});
