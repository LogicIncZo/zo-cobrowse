// Modes — pure logic, no chrome.* or DOM dependencies.
// A Mode is the single source of truth for how Zo behaves on a request:
// which system prompt/instructions it gets, how much page context, and
// whether it should respond with actions (JSON) or plain markdown.
// Imported by background.js + sidepanel.js (ESM) and directly by tests.

/**
 * Compact action protocol — shipped only when a Mode sets expectJson:true.
 * One line vs the old ~130-token commented JSON block.
 */
// Only cobrowse needs structured actions (click/fill/navigate) to drive the
// browser. It requests an actions array only — NOT a {reasoning,actions}
// envelope — because demanding reasoning inside the JSON is what made the
// model club thinking + answer into one blob (the "raw JSON in chat" bug).
// Reasoning streams as its own channel from the backend when available and
// is rendered into a separate Thought bubble; it is never asked for here.
// The no-secrets / never-click-after-fill safety rules used to ride here AND
// in cobrowse.instructions (restated every turn). They now live in ONE place:
// lib/prompt.js's SHARED_SAFETY_RULES, composed once (#71 trim).
export const ACTION_SCHEMA_COMPACT =
  'Respond with JSON {"actions":[...]}. ' +
  'Actions: click{selector} | fill{selector,value} | ' +
  'fill_form{values:[{target,value}]} — batch-fill by question/label/placeholder text (PREFER for 2+ fields) | ' +
  'extract{selector,attribute} | navigate{url} | scroll{direction,amount?} | wait{ms} | done{response}' +
  ' | read_tab{ref} — request full content of a referenced tab (context only)' +
  ' | read_page — fetch full text of the current page (context only)' +
  ' | get_dom — fetch all interactive elements of the current page (context only)' +
  ' | get_form — fetch all form fields of the current page (context only). ';

/**
 * Fallback instructions for Modes that don't define their own.
 */
export const PLAIN_RESPONSE_HINT = 'Respond in plain markdown.';

/**
 * Context tiers — how much of the page is sent to Zo.
 *   0 = pointer   — URL + title + viewport only
 *   1 = +text     — add visibleText sliced to textBudget
 *   2 = +elements — add compact clickable + form-field list (with selectors)
 *   3 = +screenshot — add a screenshot
 */
export const TIER = Object.freeze({ POINTER: 0, TEXT: 1, ELEMENTS: 2, SCREENSHOT: 3 });

/**
 * Built-in Modes. Each is immutable (builtin:true). Custom Modes (from the ✦
 * generator or migrated from legacy presets) live in storage and merge over
 * these via resolveMode().
 */
export const BUILTIN_MODES = {
  cobrowse: {
    id: 'cobrowse',
    name: 'Co-browse',
    icon: '🤖',
    systemPrompt: "You are Zo — the user's AI co-browsing assistant. You see the page they're on and can control the browser.",
    instructions: 'Act on the page to fulfill the request. Use the ELEMENTS list when targeting clicks/fills. Prefer fill_form for multi-field forms (target = the field\'s question text). On one-question-per-screen forms, fill only the visible section per turn and let the user review + advance.',
    contextTier: TIER.ELEMENTS,
    textBudget: 4000,
    expectJson: true,
    builtin: true,
  },
  ask: {
    id: 'ask',
    name: 'Ask',
    icon: '💬',
    systemPrompt: "You are Zo — the user's browser companion. You see the page they're on. Keep responses concise and scannable.",
    // Summarize/Research merged into Ask (2026-08 rationalization): they were
    // tier-1 readers differing only in query phrasing, and every canned entry
    // (!summarize, !research, shortcut, starter chip) carries its own phrasing.
    instructions: 'Answer the request directly. Use the page content when it is attached; otherwise reason from the page pointer (URL/title) and your own tools. Organize longer answers with clear headings.',
    contextTier: TIER.TEXT,
    textBudget: 4000,
    expectJson: false,
    builtin: true,
  },
  extract: {
    id: 'extract',
    name: 'Extract',
    icon: '📥',
    systemPrompt: "You are Zo — the user's data extraction assistant. Extract structured data from the page into clean tables or JSON.",
    instructions: 'Extract all structured data: tables, lists, contacts, prices, dates, links. Be exhaustive. Output the extracted data directly as markdown tables or a JSON code block.',
    contextTier: TIER.ELEMENTS,
    textBudget: 4000,
    // Read-only: streams plain markdown. The extracted data can still be
    // JSON/tables as CONTENT — just not wrapped in the {reasoning,actions}
    // action envelope, which caused the raw-JSON-in-chat bug.
    expectJson: false,
    builtin: true,
  },
  visual: {
    id: 'visual',
    name: 'Visual',
    icon: '🖼️',
    systemPrompt: "You are Zo — answering questions about what is visible on the user's screen, using the screenshot provided.",
    instructions: 'Describe or analyze what is visible in the screenshot.',
    contextTier: TIER.SCREENSHOT,
    textBudget: 1000,
    expectJson: false,
    builtin: true,
  },
  lean: {
    id: 'lean',
    name: 'Lean',
    icon: '🪶',
    systemPrompt: "You are Zo — the user's AI companion. You receive only the current page's URL and title plus the user's request; you do NOT see the page itself.",
    // URL-only Mode (see docs/superpowers/specs/2026-08-29-lean-mode-design.md):
    // Zo works entirely server-side — fetches the page itself, never acts.
    instructions: 'The page content is NOT attached. If you need the page, fetch the URL yourself with your web tools; if it is inaccessible, paywalled, or geoblocked, say so plainly instead of guessing. Never return browser actions — this Mode cannot control the page. When the request is note-shaped (note/remember/file/save this), write the note and cross-reference your memory.',
    contextTier: TIER.POINTER,
    textBudget: 1000, // inert at tier 0 — no text is ever attached
    expectJson: false,
    builtin: true,
  },
};

