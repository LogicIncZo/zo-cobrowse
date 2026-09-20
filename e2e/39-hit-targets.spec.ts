// E2E (#309): 24px hit-target floor (WCAG 2.5.8) — every interactive control
// on an answered conversation + composer + open popup measures ≥ 24×24 CSS
// px. Inline prose links are exempt (in-sentence exception); sr-only elements
// are not targets. Visible glyph sizes untouched — padding/min-size only.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery } from "./helpers/extension";

interface SmallTarget {
  id: string;
  cls: string;
  w: number;
  h: number;
}

const SWEEP = (): SmallTarget[] => {
  const sel = "button, [role='button'], [role='option'], [role='tab'], select, input:not([type='hidden']), textarea";
  const els = [...document.querySelectorAll(sel)] as HTMLElement[];
  const out: SmallTarget[] = [];
  for (const el of els) {
    if (el.closest("[aria-hidden='true']") || el.classList.contains("sr-only")) continue;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.width + 0.01 >= 24 && r.height + 0.01 >= 24) continue;
    out.push({
      id: el.id || "(no id)",
      cls: (el.className + "").split(" ").slice(0, 2).join("."),
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
    });
  }
  return out;
};

test.describe("24px hit-target floor (#309)", () => {
  test("zero sub-24 targets on answered chat + composer + popup at 420px", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html", viewport: { width: 420, height: 760 } });
    test.setTimeout(60_000);
    try {
      const panel = h.panel;

      // An answered conversation: message-level TTS/copy/chips all exist.
      await sendQuery(panel, "Summarize this page");
      await panel.locator("#messages .msg-assistant .msg-footer").last().waitFor({ state: "visible", timeout: 20_000 });

      // Composer sub-bar revealed + a popup open (option rows are targets).
      await panel.evaluate(() => {
        document.getElementById("tab-contexts")?.classList.remove("hidden");
        const input = document.querySelector("#query-input") as HTMLTextAreaElement;
        input.value = "%";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await expect(panel.locator("#file-autocomplete")).toBeVisible({ timeout: 10_000 });

      const gaps = await panel.evaluate(SWEEP);
      expect(gaps, `sub-24 targets: ${JSON.stringify(gaps, null, 1)}`).toEqual([]);

      // Footer density: the footer row still fits without grotesque wrapping —
      // its height stays under 3 stacked chip-rows at 420px.
      const footerH = await panel.evaluate(() => {
        const footers = document.querySelectorAll(".msg-assistant .msg-footer");
        const f = footers[footers.length - 1] as HTMLElement;
        return f.getBoundingClientRect().height;
      });
      expect(footerH).toBeLessThan(72); // 3 rows of 24px would be a wrap regression
    } finally {
      await h.context.close();
    }
  });

  test("options page: zero sub-24 targets", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const opts = await h.context.newPage();
      await opts.goto(`chrome-extension://${h.extensionId}/options.html`);
      await opts.waitForLoadState("load");
      const gaps = await opts.evaluate(SWEEP);
      expect(gaps, `sub-24 targets (options): ${JSON.stringify(gaps, null, 1)}`).toEqual([]);
    } finally {
      await h.context.close();
    }
  });
});
