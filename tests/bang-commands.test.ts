import { describe, it, expect } from "bun:test";
import { parseBangCommand, BANG_COMMANDS } from "../extension/lib/bang-commands.js";
import { BangCommandResultSchema, type BangCommandResult } from "./schemas/bang-commands.js";

// Helper: parse + validate against the Zod schema. Throws with Zod's
// human-readable error if the shape drifts from the contract.
function parse(raw: string): BangCommandResult {
  const result = parseBangCommand(raw);
  const parsed = BangCommandResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(
      `parseBangCommand(${JSON.stringify(raw)}) returned invalid shape:\n` +
        parsed.error.message
    );
  }
  return parsed.data;
}

describe("parseBangCommand — schema conformance", () => {
  it("returns { handled: false } for non-bang input", () => {
    expect(parse("just a question")).toEqual({ handled: false, kind: "passthrough" });
    expect(parse("")).toEqual({ handled: false, kind: "passthrough" });
    expect(parse(" leading space")).toEqual({ handled: false, kind: "passthrough" });
  });

  it("!help / !commands / !? return an inline reply listing all commands", () => {
    for (const raw of ["!help", "!commands", "!?"]) {
      const r = parse(raw);
      expect(r.handled).toBe(true);
      if ("inlineReply" in r) {
        // Every registered command appears in the help text
        for (const name of Object.keys(BANG_COMMANDS)) {
          expect(r.inlineReply).toContain(`!${name}`);
        }
        expect(r.inlineReply).toContain("!save");
      }
    }
  });

  it("!save returns { isSave: true, savePath }", () => {
    expect(parse("!save")).toEqual({ handled: true, kind: "save", isSave: true, savePath: "" });
    expect(parse("!save my-note.md")).toEqual({
      handled: true,
      kind: "save",
      isSave: true,
      savePath: "my-note.md",
    });
  });
  it("!auto returns { isAuto: true, instruction } (#08)", () => {
    const r = parse("!auto every day at 9am summarize this page");
    expect(r.handled).toBe(true);
    expect(r.kind).toBe("automation");
    if (r.kind === "automation") {
      expect(r.isAuto).toBe(true);
      expect(r.instruction).toContain("every day");
    }
    // !auto with no args → inline help
    const empty = parse("!auto");
    expect(empty.handled).toBe(true);
    expect(empty.kind).toBe("inline");
  });


  it("!query / !data returns { isDuckdb: true, query } (#05)", () => {
    const r = parse("!query total upi volume by month");
    expect(r.handled).toBe(true);
    expect(r.kind).toBe("duckdb");
    if (r.kind === "duckdb") {
      expect(r.isDuckdb).toBe(true);
      expect(r.naturalQuery).toContain("upi volume");
    }
    // alias: !data
    const alias = parse("!data top 10 stocks by market cap");
    expect(alias.kind).toBe("duckdb");
  });

  it("unknown command returns an inline error mentioning !help", () => {
    const r = parse("!bogus");
    expect(r.handled).toBe(true);
    if ("inlineReply" in r) {
      expect(r.inlineReply).toContain("Unknown command");
      expect(r.inlineReply).toContain("!help");
    }
  });

  it("!context attaches page context for one turn (no mode switch)", () => {
    expect(parse("!context summarize the pricing")).toEqual({
      handled: true, kind: "context", isContext: true, query: "summarize the pricing",
    });
  });

  it("former !dom / !ctx aliases are gone (2026-08 rationalization)", () => {
    for (const raw of ["!dom compare the plans", "!ctx extract all emails"]) {
      const r = parse(raw);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe("inline"); // unknown-command reply
    }
  });

  it("former !qa alias is gone; !ask is the canonical question bang", () => {
    expect(parse("!qa what is this").kind).toBe("inline");
    const r = parse("!ask what is this");
    expect(r.handled).toBe(true);
    if (r.kind === "command") expect(r.mode).toBe("ask");
  });

  it("!context with no args → inline usage hint", () => {
    const r = parse("!context");
    expect(r.handled).toBe(true);
    expect(r.kind).toBe("inline");
    if ("inlineReply" in r) expect(r.inlineReply).toContain("Usage:");
  });

  it("!handoff carries the goal; no args → inline usage hint (Lane E)", () => {
    const r = parse("!handoff read these 5 tabs and build a comparison table");
    expect(r).toEqual({
      handled: true, kind: "handoff", isHandoff: true, query: "read these 5 tabs and build a comparison table",
    });
    const empty = parse("!handoff");
    expect(empty.handled).toBe(true);
    expect(empty.kind).toBe("inline");
    if ("inlineReply" in empty) expect(empty.inlineReply).toContain("Usage:");
  });

  it("!help lists the !handoff command", () => {
    const r = parse("!help");
    if ("inlineReply" in r) expect(r.inlineReply).toContain("!handoff");
  });

  it("!help lists the !context command", () => {
    const r = parse("!help");
    if ("inlineReply" in r) expect(r.inlineReply).toContain("!context");
  });

  it("every registered bang command resolves to a query + mode", () => {
    for (const name of Object.keys(BANG_COMMANDS)) {
      const r = parse(`!${name}`);
      expect(r.handled).toBe(true);
      if ("query" in r) {
        expect(typeof r.query).toBe("string");
        expect(r.query.length).toBeGreaterThan(0);
      }
    }
  });

  it("commands accept args and fold them into the query", () => {
    const r = parse("!extract prices");
    expect(r.handled).toBe(true);
    if ("query" in r) expect(r.query).toContain("prices");

    const r2 = parse("!research climate policy");
    expect(r2.handled).toBe(true);
    if ("query" in r2) expect(r2.query).toContain("climate policy");

    const r3 = parse("!skill cc-awareness-video");
    expect(r3.handled).toBe(true);
    if ("query" in r3) expect(r3.query).toContain("cc-awareness-video");
  });

  it("mode field is either null or a known Mode id", () => {
    const knownModes = ["extract", "ask"];
    for (const name of Object.keys(BANG_COMMANDS)) {
      const r = parse(`!${name}`);
      if ("mode" in r) {
        expect(r.mode === null || knownModes.includes(r.mode)).toBe(true);
      }
    }
  });

  it("canned reader bangs target the merged Ask mode (2026-08 rationalization)", () => {
    expect(BANG_COMMANDS.summarize.mode).toBe("ask");
    expect(BANG_COMMANDS.research.mode).toBe("ask");
    expect(BANG_COMMANDS.extract.mode).toBe("extract");
  });
});

