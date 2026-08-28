import { describe, it, expect } from "bun:test";
import {
  WRITE_ASSIST_MARKER,
  isEnhanceableField,
  buildEnhancePrompt,
  parseEnhanceResponse,
} from "../extension/lib/write-assist";
import {
  EnhancePromptSchema,
  ParsedEnhanceSchema,
  EnhanceVerdictSchema,
  EnhanceInputSchema,
} from "./schemas/write-assist";

const input = (over: Record<string, unknown> = {}) => ({
  text: "Led migration of 40 dashboards to DuckDB",
  instruction: "",
  field: { label: "", placeholder: "", maxLength: null },
  page: { url: "", title: "" },
  ...over,
});

describe("isEnhanceableField", () => {
  it("accepts an editable textarea", () => {
    const v = isEnhanceableField({ tag: "textarea", disabled: false, readOnly: false });
    expect(EnhanceVerdictSchema.safeParse(v).success).toBe(true);
    expect(v).toBe(true);
  });
  it("accepts the tag case-insensitively (DOM tagName is uppercase)", () => {
    expect(isEnhanceableField({ tag: "TEXTAREA" })).toBe(true);
  });
  it("rejects non-textarea fields", () => {
    expect(isEnhanceableField({ tag: "input" })).toBe(false);
    expect(isEnhanceableField({ tag: "select" })).toBe(false);
    expect(isEnhanceableField({ tag: "" })).toBe(false);
  });
  it("rejects disabled or readonly textareas", () => {
    expect(isEnhanceableField({ tag: "textarea", disabled: true })).toBe(false);
    expect(isEnhanceableField({ tag: "textarea", readOnly: true })).toBe(false);
  });
  it("accepts contenteditable rich editors regardless of tag", () => {
    // GitHub's new issue form description is a CodeMirror .cm-content div.
    expect(isEnhanceableField({ tag: "div", editable: true })).toBe(true);
    expect(isEnhanceableField({ editable: true })).toBe(true);
  });
  it("tolerates null/undefined", () => {
    expect(isEnhanceableField(null)).toBe(false);
    expect(isEnhanceableField(undefined)).toBe(false);
  });
});

describe("buildEnhancePrompt", () => {
  it("produces a non-empty prompt carrying the lead", () => {
    const p = buildEnhancePrompt(input());
    expect(EnhancePromptSchema.safeParse(p).success).toBe(true);
    expect(p).toContain("Led migration of 40 dashboards to DuckDB");
  });
  it("embeds the stable routing marker", () => {
    expect(buildEnhancePrompt(input())).toContain(WRITE_ASSIST_MARKER);
  });
  it("bakes in the honest-copy + plain-text rules", () => {
    const p = buildEnhancePrompt(input());
    expect(p).toMatch(/do NOT invent/i);
    expect(p).toMatch(/ONLY the improved text/i);
    expect(p).toMatch(/first-person/i);
  });
  it("includes field label + placeholder when present", () => {
    const p = buildEnhancePrompt(input({
      field: { label: "Describe your project", placeholder: "Tell us more...", maxLength: null },
    }));
    expect(p).toContain("Describe your project");
    expect(p).toContain("Tell us more...");
  });
  it("includes page url + title when present", () => {
    const p = buildEnhancePrompt(input({
      page: { url: "https://jobs.example.com/apply", title: "Apply — Example Co" },
    }));
    expect(p).toContain("https://jobs.example.com/apply");
    expect(p).toContain("Apply — Example Co");
  });
  it("adds a character-limit rule only for a positive maxLength", () => {
    expect(buildEnhancePrompt(input({ field: { maxLength: 500 } }))).toContain("within 500 characters");
    expect(buildEnhancePrompt(input({ field: { maxLength: null } }))).not.toMatch(/characters/);
    expect(buildEnhancePrompt(input({ field: { maxLength: -1 } }))).not.toMatch(/characters/);
    expect(buildEnhancePrompt(input({ field: { maxLength: 0 } }))).not.toMatch(/characters/);
  });
  it("threads the optional user instruction", () => {
    const p = buildEnhancePrompt(input({ instruction: "about 200 words, professional tone" }));
    expect(p).toContain("about 200 words, professional tone");
  });
  it("omits empty sections (no dangling headers)", () => {
    const p = buildEnhancePrompt(input());
    expect(p).not.toContain("Field being filled:");
    expect(p).not.toContain("Page (context only):");
    expect(p).not.toContain("instruction for this rewrite");
  });
  it("validates a minimal input shape", () => {
    expect(EnhanceInputSchema.safeParse({ text: "hi" }).success).toBe(true);
  });
  it("tolerates a fully-empty call without throwing", () => {
    const p = buildEnhancePrompt({});
    expect(EnhancePromptSchema.safeParse(p).success).toBe(true);
  });
});

describe("parseEnhanceResponse", () => {
  it("trims surrounding whitespace", () => {
    const r = parseEnhanceResponse("  improved text  \n");
    expect(ParsedEnhanceSchema.safeParse(r).success).toBe(true);
    expect(r.text).toBe("improved text");
  });
  it("strips a wrapping code fence", () => {
    expect(parseEnhanceResponse("```\nLed a 6-month migration\n```").text).toBe("Led a 6-month migration");
    expect(parseEnhanceResponse("```text\nbody\n```").text).toBe("body");
  });
  it("strips one pair of wrapping straight quotes", () => {
    expect(parseEnhanceResponse('"Led a migration"').text).toBe("Led a migration");
  });
  it("strips one pair of wrapping curly quotes", () => {
    expect(parseEnhanceResponse("\u201cLed a migration\u201d").text).toBe("Led a migration");
  });
  it("keeps inner quotes intact", () => {
    expect(parseEnhanceResponse('He said "ship it" and we did').text).toBe('He said "ship it" and we did');
  });
  it("handles fence + quotes together", () => {
    expect(parseEnhanceResponse('```\n"quoted body"\n```').text).toBe("quoted body");
  });
  it("tolerates null/undefined/empty", () => {
    expect(parseEnhanceResponse(null).text).toBe("");
    expect(parseEnhanceResponse(undefined).text).toBe("");
    expect(parseEnhanceResponse("").text).toBe("");
  });
});
