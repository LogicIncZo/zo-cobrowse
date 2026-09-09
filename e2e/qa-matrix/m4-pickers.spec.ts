// QA matrix m4 — composer picker send-once semantics beyond the scripted e2e
// (08-pickers covers popup open/pick/add flows):
//   • a picked skill chip rides the NEXT ask as a `## Skills to Run` section
//     and clears after exactly one send (send-once — no residue)
//   • a picked workspace-file chip rides as `## Referenced Files`, also once

import { test, expect } from "@playwright/test";
import {
  openHarness,
  sendQuery,
  waitForTurnComplete,
  lastAskBody,
  recordedAsks,
  clearRecordedRequests,
  type ExtensionHarness,
} from "../helpers/extension";

let h: ExtensionHarness;
test.beforeAll(async () => {
  h = await openHarness({ freshProfile: true, sitePath: "/" });
});
test.afterAll(async () => {
  await h?.context.close();
});
// The mock server accumulates __requests across runs (reuseExistingServer) —
// scope every assertion to this run's asks.
test.beforeEach(async () => {
  await clearRecordedRequests();
});

test.fixme("skill chip is send-once: rides one ask, then clears", async () => {
  // finding: qa-pickers-skills-section-residue — the ## Skills to Run section
  // re-appears on the follow-up ask; unfixme when that finding is fixed.
  await h.panel.locator("#query-input").click();
  await h.panel.locator("#query-input").fill("/");
  await expect(h.panel.locator("#skill-autocomplete")).toBeVisible();
  await expect(h.panel.locator("#skill-autocomplete button.picker-item").first()).toBeVisible();
  await h.panel.locator("#skill-autocomplete button.picker-item").first().click();
  await expect(h.panel.locator("#picker-chips .picker-chip").first()).toBeVisible();

  await sendQuery(h.panel, "run the picked skill once");
  await waitForTurnComplete(h.panel);
  expect(JSON.stringify(await lastAskBody())).toContain("## Skills to Run");
  await expect(h.panel.locator("#picker-chips .picker-chip")).toHaveCount(0);

  // Turn 1 (cobrowse envelope) may park actions; skip them so the composer
  // unblocks for the follow-up send.
  const bar = h.panel.locator("#actions-bar");
  if (await bar.isVisible()) await h.panel.locator("#skip-btn").click();
  await expect(bar).toBeHidden();

  // Follow-up ask must NOT carry the section again.
  await sendQuery(h.panel, "and now without it");
  await waitForTurnComplete(h.panel);
  expect(JSON.stringify(await lastAskBody())).not.toContain("## Skills to Run");
});

test("file chip is send-once: rides one ask as ## Referenced Files", async () => {
  await h.panel.locator("#query-input").click();
  await h.panel.locator("#query-input").fill("%");
  await expect(h.panel.locator("#file-autocomplete")).toBeVisible();
  // Adding uses the row's ＋ button (clicking the row itself navigates folders).
  const firstRow = h.panel.locator("#file-autocomplete button.picker-item").first();
  await expect(firstRow).toBeVisible();
  await firstRow.locator(".picker-item-add").click();
  await expect(h.panel.locator("#picker-chips .picker-chip").first()).toBeVisible();

  await sendQuery(h.panel, "read the referenced file once");
  await waitForTurnComplete(h.panel);
  expect(JSON.stringify(await lastAskBody())).toContain("## Referenced Files");
  await expect(h.panel.locator("#picker-chips .picker-chip")).toHaveCount(0);
});
