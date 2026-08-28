// E2E: #27 link chips + "Open all" — a research-style prose answer full of
// links renders the chips card under the assistant bubble; "Open all" opens
// real tabs (first foreground, rest background) and auto-references them in
// the tab strip so read_tab follow-ups can engage.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, waitForTurnComplete, E2E_BASE, type ExtensionHarness } from "./helpers/extension";

let h: ExtensionHarness;

test.beforeAll(async () => {
  // sitePath=/form.html so the first link (/) is unambiguous as the
  // foreground tab opened by "Open all".
  h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
});

test.afterAll(async () => {
  await h?.context.close();
});

/** The window's active tab URL, queried from inside the panel. */
async function activeTabUrl(panel: ExtensionHarness["panel"]): Promise<string> {
  return panel.evaluate(
    () =>
      new Promise<string>((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs: any[]) =>
          resolve(tabs[0]?.url || ""),
        );
      }),
  );
}

test.describe("link chips + open all (#27)", () => {
  test.setTimeout(90_000); // CI-load headroom (QA_REPORT flake)

  test("prose answer with links renders the card; Open all opens + references tabs", async () => {
    await sendQuery(h.panel, "give me links to the fixture pages");
    await waitForTurnComplete(h.panel);

    // The card: header, one chip per URL, Open all button
    const card = h.panel.locator("#messages .msg-assistant .msg-links").last();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".msg-links-head")).toContainText("3 links");
    const chips = card.locator(".msg-link-chip");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveAttribute("title", `${E2E_BASE}/`);
    await expect(chips.nth(1)).toHaveAttribute("title", `${E2E_BASE}/form.html`);
    await expect(chips.nth(2)).toHaveAttribute("title", `${E2E_BASE}/long.html`);
    await expect(card.locator(".msg-links-open-all")).toHaveText("Open all (3)");

    // Open all → three real browser tabs created
    const pagesPromise = Promise.all([
      h.context.waitForEvent("page"),
      h.context.waitForEvent("page"),
      h.context.waitForEvent("page"),
    ]);
    await card.locator(".msg-links-open-all").click();
    await pagesPromise;

    // First link foreground, rest background: the active tab is the first
    // link (/), not the site tab (/form.html) we started on.
    await expect
      .poll(() => activeTabUrl(h.panel), { timeout: 10_000 })
      .toBe(`${E2E_BASE}/`);

    // All three URLs are now open (form.html twice: site tab + opened tab)
    const tabs: any[] = await h.panel.evaluate(
      () => new Promise((resolve) => chrome.tabs.query({ currentWindow: true }, (t: any[]) => resolve(t))),
    );
    const siteTabs = tabs.filter((t) => (t.url || "").startsWith(E2E_BASE));
    expect(siteTabs.length).toBe(4);
    expect(siteTabs.filter((t) => t.url === `${E2E_BASE}/form.html`).length).toBe(2);
    expect(siteTabs.filter((t) => t.url === `${E2E_BASE}/long.html`).length).toBe(1);

    // Opened tabs auto-become referenced chips in the tab strip
    await expect(h.panel.locator("#tab-contexts")).toBeVisible();
    await expect(h.panel.locator("#tab-strip .tab-chip")).toHaveCount(4, { timeout: 25_000 }); // CI runners under load poll slowly (QA_REPORT flake)
    await expect(h.panel.locator("#tab-strip .tab-chip-on")).toHaveCount(3);
    await expect(h.panel.locator("#tab-strip-count")).toHaveText("(3/4)");
  });

  test("single chip click opens that link in a foreground tab", async () => {
    const card = h.panel.locator("#messages .msg-assistant .msg-links").last();
    const chip = card.locator(`.msg-link-chip[title="${E2E_BASE}/long.html"]`);
    const pagePromise = h.context.waitForEvent("page");
    await chip.click();
    const page = await pagePromise;
    await page.waitForURL(`${E2E_BASE}/long.html`, { timeout: 10_000 });
    await expect.poll(() => activeTabUrl(h.panel), { timeout: 10_000 }).toBe(`${E2E_BASE}/long.html`);
  });
});
