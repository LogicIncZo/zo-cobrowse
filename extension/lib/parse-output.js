// Zo output parsing — pure logic, no chrome.* or DOM dependencies.
// Extracted from background.js so the stream replay harness can import it
// directly (no VM slice) and so the read_tab loop can inspect a response's
// actions before the stream finishes. parseZoOutput is the parse half of the
// old finishStream; finishStream (background.js) stays the render half.

import { normalizeActions } from './modes.js';
import { safeText } from './prompt.js';

/**
 * Unwrap exactly one whole ``` fence around a string (cobrowse wraps its
 * action envelope in a ```json fence — see qa-notes.md). Non-fenced input is
 * returned untouched.
 */
export function stripCodeFence(str) {
  if (typeof str !== 'string') return str;
  const trimmed = str.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n```\s*$/);
  return match ? match[1] : str;
}

/**
 * Repair the most common model-emitted broken-JSON form: unescaped double
 * quotes inside string values — e.g. CSS attribute selectors written with
 * double quotes (`"selector":"input[name="\\30 x"]"`). The inner `"` makes
 * strict JSON.parse throw, which used to drop the whole action envelope into
 * plain-text display.
 *
 * Heuristic (only runs as a fallback after strict parse failed): walk the
 * text tracking string state; a `"` that is not already backslash-escaped and
 * is NOT followed (after whitespace) by a structural char (, : } ] or EOF)
 * is an inner quote — escape it. Already-valid JSON round-trips unchanged.
 */
export function repairJson(text) {
  if (typeof text !== 'string') return text;
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === '\\') { // keep existing escapes intact (\" \\ \30 …)
      out += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      // `"]` + `"` can't be a real terminator (array-close is never followed
      // by an opening string in valid JSON) — that's the CSS attribute
      // selector shape [name="x"] with an inner closing quote.
      const innerBeforeBracket = next === ']' && text[j + 1] === '"';
      if (!innerBeforeBracket && (next === undefined || ',:}]'.includes(next))) {
        inStr = false; // real string terminator
        out += ch;
      } else {
        out += '\\"'; // inner quote — escape it
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** Shared shape-extraction for a parsed envelope object. */
function envelopeFrom(parsed, fallbackText) {
  if (parsed && typeof parsed === 'object') {
    return {
      reasoning: parsed.reasoning || '',
      actions: normalizeActions(parsed.actions),
      rawOutput: safeText(JSON.stringify(parsed)),
      plainText: '',
    };
  }
  // JSON but not an object (number/bool) — treat as plain text.
  return { reasoning: '', actions: [], rawOutput: '', plainText: safeText(fallbackText) };
}

/**
 * Scan a narration-led output for a fenced JSON action envelope (#426 F1):
 * Zo sometimes narrates its tool use in prose and THEN emits the envelope in
 * a ```json fence — the whole-string strip in parseZoOutput can't see it.
 * Fences are scanned LAST-to-first (the envelope is conventionally the final
 * block); the first fence whose body parses (strict, then repairJson) to an
 * object with an `actions` array wins. Text outside the chosen fence is the
 * model's intermediate narration and comes back as `narration` for the
 * reasoning channel. A fenced block that is not an actions envelope (an
 * example snippet, a non-envelope JSON object) never hijacks the parse.
 *
 * @returns {{ env: object, narration: string } | null}
 */
export function extractFencedEnvelope(text) {
  if (typeof text !== 'string') return null;
  const fences = [...text.matchAll(/```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i][1];
    for (const candidate of [body, repairJson(body)]) {
      let parsed = null;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.actions)) {
        const narration = text.replace(fences[i][0], ' ').trim();
        return { env: envelopeFrom(parsed, text), narration };
      }
    }
  }
  return null;
}

/**
 * Parse a Zo output (string — possibly fenced JSON — or a response object)
 * into the standard channel triple: reasoning, actions, plainText. Never
 * throws; unparseable strings degrade to plainText.
 *
 * @returns {{ reasoning: string, actions: Array, rawOutput: string, plainText: string, normalizedOutput: any }}
 */
export function parseZoOutput(output) {
  let reasoning = '';
  let actions = [];
  let rawOutput = '';
  let plainText = ''; // non-JSON answer text, surfaced directly to the user

  // Normalize to string for consistent parsing
  const normalizedOutput = (typeof output === 'object' && output !== null)
    ? output
    : String(output ?? '');

  if (typeof normalizedOutput === 'object' && normalizedOutput !== null) {
    reasoning = normalizedOutput.reasoning || '';
    actions = normalizeActions(normalizedOutput.actions);
    rawOutput = safeText(JSON.stringify(normalizedOutput));
  } else if (typeof normalizedOutput === 'string') {
    const fencedStripped = stripCodeFence(normalizedOutput);
    let env = null;
    try {
      env = envelopeFrom(JSON.parse(fencedStripped), normalizedOutput);
    } catch {
      // Strict parse failed. Before giving up, try one repair pass for the
      // unescaped-inner-quote form (live-observed on roboform.com: Zo wrote
      // input[name="…"] with double quotes inside the JSON string). If the
      // repair also fails, try the narration-led fence scan (#426 F1) before
      // treating it as plain text (#29 behavior).
      try {
        env = envelopeFrom(JSON.parse(repairJson(fencedStripped)), normalizedOutput);
      } catch {
        env = null;
      }
    }
    if (env) {
      reasoning = env.reasoning;
      actions = env.actions;
      rawOutput = env.rawOutput;
      plainText = env.plainText;
    } else {
      const fenced = extractFencedEnvelope(normalizedOutput);
      if (fenced) {
        // Narration-led envelope: actions execute; the prose the model wrote
        // around the fence is intermediate narration — it rides the reasoning
        // channel (inline muted prose / collapsible trace), never the answer.
        reasoning = fenced.env.reasoning || fenced.narration;
        actions = fenced.env.actions;
        rawOutput = fenced.env.rawOutput;
        plainText = '';
      } else {
        // Not JSON — this is a plain-text (markdown) answer. Show it directly
        // rather than routing through `reasoning` (ticket #29: plain-text
        // answers were only surfaced via reasoning and otherwise became "Done.").
        plainText = normalizedOutput;
      }
    }
  }
  return { reasoning, actions, rawOutput, plainText, normalizedOutput };
}
