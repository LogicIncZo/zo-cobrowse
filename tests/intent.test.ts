import { describe, it, expect } from "bun:test";
import { detectIntent, shouldDowngradeToJsonDisabled, looksLikeActionJson } from "../extension/lib/intent.js";
import { DowngradeDecisionSchema, IntentSchema } from "./schemas/intent.js";

/**
 * Pure-logic tests for the Co-browse intent downgrade.
 *
 * Co-browse is the default mode and is an action (JSON) mode: it asks Zo for
 * {actions:[...]}. But read-only intents typed into it ("Summarize", "What is
 * this page?") should answer in plain markdown. detectIntent() classifies a
 * free-text query as 'action' or 'read'; shouldDowngradeToJsonDisabled()
 * decides whether an action mode drops the JSON schema for that turn.
 */

describe("detectIntent — read-only intents (→ markdown)", () => {
  const readCases = [
    "Summarize",
    "summarize this page",
    "Summarize the pricing page", // read leader wins over later words
    "summarise the key findings",
    "TL;DR",
    "Explain what this page does",
    "Describe the layout",
    "Analyze the competitive positioning",
    "Review the terms",
    "Research the company's funding history",
    "Compare the Pro and Team plans",
    "What is this page about?",
    "What does this do",
    "Why is the button disabled",
    "Who wrote this article",
    "How does the API work",
    "Which plan includes SSO",
    "Is there a free tier",
    "Can it export to CSV",
    "Tell me about the integrations",
    "List the supported models",
    "Translate this to Spanish",
    "Define SOC2",
    // read-only triggers without a leading verb
    "give me a summary",
    "show me the overview",
    "key points please",
    // explicit question
    "pricing?",
    "does it support webhooks?",
  ];
  for (const q of readCases) {
    it(`read: "${q}"`, () => {
      expect(detectIntent(q)).toBe("read");
    });
  }
});

describe("detectIntent — action intents (→ keep JSON actions)", () => {
  const actionCases = [
    "Click the Pricing link",
    "Fill the email field with test@example.com",
    "Type hello into the search box",
    "Navigate to /dashboard",
    "Scroll down",
    "Scroll to the footer",
    "Wait 2 seconds",
    "Extract the pricing table", // explicit extract action verb
    "Select the monthly option",
    "Check the remember-me box",
    "Submit the form",
    "Download the invoice",
    "Go to the blog",
    "Open the menu",
    "Log in", // whole word; "login" also matches
    "Sign in to my account",
    "Sign up for the newsletter",
    "Search for sneakers",
    "Buy the Pro plan",
    "Add to cart",
    "Checkout",
    "Subscribe to the feed",
    "Play the video",
    "Expand the advanced settings",
    "Delete the second row",
    "Copy the API key",
    // action verb mid-sentence
    "please click the submit button",
    // ambiguous, no read-only signal → action (Co-browse is the action mode)
    "Pricing",
    "the footer",
    "menu",
  ];
  for (const q of actionCases) {
    it(`action: "${q}"`, () => {
      expect(detectIntent(q)).toBe("action");
    });
  }
});

describe("detectIntent — edge cases", () => {
  it("empty / whitespace / non-string → action (no-op caller default)", () => {
    expect(detectIntent("")).toBe("action");
    expect(detectIntent("   ")).toBe("action");
    expect(detectIntent(null as unknown as string)).toBe("action");
    expect(detectIntent(undefined as unknown as string)).toBe("action");
    expect(detectIntent(123 as unknown as string)).toBe("action");
  });

  it("whole-word matching: 'looking' is not 'login'", () => {
    // "looking" must not match the "login" action verb (substring trap).
    // No read leader, no trigger, no '?', no action verb → action default.
    expect(detectIntent("looking at the page")).toBe("action");
  });

  it("case-insensitive matching", () => {
    expect(detectIntent("SUMMARIZE")).toBe("read");
    expect(detectIntent("CLICK")).toBe("action");
    expect(detectIntent("What Is This")).toBe("read");
  });

  it("read-only leader outranks a later action verb", () => {
    // "summarize" leads → read, even though it mentions clicking.
    expect(detectIntent("summarize what happens when I click submit")).toBe("read");
    expect(detectIntent("explain how to navigate the menu")).toBe("read");
  });
});

