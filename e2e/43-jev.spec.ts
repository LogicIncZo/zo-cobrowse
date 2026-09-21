// E2E (#342, 0.3.4 Lane J2): the Jev fast path — click-pick rescue on a
// cue-missed click, the low-confidence fallback, and the handoff done-gate
// (a chained turn short-circuited WITHOUT its Zo round-trip).
//
// With Jev disabled or unkeyed every flow is byte-identical to today; these
// specs seed a key + the mocked /v1/systemone endpoint, so both arms of the
// confidence routing run against the local mock.

import { test, expect } from "@playwright/test";
import {
  openHarness,
  sendQuery,
  recordedAsks,
  clearRecordedRequests,
  E2E_BASE,
  type ExtensionHarness,
} from "./helpers/extension";

async function seedJev(sw: any, enabled = true) {
  await sw.evaluate(
    (base: string) =>
      new Promise((r) =>
        chrome.storage.local.set({ jevApiKey: "apik_e2e", jevApiUrl: `${base}/v1/systemone` }, () => r(null)),
      ),
    E2E_BASE,
  );
  await sw.evaluate(
    (on: boolean) => new Promise((r) => chrome.storage.sync.set({ jevEnabled: on }, () => r(null))),
    enabled,
  );
}

test.describe("jev fast path (#342)", () => {
  test("click-pick rescues a cue-missed click at high confidence (and says so)", async () => {
    const h: ExtensionHarness = await openHarness({ freshProfile: true, sitePath: "/" });
    try {
      await seedJev(h.serviceWorker, true);
      await clearRecordedRequests();
      await sendQuery(h.panel, "JEV-PICK-RESCUE buy the thing please");
      // The rescued pick lands on the first candidate (the form link) —
      // the page navigated, which a cue-missed click could never do.
      await h.site.waitForURL(/form\.html/, { timeout: 20_000 });
      // Provenance: the timeline card names the fast path (the run body is
      // collapsed by default — assert on text, not visibility).
      await expect(h.panel.locator("#action-run")).toContainText("⚡ Jev pick (conf 0.97", { timeout: 10_000 });
    } finally {
      await h.context.close();
    }
  });

  test("click-pick falls back honestly at low confidence — the page is untouched", async () => {
    const h: ExtensionHarness = await openHarness({ freshProfile: true, sitePath: "/" });
    try {
      await seedJev(h.serviceWorker, true);
      await clearRecordedRequests();
      await sendQuery(h.panel, "JEV-PICK-LOWCONF buy the thing please");
      // The pick is below threshold → the cue-miss stands, no navigation.
      await h.panel.waitForTimeout(4000);
      expect(h.site.url()).not.toContain("form.html");
      // Provenance shows the fallback reason on the timeline card.
      await expect(h.panel.locator("#action-run")).toContainText("⚡ Jev fallback", { timeout: 10_000 });
    } finally {
      await h.context.close();
    }
  });

  test("done-gate short-circuits a chained handoff turn — no second Zo call", async () => {
    const h: ExtensionHarness = await openHarness({ freshProfile: true, sitePath: "/" });
    try {
      await seedJev(h.serviceWorker, true);
      await clearRecordedRequests();
      await sendQuery(h.panel, "!handoff compare the pricing across fixture pages");
      // The gate completes the run after turn 1 — the system note says why.
      await expect(h.panel.locator("#messages")).toContainText("Jev done-gate", { timeout: 30_000 });
      // Exactly ONE Zo turn was spent (the priming turn); the continuation
      // never happened.
      const asks = await recordedAsks();
      expect(asks.length).toBe(1);
    } finally {
      await h.context.close();
    }
  });

  test("done-gate at low confidence chains the Zo turns exactly as before", async () => {
    const h: ExtensionHarness = await openHarness({ freshProfile: true, sitePath: "/" });
    try {
      await seedJev(h.serviceWorker, true);
      await clearRecordedRequests();
      // The JEV-LOWCONF marker rides the goal text into the gate question —
      // the mock answers 0.2, below the 0.9 threshold.
      await sendQuery(h.panel, "!handoff JEV-LOWCONF compare the pricing across fixture pages");
      // The run still completes the classic way: the t3 digest lands.
      await expect(
        h.panel.locator("#messages .msg-assistant .msg-body", { hasText: "Pricing digest" }).first(),
      ).toBeVisible({ timeout: 40_000 });
      // All three Zo turns happened (t1 priming + two chained continuations).
      const asks = await recordedAsks();
      expect(asks.length).toBe(3);
    } finally {
      await h.context.close();
    }
  });

  test("Jev disabled: nothing changes — the same cue-missed click just fails", async () => {
    const h: ExtensionHarness = await openHarness({ freshProfile: true, sitePath: "/" });
    try {
      // Key present but the opt-in OFF: jevReady() is false.
      await seedJev(h.serviceWorker, false);
      await clearRecordedRequests();
      await sendQuery(h.panel, "JEV-PICK-RESCUE buy the thing please");
      await h.panel.waitForTimeout(4000);
      // No rescue: the page never navigated, no Jev provenance anywhere.
      expect(h.site.url()).not.toContain("form.html");
      const runText = await h.panel.locator("#action-run").textContent().catch(() => "");
      expect(runText || "").not.toContain("⚡ Jev");
    } finally {
      await h.context.close();
    }
  });

  test("plan pick (#343): Zo's pick-annotated click resolves in-page and executes", async () => {
    const h: ExtensionHarness = await openHarness({ freshProfile: true, sitePath: "/" });
    try {
      await seedJev(h.serviceWorker, true);
      await clearRecordedRequests();
      await sendQuery(h.panel, "jev-plan-rescue open the form page");
      // The resolved winner (first candidate) opens the form page — the
      // planner never named a selector; Jev picked it in-page.
      await h.site.waitForURL(/form\.html/, { timeout: 20_000 });
      await expect(h.panel.locator("#action-run")).toContainText("⚡ Jev pick (conf 0.97", { timeout: 10_000 });
    } finally {
      await h.context.close();
    }
  });

  test("plan pick at low confidence parks the step honestly (#343)", async () => {
    const h: ExtensionHarness = await openHarness({ freshProfile: true, sitePath: "/" });
    try {
      await seedJev(h.serviceWorker, true);
      await clearRecordedRequests();
      await sendQuery(h.panel, "jev-plan-lowconf open the form page");
      await h.panel.waitForTimeout(4000);
      // Below threshold → the step parks: the page is untouched and the
      // honest reason lands in the chat.
      expect(h.site.url()).not.toContain("form.html");
      await expect(h.panel.locator("#messages")).toContainText("Jev could not resolve the click", { timeout: 10_000 });
      await expect(h.panel.locator("#action-run")).toContainText("⚡ Jev fallback", { timeout: 10_000 });
    } finally {
      await h.context.close();
    }
  });

  test("prompt inspector shows the Jev section exactly when enabled (#343)", async () => {
    const h: ExtensionHarness = await openHarness({ freshProfile: true, sitePath: "/" });
    try {
      const poke = () => h.panel.evaluate(() => {
        const i = document.querySelector("#query-input");
        if (i) {
          i.value = "probe";
          i.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      // Off by default: no section in the preview.
      await poke();
      await h.panel.waitForTimeout(600);
      await expect(h.panel.locator("#prompt-preview")).not.toContainText("Jev-Assisted Steps");
      // Enabled + keyed: the section appears (preview parity with the wire).
      await seedJev(h.serviceWorker, true);
      await poke();
      await expect(h.panel.locator("#prompt-preview")).toContainText("Jev-Assisted Steps", { timeout: 10_000 });
    } finally {
      await h.context.close();
    }
  });
});
