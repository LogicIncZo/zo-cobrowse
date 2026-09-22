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
import { createFakeChrome, createTabTarget, waitUntil } from "../helpers/chrome-mock.ts";
import {
  ZoFetchMock,
  MOCK_ZO_TOKEN,
  jsonResponse,
  sseResponse,
  textResponse,
  zoSseText,
} from "../helpers/zo-fetch-mock.ts";
import { HandoffRun } from "../schemas/handoff.js";

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
  // #158: a stored handoff budget (sync) must be what HANDOFF_START uses when
  // the request carries no explicit budget — seeded before the import so the
  // background's init picks it up.
  bus.storage.sync._store.cobrowse_handoff_budget = { maxTurns: 8, maxNavigations: 9, maxMinutes: 11 };
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
    if (st.run && ["done", "aborted", "paused", "blocked"].includes(st.run.status)) return st.run;
    if (executed >= max) return st.run;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("handoff run loop (Lane E)", () => {
  // #158: the budget defaults are config-resident (storage.sync
  // `cobrowse_handoff_budget`, defaulting from lib/handoff.js DEFAULT_BUDGET)
  // and an explicit request budget still wins.
  it("HANDOFF_START takes an unset budget from the config-resident default", async () => {
    const run = await startRun();
    expect(run.budget).toEqual({ maxTurns: 8, maxNavigations: 9, maxMinutes: 11 });
    const stop = await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: run.runId });
    expect(stop.ok).toBe(true);
  });

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

  it("blocks when the turn budget is exhausted — no runaway chaining, user notified", async () => {
    const run = await startRun({ budget: { maxTurns: 1 } });
    fm.handle(() => envelope({ actions: [{ type: "navigate", url: "https://x.example" }] }));
    const asksBefore = fm.to("/zo/ask").length;
    port.postMessage({ sessionId: 920, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    const finalRun = await panelLoop(run, { sessionBase: "920" });
    // #157: the run needs the user's call, so it is BLOCKED (not paused) —
    // which is what fires the one-shot "needs you" notification.
    expect(finalRun.status).toBe("blocked");
    expect(finalRun.stopReason).toContain("turn budget");
    expect(fm.to("/zo/ask").length).toBe(asksBefore + 1); // no chained fetch after the block
    const note = notifications.find((n) => n.id === `handoff-${run.runId}`);
    expect(note?.opts.title).toBe("Zo handoff needs you");
    expect(note?.opts.message).toContain("turn budget");
  });

  it("blocks and notifies when a chained stream fails mid-run (#157)", async () => {
    const run = await startRun();
    let asks = 0;
    fm.handle((url) => {
      if (!url.includes("/zo/ask")) return envelope({ actions: [] });
      asks++;
      // Turn 1 drives the loop; the chained turn dies on a non-retriable 4xx.
      if (asks === 1) return envelope({ actions: [{ type: "navigate", url: "https://d.example" }] });
      return textResponse("bad request", 400);
    });
    port.postMessage({ sessionId: 960, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    const finalRun = await panelLoop(run, { sessionBase: "960" });
    expect(finalRun.status).toBe("blocked");
    expect(finalRun.stopReason).toBe("stream error mid-run");
    expect(notifications.find((n) => n.id === `handoff-${run.runId}`)?.opts.title).toBe("Zo handoff needs you");
  });

  it("continuation turns drop turn 1's send-once attachments (#159)", async () => {
    const run = await startRun();
    let turn = 0;
    fm.handle(() => {
      turn++;
      if (turn === 1) return envelope({ actions: [{ type: "navigate", url: "https://so.example" }] });
      return envelope({ actions: [{ type: "done", response: "done" }] });
    });
    const asksBefore = fm.to("/zo/ask").length;
    port.postMessage({
      sessionId: 970, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse",
      userQuery: run.goal, handoffRunId: run.runId,
      // send-once attachments — must ride turn 1 only
      skills: [{ name: "thread-summarizer", description: "summarize a thread" }],
      workspaceFiles: [{ path: "/home/workspace/notes.md" }],
      tabContexts: [{ ref: "T1", url: "https://other.example", title: "Other tab", excerpt: "hello" }],
    });
    const finalRun = await panelLoop(run, { sessionBase: "970" });
    expect(finalRun.status).toBe("done");
    const asks = fm.to("/zo/ask").slice(asksBefore);
    expect(asks.length).toBe(2);
    const first = String(asks[0].body.input);
    const second = String(asks[1].body.input);
    // Turn 1 carried them…
    expect(first).toContain("## Skills to Run");
    expect(first).toContain("thread-summarizer");
    expect(first).toContain("## Referenced Files");
    expect(first).toContain("notes.md");
    expect(first).toContain("## Referenced Tabs");
    // …the continuation must not (progress report + continue prompt only).
    expect(second).toContain("[handoff-run continuation]");
    expect(second).not.toContain("## Skills to Run");
    expect(second).not.toContain("thread-summarizer");
    expect(second).not.toContain("## Referenced Files");
    expect(second).not.toContain("notes.md");
    expect(second).not.toContain("## Referenced Tabs");
  });

  it("STOP on an already-finished run is a no-op — no second notification (#160)", async () => {
    const run = await startRun();
    fm.handle(() => envelope({ actions: [{ type: "done", response: "All finished" }] }));
    port.postMessage({ sessionId: 940, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    const finalRun = await panelLoop(run, { sessionBase: "940" });
    expect(finalRun.status).toBe("done");
    const notes = () => notifications.filter((n) => n.id === `handoff-${run.runId}`);
    expect(notes().length).toBe(1);

    // The stop button is already gone on done, but a late click (or a stray
    // message) must not re-save the run: doing so re-ran the notify and
    // re-pushed the terminal update, which the panel rendered a second time.
    const stop = await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: run.runId });
    expect(stop.ok).toBe(false);
    expect(stop.error).toContain("already done");
    expect(stop.run.status).toBe("done");
    await flush();
    expect(notes().length).toBe(1);
    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    expect(st.run.status).toBe("done");
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
    // Aborting is panel-only — never a notification (#157: 'blocked' is the
    // needs-you notify path; done/blocked are the only notifying statuses).
    expect(notifications.some((n) => n.id === `handoff-${run.runId}`)).toBe(false);
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
  });

  it("a second HANDOFF_START in the same chat refuses while a run is live (#370)", async () => {
    const run = await startRun({ goal: "First goal" });
    const second = await bus.runtime.sendMessage({
      type: "HANDOFF_START", chatId: run.chatId, tabId: 1, goal: "Second goal", boundaryMode: "readonly",
    });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already has a live handoff run");
    // Stopping the live run frees the chat for a fresh start.
    await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: run.runId });
    const third = await bus.runtime.sendMessage({
      type: "HANDOFF_START", chatId: run.chatId, tabId: 1, goal: "Third goal", boundaryMode: "readonly",
    });
    expect(third.ok).toBe(true);
    await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: third.run.runId });
  });

  it("#371: a readonly run's turns carry no Jev block even with the fast path configured", async () => {
    // Configure Jev the way the options card does (key + enable) — through
    // the storage API so the background's onChanged refresh picks it up.
    await bus.storage.local.set({ jevApiKey: "test-key" });
    await bus.storage.sync.set({ jevEnabled: true });
    await flush();
    const run = await startRun({ goal: "Digest the release notes" });
    fm.handle(() => sseResponse(zoSseText({ text: "ok" })));
    const asksBefore = fm.to("/zo/ask").length;
    port.postMessage({ sessionId: 970, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    await waitUntil(() => fm.to("/zo/ask").length > asksBefore, 8000);
    const turn = fm.to("/zo/ask").at(-1);
    expect(String(turn.body.input)).toContain("Digest the release notes");
    expect(String(turn.body.input)).not.toContain("Jev-Assisted Steps");
    await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: run.runId });
    // Control: a plain chat ask with the same config still gets the block —
    // the suppression is run-scoped (readonly boundary), not global.
    fm.handle(() => sseResponse(zoSseText({ text: "ok" })));
    const plainBefore = fm.to("/zo/ask").length;
    port.postMessage({ sessionId: 971, type: "ASK_ZO", chatId: "chat-jev-control", modeId: "cobrowse", userQuery: "Click the first product" });
    await waitUntil(() => fm.to("/zo/ask").length > plainBefore, 8000);
    expect(String(fm.to("/zo/ask").at(-1).body.input)).toContain("Jev-Assisted Steps");
    await bus.storage.local.remove("jevApiKey");
    await bus.storage.sync.remove("jevEnabled");
    await flush();
  });

  it("blocks the run when a turn ends without actions — no strand, no chain (#368)", async () => {
    const run = await startRun();
    fm.handle(() => sseResponse(zoSseText({ text: "The page requires a login — which credentials should I use?" })));
    const asksBefore = fm.to("/zo/ask").length;
    port.postMessage({ sessionId: 960, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    await waitUntil(() => pushes.some((p) => p.run?.runId === run.runId && p.run.status === "blocked"), 8000);
    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    expect(st.run.status).toBe("blocked");
    expect(st.run.stopReason).toContain("turn ended without actions");
    expect(st.run.stopReason).toContain("login"); // the prose is the reason
    // No continuation was chained — exactly one real Zo turn was spent.
    expect(fm.to("/zo/ask").length).toBe(asksBefore + 1);
    // The blocked run fired the needs-you notification…
    const note = notifications.find((n) => n.id === `handoff-${run.runId}`);
    expect(note).toBeTruthy();
    expect(note.opts.title).toBe("Zo handoff needs you");
    // …and is resumable: the panel re-issues the returned continuation turn.
    const res = await bus.runtime.sendMessage({ type: "HANDOFF_RESUME", runId: run.runId });
    expect(res.ok).toBe(true);
    expect(res.continuationQuery).toContain("[handoff-run continuation]");
    await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: run.runId });
  });
});