export const DEFAULT_MODE_ID = 'cobrowse';

/**
 * Built-in ids removed in the 2026-08 mode rationalization (Summarize and
 * Research merged into Ask). Persisted `zoActiveMode` values and override
 * entries carrying these ids are migrated to MODE_MERGE_TARGETS on load —
 * resolveMode would otherwise silently fall back to the DEFAULT Mode
 * (Co-browse), which has a different contract than the reader the user had.
 */
export const MERGED_MODE_IDS = Object.freeze(['summarize', 'research']);
export const MODE_MERGE_TARGET = 'ask';

/**
 * Migrate a persisted Mode id that points at a merged built-in. Ids outside
 * the merge catalog pass through unchanged.
 */
export function migrateMergedModeId(modeId) {
  return MERGED_MODE_IDS.includes(modeId) ? MODE_MERGE_TARGET : modeId;
}

/**
 * Migrate a per-built-in override catalog: overrides saved against merged ids
 * carry onto the merge target only when the target has none of its own (the
 * user's tuned knobs win over nothing, but never clobber fresh edits); the
 * dead entries are always dropped.
 *
 * @param {Record<string, object>} overrides
 * @returns {{ next: Record<string, object>, changed: boolean }}
 */
export function migrateMergedOverrides(overrides) {
  const next = (overrides && typeof overrides === 'object') ? { ...overrides } : {};
  let changed = false;
  for (const dead of MERGED_MODE_IDS) {
    if (!next[dead]) continue;
    if (!next[MODE_MERGE_TARGET]) next[MODE_MERGE_TARGET] = { ...next[dead] };
    delete next[dead];
    changed = true;
  }
  return { next, changed };
}

/**
 * The user-tunable Mode knobs. The remaining fields (id/name/icon/builtin) are
 * identity and stay fixed for built-ins. The Settings editor persists a sparse
 * subset of these per built-in id in the cobrowse_mode_overrides catalog.
 */
export const EDITABLE_MODE_FIELDS = Object.freeze([
  'systemPrompt',
  'instructions',
  'contextTier',
  'textBudget',
  'expectJson',
]);

/**
 * Merge a (possibly sparse) builtin override over a COPY of the base Mode.
 * Only the editable knobs are taken from the override; identity fields
 * (id/name/icon/builtin) always come from the base — so a built-in stays a
 * built-in and "Reset to original" is just deleting the override entry. The
 * base object (a BUILTIN_MODES entry) is never mutated.
 *
 * @param {object} base   a full Mode (typically a BUILTIN_MODES entry)
 * @param {object} [override]  a sparse partial carrying only edited knobs
 * @returns {object} a full Mode with overrides applied
 */
export function mergeOverride(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const k of EDITABLE_MODE_FIELDS) {
    if (override[k] !== undefined) out[k] = override[k];
  }
  return out;
}

/**
 * Resolve a Mode id to a Mode object.
 * Custom modes override built-ins by id; unknown/missing ids fall back to
 * the default Mode so callers never receive null. Built-in resolution also
 * applies any stored per-id overrides (editable knobs only), so user edits
 * made in Settings take effect without mutating the immutable BUILTIN_MODES.
 *
 * @param {string} modeId
 * @param {Record<string, object>} [customModes={}]
 * @param {Record<string, object>} [overrides={}]  per-built-in-id sparse overrides
 * @returns {object} a full Mode object
 */
export function resolveMode(modeId, customModes = {}, overrides = {}) {
  if (modeId && customModes[modeId]) return normalizeMode(customModes[modeId], modeId);
  if (modeId && BUILTIN_MODES[modeId]) return mergeOverride(BUILTIN_MODES[modeId], overrides[modeId]);
  return mergeOverride(BUILTIN_MODES[DEFAULT_MODE_ID], overrides[DEFAULT_MODE_ID]);
}

/**
 * Migrate a legacy preset object to a full Mode, backfilling the fields a
 * preset never carried (contextTier, textBudget, expectJson). Used by the
 * one-time storage migration in sidepanel.js and by generateMode().
 */
