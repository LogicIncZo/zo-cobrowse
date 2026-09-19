// E2E (#296): dock-width header policy — at the panel's real ~400–420px dock
// width the brand row collapses to the icon so the page title (the user's
// primary "where am I" signal) keeps a ≥16-character budget; at ≥600px the
// full brand renders unchanged. The header action buttons must never wrap or
// push the title out.
//
// Char-budget math: #page-url is a nowrap ellipsized line in a monospace
// face, so visible chars ≈ clientWidth / (scrollWidth / textLength).

import { test, expect, type Page } from "@playwright/test";
import { openHarness } from "./helpers/extension";

const LONG_TITLE = "Quarterly infrastructure cost review — production telemetry deep dive";

interface HeaderProbe {
  brandZoDisplay: string;
  brandSubDisplay: string;
  iconDisplay: string;
  charBudget: number;
  headerOverflow: boolean;
  actionsInsideHeader: boolean;
}

async function probeHeader(panel: Page): Promise<HeaderProbe> {
  return panel.evaluate((title) => {
    const pageUrl = document.querySelector("#page-url") as HTMLElement;
    pageUrl.textContent = title;
    pageUrl.title = "https://example.com/telemetry/quarterly-infrastructure-cost-review";

    const disp = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display : "missing";
    };
    const charW = pageUrl.scrollWidth / Math.max(1, title.length);
    const header = document.querySelector(".header") as HTMLElement;
    const actions = document.querySelector(".header-actions") as HTMLElement;
    const hBox = header.getBoundingClientRect();
    const aBox = actions.getBoundingClientRect();
    return {
      brandZoDisplay: disp(".brand-zo"),
      brandSubDisplay: disp(".brand-sub"),
      iconDisplay: disp(".brand-icon-img"),
      charBudget: Math.floor(pageUrl.clientWidth / charW),
      headerOverflow: header.scrollWidth > header.clientWidth + 1,
      actionsInsideHeader: aBox.right <= hBox.right + 1 && aBox.height <= hBox.height,
    };
  }, LONG_TITLE);
}

test.describe("dock-width header (#296)", () => {
  for (const width of [400, 420]) {
    test(`at ${width}px the brand collapses to the icon and the title keeps ≥16 chars`, async () => {
      const h = await openHarness({ freshProfile: true, viewport: { width, height: 640 } });
      try {
        const probe = await probeHeader(h.panel);
        expect(probe.brandZoDisplay).toBe("none");
        expect(probe.brandSubDisplay).toBe("none");
        expect(probe.iconDisplay).toBe("block"); // the icon stays as identity
        expect(probe.charBudget).toBeGreaterThanOrEqual(16);
        expect(probe.headerOverflow).toBe(false); // buttons never wrap/push the title
        expect(probe.actionsInsideHeader).toBe(true);
      } finally {
        await h.context.close();
      }
    });
  }

  test("at 600px the full brand renders unchanged", async () => {
    const h = await openHarness({ freshProfile: true, viewport: { width: 600, height: 640 } });
    try {
      const probe = await probeHeader(h.panel);
      expect(probe.brandZoDisplay).not.toBe("none");
      expect(probe.brandSubDisplay).not.toBe("none");
      expect(probe.iconDisplay).toBe("block");
      expect(probe.headerOverflow).toBe(false);
    } finally {
      await h.context.close();
    }
  });
});