describe("shouldDowngradeToJsonDisabled — mode gating", () => {
  const actionMode = { expectJson: true };
  const readMode = { expectJson: false };

  it("downgrades an action mode for a read-only query", () => {
    expect(shouldDowngradeToJsonDisabled(actionMode, "Summarize")).toBe(true);
    expect(shouldDowngradeToJsonDisabled(actionMode, "What is this page?")).toBe(true);
  });

  it("keeps JSON for an action mode when the query is an action", () => {
    expect(shouldDowngradeToJsonDisabled(actionMode, "Click Pricing")).toBe(false);
    expect(shouldDowngradeToJsonDisabled(actionMode, "Fill the form")).toBe(false);
  });

  it("never downgrades a plain-markdown mode (already read-only)", () => {
    // ask/summarize/research/extract/visual all have expectJson:false.
    expect(shouldDowngradeToJsonDisabled(readMode, "anything")).toBe(false);
    expect(shouldDowngradeToJsonDisabled(readMode, "click submit")).toBe(false);
  });

  it("handles a missing/null mode safely", () => {
    expect(shouldDowngradeToJsonDisabled(null, "Summarize")).toBe(false);
    expect(shouldDowngradeToJsonDisabled(undefined, "Summarize")).toBe(false);
    expect(shouldDowngradeToJsonDisabled({}, "Summarize")).toBe(false);
  });
});

describe("looksLikeActionJson — suppress raw action-JSON during streaming", () => {
  it("detects a partial action envelope streaming in", () => {
    expect(looksLikeActionJson('{"actions":')).toBe(true);
    expect(looksLikeActionJson('{"actions":[{"click":{"selector":"#x"}}')).toBe(true);
    expect(looksLikeActionJson('  {"actions" : [')).toBe(true);
  });

  it("detects a complete action envelope", () => {
    expect(looksLikeActionJson('{"actions":[{"click":{"selector":"a"}}]}')).toBe(true);
  });

  it("does not flag plain prose (even JSON-looking markdown)", () => {
    expect(looksLikeActionJson('Here is the summary.')).toBe(false);
    expect(looksLikeActionJson('The config is {"name":"zo"}')).toBe(false);
    expect(looksLikeActionJson('')).toBe(false);
    expect(looksLikeActionJson('   ')).toBe(false);
  });

  it("does not flag other JSON objects without an actions key", () => {
    expect(looksLikeActionJson('{"reasoning":"because..."}')).toBe(false);
    expect(looksLikeActionJson('{"foo":1}')).toBe(false);
  });

  it("detects a FENCED envelope (cobrowse models wrap it in ```json)", () => {
    expect(looksLikeActionJson('```json\n{"actions":[{"type":"fill"}]}\n```')).toBe(true);
    expect(looksLikeActionJson('```\n{"actions":')).toBe(true);
    expect(looksLikeActionJson('```json\n{"reasoning":"x"}\n```')).toBe(false);
  });

  it("detects the envelope from ANY accumulated-stream prefix (not just chunk 1)", () => {
    // The streaming guard tests the ACCUMULATED text; a mid-stream prefix that
    // starts mid-envelope (the old per-delta bug) must not be the test basis,
    // while an accumulated prefix starting at the envelope must still match.
    expect(looksLikeActionJson('{"actions":[{"type":"fill","selector":"#r_bk","val')).toBe(true);
    expect(looksLikeActionJson('or":"#r_bk","value":"x"}')).toBe(false); // bare delta, no envelope start
  });

  it("coerces non-string input safely", () => {
    expect(looksLikeActionJson(null as unknown as string)).toBe(false);
    expect(looksLikeActionJson(undefined as unknown as string)).toBe(false);
    expect(looksLikeActionJson(123 as unknown as string)).toBe(false);
  });
});

// ---- schema conformance: every classification must satisfy the contract ----

describe("detectIntent — schema conformance (tests/schemas/intent.ts)", () => {
  const matrix = [
    "Summarize", "What is this page?", "pricing?", "the summary",
    "Click the login button", "fill the form", "go to settings",
    "", "   ", "summarize what happens when I click submit", "?", "hello world",
  ];
  it("every detectIntent output satisfies IntentSchema", () => {
    for (const q of matrix) {
      const intent = detectIntent(q);
      const parsed = IntentSchema.safeParse(intent);
      if (!parsed.success) throw new Error(`detectIntent(${JSON.stringify(q)}) → ${intent} failed IntentSchema`);
    }
  });

  it("shouldDowngradeToJsonDisabled output satisfies DowngradeDecisionSchema", () => {
    for (const q of matrix) {
      expect(DowngradeDecisionSchema.safeParse(shouldDowngradeToJsonDisabled({ expectJson: true }, q)).success).toBe(true);
    }
  });
});
