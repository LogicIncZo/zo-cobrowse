// E2E (#298): message-surface contrast gate — the committed CSS-audit walker
// (e2e/helpers/css-audit.ts) over the real rendered footer set (Copy, mode
// chip, tier chip, conversation chip, timestamp) + quick chips after a real
// streamed turn. Every visible text node in #messages and .chips-wrap must
// clear WCAG AA 4.5:1 in all six themes. The footer hierarchy (time dimmer
// than chips dimmer than body) is pinned structurally in dark + light.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery } from "./helpers/extension";
import { auditContrast, PANEL_THEMES } from "./helpers/css-audit";

test.describe("message-surface contrast (#298)", () => {
  for (const theme of PANEL_THEMES) {
    const name = theme === "" ? "default" : theme;

    test(`${name}: every message-surface text ≥4.5:1`, async () => {
      const h = await openHarness({ freshProfile: true, viewport: { width: 420, height: 720 } });
      try {
        const panel = h.panel;

        // One real turn → real footer (Copy / mode chip / tier chip / conv
        // chip / timestamp). Rendered once; the theme flips below re-audit
        // the same DOM the way applyTheme repaints it.
        await sendQuery(panel, "Summarize this page");
        await panel
          .locator("#messages .msg-assistant .msg-footer")
          .last()
          .waitFor({ state: "visible", timeout: 20_000 });

        await panel.evaluate((t) => {
          document.documentElement.setAttribute("data-theme", t);
        }, theme);

        const rows = [
          ...(await auditContrast(panel, "#messages")),
          ...(await auditContrast(panel, ".chips-wrap")),
        ];
        expect(rows.length).toBeGreaterThanOrEqual(5); // footer + chips content present
        const failing = rows.filter((r) => r.ratio < 4.5);
        if (failing.length) {
          console.log(`FAILING[${name}]>> ` + JSON.stringify(failing));
        }
        expect(failing, `${name}: sub-AA rows`).toEqual([]);

        // Hierarchy: time dimmer than chips dimmer than body (dark + light
        // are the shipped defaults the gate calls out).
        if (theme === "" || theme === "dark" || theme === "light") {
          const cols = await panel.evaluate(() => {
            const c = (sel: string) => {
              const el = document.querySelector(sel);
              return el ? getComputedStyle(el).color : null;
            };
            const footers = document.querySelectorAll(".msg-assistant .msg-footer");
            const footer = footers[footers.length - 1];
            return {
              time: footer ? getComputedStyle(footer.querySelector(".msg-footer-time") ?? footer).color : null,
              chip: c(".msg-assistant .msg-footer .msg-footer-mode") || c(".msg-assistant .msg-footer .msg-footer-btn"),
              body: c(".msg-assistant .msg-body"),
            };
          });
          expect(cols.time).toBeTruthy();
          expect(cols.chip).toBeTruthy();
          expect(cols.time).not.toEqual(cols.chip); // time dimmer than chips
          expect(cols.chip).not.toEqual(cols.body); // chips dimmer than body
        }
      } finally {
        await h.context.close();
      }
    });
  }
});
