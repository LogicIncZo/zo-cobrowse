#!/usr/bin/env bun
/**
 * Jev vs Zo comparative probe (0.3.4 Lane J spike — spec Part A live verification).
 *
 *   bun --env-file=.env tests/test-prompts/probe-jev.ts
 *
 * Question: is Jev (TypeSafe AI System One decide endpoint) actually faster
 * than a full Zo turn for the two fast-path hooks tickets #341/#342 spec —
 * click-pick (choice) and the done-gate (noul) — and do the two agree?
 *
 * "Inside the extension" on purpose: the state under test is a REAL tier-2
 * CAPTURE_CONTEXT from the real content script, captured on the e2e fixture
 * site through the real extension (launchExtension harness). The Zo leg runs
 * the extension's actual prompt assembler (lib/prompt.js buildPrompt in
 * cobrowse mode) against the live Zo API and parses the reply with the
 * extension's real parser (lib/parse-output.js parseZoOutput). The Jev leg
 * speaks the documented POST /v1/systemone contract (spec Part A).
 *
 * Scenarios (ground truth comes from the fixture page itself):
 *   S1 click-pick  "make the page say the thing is done" → #action-btn
 *   S2 click-pick  "open the form page"                  → #nav-form
 *   S3 done-gate BEFORE the click (goal NOT achieved)    → expect low / not-done
 *   S4 done-gate AFTER  the click (goal achieved)        → expect high / done
 *
 * Exit 0 when every correctness gate passes (latency is reported, not gated).
 * Spike artifact — throwaway by design; the durable home for these shapes is
 * lib/jev.js + tests (Lane J1/J2).
 */

import { spawn } from "child_process";

const ZO_TOKEN = process.env.ZO_API_KEY || process.env.ZO_ACCESS_TOKEN || "";
const JEV_TOKEN = process.env.TYPESAFE_API_KEY || "";
const ZO_API = "https://api.zo.computer/zo/ask";
const JEV_API = process.env.JEV_API_URL || "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = process.env.JEV_MODEL || "jev-latest";
const ZO_MODEL = process.env.PROBE_MODEL || ""; // empty = server default (named models rot)
const E2E_BASE = process.env.E2E_BASE || "http://127.0.0.1:3179";

const missing = [!ZO_TOKEN && "ZO_API_KEY", !JEV_TOKEN && "TYPESAFE_API_KEY"].filter(Boolean);
if (missing.length) {
  console.error(`probe-jev: missing ${missing.join(" + ")} (bun --env-file=.env)`);
  process.exit(2);
}
const mask = (k) => `${k.slice(0, 4)}…${k.slice(-2)}`;
console.log(`probe-jev: zo=${mask(ZO_TOKEN)} jev=${mask(JEV_TOKEN)} jev-model=${JEV_MODEL}${ZO_MODEL ? ` zo-model=${ZO_MODEL}` : " zo-model=<server default>"}\n`);

const { buildPrompt } = await import("../../extension/lib/prompt.js");
const { resolveMode } = await import("../../extension/lib/modes.js");
const { parseZoOutput } = await import("../../extension/lib/parse-output.js");
const { launchExtension } = await import("../../e2e/helpers/extension.js");

// ── Transport helpers ────────────────────────────────────────────────────────

