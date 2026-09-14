// Chat tabs — the sidepanel's browser-style tab bar over the conversations
// store (`cobrowse_convos`): several chats open at once (ordered openIds +
// activeId), plus the history-view management ops (rename, search). Pure
// state transforms, no chrome.*/DOM deps — the sidepanel owns persistence and
// rendering. Design: docs/superpowers/specs/2026-08-15-chat-tabs-design.md
//
// Semantics:
//   - `openIds` is ordered, leftmost = oldest open. It is a subset of the
//     conversation map's keys — closing a tab never deletes the chat.
//   - At least one tab stays open: closeChatTab no-ops on the last one.
//   - Overflow evicts the oldest-position NON-ACTIVE tab (the active chat is
//     never evicted by opening something else).

/** Max simultaneously-open chat tabs (sidepanel is ~360px wide). */
export const MAX_OPEN_TABS = 8;

/** Title cap for tabs + renames (matches the auto-title cap). */
export const TITLE_MAX = 60;

/** Coerce any value to a display-safe string (never throws). */
function txt(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try { return String(v); } catch { return ''; }
}

/** A fresh open-tab set (pre-init; every op output activates something). */
export function createTabsState() {
  return { openIds: [], activeId: null };
}

/**
 * Open (or focus) a chat tab and activate it. Idempotent. When the result
 * would exceed maxOpen, the oldest-position non-active tab is evicted — the
 * chat stays in history, just not open. `opts.pinnedIds` (#54) are exempt:
 * eviction skips them, and if ONLY pinned tabs + the active one remain the
 * set may grow past maxOpen rather than close a protected chat.
 */
export function openChatTab(state, chatId, { maxOpen = MAX_OPEN_TABS, pinnedIds = [] } = {}) {
  const st = state || createTabsState();
  const id = txt(chatId).trim();
  if (!id) return { ...st };

  const pinned = new Set((Array.isArray(pinnedIds) ? pinnedIds : []).map((x) => txt(x)));
  let openIds = st.openIds.includes(id) ? [...st.openIds] : [...st.openIds, id];
  const activeId = id;
  while (openIds.length > maxOpen) {
    const idx = openIds.findIndex((x) => x !== activeId && !pinned.has(x));
    if (idx === -1) break;
    openIds.splice(idx, 1);
  }
  return { openIds, activeId };
}

/**
 * Toggle a conversation's pin (#54). Pinned chats are exempt from the LRU
 * eviction and sort first in the tab bar; the flag lives ON the conversation
 * record so it persists in `cobrowse_convos` across tab close/reopen and
 * browser restarts. Unknown ids are a no-op.
 *
 * @returns {{ convos: object, pinned: boolean }} new map (spread-copied) + the NEW pin state
 */
export function togglePinConversation(convos, chatId) {
  const map = convos || {};
  const id = txt(chatId);
  const convo = map[id];
  if (!convo) return { convos: map, pinned: false };
  const pinned = !convo.pinned;
  return { convos: { ...map, [id]: { ...convo, pinned } }, pinned };
}

/**
 * Pinned-first display order (#54): stable partition of openIds — pinned
 * chats (in their existing order) first, then the rest. Pure display
 * concern: openIds itself keeps insertion order, so eviction semantics stay
 * oldest-position and the ordering never leaks into persisted state.
 */
export function orderTabsPinnedFirst(openIds, pinnedIds = []) {
  const ids = Array.isArray(openIds) ? openIds : [];
  const pinned = new Set((Array.isArray(pinnedIds) ? pinnedIds : []).map((x) => txt(x)));
  return [...ids.filter((x) => pinned.has(x)), ...ids.filter((x) => !pinned.has(x))];
}

/**
 * Close a chat tab (the conversation itself is untouched). No-op when the id
 * isn't open or when it is the last open tab — at least one stays open, like
 * a browser window. Closing the active tab activates its right neighbor, or
 * the previous tab when closing the tail.
 */
export function closeChatTab(state, chatId) {
  const st = state || createTabsState();
  const id = txt(chatId);
  const idx = st.openIds.indexOf(id);
  if (idx === -1 || st.openIds.length <= 1) return { ...st };

  const openIds = st.openIds.filter((x) => x !== id);
  const activeId =
    st.activeId === id ? (openIds[idx] !== undefined ? openIds[idx] : openIds[openIds.length - 1]) : st.activeId;
  return { openIds, activeId };
}

