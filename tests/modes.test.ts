import { describe, it, expect } from "bun:test";
import {
  BUILTIN_MODES,
  DEFAULT_MODE_ID,
  MERGED_MODE_IDS,
  MODE_MERGE_TARGET,
  migrateMergedModeId,
  migrateMergedOverrides,
  TIER,
  ACTION_SCHEMA_COMPACT,
  resolveMode,
  presetToMode,
  normalizeActions,
} from "../extension/lib/modes.js";
import { ModeSchema, BUILTIN_MODE_IDS, BANG_MODE_IDS } from "./schemas/modes.js";

// Helper: validate a Mode against the Zod schema; throw a readable error on drift.
function expectValid(mode: unknown) {
  const parsed = ModeSchema.safeParse(mode);
  if (!parsed.success) {
    throw new Error(
      `Mode failed schema validation:\n${JSON.stringify(mode, null, 2)}\n${parsed.error.message}`
    );
  }
  return parsed.data;
}

describe("BUILTIN_MODES — schema conformance", () => {
  it("every built-in Mode validates against ModeSchema", () => {
    for (const mode of Object.values(BUILTIN_MODES)) {
      expectValid(mode);
    }
  });

  it("the built-in set is exactly BUILTIN_MODE_IDS", () => {
    expect(Object.keys(BUILTIN_MODES).sort()).toEqual([...BUILTIN_MODE_IDS].sort());
  });

  it("every built-in is marked builtin:true", () => {
    for (const mode of Object.values(BUILTIN_MODES)) {
      expect(mode.builtin).toBe(true);
    }
  });

  it("every built-in has a non-empty systemPrompt + instructions + icon", () => {
    for (const mode of Object.values(BUILTIN_MODES)) {
      expect(mode.systemPrompt.length).toBeGreaterThan(0);
      expect(mode.instructions.length).toBeGreaterThan(0);
      expect(mode.icon.length).toBeGreaterThan(0);
    }
  });
});

describe("BUILTIN_MODES — tier invariants", () => {
  it("cobrowse is ELEMENTS tier (2) and is the ONLY mode expecting JSON actions", () => {
    expect(BUILTIN_MODES.cobrowse.contextTier).toBe(TIER.ELEMENTS);
    expect(BUILTIN_MODES.cobrowse.expectJson).toBe(true);
    // Read-only modes no longer wrap answers in the {actions} envelope —
    // they stream plain markdown (matches zo.computer's chat UI).
    expect(BUILTIN_MODES.extract.contextTier).toBe(TIER.ELEMENTS);
    expect(BUILTIN_MODES.extract.expectJson).toBe(false);
  });

  it("ask is TEXT tier (1) — the single reader Mode after the rationalization", () => {
    expect(BUILTIN_MODES.ask.contextTier).toBe(TIER.TEXT);
  });

  it("lean is POINTER tier (0) and does not expect JSON", () => {
    expect(BUILTIN_MODES.lean.contextTier).toBe(TIER.POINTER);
    expect(BUILTIN_MODES.lean.expectJson).toBe(false);
  });

  it("lean instructions contract: no content attached, self-fetch, never act, notes on request", () => {
    expect(BUILTIN_MODES.lean.instructions).toMatch(/NOT attached/i);
    expect(BUILTIN_MODES.lean.instructions).toMatch(/fetch the URL yourself/i);
    expect(BUILTIN_MODES.lean.instructions).toMatch(/Never return browser actions/i);
    expect(BUILTIN_MODES.lean.instructions).toMatch(/note/i);
  });

  it("all read-only modes (ask/extract/visual/lean) stream plain markdown", () => {
    for (const id of ["ask", "extract", "visual", "lean"]) {
      expect(BUILTIN_MODES[id].expectJson, `${id} should be plain markdown`).toBe(false);
    }
    // cobrowse drives the browser, so it alone keeps structured actions.
    expect(BUILTIN_MODES.cobrowse.expectJson).toBe(true);
  });

  it("the merged ids (summarize/research) no longer exist as built-ins", () => {
    expect(BUILTIN_MODES.summarize).toBeUndefined();
    expect(BUILTIN_MODES.research).toBeUndefined();
  });

  it("visual is SCREENSHOT tier (3) and does not expect JSON", () => {
    expect(BUILTIN_MODES.visual.contextTier).toBe(TIER.SCREENSHOT);
    expect(BUILTIN_MODES.visual.expectJson).toBe(false);
  });

  it("ask does not expect JSON (plain markdown answer)", () => {
    expect(BUILTIN_MODES.ask.expectJson).toBe(false);
  });

  it("textBudget is a positive int for every built-in", () => {
    for (const mode of Object.values(BUILTIN_MODES)) {
      expect(Number.isInteger(mode.textBudget)).toBe(true);
      expect(mode.textBudget).toBeGreaterThan(0);
    }
  });

  it("tiers are all within the 0–3 range", () => {
    for (const mode of Object.values(BUILTIN_MODES)) {
      expect(mode.contextTier).toBeGreaterThanOrEqual(TIER.POINTER);
      expect(mode.contextTier).toBeLessThanOrEqual(TIER.SCREENSHOT);
    }
  });
});