async function jevDecide(state, questions, label) {
  const t0 = performance.now();
  const res = await fetch(JEV_API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${JEV_TOKEN}` },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal: AbortSignal.timeout(15_000),
  });
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`jev [${label}] HTTP ${res.status} — ${body}`);
  }
  const data = await res.json();
  return { ms, answers: data.answers ?? {}, usage: data.usage ?? {}, model: data.model };
}

async function zoTurn(prompt, label) {
  const t0 = performance.now();
  const res = await fetch(ZO_API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ZO_TOKEN}` },
    body: JSON.stringify({
      input: prompt,
      stream: false,
      memory_mode: "off",
      ...(ZO_MODEL ? { model_name: ZO_MODEL } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`zo [${label}] HTTP ${res.status} — ${body}`);
  }
  const data = await res.json();
  const text = typeof data === "string" ? data : (data.response ?? data.output ?? data.text ?? JSON.stringify(data));
  return { ms, parsed: parseZoOutput(text) };
}

const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

// ── Fixture state builders (filtered per the jaggedness guidance: tight state) ──

function clickPickState(capture, goal) {
  const elements = (capture.clickable || [])
    .filter((el) => (el.text || "").trim())
    .slice(0, 20)
    .map((el, i) => ({ id: `e${i}`, text: el.text.trim().slice(0, 60), tag: el.tag, selector: el.selector }));
  return { goal, page: { url: capture.url, title: capture.title }, elements };
}
function doneGateState(capture, goal) {
  return {
    goal,
    page: { url: capture.url, title: capture.title },
    pageText: (capture.visibleText || "").replace(/\s+/g, " ").trim().slice(0, 800),
  };
}
const pickGroundTruth = (state, marker, textTell) =>
  state.elements.find((el) => el.selector.includes(marker) || el.text.toLowerCase().includes(textTell))?.id ?? null;

// ── Boot: mock server (fixture site) + the real extension ────────────────────

const server = spawn(process.execPath, ["e2e/mock-zo/server.mjs"], { stdio: "ignore", detached: false });
let siteTabId = null;
let panel = null;
let context = null;
try {
  for (let i = 0; i < 40; i++) {
    try { await fetch(E2E_BASE); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ context } = await launchExtension({ freshProfile: true }));
  const { extensionId } = { extensionId: new URL(context.serviceWorkers()[0].url()).host };
  const site = await context.newPage();
  await site.goto(`${E2E_BASE}/`, { waitUntil: "load" });
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForTimeout(2500);

  // Real tier-2 capture through the real content script, from the panel's
  // extension context (the SW evaluate path is unreliable from test runners).
  siteTabId = await panel.evaluate(
    (prefix) =>
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => resolve(tabs.find((t) => (t.url || "").startsWith(prefix))?.id ?? null));
      }),
    E2E_BASE,
  );
} catch (err) {
  console.error("probe-jev: harness boot failed —", err.message);
  server.kill();
  process.exit(2);
}

async function realCapture() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cap = await panel.evaluate(
      (tabId) =>
        new Promise((resolve) => {
          try {
            chrome.tabs.sendMessage(tabId, { type: "CAPTURE_CONTEXT", tier: 2 }, (r) => {
              void chrome.runtime.lastError; // tab not ready yet → undefined
              resolve(r ?? null);
            });
          } catch { resolve(null); }
        }),
      siteTabId,
    );
    if (cap?.url) return cap;
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

const capture1 = await realCapture();
if (!capture1) {
  console.error("probe-jev: CAPTURE_CONTEXT returned nothing (content script not injected?)");
  server.kill();
  process.exit(2);
}
console.log(`capture: url=${capture1.url} title="${capture1.title}" clickable=${(capture1.clickable || []).length} text=${(capture1.visibleText || "").length} chars`);

// ── Scenarios ────────────────────────────────────────────────────────────────

const GOAL_THING = "Make the page say the thing is done";
const GOAL_FORM = "Open the form page";
const state1 = clickPickState(capture1, GOAL_THING);
const state2 = clickPickState(capture1, GOAL_FORM);
const gt1 = pickGroundTruth(state1, "action-btn", "do a thing");
const gt2 = pickGroundTruth(state2, "nav-form", "form page");

const clickQuestions = (state) => ({
  target: {
    type: "choice",
    instructions: "The user's goal is stated in the state. Which element, when activated on the page, achieves the goal?",
    criteria: Object.fromEntries(state.elements.map((el) => [el.id, `${el.text} (${el.tag})`])),
  },
});

const doneQuestions = (goal) => ({
  goal_done: {
    type: "noul",
    instructions: `The user's goal is: "${goal}". The state is the URL, title, and text content of the web page the user is currently viewing. The goal is already fully achieved on this page.`,
  },
});

const zoClickPrompt = (cap, goal) =>
  buildPrompt(resolveMode("cobrowse"), cap, goal, { effectiveTier: 2 });
const zoDonePrompt = (cap, goal) =>
  buildPrompt(
    resolveMode("cobrowse"),
    cap,
    `Goal: ${goal}. If the goal is already fully achieved on this page, respond with only a done action. Otherwise respond with the next action to take.`,
    { effectiveTier: 2 },
  );

const rows = [];
let fail = 0;
const gate = (name, pass, detail) => {
  rows.push({ name, pass, detail });
  if (!pass) fail++;
  console.log(` ${pass ? "✓" : "✗"} ${name} — ${detail}`);
};

// Jev trials
async function jevTrials(name, n, stateBuilder, questions) {
  const times = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    const r = await jevDecide(stateBuilder(), questions, `${name}#${i}`);
    times.push(r.ms);
    last = r;
  }
  return { times, last };
}
// Zo trials
async function zoTrials(name, n, promptBuilder, cap) {
  const times = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    const r = await zoTurn(promptBuilder(cap), `${name}#${i}`);
    times.push(r.ms);
    last = r;
  }
  return { times, last };
}

