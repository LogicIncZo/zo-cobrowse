import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import * as vm from "node:vm";

/**
 * Pure-logic tests for the zo.computer-style UI helpers added to sidepanel.js:
 *   - reasoningSummary(): collapsed-bubble header preview (Gap 3)
 *   - groupActions(): collapse consecutive identical actions (Gap 1)
 *   - formatDuration(): compact elapsed-time formatting (Gap 2)
 *
 * These are pure (no chrome.* / DOM deps) and are extracted from the real
 * sidepanel.js source via vm — same pattern as the addReasoningBubble /
 * healAssistantMessage tests. Output for groupActions is also validated
 * against the action schema's invariants by hand (the Zod ActionArray lives
 * upstream in background→sidepanel and is exercised by normalize-actions tests).
 */

const SIDEPANEL_PATH = resolve(import.meta.dir, "../extension/sidepanel.js");
const code = readFileSync(SIDEPANEL_PATH, "utf-8");

function braceEnd(src: string, start: number): number {
  let depth = 0, started = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") { depth++; started = true; }
    else if (src[i] === "}") { depth--; if (started && depth === 0) return i + 1; }
  }
  return start;
}
function extractFn(name: string): string {
  const start = code.indexOf("function " + name + "(");
  if (start === -1) throw new Error("fn not found: " + name);
  return code.slice(start, braceEnd(code, start));
}

function loadPureHelpers() {
  const sandbox: any = {};
  vm.createContext(sandbox);
  vm.runInContext(
    extractFn("safeText") + "\n" +
    extractFn("reasoningSummary") + "\n" +
    extractFn("actionKey") + "\n" +
    extractFn("groupActions") + "\n" +
    extractFn("formatDuration") + "\n" +
    extractFn("relativeTime"),
    sandbox,
  );
  return {
    reasoningSummary: sandbox.reasoningSummary as (text: any, max?: number) => string,
    groupActions: sandbox.groupActions as (actions: any[]) => any[],
    formatDuration: sandbox.formatDuration as (ms: any) => string,
    relativeTime: sandbox.relativeTime as (ts: number, now?: number) => string,
  };
}

const { reasoningSummary, groupActions, formatDuration, relativeTime } = loadPureHelpers();

