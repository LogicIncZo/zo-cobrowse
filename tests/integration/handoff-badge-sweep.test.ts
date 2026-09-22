// #372: the SW-restart orphan sweep must clear the ▶ badge. The sweep runs
// at background import; this file seeds a RUNNING run into storage.session
// BEFORE the import, then asserts the sweep paused it AND called
// setBadgeText('') — pre-fix, the sweep saved runs via handoffStore.save and
// never touched the badge, leaving a stale ▶ after a worker restart.
//
// NOTE: standalone-process by design (bun --test shares the module registry
// across files; the import-time sweep must see the pre-seeded state).

import { describe, it, expect } from "bun:test";
import { createFakeChrome } from "../helpers/chrome-mock.ts";
import { ZoFetchMock } from "../helpers/zo-fetch-mock.ts";

describe("handoff orphan sweep (#372)", () => {
  it("pauses a running run at import AND clears the live badge", async () => {
    const bus = createFakeChrome();
    const fm = new ZoFetchMock();
    const badgeTexts: string[] = [];
    (bus as any).action = {
      setBadgeBackgroundColor: () => {},
      setBadgeText: (o: any) => { badgeTexts.push(o.text); },
    };
    (bus as any).notifications = { create: () => {} };
    bus.storage.local._store.zoAccessToken = "mock-token";
    // A run the dying worker left 'running'.
    bus.storage.session._store["cobrowse_handoff_runs"] = {
      "run-372": {
        runId: "run-372", chatId: "chat-372", goal: "Digest", status: "running",
        boundaryMode: "readonly", budget: { maxTurns: 6, maxNavigations: 12, maxMinutes: 15 },
        usage: { turns: 2, navigations: 1, startedAt: Date.now() - 60_000 },
        pagesVisited: [], parkLog: [], tabId: 1,
        createdAt: Date.now() - 90_000, updatedAt: Date.now() - 30_000,
      },
    };
    await bus.tabs.create({ id: 1, url: "https://fixture.example/", active: true });
    fm.install();
    (globalThis as any).chrome = bus;
    await import("../../extension/background.js?file=badge-372");
    await new Promise((r) => setTimeout(r, 50));

    const run = bus.storage.session._store["cobrowse_handoff_runs"]["run-372"];
    expect(run.status).toBe("paused");
    expect(run.stopReason).toContain("extension restarted");
    // The stale ▶ (which persists across SW restarts in real Chrome) is cleared.
    expect(badgeTexts.at(-1)).toBe("");
  });
});
