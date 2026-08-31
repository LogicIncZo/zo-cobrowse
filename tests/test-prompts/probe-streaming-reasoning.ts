#!/usr/bin/env bun
/**
 * Streaming-reasoning probe (0.2.7 Lane D item 8 live verification).
 *
 *   bun --env-file=.env tests/test-prompts/probe-streaming-reasoning.ts
 *   PROBE_MODEL="zo:anthropic/claude-…" bun --env-file=.env tests/test-prompts/probe-streaming-reasoning.ts
 *
 * Answers the open question: does the live /zo/ask SSE stream emit reasoning
 * INCREMENTALLY (before the terminal event), or does reasoning only arrive in
 * the final payload? The extension already renders incremental thinking
 * (STREAM_REASONING from PartDeltaEvent part_delta_kind:"thinking" deltas) —
 * this probe verifies which shapes real servers emit, per model, and whether
 * the existing handling is fed on the wire.
 *
 * Method: one reasoning-heavy prompt, stream:true; every SSE event's type and
 * top-level data keys are recorded in arrival order. "Incremental" = a
 * reasoning-bearing event/field observed strictly BEFORE the terminal event.
 *
 * Exit 0 when the probe ran to a terminal event (verdict may be negative).
 */

const TOKEN = process.env.ZO_API_KEY || process.env.ZO_ACCESS_TOKEN || "";
if (!TOKEN) {
  console.error("probe-streaming-reasoning: ZO_API_KEY missing (bun --env-file=.env)");
  process.exit(2);
}

const API = "https://api.zo.computer/zo/ask";
const MODELS = (process.env.PROBE_MODEL || "zo:openai/gpt-5.6-sol")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PROMPT = "Think through this step by step (show your reasoning), then answer: A snail climbs 3 meters each day and slips back 2 meters each night. How many days until it exits a 10 meter well? Explain every intermediate step.";

const REASONING_KEYS = ["thinking", "reasoning", "reasoning_content", "reasoning_text", "thought"];
const TERMINAL_EVENTS = new Set(["completed", "failed", "End", "done", "error"]);

function isReasoningData(data) {
  if (data == null || typeof data !== "object") return false;
  const direct = Object.keys(data).some((k) => REASONING_KEYS.includes(k) && data[k]);
  if (direct) return true;
  // nested shapes: {delta: {part_delta_kind: "thinking", content_delta: …}}, {part: {content: …}}
  const delta = data.delta;
  if (delta && typeof delta === "object" && String(delta.part_delta_kind) === "thinking" && delta.content_delta) return true;
  if (data.part && typeof data.part === "object") {
    const kind = String(data.part.part_kind || "");
    if (kind.includes("thinking") || kind.includes("reasoning")) return true;
  }
  return false;
}

async function probe(model) {
  console.log(`\n=== model: ${model} ===`);
  const t0 = Date.now();
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ input: PROMPT, model_name: model, stream: true }),
  });
  console.log(`HTTP ${res.status} · content-type: ${res.headers.get("content-type")}`);
  if (!res.ok || !res.body) {
    console.log(`✗ request failed: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return false;
  }

  /** event type → { count, firstIndex, keys:Set, reasoningSeen:boolean } */
  const shapes = new Map();
  let idx = 0;
  let terminalAt = -1;
  let firstReasoningAt = -1;
  let finalOutput = "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let data;
      try { data = JSON.parse(raw); } catch { continue; }
      const evType = String(data.type ?? data.event ?? data.status ?? "data");
      const s = shapes.get(evType) || { count: 0, firstIndex: idx, keys: new Set(), reasoningSeen: false };
      s.count++;
      Object.keys(data).forEach((k) => s.keys.add(k));
      s.reasoningSeen = s.reasoningSeen || isReasoningData(data);
      shapes.set(evType, s);
      if (firstReasoningAt === -1 && isReasoningData(data)) firstReasoningAt = idx;
      if (TERMINAL_EVENTS.has(evType) && terminalAt === -1) terminalAt = idx;
      if (data.output) finalOutput = String(data.output);
      idx++;
    }
  }

  console.log(`events: ${idx} · elapsed ${(Date.now() - t0) / 1000 | 0}s · terminal event at #${terminalAt}`);
  console.log("shape timeline:");
  for (const [evType, s] of shapes) {
    const reason = s.reasoningSeen ? "  ⇐ carries reasoning" : "";
    console.log(`  ${s.firstIndex === terminalAt && terminalAt !== -1 ? "[terminal] " : ""}${evType} ×${s.count} (first@#${s.firstIndex}, keys: ${[...s.keys].slice(0, 8).join(",")})${reason}`);
  }
  const verdict = firstReasoningAt !== -1 && (terminalAt === -1 || firstReasoningAt < terminalAt)
    ? "INCREMENTAL: reasoning streams before the terminal event — the existing STREAM_REASONING path is fed on the wire"
    : "FINAL-ONLY: no reasoning observed before the terminal event (or none emitted at all)";
  console.log(`VERDICT: ${verdict}`);
  console.log(`final output length: ${finalOutput.length}`);
  return true;
}

let ok = true;
for (const model of MODELS) {
  try {
    const ran = await probe(model);
    ok = ok && ran;
  } catch (err) {
    console.log(`✗ ${model}: ${err.message}`);
    ok = false;
  }
}
process.exit(ok ? 0 : 1);
