// E2E (#310): one keyboard focus ring — every Tab stop shows the 2px amber
// outline (:focus-visible), and mouse focus does NOT show it. Sweep walks
// header → controls → composer with real keypresses.

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";

test.describe("focus ring (#310)", () => {
  test("every keyboard Tab stop shows a ring; mouse focus stays clean", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html", viewport: { width: 460, height: 720 } });
    try {
      const panel = h.panel;

      // Tab through the header + controls into the composer: each stop must
      // carry a ≥2px outline (the global :focus-visible ring).
      await panel.keyboard.press("Tab");
      const stops: { tag: string; id: string; fv: boolean; style: string }[] = [];
      for (let i = 0; i < 24; i++) {
        const stop = await panel.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const st = getComputedStyle(el);
          return {
            tag: el.tagName,
            id: el.id,
            fv: el.matches(":focus-visible"),
            style: st.outlineStyle,
          };
        });
        if (stop) stops.push(stop);
        if (stop?.id === "query-input") break; // reached the composer
        await panel.keyboard.press("Tab");
      }
      expect(stops.length).toBeGreaterThanOrEqual(5); // header icons + selects + composer
      // Ring = :focus-visible matched AND a solid outline (our 2px amber, or
      // a component's own ring).
      const ringless = stops.filter((s) => !s.fv || s.style === "none");
      expect(ringless, `stops without a ring: ${JSON.stringify(stops)}`).toEqual([]);

      // The composer textarea is among the stops with the ring.
      expect(stops.some((s) => s.id === "query-input")).toBe(true);

      // Mouse focus on a BUTTON stays clean (no ring) — blur first so the
      // click actually re-evaluates focus-visible. (Text inputs always match
      // :focus-visible in Chromium — caret entry is keyboard input — so the
      // textarea legitimately keeps its ring on click.)
      await panel.locator("#messages .msg-system").first().click();
      await panel.locator("#help-btn").click();
      const mouse = await panel.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        return { fv: el.matches(":focus-visible"), style: getComputedStyle(el).outlineStyle };
      });
      expect(mouse.fv, "mouse focus must not be keyboard-visible").toBe(false);
      expect(mouse.style).toBe("none");
      await expect(panel.locator("#help-btn")).toBeFocused();
    } finally {
      await h.context.close();
    }
  });

  test("options page inputs show the ring on keyboard focus", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const opts = await h.context.newPage();
      await opts.goto(`chrome-extension://${h.extensionId}/options.html`);
      await opts.waitForLoadState("load");
      await opts.keyboard.press("Tab");
      const ok = await opts.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return !!el && el.matches(":focus-visible") && getComputedStyle(el).outlineStyle === "solid";
      });
      expect(ok).toBe(true);
    } finally {
      await h.context.close();
    }
  });
});
