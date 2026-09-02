// Chat export (Lane D) — pure serializer: a persisted conversation record →
// a downloadable Markdown transcript. No chrome.*/DOM deps; the sidepanel
// owns the Blob download. Tool-trace internals are deliberately omitted —
// the export is the conversation a reader would want, not a debug log.
// Spec: docs/superpowers/specs/2026-08-30-0.2.7-slate-design.md § Lane D item 6.

const TIER_LABELS = {
  0: '🔗 URL-only context',
  1: '📝 Text context',
  2: '🧩 Elements context',
  3: '📷 Screenshot context',
};

const ROLE_LABELS = {
  user: '🧑 You',
  assistant: '🤖 Zo',
};

/** Slug a conversation title for a filename: lowercase, alnum+dashes, capped. */
export function slugifyTitle(title, max = 40) {
  const slug = String(title || 'chat')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'chat';
}

/** `zo-chat-<slug>-<YYYYMMDD>.md` from the export date (UTC, deterministic). */
export function exportFileName(title, exportedAt = Date.now()) {
  const d = new Date(exportedAt);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `zo-chat-${slugifyTitle(title)}-${ymd}.md`;
}

function formatClock(ts) {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDay(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

/** Serialize one message record (or null for messages that carry no
 * exportable content — system/thinking rows are skipped by the caller too). */
function messageToMarkdown(msg) {
  const role = String(msg.role || '');
  const label = ROLE_LABELS[role];
  if (!label) return null; // system/error/thinking rows are not transcript turns
  const text = String(msg.text || '').trim();
  if (!text) return null;

  const parts = [];
  let header = label;
  if (msg.timestamp) header += ` — ${formatClock(msg.timestamp)}`;
  if (role === 'assistant') {
    if (msg.contextTier !== undefined && TIER_LABELS[msg.contextTier]) {
      header += ` · ${TIER_LABELS[msg.contextTier]}`;
    }
    if (msg.durationMs) header += ` · ${(msg.durationMs / 1000).toFixed(1)}s`;
  }
  parts.push(`## ${header}`);
  parts.push('');
  parts.push(text);

  if (msg.reasoning) {
    parts.push('');
    parts.push('> 💭 ' + String(msg.reasoning).replace(/\n/g, '\n> '));
  }
  return parts.join('\n');
}

/** The whole conversation → one Markdown document.
 * @param {{title: string, messages: Array<object>, exportedAt?: number}} conv
 * @returns {string} */
export function conversationToMarkdown(conv) {
  const exportedAt = conv.exportedAt ?? Date.now();
  const turns = (conv.messages || [])
    .map(messageToMarkdown)
    .filter(Boolean);
  const body = turns.length
    ? turns.join('\n\n---\n\n')
    : '_This conversation has no exportable turns._';
  return [
    `# ${String(conv.title || 'Zo conversation')}`,
    '',
    `_Exported from Zo Co-browse · ${formatDay(exportedAt)}_`,
    '',
    '---',
    '',
    body,
    '',
  ].join('\n');
}
