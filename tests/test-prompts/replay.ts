/**
 * replay.ts — Replay captured .sse fixture bytes through the real Zo-cobrowse
 * stream parsers (extractStreamContent, finishStream, safeText) extracted from
 * extension/background.js via the shared sandbox helper (tests/helpers/vm-sandbox.ts).
 *
 * Usage:
 *   import { replaySse, replaySseFromFile } from "./replay.js";
 *   const result = await replaySse(sseRawContent);
 *
 * This mirrors the production byte-loop at background.js:876-981 and the
 * finishStream path at :988-1034, emitting the same STREAM_CHUNK, STREAM_DONE,
 * and STREAM_ERROR messages the extension would produce.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { runInSandbox } from "../helpers/vm-sandbox";
import { normalizeActions } from "../../extension/lib/modes.js";
import { safeText } from "../../extension/lib/prompt.js";

import type { ReplayResult, StreamMessage } from "./schema.js";

// ── Load background.js source ──────────────────────────────────────────────
const BG_PATH = resolve(import.meta.dir, "..", "..", "extension", "background.js");

let bgSource: string;
try {
  bgSource = readFileSync(BG_PATH, "utf-8");
} catch (err) {
  throw new Error(`Cannot read background.js at ${BG_PATH}: ${(err as Error).message}`);
}

// ── VM-extract helper functions ────────────────────────────────────────────

/** Find the brace-matched end of a function at `start` index */
function braceEnd(src: string, start: number): number {
  let depth = 0;
  let started = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") { depth++; started = true; } else if (src[i] === "}") {
      depth--;
      if (started && depth === 0) return i + 1;
    }
  }
  return start;
}

/** Brace-match the body of a function whose signature starts at `fnStart`.
 *  Finds the first `{` after the signature's closing `)` so a default-param
 *  `{}` (e.g. `extra = {}`) inside the signature isn't mistaken for the body. */
function braceEndFromBody(src: string, fnStart: number): number {
  const sigEnd = src.indexOf(")", fnStart);
  if (sigEnd === -1) throw new Error("Could not find signature end");
  return braceEnd(src, src.indexOf("{", sigEnd));
}

// stripCodeFence + parseZoOutput — now canonical in lib/parse-output.js
// (finishStream's parse half moved there so the read_tab loop and the replay
// harness share one implementation, no VM slice, no reimplementation drift).
import { stripCodeFence, parseZoOutput } from "../../extension/lib/parse-output.js";

// summarizeToolResult — faithful reimplementation of background.js's tool-
// result truncation (used by the replay byte-loop's STREAM_TOOL emission).
function summarizeToolResult(result: any): string {
  if (result == null) return "";
  if (typeof result === "string") return result.slice(0, 300);
  const content = result.content;
  let body = "";
  const t = (v: any) => (typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return ""; } })());
  if (typeof content === "string") body = content;
  else if (content && typeof content === "object") {
    body = t(content.stdout || content.text || content.message || "");
    if (content.stderr) body += (body ? "\n" : "") + t(content.stderr);
  } else if (result.output != null) body = t(result.output);
  else { try { body = JSON.stringify(result); } catch { body = ""; } }
  return body.slice(0, 300);
}

// safePost — faithful reimplementation of background.js's port-post helper
// (post a message to a streaming port, tolerating disconnects). finishStream
// uses it to emit STREAM_* messages; replaySse's recording port stands in for
// a real runtime port. Mirrors background.js byte-for-byte.
function safePost(port: any, msg: any): boolean {
  if (!port || (port as any)._dead) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    (port as any)._dead = true;
    return false;
  }
}

interface LoadedParsers {
  extractStreamContent: (parsed: any) => string;
  safeText: (input: any) => string;
  finishStream: (port: any, sid: string, output: any, extra?: any) => void;
  safePost: (port: any, msg: any) => boolean;
  stripCodeFence: (str: any) => any;
  summarizeToolResult: (result: any) => string;
}

