import { describe, it, expect } from "bun:test";
import {
  buildDecideRequest,
  parseDecideResponse,
  shouldAct,
  clickChoiceQuestion,
  doneGateQuestion,
  redactStateForJev,
  DEFAULT_JEV_API_URL,
  DEFAULT_JEV_MODEL,
  MAX_CHOICE_OPTIONS,
} from "../extension/lib/jev.js";
import {
  JevDecideRequest,
  JevDecideResponse,
  JevAnswer,
  JevTestResult,
  JevRoutingDecision,
} from "./schemas/jev";

/**
 * Unit tests for extension/lib/jev.js (0.3.4 Lane J1) — the pure half of the
 * Jev integration. Every wire shape is validated against tests/schemas/jev.ts
 * (the contract captured from docs.typesafe.ai/api + the live probe).
 */

const CANDIDATES = [
  { id: "e0", label: "Go to the form page (a)" },
  { id: "e1", label: "Go to the long page (a)" },
  { id: "e2", label: "Do a thing (button)" },
];

describe("buildDecideRequest", () => {
  it("builds a schema-valid decide request with defaults", () => {
    const req = buildDecideRequest({ state: { url: "https://x" }, questions: doneGateQuestion("Buy milk") });
    expect(req.model).toBe(DEFAULT_JEV_MODEL);
    const r = JevDecideRequest.safeParse(req);
    expect(r.success).toBe(true);
  });

  it("rejects missing state and empty questions", () => {
    expect(() => buildDecideRequest({ questions: { a: { type: "noul", instructions: "x" } } })).toThrow(/state/);
    expect(() => buildDecideRequest({ state: "s", questions: {} })).toThrow(/question/);
    expect(() => buildDecideRequest({ state: "s" })).toThrow();
  });

  it("honors an explicit model pin", () => {
    expect(buildDecideRequest({ model: "jev-1.13", state: "s", questions: doneGateQuestion("g") }).model).toBe("jev-1.13");
  });
});

describe("parseDecideResponse", () => {
  it("parses the documented live shape (choice + noul) schema-clean", () => {
    const parsed = parseDecideResponse({
      model: "jev-1.13.0",
      answers: {
        target: { type: "choice", choice: "e2", probabilities: { e2: 0.88 }, confidence: 0.81 },
        goal_done: { type: "noul", noul: 0.95 },
      },
      usage: { input_tokens: 296, output_tokens: 20 },
    });
    expect(parsed.ok).toBe(true);
    const r = JevDecideResponse.safeParse({ model: parsed.model, answers: parsed.answers, usage: parsed.usage });
    expect(r.success).toBe(true);
    expect(parsed.answers.target.choice).toBe("e2");
  });

  it("never throws — malformed payloads come back as {ok:false}", () => {
    expect(parseDecideResponse(null).ok).toBe(false);
    expect(parseDecideResponse("nope" as any).ok).toBe(false);
    expect(parseDecideResponse({ error: "boom" }).ok).toBe(false);
    expect(parseDecideResponse({ answers: null }).ok).toBe(false);
    expect(parseDecideResponse({ answers: { a: { type: "noul" } } }).ok).toBe(false);
    expect(parseDecideResponse({ answers: { a: { type: "choice" } } }).ok).toBe(false);
    expect(parseDecideResponse({ answers: { a: 42 } }).ok).toBe(false);
  });

  it("score answers parse (schema union)", () => {
    const parsed = parseDecideResponse({ answers: { s: { type: "score", score: 1.05, confidence: 0.9 } } });
    expect(parsed.ok).toBe(true);
    expect(JevAnswer.safeParse(parsed.answers.s).success).toBe(true);
  });
});

