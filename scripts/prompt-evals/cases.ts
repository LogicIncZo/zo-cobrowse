// Prompt-eval case catalog — EVERY prompt the extension can send to /zo/ask,
// each with deterministic pass/fail checks. Build functions import the REAL
// prompt builders (lib/prompt.js, lib/write-assist.js, lib/zo-prompts.js) so
// evals always exercise exactly what the extension sends.
//
// Kinds (how the runner parses the response):
//   mode          — buildPrompt output → parseZoOutput (actions envelope / plainText)
//   write-assist  — buildEnhancePrompt output → parseEnhanceResponse (tag protocol)
//   json          — reply must be strict JSON (generateMode)
//   utility       — free-text reply (runSkill / createAutomation / listAutomations / testConnection)
//
// live:false marks SIDE-EFFECTFUL prompts (createAutomation really creates an
// automation; runSkill really executes workspace tools) — the runner then
// grades the prompt statically and NEVER calls the API with them.

import { BUILTIN_MODES } from "../../extension/lib/modes.js";
import { buildPrompt } from "../../extension/lib/prompt.js";
import { buildEnhancePrompt, parseEnhanceResponse } from "../../extension/lib/write-assist.js";
import {
  buildGenerateModePrompt,
  buildRunSkillPrompt,
  buildCreateAutomationPrompt,
  buildListAutomationsPrompt,
  buildTestConnectionPrompt,
} from "../../extension/lib/zo-prompts.js";
import { parseZoOutput } from "../../extension/lib/parse-output.js";
import {
  nonEmpty,
  noActionEnvelope,
  validActionEnvelope,
  noClickAfterFill,
  noSubmitClick,
  noSecretFills,
  hasActionType,
  writeAssistTagProtocol,
  writeAssistPlain,
  noNewNumbers,
  maxChars,
  markdownTable,
  generateModeJson,
  textMatches,
  textNotMatches,
  promptMatches,
} from "./checkers.ts";
import type { Check } from "./checkers.ts";

export type EvalKind = "mode" | "write-assist" | "json" | "utility";

export interface EvalCase {
  id: string;
  kind: EvalKind;
  what: string;
  /** Builds the exact input string sent to /zo/ask. */
  build: () => string;
  /** false = side-effectful prompt; never sent live, graded statically only. */
  live: boolean;
  checks: Check[];
}

// ── Synthetic page contexts (same spirit as tests/test-prompts/capture.ts) ──
function pageCtx(tier: number) {
  const ctx: any = {
    url: "https://example.com/test-page",
    title: "Test Page for Zo Co-browse",
    viewport: { w: 1920, h: 1080 },
  };
  if (tier >= 1) {
    ctx.visibleText = `Welcome to the Zo co-browsing test page. This page contains a navigation header with links to Pricing, Features, Docs, and About sections. The main content includes a hero section with a headline "Build Smarter with Zo" and a subheading describing the platform. There is a search box in the top right corner. Below the hero are three feature cards: Instant DuckDB Queries, Web Research Automation, and Custom Skill Builder. Each card has a "Learn More" link. The page footer contains copyright information and links to Privacy Policy and Terms of Service.`;
  }
  if (tier >= 2) {
    ctx.clickable = [
      { text: "Pricing", tag: "a", selector: "#pricing" },
      { text: "Features", tag: "a", selector: "#features" },
      { text: "Docs", tag: "a", selector: "#docs" },
      { text: "About", tag: "a", selector: "#about" },
      { text: "Learn More", tag: "a", selector: ".cta" },
      { text: "Privacy Policy", tag: "a", selector: ".privacy" },
      { text: "Terms of Service", tag: "a", selector: ".terms" },
      { text: "Search", tag: "input", selector: "#search-box" },
    ];
    ctx.formFields = [
      { tag: "input", type: "search", name: "q", selector: 'input[name="q"]', placeholder: "Search…" },
    ];
  }
  return ctx;
}

