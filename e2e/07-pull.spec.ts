// E2E: the context-on-demand pull loop (#24) in a real Chromium — Zo asks
// get_form → the background captures the COMPLETE form schema inside the
// stream → a second /zo/ask carries the `## Auto-fetched:` follow-up → Zo's
// final envelope acts on it. One user turn, two API calls, one live bubble.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, waitForTurnComplete, recordedAsks, clearRecordedRequests, E2E_BASE } from "./helpers/extension";

/** All recorded mock-server requests (incl. /mcp — recordedAsks filters those out). */
async function recordedRequests(): Promise<any[]> {
  const res = await fetch(`${E2E_BASE}/__requests`);
  return res.json();
}

test.describe("pull protocol (context-on-demand)", () => {
  test("get_form pull → in-stream schema fetch → follow-up turn → fill runs", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      await clearRecordedRequests(); // the recorder is shared across specs
      await sendQuery(h.panel, "fill the name field using the form schema");

      // Two /zo/ask calls for ONE user turn: the ask, then the auto-fetched
      // follow-up (loop runs inside the stream, before STREAM_DONE).
      await expect
        .poll(async () => (await recordedAsks()).length, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(2);

      const asks = await recordedAsks();
      const followUp = asks[asks.length - 1];
      expect(followUp.body.input).toContain("## Auto-fetched: form fields on");
      // The complete schema — including fields the tier-2 prompt slice already
      // carried, plus label/placeholders via the compact serializers.
      expect(followUp.body.input).toContain("[input#name type=text \"Full name\"]");
      expect(followUp.body.input).toContain("select#plan");

      // The pull rendered as a tool-trace card in the live bubble…
      await expect(h.panel.locator(".msg-stream-tool-card").filter({ hasText: "get_form" }))
        .toBeVisible({ timeout: 20_000 });

      // …and the follow-up's fill executed against the real page.
      await expect(h.site.locator("#name")).toHaveValue("Pulled E2E", { timeout: 20_000 });
      await waitForTurnComplete(h.panel);

      // get_form itself never reached the DOM executor (no card for it).
      await expect(h.panel.locator("#action-timeline .action-card")).toHaveCount(1, { timeout: 20_000 });
      await expect(h.panel.locator("#action-timeline .action-card").first()).toContainText("Fill");
    } finally {
      await h.context.close();
    }
  });

  test("read_file pull → workspace file fetched over MCP → continuation cites it (#52)", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      await clearRecordedRequests();
      await sendQuery(h.panel, "summarize the referenced workspace file");

      // One user turn → the ask, the MCP read_file, and the auto-fetched follow-up.
      await expect
        .poll(async () => (await recordedAsks()).length, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(2);

      const asks = await recordedAsks();
      const followUp = asks[asks.length - 1];
      expect(followUp.body.input).toContain("## Auto-fetched: file e2e-summary.md");
      expect(followUp.body.input).toContain("/home/workspace/notes/e2e-summary.md");
      expect(followUp.body.input).toContain("e2e-file-content-52");

      // The pull went out over the mock MCP server as a read_file tools/call.
      const mcps = (await recordedRequests()).filter((r) => r.url === "/mcp");
      const call = mcps.find((r) => r.body?.method === "tools/call" && r.body?.params?.name === "read_file");
      expect(call).toBeTruthy();
      expect(call.body.params.arguments.target_file).toBe("/home/workspace/notes/e2e-summary.md");

      // Trace card names the file; the final answer cites its content.
      await expect(h.panel.locator(".msg-stream-tool-card").filter({ hasText: "read_file" }))
        .toBeVisible({ timeout: 20_000 });
      await expect(h.panel.locator(".msg-body").last()).toContainText("e2e-file-content-52", { timeout: 20_000 });
      await waitForTurnComplete(h.panel);
    } finally {
      await h.context.close();
    }
  });
});