let loadedParsers: LoadedParsers | null = null;

function loadParsers(): LoadedParsers {
  if (loadedParsers) return loadedParsers;

  // Only finishStream is still VM-extracted from background.js (too large to
  // re-implement like the helpers above). safeText + safePost are injected
  // directly from their pure/reimpl forms so the extracted finishStream can
  // call them as free variables. braceEndFromBody starts brace-matching at
  // the function BODY's `{` (not the signature), so a default-param `{}`
  // such as `finishStream(port, sid, output, extra = {})` isn't mistaken for it.
  const fsStart = bgSource.indexOf("function finishStream(");
  const fsEnd = braceEndFromBody(bgSource, fsStart);

  // Build sandbox
  const sandbox: any = {
    normalizeActions,
    // safeText is imported from the pure lib/prompt.js (single source of
    // truth, shared with the inspector + Settings editor) and injected here so
    // the VM-extracted background functions can call it as a free variable.
    safeText,
    // safePost is re-implemented above (mirrors background.js byte-for-byte)
    // and injected so finishStream can post STREAM_* messages.
    safePost,
    // finishStream calls emitStreamDiagnostic (a diagnostics-only helper that
    // posts a STREAM_DIAGNOSTIC message). Stub it as a no-op so the slice can
    // run without pulling in sessionEventShapes / safePost wiring.
    emitStreamDiagnostic: () => {},
  // finishStream also calls stripCodeFence + parseZoOutput. Both now live in
  // lib/parse-output.js — imported above and injected as free variables so the
  // replay exercises the exact production parse without a VM slice.
    stripCodeFence,
    parseZoOutput,
    summarizeToolResult,
    console: { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} },
  };
  // safeText + safePost are injected above (no longer VM-extracted). The
  // remaining extractions (extractStreamContent, finishStream) still run their
  // background.js source slices in this sandbox.

  // For extractStreamContent: find the function start (it has a comment marker)
  // Pattern: locate "function extractStreamContent("
  const escStart = bgSource.indexOf("function extractStreamContent(");
  if (escStart === -1) throw new Error("extractStreamContent not found in background.js");

  // Find the end of extractStreamContent: brace-match from its body `{`
  const escEnd = braceEndFromBody(bgSource, escStart);
  runInSandbox(bgSource.slice(escStart, escEnd), sandbox);

  // Run finishStream
  runInSandbox(bgSource.slice(fsStart, fsEnd), sandbox);

  // Verify
  for (const fn of ["extractStreamContent", "safeText", "finishStream", "safePost", "stripCodeFence", "summarizeToolResult"]) {
    if (typeof sandbox[fn] !== "function") {
      throw new Error(`Failed to load ${fn} from background.js`);
    }
  }

  loadedParsers = sandbox as unknown as LoadedParsers;
  return loadedParsers;
}

// ── SSE byte-loop replay (mirrors background.js:876-981) ────────────────────
//
// Drives a buffered line reader over the raw .sse bytes, tracks event: and
// data: lines, feeds JSON data through extractStreamContent and accumulation,
// and dispatches to finishStream on End / [DONE] / stream-close.
//
// Instead of a real fetch Reader, we take the full .sse text and simulate the
// byte-loop feeding it as a single chunk (mirrors the test approach in
// tests/sse-parsing.test.ts:parseSseStream but produces STREAM_* messages).

