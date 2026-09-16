import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  PROTOCOL_SKILL_DIR,
  PROTOCOL_SKILL_PATH,
  BUNDLED_SKILL_PATH,
  SKILL_MARKER,
  SKILL_POINTER,
  ACTION_ENVELOPE_DEMAND,
  SKILL_STATE_KEY,
  injectVersion,
  parseInstalledVersion,
  needsInstall,
} from "../extension/lib/protocol-skill.js";
import { BUILTIN_MODES, ACTION_SCHEMA_COMPACT } from "./../extension/lib/modes.js";
import { SHARED_SAFETY_RULES, buildPrompt, describePrompt } from "../extension/lib/prompt.js";
import { DescribedPromptSchema, ProtocolSkillStateSchema } from "./schemas/prompt.js";

const INSTALLED_AT = `---\nname: zo-cobrowse\ndescription: protocol\nmetadata:\n  author: LogicIncZo\n  version: "0.2.9.0"\n---\n\n# body\n`;

function makeCtx(extra: Record<string, unknown> = {}) {
  return {
    url: "https://example.com",
    title: "Example",
    visibleText: "Hello world",
    clickable: [{ text: "a", tag: "a", selector: "#a" }],
    formFields: [],
    viewport: { w: 800, h: 600 },
    ...extra,
  };
}

describe("protocol-skill paths + constants", () => {
  it("workspace + bundled paths follow the Zo skills convention", () => {
    expect(PROTOCOL_SKILL_DIR).toBe("/home/workspace/Skills/zo-cobrowse");
    expect(PROTOCOL_SKILL_PATH).toBe("/home/workspace/Skills/zo-cobrowse/SKILL.md");
    expect(BUNDLED_SKILL_PATH).toBe("skills/zo-cobrowse/SKILL.md");
    expect(SKILL_STATE_KEY).toBe("cobrowse_protocol_skill");
  });

  it("the bundled artifact exists, has frontmatter, and carries the marker vocabulary", () => {
    const bundled = readFileSync(resolve(import.meta.dir, "../extension", BUNDLED_SKILL_PATH), "utf-8");
    expect(bundled.startsWith("---\n")).toBe(true);
    expect(bundled).toMatch(/^name: zo-cobrowse$/m);
    expect(bundled).toMatch(/actions/);
    // The protocol sections the slim tail moves server-side.
    for (const section of ["Response envelope", "Action grammar", "Pull actions", "Cue-resolution ladders", "Safety rules"]) {
      expect(bundled).toContain(section);
    }
    // Every action the executor knows is documented.
    for (const action of ["click{selector}", "fill{selector,value}", "fill_form{values:[{target,value}]}", "extract{selector,attribute}", "navigate{url}", "scroll{direction,amount?}", "wait{ms}", "done{response}", "read_tab{ref}", "read_page", "get_dom", "get_form", "read_file{path}"]) {
      expect(bundled).toContain(action);
    }
    // Safety rules ride BOTH inline (every turn) and in the skill.
    expect(bundled).toMatch(/NEVER click ANY button/i);
    expect(bundled).toMatch(/password \/ card \/ CVV/i);
  });
});

describe("injectVersion / parseInstalledVersion", () => {
  it("replaces the placeholder version with the extension version", () => {
    const bundled = readFileSync(resolve(import.meta.dir, "../extension", BUNDLED_SKILL_PATH), "utf-8");
    const out = injectVersion(bundled, "1.2.3.4");
    expect(out).toMatch(/version: "1\.2\.3\.4"/);
    expect(out).not.toMatch(/version: "0"/);
    // Everything else rides unchanged.
    expect(out).toContain("# Zo Co-browse — action protocol");
  });

  it("appends a metadata block when the frontmatter lacks one", () => {
    const out = injectVersion('---\nname: x\ndescription: y\n---\nbody', "9.9.9");
    expect(out).toMatch(/metadata:\n {2}version: "9\.9\.9"/);
  });

  it("parses the installed version from the frontmatter (quoted or bare)", () => {
    expect(parseInstalledVersion(INSTALLED_AT)).toBe("0.2.9.0");
    expect(parseInstalledVersion('---\nmetadata:\n  version: 3\n---\nx')).toBe("3");
  });

  it("returns null for missing frontmatter / missing version / non-strings", () => {
    expect(parseInstalledVersion("no frontmatter at all")).toBe(null);
    expect(parseInstalledVersion("---\nname: x\n---\nbody")).toBe(null);
    expect(parseInstalledVersion(null)).toBe(null);
  });

  it("injectVersion is a no-op on empty input and never mutates its argument", () => {
    expect(injectVersion("", "1.0")).toBe("");
    const src = '---\nmetadata:\n  version: "0"\n---\n';
    injectVersion(src, "2.0");
    expect(src).toContain('version: "0"');
  });
});