console.log("\n── S1 click-pick: “" + GOAL_THING + "” (truth: #action-btn = " + gt1 + ") ──");
{
  const jev = await jevTrials("S1.jev", 3, () => state1, clickQuestions(state1));
  const choice = jev.last.answers?.target?.choice;
  const conf = jev.last.answers?.target?.confidence;
  gate("S1 Jev pick", choice === gt1, `choice=${choice} conf=${conf} median=${median(jev.times)}ms in_tokens=${jev.last.usage?.input_tokens}`);
  const zo = await zoTrials("S1.zo", 2, (c) => zoClickPrompt(c, GOAL_THING), capture1);
  const act = zo.last.parsed.actions.find((a) => a.type === "click");
  const raw = JSON.stringify(act ?? zo.last.parsed.actions).toLowerCase();
  gate("S1 Zo pick", !!act && (raw.includes("action-btn") || raw.includes("do a thing")), `median=${median(zo.times)}ms action=${raw.slice(0, 120)}`);
  console.log(`   speedup (median): ${Math.round(median(zo.times) / Math.max(1, median(jev.times)))}×  jev[${jev.times.join(", ")}ms] zo[${zo.times.join(", ")}ms]\n`);
}

console.log("── S2 click-pick: “" + GOAL_FORM + "” (truth: #nav-form = " + gt2 + ") ──");
{
  const jev = await jevTrials("S2.jev", 2, () => state2, clickQuestions(state2));
  const choice = jev.last.answers?.target?.choice;
  gate("S2 Jev pick", choice === gt2, `choice=${choice} conf=${jev.last.answers?.target?.confidence} median=${median(jev.times)}ms`);
  const zo = await zoTrials("S2.zo", 1, (c) => zoClickPrompt(c, GOAL_FORM), capture1);
  const act = zo.last.parsed.actions.find((a) => a.type === "click");
  const raw = JSON.stringify(act ?? zo.last.parsed.actions).toLowerCase();
  gate("S2 Zo pick", !!act && (raw.includes("nav-form") || raw.includes("form page") || raw.includes("form.html")), `median=${median(zo.times)}ms action=${raw.slice(0, 120)}`);
  console.log(`   speedup (median): ${Math.round(median(zo.times) / Math.max(1, median(jev.times)))}×\n`);
}

console.log("── S3 done-gate BEFORE (goal NOT achieved; truth: not done) ──");
{
  const jev = await jevTrials("S3.jev", 2, () => doneGateState(capture1, GOAL_THING), doneQuestions(GOAL_THING));
  const noul = jev.last.answers?.goal_done?.noul;
  gate("S3 Jev not-done", typeof noul === "number" && noul < 0.5, `noul=${noul} median=${median(jev.times)}ms`);
  const zo = await zoTrials("S3.zo", 1, (c) => zoDonePrompt(c, GOAL_THING), capture1);
  const done = zo.last.parsed.actions.some((a) => a.type === "done");
  gate("S3 Zo not-done", !done, `median=${median(zo.times)}ms actions=${JSON.stringify(zo.last.parsed.actions.map((a) => a.type))}`);
  console.log(`   speedup (median): ${Math.round(median(zo.times) / Math.max(1, median(jev.times)))}×\n`);
}

console.log("── S4 done-gate AFTER (goal achieved; truth: done) ──");
{
  const site = context.pages().find((p) => (p.url() || "").startsWith(E2E_BASE));
  await site.click("#action-btn");
  const capture2 = (await realCapture()) ?? capture1;
  const jev = await jevTrials("S4.jev", 2, () => doneGateState(capture2, GOAL_THING), doneQuestions(GOAL_THING));
  const noul = jev.last.answers?.goal_done?.noul;
  gate("S4 Jev done", typeof noul === "number" && noul >= 0.8, `noul=${noul} median=${median(jev.times)}ms`);
  const zo = await zoTrials("S4.zo", 1, (c) => zoDonePrompt(c, GOAL_THING), capture2);
  const done = zo.last.parsed.actions.some((a) => a.type === "done");
  gate("S4 Zo done", done, `median=${median(zo.times)}ms actions=${JSON.stringify(zo.last.parsed.actions.map((a) => a.type))}`);
  console.log(`   speedup (median): ${Math.round(median(zo.times) / Math.max(1, median(jev.times)))}×\n`);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("probe-jev results");
for (const r of rows) console.log(` ${r.pass ? "✓" : "✗"} ${r.name} — ${r.detail}`);
console.log(`\nverdict: ${fail ? `${fail} gate(s) failed` : "all gates passed"} — see per-scenario speedups above for the latency story`);
server.kill();
await context.close();
process.exit(fail ? 1 : 0);