describe("!export (#51)", () => {
  it("bare !export targets the conversation", () => {
    expect(parse("!export")).toEqual({ handled: true, kind: "export", exportTarget: "conversation" });
    expect(parse("!export  ")).toEqual({ handled: true, kind: "export", exportTarget: "conversation" }); // trailing ws ok, leading is a different query
  });

  it("!export page / !export pdf target the page and reader view", () => {
    expect(parse("!export page")).toEqual({ handled: true, kind: "export", exportTarget: "page" });
    expect(parse("!export pdf")).toEqual({ handled: true, kind: "export", exportTarget: "pdf" });
    expect(parse("!export reader")).toEqual({ handled: true, kind: "export", exportTarget: "pdf" });
  });

  it("!export <path> targets the workspace with the path preserved", () => {
    expect(parse("!export Documents/research/rti.md")).toEqual({
      handled: true, kind: "export", exportTarget: "workspace", exportPath: "Documents/research/rti.md",
    });
    expect(parse("!export notes/rti-guide.md")).toEqual({
      handled: true, kind: "export", exportTarget: "workspace", exportPath: "notes/rti-guide.md",
    });
  });

  it("case-insensitive targets, and the result is always schema-valid", () => {
    expect(parse("!export PAGE")).toEqual({ handled: true, kind: "export", exportTarget: "page" });
    expect(parse("!export PDF")).toEqual({ handled: true, kind: "export", exportTarget: "pdf" });
  });

  it("!help mentions the export line", () => {
    const r = parse("!help");
    if ("inlineReply" in r) expect(r.inlineReply).toContain("!export");
  });
});

describe("BANG_COMMANDS — registry integrity", () => {
  it("every command has label + desc + buildQuery function", () => {
    for (const [name, def] of Object.entries(BANG_COMMANDS)) {
      expect(typeof def.label).toBe("string");
      expect(def.label.length).toBeGreaterThan(0);
      expect(typeof def.desc).toBe("string");
      expect(def.desc.length).toBeGreaterThan(0);
      expect(typeof def.buildQuery).toBe("function");
    }
  });

  it("buildQuery never throws or returns empty for no args", () => {
    for (const [name, def] of Object.entries(BANG_COMMANDS)) {
      const q = def.buildQuery("");
      expect(typeof q).toBe("string");
      expect(q.length).toBeGreaterThan(0);
    }
  });
});

describe("!recipe — subcommands (#220)", () => {
  it("!recipe run carries the workspace path or local name", () => {
    expect(parse("!recipe run recipes/rti-filing.json")).toEqual({
      handled: true, kind: "recipe", isRecipe: true, sub: "run", target: "recipes/rti-filing.json",
    });
    expect(parse("!recipe run rti")).toEqual({
      handled: true, kind: "recipe", isRecipe: true, sub: "run", target: "rti",
    });
  });

  it("!recipe record carries the optional draft name", () => {
    expect(parse("!recipe record rti-flow")).toEqual({
      handled: true, kind: "recipe", isRecipe: true, sub: "record", target: "rti-flow",
    });
    expect(parse("!recipe record")).toEqual({
      handled: true, kind: "recipe", isRecipe: true, sub: "record", target: "",
    });
  });

  it("!recipe stop / list parse with empty targets", () => {
    expect(parse("!recipe stop")).toEqual({
      handled: true, kind: "recipe", isRecipe: true, sub: "stop", target: "",
    });
    expect(parse("!recipe list")).toEqual({
      handled: true, kind: "recipe", isRecipe: true, sub: "list", target: "",
    });
  });

  it("bare !recipe, unknown subs, and run-without-target → inline usage", () => {
    for (const raw of ["!recipe", "!recipe bogus", "!recipe run"]) {
      const r = parse(raw);
      expect(r.handled).toBe(true);
      expect(r.kind).toBe("inline");
      if ("inlineReply" in r) expect(r.inlineReply).toContain("Usage:");
    }
  });

  it("!help mentions the recipe line", () => {
    const r = parse("!help");
    if ("inlineReply" in r) expect(r.inlineReply).toContain("!recipe");
  });
});
