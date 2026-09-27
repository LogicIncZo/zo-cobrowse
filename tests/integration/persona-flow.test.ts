// Integration: the #415 persona_id lane over the REAL background —
// ensurePersonas creates one persona per builtin Mode (server-side system
// text), the turn payload carries persona_id and DROPS the inline system
// section; fail-closed paths (tuned overrides, user persona routing,
// send-time drift) keep the inline system; lost storage re-adopts by name.
//
// NOTE: bun shares the module registry across test files — unique ?file= buster.

import { describe, it, expect, beforeAll } from "bun:test";
import { createFakeChrome, waitUntil } from "../helpers/chrome-mock.ts";
import { ZoFetchMock, MOCK_ZO_TOKEN, sseResponse, zoSseText, jsonResponse, textResponse } from "../helpers/zo-fetch-mock.ts";

const bus = createFakeChrome();
const fm = new ZoFetchMock();

const EXT_VERSION = bus.runtime._manifestVersion;
const CO_SYSTEM = "You are Zo — the user's AI co-browsing assistant. You see the page and can control the browser.";
const ASK_SYSTEM = "You are Zo — the user's browser companion. You see the page. Keep responses concise and scannable.";

/** Server-side persona list (the REST + MCP views stay in sync). */
const workspaceFiles = new Map<string, string>();
const serverPersonas: { id: string; name: string; prompt: string }[] = [];
const createCalls: { name: string; prompt: string }[] = [];
const deleteCalls: string[] = [];

function uuidFor(i: number): string {
  return `aaaa0000-0000-0000-0000-${String(i).padStart(12, "0")}`;
}
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
const storedMap = async () => (await bus.storage.local.get("cobrowse_personas"))["cobrowse_personas"];

beforeAll(async () => {
  bus.storage.local._store.zoAccessToken = MOCK_ZO_TOKEN;
  fm.install();
  fm.handle((url, _init, req) => {
    if (url.endsWith("/personas/available")) {
      return jsonResponse({ personas: serverPersonas.map(({ id, name }) => ({ id, name })) });
    }
    if (url.includes("skills/zo-cobrowse/")) {
      // Bundled artifact fetch — the skill install rides the same turn path.
      return textResponse("---\nname: x\nmetadata:\n  version: \"0\"\n---\nbody");
    }
    if (url.endsWith("/mcp")) {
      const body = req.body || {};
      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "zo-tools", version: "1" } } },
          { headers: { "mcp-session-id": "persona-sess" } },
        );
      }
      if (body.method === "notifications/initialized") return textResponse("", 202);
      if (body.method === "tools/call" && body.params?.name === "create_persona") {
        const name = String(body.params.arguments?.name || "");
        const prompt = String(body.params.arguments?.prompt || "");
        createCalls.push({ name, prompt });
        const id = uuidFor(createCalls.length);
        serverPersonas.push({ id, name, prompt });
        return mcpOk(body.id, { isError: false, content: [{ type: "text", text: `id='${id}' name='${name}' prompt="${prompt}"` }] });
      }
      if (body.method === "tools/call" && body.params?.name === "delete_persona") {
        const pid = String(body.params.arguments?.persona_id || "");
        deleteCalls.push(pid);
        const idx = serverPersonas.findIndex((p) => p.id === pid);
        if (idx >= 0) serverPersonas.splice(idx, 1);
        return mcpOk(body.id, { isError: false, content: [{ type: "text", text: `persona_id='${pid}'` }] });
      }
      if (body.method === "tools/call" && (body.params?.name === "read_file" || body.params?.name === "write_file")) {
        // Skill install loop — must SUCCEED so the persona sync (gated on a
        // verified install) runs: per-path virtual workspace.
        if (body.params?.name === "write_file") {
          workspaceFiles.set(String(body.params.arguments?.target_file || ""), String(body.params.arguments?.content || ""));
          return mcpOk(body.id, { isError: false, content: [{ type: "text", text: "written" }] });
        }
        const stored = workspaceFiles.get(String(body.params.arguments?.target_file || ""));
        if (stored == null) return mcpOk(body.id, { isError: true, content: [{ type: "text", text: "code: read_failed" }] });
        return mcpOk(body.id, { isError: false, content: [{ type: "text", text: JSON.stringify([stored, "kind='file_ref'"]) }] });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
    }
    return sseResponse(zoSseText({ text: "ok" }));
  });
  (globalThis as any).chrome = bus;
  await import("../../extension/background.js?file=persona-flow");
  await new Promise((r) => setTimeout(r, 25));
});

