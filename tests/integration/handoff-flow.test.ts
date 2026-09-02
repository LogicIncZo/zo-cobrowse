// Integration: the Lane E handoff loop — the REAL background.js driving
// delegate-mode runs over the fake-chrome bus. Covers: HANDOFF_START/STOP/
// STATUS, the priming→running flip on the first turn, the execute →
// continuation-turn chain, budget pause, readonly boundary parking, and the
// HANDOFF_UPDATE push. The test plays the panel's role: after each
// STREAM_DONE it posts EXECUTE_ACTIONS carrying handoffRunId, exactly as the
// sidepanel does for handoff turns.
//
// NOTE: unique ?file= cache-buster — bun shares the module registry per process.

import { describe, it, expect, beforeAll } from "bun:test";
import { createFakeChrome, waitUntil } from "../helpers/chrome-mock.ts";
import {
  ZoFetchMock,
  MOCK_ZO_TOKEN,
  sseResponse,
  zoSseText,
} from "../helpers/zo-fetch-mock.ts";

const bus = createFakeChrome();
const fm = new ZoFetchMock();
const pushes: any[] = [];
bus.runtime.onMessage.addListener((m: any) => {
  if (m?.type === "HANDOFF_UPDATE") pushes.push(m);
});

// Lane E item 12: badge + notification surface (absent from the base mock).
const badgeCalls: any[] = [];
(bus as any).action = {
  setBadgeBackgroundColor: (o: any) => { badgeCalls.push({ kind: "bg", ...o }); return Promise.resolve(); },
  setBadgeText: (o: any) => { badgeCalls.push({ kind: "text", text: o.text }); return Promise.resolve(); },
};
const notifications: any[] = [];
(bus as any).notifications = {
  create: (id: any, opts: any) => { notifications.push({ id, opts }); return id; },
};

const flush = () => new Promise((r) => setTimeout(r, 30));

let port: any;
const seen: any[] = [];

beforeAll(async () => {
  bus.storage.local._store.zoAccessToken = MOCK_ZO_TOKEN;
  await bus.tabs.create({ id: 1, url: "https://fixture.example/", active: true });
  fm.install();
  (globalThis as any).chrome = bus;
  await import("../../extension/background.js?file=handoff-flow");
  await flush(); // import-time registrations + the orphan-pause sweep
  port = bus.runtime.connect({ name: "cobrowse-stream" });
  port.onMessage.addListener((m: any) => seen.push(m));
});

async function startRun(over: Record<string, unknown> = {}) {
  const chatId = `chat-h-${Math.random().toString(36).slice(2, 8)}`;
  const res = await bus.runtime.sendMessage({
    type: "HANDOFF_START",
    chatId,
    tabId: 1,
    goal: over.goal ?? "Digest the tabs",
    boundaryMode: over.boundaryMode ?? "readonly",
    budget: over.budget,
  });
  expect(res.ok).toBe(true);
  expect(res.run.status).toBe("priming");
  return res.run;
}

const envelope = (obj: unknown) => sseResponse(zoSseText({ text: JSON.stringify(obj) }));

/** The panel's half of the contract: execute every handoff turn's actions as
 * its STREAM_DONE arrives, until the run leaves the loop (done/paused/aborted).
 * `sessionBase` scopes to THIS test's stream session (seen[] is file-global). */
