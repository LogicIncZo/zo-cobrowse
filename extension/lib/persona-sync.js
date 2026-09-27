// Persona-sync pure half (#415) — no chrome.* / DOM / fetch deps.
//
// The persona_id lane moves the builtin Modes' per-turn `system` section
// server-side: one Zo persona per builtin Mode, each carrying that Mode's
// EXACT systemPrompt. Spike-verified (probe-persona-composition): persona
// composes with custom inline system text (persona token first, no collision)
// and survives a rotated conversation_id.
//
// Fail-closed contract: the inline system section rides unless EVERY check
// passes — builtin Mode, stored persona, byte-equal prompt, no user-configured
// persona routing. Any doubt → inline.

/** storage.local key: durable map { [modeId]: { personaId, prompt, name } }. */
export const PERSONA_STORAGE_KEY = 'cobrowse_personas';

/** storage.session key: { checkedVersion } — one ensure per version per session. */
export const PERSONA_STATE_KEY = 'cobrowse_personas_state';

/** Name prefix shared by all auto-managed personas (sweep anchor). */
export const PERSONA_NAME_PREFIX = 'zo-cobrowse:';

/** Stable short hash of the system prompt (name carries it → adopt-by-name is prompt-safe). */
export function promptHash(text) {
  const s = String(text || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, '0').slice(-7);
}

/** `zo-cobrowse: <modeId> · <hash>` — the exact name a persona is managed by. */
export function personaNameFor(modeId, systemPrompt) {
  return `${PERSONA_NAME_PREFIX} ${modeId} · ${promptHash(systemPrompt)}`;
}

/**
 * Extract the persona id from create_persona's response text (a python-repr
 * `id='…'` string, live-verified — not JSON).
 */
export function parsePersonaId(createdText) {
  const m = String(createdText || '').match(/id='([0-9a-f-]{36})'/i);
  return m ? m[1] : '';
}

/**
 * Per-turn decision. `stored` is the durable map from PERSONA_STORAGE_KEY.
 *   use  → send persona_id, drop the inline system section
 *   sync → the ensure loop should (re)create (missing/stale/drifted)
 *   skip → custom Mode, no entry, or byte-drift at send time — inline rides
 */
export function decidePersona(mode, stored) {
  if (!mode || mode.builtin !== true || !mode.systemPrompt) return { kind: 'skip' };
  const entry = stored && stored[mode.id];
  if (!entry || !entry.personaId) return { kind: 'sync' };
  if (entry.prompt !== mode.systemPrompt) {
    // Drift: the extension's framing changed (update) or the entry is corrupt.
    return { kind: 'sync', stalePersonaId: entry.personaId };
  }
  return { kind: 'use', personaId: entry.personaId };
}

/**
 * Sweep plan: ids of auto-managed personas (name prefix matches) that are NOT
 * current targets — orphans from lost storage or renamed framings. Never
 * touches personas outside our prefix.
 */
export function planPersonaSweep(listed, targetNames) {
  const targets = new Set(targetNames);
  const ids = [];
  for (const p of Array.isArray(listed) ? listed : []) {
    if (p && typeof p.id === 'string' && typeof p.name === 'string' && p.name.startsWith(PERSONA_NAME_PREFIX) && !targets.has(p.name)) {
      ids.push(p.id);
    }
  }
  return ids;
}
