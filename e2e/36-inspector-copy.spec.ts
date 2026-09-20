// E2E (#306): prompt inspector copy — the meta row gains a Copy button that
// writes the RAW assembled prompt (clipboard equals the <pre> text), with
// "Copied ✓" feedback. Token estimate + meta chips unchanged; preview
// letter-spacing pinned to normal.

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";

test.describe("prompt inspector copy (#306)", () => {
  test("Copy writes the raw prompt; feedback + chips + spacing intact", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const panel = h.panel;

      // Real clipboard (zo-links pattern).
      await h.context.grantPermissions(["clipboard-read", "clipboard-write"]);

      // Open the details first, then type — and confirm the query landed in
      // the preview before copying (the inspector re-renders async).
      await panel.locator("#prompt-inspector-summary").click();
      await panel.evaluate(() => {
        const input = document.querySelector("#query-input") as HTMLTextAreaElement;
        input.value = "What is on this page?";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const pre = panel.locator("#prompt-preview");
      await expect(pre).toContainText("What is on this page?", { timeout: 5_000 });

      // Copy → clipboard equals the rendered text (raw string, not HTML).
      // Read BOTH after the copy: the inspector re-renders async (tab polls
      // add the auto-active T1 line), so a pre-copy snapshot can be stale.
      await panel.locator(".prompt-copy-btn").click();
      await expect(panel.locator(".prompt-copy-btn")).toHaveText("Copied ✓");
      const clip = await panel.evaluate(() => navigator.clipboard.readText());
      const rendered = await pre.textContent();
      expect(clip).toBe(rendered);
      expect(clip).toContain("What is on this page?");

      // Meta chips + token estimate unchanged.
      await expect(panel.locator("#prompt-inspector-summary")).toContainText("Prompt preview · ~");
      await expect(panel.locator("#prompt-inspector-meta")).toContainText("Mode:");
      await expect(panel.locator("#prompt-inspector-meta")).toContainText("Context:");

      // Feedback resets after the flash.
      await expect(panel.locator(".prompt-copy-btn")).toHaveText("⧉ Copy", { timeout: 3_000 });

      // Letter-spacing pinned to normal on the preview.
      const spacing = await pre.evaluate((el: HTMLElement) => getComputedStyle(el).letterSpacing);
      expect(spacing === "normal" || spacing === "0px").toBe(true);
    } finally {
      await h.context.close();
    }
  });
});
