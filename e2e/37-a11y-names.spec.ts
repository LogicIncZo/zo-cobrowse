// E2E (#307): accessible-name sweep — every button-like control in the panel
// (static markup + JS-injected, plus the options page) must resolve a
// non-empty accessible name. Icon glyphs (☀ ☰ ✚ → 🎤 ✦) convey nothing
// non-visually; title alone is not a name.

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";

interface NameGap {
  id: string;
  cls: string;
  text: string;
}

// Name resolution per accname spec, simplified: aria-label > aria-labelledby >
// visible text > title. Empty/whitespace/pure-symbol text counts as unnamed
// unless an aria attribute rescues it.
const SWEEP = (): NameGap[] => {
  const symbolOnly = (t: string) => {
    const s = (t || "").trim();
    if (!s) return true;
    // no letters/digits anywhere → glyph-only
    return !/\p{L}|\p{N}/u.test(s);
  };
  const gaps: NameGap[] = [];
  const els = [...document.querySelectorAll("button, [role='button'], [role='img']")] as HTMLElement[];
  for (const el of els) {
    if (el.closest("[aria-hidden='true']")) continue;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    const labelledby = el.getAttribute("aria-labelledby");
    const name =
      el.getAttribute("aria-label")?.trim() ||
      (labelledby ? document.getElementById(labelledby)?.textContent?.trim() : "") ||
      el.textContent?.trim() ||
      el.getAttribute("title")?.trim() ||
      "";
    const symbol = !el.getAttribute("aria-label") && !labelledby && symbolOnly(el.textContent) && !el.getAttribute("title");
    if (!name || symbol) {
      gaps.push({
        id: el.id || "(no id)",
        cls: (el.className + "").split(" ").slice(0, 2).join("."),
        text: (el.textContent || "").trim().slice(0, 12),
      });
    }
  }
  return gaps;
};

test.describe("accessible names sweep (#307)", () => {
  test("every panel control resolves a non-empty accessible name", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const panel = h.panel;
      // Reveal the composer sub-bars so their controls are in the sweep.
      await panel.evaluate(() => {
        document.getElementById("tab-contexts")?.classList.remove("hidden");
      });

      // Exercise the dynamic surfaces once so their buttons exist (footer).
      const gaps = await panel.evaluate(SWEEP);
      expect(gaps, `unnamed controls: ${JSON.stringify(gaps, null, 1)}`).toEqual([]);

      // Spot-check the ticket's named offenders carry the exact labels.
      for (const [id, label] of [
        ["theme-toggle", "Toggle theme"],
        ["help-btn", "Help"],
        ["history-btn", "Conversation history"],
        ["new-chat-btn", "New chat"],
        ["create-mode-btn", "Create a custom Mode"],
        ["mic-btn", "Voice input"],
        ["send-btn", "Send"],
      ] as const) {
        await expect(panel.locator(`#${id}`)).toHaveAttribute("aria-label", label);
      }
      await expect(panel.locator("#send-btn")).toHaveAttribute("aria-keyshortcuts", "Enter");
    } finally {
      await h.context.close();
    }
  });

  test("options page controls resolve names too", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const opts = await h.context.newPage();
      await opts.goto(`chrome-extension://${h.extensionId}/options.html`);
      await opts.waitForLoadState("load");
      const gaps = await opts.evaluate(SWEEP);
      expect(gaps, `unnamed options controls: ${JSON.stringify(gaps, null, 1)}`).toEqual([]);
    } finally {
      await h.context.close();
    }
  });
});
