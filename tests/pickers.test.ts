import { describe, expect, it } from "bun:test";
import {
  WORKSPACE_ROOT,
  SKILLS_DIR,
  safeWorkspacePath,
  shellQuote,
  skillsListCommand,
  dirListCommand,
  unescapeRepr,
  extractMarkedStdout,
  parseLsEntries,
  parseSkillFrontmatter,
  parseSkillsBundle,
  filterPickerEntries,
  buildSkillLines,
  buildFileLines,
} from "../extension/lib/pickers.js";
import { mcpRequest, mcpNotification, initializeParams, toolCallParams, parseMcpMessage, toolText, isToolError } from "../extension/lib/mcp.js";
import {
  McpInitializeParamsSchema,
  McpNotificationMessageSchema,
  McpRequestMessageSchema,
  McpResponseMessageSchema,
  McpToolCallParamsSchema,
  McpToolResultSchema,
} from "./schemas/mcp.js";
import {
  SkillEntrySchema,
  FileEntrySchema,
  ListSkillsResponseSchema,
  ListWorkspaceDirResponseSchema,
} from "./schemas/pickers";
import { buildPrompt, describePrompt } from "../extension/lib/prompt.js";
import { BUILTIN_MODES } from "../extension/lib/modes.js";

// ---------------------------------------------------------------------------
// Path safety — the shell boundary for the `%` picker.
// ---------------------------------------------------------------------------
describe("safeWorkspacePath — confine listings to the workspace root", () => {
  it("accepts the root and paths inside it (normalizing slashes)", () => {
    expect(safeWorkspacePath("/home/workspace")).toBe(WORKSPACE_ROOT);
    expect(safeWorkspacePath("/home/workspace/")).toBe(WORKSPACE_ROOT);
    expect(safeWorkspacePath("/home/workspace//Skills//")).toBe("/home/workspace/Skills");
    expect(safeWorkspacePath("/home/workspace/Skills/websh")).toBe("/home/workspace/Skills/websh");
  });

  it("normalizes . and .. INSIDE the root", () => {
    expect(safeWorkspacePath("/home/workspace/Skills/./websh")).toBe("/home/workspace/Skills/websh");
    expect(safeWorkspacePath("/home/workspace/Skills/websh/..")).toBe("/home/workspace/Skills");
  });

  it("rejects traversal escaping the root", () => {
    expect(safeWorkspacePath("/home/workspace/../etc")).toBeNull(); // → /home/etc
    expect(safeWorkspacePath("/home/workspace/..")).toBeNull();     // → /home
    expect(safeWorkspacePath("/home/workspace/Skills/../../..")).toBeNull();
  });

  it("rejects relative, empty, and control-character input", () => {
    expect(safeWorkspacePath("Skills")).toBeNull();
    expect(safeWorkspacePath("")).toBeNull();
    expect(safeWorkspacePath(null as any)).toBeNull();
    expect(safeWorkspacePath("/home/workspace/bo\u0000om")).toBeNull();
    expect(safeWorkspacePath("/home/workspace/bo\nom")).toBeNull();
  });

  it("rejects unrelated absolute roots", () => {
    expect(safeWorkspacePath("/etc/passwd")).toBeNull();
    expect(safeWorkspacePath("/root/.agents/skills")).toBeNull();
  });
});

describe("shellQuote — single-quote hardening", () => {
  it("quotes plain paths", () => {
    expect(shellQuote("/home/workspace/Skills")).toBe("'/home/workspace/Skills'");
  });
  it("neutralizes embedded quotes", () => {
    expect(shellQuote("a'; rm -rf /; '")).toBe("'a'\\''; rm -rf /; '\\'''");
  });
});

