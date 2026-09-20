// E2E (#308): connection status has a text alternative — the dot carries a
// stateful aria-label AND a visually-hidden sr-only text twin (WCAG 1.4.1),
// mirrored by updateStatus. Dot colors unchanged.

import { test, expect } from "@playwright/test";
import { openHarness } from "./helpers/extension";

test.describe("connection status text alternative (#308)", () => {
  test("connected state: aria-label + sr-only twin, visually hidden", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const panel = h.panel;
      // Harness seeds a token → init reports connected.
      await expect(panel.locator("#status-dot")).toHaveAttribute(
        "aria-label", "Connection status: Zo connected", { timeout: 10_000 },
      );
      const twin = panel.locator("#status-text");
      await expect(twin).toHaveText("Connection status: Zo connected");

      // The twin renders for AT but is visually hidden in every theme.
      const hidden = await twin.evaluate((el: HTMLElement) => {
        const st = getComputedStyle(el);
        return {
          w: st.width, h: st.height,
          clip: st.clip,
          pos: st.position,
          overflow: st.overflow,
        };
      });
      expect(parseFloat(hidden.w)).toBeLessThanOrEqual(1);
      expect(parseFloat(hidden.h)).toBeLessThanOrEqual(1);
      expect(hidden.clip).toContain("rect(");
      expect(hidden.pos).toBe("absolute");
    } finally {
      await h.context.close();
    }
  });

  test("no token: dot + twin read 'Not configured'", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      const panel = h.panel;
      // Strip the token the harness seeded, then reload — init re-reads config.
      await panel.evaluate(() =>
        new Promise<void>((res) => chrome.storage.local.remove("zoAccessToken", () => res())),
      );
      await panel.reload();

      await expect(panel.locator("#status-dot")).toHaveAttribute(
        "aria-label", "Connection status: Not configured — open settings", { timeout: 10_000 },
      );
      await expect(panel.locator("#status-text")).toHaveText(
        "Connection status: Not configured — open settings",
      );
    } finally {
      await h.context.close();
    }
  });
});
