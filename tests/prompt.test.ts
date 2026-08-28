import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  buildPrompt,
  describePrompt,
  estimateTokens,
  compactEl,
  compactForm,
  safeText,
  SECTION_LABELS,
} from "../extension/lib/prompt.js";
import { BUILTIN_MODES, TIER, ACTION_SCHEMA_COMPACT, PLAIN_RESPONSE_HINT } from "../extension/lib/modes.js";
import { DescribedPromptSchema } from "./schemas/prompt.js";

const promptLibCode = readFileSync(
  resolve(import.meta.dir, "../extension/lib/prompt.js"),
  "utf-8",
);

// ---- fixtures ----------------------------------------------------------------

function makeCtx(opts: Partial<{
  url: string; title: string; visibleText: string; clickable: unknown[]; formFields: unknown[]; viewport: { w: number; h: number }; screenshotDataUrl: string;
}> = {}) {
  return {
    url: opts.url ?? "https://example.com",
    title: opts.title ?? "Example",
    visibleText: opts.visibleText ?? "Hello world",
    clickable: opts.clickable ?? [],
    formFields: opts.formFields ?? [],
    viewport: opts.viewport ?? { w: 800, h: 600 },
    ...(opts.screenshotDataUrl ? { screenshotDataUrl: opts.screenshotDataUrl } : {}),
  };
}

function expectValid(described: unknown) {
  const parsed = DescribedPromptSchema.safeParse(described);
  if (!parsed.success) {
    throw new Error(
      `describePrompt failed schema validation:\n${JSON.stringify(described, null, 2)}\n${parsed.error.message}`,
    );
  }
  return parsed.data;
}

// ---- byte-exact parity with the historical background.js buildPrompt ---------

describe("buildPrompt — parity with the original assembler", () => {
  it("reproduces the exact ask-mode prompt string (join, spacing, section order)", () => {
    const mode = BUILTIN_MODES.ask; // tier 1, expectJson false
    const ctx = makeCtx({ visibleText: "Hello world" });
    const expected = [
      mode.systemPrompt,
      "",
      "## Page",
      "- URL: https://example.com",
      "- Title: Example",
      "- Viewport: 800x600",
      "",
      "## Page Content",
      "```",
      "Hello world",
      "```",
      "",
      "## User Request",
      "What is this?",
      "",
      mode.instructions,
      PLAIN_RESPONSE_HINT,
    ].join("\n");
    expect(buildPrompt(mode, ctx, "What is this?")).toBe(expected);
  });

  it("starts with the Mode systemPrompt and ends with the instruction tail", () => {
    const p = buildPrompt(BUILTIN_MODES.research, makeCtx(), "Analyze");
    expect(p.startsWith(BUILTIN_MODES.research.systemPrompt)).toBe(true);
    expect(p.endsWith(PLAIN_RESPONSE_HINT)).toBe(true);
  });
});

// ---- tier gating -------------------------------------------------------------