export function replaySse(sseRaw: string): ReplayResult {
  const parsers = loadParsers();
  const { extractStreamContent, safeText, finishStream, safePost, stripCodeFence: _scf, summarizeToolResult } = parsers;

  // Recording port — collects every posted STREAM_* message
  const messages: StreamMessage[] = [];
  const recordingPort = {
    _dead: false,
    postMessage: (msg: any) => {
      messages.push(msg);
    },
  };

  // Session id for finishStream (not used in recording, but required)
  const SID = "test-session";

  // Byte-loop state (mirrors background.js)
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  // Three-channel routing (mirrors background.js _askZoStreamImpl): partKinds
  // maps a part index → kind; reasoningText accumulates the thinking channel.
  const partKinds: Record<number, string> = {};
  let reasoningText = "";
  let currentEventType = "";

  // Send bytes to the decoder as one chunk
  buffer += decoder.decode(new TextEncoder().encode(sseRaw), { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  // Track the last data payload for edge-case handling
  let lastData = "";
  let endedVia = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;

    // event: <type> (with or without space after colon)
    if (trimmed.startsWith("event:")) {
      currentEventType = trimmed.slice(6).trim();
      continue;
    }

    // data: <payload>
    const dataMatch = trimmed.match(/^data:\s?(.*)$/);
    if (!dataMatch) continue;
    const data = dataMatch[1].trim();
    lastData = data;
    if (!data) continue;

    // ── End event ──────────────────────────────────────────────────────────
    if (currentEventType === "End") {
      endedVia = "End";
      if (data !== "{}" && data !== "") {
        try {
          const parsed = JSON.parse(data);
          if (!fullText) {
            const endContent = typeof parsed.output === "string" ? parsed.output : "";
            fullText =
              endContent ||
              extractStreamContent(parsed) ||
              (parsed.reasoning || parsed.actions ? safeText(parsed) : "");
          }
        } catch {
          // non-JSON payload
        }
      }
      finishStream(recordingPort, SID, data === "{}" ? fullText : data, { reasoning: reasoningText });
      currentEventType = "";
      continue;
    }

    // ── Error event ────────────────────────────────────────────────────────
    if (currentEventType === "Error") {
      endedVia = "Error";
      let errorMsg = data;
      try {
        const parsed = JSON.parse(data);
        errorMsg = parsed.message || data;
      } catch {}
      safePost(recordingPort, { type: "STREAM_ERROR", error: errorMsg });
      currentEventType = "";
      continue;
    }

    // ── completed (real Zo terminal; see tests/test-prompts/qa-notes.md) ───
    if (currentEventType === "completed") {
      endedVia = "completed";
      finishStream(recordingPort, SID, fullText, { reasoning: reasoningText });
      currentEventType = "";
      continue;
    }

    // ── Real Zo content events ─────────────────────────────────────────────
    try {
      const parsed = JSON.parse(data);
      if (currentEventType === "PartStartEvent") {
        const part = parsed.part || {};
        if (part.part_kind) partKinds[parsed.index] = part.part_kind;
        const kind = part.part_kind || partKinds[parsed.index] || "";
        const piece = safeText(part.content || part.args);
        if (piece && kind === "thinking") {
          reasoningText += piece;
          // For chronological feed, send only the delta (not cumulative text)
          safePost(recordingPort, { type: "STREAM_REASONING", text: piece });
        } else if (piece && kind === "text") {
          fullText += piece;
          // For chronological feed, send only the delta (not cumulative text)
          safePost(recordingPort, { type: "STREAM_CHUNK", text: piece });
        }
        currentEventType = "";
        continue;
      }
      if (currentEventType === "PartDeltaEvent") {
        const delta = parsed.delta || {};
        const kind = delta.part_delta_kind || partKinds[parsed.index] || "";
        const piece = safeText(delta.content_delta);
        if (piece && kind === "thinking") {
          reasoningText += piece;
          // For chronological feed, send only the delta (not cumulative text)
          safePost(recordingPort, { type: "STREAM_REASONING", text: piece });
        } else if (piece && kind === "text") {
          fullText += piece;
          // For chronological feed, send only the delta (not cumulative text)
          safePost(recordingPort, { type: "STREAM_CHUNK", text: piece });
        } else {
          // Unknown shape — fall back to content extraction.
          const content = extractStreamContent(parsed);
          if (content) {
            fullText += content;
            // For chronological feed, send only the delta (not cumulative text)
            safePost(recordingPort, { type: "STREAM_CHUNK", text: content });
          }
        }
        currentEventType = "";
        continue;
      }
      if (currentEventType === "FunctionToolCallEvent" || parsed.event_kind === "function_tool_call") {
        const part = parsed.part || {};
        safePost(recordingPort, {
          type: "STREAM_TOOL",
          phase: "call",
          callId: part.tool_call_id ?? null,
          toolName: part.tool_name ?? null,
          args: safeText(part.args),
        });
        currentEventType = "";
        continue;
      }
      if (currentEventType === "FunctionToolResultEvent" || parsed.event_kind === "function_tool_result") {
        const result = parsed.result || {};
        const part = parsed.part || {};
        safePost(recordingPort, {
          type: "STREAM_TOOL",
          phase: "result",
          callId: (part.tool_call_id || result.tool_call_id) ?? null,
          toolName: (part.tool_name || result.tool_name) ?? null,
          outcome: result.outcome || (result.error ? "error" : "success"),
          result: summarizeToolResult(result),
        });
        currentEventType = "";
        continue;
      }

      // ── Default (FrontendModelResponse or no event name) ─────────────────
      const content = extractStreamContent(parsed);
      if (content) {
        fullText += content;
        safePost(recordingPort, { type: "STREAM_CHUNK", text: fullText });
      }
      // Legacy completion markers
      if (
        parsed.done ||
        parsed.finish_reason ||
        parsed.type === "final" ||
        parsed.type === "complete" ||
        parsed.type === "End"
      ) {
        endedVia = "legacy-complete";
        finishStream(recordingPort, SID, fullText, { reasoning: reasoningText });
      }
    } catch {
      // Non-JSON data line
      if (data === "[DONE]") {
        endedVia = "[DONE]";
        finishStream(recordingPort, SID, fullText, { reasoning: reasoningText });
      } else {
        fullText += safeText(data);
        safePost(recordingPort, { type: "STREAM_CHUNK", text: fullText });
      }
    }
    currentEventType = "";
  }

  // Stream closed without a terminal event
  if (!endedVia && (fullText || reasoningText)) {
    finishStream(recordingPort, SID, fullText, { reasoning: reasoningText });
    endedVia = "stream-close";
  }

  // Classify terminal
  const lastMsg = messages[messages.length - 1];
  let terminal: ReplayResult["terminal"] = "done";
  if (lastMsg?.type === "STREAM_ERROR") terminal = "error";

  // Find final values
  const doneMsg = messages.find((m) => m.type === "STREAM_DONE") as any;
  const errorMsg = messages.find((m) => m.type === "STREAM_ERROR");

  return {
    messages,
    terminal,
    finalFullText: doneMsg?.fullText,
    finalReasoning: doneMsg?.reasoning,
    finalActions: doneMsg?.actions,
  };
}

/**
 * Read a .sse fixture file and replay it through the real parsers.
 */
export function replaySseFromFile(ssePath: string): ReplayResult {
  const raw = readFileSync(ssePath, "utf-8");
  return replaySse(raw);
}

/**
 * Read a .sse file and return the parsed event sequence (event + data).
 * Useful for schema validation before replay.
 */
export function parseFixtureEvents(sseRaw: string): Array<{ event: string; data: string; parsed?: any }> {
  const events: Array<{ event: string; data: string; parsed?: any }> = [];
  let currentEvent = "";

  const lines = sseRaw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;

    if (trimmed.startsWith("event:")) {
      currentEvent = trimmed.slice(6).trim();
      continue;
    }
    const dataMatch = trimmed.match(/^data:\s?(.*)$/);
    if (!dataMatch) continue;
    const data = dataMatch[1].trim();
    if (!data) continue;

    let parsed: any = undefined;
    try { parsed = JSON.parse(data); } catch {}
    events.push({ event: currentEvent, data, parsed });
    currentEvent = "";
  }

  return events;
}
