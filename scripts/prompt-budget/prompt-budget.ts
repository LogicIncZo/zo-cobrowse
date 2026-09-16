// Prompt-budget gate (#238): enforce per-mode × turn-shape token ceilings
// from the prompt-bloat audit inside `verify`/CI. Drift-gate philosophy —
// the ceilings are COMMITTED (scripts/prompt-budget/ceilings.json); intentional
// prompt growth = a ceiling bump in the SAME PR, review-visible. A +2% tolerance
// absorbs non-semantic churn; anything beyond it turns the gate red.
//
//   bun scripts/prompt-budget/prompt-budget.ts            // enforce
//   bun scripts/prompt-budget/prompt-budget.ts --update   // re-pin ceilings
//
// Offline, no network — the same deterministic fixture as
// scripts/prompt-audit/prompt-audit.ts over pure lib/prompt.js.

import { describePrompt, estimateTokens } from "../../extension/lib/prompt.js";
import { BUILTIN_MODES } from "../../extension/lib/modes.js";
import { readFileSync, writeFileSync } from "node:fs";

// ── fixture (kept in lockstep with scripts/prompt-audit/prompt-audit.ts) ──
const ctx = {
  url: "https://example.test/product/page",
  title: "Example Product Page — Widgets & Co.",
  visibleText: Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: sample page copy for the audit fixture.`).join(" "),
  clickable: Array.from({ length: 50 }, (_, i) => ({ text: `Control ${i}`, tag: i % 3 ? "a" : "button", selector: `#ctl-${i}` })),
  formFields: Array.from({ length: 6 }, (_, i) => ({ label: `Field ${i}`, name: `f${i}`, type: "text", selector: `#f${i}`, question: `Question ${i}?` })),
  viewport: { w: 1280, h: 800 },
  screenshotDataUrl: "data:image/jpeg;base64," + "Q".repeat(4000),
};
const tab = { ref: "T1", tabId: 1, url: "https://docs.example.test/api", title: "API Reference", excerpt: "Excerpt: endpoints overview ".repeat(10), active: false };
const tabThin = { ...tab, excerpt: "" };
const skills = [{ id: "websh", name: "websh", description: "A shell for the web. Navigate URLs like directories." }];
const files = [{ path: "/home/workspace/report.md" }, { path: "/home/workspace/Skills/e2e-skill", dir: true }];

const turnShapes: Array<[string, (m: any) => ReturnType<typeof describePrompt>]> = [
  ["fresh action", (m) => describePrompt(m, ctx, "Fill the order form and continue to checkout", { effectiveTier: m.contextTier })],
  ["read (downgraded)", (m) => describePrompt(m, ctx, "Summarize this page", { effectiveTier: m.contextTier })],
  ["tier-0 follow-up", (m) => describePrompt(m, ctx, "thanks — now the other button", { effectiveTier: 0 })],
  ["+2 referenced tabs", (m) => describePrompt(m, ctx, "compare with the docs", { effectiveTier: m.contextTier, tabContexts: [tab, { ...tab, ref: "T2", tabId: 2, url: "https://example.test/pricing", title: "Pricing" }] })],
  ["+skill +files", (m) => describePrompt(m, ctx, "run it", { effectiveTier: m.contextTier, skills, workspaceFiles: files })],
  ["tier-0 +tabs(thin)", (m) => describePrompt(m, ctx, "what changed on the docs?", { effectiveTier: 0, tabContexts: [tabThin] })],
];

export type Ceilings = Record<string, number>; // `${modeId}|${shape}` → approx tokens

export function currentTotals(): Ceilings {
  const out: Ceilings = {};
  for (const m of Object.values(BUILTIN_MODES)) {
    for (const [name, run] of turnShapes) {
      out[`${m.id}|${name}`] = run(m).approxTokens;
    }
  }
  return out;
}

/** A ceiling holds when current ≤ ceiling×(1+tolerance). 2% churn headroom. */
export function ceilingHolds(current: number, ceiling: number, tolerance = 0.02): boolean {
  return current <= Math.ceil(ceiling * (1 + tolerance));
}

const CEILINGS_PATH = new URL("./ceilings.json", import.meta.url);

const update = process.argv.includes("--update");
const current = currentTotals();

if (update) {
  writeFileSync(CEILINGS_PATH, JSON.stringify(current, null, 2) + "\n");
  console.log(`prompt-budget: re-pinned ${Object.keys(current).length} ceilings → scripts/prompt-budget/ceilings.json`);
  process.exit(0);
}

let ceilings: Ceilings;
try {
  ceilings = JSON.parse(readFileSync(CEILINGS_PATH, "utf-8"));
} catch {
  console.error("prompt-budget: scripts/prompt-budget/ceilings.json missing — run with --update to pin.");
  process.exit(1);
}

const violations: string[] = [];
for (const [key, cur] of Object.entries(current)) {
  const ceiling = ceilings[key];
  if (ceiling === undefined) {
    violations.push(`${key}: NO CEILING PINNED (current ~${cur}) — bump ceilings.json in this PR`);
    continue;
  }
  if (!ceilingHolds(cur, ceiling)) {
    violations.push(`${key}: ~${cur} tok exceeds ceiling ${ceiling} (+2% tolerance) — trim the prompt or bump the ceiling in this PR (review-visible)`);
  }
}
for (const key of Object.keys(ceilings)) {
  if (current[key] === undefined) violations.push(`${key}: ceiling for a shape that no longer exists — drop it from ceilings.json`);
}

if (violations.length) {
  console.error("prompt-budget: BREACHED —");
  for (const v of violations) console.error("  ✗ " + v);
  console.error("\nIntentional growth? Re-pin with `bun scripts/prompt-budget/prompt-budget.ts --update` in the same PR.");
  process.exit(1);
}
console.log(`prompt-budget: OK — ${Object.keys(current).length} mode × shape ceilings hold (+2% tolerance).`);
