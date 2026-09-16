#!/usr/bin/env bun
/**
 * #239 spike — can the per-turn `system` section (~27 tok) move server-side
 * into a custom persona?
 *
 *   bun --env-file=.env tests/test-prompts/probe-persona-system.ts
 *
 * Known before probing (slate-planning corrections, recorded in-issue):
 * the extension ALREADY sends persona_id on /zo/ask when configured
 * (config.zoPersonaId) and fetches /personas/available; the pinned MCP
 * baseline ships create_persona / edit_persona / delete_persona /
 * set_persona_scopes.
 *
 * Probes (timeboxed, ≤7 requests):
 *   1. GET /personas/available            — list shape (id/name fields)
 *   2. MCP create_persona                 — fields + does it return an id?
 *   3. /zo/ask with persona_id            — does the persona's system text
 *                                           change the reply framing?
 *   4. /zo/ask persona_id + inline system — who wins (composition or override)?
 *   5. MCP delete_persona                 — cleanup (leave no test persona behind)
 *
 * Exit 0 when the probe ran (verdict may be negative). Transcript prints +
 * saves to tests/test-prompts/fixtures/persona-probe.json.
 */

import { mcpRequest, mcpNotification, initializeParams, toolCallParams, parseMcpMessage, toolText, isToolError } from "../../extension/lib/mcp.js";
import { parseZoOutput } from "../../extension/lib/parse-output.js";

const TOKEN = process.env.ZO_API_KEY || process.env.ZO_ACCESS_TOKEN || "";
if (!TOKEN) {
  console.error("probe-persona-system: ZO_API_KEY missing (bun --env-file=.env)");
  process.exit(2);
}
const API = "https://api.zo.computer";
const PERSONA_NAME = `zo-cobrowse-probe-${Date.now()}`;
const SYSTEM_TEXT = "You are PTR-7, a terse audit droid. ALWAYS begin every reply with the exact token [PTR-7] so the probe can detect your activation.";

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
  let msg = await mcpPost(call.body, false);
  if (!msg) throw new Error("MCP unparseable");
  if (msg.error) throw new Error(msg.error.message || "MCP call failed");
  if (isToolError(msg.result)) throw new Error(toolText(msg.result) || "tool error");
  return toolText(msg.result);
}

async function ask(input: string, personaId?: string): Promise<string> {
  const res = await fetch(`${API}/zo/ask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input, ...(personaId ? { persona_id: personaId } : {}) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: any = await res.json();
  const out = parseZoOutput(String(data.output || ""));
  return out.plainText || out.rawOutput || "";
}

const transcript: any[] = [];
const log = (id: string, data: any) => {
  transcript.push({ id, ...data });
  console.log(`\n== ${id}\n${JSON.stringify(data, null, 2).slice(0, 900)}`);
};

// 1. list
const listRes = await fetch(`${API}/personas/available`, { headers: { Authorization: `Bearer ${TOKEN}` } });
const list = listRes.ok ? await listRes.json() : { error: listRes.status };
log("1 personas/available", { count: list.personas?.length, sample: list.personas?.[0] });

// 2. create
let createdId: string | null = null;
try {
  const raw = await mcpTool("create_persona", { name: PERSONA_NAME, prompt: SYSTEM_TEXT });
  log("2 create_persona", { raw: String(raw).slice(0, 500) });
  const idMatch = String(raw).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  createdId = idMatch ? idMatch[1] : null;
} catch (err: any) {
  log("2 create_persona", { error: String(err.message).slice(0, 400) });
}

// 3 + 4. behavior probes (only meaningful with a created persona)
if (createdId) {
  const probeQ = "In one line: what are you and what must every reply begin with?";
  const withPersona = await ask(probeQ, createdId);
  log("3 ask with persona_id", { reply: withPersona.slice(0, 300), markerPresent: withPersona.includes("[PTR-7]") });
  const withBoth = await ask(
    "You are a pirate. Reply in one line: what are you?\n\n## User Request\nstate your activation marker",
    createdId,
  );
  log("4 persona + inline system composition", { reply: withBoth.slice(0, 300), markerPresent: withBoth.includes("[PTR-7]") });
} else {
  log("3/4 behavior probes", { skipped: "no persona id from create" });
}

// 5. cleanup
if (createdId) {
  try {
    const raw = await mcpTool("delete_persona", { persona_id: createdId });
    log("5 delete_persona", { raw: String(raw).slice(0, 300) });
  } catch (err: any) {
    log("5 delete_persona", { error: String(err.message).slice(0, 300) });
  }
}

const markerSeen = transcript.some((t) => t.markerPresent === true);
const verdict = createdId && markerSeen ? "GO — personas carry server-side system text; the per-turn system section can move" : createdId ? "PARTIAL — persona created but marker not detected in replies (composition unclear)" : "NO-GO — persona creation unavailable via MCP";
console.log(`\n===== VERDICT: ${verdict} =====`);

import { writeFileSync } from "fs";
writeFileSync(new URL("./fixtures/persona-probe.json", import.meta.url), JSON.stringify({ probedAt: new Date().toISOString(), verdict, createdId, markerSeen, transcript }, null, 2));
console.log("transcript → tests/test-prompts/fixtures/persona-probe.json");
