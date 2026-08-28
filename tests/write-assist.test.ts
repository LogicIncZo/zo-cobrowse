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
  it("bakes in the honest-copy rules", () => {
    const p = buildEnhancePrompt(input());
    expect(p).toMatch(/do NOT invent/i);
    expect(p).toMatch(/first-person/i);
  });
  it("bans tools and narration, and mandates the tag protocol", () => {
    const p = buildEnhancePrompt(input());
    expect(p).toMatch(/do not use tools, run commands, or search/i);
    expect(p).toContain("<write-assist>");
    expect(p).toContain("</write-assist>");
    expect(p).toMatch(/no narration/i);
  });
  it("plain fields forbid markdown; markdown-accepting fields welcome it", () => {
    const plain = buildEnhancePrompt(input());
    expect(plain).toMatch(/field is plain text/i);
    expect(plain).toMatch(/no markdown, no headings, no bullet lists/i);
    expect(plain).not.toMatch(/accepts Markdown/i);

    const md = buildEnhancePrompt(input({ field: { markdown: true }, acceptsMarkdown: true }));
    expect(md).toMatch(/accepts Markdown/i);
    expect(md).not.toMatch(/field is plain text/i);
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
  it("keeps ONLY tag content — narration outside the tags is intermediate thought, dropped", () => {
    const r = parseEnhanceResponse(
      'Let me quickly ground this in the data model before expanding.\n' +
      '<write-assist>\nFinal answer for the field.\n</write-assist>\nDone — review it.',
    );
    expect(r.text).toBe("Final answer for the field.");
  });
  it("tag content preserves markdown when the field accepts it", () => {
    const r = parseEnhanceResponse("<write-assist>## Heading\n- one\n- **two**</write-assist>");
    expect(r.text).toBe("## Heading\n- one\n- **two**");
  });
  it("handles fence inside tags and narration outside", () => {
    expect(parseEnhanceResponse('warm-up here\n<write-assist>```\nquoted body\n```</write-assist>').text).toBe("quoted body");
  });
  it("untagged replies fall back to trim/fence/quote stripping", () => {
    expect(parseEnhanceResponse("```\nLed a 6-month migration\n```").text).toBe("Led a 6-month migration");
    expect(parseEnhanceResponse('"Led a migration"').text).toBe("Led a migration");
    expect(parseEnhanceResponse("\u201cLed a migration\u201d").text).toBe("Led a migration");
  });
  it("keeps inner quotes intact", () => {
    expect(parseEnhanceResponse('He said "ship it" and we did').text).toBe('He said "ship it" and we did');
  });
  it("tolerates null/undefined/empty", () => {
    expect(parseEnhanceResponse(null).text).toBe("");
    expect(parseEnhanceResponse(undefined).text).toBe("");
    expect(parseEnhanceResponse("").text).toBe("");
  });
});