describe("command builders — deterministic, marker-delimited", () => {
  it("skillsListCommand scans SKILL.md heads under the skills dir", () => {
    const cmd = skillsListCommand();
    expect(cmd).toContain("__ZO_BEGIN__");
    expect(cmd).toContain("__ZO_END__");
    expect(cmd).toContain("'/home/workspace/Skills'");
    expect(cmd).toContain("SKILL.md");
  });
  it("skillsListCommand emits the ##SKILL_COUNT line first, inside the markers (#73)", () => {
    const cmd = skillsListCommand();
    const beginIdx = cmd.indexOf("__ZO_BEGIN__;");
    const countIdx = cmd.indexOf("##SKILL_COUNT", beginIdx);
    const loopIdx = cmd.indexOf("for d in", beginIdx);
    expect(countIdx).toBeGreaterThan(beginIdx);
    expect(loopIdx).toBeGreaterThan(countIdx);
    expect(cmd).toContain("wc -l");
  });
  it("dirListCommand lists one directory non-recursively", () => {
    const cmd = dirListCommand("/home/workspace/Skills/websh");
    expect(cmd).toContain("ls -1F");
    expect(cmd).toContain("'/home/workspace/Skills/websh'");
    expect(cmd).toContain("__ZO_BEGIN__");
  });
});

// ---------------------------------------------------------------------------
// bash-tool result parsing (Python-repr CmdResult wrapper + markers).
// ---------------------------------------------------------------------------
describe("unescapeRepr", () => {
  it("decodes the escapes the bash tool emits", () => {
    expect(unescapeRepr("a\\nb")).toBe("a\nb");
    expect(unescapeRepr("it\\'s")).toBe("it's");
    expect(unescapeRepr("tab\\there")).toBe("tab\there");
    expect(unescapeRepr("back\\\\slash")).toBe("back\\slash");
    expect(unescapeRepr("plain")).toBe("plain");
  });
});

