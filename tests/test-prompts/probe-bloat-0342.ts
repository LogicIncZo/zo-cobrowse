#!/usr/bin/env bun
/**
 * probe-bloat-0342.ts — 0.3.4.2 prompt-efficiency bug bash.
 *
 * Renders EVERY prompt the extension can send to /zo/ask across a scenario
 * matrix (modes × tiers × tail states × option combos + the one-shot
 * assemblers) and prints per-section char/token sizes. Offline — pure
 * rendering, no network. Findings feed the 0.3.4.2 issue log.
 *
 * Usage: bun tests/test-prompts/probe-bloat-0342.ts [--json]
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_LIB = resolve(__dirname, "..", "..", "extension", "lib");

const modesMod = await import(resolve(EXT_LIB, "modes.js"));
const promptMod = await import(resolve(EXT_LIB, "prompt.js"));
const handoffMod = await import(resolve(EXT_LIB, "handoff.js"));
const recipesMod = await import(resolve(EXT_LIB, "recipes.js"));
const pullMod = await import(resolve(EXT_LIB, "pull.js"));
const tabCtxMod = await import(resolve(EXT_LIB, "tab-contexts.js"));
const writeAssistMod = await import(resolve(EXT_LIB, "write-assist.js"));
const zoPromptsMod = await import(resolve(EXT_LIB, "zo-prompts.js"));

const { BUILTIN_MODES } = modesMod;
const { buildPrompt, describePrompt, estimateTokens } = promptMod;

const AS_JSON = process.argv.includes("--json");

// ── Synthetic page context in the real capture shape ──────────────────────
function makePageContext(tier: number, opts: { textLen?: number } = {}) {
  const ctx: any = {
    url: "https://example.com/shop/products?category=widgets",
    title: "Widgets — Example Shop",
    viewport: { w: 1512, h: 982 },
  };
  if (tier >= 1) {
    const n = opts.textLen ?? 4000; // textBudget-sliced by buildPrompt anyway
    ctx.visibleText = ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(200)).slice(0, n);
  }
  if (tier >= 2) {
    ctx.clickable = Array.from({ length: 50 }, (_, i) => ({
      tag: i % 3 === 0 ? "button" : "a",
      text: `Product link ${i + 1} — buy widget model ${1000 + i}`,
      selector: `#main > div:nth-child(${i + 1}) > a`,
    }));
    ctx.formFields = Array.from({ length: 12 }, (_, i) => ({
      tag: "input",
      type: i % 4 === 0 ? "email" : "text",
      placeholder: `Field ${i + 1} placeholder text`,
      selector: `#form input[name=field_${i + 1}]`,
      question: `What is your answer for question ${i + 1}?`,
    }));
  }
  if (tier >= 3) {
    // real tier-3 data URLs are ~100KB+; a small stand-in marks the section
    ctx.screenshotDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";
  }
  return ctx;
}

const tok = (s: string) => estimateTokens(s);
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s).padEnd(n);

interface Row {
  scenario: string;
  chars: number;
  tokens: number;
  sections?: Array<{ id: string; chars: number; tokens: number }>;
  notes?: string[];
}

const rows: Row[] = [];

function recordPrompt(scenario: string, prompt: string, mode?: any, pageContext?: any, userQuery?: string, opts?: any) {
  let sections: Row["sections"];
  let notes: string[] = [];
  if (mode) {
    const d = describePrompt(mode, pageContext, userQuery, opts);
    sections = d.sections.map((s: any) => ({ id: s.id, chars: s.text.length, tokens: tok(s.text) }));
    // bloat heuristics
    const sys = d.sections.find((s: any) => s.id === "system");
    const tail = d.sections.find((s: any) => s.id === "tail");
    if (sys && tail) {
      const personaDup = sys.text.includes("You are Zo") && tail.text.includes("You are Zo");
      if (personaDup) notes.push("persona restated in tail");
    }
    const safety = (tail?.text.match(/never click ANY button/gi) || []).length;
    if (safety > 1) notes.push(`safety rules x${safety} in tail`);
    if (d.sections.filter((s: any) => s.id === "tail").length) {
      // already grouped; nothing
    }
  }
  rows.push({ scenario, chars: prompt.length, tokens: tok(prompt), sections, notes });
}

// ── A. buildPrompt scenario matrix (sidepanel-driven turns) ────────────────
const ACTION_Q = "Click the first product link and fill the search box with 'widgets'";
const READ_Q = "Summarize what this page is about";

const matrix: Array<{ name: string; modeId: keyof typeof BUILTIN_MODES; q: string; tier: number; opts: any }> = [
  { name: "A1 cobrowse action t2 full-tail (no skill)", modeId: "cobrowse", q: ACTION_Q, tier: 2, opts: {} },
  { name: "A2 cobrowse action t2 slim-tail (skill ok)", modeId: "cobrowse", q: ACTION_Q, tier: 2, opts: { protocolSkill: { installed: true } } },
  { name: "A3 cobrowse action t0 follow-up (same page)", modeId: "cobrowse", q: ACTION_Q, tier: 0, opts: { protocolSkill: { installed: true }, establishedThread: true } },
  { name: "A4 cobrowse action t2 + jev", modeId: "cobrowse", q: ACTION_Q, tier: 2, opts: { protocolSkill: { installed: true }, jevAssist: true } },
  { name: "A5 cobrowse read-downgrade t0 first", modeId: "cobrowse", q: READ_Q, tier: 0, opts: {} },
  { name: "A6 cobrowse read-downgrade t0 established", modeId: "cobrowse", q: READ_Q, tier: 0, opts: { establishedThread: true } },
  { name: "A7 cobrowse read-downgrade t2 first", modeId: "cobrowse", q: READ_Q, tier: 2, opts: {} },
  { name: "A8 ask t1 first", modeId: "ask", q: "What is the main topic?", tier: 1, opts: {} },
  { name: "A9 ask t0 established", modeId: "ask", q: "follow-up question about the same page", tier: 0, opts: { establishedThread: true } },
  { name: "A10 extract t2", modeId: "extract", q: "Extract all product names and prices", tier: 2, opts: {} },
  { name: "A11 lean t0", modeId: "lean", q: "Summarize this article", tier: 0, opts: {} },
  { name: "A12 visual t3", modeId: "visual", q: "Describe the screen", tier: 3, opts: {} },
  { name: "A13 cobrowse t2 + 3 tab refs", modeId: "cobrowse", q: ACTION_Q, tier: 2, opts: { protocolSkill: { installed: true }, tabContexts: [
    { ref: "T1", title: "Competitor pricing", url: "https://comp.example/pricing", excerpt: "Plans start at $10/mo…".repeat(12) },
    { ref: "T2", title: "Docs", url: "https://docs.example/widgets", excerpt: "Widget API docs…".repeat(12) },
    { ref: "T3", title: "Reviews", url: "https://rev.example/w", excerpt: "Best widget ever…".repeat(12) },
  ] } },
  { name: "A14 cobrowse t2 + 2 skills + 2 files", modeId: "cobrowse", q: ACTION_Q, tier: 2, opts: { protocolSkill: { installed: true }, skills: [
    { name: "duckdb-analysis", folder: "Skills/duckdb-analysis" },
    { name: "web-research", folder: "Skills/web-research" },
  ], workspaceFiles: [
    { path: "/home/workspace/data/leads.csv" },
    { path: "/home/workspace/notes" },
  ] } },
  { name: "A15 cobrowse handoff turn1 (goal+instr)", modeId: "cobrowse", q: `Research the top 5 competing widget stores and compile prices\n\n${handoffMod.handoffInstructions(handoffMod.createRun({ goal: "Research the top 5 competing widget stores and compile prices" }))}`, tier: 2, opts: { protocolSkill: { installed: true } } },
  { name: "A16 compose turn1 (goal+instr, full tail)", modeId: "cobrowse", q: `Compose a recipe that books a widget demo\n\n${recipesMod.composeInstructions("book a widget demo")}`, tier: 2, opts: { protocolSkill: { installed: true }, noSlimTail: true } },
];

for (const m of matrix) {
  const mode = BUILTIN_MODES[m.modeId];
  const ctx = makePageContext(m.tier);
  const prompt = buildPrompt(mode, ctx, m.q, { effectiveTier: m.tier, ...m.opts });
  recordPrompt(m.name, prompt, mode, ctx, m.q, { effectiveTier: m.tier, ...m.opts });
}

// handoff continuation turn (progress report as userQuery, fresh t2 capture)
{
  const run = handoffMod.createRun({ goal: "research competitors" });
  const stepped = handoffMod.tally(run, { turns: 3, navigations: 5 });
  const q = handoffMod.buildContinuationTurn(stepped, { lastSummary: "Scanned 3 stores; 2 remain." });
  const mode = BUILTIN_MODES.cobrowse;
  const ctx = makePageContext(2);
  const prompt = buildPrompt(mode, ctx, q, { effectiveTier: 2, protocolSkill: { installed: true } });
  recordPrompt("A17 handoff continuation t2", prompt, mode, ctx, q, { effectiveTier: 2, protocolSkill: { installed: true } });
}

// ── B. pull follow-ups (_followUpInput — replaces the whole prompt) ───────
{
  const ctx2 = makePageContext(2, { textLen: 12000 });
  const target = { ref: "T1", title: "Competitor pricing", url: "https://comp.example/pricing", host: "comp.example" };
  for (const [name, type, capt, tgt] of [
    ["B1 read_tab content", "read_tab", ctx2, target],
    ["B2 read_page 12k", "read_page", ctx2, { title: "Current page", url: "https://example.com/shop", host: "example.com" }],
    ["B3 get_dom", "get_dom", ctx2, { title: "Current page", url: "https://example.com/shop", host: "example.com" }],
    ["B4 get_form", "get_form", ctx2, { title: "Current page", url: "https://example.com/shop", host: "example.com" }],
    ["B5 read_file 20k", "read_file", { content: "a".repeat(20000) }, { path: "/home/workspace/data/leads.csv" }],
  ] as Array<[string, string, any, any]>) {
    const fu = pullMod.buildPullFollowUp(type, tgt, capt, {});
    rows.push({ scenario: name, chars: fu.input.length, tokens: tok(fu.input) });
  }
}

// ── C. write-assist ────────────────────────────────────────────────────────
{
  const base = { text: "we should probably ship the fix this week since customers asked", instruction: "", field: { label: "Additional comments", placeholder: "Anything else?", maxLength: 500 }, page: { url: "https://example.com/support/ticket/123", title: "Support ticket #123" }, acceptsMarkdown: false };
  const p1 = writeAssistMod.buildEnhancePrompt(base);
  rows.push({ scenario: "C1 write-assist enhance", chars: p1.length, tokens: tok(p1) });
  const p2 = writeAssistMod.buildEnhanceFollowUpPrompt({ ...base, priorText: "We should ship the fix this week because multiple customers have requested it.", instruction: "make it more formal" });
  rows.push({ scenario: "C2 write-assist chip follow-up", chars: p2.length, tokens: tok(p2) });
}

// ── D. one-shot assemblers ────────────────────────────────────────────────
{
  const draft = {
    name: "Book widget demo",
    params: [{ name: "email", type: "string", required: true, question: "Your email?", default: "REDACTED" }],
    steps: [
      { type: "navigate", url: "https://example.com/demo" },
      { type: "fill", selector: "#email", cues: [{ strategy: "label", value: "Email" }], value: "{{email}}" },
      { type: "human", instruction: "Review and submit", resumeOn: { selector: ".success" } },
      { type: "done", message: "Demo booked" },
    ],
  };
  const d1 = recipesMod.generateRecipePrompt(draft as any);
  rows.push({ scenario: "D1 recipe cleanup", chars: d1.length, tokens: tok(d1) });
  const d2 = recipesMod.composeCleanupPrompt({ ...draft, goal: "book a demo" } as any);
  rows.push({ scenario: "D2 compose cleanup", chars: d2.length, tokens: tok(d2) });
  const d3 = recipesMod.healPrompt({ name: "Book widget demo" }, draft.steps[1] as any, { tried: ["label: Email", "selector: #email"], candidates: [{ text: "Email address", selector: "#email-addr" }] }, makePageContext(2));
  rows.push({ scenario: "D3 recipe heal", chars: d3.length, tokens: tok(d3) });
  const d4 = recipesMod.generateValuePrompt({ generate: { prompt: "Draft a professional one-line company description for the Company field", maxChars: 120 } } as any);
  rows.push({ scenario: "D4 generate-value", chars: d4.length, tokens: tok(d4) });
  const d5 = zoPromptsMod.buildGenerateModePrompt("a mode that finds cheapest flights and books them");
  rows.push({ scenario: "D5 generate-mode", chars: d5.length, tokens: tok(d5) });
  const d6 = zoPromptsMod.buildRunSkillPrompt("web-research", makePageContext(1));
  rows.push({ scenario: "D6 run-skill", chars: d6.length, tokens: tok(d6) });
  const d7 = zoPromptsMod.buildCreateAutomationPrompt("summarize this page daily", "FREQ=DAILY", makePageContext(1));
  rows.push({ scenario: "D7 create-automation", chars: d7.length, tokens: tok(d7) });
  const d8 = zoPromptsMod.buildListAutomationsPrompt();
  rows.push({ scenario: "D8 list-automations", chars: d8.length, tokens: tok(d8) });
}

// ── Report ────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`scenario                               chars   ~tok   sections (id:tok) / notes`);
  console.log("─".repeat(110));
  for (const r of rows) {
    const secs = r.sections ? "  " + r.sections.map((s) => `${s.id}:${s.tokens}`).join(" ") : "";
    const notes = r.notes?.length ? `   ⚠ ${r.notes.join("; ")}` : "";
    console.log(`${pad(r.scenario, 38)} ${String(r.chars).padStart(6)} ${String(r.tokens).padStart(6)}${secs}${notes}`);
  }
}
