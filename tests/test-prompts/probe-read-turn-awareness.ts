#!/usr/bin/env bun
/**
 * #414 probe — does Zo auto-discover workspace skills on READ turns (no
 * skill pointer in the prompt)? Decides the read-turn half of the 0.3.7.0
 * skill-lifecycle slate: pointer on read turns only if the probe says Zo
 * does NOT auto-discover.
 *
 *   bun --env-file=.env tests/test-prompts/probe-read-turn-awareness.ts
 *
 * Method (≤4 paid requests):
 *   1. MCP read_file the installed SKILL.md — capture the original for restore.
 *   2. MCP write_file the bundled skill (SKILL.md + references) with a UNIQUE
 *      probe version `0.0.0-probe-<ts>`. That version string exists nowhere
 *      else (not on GitHub, not web-searchable) — only reading the workspace
 *      copy can answer a question about it.
 *   3. /zo/ask (NO pointer, NO page content — a bare read turn):
 *      Q1 "what value is in metadata.version of the installed zo-cobrowse
 *      skill's frontmatter?" — GO signal: the reply contains the probe version.
 *      Q2 "which bang command records manual actions into a repeatable
 *      workflow?" — corroborating signal (`!recipe record` lives in the skill).
 *   4. Restore the original SKILL.md content (or, if none existed, write the
 *      bundled files at the repo's manifest version — the state a current
 *      extension install produces).
 *
 * Verdict: AUTO_DISCOVERY=go|no (Q1 is the decider; Q2 corroborates).
 * Exit 0 when the probe ran (verdict may be negative). Transcript prints +
 * saves to tests/test-prompts/fixtures/read-turn-awareness-probe.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { mcpRequest, mcpNotification, initializeParams, toolCallParams, parseMcpMessage, toolText, isToolError } from "../../extension/lib/mcp.js";
import { injectVersion, PROTOCOL_SKILL_PATH, PROTOCOL_SKILL_DIR, BUNDLED_REFERENCE_PATHS, workspaceReferencePath } from "../../extension/lib/protocol-skill.js";

const TOKEN = process.env.ZO_API_KEY || process.env.ZO_ACCESS_TOKEN || "";
if (!TOKEN) {
  console.error("probe-read-turn-awareness: ZO_API_KEY missing (bun --env-file=.env)");
  process.exit(2);
}
const API = "https://api.zo.computer";
const PROBE_VERSION = `0.0.0-probe-${Date.now()}`;
const SKILL_MD = readFileSync(resolve(import.meta.dir, "../../extension/skills/zo-cobrowse/SKILL.md"), "utf-8");
const REF_FILES: Record<string, string> = {};
for (const ref of BUNDLED_REFERENCE_PATHS) {
  REF_FILES[workspaceReferencePath(ref) || ""] = readFileSync(resolve(import.meta.dir, "../../extension", ref), "utf-8");
}
const MANIFEST_VERSION = (JSON.parse(readFileSync(resolve(import.meta.dir, "../../extension/manifest.json"), "utf-8")) as { version: string }).version;

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

async function ask(input: string): Promise<string> {
  const res = await fetch(`${API}/zo/ask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return typeof data?.output === "string" ? data.output : JSON.stringify(data?.output ?? data);
}

async function writeSkill(version: string, skillMd: string): Promise<void> {
  await mcpTool("write_file", { target_file: PROTOCOL_SKILL_PATH, content: injectVersion(skillMd, version) });
  for (const [wsPath, text] of Object.entries(REF_FILES)) {
    await mcpTool("write_file", { target_file: wsPath, content: text });
  }
}

const transcript: Record<string, unknown> = { probeVersion: PROBE_VERSION, at: new Date().toISOString() };

// 1. capture the original installed copy for restore.
let original: string | null = null;
try {
  const raw = await mcpTool("read_file", { target_file: PROTOCOL_SKILL_PATH });
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") original = parsed[0];
  } catch { original = raw; }
  transcript.originalCaptured = Boolean(original);
} catch (err) {
  transcript.originalCaptured = false;
  transcript.originalError = String(err);
}

// 2. install the probe-versioned skill.
await writeSkill(PROBE_VERSION, SKILL_MD);
transcript.probeInstalled = true;

// 3a. Q1 — the decider (unique version string, no pointer in the prompt).
const Q1 = `What exact value is in the metadata.version field of the frontmatter of the zo-cobrowse skill installed in this workspace at ${PROTOCOL_SKILL_DIR}? Reply with just that value, or the word UNKNOWN if you cannot check.`;
const A1 = await ask(Q1);
transcript.q1 = { question: Q1, answer: A1, hit: A1.includes(PROBE_VERSION) };

// 3b. Q2 — corroborating feature-awareness signal.
const Q2 = "In the Zo Co-browse browser extension, which bang command records the user's manual page actions into a repeatable multi-page workflow? Reply with just the command, or the word UNKNOWN.";
const A2 = await ask(Q2);
transcript.q2 = { question: Q2, answer: A2, hit: /recipe\s+record/i.test(A2) };

// 4. restore: original bytes when one existed; otherwise leave the workspace
// the way a current-version extension install would.
if (original) {
  await mcpTool("write_file", { target_file: PROTOCOL_SKILL_PATH, content: original });
} else {
  await writeSkill(MANIFEST_VERSION, SKILL_MD);
}
transcript.restored = original ? "original" : `bundled@${MANIFEST_VERSION}`;

const verdict = transcript.q1.hit ? "go" : "no";
transcript.verdict = verdict;

mkdirSync(resolve(import.meta.dir, "fixtures"), { recursive: true });
writeFileSync(resolve(import.meta.dir, "fixtures/read-turn-awareness-probe.json"), JSON.stringify(transcript, null, 2) + "\n");

console.log("=== probe-read-turn-awareness ===");
console.log("Q1 (unique version, no pointer):", JSON.stringify(A1), "→ hit:", transcript.q1.hit);
console.log("Q2 (feature recall):            ", JSON.stringify(A2), "→ hit:", transcript.q2.hit);
console.log("verdict: AUTO_DISCOVERY=" + verdict);
console.log("transcript: tests/test-prompts/fixtures/read-turn-awareness-probe.json");