describe("ACTION_SCHEMA_COMPACT", () => {
  it("mentions every action type from the action protocol", () => {
    for (const action of ["click", "fill", "fill_form", "extract", "navigate", "scroll", "wait", "done", "read_tab", "read_page", "get_dom", "get_form"]) {
      expect(ACTION_SCHEMA_COMPACT).toContain(action);
    }
  });

  it("documents fill_form + the never-click-any-button rule", () => {
    expect(ACTION_SCHEMA_COMPACT).toContain("fill_form{values:[{target,value}]}");
    expect(ACTION_SCHEMA_COMPACT).toMatch(/question\/label\/placeholder text/);
    expect(ACTION_SCHEMA_COMPACT).toMatch(/never click ANY button/i);
    expect(ACTION_SCHEMA_COMPACT).toMatch(/done\(\)/);
    expect(ACTION_SCHEMA_COMPACT).toMatch(/password/i);
  });

  it("cobrowse instructions carry the never-click + pacing rules", () => {
    expect(BUILTIN_MODES.cobrowse.instructions).toMatch(/fill_form/);
    expect(BUILTIN_MODES.cobrowse.instructions).toMatch(/visible section/);
    expect(BUILTIN_MODES.cobrowse.instructions).toMatch(/never click ANY button/i);
    expect(BUILTIN_MODES.cobrowse.instructions).toMatch(/done\(\)/);
  });

  it("teaches the context-only pull actions (never cross-tab DOM actions)", () => {
    expect(ACTION_SCHEMA_COMPACT).toContain("read_tab{ref}");
    expect(ACTION_SCHEMA_COMPACT).toContain("read_page");
    expect(ACTION_SCHEMA_COMPACT).toContain("get_dom");
    expect(ACTION_SCHEMA_COMPACT).toContain("get_form");
    expect(ACTION_SCHEMA_COMPACT).toContain("context only");
  });

  it("is much shorter than the legacy commented JSON block (sanity)", () => {
    // The old schema block was ~600 chars / ~130 tokens. #26's fill_form +
    // sensitive-form rules legitimately grew it; the guard stays tight.
    expect(ACTION_SCHEMA_COMPACT.length).toBeLessThan(760);
  });

  it("demands ACTIONS only — not a {reasoning, actions} envelope (declubbing)", () => {
    // The old envelope asked for {"reasoning":"...","actions":[...]}, which
    // made the model club thinking + answer into one JSON blob. Now we only
    // request actions; reasoning streams separately (or not at all).
    expect(ACTION_SCHEMA_COMPACT).toContain('"actions"');
    expect(ACTION_SCHEMA_COMPACT).not.toContain('"reasoning"');
    expect(ACTION_SCHEMA_COMPACT).not.toContain('{"reasoning"');
  });

  it("is gated to expectJson:true ONLY — every non-cobrowse mode is plain markdown", () => {
    // The action-schema text must never leak into a prompt for a read-only
    // mode. buildPrompt pushes ACTION_SCHEMA_COMPACT only when mode.expectJson
    // is true; everything else gets the plain-markdown hint. Guard the
    // invariant at the source of truth: the Mode definitions.
    const jsonModes = Object.values(BUILTIN_MODES).filter((m) => m.expectJson);
    expect(jsonModes.map((m) => m.id)).toEqual(["cobrowse"]);
  });

  it("custom modes / presets default to plain markdown (no schema leak)", () => {
    // Regression guard: presetToMode / normalizeMode previously defaulted
    // expectJson to true, silently turning any custom mode into a
    // JSON-action mode and leaking "Respond with JSON {actions}".
    expect(presetToMode({ name: "custom persona" }).expectJson).toBe(false);
    expect(resolveMode("c", { c: { name: "custom" } }).expectJson).toBe(false);
  });
});

