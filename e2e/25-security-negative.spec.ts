// E2E (#243 security review round — adversarial negative test): a hostile
// page cannot trigger EXECUTE_ACTION / CAPTURE_CONTEXT / any extension turn
// from page context. The fixture runs every page-context vector it has
// (chrome.runtime access, window.postMessage shaped like internal messages);
// the assertions are the WIRE, not the page's self-report: no /zo/ask, no /mcp,
// no canary DOM mutation — and a normal panel turn still works afterwards.

import { test, expect } from "@playwright/test";
import { E2E_BASE, openHarness, lastAskBody, clearRecordedRequests, waitForTurnComplete, sendQuery } from "./helpers/extension";

async function recordedUrls(): Promise<string[]> {
  const res = await fetch(`${E2E_BASE}/__requests`);
  return (await res.json()).map((r: any) => r.url);
}

test.describe("security round — hostile page negative test (#243)", () => {
  test("hostile page reaches no extension surface; normal turns still work", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/hostile.html" });
    try {
      await clearRecordedRequests();

      // The page's own probes all failed: no chrome.runtime surface, and the
      // postMessage payloads produced no effect anywhere.
      const probes = h.site.locator("#probe-results");
      await expect(probes).toHaveAttribute("data-runtime", /unreachable/, { timeout: 10_000 });
      await expect(probes).toHaveAttribute("data-postmessage", /no effect/, { timeout: 10_000 });

      // Canary targets the attacks pointed at are untouched.
      await expect(h.site.locator("#canary-secret")).toHaveValue("");
      await expect(h.site.locator("form[data-canary]")).toHaveAttribute("data-canary", "untouched");

      // The wire is the real assertion: opening and attacking the page fired
      // NO extension network traffic — no /zo/ask, no /mcp.
      await h.site.waitForTimeout(400);
      expect((await recordedUrls()).filter((u) => u === "/zo/ask" || u === "/mcp")).toEqual([]);

      // Positive control: the extension still works normally afterwards —
      // a real panel turn completes end-to-end on the same tab.
      await sendQuery(h.panel, "What is this page about?");
      await waitForTurnComplete(h.panel);
      const ask = await lastAskBody();
      expect(ask.input).toContain("hostile"); // the hostile page was the captured tab
      expect((await recordedUrls()).filter((u) => u === "/zo/ask").length).toBeGreaterThan(0);
    } finally {
      await h.context.close();
    }
  });
});
