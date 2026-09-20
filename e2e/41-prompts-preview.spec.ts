// E2E (#311): the Prompts editor's LIVE PREVIEW is populated on load and
// re-renders on Mode switch — without waiting for a user edit. (The audit's
// empty box was against 0.3.2-era code; fill() now calls renderPreview on
// hydration. This spec pins the behavior so it cannot regress.)

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";

async function openPromptsPane(h: any) {
  const opts = await h.context.newPage();
  await opts.goto(`chrome-extension://${h.extensionId}/options.html`);
  await opts.waitForLoadState("load");
  await opts.evaluate(() => {
    const btn = [...document.querySelectorAll("#settings-nav button")].find((b) =>
      /prompt/i.test(b.textContent || "")
    );
    (btn as HTMLElement).click();
  });
  return opts;
}

test.describe("prompts editor LIVE PREVIEW (#311)", () => {
  test("preview non-empty on load; Mode switch re-renders without touching inputs", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const opts = await openPromptsPane(h);

      // On load: populated, no edit needed.
      const pre = opts.locator("#prompt-preview-pre");
      await expect(pre).not.toBeEmpty();
      await expect(pre).toContainText("You are Zo");
      const first = await pre.textContent();
      const meta = opts.locator("#prompt-preview-meta");
      await expect(meta).toContainText("Context:");
      await expect(meta).toContainText("≈ Tokens:");

      // Switch Mode (cobrowse → ask): fields hydrate and the preview
      // re-renders WITHOUT any input event.
      await opts.evaluate(() => {
        const sel = document.getElementById("prompt-mode-select") as HTMLSelectElement;
        sel.value = "ask";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect(opts.locator("#prompt-system")).not.toHaveValue(first?.slice(0, 20) ?? "", { timeout: 5_000 });
      await expect(pre).not.toBeEmpty();
      const second = await pre.textContent();
      expect(second).toBeTruthy();
      // The different Mode produced a different prompt (or at least re-rendered).
      expect(second === first || second!.length > 0).toBe(true);
      expect(second).not.toBe(first); // ask's prompt differs from cobrowse's
    } finally {
      await h.context.close();
    }
  });
});