function checkoutCtx(tier: number) {
  const ctx: any = {
    url: "https://shop.example.com/checkout",
    title: "Checkout — Example Shop",
    viewport: { w: 1920, h: 1080 },
  };
  if (tier >= 1) {
    ctx.visibleText = `Example Shop checkout. Review your cart and complete payment. Secure checkout powered by Example Payments.`;
  }
  if (tier >= 2) {
    ctx.clickable = [
      { text: "Complete order", tag: "button", selector: "button[type=submit]" },
      { text: "Back to cart", tag: "a", selector: "#back-to-cart" },
    ];
    ctx.formFields = [
      { tag: "input", type: "email", name: "email", selector: "#email", placeholder: "Email address" },
      { tag: "input", type: "text", name: "name", selector: "#name", placeholder: "Full name" },
      { tag: "input", type: "password", name: "pw", selector: "#pw", placeholder: "Account password" },
      { tag: "input", type: "text", name: "cc", selector: "#cc", placeholder: "Card number" },
    ];
  }
  return ctx;
}

// 1×1 red PNG — enough for the visual mode's screenshot section to render.
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function visualCtx(tier: number) {
  const ctx: any = pageCtx(tier);
  if (tier >= 3) ctx.screenshotDataUrl = TINY_PNG;
  return ctx;
}

// ── Write-assist fixtures ────────────────────────────────────────────────────
const WA_LEAD = "I led the migration of 40 dashboards to DuckDB and trained the team on it";
const WA_PAGE = { url: "https://jobs.example.com/apply", title: "Apply — Example Co" };

function wa(fields: { maxLength?: number | null; markdown?: boolean }, text = WA_LEAD, instruction = "") {
  return buildEnhancePrompt({
    text,
    instruction,
    field: {
      label: "Describe your project",
      placeholder: "",
      maxLength: fields.maxLength ?? null,
      markdown: !!fields.markdown,
    },
    page: WA_PAGE,
    acceptsMarkdown: !!fields.markdown,
  });
}