/** Activate an already-open tab. Unknown ids are a no-op (use openChatTab). */
export function activateChatTab(state, chatId) {
  const st = state || createTabsState();
  const id = txt(chatId);
  if (!st.openIds.includes(id)) return { ...st };
  return { openIds: [...st.openIds], activeId: id };
}

/**
 * Drop open tabs whose conversations no longer exist (deleted from the
 * history view). If the active tab was dropped, activate the first survivor;
 * an empty result keeps activeId null only when nothing survives (the caller
 * creates a fresh chat in that case).
 */
export function pruneChatTabs(state, existingIds) {
  const st = state || createTabsState();
  const existing = new Set((existingIds || []).map((x) => txt(x)));
  const openIds = st.openIds.filter((id) => existing.has(id));
  const activeId = openIds.includes(st.activeId) ? st.activeId : (openIds[0] || null);
  return { openIds, activeId };
}

/** The tab label for a conversation: its title (or "New Chat"), capped.
 * `opts.handoff` marks the tab whose chat a handoff run is driving (#166) —
 * the run-tab marker the spec promises, so a delegated run is distinguishable
 * from a chat that is merely streaming. */
export function tabTitleFor(convo, opts = {}) {
  const c = convo || {};
  const t = txt(c.title).trim() || 'New Chat';
  const capped = t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) : t;
  return opts.handoff ? `🤖 ${capped}` : capped;
}

/**
 * Rename a conversation. Empty/whitespace titles are a no-op (the previous
 * title is kept); the result never exceeds TITLE_MAX. `updatedAt` is NOT
 * bumped — renaming shouldn't reorder the history list.
 *
 * @returns {{ convos: object, changed: boolean }}  convos is a new map (spread-copied)
 */
export function renameConversation(convos, chatId, title) {
  const map = convos || {};
  const id = txt(chatId);
  const t = txt(title).trim().slice(0, TITLE_MAX);
  const convo = map[id];
  if (!convo || !t || t === txt(convo.title)) return { convos: map, changed: false };
  return { convos: { ...map, [id]: { ...convo, title: t } }, changed: true };
}

/**
 * Case-insensitive substring search over conversations — matches the title or
 * any message's text. Empty query returns every summary (updatedAt desc),
 * same shape as the history view's list. Each summary carries a one-line
 * `snippet` (the first user message, whitespace-collapsed + truncated) so the
 * chat list can show what the conversation is about without opening it.
 *
 * @returns {Array<{id,title,snippet,createdAt,updatedAt,messageCount,isActive}>}
 */
export function searchConversations(convos, query, { activeId = null } = {}) {
  const map = convos || {};
  const q = txt(query).trim().toLowerCase();
  const list = Object.values(map).filter((c) => c && typeof c === 'object' && txt(c.id));
  const matched = q
    ? list.filter((c) => {
        if (txt(c.title).toLowerCase().includes(q)) return true;
        const msgs = Array.isArray(c.messages) ? c.messages : [];
        return msgs.some((m) => m && txt(m.text).toLowerCase().includes(q));
      })
    : list;
  return matched
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((c) => ({
      id: c.id,
      title: txt(c.title).trim() || 'New Chat',
      snippet: snippetOf(c),
      createdAt: c.createdAt || 0,
      updatedAt: c.updatedAt || 0,
      messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
      isActive: c.id === activeId,
      // Zo thread id when present — drives the history card's copy-id /
      // Open-in-Zo actions (0.2.8.0). Omitted otherwise.
      ...(txt(c.zoThreadId) ? { zoThreadId: txt(c.zoThreadId) } : {}),
    }));
}

const SNIPPET_MAX = 90;

/** One-line preview of a conversation: its first user message, collapsed. */
function snippetOf(convo) {
  const msgs = Array.isArray(convo.messages) ? convo.messages : [];
  const firstUser = msgs.find((m) => m && m.role === 'user' && txt(m.text).trim());
  const s = txt(firstUser && firstUser.text).replace(/\s+/g, ' ').trim();
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX - 1) + '…' : s;
}
