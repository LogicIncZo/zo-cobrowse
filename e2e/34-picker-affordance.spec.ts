// E2E (#304): picker popups communicate keyboard use — a shared hint footer
// ("↑↓ navigate · ↵ select · Esc close") renders on all three popups, the
// highlighted row carries an accent edge (amber ≥3:1 non-text contrast), and
// arrowing updates aria-activedescendant so screen readers track the row.

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";

async function typeIntoComposer(panel: any, text: string) {
  await panel.evaluate((t: string) => {
    const input = document.querySelector("#query-input") as HTMLTextAreaElement;
    input.value = t;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}

async function pressComposerKey(panel: any, key: string) {
  await panel.evaluate((k: string) => {
    const wrap = document.querySelector(".input-wrap") as HTMLElement;
    wrap.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  }, key);
}

const HINT = "↑↓ navigate · ↵ select · Esc close";

test.describe("picker popup affordance (#304)", () => {
  test("@ tabs popup: hint + accent row + aria-activedescendant tracks arrows", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      // A second real tab so the @ popup has ≥2 rows to move between.
      const extra = await h.context.newPage();
      await extra.goto(new URL("/links.html", (await import("./helpers/extension")).E2E_BASE).href);

      await typeIntoComposer(h.panel, "@");
      const popup = h.panel.locator("#tab-autocomplete");
      await expect(popup).toBeVisible();
      await expect(popup.locator(".picker-hint")).toHaveText(HINT);
      await expect(popup.locator(".tab-ac-item").first()).toHaveAttribute("role", "option");
      await expect(popup).toHaveAttribute("aria-activedescendant", "tab-ac-opt-0");
      await expect(popup.locator(".tab-ac-item")).toHaveCount(2, { timeout: 10_000 });

      // Arrow down: class moves AND aria-activedescendant follows.
      await pressComposerKey(h.panel, "ArrowDown");
      await expect(popup.locator(".tab-ac-item").nth(1)).toHaveClass(/tab-ac-active/);
      await expect(popup).toHaveAttribute("aria-activedescendant", "tab-ac-opt-1");

      // Accent edge on the active row (non-text contrast pair).
      const accent = await popup.locator(".tab-ac-item.tab-ac-active").evaluate(
        (el: HTMLElement) => getComputedStyle(el).boxShadow,
      );
      expect(accent).toContain("inset");
    } finally {
      await h.context.close();
    }
  });

  test("/ skills popup: hint + aria-activedescendant tracks arrows", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      await typeIntoComposer(h.panel, "/");
      const popup = h.panel.locator("#skill-autocomplete");
      await expect(popup).toBeVisible();
      await expect(popup.locator("button.picker-item").first()).toBeVisible({ timeout: 10_000 });
      await expect(popup.locator(".picker-hint")).toHaveText(HINT);
      await expect(popup).toHaveAttribute("aria-activedescendant", "skill-ac-opt-0");
      await pressComposerKey(h.panel, "ArrowDown");
      await expect(popup).toHaveAttribute("aria-activedescendant", "skill-ac-opt-1");
    } finally {
      await h.context.close();
    }
  });

  test("% files popup: hint + aria-activedescendant tracks arrows", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      await typeIntoComposer(h.panel, "%");
      const popup = h.panel.locator("#file-autocomplete");
      await expect(popup).toBeVisible();
      await expect(popup.locator("button.picker-item").first()).toBeVisible({ timeout: 10_000 });
      await expect(popup.locator(".picker-hint")).toHaveText(HINT);
      await expect(popup).toHaveAttribute("aria-activedescendant", "file-ac-opt-0");
      await pressComposerKey(h.panel, "ArrowDown");
      await expect(popup).toHaveAttribute("aria-activedescendant", "file-ac-opt-1");
    } finally {
      await h.context.close();
    }
  });

  test("selected-row accent clears ≥3:1 non-text contrast against the popup surface", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      await typeIntoComposer(h.panel, "@");
      await h.panel.locator("#tab-autocomplete").waitFor({ state: "visible" });
      const ratio = await h.panel.evaluate(() => {
        const lum = (rgb: number[]) => {
          const f = (c: number) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
        };
        const parse = (s: string) => (s.match(/\d+(\.\d+)?/g) || []).map(Number);
        const active = document.querySelector(".tab-ac-item.tab-ac-active") as HTMLElement;
        const shadow = getComputedStyle(active).boxShadow; // inset 3px 0 0 0 rgb(r, g, b)
        const accent = parse(shadow).slice(0, 3);
        const bgEl = active.closest(".tab-autocomplete") as HTMLElement;
        const bg = parse(getComputedStyle(bgEl).backgroundColor).slice(0, 3);
        const l1 = lum(accent);
        const l2 = lum(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(3);
    } finally {
      await h.context.close();
    }
  });
});