describe("compose sink (C1 #289)", () => {
  // Tab 1's fake content script — fills/clicks execute through it (the
  // recipe-flow pattern); the default answers ok for any action.
  const sinkTarget = createTabTarget();
  sinkTarget.onMessage.addListener((msg: any, _s: any, sendResponse: Function) => {
    if (msg.type === "EXECUTE_ACTION") {
      sendResponse({ ok: true, type: msg.action?.step?.type ?? msg.action?.type });
      return true;
    }
  });
  bus.tabs.bindTab(1, sinkTarget.onMessage);

  it("records executed + parked actions on the run — with the fill value stripped at the sink", async () => {
    const run = await startRun({ boundaryMode: "no-submit", goal: "Order the supplies" });
    let turn = 0;
    fm.handle(() => {
      turn++;
      if (turn === 1) {
        return envelope({
          actions: [
            { type: "navigate", url: "https://shop.example/cart" },
            // Zo INVENTED a value for the quantity field — the sink must strip it.
            { type: "fill", selector: "#qty", value: "ZO-INVENTED-42" },
            { type: "click", selector: "[type=submit]", text: "Place order" }, // submitish → park
          ],
        });
      }
      return envelope({ actions: [{ type: "done", response: "parked at checkout" }] });
    });

    port.postMessage({ sessionId: 2960, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId, boundaryMode: "no-submit" });
    const finalRun = await panelLoop(run, { boundaryMode: "no-submit", sessionBase: "2960" });
    expect(finalRun.status).toBe("done");

    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    const obs = st.run.obs;
    expect(Array.isArray(obs)).toBe(true);
    const nav = obs.find((o: any) => o.op === "navigate");
    expect(nav?.source).toBe("zo");
    expect(nav?.url).toBe("https://shop.example/cart");
    const fill = obs.find((o: any) => o.op === "fill");
    expect(fill?.source).toBe("zo");
    expect(fill?.cues).toContainEqual({ strategy: "selector", value: "#qty" });
    // The invented value never landed in the sink.
    expect(JSON.stringify(obs)).not.toContain("ZO-INVENTED-42");
    expect(fill && "value" in fill).toBe(false);
    const park = obs.find((o: any) => o.source === "boundary");
    expect(park?.op).toBe("click");
    expect(park?.reason).toContain("terminal action");
    expect(() => HandoffRun.parse(st.run)).not.toThrow();
  });

  it("a readonly run records navigate/extract but no click noise beyond parks", async () => {
    const run = await startRun({ boundaryMode: "readonly" });
    fm.handle(() => envelope({
      actions: [
        { type: "navigate", url: "https://news.example/a" },
        { type: "click", selector: ".next" }, // parked (readonly)
        { type: "done", response: "read it" },
      ],
    }));
    port.postMessage({ sessionId: 2961, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    const finalRun = await panelLoop(run, { boundaryMode: "readonly", sessionBase: "2961" });
    expect(finalRun.status).toBe("done");
    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    const obs = st.run.obs;
    expect(obs.filter((o: any) => o.source === "zo").map((o: any) => o.op)).toEqual(["navigate"]);
    expect(obs.filter((o: any) => o.source === "boundary").map((o: any) => o.op)).toEqual(["click"]);
  });
});

describe("compose sink — alignment (review F2)", () => {
  it("context/pull actions mixed into the batch do not shift obs records off their actions", async () => {
    // Seeded 'running' run — handoffAfterExecute processes the batch without
    // a live stream (no turn context → the continuation chain no-ops).
    const runId = `run-f2-${Math.random().toString(36).slice(2, 8)}`;
    const runs = (bus.storage.session._store.cobrowse_handoff_runs ??= {});
    runs[runId] = {
      runId, chatId: "chat-f2", goal: "Fill the demo form", boundaryMode: "no-submit",
      budget: { maxTurns: 12, maxNavigations: 25, maxMinutes: 20 },
      usage: { turns: 0, navigations: 0, startedAt: Date.now() }, status: "running",
      pagesVisited: [], parkLog: [], obs: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS", tabId: 1, handoffRunId: runId, boundaryMode: "no-submit",
      actions: [
        // Degenerate mixed reply: a context action rides BEFORE the DOM fill —
        // the executor never sees it, so results align with the FILTERED list.
        { type: "read_page" },
        { type: "fill", selector: "#qty", value: "ZO-INVENTED-77" },
      ],
    });
    await flush();
    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId });
    const fill = (st.run.obs || []).find((o: any) => o.op === "fill");
    // The fill record carries the FILL's cues — not shifted onto a neighbor.
    expect(fill?.cues).toContainEqual({ strategy: "selector", value: "#qty" });
    expect(JSON.stringify(st.run.obs)).not.toContain("ZO-INVENTED-77");
  });
});