describe("extractMarkedStdout", () => {
  it("extracts + unescapes the marked region from a CmdResult repr", () => {
    const raw = "CmdResult(stdout='__ZO_BEGIN__\\nConnections/\\nagent-browser-rest.skill\\n__ZO_END__\\n', stderr='', returncode=0)";
    expect(extractMarkedStdout(raw)).toBe("Connections/\nagent-browser-rest.skill");
  });
  it("returns null when markers are absent", () => {
    expect(extractMarkedStdout("CmdResult(stdout='ls: cannot access', stderr='', returncode=2)")).toBeNull();
    expect(extractMarkedStdout("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ls -1F parsing.
// ---------------------------------------------------------------------------
describe("parseLsEntries", () => {
  it("classifies ls -F suffixes into kinds and builds absolute paths", () => {
    const out = parseLsEntries("Skills/\nAGENTS.md\nrun.sh*\nlink@\nDocs/\n", "/home/workspace");
    expect(out).toEqual([
      { name: "Skills", path: "/home/workspace/Skills", kind: "dir" },
      { name: "AGENTS.md", path: "/home/workspace/AGENTS.md", kind: "file" },
      { name: "run.sh", path: "/home/workspace/run.sh", kind: "exec" },
      { name: "link", path: "/home/workspace/link", kind: "symlink" },
      { name: "Docs", path: "/home/workspace/Docs", kind: "dir" },
    ]);
    for (const e of out) expect(FileEntrySchema.safeParse(e).success).toBe(true);
  });
  it("skips blank lines and dot entries", () => {
    expect(parseLsEntries(".\n..\n\nfile\n", "/root")).toEqual([{ name: "file", path: "/root/file", kind: "file" }]);
  });
});

// ---------------------------------------------------------------------------
// SKILL.md frontmatter + bundle parsing.
// ---------------------------------------------------------------------------
describe("parseSkillFrontmatter", () => {
  it("reads inline name + description", () => {
    const fm = parseSkillFrontmatter("---\nname: websh\ndescription: A shell for the web.\n---\n# body");
    expect(fm).toEqual({ name: "websh", description: "A shell for the web." });
  });
  it("reads block (|) multiline descriptions", () => {
    const head = "---\nname: vid\ndescription: |\n  Line one.\n  Line two.\nmetadata:\n  author: x\n---\n";
    const fm = parseSkillFrontmatter(head);
    expect(fm.name).toBe("vid");
    expect(fm.description).toContain("Line one.");
    expect(fm.description).toContain("Line two.");
  });
  it("returns null name + empty description for a head with no frontmatter", () => {
    expect(parseSkillFrontmatter("# just a readme")).toEqual({ name: null, description: "" });
  });
});

describe("parseSkillsBundle", () => {
  const mk = (id: string, name: string, desc: string) =>
    `##SKILL /home/workspace/Skills/${id}\n---\nname: ${name}\ndescription: ${desc}\n---\n`;
  const raw =
    "__ZO_BEGIN__\n" +
    mk("websh", "websh", "A shell for the web.") +
    "\n" +
    mk("cc-video", "cc-awareness-video", "End-to-end video pipeline.") +
    "__ZO_END__\n";

  it("parses ##SKILL-delimited heads into schema-valid entries, sorted by name", () => {
    const { skills } = parseSkillsBundle(raw);
    expect(skills.map((s: any) => s.id)).toEqual(["cc-video", "websh"]);
    for (const s of skills) expect(SkillEntrySchema.safeParse(s).success).toBe(true);
  });
  it("falls back to the folder name when frontmatter lacks name:", () => {
    const r = "__ZO_BEGIN__\n##SKILL /home/workspace/Skills/noname\ndescription: only a description\n__ZO_END__";
    const { skills } = parseSkillsBundle(r);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("noname");
  });
  it("skips entries with no parseable head, and returns an empty report without markers", () => {
    expect(parseSkillsBundle("CmdResult(stdout='ls: cannot access', stderr='', returncode=2)")).toEqual({ skills: [], totalFolders: null });
    expect(parseSkillsBundle("__ZO_BEGIN__\n##SKILL /home/workspace/Skills/empty\n__ZO_END__")).toEqual({ skills: [], totalFolders: null });
  });
});

describe("parseSkillsBundle — ##SKILL_COUNT + truncation (#73)", () => {
  const mk = (id: string, name: string) =>
    `##SKILL /home/workspace/Skills/${id}\n---\nname: ${name}\ndescription: d\n---\n`;

  it("reads the count line and reports totalFolders next to the parsed list", () => {
    const raw = "__ZO_BEGIN__\n##SKILL_COUNT 5\n" + mk("a", "A") + mk("b", "B") + "__ZO_END__\n";
    const { skills, totalFolders } = parseSkillsBundle(raw);
    expect(totalFolders).toBe(5);
    expect(skills.map((s: any) => s.name)).toEqual(["A", "B"]);
  });

  it("a listing cut short (missing END marker) yields an empty report — the caller turns that into an honest error", () => {
    const raw = "CmdResult(stdout='__ZO_BEGIN__\\n##SKILL_COUNT 9\\n##SKILL /home/workspace/Skills/a\\n---\\nname: A\\n---\\n', stderr='', returncode=0)";
    expect(parseSkillsBundle(raw)).toEqual({ skills: [], totalFolders: null });
  });

  it("totalFolders stays null when the count line is absent (older fixture shape)", () => {
    const raw = "__ZO_BEGIN__\n" + mk("a", "A") + "__ZO_END__\n";
    expect(parseSkillsBundle(raw).totalFolders).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Response schema conformance (message payloads).
// ---------------------------------------------------------------------------
describe("picker message payload schemas", () => {
  it("LIST_SKILLS ok + error shapes validate", () => {
    expect(ListSkillsResponseSchema.safeParse({ ok: true, skills: [{ id: "websh", name: "websh", description: "" }] }).success).toBe(true);
    expect(ListSkillsResponseSchema.safeParse({ ok: false, error: "no token" }).success).toBe(true);
    expect(ListSkillsResponseSchema.safeParse({ ok: true, skills: [{ id: "", name: "x", description: "" }] }).success).toBe(false);
  });
  it("LIST_SKILLS ok shape validates with and without the optional total (#73)", () => {
    expect(ListSkillsResponseSchema.safeParse({ ok: true, skills: [{ id: "a", name: "A", description: "" }], total: 5 }).success).toBe(true);
    expect(ListSkillsResponseSchema.safeParse({ ok: true, skills: [] }).success).toBe(true);
    expect(ListSkillsResponseSchema.safeParse({ ok: true, skills: [], total: -1 }).success).toBe(false);
  });
  it("LIST_WORKSPACE_DIR ok + error shapes validate", () => {
    expect(ListWorkspaceDirResponseSchema.safeParse({
      ok: true, path: "/home/workspace", entries: [{ name: "Skills", path: "/home/workspace/Skills", kind: "dir" }],
    }).success).toBe(true);
    expect(ListWorkspaceDirResponseSchema.safeParse({ ok: false, error: "outside root" }).success).toBe(true);
    expect(ListWorkspaceDirResponseSchema.safeParse({ ok: true, path: "relative", entries: [] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP envelope helpers.
// ---------------------------------------------------------------------------
describe("mcp.js — JSON-RPC envelope", () => {
  it("mcpRequest builds unique-id JSON-RPC 2.0 bodies", () => {
    const a = mcpRequest("tools/list");
    const b = mcpRequest("tools/call", toolCallParams("bash", { cmd: "ls" }));
    expect(JSON.parse(a.body)).toMatchObject({ jsonrpc: "2.0", method: "tools/list", id: a.id });
    expect(JSON.parse(b.body).params).toEqual({ name: "bash", arguments: { cmd: "ls" } });
    expect(a.id).not.toBe(b.id);
  });
  it("mcpNotification has no id", () => {
    expect(JSON.parse(mcpNotification("notifications/initialized"))).not.toHaveProperty("id");
  });
  it("initializeParams identifies the extension", () => {
    expect(initializeParams().clientInfo.name).toBe("zo-cobrowse-extension");
  });
  it("parseMcpMessage reads plain JSON and SSE-framed bodies", () => {
    const msg = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }] } };
    expect(parseMcpMessage(JSON.stringify(msg))).toEqual(msg);
    expect(parseMcpMessage(`event: message\ndata: ${JSON.stringify(msg)}\n\n`)).toEqual(msg);
    expect(parseMcpMessage("not json")).toBeNull();
  });
  it("toolText + isToolError read tools/call results", () => {
    const result = { isError: false, content: [{ type: "text", text: "CmdResult(stdout='…')" }] };
    expect(toolText(result)).toContain("CmdResult");
    expect(isToolError(result)).toBe(false);
    expect(isToolError({ isError: true, content: [] })).toBe(true);
    expect(toolText({})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Picker payload → prompt sections.
// ---------------------------------------------------------------------------
describe("picker payload assembly", () => {
  const skills = [{ id: "websh", name: "websh", description: "A shell for the web." }];
  const files = [{ path: "/home/workspace/AGENTS.md" }];

  it("buildSkillLines names the skill and its workspace folder", () => {
    const lines = buildSkillLines(skills);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"websh"');
    expect(lines[0]).toContain(`${SKILLS_DIR}/websh`);
  });
  it("buildFileLines emit absolute paths only", () => {
    expect(buildFileLines(files)).toEqual(["- /home/workspace/AGENTS.md"]);
    expect(buildFileLines([{ path: "" } as any, null as any])).toEqual([]);
  });
  it("filterPickerEntries matches name/description/id/path case-insensitively", () => {
    const entries = [
      { id: "websh", name: "websh", description: "shell for the web" },
      { id: "v", name: "video maker", description: "" },
    ];
    expect(filterPickerEntries(entries, "SHELL")).toHaveLength(1);
    expect(filterPickerEntries(entries, "")).toHaveLength(2);
  });

  it("buildPrompt renders ## Skills to Run + ## Referenced Files sections", () => {
    const mode = BUILTIN_MODES.ask;
    const prompt = buildPrompt(mode, null, "do the thing", { skills, workspaceFiles: files });
    expect(prompt).toContain("## Skills to Run");
    expect(prompt).toContain('"websh"');
    expect(prompt).toContain("read its SKILL.md");
    expect(prompt).toContain("## Referenced Files");
    expect(prompt).toContain("- /home/workspace/AGENTS.md");
    // Ordering: picker sections sit between Referenced Tabs and Page Content.
    expect(prompt.indexOf("## Skills to Run")).toBeGreaterThan(-1);
  });

  it("describePrompt exposes the sections with counts", () => {
    const d = describePrompt(BUILTIN_MODES.ask, null, "q", { skills, workspaceFiles: files });
    const ids = d.sections.map((s: any) => s.id);
    expect(ids).toContain("skills");
    expect(ids).toContain("files");
    const skillSection = d.sections.find((s: any) => s.id === "skills");
    expect(skillSection.meta).toBe("1 skill");
    const fileSection = d.sections.find((s: any) => s.id === "files");
    expect(fileSection.meta).toBe("1 file");
  });

  it("omits the sections entirely when nothing is picked (prompt unchanged)", () => {
    const plain = buildPrompt(BUILTIN_MODES.ask, null, "q");
    expect(plain).not.toContain("## Skills to Run");
    expect(plain).not.toContain("## Referenced Files");
  });

  it("drops malformed entries instead of rendering them", () => {
    const prompt = buildPrompt(BUILTIN_MODES.ask, null, "q", {
      skills: [{ nope: 1 } as any, { name: "ok" } as any],
      workspaceFiles: [{ path: 42 } as any, { path: "/home/workspace/ok.md" }],
    });
    expect(prompt).toContain('"ok"');
    expect(prompt).not.toContain("nope");
    expect(prompt).toContain("/home/workspace/ok.md");
  });
});

// ---- schema conformance: MCP JSON-RPC envelopes (tests/schemas/mcp.ts) ----

describe("mcp — schema conformance", () => {
  it("mcpRequest bodies parse into McpRequestMessageSchema with matching ids", () => {
    const { body, id } = mcpRequest("tools/call", toolCallParams("bash", { cmd: "ls" }));
    const msg = JSON.parse(body);
    const parsed = McpRequestMessageSchema.safeParse(msg);
    if (!parsed.success) throw new Error(`mcpRequest body failed schema:\n${parsed.error.message}`);
    expect(msg.id).toBe(id);
  });

  it("mcpNotification bodies satisfy McpNotificationMessageSchema (no id)", () => {
    const body = mcpNotification("notifications/initialized");
    const parsed = McpNotificationMessageSchema.safeParse(JSON.parse(body));
    if (!parsed.success) throw new Error(`notification failed schema:\n${parsed.error.message}`);
    expect(JSON.parse(body).id).toBeUndefined();
  });

  it("initializeParams + toolCallParams satisfy their schemas", () => {
    expect(McpInitializeParamsSchema.safeParse(initializeParams()).success).toBe(true);
    expect(McpToolCallParamsSchema.safeParse(toolCallParams("bash", { cmd: "ls" })).success).toBe(true);
    expect(McpToolCallParamsSchema.safeParse(toolCallParams("bash", null)).success).toBe(true);
  });

  it("parseMcpMessage outputs (plain + SSE) satisfy McpResponseMessageSchema; nulls pass through", () => {
    const ok = parseMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }));
    expect(ok).not.toBeNull();
    expect(McpResponseMessageSchema.safeParse(ok).success).toBe(true);

    const sse = parseMcpMessage('event: message\ndata: {"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"no"}}\n\n');
    expect(sse).not.toBeNull();
    expect(McpResponseMessageSchema.safeParse(sse).success).toBe(true);

    for (const junk of [null, "", "event: ping", "[1,2]", "{not json"]) {
      expect(parseMcpMessage(junk as never)).toBeNull();
    }
  });

  it("tools/call results satisfy McpToolResultSchema for toolText/isToolError inputs", () => {
    const results = [
      { content: [{ type: "text", text: "hi" }] },
      { content: [{ type: "image", data: "..." }], isError: true },
      {},
      null,
    ];
    for (const r of results) {
      if (r && typeof r === "object") {
        expect(McpToolResultSchema.safeParse(r).success).toBe(true);
      }
      expect(typeof toolText(r as never)).toBe("string");
      expect(typeof isToolError(r as never)).toBe("boolean");
    }
  });
});
