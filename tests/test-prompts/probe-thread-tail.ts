#!/usr/bin/env bun
/**
 * #237 spike — established-thread minimal tail: does Zo's conversation_id
 * thread retain enough that a follow-up turn can ride a STUB tail (no
 * not-attached contract, no instructions), or does the static tail have to
 * ride every turn?
 *
 *   bun --env-file=.env tests/test-prompts/probe-thread-tail.ts
 *
 * Method (6 requests max, timeboxed):
 *   A1  fresh action turn   — full cobrowse prompt (schema) → seed the thread
 *   A2  threaded action turn— stub tail: envelope demand only. Does the model
 *                             still emit a valid actions envelope + act on the
 *                             CURRENT page pointer (not A1's)?
 *   A2' fresh control       — same stub, NO conversation_id (protocol must
 *                             degrade — proves the thread is what carries it)
 *   R1  threaded read turn  — full read tail (contract) → the honest baseline
 *   R2  threaded read turn  — stub tail (bare query + "Answer directly") →
 *                             does Zo still fetch the URL itself instead of
 *                             claiming content was provided?
 *
 * Verdict rule (recorded in #237):
 *   GO if A2 keeps a valid envelope on the right target AND R2 answers without
 *   hallucinating page content (fetches or honestly declines). NO-GO otherwise.
 * Exit 0 when the probe ran (verdict may be NO-GO); transcripts print + save
 * to tests/test-prompts/fixtures/thread-tail-probe.json.
 */

import { buildPrompt } from "../../extension/lib/prompt.js";
import { BUILTIN_MODES, ACTION_SCHEMA_COMPACT, NOT_ATTACHED_CONTRACT, SHARED_SAFETY_RULES } from "../../extension/lib/modes.js";
import { parseZoOutput } from "../../extension/lib/parse-output.js";

const TOKEN = process.env.ZO_API_KEY || process.env.ZO_ACCESS_TOKEN || "";
if (!TOKEN) {
  console.error("probe-thread-tail: ZO_API_KEY missing (bun --env-file=.env)");
  process.exit(2);
}
const API = "https://api.zo.computer/zo/ask";

const PAGE = {
  url: "https://example.com/account/settings",
  title: "Account Settings — Example Corp",
  viewport: { w: 1920, h: 1080 },
  visibleText: "Account Settings\nProfile\nEmail preferences\nSecurity\nSign out",
  clickable: [
    { tag: "a", text: "Profile", selector: "#nav-profile" },
    { tag: "a", text: "Security", selector: "#nav-security" },
    { tag: "button", text: "Sign out", selector: "#signout-btn" },
  ],
  formFields: [],
};

async function ask(input: string, conversationId?: string) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input,
      ...(conversationId ? { conversation_id: conversationId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return { text: String(data.output || ""), conversationId: data.conversation_id || null };
}

const stubActionTurn = (q: string) => `## User Request\n${q}\n\nRespond with JSON {"actions":[...]}`;
const stubReadTurn = (q: string) => `## User Request\n${q}\n\nAnswer directly in plain markdown.`;

const fullAction = (q: string) => buildPrompt(BUILTIN_MODES.cobrowse, PAGE, q);
const fullRead = (q: string) => buildPrompt(BUILTIN_MODES.cobrowse, PAGE, q, { effectiveTier: 0 });

type Step = { id: string; input: string; threaded: boolean; note: string };
const steps: Step[] = [
  { id: "A1 fresh-full", input: fullAction("Click the Profile link in the sidebar"), threaded: false, note: "seed the thread with the full protocol" },
  { id: "A2 thread-stub", input: stubActionTurn("Click the Security link instead"), threaded: true, note: "envelope demand only — does the thread carry the protocol AND the NEW page pointer?" },
  { id: "A2' fresh-stub", input: stubActionTurn("Click the Security link instead"), threaded: false, note: "control: same stub WITHOUT the thread — expected to degrade" },
  { id: "R1 thread-full", input: fullRead("What sections does this page have?"), threaded: true, note: "baseline: contract tail on the thread" },
  { id: "R2 thread-stub", input: stubReadTurn("What sections does this page have?"), threaded: true, note: "stub read turn: no not-attached contract — honest fetch or hallucination?" },
];

const transcripts: any[] = [];
let threadId: string | null = null;

for (const s of steps) {
  try {
    const t0 = Date.now();
    const r = await ask(s.input, s.threaded ? threadId || undefined : undefined);
    const parsed = parseZoOutput(r.text);
    const entry: any = {
      id: s.id,
      note: s.note,
      sentWithThread: s.threaded ? threadId : null,
      ms: Date.now() - t0,
      rawOutput: r.text.slice(0, 1200),
      parsed: {
        isActionEnvelope: parsed.actions.length > 0,
        actions: parsed.actions.slice(0, 4),
        plainText: parsed.plainText?.slice(0, 400) || null,
      },
    };
    transcripts.push(entry);
    console.log(`\n== ${s.id} (${entry.ms}ms) — ${s.note}`);
    if (entry.parsed.isActionEnvelope) {
      console.log("   actions:", JSON.stringify(entry.parsed.actions));
    } else {
      console.log("   text:", entry.parsed.plainText?.slice(0, 300));
    }
    if (r.conversationId && !threadId) {
      threadId = r.conversationId;
      console.log("   thread:", threadId);
    }
  } catch (err: any) {
    transcripts.push({ id: s.id, error: String(err?.message || err) });
    console.log(`\n== ${s.id} ERROR: ${err?.message || err}`);
  }
}

const byId = Object.fromEntries(transcripts.map((t) => [t.id, t]));
const a2Ok = byId["A2 thread-stub"]?.parsed?.isActionEnvelope === true &&
  JSON.stringify(byId["A2 thread-stub"]?.parsed?.actions || []).includes("Security");
const freshDegrades = byId["A2' fresh-stub"] && (byId["A2' fresh-stub"].parsed?.isActionEnvelope !== true ||
  !JSON.stringify(byId["A2' fresh-stub"]?.parsed?.actions || []).includes("Security"));
const r2Text = byId["R2 thread-stub"]?.parsed?.plainText || "";
const r2Honest = r2Text.length > 0 && !/cannot see|no access to the page/i.test(r2Text);
const verdict = a2Ok && r2Honest ? "GO" : "NO-GO";

console.log(`\n===== VERDICT: ${verdict} =====`);
console.log(`A2 threaded stub envelope on the right target: ${a2Ok}`);
console.log(`A2' fresh-stub control degrades: ${freshDegrades}`);
console.log(`R2 stub read turn honest (no hallucinated content): ${r2Honest}`);
console.log(`R2 text: ${r2Text.slice(0, 300)}`);

import { writeFileSync } from "fs";
import { resolve } from "path";
writeFileSync(
  resolve(import.meta.dir, "fixtures/thread-tail-probe.json"),
  JSON.stringify({ probedAt: new Date().toISOString(), verdict, a2Ok, freshDegrades, r2Honest, transcripts }, null, 2),
);
console.log("transcript → tests/test-prompts/fixtures/thread-tail-probe.json");