async function panelLoop(run: any, opts: { boundaryMode?: string; sessionBase: string; maxTurns?: number }) {
  const max = opts.maxTurns ?? 5;
  let executed = 0;
  for (;;) {
    const dones = seen.filter((m) => m.type === "STREAM_DONE" && m.actions?.length && String(m.sessionId).startsWith(opts.sessionBase));
    if (executed < dones.length) {
      const m = dones[executed++];
      await bus.runtime.sendMessage({
        type: "EXECUTE_ACTIONS", tabId: 1, handoffRunId: run.runId,
        boundaryMode: opts.boundaryMode, actions: m.actions,
      });
      continue;
    }
    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    if (st.run && ["done", "aborted", "paused"].includes(st.run.status)) return st.run;
    if (executed >= max) return st.run;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("handoff run loop (Lane E)", () => {
  it("first handoff ASK_ZO flips priming → running and pushes the update", async () => {
    const run = await startRun();
    fm.handle(() => sseResponse(zoSseText({ text: "hello" })));
    port.postMessage({ sessionId: 940, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    await waitUntil(() => pushes.some((p) => p.run?.runId === run.runId && p.run.status === "running"), 8000);
    const stop = await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: run.runId });
    expect(stop.ok).toBe(true);
  });

  it("chains turn 2 after a turn without done(), and completes on done()", async () => {
    const run = await startRun();
    let turn = 0;
    fm.handle(() => {
      turn++;
      if (turn === 1) {
        return envelope({ actions: [{ type: "navigate", url: "https://a.example" }, { type: "navigate", url: "https://b.example" }] });
      }
      return envelope({ actions: [{ type: "done", response: "Final digest" }] });
    });

    const asksBefore = fm.to("/zo/ask").length;
    port.postMessage({ sessionId: 900, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId, conversationId: "thread-h" });

    const finalRun = await panelLoop(run, { sessionBase: "900" });
    expect(finalRun.status).toBe("done");
    expect(turn).toBe(2); // the chained second turn hit the wire

    const asks = fm.to("/zo/ask");
    expect(asks.length).toBe(asksBefore + 2);
    const cont = String(asks[asks.length - 1].body.input);
    expect(cont).toContain("[handoff-run continuation]");
    expect(cont).toContain("Pages visited"); // progress report rode along

    expect(finalRun.stopReason).toBe("Final digest");
    expect(finalRun.usage.turns).toBe(2);
  });

  it("readonly boundary parks clicks, executes siblings, keeps chaining", async () => {
    const run = await startRun();
    let turn = 0;
    fm.handle(() => {
      turn++;
      if (turn === 1) {
        return envelope({ actions: [{ type: "click", selector: "#filter-btn" }, { type: "navigate", url: "https://c.example" }] });
      }
      return envelope({ actions: [{ type: "done", response: "ok" }] });
    });

    port.postMessage({ sessionId: 910, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    const finalRun = await panelLoop(run, { boundaryMode: "readonly", sessionBase: "910" });

    expect(finalRun.status).toBe("done");
    expect(turn).toBe(2); // parking did not stop the loop
    expect(finalRun.parkLog).toHaveLength(1);
    expect(finalRun.parkLog[0].reason).toContain("READ-ONLY");
    expect(finalRun.parkLog[0].action.type).toBe("click");
  });

  it("pauses when the turn budget is exhausted — no runaway chaining", async () => {
    const run = await startRun({ budget: { maxTurns: 1 } });
    fm.handle(() => envelope({ actions: [{ type: "navigate", url: "https://x.example" }] }));
    const asksBefore = fm.to("/zo/ask").length;
    port.postMessage({ sessionId: 920, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    const finalRun = await panelLoop(run, { sessionBase: "920" });
    expect(finalRun.status).toBe("paused");
    expect(finalRun.stopReason).toContain("turn budget");
    expect(fm.to("/zo/ask").length).toBe(asksBefore + 1); // no chained fetch after the pause
  });

  it("STOP aborts the run; a late turn completion does not chain", async () => {
    const run = await startRun();
    fm.handle(() => envelope({ actions: [{ type: "navigate", url: "https://y.example" }] }));
    const asksBefore = fm.to("/zo/ask").length;
    port.postMessage({ sessionId: 930, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    await waitUntil(() => seen.some((m) => m.type === "STREAM_DONE"), 8000);
    const stop = await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: run.runId });
    expect(stop.ok).toBe(true);
    expect(stop.run.status).toBe("aborted");
    // A stale EXECUTE_ACTIONS arriving after the stop must NOT resurrect the loop.
    await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS", tabId: 1, handoffRunId: run.runId,
      actions: [{ type: "navigate", url: "https://y.example" }],
    });
    await flush();
    expect(fm.to("/zo/ask").length).toBe(asksBefore + 1);
    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    expect(st.run.status).toBe("aborted");
  });

  it("badge marks live runs; finishing a run notifies (Lane E item 12)", async () => {
    const run = await startRun();
    fm.handle(() => envelope({ actions: [{ type: "done", response: "All finished" }] }));
    port.postMessage({ sessionId: 950, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    const finalRun = await panelLoop(run, { sessionBase: "950" });

    // While the run was live the badge lit up…
    expect(badgeCalls.some((b) => b.kind === "text" && b.text === "▶")).toBe(true);
    // …and finishing clears it and fires the one-shot notification.
    expect(finalRun.status).toBe("done");
    expect(badgeCalls.filter((b) => b.kind === "text").at(-1)?.text).toBe("");
    const note = notifications.find((n) => n.id === `handoff-${run.runId}`);
    expect(note).toBeTruthy();
    expect(note.opts.title).toBe("Zo handoff finished");
    expect(note.opts.message).toContain("Digest the tabs");
    // aborted/paused runs never notified (panel-only).
    expect(notifications.every((n) => !n.id.startsWith("handoff-run") || n.opts.title.includes("finished"))).toBe(true);
  });
});
