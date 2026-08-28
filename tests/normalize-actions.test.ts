import { describe, it, expect } from "bun:test";
import {
  normalizeActions,
  ACTION_TYPE_NAMES,
  isContextAction,
} from "../extension/lib/modes.js";
import { ActionArray } from "./schemas/actions.js";

/**
 * normalizeActions() converts the "key-first" action shape Zo sometimes emits
 * to the canonical "type-first" shape every consumer executes.
 *
 *   key-first (Zo variant):  { extract: { selector: 'body', attribute: 'textContent' } }
 *   type-first (canonical):  { type: 'extract', selector: 'body', attribute: 'textContent' }
 *
 * Without it, key-first actions silently drop out of `a.type === 'done'`,
 * executeActions, and the timeline, and the whole {reasoning, actions} blob
 * leaks into the chat as raw JSON (the bug these tests guard against).
 *
 * Output is validated against the canonical ActionArray Zod schema — the same
 * source of truth background.js / sidepanel.js hand to executeActions().
 */
function expectValidActions(actions: unknown) {
  const parsed = ActionArray.safeParse(actions);
  if (!parsed.success) {
    throw new Error(
      `normalizeActions output failed ActionArray schema:\n` +
      JSON.stringify(actions, null, 2) +
      `\n${parsed.error.message}`,
    );
  }
  return parsed.data;
}

describe("normalizeActions — type-first (canonical) pass-through", () => {
  it("returns [] for non-array input", () => {
    expect(normalizeActions(undefined)).toEqual([]);
    expect(normalizeActions(null)).toEqual([]);
    expect(normalizeActions({})).toEqual([]);
    expect(normalizeActions("not an array")).toEqual([]);
  });

  it("passes already-canonical type-first actions through unchanged", () => {
    const input = [
      { type: "navigate", url: "https://example.com" },
      { type: "click", selector: "#go" },
      { type: "done", response: "All done." },
    ];
    const out = normalizeActions(input);
    expect(out).toEqual(input);
    expectValidActions(out);
  });

  it("every canonical type-first action validates against the schema", () => {
    // One of each type, canonical shape.
    const canonical = [
      { type: "navigate", url: "https://example.com" },
      { type: "click", selector: "a.login" },
      { type: "fill", selector: "#q", value: "hello" },
      { type: "extract", selector: "body", attribute: "textContent" },
      { type: "scroll", direction: "down" },
      { type: "wait", ms: 500 },
      { type: "done", response: "finished" },
    ];
    expectValidActions(normalizeActions(canonical));
  });
});

describe("normalizeActions — key-first (Zo variant) → type-first", () => {
  it("converts the exact shape from the bug report (extract + done)", () => {
    // This is the literal structure the user saw rendered as raw JSON.
    const input = [
      { extract: { selector: "body", attribute: "textContent" } },
      { done: { response: "## Summary\n\nAll extracted." } },
    ];
    const out = normalizeActions(input);
    expect(out).toEqual([
      { type: "extract", selector: "body", attribute: "textContent" },
      { type: "done", response: "## Summary\n\nAll extracted." },
    ]);
    expectValidActions(out);
  });

  it("converts every action type from key-first to type-first", () => {
    const input = [
      { navigate: { url: "https://example.com" } },
      { click: { selector: "#go" } },
      { fill: { selector: "#q", value: "hi" } },
      { extract: { selector: "main" } },
      { scroll: { direction: "down", amount: 3 } },
      { wait: { ms: 200 } },
      { done: { response: "ok" } },
    ];
    const out = normalizeActions(input);
    expect(out.map((a) => a.type)).toEqual([
      "navigate", "click", "fill", "extract", "scroll", "wait", "done",
    ]);
    expectValidActions(out);
  });

  it("preserves all argument fields when unwrapping the key", () => {
    const input = [{ fill: { selector: "input.email", value: "a@b.c" } }];
    const [a] = normalizeActions(input);
    expect(a).toEqual({ type: "fill", selector: "input.email", value: "a@b.c" });
  });

  it("handles a key-first action whose value is missing (bare key)", () => {
    // { done: {} } → { type: 'done' } (response backfilled by schema as required)
    const out = normalizeActions([{ done: {} }]);
    expect(out).toEqual([{ type: "done" }]);
  });

  it("mixes key-first and type-first actions in the same payload", () => {
    const input = [
      { type: "navigate", url: "https://example.com" },
      { click: { selector: "#btn" } },
      { type: "done", response: "mixed" },
    ];
    const out = normalizeActions(input);
    expect(out).toEqual([
      { type: "navigate", url: "https://example.com" },
      { type: "click", selector: "#btn" },
      { type: "done", response: "mixed" },
    ]);
  });
});

describe("normalizeActions — robustness / non-conforming input", () => {
  it("drops null / primitive / array entries instead of throwing", () => {
    const input = [
      null,
      "click",
      42,
      [],
      { type: "done", response: "kept" },
      { notAnAction: { foo: 1 } },
    ];
    const out = normalizeActions(input);
    expect(out).toEqual([{ type: "done", response: "kept" }]);
  });

  it("drops entries whose key is not a recognized action type", () => {
    const out = normalizeActions([{ hover: { selector: "#x" } }]);
    expect(out).toEqual([]);
  });

  it("does not mutate the input array or its objects", () => {
    const input = [{ done: { response: "orig" } }];
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeActions(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });
});

describe("ACTION_TYPE_NAMES", () => {
  it("lists all eight executor action types", () => {
    expect(ACTION_TYPE_NAMES.sort()).toEqual(
      ["click", "done", "extract", "fill", "fill_form", "navigate", "scroll", "wait"],
    );
  });
});

describe("context-only pull actions (#24)", () => {
  it("survive normalization in canonical type-first form", () => {
    const out = normalizeActions([
      { type: "read_tab", ref: "T1" },
      { type: "read_page" },
      { type: "get_dom" },
      { type: "get_form" },
    ]);
    expect(out).toEqual([
      { type: "read_tab", ref: "T1" },
      { type: "read_page" },
      { type: "get_dom" },
      { type: "get_form" },
    ]);
  });

  it("survive normalization in key-first form", () => {
    const out = normalizeActions([
      { read_tab: { ref: "T2" } },
      { get_form: {} },
    ]);
    expect(out).toEqual([
      { type: "read_tab", ref: "T2" },
      { type: "get_form" },
    ]);
  });

  it("survive normalization in the singular {action:…} form", () => {
    const out = normalizeActions([{ action: "read_page" }]);
    expect(out).toEqual([{ type: "read_page" }]);
  });

  it("are recognized by isContextAction (executor filter)", () => {
    for (const type of ["read_tab", "read_page", "get_dom", "get_form"]) {
      expect(isContextAction({ type })).toBe(true);
    }
    expect(isContextAction({ type: "click" })).toBe(false);
    expect(isContextAction(null)).toBe(false);
    expect(isContextAction("read_page")).toBe(false);
  });
});
