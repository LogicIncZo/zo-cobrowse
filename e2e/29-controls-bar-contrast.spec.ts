// E2E (#297): controls-bar contrast gate — the audit probe's CSS walker,
// committed. In all six themes every visible text node on the controls bar
// must clear the WCAG AA 4.5:1 text minimum, and the MODEL/PERSONA/MODE
// labels must render at 11px (bumped from the audited 10px @ 2.40–3.14:1).
// Also pins the #140 stacked layout at 400px dock width (no regression from
// the size bump).

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";
import { auditContrast, PANEL_THEMES } from "./helpers/css-audit";

test.describe("controls-bar contrast (#297)", () => {
  for (const theme of PANEL_THEMES) {
    const name = theme === "" ? "default" : theme;

    test(`${name}: every controls-bar text ≥4.5:1, labels 11px, stacked at 400px`, async () => {
      const h = await openHarness({ freshProfile: true, viewport: { width: 400, height: 640 } });
      try {
        const panel = h.panel;
        await panel.evaluate((t) => {
          (document.querySelector(".shell") as HTMLElement).dataset.theme = t;
        }, theme);

        const rows = await auditContrast(panel, ".controls-bar");
        expect(rows.length).toBeGreaterThanOrEqual(3); // Model / Persona / Mode labels
        for (const r of rows) {
          expect(r.ratio, `"${r.text}" at ${r.fontSize}px`).toBeGreaterThanOrEqual(4.5);
        }
        for (const label of ["Model", "Persona", "Mode"]) {
          const row = rows.find((r) => r.text === label);
          expect(row, `${label} label visible`).toBeTruthy();
          expect(row!.fontSize).toBe(11);
        }

        // #140 stacked label-over-value groups survive at dock width.
        const dir = await panel.evaluate(
          () => getComputedStyle(document.querySelector(".sel-group") as Element).flexDirection,
        );
        expect(dir).toBe("column");
      } finally {
        await h.context.close();
      }
    });
  }
});
