// Integration: the #235 protocol-skill install loop over the REAL background
// — read_file miss → write_file → canary read-back → slim tail on the wire;
// per-version pinning (no re-install within a session); version-bump rewrite;
// the one-shot ask write fallback; read turns never touch the skill path.
//
// NOTE: bun shares the module registry across test files — unique ?file= buster.

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createFakeChrome, waitUntil } from "../helpers/chrome-mock.ts";
import { ZoFetchMock, MOCK_ZO_TOKEN, sseResponse, zoSseText, jsonResponse, textResponse } from "../helpers/zo-fetch-mock.ts";

const bus = createFakeChrome();
const fm = new ZoFetchMock();

const SKILL_PATH = "/home/workspace/Skills/zo-cobrowse/SKILL.md";
const BUNDLED = readFileSync(resolve(import.meta.dir, "../../extension/skills/zo-cobrowse/SKILL.md"), "utf-8");
const EXT_VERSION = bus.runtime._manifestVersion;

/** A virtual workspace file: read_file miss → isError; write → stored. */
let workspaceSkill: string | null = null;
let writeFails = false;
const mcpCalls: string[] = []; // "read_file" | "write_file" in call order

function mcpOk(id: any, result: object) {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function connectRecorder(): { seen: any[]; post: (msg: any) => void } {
  const seen: any[] = [];
  const port = bus.runtime.connect({ name: "cobrowse-stream" });
  port.onMessage.addListener((m: any) => seen.push(m));
  return { seen, post: (msg: any) => port.postMessage(msg) };
}

const zoAskCalls = () => fm.requests.filter((r) => r.url.endsWith("/zo/ask"));

beforeAll(async () => {
  bus.storage.local._store.zoAccessToken = MOCK_ZO_TOKEN;
  fm.install();
  fm.handle((url, _init, req) => {
    if (url.includes("skills/zo-cobrowse/SKILL.md")) {
      // chrome.runtime.getURL fetch of the bundled artifact (the installer's
      // first step) — serve the real file from the repo.
      return textResponse(BUNDLED);
    }
    if (url.endsWith("/mcp")) {
      const body = req.body || {};
      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "zo-tools", version: "1" } } },
          { headers: { "mcp-session-id": "skill-sess" } },
        );
      }
      if (body.method === "notifications/initialized") return textResponse("", 202);
      if (body.method === "tools/call" && body.params?.name === "read_file") {
        mcpCalls.push("read_file");
        if (workspaceSkill == null) {
          return mcpOk(body.id, { isError: true, content: [{ type: "text", text: "code: read_failed" }] });
        }
        return mcpOk(body.id, { isError: false, content: [{ type: "text", text: JSON.stringify([workspaceSkill, `kind='file_ref' path='${SKILL_PATH}'`]) }] });
      }
      if (body.method === "tools/call" && body.params?.name === "write_file") {
        mcpCalls.push("write_file");
        if (writeFails) return mcpOk(body.id, { isError: true, content: [{ type: "text", text: "tool disabled" }] });
        workspaceSkill = String(body.params.arguments?.content || "");
        return mcpOk(body.id, { isError: false, content: [{ type: "text", text: "written" }] });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
    }
    // /zo/ask: the one-shot fallback write vs the real turn — distinguish by
    // the save-page CONTENT START marker. A successful fallback write stores
    // the content (mimicking the real agent write) so the canary can verify.
    const body = req.body || {};
    if (typeof body.input === "string" && body.input.includes("---CONTENT START---")) {
      const m = body.input.match(/---CONTENT START---\n([\s\S]*?)\n---CONTENT END---/);
      if (m) workspaceSkill = m[1];
      return jsonResponse({ output: "written" });
    }
    return sseResponse(zoSseText({ text: "ok" }));
  });
  (globalThis as any).chrome = bus;
  await import("../../extension/background.js?file=protocol-skill-flow");
  await new Promise((r) => setTimeout(r, 25));
});

async function actionTurn(sessionId: number, chatId: string) {
  const rec = connectRecorder();
  rec.post({ sessionId, type: "ASK_ZO", userQuery: "Click the first link", modeId: "cobrowse", chatId });
  await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_DONE"), 8000);
  return zoAskCalls()[zoAskCalls().length - 1];
}