describe("buildPrompt — tier gating", () => {
  it("tier 0 emits URL/title/viewport only (no content/elements)", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "go", { effectiveTier: TIER.POINTER });
    expect(p).toContain("## Page");
    expect(p).not.toContain("## Page Content");
    expect(p).not.toContain("## Elements");
    expect(p).not.toContain("## Forms");
  });

  it("tier 1 adds Page Content but not elements/forms", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "go", { effectiveTier: TIER.TEXT });
    expect(p).toContain("## Page Content");
    expect(p).not.toContain("## Elements");
    expect(p).not.toContain("## Forms");
  });

  it("tier 2 adds Elements + Forms when present", () => {
    const ctx = makeCtx({
      clickable: [{ text: "Pricing", tag: "a", selector: "#pricing" }],
      formFields: [{ tag: "input", type: "text", selector: "#q", placeholder: "Search" }],
    });
    const p = buildPrompt(BUILTIN_MODES.cobrowse, ctx, "go", { effectiveTier: TIER.ELEMENTS });
    expect(p).toContain("## Elements");
    expect(p).toContain("## Forms");
  });

  it("without opts, uses mode.contextTier (cobrowse → elements)", () => {
    // cobrowse.contextTier === 2; with elements present they appear.
    const ctx = makeCtx({ clickable: [{ text: "Go", tag: "a", selector: "#go" }] });
    const p = buildPrompt(BUILTIN_MODES.cobrowse, ctx, "click go");
    expect(p).toContain("## Elements");
  });

  it("effectiveTier overrides mode.contextTier downward (read follow-up thinning)", () => {
    // cobrowse (tier 2) thinned to tier 0 for a follow-up turn.
    const ctx = makeCtx({ clickable: [{ text: "Go", tag: "a", selector: "#go" }] });
    const p = buildPrompt(BUILTIN_MODES.cobrowse, ctx, "click go", { effectiveTier: 0 });
    expect(p).not.toContain("## Elements");
    expect(p).not.toContain("## Page Content");
  });

  it("caps visibleText at mode.textBudget", () => {
    const long = "x".repeat(3000);
    const p = buildPrompt(BUILTIN_MODES.ask, makeCtx({ visibleText: long }), "q");
    // ask.textBudget === 2000 → the fenced content is exactly 2000 chars.
    const fenced = p.split("## Page Content\n```\n")[1].split("\n```")[0];
    expect(fenced.length).toBe(2000);
  });

  it("tier 3 screenshot only when screenshotDataUrl is present", () => {
    const withShot = buildPrompt(BUILTIN_MODES.visual, makeCtx({ screenshotDataUrl: "data:image/jpeg;base64,AAA" }), "describe");
    expect(withShot).toContain("## Screenshot");
    const noShot = buildPrompt(BUILTIN_MODES.visual, makeCtx(), "describe");
    expect(noShot).not.toContain("## Screenshot");
  });
});

// ---- intent downgrade (moved from background.test.ts — logic now in prompt.js)

describe("buildPrompt — intent-aware JSON/markdown downgrade", () => {
  it("prompt.js imports the downgrade classifier from intent.js", () => {
    expect(promptLibCode).toMatch(/import\s*\{[^}]*shouldDowngradeToJsonDisabled[^}]*\}\s*from\s*['"]\.\/intent\.js['"]/);
  });

  it("cobrowse action query → appends ACTION_SCHEMA_COMPACT", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Click the login button");
    expect(p).toContain(ACTION_SCHEMA_COMPACT);
  });

  it("cobrowse read query → downgrades to plain markdown (no action envelope)", () => {
    // "Summarize this page" is a read-only leader → downgrade fires even in
    // the action mode, so the answer renders as prose, not {actions:[...]}.
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Summarize this page");
    expect(p).not.toContain(ACTION_SCHEMA_COMPACT);
    expect(p).toContain(PLAIN_RESPONSE_HINT);
    expect(p).toContain("Answer the request directly using the page content provided.");
  });
});

// ---- describePrompt (structured view for the inspector / Settings editor) ----

describe("describePrompt — structured breakdown", () => {
  it("returns a schema-valid structure", () => {
    const described = describePrompt(BUILTIN_MODES.cobrowse, makeCtx({
      clickable: [{ text: "A", tag: "a", selector: "#a" }],
      formFields: [{ tag: "input", type: "text", selector: "#q", placeholder: "Search" }],
    }), "click a");
    expectValid(described);
  });

  it("prompt field equals buildPrompt output", () => {
    const mode = BUILTIN_MODES.ask;
    const ctx = makeCtx();
    expect(describePrompt(mode, ctx, "hi").prompt).toBe(buildPrompt(mode, ctx, "hi"));
  });

  it("system + tail are editable; page/content/elements/forms/screenshot/userRequest are not", () => {
    const described = describePrompt(BUILTIN_MODES.cobrowse, makeCtx({
      clickable: [{ text: "A", tag: "a", selector: "#a" }],
    }), "click a");
    const byId = Object.fromEntries(described.sections.map((s) => [s.id, s]));
    expect(byId.system.editable).toBe(true);
    expect(byId.tail.editable).toBe(true);
    expect(byId.page.editable).toBe(false);
    expect(byId.userRequest.editable).toBe(false);
  });

  it("reports intent + expectJson metadata (action turn)", () => {
    const described = describePrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Click login");
    expect(described.intent).toBe("action");
    expect(described.expectJson).toBe(true);
    expect(described.downgradeApplied).toBe(false);
  });

  it("reports downgradeApplied for a read query in an action mode", () => {
    const described = describePrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Summarize this page");
    expect(described.downgradeApplied).toBe(true);
    expect(described.expectJson).toBe(false);
  });

  it("tier field reflects the resolved effective tier", () => {
    expect(describePrompt(BUILTIN_MODES.cobrowse, makeCtx(), "q", { effectiveTier: 0 }).tier).toBe(0);
    expect(describePrompt(BUILTIN_MODES.cobrowse, makeCtx(), "q").tier).toBe(BUILTIN_MODES.cobrowse.contextTier);
  });

  it("approxTokens is a positive ~chars/4 estimate", () => {
    const described = describePrompt(BUILTIN_MODES.ask, makeCtx(), "q");
    expect(described.approxTokens).toBeGreaterThan(0);
    expect(described.approxTokens).toBe(Math.ceil(described.prompt.length / 4));
  });
});

