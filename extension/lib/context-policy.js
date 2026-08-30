// Context policy — decides, per turn, how much page context to capture + send
// to Zo. Encodes the two efficiency rules the user asked for:
//
//   1. Opt-in DOM — page content (text/elements/screenshot) is NOT sent by
//      default. Read turns send URL/title only (tier 0). The user attaches
//      full context for one turn with the `!context` / `!dom` bang command
//      (or a manual refresh). Co-browse action turns attach element selectors
//      when Zo needs to click/fill.
//
//   2. Send once per conversation — within a conversation, full context is
//      attached at most once per stable page; follow-ups send URL-only and
//      rely on Zo's `conversation_id` threading. Navigation (a page-hash
//      change) re-enables a fresh attach.
//
// Pure logic (no chrome.* or DOM deps) EXCEPT the two storage.session helpers
// at the bottom, which follow config.js's precedent. decideTurn/computePageHash/
// stripToPointer/createConversationState are fully unit-testable.

import { shouldDowngradeToJsonDisabled } from './intent.js';

/** chrome.storage.session key prefix for the per-chat context state. */
export const CONVERSATION_STATE_KEY = 'cobrowse_ctx_state';

/**
 * A fresh conversation-context state: nothing captured yet. Stored in
 * chrome.storage.session (survives MV3 service-worker restarts, clears on
 * browser close) — peers with the `zoConversationId` session value.
 */
export function createConversationState() {
  return {
    conversationId: null,
    lastCaptureHash: null,
    lastCaptureTier: null,
    turnsSinceFullCapture: 0,
    // Tab contexts (send-once per tab): { [tabId]: pageHash }. Managed by
    // noteTabSent/isTabSentAt in lib/tab-contexts.js.
    tabsSent: {},
    // Referenced-tab manifest dedup: { [tabId]: contentKey } — the content key
    // (url|title|excerpt-length) each tab's excerpt was last sent at. Managed
    // by thinTabExcerpts in lib/tab-contexts.js; an unchanged tab's excerpt is
    // NOT re-sent on follow-ups (manifest line only) since Zo's conversation
    // threading already holds it.
    tabManifestSent: {},
  };
}

/**
 * Cheap, structure-aware page signature. Detects navigation (url/title) and
 * structural changes (text length, element/form counts at the capture tier).
 * Not cryptographic — a false "changed" only costs one extra capture, so a
 * simple join is enough and keeps the policy free of a hash dependency.
 *
 * @param {object} pageContext
 * @param {number} tier  the tier at which pageContext was captured
 * @returns {string}
 */
export function computePageHash(pageContext, tier) {
  const ctx = pageContext || {};
  const sig = [ctx.url || '', ctx.title || ''];
  if (tier >= 1) sig.push(String((ctx.visibleText || '').length));
  if (tier >= 2) {
    sig.push(String(Array.isArray(ctx.clickable) ? ctx.clickable.length : 0));
    sig.push(String(Array.isArray(ctx.formFields) ? ctx.formFields.length : 0));
  }
  return sig.join('|');
}

/** Reduce a captured context to the tier-0 (URL-only) envelope. */
export function stripToPointer(pageContext) {
  const ctx = pageContext || {};
  return {
    url: ctx.url,
    title: ctx.title,
    viewport: ctx.viewport || { w: '?', h: '?' },
  };
}

/**
 * The per-turn context decision. Pure.
 *
 * Resolution (honoring opt-in DOM + send-once):
 *   - `pageBlank` (active tab is a new/blank page — cold start) → never
 *     attach: there is no page content to send, so even explicit `!context`
 *     and manual refresh degrade to tier 0. The blank turn records NO capture
 *     hash, so the first action turn after navigating to a real page still
 *     attaches.
 *   - `!context` (bang.kind === 'context') or `forceRefresh` → always attach at
 *     the Mode's tier this turn (explicit user intent overrides dedup).
 *   - action intent (mode.expectJson && not read-downgraded) → attach when the
 *     page hash changed since the last attach. This covers the first turn of a
 *     conversation (lastCaptureHash is null) and any navigation. A same-page
 *     follow-up action turn sends URL-only, relying on Zo retaining the
 *     selectors it already received via conversation_id — UNLESS threading is
 *     not established (`hasThread === false`, e.g. a retry after a stream that
 *     died before the conversation_id echo): a fresh Zo thread holds nothing,
 *     so the page re-attaches.
 *   - read intent → URL only (tier 0) unless explicitly requested.
 *
 * `hasThread` defaults to true so legacy callers (and the "thread will exist
 * by the time this matters" assumption) keep today's behavior; only the
 * sidepanel passes the live per-chat value.
 *
 * `attach === false` means effectiveTier 0; the caller captures at tier 0 and
 * buildPrompt emits only `## Page`. `newState` is the updated conversation
 * state (attach records the hash; non-attach just advances the turn counter).
 *
 * @param {{ mode: object, query: string, bang?: object, state?: object, pageHash?: string, pageBlank?: boolean, forceRefresh?: boolean, hasThread?: boolean, domEnabled?: boolean }} args
 * @returns {{ effectiveTier: number, reason: string, attach: boolean, newState: object }}
 */
