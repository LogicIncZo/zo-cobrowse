import { describe, it, expect } from "bun:test";
import { CASES, parseForKind } from "../scripts/prompt-evals/cases.ts";
import {
  noClickAfterFill,
  writeAssistTagProtocol,
  writeAssistPlain,
  noNewNumbers,
  maxChars,
  validActionEnvelope,
} from "../scripts/prompt-evals/checkers.ts";
import type { EvalOutput } from "../scripts/prompt-evals/checkers.ts";

// Smoke coverage for the prompt-evals harness itself: the catalog stays
// well-formed and the deterministic checkers behave on synthetic outputs.
// The live/offline scoring runs via `bun run evals` / `evals:live`.

describe("prompt-evals catalog", () => {
  it("covers every prompt surface the extension can send", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // unique ids
    for (const kind of ["cobrowse-click", "cobrowse-readonly", "ask-topic", "summarize-brief", "extract-table", "research-claims", "visual-describe", "lean-pointer"]) {
      expect(ids).toContain(kind); // all 5 builtin modes represented (summarize/research merged into ask)
    }
    expect(ids).toContain("wa-plain-textarea"); // write-assist
    expect(ids).toContain("generate-mode"); // Mode generator
    expect(ids).toContain("run-skill"); // utility prompts
    expect(ids).toContain("create-automation");
  });

  it("every case builds a non-empty prompt and has checks", () => {
    for (const c of CASES) {
      const input = c.build();
      expect(input.length, c.id + " built an empty prompt").toBeGreaterThan(20);
      expect(c.checks.length, c.id + " has no checks").toBeGreaterThan(0);
      expect(typeof c.live).toBe("boolean");
    }
  });

  it("side-effectful prompts are marked live:false", () => {
    for (const c of CASES) {
      if (c.id === "create-automation" || c.id === "run-skill") {
        expect(c.live, c.id + " must never be sent live").toBe(false);
      }
    }
  });

  it("parses kinds correctly", () => {
    const env = parseForKind("mode", '{"actions":[{"type":"done","response":"ok"}]}');
    expect(env.parsed.actions).toHaveLength(1);
    const wa = parseForKind("write-assist", "warm-up\n<write-assist>final</write-assist>");
    expect(wa.text).toBe("final");
    const json = parseForKind("json", '```json\n{"name":"X"}\n```');
    expect(json.parsed.name).toBe("X");
  });
});

const mk = (over: Partial<EvalOutput>): EvalOutput => ({
  input: "",
  raw: "",
  parsed: undefined,
  text: "",
  ...over,
});

describe("prompt-evals checkers", () => {
  it("noClickAfterFill encodes the user rule", () => {
    const badActions = [
      { type: "fill", selector: "#email", value: "x" },
      { type: "click", selector: "button[type=submit]" },
    ];
    const r = noClickAfterFill()(mk({ parsed: { actions: badActions } }));
    expect(r.pass).toBe(false);
    const good = noClickAfterFill()(mk({ parsed: { actions: [{ type: "fill", selector: "#e", value: "x" }, { type: "done", response: "ok" }] } }));
    expect(good.pass).toBe(true);
  });

  it("validActionEnvelope validates against the Zod protocol", () => {
    const good = validActionEnvelope()(mk({ parsed: { actions: [{ type: "done", response: "ok" }] } }));
    expect(good.pass).toBe(true);
    const bad = validActionEnvelope()(mk({ parsed: { actions: [{ type: "warp" }] } }));
    expect(bad.pass).toBe(false);
  });

  it("writeAssistTagProtocol demands tags and nothing outside", () => {
    const good = writeAssistTagProtocol()(mk({ raw: "<write-assist>text here</write-assist>", text: "text here" }));
    expect(good.pass).toBe(true);
    const narrated = writeAssistTagProtocol()(mk({
      raw: "Let me think...\n<write-assist>text here</write-assist>\nDone.",
      text: "text here",
    }));
    expect(narrated.pass).toBe(false);
  });

  it("writeAssistPlain rejects markdown structures", () => {
    const r = writeAssistPlain()(mk({ text: "Led the team.\n- bullet one\n- bullet two" }));
    expect(r.pass).toBe(false);
    const ok2 = writeAssistPlain()(mk({ text: "Led the migration of dashboards and trained the team on the new setup." }));
    expect(ok2.pass).toBe(true);
  });

  it("noNewNumbers catches invented multi-digit facts", () => {
    const src = "I led the migration of 40 dashboards to DuckDB";
    const invented = noNewNumbers(src)(mk({ text: "I led a migration of 40 dashboards in 2024 and saved 500 hours." }));
    expect(invented.pass).toBe(false);
    const honest = noNewNumbers(src)(mk({ text: "I led the migration of 40 dashboards and trained the team on the new setup." }));
    expect(honest.pass).toBe(true);
  });

  it("maxChars enforces the field limit", () => {
    expect(maxChars(10)(mk({ text: "12345" })).pass).toBe(true);
    expect(maxChars(10)(mk({ text: "1234567890ABC" })).pass).toBe(false);
  });
});