// ---- helpers -----------------------------------------------------------------

describe("prompt helpers", () => {
  it("estimateTokens is ceil(length / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("compactEl truncates text to 40 chars and formats [tag \"text\" selector]", () => {
    const out = compactEl({ tag: "a", text: "Hello World That Is Quite Long Indeed", selector: "#nav" });
    expect(out).toBe('[a "Hello World That Is Quite Long Indeed" #nav]');
    const truncated = compactEl({ tag: "button", text: "x".repeat(60), selector: ".c" });
    expect([...truncated.matchAll(/"([^"]*)"/g)][0][1].length).toBe(40);
  });

  it("compactForm formats [tag selector type=t \"placeholder\"]", () => {
    expect(compactForm({ tag: "input", type: "text", selector: "#q", placeholder: "Search" }))
      .toBe('[input#q type=text "Search"]');
  });

  it("compactForm appends the question cue when captured (builder-form disambiguator)", () => {
    expect(compactForm({ tag: "input", type: "text", selector: "#uuid1", placeholder: "Type your answer here...", question: "Your name" }))
      .toBe('[input#uuid1 type=text "Type your answer here..."] — Your name');
  });

  it("safeText passes strings, blanks nullish, JSON-stringifies objects", () => {
    expect(safeText("hi")).toBe("hi");
    expect(safeText(null)).toBe("");
    expect(safeText(undefined)).toBe("");
    expect(safeText({ a: 1 })).toBe('{"a":1}');
    // Circular values throw during JSON.stringify → safeText returns ''.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeText(circular)).toBe("");
  });

  it("SECTION_LABELS covers every section id describePrompt can emit", () => {
    const ids = new Set(["system", "page", "tabs", "content", "elements", "forms", "screenshot", "userRequest", "tail"]);
    for (const id of ids) expect(SECTION_LABELS[id]).toBeTruthy();
  });

  it("does not throw on an empty pageContext", () => {
    expect(() => buildPrompt(BUILTIN_MODES.ask, {}, "q")).not.toThrow();
    const p = buildPrompt(BUILTIN_MODES.ask, {}, "q");
    expect(p).not.toContain("## Page\n"); // no URL to point at → no Page section
    expect(p).toContain("## Page Content"); // tier 1 → '—empty—' placeholder
  });
});

// ---- cold start: blank/new-tab pages carry no Page pointer --------------------

describe("buildPrompt — blank page (cold start)", () => {
  const newtabCtx = { url: "chrome://newtab/", title: "New Tab", viewport: { w: 1234, h: 756 } };

  it("omits the ## Page section entirely for a new/blank tab", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, newtabCtx, "find me docs on X", { effectiveTier: 0 });
    expect(p).not.toContain("## Page\n");
    expect(p).not.toContain("chrome://newtab");
    expect(p).toContain("## User Request");
    expect(p).toContain("find me docs on X");
  });

  it("omits ## Page for the about:blank family too (and when url is missing)", () => {
    for (const ctxObj of [{ url: "about:blank", title: "about:blank" }, {}]) {
      const p = buildPrompt(BUILTIN_MODES.ask, ctxObj, "q");
      expect(p).not.toContain("## Page\n");
    }
  });

  it("keeps ## Page for real pages (regression guard)", () => {
    const p = buildPrompt(BUILTIN_MODES.ask, makeCtx(), "q", { effectiveTier: 0 });
    expect(p).toContain("## Page\n- URL: https://example.com");
  });

  it("describePrompt drops the page section for blank pages (inspector parity)", () => {
    const d = describePrompt(BUILTIN_MODES.cobrowse, newtabCtx, "find me docs", { effectiveTier: 0 });
    expect(d.sections.map((s: { id: string }) => s.id)).not.toContain("page");
    expect(d.prompt).not.toContain("chrome://newtab");
  });
});