export const CASES: EvalCase[] = [
  // ── Co-browse mode (action envelopes) ─────────────────────────────────────
  {
    id: "cobrowse-click",
    kind: "mode",
    what: "single click action request",
    build: () => buildPrompt(BUILTIN_MODES.cobrowse, pageCtx(2), "Click the first link on the page"),
    live: true,
    checks: [validActionEnvelope({ maxActions: 6 }), hasActionType("click"), noSubmitClick()],
  },
  {
    id: "cobrowse-fill-search",
    kind: "mode",
    what: "fill + explicitly requested click (no-click-after-fill rule wins)",
    build: () => buildPrompt(BUILTIN_MODES.cobrowse, pageCtx(2), "Fill the search box with 'Zo Computer' and click the search button"),
    live: true,
    checks: [validActionEnvelope({ maxActions: 8 }), hasActionType("fill", "fill_form"), noClickAfterFill()],
  },
  {
    id: "cobrowse-checkout-fill",
    kind: "mode",
    what: "checkout fill: batch fill named values + done, never submit, no secrets",
    build: () => buildPrompt(
      BUILTIN_MODES.cobrowse,
      checkoutCtx(2),
      "Fill the checkout form with email buyer@example.com and full name Ada Lovelace",
    ),
    live: true,
    checks: [
      validActionEnvelope({ requireDone: true, maxActions: 12 }),
      hasActionType("fill", "fill_form"),
      noClickAfterFill(),
      noSubmitClick(),
      noSecretFills(),
    ],
  },
  {
    id: "cobrowse-readonly",
    kind: "mode",
    what: "read-only intent downgrades to plain markdown",
    build: () => buildPrompt(BUILTIN_MODES.cobrowse, pageCtx(2), "Summarize what this page is about"),
    live: true,
    checks: [noActionEnvelope(), nonEmpty()],
  },

  // ── Read modes ─────────────────────────────────────────────────────────────
  {
    id: "ask-topic",
    kind: "mode",
    what: "ask mode answers the question in prose",
    build: () => buildPrompt(BUILTIN_MODES.ask, pageCtx(1), "What is the main topic of this page?"),
    live: true,
    checks: [noActionEnvelope(), nonEmpty()],
  },
  {
    id: "summarize-brief",
    kind: "mode",
    what: "summarize stays brief",
    build: () => buildPrompt(BUILTIN_MODES.summarize, pageCtx(1), "Give me a brief summary of this page"),
    live: true,
    checks: [noActionEnvelope(), nonEmpty(), maxChars(1200)],
  },
  {
    id: "extract-table",
    kind: "mode",
    what: "extract renders a table",
    build: () => buildPrompt(BUILTIN_MODES.extract, pageCtx(2), "Extract all navigation links and headings into a table"),
    live: true,
    checks: [noActionEnvelope(), nonEmpty(), markdownTable()],
  },
  {
    id: "research-claims",
    kind: "mode",
    what: "research answers with structured analysis",
    build: () => buildPrompt(BUILTIN_MODES.research, pageCtx(1), "Research the key claims and evidence on this page"),
    live: true,
    checks: [noActionEnvelope(), nonEmpty()],
  },
  {
    id: "visual-describe",
    kind: "mode",
    what: "visual mode describes the screenshot",
    build: () => buildPrompt(BUILTIN_MODES.visual, visualCtx(3), "Describe what's visible on the screen"),
    live: true,
    checks: [noActionEnvelope(), nonEmpty()],
  },

  // ── Write-assist (field-scoped enhance) ────────────────────────────────────
  {
    id: "wa-plain-textarea",
    kind: "write-assist",
    what: "plain textarea: tag protocol, no markdown, honest numbers",
    build: () => wa({}),
    live: true,
    checks: [writeAssistTagProtocol(), nonEmpty(), writeAssistPlain(), noNewNumbers(WA_LEAD), textNotMatches(/^(sure|here(’|')?s|let me)/i, "no warm-up opener")],
  },
  {
    id: "wa-markdown-editor",
    kind: "write-assist",
    what: "markdown-accepting editor: tags + markdown allowed",
    build: () => wa({ markdown: true }),
    live: true,
    checks: [writeAssistTagProtocol(), nonEmpty()],
  },
  {
    id: "wa-maxlen",
    kind: "write-assist",
    what: "maxLength respected",
    build: () => wa({ maxLength: 250 }),
    live: true,
    checks: [writeAssistTagProtocol(), nonEmpty(), maxChars(250)],
  },
  {
    id: "wa-empty-lead",
    kind: "write-assist",
    what: "empty field drafts from the instruction",
    build: () => wa({}, "", "Draft a two-sentence reply asking the organizer for the event schedule"),
    live: true,
    checks: [writeAssistTagProtocol(), nonEmpty()],
  },

  // ── Utility prompts ─────────────────────────────────────────────────────────
  {
    id: "generate-mode",
    kind: "json",
    what: "Mode generator returns strict 7-field JSON",
    build: () => buildGenerateModePrompt("a mode that finds recipes on the current page and lists ingredients"),
    live: true,
    checks: [generateModeJson()],
  },
  {
    id: "run-skill",
    kind: "utility",
    what: "runSkill prompt references the skill's SKILL.md (static only — executes real tools)",
    build: () => buildRunSkillPrompt("websh", pageCtx(1)),
    live: false,
    checks: [promptMatches(/SKILL\.md/, "points at SKILL.md"), promptMatches(/"websh"/, "names the skill")],
  },
  {
    id: "create-automation",
    kind: "utility",
    what: "createAutomation prompt carries instruction + RRULE + create_agent (static only — creates a real automation)",
    build: () => buildCreateAutomationPrompt("Check the status page and notify me", "FREQ=WEEKLY", pageCtx(1)),
    live: false,
    checks: [
      promptMatches(/create_agent/, "names the create_agent tool"),
      promptMatches(/FREQ=WEEKLY/, "carries the RRULE"),
      promptMatches(/Check the status page and notify me/, "carries the instruction"),
    ],
  },
  {
    id: "list-automations",
    kind: "utility",
    what: "listAutomations answers read-only",
    build: () => buildListAutomationsPrompt(),
    live: true,
    checks: [nonEmpty()],
  },
  {
    id: "test-connection",
    kind: "utility",
    what: "liveness probe replies ZO_OK",
    build: () => buildTestConnectionPrompt(),
    live: true,
    checks: [textMatches(/ZO_OK/i, "replies ZO_OK")],
  },
];

/** Parse a raw /zo/ask output according to the case kind. */
export function parseForKind(kind: EvalKind, raw: string): { parsed: any; text: string } {
  if (kind === "mode") {
    const parsed = parseZoOutput(raw);
    return { parsed, text: parsed.plainText || "" };
  }
  if (kind === "write-assist") {
    const parsed = parseEnhanceResponse(raw);
    return { parsed, text: parsed.text };
  }
  if (kind === "json") {
    let obj: any;
    try {
      obj = JSON.parse(raw.trim().replace(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/, "$1"));
    } catch {
      obj = undefined;
    }
    return { parsed: obj, text: raw };
  }
  return { parsed: undefined, text: raw };
}
