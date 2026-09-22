#!/usr/bin/env bun
/**
 * probe-handoff-bash.ts — !handoff bug bash (0.3.4.3 round).
 *
 * Demonstrates suspected defects in the Lane E handoff loop, one section per
 * finding. Integration sections use the fake-chrome bus + SSE fetch mock in
 * a fresh process (same mechanics as tests/integration/handoff-flow.test.ts).
 *
 * Usage: bun tests/test-prompts/probe-handoff-bash.ts
 */

import { createFakeChrome, waitUntil } from "../helpers/chrome-mock.ts";
import { ZoFetchMock, MOCK_ZO_TOKEN, sseResponse, zoSseText } from "../helpers/zo-fetch-mock.ts";

const out = (s: string) => console.log(s);
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  out(`${ok ? "CONFIRMED" : "clean   "} — ${name}${detail ? ` · ${detail}` : ""}`);
  if (ok) failed++;
};

// ── Sections 3+4 (pure): the readonly turn-1 prompt teaches actions the
// boundary refuses, and the Jev click block rides a run that cannot click ──
{
  const modes = await import("../../extension/lib/modes.js");
  const prompt = await import("../../extension/lib/prompt.js");
  const handoff = await import("../../extension/lib/handoff.js");

  const run = handoff.createRun({ goal: "Compare the pricing across these product tabs", boundaryMode: "readonly" });
  const query = `${run.goal}\n\n${handoff.handoffInstructions(run)}`;
  const ctx = { url: "https://fixture.example/", title: "Fixture", viewport: { w: 1280, h: 800 }, visibleText: "body", clickable: [{ tag: "a", text: "x", selector: "#a" }], formFields: [] };
  const p = prompt.buildPrompt(modes.BUILTIN_MODES.cobrowse, ctx, query, { effectiveTier: 2, protocolSkill: { installed: true }, jevAssist: true });

  check(
    "F3: Jev-Assisted click block rides a READONLY handoff turn-1 prompt",
    p.includes("Jev-Assisted Steps"),
    "boundary refuses every click; the block teaches delegating clicks",
  );
  const schemaRides = ["fill_form", "click{selector}", "fill{selector,value}"].filter((s) => p.includes(s));
  check(
    "F4: full action schema (click/fill/fill_form PREFER) rides a READONLY run",
    schemaRides.length === 3,
    `schema teaches: ${schemaRides.join(", ")}`,
  );
  const full = prompt.ACTION_SCHEMA_COMPACT ?? modes.ACTION_SCHEMA_COMPACT;
  out(`        (full schema = ${Math.ceil(full.length / 4)} tok; readonly-legal subset navigate/extract/scroll/wait/done ≈ 25 tok)`);
}

// ── Sections 1, 2, 5 (integration): fresh fake-chrome process ──────────────
const bus = createFakeChrome();
const fm = new ZoFetchMock();
const pushes: any[] = [];
bus.runtime.onMessage.addListener((m: any) => { if (m?.type === "HANDOFF_UPDATE") pushes.push(m); });
const badgeCalls: any[] = [];
(bus as any).action = {
  setBadgeBackgroundColor: (o: any) => { badgeCalls.push({ kind: "bg", ...o }); return Promise.resolve(); },
  setBadgeText: (o: any) => { badgeCalls.push({ kind: "text", text: o.text }); return Promise.resolve(); },
};
(bus as any).notifications = { create: (id: any, opts: any) => ({ id, opts }) };

bus.storage.local._store.zoAccessToken = MOCK_ZO_TOKEN;
await bus.tabs.create({ id: 1, url: "https://fixture.example/", active: true });
fm.install();
(globalThis as any).chrome = bus;
await import("../../extension/background.js?file=handoff-bash-probe");
await new Promise((r) => setTimeout(r, 50));

const port: any = bus.runtime.connect({ name: "cobrowse-stream" });
const seen: any[] = [];
port.onMessage.addListener((m: any) => seen.push(m));

async function startRun(chatId: string, goal: string) {
  return bus.runtime.sendMessage({ type: "HANDOFF_START", chatId, tabId: 1, goal, boundaryMode: "readonly" });
}

// ── F1 (post-fix): a zero-action (prose-only) turn BLOCKS the run ──────────
// Pre-fix this stranded the run 'running' forever (no chain, no block, stuck
// ▶ badge) — the finding that opened #368. The probe now asserts the fix.
{
  const start = await startRun("chat-prose", "Digest these tabs");
  fm.handle(() => sseResponse(zoSseText({ text: "I cannot reach the page — it requires a login. Which credentials should I use?" })));
  port.postMessage({ sessionId: 700, type: "ASK_ZO", chatId: "chat-prose", modeId: "cobrowse", userQuery: start.run.goal, handoffRunId: start.run.runId });
  await waitUntil(() => seen.some((m) => m.type === "STREAM_DONE" && String(m.sessionId).startsWith("700")), 8000);
  await waitUntil(async () => (await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: start.run.runId })).run?.status === "blocked", 8000);
  const st = await bus.runtime.sendMessage({ type: "HANDOFF_STATUS", runId: start.run.runId });
  const ok = st.run?.status === "blocked" && String(st.run?.stopReason || "").includes("turn ended without actions");
  check("F1 fixed: prose-only turn blocks the run with the prose as the reason", !ok, `status=${st.run?.status}, reason=${String(st.run?.stopReason || "").slice(0, 60)}`);
  await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: start.run.runId });
}

// ── F2: a second !handoff in the same chat starts a second live run ────────
{
  const a = await startRun("chat-dup", "First goal");
  const b = await startRun("chat-dup", "Second goal");
  const live = [a, b].filter((r) => r.ok && !["done", "aborted"].includes(r.run.status));
  check(
    "F2: double !handoff in one chat — both starts accepted (compose refuses this)",
    live.length === 2,
    `runs ${a.run?.runId} + ${b.run?.runId} both live on chat-dup, one pinned tab`,
  );
  await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: a.run.runId });
  await bus.runtime.sendMessage({ type: "HANDOFF_STOP", runId: b.run.runId });
}

// ── F5 (contrast demo): message-path pause updates the badge; the SW-restart
// orphan sweep (handoffPauseOrphans) saves runs via handoffStore.save and
// never calls handoffUpdateBadge — cite background.js sweep vs handoffPut. ──
{
  const start = await startRun("chat-badge", "Badge demo");
  const before = badgeCalls.filter((c) => c.kind === "text" && c.text === "▶").length;
  await bus.runtime.sendMessage({ type: "HANDOFF_PAUSE", runId: start.run.runId, reason: "demo" });
  const clearedAfterMessagePause = badgeCalls.some((c) => c.kind === "text" && c.text === "");
  out(`contrast  — message-path pause clears the badge (${clearedAfterMessagePause}, ▶ calls before: ${before});`);
  out(`            the SW-restart sweep path (handoffPauseOrphans → handoffStore.save) skips handoffUpdateBadge entirely`);
}

out(failed ? `\n${failed} finding(s) reproduced` : "\nall clean");
process.exit(0);
