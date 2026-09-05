// Zo Co-browse — Zo web deep links (0.2.8.0 enabler)
// Build "open this conversation in Zo's web UI" URLs + display helpers for
// the conversation-id debug chip. Pure module — no chrome.* / DOM deps.
//
// Deep link shape (owner-confirmed 2026-09-03):
//   https://<user-slug>.zo.computer/?chat=<conversation_id>&t=chats
// The slug is per-account and NOT derivable from the API token (the public
// API has no profile endpoints), so the origin is user-configured
// (`zoWebOrigin` setting). Callers hide the affordance on `null` — no dead
// links, ever.

/** Real Zo conversation ids look like `con_ijM6neD936odlluG` (note: some
 *  older docs say `conv_` — reality is `con_`). Length left loose. */
const CONVERSATION_ID_RE = /^con_[A-Za-z0-9_-]+$/;

/** Build a Zo web chat URL, or null when either input is unusable.
 *  Origin: trimmed, must parse as http(s), trailing slash normalized.
 *  Conversation id: must match `con_*`, else null. */
export function zoChatUrl(origin, conversationId) {
  const trimmed = String(origin ?? '').trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!conversationId || !CONVERSATION_ID_RE.test(String(conversationId))) return null;
  const base = `${url.protocol}//${url.host}`; // drops any path/slash noise
  return `${base}/?chat=${encodeURIComponent(String(conversationId))}&t=chats`;
}

/** Display form for the footer chip: first 10 chars + ellipsis. */
export function truncateId(id) {
  const s = String(id ?? '');
  if (!s) return '';
  return s.length > 10 ? s.slice(0, 10) + '…' : s;
}
