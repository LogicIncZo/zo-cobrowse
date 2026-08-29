// Integration: the #28 composer pickers' background path — the MCP client
// (initialize → session header → tools/call) behind LIST_SKILLS and
// LIST_WORKSPACE_DIR, against the fake-chrome bus + recording fetch mock.
//
// NOTE: bun test shares the module registry across test files in one process,
// so this file imports background.js with its own ?file= cache-buster.

import { describe, it, expect, beforeAll } from "bun:test";
import { createFakeChrome } from "../helpers/chrome-mock.ts";
import { ZoFetchMock, MOCK_ZO_TOKEN, jsonResponse, textResponse } from "../helpers/zo-fetch-mock.ts";
import { ListSkillsResponseSchema, ListWorkspaceDirResponseSchema } from "../schemas/pickers";

const bus = createFakeChrome();
const fm = new ZoFetchMock();

// Fixtures shaped like the LIVE bash tool (verified 2026-08-18): the tool's
// text output is a Python-repr CmdResult wrapper around stdout, with \n
// escapes and our __ZO_BEGIN__/__ZO_END__ markers around the payload.
const SKILLS_STDOUT = [
  "##SKILL /home/workspace/Skills/websh",
  "---",
  "name: websh",
  "description: A shell for the web.",
  "---",
  "",
  "##SKILL /home/workspace/Skills/cc-video",
  "---",
  "name: cc-awareness-video",
  "description: End-to-end video pipeline.",
  "---",
].join("\\n");
const LS_STDOUT = "Skills/\\nAGENTS.md\\nrun.sh*";

function bashResult(stdoutRepr: string): string {
  return `CmdResult(stdout='__ZO_BEGIN__\\n${stdoutRepr}\\n__ZO_END__\\n', stderr='', returncode=0)`;
}

function mcpOk(id: any, result: object) {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

const mcpRequests = () => fm.requests.filter((r) => r.url.endsWith("/mcp"));

beforeAll(async () => {
  bus.storage.local._store.zoAccessToken = MOCK_ZO_TOKEN;
  fm.install();
  fm.handle((url, _init, req) => {
    if (!url.endsWith("/mcp")) return jsonResponse({});
    const body = req.body || {};
    if (body.method === "initialize") {
      return jsonResponse(
        { jsonrpc: "2.0", id: body.id, result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "zo-tools", version: "1.0.0" },
        } },
        { headers: { "mcp-session-id": "sess-1" } },
      );
    }
    if (body.method === "notifications/initialized") return textResponse("", 202);
    if (body.method === "tools/call" && body.params?.name === "bash") {
      const cmd = String(body.params.arguments?.cmd || "");
      if (cmd.includes("SKILL.md")) return mcpOk(body.id, { isError: false, content: [{ type: "text", text: bashResult(SKILLS_STDOUT) }] });
      if (cmd.includes("ls -1F")) return mcpOk(body.id, { isError: false, content: [{ type: "text", text: bashResult(LS_STDOUT) }] });
      return mcpOk(body.id, { isError: true, content: [{ type: "text", text: "unexpected command" }] });
    }
    return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
  });
  (globalThis as any).chrome = bus;
  await import("../../extension/background.js?file=mcp-flow");
  await new Promise((r) => setTimeout(r, 25));
});