export function decideTurn({ mode, query, bang, state, pageHash, pageBlank = false, forceRefresh = false, hasThread = true, domEnabled = true }) {
  const st = state || createConversationState();
  const isAction = !!mode && !!mode.expectJson && !shouldDowngradeToJsonDisabled(mode, query);
  const contextRequested = !!bang && bang.kind === 'context';
  const explicit = contextRequested || !!forceRefresh;
  const hasCaptured = st.lastCaptureHash !== null && st.lastCaptureHash !== undefined;
  const pageChanged = st.lastCaptureHash !== pageHash; // true on the first turn (null !== hash)

  let attach;
  if (pageBlank) attach = false; // cold start: nothing to attach, ever
  else if (explicit) attach = true;
  else if (isAction) attach = pageChanged || !hasThread; // first turn / navigation / thread lost
  else attach = false; // reads: opt-in only

  const modeTier = mode && Number.isInteger(mode.contextTier) ? mode.contextTier : 0;
  let effectiveTier = attach ? modeTier : 0;

  let reason;
  if (pageBlank) reason = 'Blank page · no page context';
  else if (forceRefresh) reason = 'Manual refresh · full context';
  else if (contextRequested) reason = '!context · full context';
  else if (isAction && !hasCaptured) reason = 'First turn · action context';
  else if (isAction && pageChanged) reason = 'Page changed · re-attaching';
  else if (isAction && !hasThread) reason = 'No thread yet · re-attaching (fresh Zo thread holds nothing)';
  else if (isAction && !pageChanged) reason = 'Follow-up · URL only (context already sent)';
  else reason = 'Read · URL only (type !context to attach)';

  // #69: the sticky DOM toggle is a HARD cap — it wins over everything,
  // including !context and first-turn action attach. The state does NOT
  // record the capture hash while capped, so re-enabling the toggle (or a
  // later page change) re-attaches normally instead of trusting a "context
  // already sent" that never went out.
  const domCapped = domEnabled === false && effectiveTier > 0;
  if (domCapped) {
    effectiveTier = 0;
    reason = '🚫 DOM toggle — page DOM off';
  }

  const newState = (attach && !domCapped)
    ? {
        ...st,
        lastCaptureHash: pageHash,
        lastCaptureTier: effectiveTier,
        turnsSinceFullCapture: 0,
      }
    : { ...st, turnsSinceFullCapture: st.turnsSinceFullCapture + 1 };

  return { effectiveTier, reason, attach: attach && !domCapped, newState };
}

// ---- chrome.storage.session helpers (the only chrome.* touch in this module)
//
// State is keyed PER CHAT (chat tabs are isolated threads — dedup state must
// not leak across conversations): `cobrowse_ctx_state:<chatId>`. Callers
// without a chatId (legacy/ambient) use the bare legacy key.

/** The session-storage key for a given chat id (no id → legacy global key). */
export function stateKeyFor(chatId) {
  const id = chatId == null ? '' : String(chatId).trim();
  return id ? `${CONVERSATION_STATE_KEY}:${id}` : CONVERSATION_STATE_KEY;
}

/** Load conversation context state, falling back to a fresh state. */
export function loadConversationState(chatId) {
  const key = stateKeyFor(chatId);
  const fresh = () => {
    const s = createConversationState();
    if (chatId) s.conversationId = chatId;
    return s;
  };
  // Guard BEFORE building the promise — a throw inside a Promise executor
  // rejects that promise; it never reaches the surrounding try/catch.
  if (typeof chrome === 'undefined' || !chrome?.storage?.session) return Promise.resolve(fresh());
  try {
    return new Promise((resolve) => {
      chrome.storage.session.get(key, (result) => {
        const s = result && result[key];
        const merged = s && typeof s === 'object' ? { ...fresh(), ...s } : fresh();
        if (chatId) merged.conversationId = chatId;
        resolve(merged);
      });
    });
  } catch {
    return Promise.resolve(fresh());
  }
}

/** Persist conversation context state to session storage. Best-effort. */
export function saveConversationState(chatId, state) {
  const key = stateKeyFor(chatId);
  const st = chatId ? { ...(state || createConversationState()), conversationId: chatId } : (state || createConversationState());
  if (typeof chrome === 'undefined' || !chrome?.storage?.session) return Promise.resolve();
  try {
    return new Promise((resolve) => {
      chrome.storage.session.set({ [key]: st }, () => resolve());
    });
  } catch {
    return Promise.resolve();
  }
}