// ---- tab contexts (referenced tabs as manifest + excerpt) ---------------------

function makeTabCtx(overrides: Partial<{
  tabId: number; ref: string; title: string; url: string; host: string;
  textLength: number; elementCount: number; excerpt: string; isActive: boolean; available: boolean;
}> = {}) {
  return {
    tabId: 7,
    ref: "T1",
    title: "Pricing",
    url: "https://acme.com/pricing",
    host: "acme.com",
    textLength: 4200,
    elementCount: 33,
    excerpt: "Plans start free.",
    isActive: false,
    available: true,
    ...overrides,
  };
}

describe("buildPrompt — tab contexts", () => {
  it("omits the Referenced Tabs section entirely when no tabs are referenced (byte-parity preserved)", () => {
    const p = buildPrompt(BUILTIN_MODES.ask, makeCtx(), "q");
    expect(p).not.toContain("## Referenced Tabs");
  });

  it("emits the section between Page and Page Content with manifest line + excerpt", () => {
    const p = buildPrompt(BUILTIN_MODES.ask, makeCtx(), "q", {
      tabContexts: [makeTabCtx()],
    });
    const pageAt = p.indexOf("## Page");
    const tabsAt = p.indexOf("## Referenced Tabs");
    const contentAt = p.indexOf("## Page Content");
    expect(tabsAt).toBeGreaterThan(pageAt);
    expect(tabsAt).toBeLessThan(contentAt);
    expect(p).toContain('- [T1] "Pricing" — acme.com — ~4k chars text, 33 links — not attached');
    expect(p).toContain("> Excerpt: Plans start free.");
  });

  it("dedups the active tab when the policy attached it this turn (tier ≥ 1)", () => {
    const p = buildPrompt(BUILTIN_MODES.ask, makeCtx(), "q", {
      tabContexts: [makeTabCtx({ isActive: true })],
    });
    expect(p).toContain("(this tab, attached above)");
    expect(p).not.toContain("> Excerpt:");
  });

  it("keeps the active tab's excerpt at tier 0 (not attached)", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "go", {
      effectiveTier: TIER.POINTER,
      tabContexts: [makeTabCtx({ isActive: true })],
    });
    expect(p).toContain("> Excerpt: Plans start free.");
    expect(p).not.toContain("(this tab, attached above)");
  });

  it("degrades unavailable tabs to URL-only manifest lines", () => {
    const p = buildPrompt(BUILTIN_MODES.ask, makeCtx(), "q", {
      tabContexts: [makeTabCtx({ available: false, excerpt: "", textLength: 0, elementCount: 0 })],
    });
    expect(p).toContain("unavailable, URL only");
    expect(p).not.toContain("> Excerpt:");
  });

  it("filters junk entries without throwing", () => {
    const p = buildPrompt(BUILTIN_MODES.ask, makeCtx(), "q", {
      tabContexts: [null, "x", makeTabCtx()] as unknown as ReturnType<typeof makeTabCtx>[],
    });
    expect(p).toContain("- [T1]");
  });
});

describe("describePrompt — tab contexts in the structured view", () => {
  it("shows the tabs section with meta and feeds the token estimate", () => {
    const base = describePrompt(BUILTIN_MODES.ask, makeCtx(), "q");
    const withTabs = describePrompt(BUILTIN_MODES.ask, makeCtx(), "q", {
      tabContexts: [makeTabCtx(), makeTabCtx({ tabId: 8, ref: "T2", title: "Docs", host: "docs.acme.com", url: "https://docs.acme.com" })],
    });
    expectValid(withTabs);
    const tabs = withTabs.sections.find((s) => s.id === "tabs");
    expect(tabs).toBeDefined();
    expect(tabs!.meta).toBe("2 tabs");
    expect(withTabs.approxTokens).toBeGreaterThan(base.approxTokens);
  });

  it("never emits a tabs section without tabContexts", () => {
    const d = describePrompt(BUILTIN_MODES.ask, makeCtx(), "q");
    expect(d.sections.find((s) => s.id === "tabs")).toBeUndefined();
  });
});