describe("compose session (C2 #290)", () => {
  async function composeStart(goal: string) {
    const res = await bus.runtime.sendMessage({
      type: "RECIPE_COMPOSE_START",
      chatId: `chat-c2-${Math.random().toString(36).slice(2, 8)}`,
      tabId: 1, goal,
    });
    expect(res.ok).toBe(true);
    expect(res.run.boundaryMode).toBe("compose");
    expect(res.run.compose.name).toBeTruthy();
    expect(() => HandoffRun.parse(res.run)).not.toThrow();
    return res.run;
  }

  /** Wait for the turn's STREAM_DONE and execute it as the panel would. */
  async function driveOnce(run: any, sessionId: string | number) {
    await waitUntil(() => seen.some((m) => m.type === "STREAM_DONE" && m.actions?.length && String(m.sessionId) === String(sessionId)), 8000);
    const m = seen.filter((x: any) => x.type === "STREAM_DONE" && String(x.sessionId) === String(sessionId)).at(-1);
    await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS", tabId: 1, handoffRunId: run.runId,
      boundaryMode: "compose", url: "https://shop.example/form", actions: m.actions,
    });
    await flush();
  }

  it("value park: the boundary refuses Zo's fill (never executed), the human fills, resume continues", async () => {
    const run = await composeStart("Fill the demo form");
    let turn = 0;
    fm.handle(() => {
      turn++;
      if (turn === 1) {
        return envelope({ actions: [
          { type: "navigate", url: "https://shop.example/form" },
          { type: "fill", selector: "#qty", value: "ZO-INVENTED-99" },
        ]});
      }
      return envelope({ actions: [{ type: "done", response: "Flow complete." }] });
    });

    port.postMessage({ sessionId: 2970, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    await driveOnce(run, 2970);
    // The loop parked instead of chaining — turn 2 never hit the wire.
    await waitUntil(() => pushes.some((p) => p.run?.runId === run.runId && p.run.status === "blocked"), 8000);
    expect(turn).toBe(1);

    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    expect(() => HandoffRun.parse(st.run)).not.toThrow();
    const parkRec = st.run.parks.find((p: any) => !p.resolved);
    expect(parkRec.kind).toBe("value");
    // The Zo fill NEVER executed: no 'zo' fill record exists, the invented
    // value never landed — the boundary record is the park's trace.
    expect(st.run.obs.filter((o: any) => o.source === "zo" && o.op === "fill")).toHaveLength(0);
    expect(JSON.stringify(st.run.obs)).not.toContain("ZO-INVENTED-99");

    // The human fills the page — RECIPE_OBS streams the human producer.
    await bus.runtime.sendMessage({
      type: "RECIPE_OBS",
      obs: { op: "fill", url: "https://shop.example/form", cues: [{ strategy: "selector", value: "#qty" }], value: "3" },
    });
    const st2 = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    const humanFill = st2.run.obs.find((o: any) => o.source === "human" && o.op === "fill");
    expect(humanFill?.value).toBe("3");

    // Resume: the park resolves and the continuation carries the resolution.
    const res = await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_RESUME", runId: run.runId, parkId: parkRec.parkId });
    expect(res.ok).toBe(true);
    expect(res.continuationQuery).toContain("[compose park resolved]");

    // The panel re-issues the continuation → turn 2 runs → done.
    port.postMessage({ sessionId: "2970-h2", type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: res.continuationQuery, handoffRunId: run.runId });
    await driveOnce(run, "2970-h2");
    await waitUntil(() => pushes.some((p) => p.run?.runId === run.runId && p.run.status === "done"), 8000);

    // Save → the HUMAN value is the param default; no invented value anywhere.
    const save = await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_SAVE", runId: run.runId, name: "C2 Composed" });
    expect(save.ok).toBe(true);
    const entry = bus.storage.local._store.cobrowse_recipes["C2 Composed"];
    expect(entry.composedBy).toBe("zo");
    const withDefault = entry.params.find((p: any) => p.default === "3");
    expect(withDefault).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain("ZO-INVENTED-99");
    // The resolved value park left NO checkpoint — the human fill IS the step.
    expect(entry.steps.filter((s: any) => s.type === "human")).toHaveLength(0);
  });

  it("choice park: a PARK: done() is a question to the human, not completion", async () => {
    const run = await composeStart("Pick a plan");
    fm.handle(() => envelope({ actions: [{ type: "done", response: "PARK: Which hosting region? | Mumbai | Frankfurt" }] }));
    port.postMessage({ sessionId: 2971, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    await driveOnce(run, 2971);

    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    expect(st.run.status).toBe("blocked"); // NOT done — the park intercepted it
    const parkRec = st.run.parks.find((p: any) => !p.resolved);
    expect(parkRec.kind).toBe("choice");
    expect(parkRec.options).toEqual(["Mumbai", "Frankfurt"]);

    const res = await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_RESUME", runId: run.runId, parkId: parkRec.parkId, text: "Mumbai" });
    expect(res.ok).toBe(true);
    expect(res.continuationQuery).toContain("Mumbai");
    await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_STOP", runId: run.runId });
  });

  it("single-session rule: a second compose (or recording) start refuses", async () => {
    const run = await composeStart("One at a time");
    const second = await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_START", chatId: "chat-other", tabId: 1, goal: "Another goal" });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already live");
    // The recorder path refuses too.
    bus.storage.session._store.cobrowse_recipe_compose = { armed: true, runId: run.runId, startedAt: Date.now() };
    const rec = await bus.runtime.sendMessage({ type: "RECIPE_RECORD_START", chatId: "chat-x", name: "sneaky" });
    expect(rec.ok).toBe(false);
    const stop = await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_STOP", runId: run.runId });
    expect(stop.ok).toBe(true);
    expect(stop.run.status).toBe("aborted");
    const peek = await bus.runtime.sendMessage({ type: "RECIPE_RECORD_PEEK" });
    expect(peek.armed).toBe(false);
  });

  it("HANDOFF_STOP (✕ / tab-close path) disarms the compose session too", async () => {
    const run = await composeStart("Disarm me");
    await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: run.runId });
    const peek = await bus.runtime.sendMessage({ type: "RECIPE_RECORD_PEEK" });
    expect(peek.armed).toBe(false);
  });
});