describe("needsInstall", () => {
  it("installs when missing, unparseable, or stale", () => {
    expect(needsInstall({ installedText: null, extVersion: "1.0" })).toBe(true);
    expect(needsInstall({ installedText: "garbage", extVersion: "1.0" })).toBe(true);
    expect(needsInstall({ installedText: INSTALLED_AT, extVersion: "1.0.0" })).toBe(true);
  });

  it("skips the write when the workspace already has the current version", () => {
    expect(needsInstall({ installedText: INSTALLED_AT, extVersion: "0.2.9.0" })).toBe(false);
  });
});

describe("buildPrompt — slim protocol tail (#235)", () => {
  it("default (no protocolSkill) keeps the full inline grammar", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Click the login button");
    expect(p).toContain(ACTION_SCHEMA_COMPACT);
    expect(p).toContain(SHARED_SAFETY_RULES);
    expect(p).not.toContain(SKILL_MARKER);
  });

  it("verified install slims the tail to pointer + envelope demand + safety rules", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Click the login button", { protocolSkill: { installed: true, version: "1.2.3.4" } });
    expect(p).toContain(SKILL_POINTER);
    expect(p).toContain("Skills/zo-cobrowse");
    expect(p).toContain(ACTION_ENVELOPE_DEMAND);
    // Invariant: NEVER lighter than the verified install — safety rules stay inline.
    expect(p).toContain(SHARED_SAFETY_RULES);
    // The grammar/semantics moved server-side…
    expect(p).not.toContain(ACTION_SCHEMA_COMPACT);
    expect(p).not.toContain("click{selector}");
    // …and so did the builtin pacing instructions (they are canon in the skill).
    expect(p).not.toContain("Act on the page to fulfill the request");
  });

  it("user-tuned instructions are NEVER dropped by the slim tail", () => {
    const tuned = { ...BUILTIN_MODES.cobrowse, instructions: "Custom pacing: my own rules here." };
    const p = buildPrompt(tuned, makeCtx(), "Click the login button", { protocolSkill: { installed: true } });
    expect(p).toContain("Custom pacing: my own rules here.");
    expect(p).toContain(SKILL_POINTER);
    expect(p).not.toContain(ACTION_SCHEMA_COMPACT);
  });

  it("downgraded turns on an installed skill skip the slim tail entirely", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Summarize this page", { protocolSkill: { installed: true } });
    expect(p).not.toContain(SKILL_MARKER);
    expect(p).not.toContain(ACTION_SCHEMA_COMPACT);
  });

  it("installed:false (failed install) keeps the full inline tail", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Click the login button", { protocolSkill: { installed: false, reason: "read-back verification failed" } });
    expect(p).toContain(ACTION_SCHEMA_COMPACT);
    expect(p).not.toContain(SKILL_MARKER);
  });

  it("read/downgraded turns are unaffected by the install state", () => {
    const p = buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Summarize this page", { protocolSkill: { installed: true } });
    expect(p).not.toContain(SKILL_MARKER);
    expect(p).not.toContain(ACTION_SCHEMA_COMPACT);
  });

  it("describePrompt surfaces the install state and stays schema-valid", () => {
    const d = describePrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Click the login button", { protocolSkill: { installed: true, version: "1.2.3.4", checkedVersion: "1.2.3.4", via: "mcp" } });
    const parsed = DescribedPromptSchema.safeParse(d);
    expect(parsed.success).toBe(true);
    const ps = ProtocolSkillStateSchema.safeParse(d.protocolSkill);
    expect(ps.success).toBe(true);
    expect(d.prompt).toBe(buildPrompt(BUILTIN_MODES.cobrowse, makeCtx(), "Click the login button", { protocolSkill: { installed: true, version: "1.2.3.4", checkedVersion: "1.2.3.4", via: "mcp" } }));
  });

  it("describePrompt passes protocolSkill:null when the option is absent", () => {
    const d = describePrompt(BUILTIN_MODES.ask, makeCtx(), "q");
    expect(d.protocolSkill).toBe(null);
  });
});
