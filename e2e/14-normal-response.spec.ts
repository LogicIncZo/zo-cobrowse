// E2E ("normal response" round): the action envelope arrives as MANY small
// text deltas (real Zo behavior — single-chunk mocks hid the leak). The panel
// must never render the raw JSON as chat prose: while streaming it shows the
// _Preparing actions…_ placeholder, and at STREAM_DONE the bubble shows the
// done response as normal markdown — while the actions still execute.

import { test, expect } from "@playwright/test";
import { openHarness, sendQuery, waitForTurnComplete } from "./helpers/extension";

test.describe("normal response for action turns", () => {
  test("multi-delta envelope: no JSON in chat, prose response rendered, actions execute", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      await sendQuery(h.panel, "fill the form chunked");

      // Actions executed on the real page.
      await expect(h.site.locator("#name")).toHaveValue("Chunked E2E", { timeout: 20_000 });
      await expect(h.site.locator("#email")).toHaveValue("chunked@example.test");
      await waitForTurnComplete(h.panel);

      // The raw JSON never leaked — not while streaming, not after DONE.
      const messages = h.panel.locator("#messages");
      await expect(messages).not.toContainText('"actions"');
      await expect(messages).not.toContainText('"type":"fill"');
      await expect(messages).not.toContainText('Preparing actions');

      // The done response renders as the bubble's normal prose.
      await expect(messages).toContainText("Filled the two visible fields — review them and submit when ready.");

      // No submit: the fixture form stays unsubmitted.
      await expect(h.site.locator("#form-result")).toBeEmpty();
    } finally {
      await h.context.close();
    }
  });
});