describe("compose session — review round 1 fixes", () => {
  async function composeStartR1(goal: string) {
    const res = await bus.runtime.sendMessage({
      type: "RECIPE_COMPOSE_START",
      chatId: `chat-r1-${Math.random().toString(36).slice(2, 8)}`,
      tabId: 1, goal,
    });
    expect(res.ok).toBe(true);
    return res.run;
  }

  async function driveOnceR1(run: any, sessionId: string | number) {
    await waitUntil(() => seen.some((m) => m.type === "STREAM_DONE" && m.actions?.length && String(m.sessionId) === String(sessionId)), 8000);
    const m = seen.filter((x: any) => x.type === "STREAM_DONE" && String(x.sessionId) === String(sessionId)).at(-1);
    await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS", tabId: 1, handoffRunId: run.runId,
      boundaryMode: "compose", url: "https://shop.example/form", actions: m.actions,
    });
    await flush();
  }

  it("F1: a fill_form action is refused by the compose boundary and never executes", async () => {
    const run = await composeStartR1("Batch-fill is still a fill");
    const res = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS", tabId: 1, handoffRunId: run.runId,
      boundaryMode: "compose", url: "https://shop.example/form",
      actions: [{ type: "fill_form", values: [{ target: "#qty", value: "ZO-INVENTED-BATCH" }] }],
    });
    await flush();
    const r = res.results[0];
    expect(r.ok).toBe(false);
    expect(r.handoffParked).toBe(true);
    expect(r.error).toContain("never fills");
    // Nothing executed: no zo record, no value anywhere.
    const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: run.runId });
    expect(st.run.obs.filter((o: any) => o.source === "zo")).toHaveLength(0);
    expect(JSON.stringify(st.run)).not.toContain("ZO-INVENTED-BATCH");
    await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_STOP", runId: run.runId });
  });

  it("F2: a cleanup reply authoring a literal fill value is rejected for the deterministic draft", async () => {
    const run = await composeStartR1("Literal guard");
    // Stream-aware mock: the compose SAVE's cleanup one-shot is NON-streaming.
    fm.handle((url: string, _init: any, req: any) => {
      const body: any = req?.body || {};
      if (url.includes("/zo/ask") && !body.stream) {
        return jsonResponse({ output: JSON.stringify({
          params: [],
          steps: [
            { type: "navigate", url: "https://shop.example/form", expectUrl: "/form" },
            { type: "fill", cues: [{ strategy: "question", value: "Quantity" }], value: "MODEL-AUTHORED-LITERAL" },
            { type: "done", message: "ok" },
          ],
        }) });
      }
      return envelope({ actions: [{ type: "navigate", url: "https://shop.example/form" }, { type: "done", response: "ok" }] });
    });
    port.postMessage({ sessionId: 2975, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    await driveOnceR1(run, 2975);
    await waitUntil(() => pushes.some((p) => p.run?.runId === run.runId && p.run.status === "done"), 8000);

    const save = await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_SAVE", runId: run.runId, name: "F2 Composed" });
    expect(save.ok).toBe(true);
    expect(save.llmCleaned).toBe(false);
    expect(save.note).toContain("literal fill value");
    const entry = bus.storage.local._store.cobrowse_recipes["F2 Composed"];
    expect(JSON.stringify(entry)).not.toContain("MODEL-AUTHORED-LITERAL");
  });

  it("F5: a paused compose run resumes WITHOUT a parkId (park-less resume)", async () => {
    const run = await composeStartR1("Pause me by the sweep");
    // Simulate the SW-restart orphan sweep's pause.
    const runs = bus.storage.session._store.cobrowse_handoff_runs;
    runs[run.runId].status = "paused";
    runs[run.runId].stopReason = "extension restarted — resume to continue";
    const res = await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_RESUME", runId: run.runId });
    expect(res.ok).toBe(true);
    expect(res.run.status).toBe("running");
    expect(res.continuationQuery).toContain("[handoff-run continuation]");
    await bus.runtime.sendMessage({ type: "RECIPE_COMPOSE_STOP", runId: run.runId });
  });

  it("F4: a compose run that completes naturally disarms the session", async () => {
    const run = await composeStartR1("Finish on your own");
    fm.handle(() => envelope({ actions: [{ type: "done", response: "All walked." }] }));
    port.postMessage({ sessionId: 2976, type: "ASK_ZO", chatId: run.chatId, modeId: "cobrowse", userQuery: run.goal, handoffRunId: run.runId });
    await driveOnceR1(run, 2976);
    await waitUntil(() => pushes.some((p) => p.run?.runId === run.runId && p.run.status === "done"), 8000);
    const peek = await bus.runtime.sendMessage({ type: "RECIPE_RECORD_PEEK" });
    expect(peek.armed).toBe(false);
  });
});
