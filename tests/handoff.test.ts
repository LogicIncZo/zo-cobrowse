import { describe, it, expect } from "bun:test";
import {
  DEFAULT_BUDGET,
  isSubmitish,
  checkBoundary,
  createRun,
  transition,
  tally,
  recordVisit,
  park,
  withinBudget,
  handoffInstructions,
  buildContinuationTurn,
  continuationPayload,
  SEND_ONCE_FIELDS,
  runProgress,
} from "../extension/lib/handoff.js";
import {
  HandoffRun,
  HandoffTransitionResult,
  BoundaryDecision,
  HandoffStatus,
} from "./schemas/handoff";

const NOW = 1788048000000; // fixed clock — 2026-08-30 UTC
const mkRun = (over: Record<string, unknown> = {}) =>
  createRun({ chatId: "chat-1", goal: "Compare the 5 product tabs", now: NOW, runId: "run-test", ...over });

describe("handoff — createRun", () => {
  it("creates a priming run matching the schema", () => {
    const run = mkRun();
    expect(run.status).toBe("priming");
    expect(run.boundaryMode).toBe("readonly");
    expect(run.budget).toEqual(DEFAULT_BUDGET);
    expect(() => HandoffRun.parse(run)).not.toThrow();
  });

  it("accepts budget overrides and no-submit mode", () => {
    const run = mkRun({ boundaryMode: "no-submit", budget: { maxTurns: 4 } });
    expect(run.budget).toEqual({ ...DEFAULT_BUDGET, maxTurns: 4 });
    expect(() => HandoffRun.parse(run)).not.toThrow();
  });
});

describe("handoff — transition", () => {
  it("priming → running → done is the happy path", () => {
    let r = mkRun();
    let res = transition(r, "start", { now: NOW });
    expect(() => HandoffTransitionResult.parse(res)).not.toThrow();
    expect(res.ok).toBe(true);
    r = (res as any).run;
    expect(r.status).toBe("running");
    res = transition(r, "complete", { now: NOW, reason: "digest delivered" });
    r = (res as any).run;
    expect(r.status).toBe("done");
    expect(r.stopReason).toBe("digest delivered");
    expect(() => HandoffRun.parse(r)).not.toThrow();
  });

  it("priming is pausable (#165) — a stranded priming run can pause + resume", () => {
    let r = mkRun();
    const res = transition(r, "pause", { now: NOW, reason: "streaming unavailable" });
    expect(res.ok).toBe(true);
    r = (res as any).run;
    expect(r.status).toBe("paused");
    expect(r.stopReason).toBe("streaming unavailable");
    r = (transition(r, "resume", { now: NOW }) as any).run;
    expect(r.status).toBe("running");
    expect(() => HandoffRun.parse(r)).not.toThrow();
  });

  it("pause/resume round-trips; block records the reason", () => {
    let r = mkRun();
    r = (transition(r, "start", { now: NOW }) as any).run;
    r = (transition(r, "pause", { now: NOW }) as any).run;
    expect(r.status).toBe("paused");
    r = (transition(r, "resume", { now: NOW }) as any).run;
    expect(r.status).toBe("running");
    r = (transition(r, "block", { now: NOW, reason: "checkout reached" }) as any).run;
    expect(r.status).toBe("blocked");
    expect(r.stopReason).toBe("checkout reached");
  });

  it("abort works from any live state; done/aborted are terminal", () => {
    let r = mkRun();
    expect(transition(r, "abort", { now: NOW }).ok).toBe(true); // abort from priming
    r = mkRun();
    r = (transition(r, "start", { now: NOW }) as any).run;
    r = (transition(r, "complete", { now: NOW }) as any).run;
    expect(transition(r, "start", { now: NOW }).ok).toBe(false);
    expect(transition(r, "abort", { now: NOW }).ok).toBe(false);
  });

  it("invalid transitions report an error and return the run unchanged", () => {
    const r = mkRun();
    const res = transition(r, "complete", { now: NOW }); // complete from priming
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("cannot complete");
      expect(res.run.status).toBe("priming");
    }
    expect(() => HandoffTransitionResult.parse(res)).not.toThrow();
  });

  it("every status value in the schema is reachable via transitions", () => {
    const seen = new Set<string>(["priming"]);
    let r = mkRun();
    for (const ev of ["start", "block", "resume", "pause", "resume", "complete"] as const) {
      const res = transition(r, ev, { now: NOW });
      expect(res.ok).toBe(true);
      r = (res as any).run;
      seen.add(r.status);
    }
    let a = mkRun();
    a = (transition(a, "start", { now: NOW }) as any).run;
    a = (transition(a, "abort", { now: NOW }) as any).run;
    seen.add(a.status);
    for (const s of HandoffStatus.options) expect(seen.has(s)).toBe(true);
  });
});

