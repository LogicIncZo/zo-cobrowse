// Zo Co-browse — Jev (TypeSafe AI "System One") pure half.
//
// Lane J1 of the 0.3.4 slate. Everything here is pure — no chrome.*, no DOM,
// no fetch. The transport lives in background.js (Lane J2); this module owns
// the wire shapes, the question builders, and the confidence-routing rule.
//
// API contract (docs.typesafe.ai/api, captured 2026-09-20; live-verified by
// tests/test-prompts/probe-jev.ts):
//   POST <jevApiUrl>  { model, state, questions }  Bearer <key>
//   → { model, answers: { id → answer }, usage: { input_tokens, output_tokens } }
//   answers: { type:'noul', noul } | { type:'choice', choice, probabilities,
//   confidence } | { type:'score', score, legend?, probabilities?, confidence? }
//
// Thresholds are PER-TYPE by design: the vendor's model notes state noul and
// choice confidences are not comparable — never route both through one number.

/** The default decide endpoint (Advanced-overridable via config). */
export const DEFAULT_JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
/** Vendor alias; pin a concrete version via config if jaggedness bites. */
export const DEFAULT_JEV_MODEL = 'jev-latest';
/** Choice answers cap their criteria at 255 options (vendor limit). */
export const MAX_CHOICE_OPTIONS = 255;

/** Build the decide request body. Throws on empty questions — a call without
 *  a question is always a caller bug, never a retryable condition. */
export function buildDecideRequest({ model = DEFAULT_JEV_MODEL, state, questions }) {
  if (!state && state !== 0) throw new Error('jev: state is required');
  if (!questions || typeof questions !== 'object' || !Object.keys(questions).length) {
    throw new Error('jev: at least one question is required');
  }
  return { model, state, questions };
}

/** Parse a decide response into {ok, answers, usage, model}. Never throws —
 *  malformed payloads come back as {ok:false, error} so the caller can fall
 *  back to the Zo path instead of crashing a turn. */
export function parseDecideResponse(json) {
  if (!json || typeof json !== 'object' || json.error) {
    return { ok: false, error: (json && json.error) || 'malformed jev response' };
  }
  const answers = json.answers;
  if (!answers || typeof answers !== 'object') {
    return { ok: false, error: 'jev response missing answers map' };
  }
  for (const [id, ans] of Object.entries(answers)) {
    if (!ans || typeof ans !== 'object' || !ans.type) {
      return { ok: false, error: `jev answer "${id}" malformed` };
    }
    if (ans.type === 'noul' && typeof ans.noul !== 'number') {
      return { ok: false, error: `jev noul answer "${id}" missing noul` };
    }
    if (ans.type === 'choice' && (typeof ans.choice === 'undefined' || ans.choice === null)) {
      return { ok: false, error: `jev choice answer "${id}" missing choice` };
    }
  }
  return {
    ok: true,
    answers,
    usage: json.usage || { input_tokens: 0, output_tokens: 0 },
    model: json.model || '',
  };
}

/** Confidence routing rule. NaN-safe: a non-number confidence never acts. */
export function shouldAct(confidence, minConfidence) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return false;
  if (typeof minConfidence !== 'number' || Number.isNaN(minConfidence)) return false;
  return confidence >= minConfidence;
}

/** Click-pick question (choice): which candidate, by id, achieves the goal?
 *  candidates: [{ id, label }] — labels should be short, literal descriptions
 *  (the vendor's guidance: literal questions, one judgment per question). */
export function clickChoiceQuestion(goal, candidates) {
  const list = (candidates || [])
    .filter((c) => c && c.id != null && (c.label || '').trim())
    .slice(0, MAX_CHOICE_OPTIONS);
  if (!list.length) throw new Error('jev: clickChoiceQuestion needs at least one labeled candidate');
  return {
    target: {
      type: 'choice',
      instructions: `The user's goal is stated in the state. Which element, when activated on the page, achieves the goal? Goal: ${goal}`,
      criteria: Object.fromEntries(list.map((c) => [String(c.id), String(c.label).trim()])),
    },
  };
}

/** Done-gate question (noul): is the goal already achieved on this page?
 *  Deliberately literal phrasing — the probe-verified wording. */
export function doneGateQuestion(goal) {
  return {
    goal_done: {
      type: 'noul',
      instructions: `The user's goal is: "${goal}". The state is the URL, title, and text content of the web page the user is currently viewing. The goal is already fully achieved on this page.`,
    },
  };
}

/** Redaction boundary for Jev-bound state (#342 consumes this): strip form
 *  field values entirely and drop secret-looking keys. Page text and element
 *  labels are fine; VALUES never are. This is the cheap structural half —
 *  the sensitivity heuristics live in lib/formfill.js with the executor. */
export function redactStateForJev(state) {
  if (!state || typeof state !== 'object') return state;
  if (Array.isArray(state)) return state.map(redactStateForJev);
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (/value|secret|password|token|cvv|card/i.test(k)) continue;
    out[k] = v && typeof v === 'object' ? redactStateForJev(v) : v;
  }
  return out;
}