async function actionTurn(sessionId: number, chatId: string, extra: Record<string, unknown> = {}) {
  const rec = connectRecorder();
  rec.post({ sessionId, type: "ASK_ZO", userQuery: "Click the first link", modeId: "cobrowse", chatId, ...extra });
  await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_DONE" || m.type === "STREAM_ERROR"), 8000);
  return zoAskCalls()[zoAskCalls().length - 1];
}

describe("persona_id lane (#415)", () => {
  it("first turn: syncs 5 builtin personas and sends persona_id with NO inline system", async () => {
    const req = await actionTurn(1, "chat-1");
    expect(createCalls.length).toBe(5);
    // The cobrowse persona carries the EXACT builtin systemPrompt.
    const co = createCalls.find((c) => c.name.startsWith("zo-cobrowse: cobrowse"));
    expect(co?.prompt).toBe(CO_SYSTEM);
    // The durable map validates its shape (validated against the Zod schema in unit tests).
    const map = await storedMap();
    expect(map.cobrowse.personaId).toBeTruthy();
    expect(map.cobrowse.prompt).toBe(CO_SYSTEM);
    // The wire: persona_id rides; the inline system section is GONE.
    expect(req.body.persona_id).toBe(map.cobrowse.personaId);
    expect(req.body.input).not.toContain("AI co-browsing assistant");
    // Page/action canon still rides inline (only the system section moved).
    expect(req.body.input).toContain("## User Request");
  });

  it("second turn (same version): no re-sync, persona still rides", async () => {
    const creates = createCalls.length;
    const req = await actionTurn(2, "chat-2");
    expect(createCalls.length).toBe(creates);
    expect(req.body.persona_id).toBeTruthy();
    expect(req.body.input).not.toContain("AI co-browsing assistant");
  });

  it("read modes get their own persona (ask mode drops ITS system text)", async () => {
    const rec = connectRecorder();
    rec.post({ sessionId: 3, type: "ASK_ZO", userQuery: "what is this page?", modeId: "ask", chatId: "chat-3" });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_DONE" || m.type === "STREAM_ERROR"), 8000);
    const req = zoAskCalls()[zoAskCalls().length - 1];
    const map = await storedMap();
    expect(req.body.persona_id).toBe(map.ask.personaId);
    expect(req.body.input).not.toContain("browser companion");
  });

  it("user-tuned system overrides fail closed: no persona, inline rides", async () => {
    const req = await actionTurn(4, "chat-4", { modeOverrides: { cobrowse: { systemPrompt: "You are TUNED — my own framing." } } });
    expect(req.body.persona_id).toBeUndefined();
    expect(req.body.input).toContain("You are TUNED — my own framing.");
  });

  it("send-time drift fails closed: corrupted stored prompt → inline system", async () => {
    const map = await storedMap();
    map.cobrowse.prompt = CO_SYSTEM + " (corrupted)";
    await bus.storage.local.set({ cobrowse_personas: map });
    const req = await actionTurn(6, "chat-6");
    expect(req.body.persona_id).toBeUndefined();
    expect(req.body.input).toContain("AI co-browsing assistant");
  });

  it("lost storage re-adopts by name (no re-create) after a version bump", async () => {
    await bus.storage.local.set({ cobrowse_personas: {} });
    bus.runtime._manifestVersion = "9.9.9.9";
    const creates = createCalls.length;
    const req = await actionTurn(7, "chat-7");
    // No create_persona calls — the listed names (prompt-hash-embedded) matched.
    expect(createCalls.length).toBe(creates);
    // The skill re-installed (new version) but personas were adopted.
    const map = await storedMap();
    expect(map.cobrowse.personaId).toBeTruthy();
    expect(map.cobrowse.prompt).toBe(CO_SYSTEM);
    expect(req.body.persona_id).toBe(map.cobrowse.personaId);
    expect(req.body.input).not.toContain("AI co-browsing assistant");
  });

  it("user-configured persona routing wins: their id rides, inline system stays (runs last — routing sticks in config)", async () => {
    // Through the real storage.set path — the startup hydration already ran,
    // so the value must arrive via the onChanged listener.
    await bus.storage.sync.set({ zoPersonaId: "user-configured-persona" });
    await new Promise((r) => setTimeout(r, 10));
    const req = await actionTurn(5, "chat-5");
    expect(req.body.persona_id).toBe("user-configured-persona");
    expect(req.body.input).toContain("AI co-browsing assistant");
  });
});