describe("LIST_SKILLS — MCP bash enumeration of the workspace Skills folder", () => {
  it("initializes the session, calls bash with the skills scan, returns parsed skills", async () => {
    const resp = await bus.runtime.sendMessage({ type: "LIST_SKILLS" });
    expect(resp.ok).toBe(true);
    expect(resp.skills.map((s: any) => s.name)).toEqual(["cc-awareness-video", "websh"]);
    expect(ListSkillsResponseSchema.safeParse(resp).success).toBe(true);

    const reqs = mcpRequests();
    expect(reqs.length).toBeGreaterThanOrEqual(3); // initialize + notification + tools/call
    expect(reqs[0].body.method).toBe("initialize");
    const auth = reqs.map((r) => r.headers.authorization);
    for (const a of auth) expect(a).toBe(`Bearer ${MOCK_ZO_TOKEN}`);
    const call = reqs.find((r) => r.body.method === "tools/call");
    expect(call.body.params.name).toBe("bash");
    expect(call.body.params.arguments.cmd).toContain("/home/workspace/Skills");
    expect(call.body.params.arguments.cmd).toContain("SKILL.md");
    expect(call.headers["mcp-session-id"]).toBeTruthy(); // session threaded after initialize
  });

  it("caches the list — a second call issues no new MCP round-trips", async () => {
    const before = mcpRequests().length;
    const resp = await bus.runtime.sendMessage({ type: "LIST_SKILLS" });
    expect(resp.ok).toBe(true);
    expect(mcpRequests().length).toBe(before);
  });

  it("cache survives a simulated SW restart — no new MCP round-trips after a background reload", async () => {
    // The earlier tests warmed the session cache via the Task-2 wiring.
    const before = mcpRequests().length;
    // Reload background.js as a "new service worker instance" (fresh module
    // registry entry, same fake-chrome bus → same storage.session).
    await import("../../extension/background.js?file=mcp-flow-restart");
    await new Promise((r) => setTimeout(r, 25));
    const resp = await bus.runtime.sendMessage({ type: "LIST_SKILLS" });
    expect(resp.ok).toBe(true);
    expect(resp.skills.length).toBeGreaterThan(0);
    expect(mcpRequests().length).toBe(before);
  });
});

describe("LIST_WORKSPACE_DIR — validated ls -1F of a workspace path", () => {
  it("lists a directory with classified entries (schema-valid)", async () => {
    const resp = await bus.runtime.sendMessage({ type: "LIST_WORKSPACE_DIR", path: "/home/workspace" });
    expect(resp.ok).toBe(true);
    expect(resp.path).toBe("/home/workspace");
    expect(resp.entries).toEqual([
      { name: "Skills", path: "/home/workspace/Skills", kind: "dir" },
      { name: "AGENTS.md", path: "/home/workspace/AGENTS.md", kind: "file" },
      { name: "run.sh", path: "/home/workspace/run.sh", kind: "exec" },
    ]);
    expect(ListWorkspaceDirResponseSchema.safeParse(resp).success).toBe(true);
    const call = mcpRequests().filter((r) => r.body.method === "tools/call").pop();
    expect(call.body.params.arguments.cmd).toContain("ls -1F");
    expect(call.body.params.arguments.cmd).toContain("'/home/workspace'");
  });

  it("rejects traversal before any fetch happens", async () => {
    const before = mcpRequests().length;
    const resp = await bus.runtime.sendMessage({ type: "LIST_WORKSPACE_DIR", path: "/home/workspace/../../etc" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("/home/workspace");
    const resp2 = await bus.runtime.sendMessage({ type: "LIST_WORKSPACE_DIR", path: "Skills" });
    expect(resp2.ok).toBe(false);
    expect(mcpRequests().length).toBe(before); // nothing escaped to the wire
  });
});

describe("ASK_ZO threads picked skills/files into the prompt", () => {
  it("streaming payload renders ## Skills to Run + ## Referenced Files", async () => {
    const port = bus.runtime.connect({ name: "cobrowse-stream" });
    const seen: any[] = [];
    port.onMessage.addListener((m: any) => seen.push(m));
    port.postMessage({
      type: "ASK_ZO",
      chatId: "chat-1",
      userQuery: "do it",
      modeId: "ask",
      effectiveTier: 0,
      skills: [{ id: "websh", name: "websh", description: "A shell for the web." }],
      workspaceFiles: [{ path: "/home/workspace/AGENTS.md" }],
    });
    await new Promise((r) => setTimeout(r, 150));
    const ask = fm.requests.find((r) => r.url.includes("/zo/ask"));
    expect(ask).toBeTruthy();
    expect(ask.body.input).toContain("## Skills to Run");
    expect(ask.body.input).toContain('"websh"');
    expect(ask.body.input).toContain("## Referenced Files");
    expect(ask.body.input).toContain("- /home/workspace/AGENTS.md");
  });
});
