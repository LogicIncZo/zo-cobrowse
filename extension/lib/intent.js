// Intent detection — pure logic, no chrome.* or DOM dependencies.
// Imported by background.js (ESM) and directly by tests.
//
// Co-browse is the default mode and an action (JSON) mode: it asks Zo to
// emit {actions:[...]} so the extension can drive the browser. But users
// often type read-only intents into it ("Summarize", "What is this page?",
// "Explain the pricing"), which should answer in plain markdown — not be
// forced through the action envelope.
//
// detectIntent() inspects a free-text query and returns 'action' or 'read'.
// background.js uses it to override mode.expectJson to false (and swap the
// action schema for the plain-markdown hint) when the intent is clearly
// read-only. Action mode is retained for genuine browser-control requests.
//
// Design notes:
//   - Bang commands (!summarize, !ask) are handled upstream and never reach
//     here; this is only for plain-text queries in an action mode.
//   - When the query is ambiguous, Co-browse defaults to 'action' (it is the
//     co-browsing mode, after all). Read-only wins only on a clear signal —
//     a leading read-only verb (summarize/explain/what/why/...) OR the
//     absence of any action verb in a question-shaped query.
//   - Action verbs are matched as whole words, case-insensitive, so "login"
//     matches but "looking" does not. Multi-word phrases like "go to" and
//   - "sign in" are matched on their boundary.

/**
 * Whole-word action verbs. A query containing one of these (as a distinct
 * word, not a substring) is treated as an action intent — UNLESS a read-only
 * verb leads the query (read-only leading verb wins).
 */
const ACTION_VERBS = [
  // core action protocol
  'click', 'fill', 'type', 'navigate', 'scroll', 'wait', 'extract',
  'select', 'check', 'uncheck', 'submit', 'download', 'upload', 'hover',
  'press', 'enter', 'delete', 'clear', 'copy', 'paste',
  // navigation / page control
  'go', 'open', 'close', 'back', 'forward', 'reload', 'refresh', 'visit',
  'login', 'logout', 'sign in', 'sign out', 'sign up', 'register',
  'search for', 'buy', 'purchase', 'add to cart', 'checkout', 'apply',
  'book', 'order', 'subscribe', 'follow', 'like', 'share', 'post', 'reply',
  'play', 'pause', 'next', 'previous', 'expand', 'collapse', 'toggle',
];

/**
 * Leading read-only verbs. When the FIRST word/phrase of the query is one of
 * these, the intent is read-only regardless of later action words
 * ("summarize the pricing page" → read, even though "page" isn't an action).
 */
const READ_ONLY_LEADERS = [
  'summarize', 'summary', 'summarise', 'tl;dr', 'tldr',
  'explain', 'describe', 'analyze', 'analyse', 'review',
  'research', 'investigate', 'compare', 'contrast',
  'what', 'why', 'who', 'when', 'where', 'how', 'which',
  'is', 'are', 'can', 'could', 'would', 'should', 'do', 'does', 'did',
  'tell me', 'list', 'show', 'read', 'translate',
  'find', 'look up', 'lookup', 'define', 'meaning',
];

const READ_ONLY_TRIGGERS = [
  // whole-word question nouns that imply a read-only answer even without a
  // leading verb ("pricing?" / "the summary").
  'summary', 'overview', 'insights', 'takeaways', 'key points',
];

const actionRe = new RegExp(
  ACTION_VERBS.map(escapeForRe).join('|'),
  'i',
);

const readLeaderFirstWordRe = new RegExp(
  // match a read-only leader at the very start of the query
  '^(?:' + READ_ONLY_LEADERS.map(escapeForRe).join('|') + ')\\b',
  'i',
);

const readTriggerRe = new RegExp(
  '\\b(?:' + READ_ONLY_TRIGGERS.map(escapeForRe).join('|') + ')\\b',
  'i',
);

function escapeForRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect whether a free-text query is an action intent ('action') or a
 * read-only intent ('read').
 *
 * Resolution order:
 *   1. empty/whitespace → 'action' (caller will no-op on empty anyway; this
 *      keeps the action mode's behaviour for blank probes).
 *   2. a read-only leader as the FIRST word → 'read'
 *      (summarize/explain/what/why/... outrank any later action verb).
 *   3. contains an action verb → 'action'
 *   4. a read-only trigger word anywhere (summary/overview/insights/...) → 'read'
 *   5. ends with '?' (explicit question) → 'read'
 *   6. otherwise → 'action' (Co-browse is the action mode; action wins ties).
 *
 * Pure (no chrome.* / DOM deps) so it's unit-testable directly.
 *
 * @param {string} query
 * @returns {'action' | 'read'}
 */
export function detectIntent(query) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return 'action';

  // 2. read-only leader wins, regardless of later action words.
  if (readLeaderFirstWordRe.test(q)) return 'read';

  // 3. action verb anywhere → action.
  if (actionRe.test(q)) return 'action';

  // 4. read-only trigger word.
  if (readTriggerRe.test(q)) return 'read';

  // 5. explicit question.
  if (q.endsWith('?')) return 'read';

  // 6. ambiguous → action (Co-browse is the action mode).
  return 'action';
}

/**
 * Should an action (JSON) mode downgrade itself to plain markdown for this
 * query? True when the mode expects JSON (it's an action mode) AND the
 * query's intent is read-only. Non-action modes always return false (they're
 * already plain markdown).
 *
 * @param {{ expectJson: boolean }} mode
 * @param {string} query
 * @returns {boolean}
 */
export function shouldDowngradeToJsonDisabled(mode, query) {
  if (!mode || !mode.expectJson) return false;
  // Lane E: a handoff turn is an ACTION turn by design — the goal may read
  // like a request ("compare the pricing across these pages"), but the
  // unattended loop needs the action envelope, so the instructions block
  // embedded in the query exempts it from the read-downgrade (context-policy
  // and buildPrompt both route through here).
  if (typeof query === 'string' && query.includes('## Handoff Run')) return false;
  return detectIntent(query) === 'read';
}

/**
 * Does this streaming text fragment look like the raw JSON action envelope
 * (i.e. Co-browse mode streaming {actions:[...]} as text deltas)? Used to
 * suppress rendering it as prose while streaming — otherwise the user sees
 * raw JSON (`{"actions":[{"click":...`) build up live before STREAM_DONE
 * resolves it into executed actions + the done.response.
 *
 * Detects a JSON prefix that opens an object and reaches an `"actions"` key,
 * without requiring the (still-incomplete) string to parse. False positives
 * are harmless: a real prose answer never starts with `{"` and mentions
 * `"actions"` as a JSON key.
 *
 * Pure (no chrome.* / DOM deps).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeActionJson(text) {
  let t = typeof text === 'string' ? text.trimStart() : '';
  if (!t) return false;
  // Cobrowse models sometimes fence the envelope (```json …). A fenced blob
  // starts with backticks, so strip the opening fence before the { test.
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z0-9]*\s*\n?/, '');
  }
  if (!t.startsWith('{')) return false;
  // Reached the "actions" key while still inside the opening object. Matches
  // both partial (`{"actions":`) and complete (`{"actions":[...]}`) envelopes.
  return /"\s*actions\s*"\s*:/.test(t);
}