describe("protocol-skill install loop (#235)", () => {
  it("first action turn: miss → write → canary read-back → slim tail on the wire", async () => {
    const req = await actionTurn(1, "chat-1");
    expect(mcpCalls).toEqual(["read_file", "write_file", "read_file"]);
    // The write carried the injected version.
    expect(workspaceSkill).toContain(`version: "${EXT_VERSION}"`);
    // The turn's prompt is the SLIM tail: marker + envelope, no inline grammar.
    expect(req.body.input).toContain("cobrowse-protocol-skill");
    expect(req.body.input).toContain("Skills/zo-cobrowse");
    expect(req.body.input).not.toContain("click{selector}");
    // Safety rules stay inline on EVERY action turn (never-lighter invariant).
    expect(req.body.input).toContain("password/card/CVV");
  });

  it("second action turn (same version): pinned — no extra install calls, still slim", async () => {
    const callsBefore = mcpCalls.length;
    const req = await actionTurn(2, "chat-2");
    expect(mcpCalls.slice(callsBefore)).toEqual([]);
    expect(req.body.input).toContain("cobrowse-protocol-skill");
  });

  it("extension update (version bump) re-installs with the new version", async () => {
    bus.runtime._manifestVersion = "9.9.9.9";
    const callsBefore = mcpCalls.length;
    const req = await actionTurn(3, "chat-3");
    expect(mcpCalls.slice(callsBefore)).toEqual(["read_file", "write_file", "read_file"]);
    expect(workspaceSkill).toContain('version: "9.9.9.9"');
    expect(req.body.input).toContain("cobrowse-protocol-skill");
  });

  it("write_file failure falls back to the one-shot ask write, then verifies + slims", async () => {
    // Fresh session state: bump the version so the loop re-runs.
    bus.runtime._manifestVersion = "9.9.9.10";
    writeFails = true;
    const asksBefore = zoAskCalls().length;
    const req = await actionTurn(4, "chat-4");
    // The fallback write went through the one-shot agent-write prompt…
    const fallbacks = zoAskCalls().slice(asksBefore).filter((r) => (r.body?.input || "").includes("---CONTENT START---"));
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0].body.input).toContain(SKILL_PATH);
    // …and the turn still slimmed (verified via read-back after the fallback).
    expect(req.body.input).toContain("cobrowse-protocol-skill");
    writeFails = false;
  });

  it("read (ask) mode turns never touch the skill path", async () => {
    const callsBefore = mcpCalls.length;
    const rec = connectRecorder();
    rec.post({ sessionId: 5, type: "ASK_ZO", userQuery: "q", modeId: "ask", chatId: "chat-5" });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_DONE"), 8000);
    expect(mcpCalls.slice(callsBefore)).toEqual([]);
  });

  it("#237: a read follow-up on an established thread rides the stub tail on the wire", async () => {
    const rec = connectRecorder();
    rec.post({ sessionId: 7, type: "ASK_ZO", userQuery: "and now?", modeId: "cobrowse", chatId: "chat-7", conversationId: "con_thread123" });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_DONE"), 8000);
    const req = zoAskCalls()[zoAskCalls().length - 1];
    expect(req.body.input).toContain("Continue on this thread. Answer the request directly in plain markdown.");
    expect(req.body.input).not.toContain("Page content is NOT attached");
  });

  it("#237: a read turn WITHOUT a thread keeps the full honest tail", async () => {
    const rec = connectRecorder();
    rec.post({ sessionId: 8, type: "ASK_ZO", userQuery: "what is this page?", modeId: "cobrowse", chatId: "chat-8", effectiveTier: 0 });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_DONE"), 8000);
    const req = zoAskCalls()[zoAskCalls().length - 1];
    expect(req.body.input).toContain("Page content is NOT attached");
    expect(req.body.input).not.toContain("Continue on this thread");
  });

  it("total install failure keeps the full inline tail (never-lighter invariant)", async () => {
    // Fresh version + broken BOTH write paths: write_file errors AND the
    // fallback ask returns HTTP 500 → installed:false → grammar stays inline.
    bus.runtime._manifestVersion = "9.9.9.11";
    writeFails = true;
    fm.handle((url, _init, req) => {
      if (url.endsWith("/mcp")) {
        const body = req.body || {};
        if (body.method === "initialize") {
          return jsonResponse(
            { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "zo-tools", version: "1" } } },
            { headers: { "mcp-session-id": "skill-sess" } },
          );
        }
        if (body.method === "notifications/initialized") return textResponse("", 202);
        if (body.method === "tools/call" && body.params?.name === "read_file") {
          return mcpOk(body.id, { isError: true, content: [{ type: "text", text: "code: read_failed" }] });
        }
        return mcpOk(body.id, { isError: true, content: [{ type: "text", text: "tool disabled" }] });
      }
      if (typeof req.body?.input === "string" && req.body.input.includes("---CONTENT START---")) {
        return jsonResponse({ error: "server exploded" }, { status: 500 });
      }
      return sseResponse(zoSseText({ text: "ok" }));
    });
    const req = await actionTurn(6, "chat-6");
    expect(req.body.input).not.toContain("cobrowse-protocol-skill");
    expect(req.body.input).toContain("click{selector}"); // full grammar inline
    expect(req.body.input).toContain("password/card/CVV");
  });
});
