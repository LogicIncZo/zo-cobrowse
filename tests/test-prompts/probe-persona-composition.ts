#!/usr/bin/env bun
/**
 * #415 spike — persona_id lane for 0.3.7.0: can the builtin Modes' per-turn
 * `system` section move server-side into per-mode personas WITHOUT breaking
 * custom Modes or thread rotation?
 *
 *   bun --env-file=.env tests/test-prompts/probe-persona-composition.ts
 *
 * Builds on #239 (probe-persona-system.ts, GO: persona composes server-side
 * with inline text). This spike answers the two OPEN questions the slate
 * pinned as build gates:
 *   S1. composition with a CUSTOM-mode inline system text — both the persona
 *       framing AND the custom system text honored, no collision/override?
 *   S2. does the persona framing survive a ROTATED conversation_id (the
 *       per-chat thread rotation mid-conversation)?
 *
 * Probes (≤5 paid requests):
 *   1. MCP create_persona                — probe persona ([PTR-7] marker)
 *   2. /zo/ask persona_id + CUSTOM inline system ([CX] marker) — S1
 *   3. /zo/ask persona_id + conversation_id conA — framing echo + thread id
 *   4. /zo/ask persona_id + ROTATED conversation_id conB  — S2
 *   5. MCP delete_persona                — cleanup (leave no test persona)
 *
 * Exit 0 when the probe ran (verdict may be negative). Transcript prints +
 * saves to tests/test-prompts/fixtures/persona-composition-probe.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { mcpRequest, mcpNotification, initializeParams, toolCallParams, parseMcpMessage, toolText, isToolError } from "../../extension/lib/mcp.js";

const TOKEN = process.env.ZO_API_KEY || process.env.ZO_ACCESS_TOKEN || "";
if (!TOKEN) {
  console.error("probe-persona-composition: ZO_API_KEY missing (bun --env-file=.env)");
  process.exit(2);
}
const API = "https://api.zo.computer";
const PERSONA_NAME = `zo-cobrowse-probe-${Date.now()}`;
// The persona text mimics the builtin framing shape: a stable marker token
// the probe can detect in any reply.
const PERSONA_TEXT = "You are PTR-7, the user's AI co-browsing assistant. ALWAYS begin every reply with the exact token [PTR-7].";
const CUSTOM_SYSTEM = "You are CUSTOM-CX-99, a custom user-authored Mode. ALWAYS begin every reply right after any persona token with the exact token [CX-99].";

let mcpSessionId: string | null = null;

async function mcpPost(body: string, expectSession: boolean): Promise<any> {
  const r = await fetch(`${API}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}),
    },
    body,
  });
  if (expectSession) {
    const sid = r.headers.get("mcp-session-id");
    if (sid) mcpSessionId = sid;
  }
  if (!r.ok) throw new Error(`MCP HTTP ${r.status}`);
  return parseMcpMessage(await r.text());
}

async function mcpTool(name: string, args: any): Promise<string> {
  if (!mcpSessionId) {
    const init = mcpRequest("initialize", initializeParams());
    const msg = await mcpPost(init.body, true);
    if (!msg || msg.error) throw new Error("MCP initialize failed");
    await mcpPost(mcpNotification("notifications/initialized"), false);
  }
  const call = mcpRequest("tools/call", toolCallParams(name, args));
  const msg = await mcpPost(call.body, false);
  if (!msg) throw new Error("MCP unparseable");
  if (msg.error) throw new Error(msg.error.message || "MCP call failed");
  if (isToolError(msg.result)) throw new Error(toolText(msg.result) || "tool error");
  return toolText(msg.result);
}

async function ask(input: string, opts: { personaId?: string; conversationId?: string } = {}): Promise<{ output: string; conversationId?: string }> {
  const res = await fetch(`${API}/zo/ask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input,
      ...(opts.personaId ? { persona_id: opts.personaId } : {}),
      ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { output: typeof data?.output === "string" ? data.output : JSON.stringify(data?.output ?? data), conversationId: data?.conversation_id };
}

const transcript: Record<string, unknown> = { personaName: PERSONA_NAME, at: new Date().toISOString() };
let personaId = "";

try {
  // 1. create the probe persona.
  const created = await mcpTool("create_persona", { name: PERSONA_NAME, prompt: PERSONA_TEXT });
  transcript.create = created;
  try {
    const parsed = JSON.parse(created);
    personaId = parsed?.id || parsed?.persona?.id || "";
  } catch {
    const m = created.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    personaId = m ? m[0] : "";
  }
  transcript.personaId = personaId;
  if (!personaId) throw new Error("create_persona returned no id — spike cannot proceed");

  // 2. S1 — persona_id + a CUSTOM-mode inline system text: both markers?
  //    The response also echoes a REAL conversation_id (con_A) for the
  //    rotation probes below — invented con_* ids 404 ("Conversation not
  //    found", live-verified); threads must exist.
  const s1 = await ask(
    `${CUSTOM_SYSTEM}\n\n## User Request\nSay hello in one short sentence.`,
    { personaId },
  );
  const conA = s1.conversationId || "";
  transcript.s1 = {
    answer: s1.output,
    personaHonored: s1.output.includes("[PTR-7]"),
    customHonored: s1.output.includes("[CX-99]"),
    echoedConversationId: conA,
  };

  // 3. thread A — framing on an ESTABLISHED real thread.
  const tA = conA ? await ask("Say hello in one short sentence.", { personaId, conversationId: conA }) : null;
  transcript.threadA = tA
    ? { answer: tA.output, echoedConversationId: tA.conversationId || "", personaHonored: tA.output.includes("[PTR-7]") }
    : { skipped: "no conversation id echoed" };

  // 4. S2 — ROTATED thread: create a second REAL thread, then ride it with
  //    the persona. Rotation survives when the framing applies there too.
  const seedB = await ask("Reply with just: ping");
  const conB = seedB.conversationId || "";
  const tB = conB ? await ask("Say hello in one short sentence.", { personaId, conversationId: conB }) : null;
  transcript.threadB = {
    rotatedConversationId: conB,
    answer: tB?.output || "",
    echoedConversationId: tB?.conversationId || "",
    personaHonored: Boolean(tB && tB.output.includes("[PTR-7]")),
    rotationSurvived: Boolean(tB && tB.output.includes("[PTR-7]")),
  };

  transcript.verdict = {
    compositionWithCustom: transcript.s1.personaHonored && transcript.s1.customHonored ? "go" : "no-go",
    threadRotation: transcript.threadB.rotationSurvived ? "go" : "no-go",
  };
} finally {
  if (personaId) {
    try { await mcpTool("delete_persona", { persona_id: personaId }); transcript.cleanup = "deleted"; } catch (err) { transcript.cleanup = `delete failed: ${err}`; }
  }
}

mkdirSync(resolve(import.meta.dir, "fixtures"), { recursive: true });
writeFileSync(resolve(import.meta.dir, "fixtures/persona-composition-probe.json"), JSON.stringify(transcript, null, 2) + "\n");

console.log("=== probe-persona-composition ===");
const s1: any = transcript.s1 || {};
console.log("S1 composition:", JSON.stringify(s1.answer || "").slice(0, 200), "| persona:", s1.personaHonored, "| custom:", s1.customHonored);
const tb: any = transcript.threadB || {};
console.log("S2 rotation:   ", JSON.stringify(tb.answer || "").slice(0, 200), "| persona:", tb.personaHonored);
console.log("verdict:", JSON.stringify(transcript.verdict));
console.log("transcript: tests/test-prompts/fixtures/persona-composition-probe.json");
