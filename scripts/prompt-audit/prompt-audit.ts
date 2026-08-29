// Prompt-bloat audit (#71): run describePrompt across the mode × tier ×
// turn-shape matrix and print a per-section token-cost table (markdown).
// Offline, no network — pure lib/prompt.js over synthetic contexts.
//
//   bun scripts/prompt-audit/prompt-audit.ts
//
import { buildPrompt, describePrompt } from "../../extension/lib/prompt.js";
import { BUILTIN_MODES } from "../../extension/lib/modes.js";
import { mkdirSync, writeFileSync } from "node:fs";

const est = (s) => {
  // Mirror lib/prompt.js#estimateTokens without importing a private.
  return Math.ceil(s.length / 4);
};

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

const turnShapes = [
  ["fresh action", (m) => describePrompt(m, ctx, "Fill the order form and continue to checkout", { effectiveTier: m.contextTier })],
  ["read (downgraded)", (m) => describePrompt(m, ctx, "Summarize this page", { effectiveTier: m.contextTier })],
  ["tier-0 follow-up", (m) => describePrompt(m, ctx, "thanks — now the other button", { effectiveTier: 0 })],
  ["+2 referenced tabs", (m) => describePrompt(m, ctx, "compare with the docs", { effectiveTier: m.contextTier, tabContexts: [tab, { ...tab, ref: "T2", tabId: 2, url: "https://example.test/pricing", title: "Pricing" }] })],
  ["+skill +files", (m) => describePrompt(m, ctx, "run it", { effectiveTier: m.contextTier, skills, workspaceFiles: files })],
  ["tier-0 +tabs(thin)", (m) => describePrompt(m, ctx, "what changed on the docs?", { effectiveTier: 0, tabContexts: [tabThin] })],
];

const lines = [];
lines.push("# Prompt-bloat audit — per-section token costs (#71)");
lines.push("");
lines.push(`**Generated:** 2026-08-30 by \`bun scripts/prompt-audit/prompt-audit.ts\` (deterministic fixture; ~4 chars/token heuristic, same as \`estimateTokens\`).`);
lines.push("");
lines.push("## Mode × turn-shape totals");
lines.push("");
lines.push("| Mode (tier) | " + turnShapes.map(([n]) => n).join(" | ") + " |");
lines.push("|---|" + turnShapes.map(() => "---:").join("|"));
for (const m of Object.values(BUILTIN_MODES)) {
  const cells = turnShapes.map(([, run]) => {
    const d = run(m);
    return `~${d.approxTokens}`;
  });
  lines.push(`| ${m.icon} ${m.name} (${m.contextTier}) | ${cells.join(" | ")} |`);
}

lines.push("");
lines.push("## Section costs — Co-browse (the heaviest mode), by turn shape");
lines.push("");
for (const [name, run] of turnShapes) {
  const d = run(BUILTIN_MODES.cobrowse);
  const total = d.sections.reduce((a, s) => a + est(s.text), 0);
  lines.push("");
  lines.push(`### ${name} — ~${d.approxTokens} tokens total`);
  lines.push("");
  lines.push("| Section | ~tokens | % of prompt |");
  lines.push("|---|---:|---:|");
  for (const s of d.sections) {
    const t = est(s.text);
    lines.push(`| ${s.id}${s.meta ? ` (${s.meta})` : ""} | ${t} | ${Math.round((t / total) * 100)}% |`);
  }
}

lines.push("");
lines.push("## Findings (2026-08-30)");
lines.push("");
lines.push("1. **Tier-0 duplication — FIXED in #70** (same milestone): Lean/read turns carried two overlapping not-attached disclaimers (~120 tokens).");
lines.push("2. **`system` + `tail` dominate light turns** — on tier-0 turns, ~90% of tokens are systemPrompt + instructions/tail. Cross-mode instruction overlap is the next audit target: persona, mode systemPrompt, and mode instructions each restate the no-submit/no-secrets rules (#26). Consolidating into ONE shared rule block (referenced, not repeated) is the top candidate — requires an evals refresh per touched prompt.");
lines.push("3. **`elements` + `forms` scale with page complexity** — already capped (50 els / 30 forms) and tier-gated; the caps look right. `read_page`/`get_dom` pulls bypass budgets by design (user asked).");
lines.push("4. **Tabs/skills/files sections are cheap** (tens of tokens each) and send-once-thinned — no action.");
lines.push("5. **Screenshot sections embed base64** — billed by Zo's backend as image tokens, not text; our `approxTokens` (chars/4) massively OVERSTATES them — flagged here so the table isn't misread (visual mode totals include the fixture data URL).");
lines.push("");
lines.push("## Discipline");
lines.push("");
lines.push("Any trim lands with before/after totals from this table + a `bun run evals:live` refresh (case ids stable). No intuition-driven rewording.");
lines.push("");

console.log(lines.join("\n"));
mkdirSync(new URL("../../docs/qa/", import.meta.url), { recursive: true });
writeFileSync(new URL("../../docs/qa/prompt-bloat-audit.md", import.meta.url), lines.join("\n"));
console.error("\n→ wrote docs/qa/prompt-bloat-audit.md");