describe("DEFAULT_MODE_ID", () => {
  it("resolves to the cobrowse Mode", () => {
    expect(DEFAULT_MODE_ID).toBe("cobrowse");
    expect(BUILTIN_MODES[DEFAULT_MODE_ID]).toBeDefined();
  });
});

describe("resolveMode", () => {
  it("returns the requested built-in Mode", () => {
    const m = resolveMode("ask", {});
    expect(m.id).toBe("ask");
    expectValid(m);
  });

  it("merged ids (summarize/research) fall back to DEFAULT_MODE_ID — callers must migrate first", () => {
    // sidepanel.loadModes migrates persisted summarize/research values to
    // 'ask' on load (MERGED_MODE_IDS), so this fallback is unreachable in
    // practice; pinned here so the silent cobrowse contract-swap is visible.
    expect(resolveMode("summarize", {}).id).toBe(DEFAULT_MODE_ID);
    expect(resolveMode("research", {}).id).toBe(DEFAULT_MODE_ID);
  });

  it("migrateMergedModeId maps merged ids to Ask, passes others through", () => {
    expect(migrateMergedModeId("summarize")).toBe("ask");
    expect(migrateMergedModeId("research")).toBe("ask");
    expect(migrateMergedModeId("ask")).toBe("ask");
    expect(migrateMergedModeId("cobrowse")).toBe("cobrowse");
    expect(migrateMergedModeId("custom_1")).toBe("custom_1");
    expect(migrateMergedModeId(undefined)).toBeUndefined();
  });

  it("migrateMergedOverrides carries dead-id overrides onto ask only if empty, then drops them", () => {
    // Target empty → carry over.
    const carried = migrateMergedOverrides({ summarize: { textBudget: 999 } });
    expect(carried.changed).toBe(true);
    expect(carried.next).toEqual({ ask: { textBudget: 999 } });
    // Target occupied → target wins; dead entry still dropped.
    const kept = migrateMergedOverrides({
      summarize: { textBudget: 999 },
      ask: { textBudget: 1 },
    });
    expect(kept.changed).toBe(true);
    expect(kept.next).toEqual({ ask: { textBudget: 1 } });
    // No dead ids → untouched.
    const untouched = migrateMergedOverrides({ ask: { textBudget: 5 } });
    expect(untouched.changed).toBe(false);
    expect(untouched.next).toEqual({ ask: { textBudget: 5 } });
    // Null/garbage input → empty catalog, no change.
    expect(migrateMergedOverrides(null)).toEqual({ next: {}, changed: false });
  });

  it("does not mutate the caller's override catalog", () => {
    const original = { summarize: { textBudget: 999 }, ask: { textBudget: 1 } };
    migrateMergedOverrides(original);
    expect(original.summarize).toBeDefined();
    expect(original.ask.textBudget).toBe(1);
  });

  it("falls back to DEFAULT_MODE_ID for an unknown id", () => {
    const m = resolveMode("does-not-exist", {});
    expect(m.id).toBe(DEFAULT_MODE_ID);
  });

  it("falls back to DEFAULT_MODE_ID for a null/undefined id", () => {
    expect(resolveMode(null).id).toBe(DEFAULT_MODE_ID);
    expect(resolveMode(undefined).id).toBe(DEFAULT_MODE_ID);
    expect(resolveMode("").id).toBe(DEFAULT_MODE_ID);
  });

  it("a custom Mode overrides a built-in by id", () => {
    const custom = { ...BUILTIN_MODES.ask, name: "My Asker", builtin: false };
    const m = resolveMode("ask", { ask: custom });
    expect(m.name).toBe("My Asker");
    expect(m.builtin).toBe(false);
  });

  it("returns a fully-formed (schema-valid) Mode for a sparse custom entry", () => {
    const sparse = { systemPrompt: "custom", instructions: "do thing" };
    const m = resolveMode("custom_1", { custom_1: sparse });
    expectValid(m);
    expect(m.id).toBe("custom_1");
    expect(m.contextTier).toBe(TIER.TEXT); // backfilled default
  });
});