describe("shouldAct — per-type confidence routing", () => {
  it("acts only at or above the threshold", () => {
    expect(shouldAct(0.9, 0.9)).toBe(true);
    expect(shouldAct(0.89, 0.9)).toBe(false);
  });

  it("is NaN-safe on both sides", () => {
    expect(shouldAct(NaN, 0.8)).toBe(false);
    expect(shouldAct(0.9, NaN)).toBe(false);
    expect(shouldAct(undefined as any, 0.8)).toBe(false);
    expect(shouldAct(0.9, undefined as any)).toBe(false);
  });

  it("routing decisions are schema-shaped", () => {
    const d = { act: shouldAct(0.97, 0.8), confidence: 0.97, threshold: 0.8, reason: "confidence ≥ threshold" };
    expect(JevRoutingDecision.safeParse(d).success).toBe(true);
  });
});

describe("question builders", () => {
  it("clickChoiceQuestion maps candidates to criteria (≤255) schema-clean", () => {
    const q = clickChoiceQuestion("Open the form page", CANDIDATES);
    expect(q.target.type).toBe("choice");
    expect(q.target.criteria.e2).toBe("Do a thing (button)");
    const req = buildDecideRequest({ state: { goal: "g" }, questions: q });
    expect(JevDecideRequest.safeParse(req).success).toBe(true);
  });

  it("clickChoiceQuestion caps at the vendor's 255-option limit and drops unlabeled candidates", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `e${i}`, label: `c${i}` }));
    const q = clickChoiceQuestion("g", many);
    expect(Object.keys(q.target.criteria).length).toBe(MAX_CHOICE_OPTIONS);
    expect(clickChoiceQuestion("g", [{ id: "a", label: "" }, { id: "b", label: "ok" }]).target.criteria).toEqual({ b: "ok" });
    expect(() => clickChoiceQuestion("g", [])).toThrow(/candidate/);
  });

  it("doneGateQuestion uses the probe-verified literal phrasing", () => {
    const q = doneGateQuestion("Make the page say the thing is done");
    expect(q.goal_done.type).toBe("noul");
    expect(q.goal_done.instructions).toContain('Make the page say the thing is done');
    expect(q.goal_done.instructions).toContain("already fully achieved");
  });
});

describe("redactStateForJev", () => {
  it("strips value-ish keys and scrubs nested objects; keeps labels and text", () => {
    const state = {
      url: "https://x/billing",
      title: "Checkout",
      fields: [{ label: "Card number", value: "4111111111111111", cvv: "123", tag: "input" }],
      pageText: "Total: $4.20",
    };
    const red = redactStateForJev(state);
    expect(red.url).toBe("https://x/billing");
    expect(red.pageText).toBe("Total: $4.20");
    expect(red.fields[0].label).toBe("Card number");
    expect(red.fields[0].value).toBeUndefined();
    expect(red.fields[0].cvv).toBeUndefined();
    expect(JSON.stringify(red)).not.toContain("4111");
    expect(JSON.stringify(red)).not.toContain("123");
  });

  it("handles arrays and primitives", () => {
    expect(redactStateForJev([{ value: "x", keep: 1 }])).toEqual([{ keep: 1 }]);
    expect(redactStateForJev("plain")).toBe("plain");
    expect(redactStateForJev(null)).toBe(null);
  });
});

describe("JEV_TEST reply shape", () => {
  it("accepts both the success and failure arms", () => {
    expect(JevTestResult.safeParse({ ok: true, latencyMs: 412, model: "jev-1.13.0", answer: { type: "noul", noul: 0.97 } }).success).toBe(true);
    expect(JevTestResult.safeParse({ ok: false, error: "Jev endpoint returned 401" }).success).toBe(true);
    expect(JevTestResult.safeParse({ ok: true }).success).toBe(false); // latencyMs required
  });

  it("exports the documented endpoint + model defaults", () => {
    expect(DEFAULT_JEV_API_URL).toBe("https://api.typesafe.ai/v1/systemone");
    expect(DEFAULT_JEV_MODEL).toBe("jev-latest");
  });
});