// ── reasoningSummary (Gap 3: collapsed-bubble preview) ──
describe("reasoningSummary — collapsed Thought-bubble preview", () => {
  it("returns the first sentence when it fits within the budget", () => {
    const out = reasoningSummary("Inspecting site responsiveness issues. Then I'll patch breakpoints.");
    expect(out).toBe("Inspecting site responsiveness issues.");
  });

  it("truncates with an ellipsis when there is no sentence terminator", () => {
    const long = "The page failed to load with a connection refused error and there is nothing to extract from it";
    const out = reasoningSummary(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(81); // max(80) + ellipsis
  });

  it("truncates long single sentences that exceed the budget", () => {
    const out = reasoningSummary("This is an extremely long single sentence with no period until the very end of it which goes way past the eighty character budget we have set.");
    // First sentence is too long (> max) → falls to the truncate branch.
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(81);
  });

  it("strips markdown structural markers so the preview reads as prose", () => {
    const out = reasoningSummary("## Inspecting the page\n\n- list item\n\n**bold** `code` here.");
    expect(out).not.toContain("#");
    expect(out).not.toContain("`");
    expect(out).not.toContain("*");
    expect(out).toContain("Inspecting");
  });

  it("reduces a markdown link to its text", () => {
    const out = reasoningSummary("See [the docs](https://example.com) for details. More here.");
    expect(out).toBe("See the docs for details.");
  });

  it("collapses internal whitespace/newlines to single spaces", () => {
    const out = reasoningSummary("First line.\n\n\n   Second sentence after big gaps.");
    expect(out).toBe("First line.");
  });

  it("returns '' for empty / whitespace / null / undefined (no-op guard)", () => {
    expect(reasoningSummary("")).toBe("");
    expect(reasoningSummary("   \n\t ")).toBe("");
    expect(reasoningSummary(null)).toBe("");
    expect(reasoningSummary(undefined)).toBe("");
  });

  it("coerces non-string input via safeText (objects → JSON string)", () => {
    // safeText({foo:1}) → '{"foo":1}'; no sentence terminator → truncated.
    const out = reasoningSummary({ foo: 1 });
    expect(typeof out).toBe("string");
    expect(out).toContain("foo");
  });

  it("respects a custom max budget", () => {
    const out = reasoningSummary("A short sentence that fits.", 10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(11);
  });
});

// ── groupActions (Gap 1: collapse consecutive repeats) ──
describe("groupActions — consecutive-repeat collapsing", () => {
  it("returns [] for non-array input", () => {
    expect(groupActions(undefined)).toEqual([]);
    expect(groupActions(null)).toEqual([]);
    expect(groupActions("nope")).toEqual([]);
  });

  it("leaves a single action as one group of count 1", () => {
    const a = { type: "click", selector: "#x" };
    const out = groupActions([a]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ action: a, count: 1, indices: [0] });
  });

  it("collapses consecutive identical actions into one group", () => {
    const click = { type: "click", selector: "#go" };
    const out = groupActions([click, click, click]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].indices).toEqual([0, 1, 2]);
    expect(out[0].action).toBe(click);
  });

  it("keeps non-consecutive duplicates as separate groups", () => {
    const click = { type: "click", selector: "#a" };
    const fill = { type: "fill", selector: "#b", value: "x" };
    const out = groupActions([click, fill, click]);
    expect(out).toHaveLength(3);
    expect(out.map((g) => g.count)).toEqual([1, 1, 1]);
    expect(out.map((g) => g.indices)).toEqual([[0], [1], [2]]);
  });

  it("distinguishes actions by all key fields, not just type", () => {
    // Same type, different selector → separate groups.
    const out = groupActions([
      { type: "click", selector: "#a" },
      { type: "click", selector: "#b" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("distinguishes fill actions by value", () => {
    const out = groupActions([
      { type: "fill", selector: "#q", value: "hello" },
      { type: "fill", selector: "#q", value: "world" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("produces indices that cover every input action exactly once", () => {
    const actions = [
      { type: "scroll", direction: "down" },
      { type: "scroll", direction: "down" },
      { type: "click", selector: "#x" },
      { type: "wait", ms: 100 },
      { type: "wait", ms: 100 },
      { type: "wait", ms: 100 },
    ];
    const out = groupActions(actions);
    const allIndices = out.flatMap((g) => g.indices);
    expect(allIndices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(allIndices).toHaveLength(actions.length);
    // Three groups: scroll×2, click×1, wait×3
    expect(out.map((g) => g.count)).toEqual([2, 1, 3]);
  });

  it("does not mutate the input array", () => {
    const input = [{ type: "click", selector: "#a" }, { type: "click", selector: "#a" }];
    const snapshot = JSON.parse(JSON.stringify(input));
    groupActions(input);
    expect(input).toEqual(snapshot);
  });
});

// ── formatDuration (Gap 2: elapsed-time summary) ──
describe("formatDuration — compact elapsed-time formatting", () => {
  it("returns '' for non-finite / negative / invalid input", () => {
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(NaN)).toBe("");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration("abc")).toBe("");
  });

  it("returns '<1s' for sub-second durations", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(499)).toBe("<1s");
  });

  it("returns whole seconds under a minute", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(42000)).toBe("42s");
    // 59999ms rounds to 60s, which crosses into minute formatting (1m).
    expect(formatDuration(59999)).toBe("1m");
  });

  it("returns 'm s' format for minutes with remainder seconds", () => {
    expect(formatDuration(297000)).toBe("4m 57s"); // 4m 57s — the zo.computer value
    expect(formatDuration(90000)).toBe("1m 30s");
  });

  it("returns plain 'm' for whole minutes (no trailing 0s)", () => {
    expect(formatDuration(120000)).toBe("2m");
    expect(formatDuration(600000)).toBe("10m");
  });
});

// ── Zo tool-trace card parity (Phase 4) ──
// The cobrowse action timeline is re-skinned as a Zo-style collapsible
// tool-trace card ("Performed N actions · <duration>"). These guard the
// structural + label changes against regressions.
describe("action tool-trace card — Zo parity", () => {
  const sidepanel = readFileSync(SIDEPANEL_PATH, "utf-8");
  const cssPath = resolve(import.meta.dir, "../extension/styles.css");
  const css = readFileSync(cssPath, "utf-8");

  it("uses Zo vocabulary for the run header (Performed …, not Worked)", () => {
    expect(sidepanel).toContain("Performed actions");
    expect(sidepanel).toContain("Performing actions…");
    // The old "Worked" wording is gone.
    expect(sidepanel).not.toContain("⚡ Worked");
    expect(sidepanel).not.toContain("⚡ Working");
  });

  it("the run block is capped + centered on the same rail as messages", () => {
    const idx = css.indexOf(".msg-action-run");
    const braceStart = css.indexOf("{", idx);
    const braceEnd = css.indexOf("}", braceStart);
    const block = css.slice(braceStart, braceEnd);
    expect(block).toContain("max-width: 768px");
    expect(block).toContain("margin-inline: auto");
  });

  it("cards + header use the Zo-neutral palette tokens", () => {
    const cardIdx = css.indexOf(".action-card {");
    const cardBlock = css.slice(cardIdx, css.indexOf("}", cardIdx) + 1);
    expect(cardBlock).toContain("var(--zo-border)");
    expect(cardBlock).toContain("var(--zo-accent)");

    const headIdx = css.indexOf(".action-run-header {");
    const headBlock = css.slice(headIdx, css.indexOf("}", headIdx) + 1);
    expect(headBlock).toContain("var(--zo-muted-foreground)");
  });
});

// ── relativeTime (Phase 5: Zo message-footer timestamp) ──
describe("relativeTime — message footer timestamp", () => {
  const NOW = 1_700_000_000_000; // fixed "now" for deterministic assertions
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY, MO = 30 * DAY, YEAR = 365 * DAY;

  it("returns 'just now' for timestamps under a minute old", () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 59_000, NOW)).toBe("just now");
  });

  it("formats minutes, hours, and days compactly (Zo style)", () => {
    expect(relativeTime(NOW - MIN, NOW)).toBe("1m");
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe("5m");
    expect(relativeTime(NOW - HOUR, NOW)).toBe("1h");
    expect(relativeTime(NOW - 5 * HOUR, NOW)).toBe("5h");
    expect(relativeTime(NOW - DAY, NOW)).toBe("1d");
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe("3d");
  });

  it("formats weeks, months, and years", () => {
    expect(relativeTime(NOW - WEEK, NOW)).toBe("1w");
    expect(relativeTime(NOW - 3 * WEEK, NOW)).toBe("3w");
    expect(relativeTime(NOW - MO, NOW)).toBe("1mo");
    expect(relativeTime(NOW - 3 * MO, NOW)).toBe("3mo");
    expect(relativeTime(NOW - YEAR, NOW)).toBe("1y");
    expect(relativeTime(NOW - 2 * YEAR, NOW)).toBe("2y");
  });

  it("returns '' for invalid / zero / future / non-number input", () => {
    expect(relativeTime(0, NOW)).toBe("");
    expect(relativeTime(-5, NOW)).toBe("");
    expect(relativeTime(NaN, NOW)).toBe("");
    expect(relativeTime(NOW + HOUR, NOW)).toBe("just now"); // future clamps to 0 → just now
    expect(relativeTime("abc" as unknown as number, NOW)).toBe("");
  });
});

// ── Message footer (Phase 5: Zo parity) CSS presence ──
describe("message footer — Zo parity", () => {
  const cssPath = resolve(import.meta.dir, "../extension/styles.css");
  const css = readFileSync(cssPath, "utf-8");
  const sidepanel = readFileSync(SIDEPANEL_PATH, "utf-8");

  it("renders a footer with Copy / mode / model / time (no feedback)", () => {
    expect(sidepanel).toContain("function addMessageFooter");
    expect(sidepanel).toContain("msg-footer-copy");
    expect(sidepanel).toContain("msg-footer-mode");
    expect(sidepanel).toContain("msg-footer-model");
    // 📷 chip marks turns whose prompt carried a page screenshot
    expect(sidepanel).toContain("msg-footer-shot");
    // Feedback icons removed - no longer present in footer
    expect(sidepanel).not.toContain("msg-footer-feedback");
  });

  it("styles the footer on neutral tokens", () => {
    const idx = css.indexOf(".msg-footer {");
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(block).toContain("var(--zo-muted-foreground)");
  });
});