describe("presetToMode — legacy migration", () => {
  it("backfills tier/budget on a legacy preset that lacked them, expectJson defaults to false", () => {
    // A legacy preset that never carried expectJson must default to plain
    // markdown (expectJson:false). Defaulting to true silently leaked the
    // "Respond with JSON {actions}" instruction into prompts for read-only
    // modes, making Zo emit actions instead of prose.
    const legacy = {
      name: "Old Preset",
      description: "from the old system",
      systemPrompt: "You are Zo — ...",
      instructions: "do the thing",
    };
    const mode = presetToMode(legacy);
    expectValid(mode);
    expect(mode.builtin).toBe(false);
    expect(mode.contextTier).toBe(TIER.TEXT);
    expect(mode.textBudget).toBe(2000);
    expect(mode.expectJson).toBe(false);
    expect(mode.id).toMatch(/^custom_/);
  });

  it("preserves an explicit id if provided", () => {
    const mode = presetToMode({ id: "my_special", systemPrompt: "s", instructions: "i" });
    expect(mode.id).toBe("my_special");
  });

  it("custom modes / presets default to plain markdown (expectJson:false)", () => {
    // Regression guard for the action-schema leak: a custom mode with no
    // explicit expectJson must NOT become a JSON-action mode.
    expect(presetToMode({ name: "no json field" }).expectJson).toBe(false);
    expect(resolveMode("customX", { customX: { name: "x" } }).expectJson).toBe(false);
  });

  it("preserves an explicit contextTier / expectJson if provided", () => {
    const mode = presetToMode({
      id: "x", systemPrompt: "s", instructions: "i",
      contextTier: TIER.ELEMENTS, expectJson: true, textBudget: 999,
    });
    expect(mode.contextTier).toBe(TIER.ELEMENTS);
    expect(mode.expectJson).toBe(true);
    expect(mode.textBudget).toBe(999);
  });
});

describe("BANG_MODE_IDS — bang command targets", () => {
  it("every bang mode id exists in BUILTIN_MODES", () => {
    for (const id of BANG_MODE_IDS) {
      expect(BUILTIN_MODES[id]).toBeDefined();
    }
  });
});

describe("normalizeActions", () => {
  it("passes through type-first canonical actions", () => {
    const actions = [{ type: "click", selector: "#btn" }, { type: "fill", selector: "#inp", value: "x" }];
    expect(normalizeActions(actions)).toEqual(actions);
  });

  it("converts key-first actions to type-first", () => {
    const actions = [{ click: { selector: "#btn" } }, { fill: { selector: "#inp", value: "x" } }];
    const normalized = normalizeActions(actions);
    expect(normalized).toEqual([
      { type: "click", selector: "#btn" },
      { type: "fill", selector: "#inp", value: "x" },
    ]);
  });

  it("handles the non-spec {\"action\":\"type\"} variant (real multi-action captures)", () => {
    const actions = [{ action: "scroll", selector: "body", args: { direction: "down", amount: 200 } }];
    const normalized = normalizeActions(actions);
    expect(normalized).toEqual([{ type: "scroll", selector: "body", direction: "down", amount: 200 }]);
  });

  it("skips unknown shapes silently", () => {
    const actions = [{ foo: "bar" }, { type: "unknown" }, null];
    expect(normalizeActions(actions)).toEqual([]);
  });

  it("handles mixed known and unknown actions", () => {
    const actions = [{ click: { selector: "#a" } }, { foo: "bar" }, { type: "fill", value: "x" }];
    const normalized = normalizeActions(actions);
    expect(normalized).toEqual([{ type: "click", selector: "#a" }, { type: "fill", value: "x" }]);
  });
});