export function presetToMode(preset) {
  const id = preset.id || ('custom_' + Date.now());
  return {
    id,
    name: preset.name || 'Custom mode',
    icon: preset.icon || '✨',
    description: preset.description || '',
    systemPrompt: preset.systemPrompt || '',
    instructions: preset.instructions || '',
    contextTier: Number.isInteger(preset.contextTier) ? preset.contextTier : TIER.TEXT,
    textBudget: preset.textBudget || 2000,
    // Default to plain-markdown (expectJson:false). Only cobrowse sets
    // expectJson:true; defaulting custom modes/presets to true silently
    // leaked the "Respond with JSON {actions}" instruction into prompts
    // for read-only modes, making Zo emit actions instead of prose.
    expectJson: preset.expectJson !== undefined ? !!preset.expectJson : false,
    builtin: false,
  };
}

/**
 * The set of action type names, mirrored from the action protocol.
 * Used to detect the "key-first" action shape Zo sometimes emits.
 * (Kept here — next to ACTION_SCHEMA_COMPACT, the single source of truth —
 * rather than duplicated in background.js.)
 */
export const ACTION_TYPE_NAMES = ['click', 'fill', 'fill_form', 'extract', 'navigate', 'scroll', 'wait', 'done'];

/**
 * Context-only ("pull") action names (#24) — intercepted by the background's
 * in-stream pull loop and NEVER executed against the DOM. They are excluded
 * from ACTION_TYPE_NAMES (the executor list) but known to normalizeActions so
 * a canonical `{type:'read_tab',ref}` from Zo survives parsing (it used to be
 * silently stripped before extractPullRequests could see it).
 */
export const CONTEXT_ACTION_NAMES = ['read_tab', 'read_page', 'get_dom', 'get_form'];

/** True for context-only pull actions — filtered wherever actions execute. */
export function isContextAction(a) {
  return !!(a && typeof a === 'object' && CONTEXT_ACTION_NAMES.includes(a.type));
}

const KNOWN_ACTION_NAMES = [...ACTION_TYPE_NAMES, ...CONTEXT_ACTION_NAMES];

/**
 * Normalize Zo's action payload to the canonical "type-first" form the
 * extension executes:
 *
 *   type-first (canonical):   { type: 'extract', selector: 'body', attribute: 'textContent' }
 *   key-first (Zo variant):   { extract: { selector: 'body', attribute: 'textContent' } }
 *
 * The compact schema shipped in the prompt (`extract{selector,attribute}`)
 * is ambiguous, and some models emit actions as `{"<type>": {...}}` instead
 * of `{"type": "<type>", ...}`. Without normalization those actions silently
 * drop out of every consumer (`a.type === 'done'`, executeActions, the
 * timeline) and the whole `{reasoning, actions}` blob leaks into the chat as
 * raw JSON. This converts key-first to type-first; already-canonical actions
 * pass through unchanged. Non-conforming entries are dropped.
 *
 * Pure (no chrome.* / DOM deps) so it's unit-testable directly.
 *
 * @param {unknown} actions
 * @returns {object[]} canonical type-first action objects
 */
export function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    if (typeof a.type === 'string' && KNOWN_ACTION_NAMES.includes(a.type)) {
      // Already canonical. Keep as-is (the consumers own validation).
      out.push(a);
      continue;
    }
    // Key-first: a single key that is a known action type, mapped to its args.
    let found = false;
    for (const key of Object.keys(a)) {
      if (KNOWN_ACTION_NAMES.includes(key)) {
        const args = (a[key] && typeof a[key] === 'object' && !Array.isArray(a[key])) ? a[key] : {};
        out.push({ type: key, ...args });
        found = true;
        break; // only the first recognized key wins
      }
    }
    if (!found) {
      // Singular `{"action":"click",...}` variant — real multi-action captures
      // emit this non-spec form (qa-notes.md §"Action envelope shape"). Map
      // a top-level `action` naming a known type onto the canonical `type`.
      if (typeof a.action === 'string' && KNOWN_ACTION_NAMES.includes(a.action)) {
        const { action, args, ...rest } = a;
        // args may be an object (common) or absent; merge into the flat action.
        const argsObj = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
        out.push({ type: action, ...argsObj, ...rest });
        found = true;
      }
    }
    if (!found) {
      // Unknown shape — skip rather than risk rendering raw JSON in the chat.
    }
  }
  return out;
}

/**
 * Ensure a (possibly user-supplied) mode object has every required field.
 * Missing fields fall back to safe defaults; an absent id uses the provided key.
 */
function normalizeMode(raw, key) {
  const m = raw || {};
  return {
    id: m.id || key,
    name: m.name || 'Custom mode',
    icon: m.icon || '✨',
    description: m.description || '',
    systemPrompt: m.systemPrompt || '',
    instructions: m.instructions || '',
    contextTier: Number.isInteger(m.contextTier) ? m.contextTier : TIER.TEXT,
    textBudget: m.textBudget || 2000,
    // Default to plain-markdown (see presetToMode for rationale).
    expectJson: m.expectJson !== undefined ? !!m.expectJson : false,
    builtin: false,
  };
}