describe("handoff — budget", () => {
  it("passes on a fresh run and fails once turns run out", () => {
    let r = mkRun({ budget: { maxTurns: 2 } });
    expect(withinBudget(r, NOW).ok).toBe(true);
    r = tally(r, { turns: 2 });
    const verdict = withinBudget(r, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("turn budget");
  });

  it("navigation budget fails independently", () => {
    let r = mkRun({ budget: { maxNavigations: 3 } });
    r = tally(r, { navigations: 3 });
    const verdict = withinBudget(r, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("navigation budget");
  });

  it("time budget uses minutes elapsed from startedAt", () => {
    const r = mkRun({ budget: { maxMinutes: 10 } });
    expect(withinBudget(r, NOW + 9 * 60000).ok).toBe(true);
    const verdict = withinBudget(r, NOW + 11 * 60000);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("time budget");
  });
});

describe("handoff — boundary", () => {
  it("readonly allows the read-only action set", () => {
    for (const type of ["navigate", "extract", "scroll", "wait", "done", "read_tab", "read_page", "get_dom", "get_form"]) {
      const d = checkBoundary({ type }, "readonly");
      expect(() => BoundaryDecision.parse(d)).not.toThrow();
      expect(d.allowed).toBe(true);
    }
  });

  it("readonly blocks interactive actions with an honest reason", () => {
    for (const type of ["click", "fill"]) {
      const d = checkBoundary({ type, selector: "#x" }, "readonly");
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain("READ-ONLY");
    }
  });

  it("no-submit mode parks submit-ish clicks but allows ordinary fills", () => {
    expect(checkBoundary({ type: "click", selector: "#checkout-btn", text: "Place order" }, "no-submit").allowed).toBe(false);
    expect(checkBoundary({ type: "click", selector: "button[type=submit]" }, "no-submit").allowed).toBe(false);
    expect(checkBoundary({ type: "click", selector: ".nav-link", text: "Pricing" }, "no-submit").allowed).toBe(true);
    expect(checkBoundary({ type: "fill", selector: "#name", value: "Ada" }, "no-submit").allowed).toBe(true);
  });

  it("isSubmitish matches selector and text hints", () => {
    expect(isSubmitish({ selector: "button[type=submit]" })).toBe(true);
    expect(isSubmitish({ selector: "#pay-now", text: "" })).toBe(true);
    expect(isSubmitish({ selector: "a", text: "Sign in" })).toBe(true);
    expect(isSubmitish({ selector: "a", text: "Product details" })).toBe(false);
    expect(isSubmitish({})).toBe(false);
  });
});

describe("handoff — tally / recordVisit / park", () => {
  it("tally bumps counters without mutating the input", () => {
    const r = mkRun();
    const r2 = tally(r, { turns: 1, navigations: 2 });
    expect(r.usage.turns).toBe(0);
    expect(r2.usage.turns).toBe(1);
    expect(r2.usage.navigations).toBe(2);
    expect(() => HandoffRun.parse(r2)).not.toThrow();
  });

  it("recordVisit dedupes consecutive repeats and caps the log", () => {
    let r = mkRun();
    r = recordVisit(r, "https://a.example");
    r = recordVisit(r, "https://a.example"); // repeat — dropped
    r = recordVisit(r, "https://b.example");
    expect(r.pagesVisited).toEqual(["https://a.example", "https://b.example"]);
    for (let i = 0; i < 120; i++) r = recordVisit(r, `https://p/${i}`);
    expect(r.pagesVisited.length).toBe(100);
  });

  it("park appends boundary entries, capped, schema-valid", () => {
    let r = mkRun();
    r = park(r, { type: "click", selector: "#submit-btn" }, "no-submit handoff", "https://shop.example/checkout");
    expect(r.parkLog).toHaveLength(1);
    expect(r.parkLog[0].action.type).toBe("click");
    expect(() => HandoffRun.parse(r)).not.toThrow();
    for (let i = 0; i < 60; i++) r = park(r, { type: "click", selector: `#s${i}` }, "x");
    expect(r.parkLog.length).toBe(50);
  });
});

describe("handoff — prompt assembly", () => {
  it("readonly instructions carry the unattended contract + stable marker", () => {
    const text = handoffInstructions(mkRun());
    expect(text).toContain("## Handoff Run");
    expect(text).toContain("handoff-run");
    expect(text).toContain("READ-ONLY");
    expect(text).toContain("Compare the 5 product tabs");
  });

  it("no-submit instructions teach the park rule instead", () => {
    const text = handoffInstructions(mkRun({ boundaryMode: "no-submit" }));
    expect(text).toContain("NEVER click terminal actions");
    expect(text).not.toContain("READ-ONLY");
  });

  it("continuation turn reports progress + budget, and orders a stop when exhausted", () => {
    let r = tally(mkRun(), { turns: 3, navigations: 7 });
    r = recordVisit(r, "https://c.example");
    r = park(r, { type: "click", selector: "#s" }, "no-submit handoff");
    const text = buildContinuationTurn(r, { now: NOW });
    expect(text).toContain("[handoff-run continuation]");
    expect(text).toContain("Pages visited: 1");
    expect(text).toContain("Parked for the user: 1");
    expect(text).toContain(`${DEFAULT_BUDGET.maxTurns - 3} turns`);

    const exhausted = tally(r, { turns: DEFAULT_BUDGET.maxTurns });
    const stop = buildContinuationTurn(exhausted, { now: NOW });
    expect(stop).toContain("Budget reached");
    expect(stop).toContain("call done() now");
  });
});

describe("handoff — runProgress", () => {
  it("renders a compact status line", () => {
    let r = transition(mkRun(), "start", { now: NOW }) as any;
    r = r.run;
    r = tally(r, { turns: 2 });
    r = recordVisit(r, "https://a.example");
    const line = runProgress(r, NOW + 5 * 60000);
    expect(line).toContain("working");
    expect(line).toContain("1 pages");
    expect(line).toContain("2/12 turns");
    expect(line).toContain("5m");
  });
});

// #159: a continuation is a progress report + continue prompt — turn 1's
// send-once attachments must not ride along (replaying them re-runs picked
// skills and re-bills stale tab excerpts).
describe("continuationPayload — send-once attachments never replay", () => {
  const turn1Msg = {
    type: 'ASK_ZO',
    chatId: 'conv-1',
    modeId: 'cobrowse',
    effectiveTier: 2,
    userQuery: 'watch the deploy',
    sessionId: '900',
    // send-once by contract:
    skills: [{ name: 'thread-summarizer' }],
    workspaceFiles: [{ path: '/home/workspace/notes.md' }],
    tabContexts: [{ ref: 'T1', url: 'https://other.example', title: 'Other' }],
    shotOnly: true,
    // thread/identity fields that MUST survive:
    conversationId: 'con_abc',
    modelName: 'byok:test',
  };

  it("strips exactly the send-once fields and re-stamps the turn's own", () => {
    const out = continuationPayload(turn1Msg, {
      sessionId: '900-h2-123',
      conversationId: 'con_abc',
      userQuery: '[handoff-run continuation] …',
      pageContext: { url: 'https://pinned.example' },
      runId: 'run-1',
    });
    for (const f of SEND_ONCE_FIELDS) expect(out[f]).toBeUndefined();
    // identity survives — the continuation stays on the same Mode/tier/chat
    expect(out.chatId).toBe('conv-1');
    expect(out.modeId).toBe('cobrowse');
    expect(out.effectiveTier).toBe(2);
    expect(out.modelName).toBe('byok:test');
    expect(out.sessionId).toBe('900-h2-123');
    expect(out.conversationId).toBe('con_abc');
    expect(out.userQuery).toContain('[handoff-run continuation]');
    expect(out.pageContext).toEqual({ url: 'https://pinned.example' });
    expect(out.handoffRunId).toBe('run-1');
    // the source message is untouched (pure)
    expect(turn1Msg.skills).toHaveLength(1);
    expect(turn1Msg.shotOnly).toBe(true);
  });

  it("tolerates an empty message", () => {
    const out = continuationPayload(undefined, { sessionId: 's', runId: 'r' });
    expect(out.sessionId).toBe('s');
    expect(out.handoffRunId).toBe('r');
    expect(SEND_ONCE_FIELDS.every((f) => out[f] === undefined)).toBe(true);
  });
});
