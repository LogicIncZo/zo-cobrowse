// Tab contexts — "tabs as contexts", VSCode-style. Pure logic, no chrome.* or
// DOM dependencies. Referenced tabs travel as a compact manifest + excerpt;
// full content is pulled on demand via the `read_tab` action and re-injected
// as an auto follow-up turn. See
// docs/superpowers/specs/2026-08-14-tab-contexts-design.md

/** Max tabs listed in the sidepanel chip strip. */
export const STRIP_MAX_TABS = 10;

/** Per-tab excerpt length (chars) before the shared budget is applied. */
export const TAB_EXCERPT_CHARS = 500;

/** Total excerpt budget across all referenced tabs in one prompt. */
export const TAB_EXCERPT_BUDGET = 8000;

/** Below this remaining budget a tab gets no excerpt line at all. */
export const TAB_EXCERPT_FLOOR = 100;

/** Max read_tab follow-up cycles per user turn (runaway-loop guard). */
export const MAX_READ_TAB_CYCLES = 3;

/**
 * Host of a URL, '' when unparseable. Never throws — used for pills and
 * manifest lines, not for network access.
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}

/** Blank-page hosts by scheme: new tabs / about:blank (cold-start family). */
const BLANK_HOSTS = {
  'about:': new Set(['blank', 'newtab']),
  'chrome:': new Set(['newtab', 'new-tab-page']),
};

/**
 * True for URLs that carry no page content: the empty/missing url and the
 * new-tab / about:blank family (matched on scheme+host, so case, trailing
 * slashes, and queries don't matter). Cold-start turns skip page context
 * entirely for these — see
 * docs/superpowers/specs/2026-08-15-cold-start-open-all-design.md
 */
export function isBlankPage(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!u) return true;
  try {
    const parsed = new URL(u);
    const hosts = BLANK_HOSTS[parsed.protocol];
    if (!hosts) return false;
    // about: URLs are opaque-path (no hostname) — `about:blank` lives in the
    // pathname; chrome:// hosts parse normally.
    const host = (parsed.hostname || parsed.pathname.replace(/^\/+|\/+$/g, '')).toLowerCase();
    return hosts.has(host);
  } catch {
    return false; // unparseable non-empty → treat as a page, not a new tab
  }
}

/** True for URLs page capture works on (http/https). The chip-strip filter. */
export function isCapturableUrl(url) {
  return typeof url === 'string' && /^https?:/i.test(url);
}

/** ~18k chars / 840 chars — compact text-size hint for manifest lines. */
export function formatChars(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 chars';
  return n >= 1000 ? `~${Math.round(n / 1000)}k chars` : `${Math.round(n)} chars`;
}

/**
 * Assign refs T1…Tn in array (strip) order. Refs are per-turn; the ref→tabId
 * mapping lives in extension state, never in the prompt.
 * @returns {Array} a new array; inputs are not mutated
 */
export function assignRefs(tabContexts) {
  return (tabContexts || []).map((t, i) => ({ ...t, ref: `T${i + 1}` }));
}

/**
 * Render the per-tab manifest lines (no `## Referenced Tabs` header — the
 * prompt assembler owns section headers). One line per tab plus an optional
 * excerpt line, applying the shared excerpt budget in order:
 *   - available background tab → stats + excerpt
 *   - pointerOnly (excerpt already sent on an earlier turn) →
 *     "already provided above" and no excerpt (threading retains it)
 *   - active tab already attached by the context policy this turn →
 *     "(this tab, attached above)" and no excerpt (content rides in
 *     ## Page Content — no double-send)
 *   - capture unavailable → "— unavailable, URL only"
 *
 * @param {Array} tabContexts  TabContext-shaped entries (ref assigned)
 * @param {{ activeTabAttached?: boolean }} [opts]
 * @returns {{ rendered: string, entries: Array<{ref,tabId,line,excerptLine?}> }}
 */
export function buildTabManifest(tabContexts, opts) {
  const activeAttached = !!(opts && opts.activeTabAttached);
  let budget = TAB_EXCERPT_BUDGET;
  const entries = [];

  for (const t of tabContexts || []) {
    const host = t.host || hostOf(t.url);
    const quoted = t.title ? `"${t.title}"` : host || t.url;
    let line;
    let excerptLine;

    if (t.isActive && activeAttached) {
      line = `- [${t.ref}] ${quoted} — ${host} — (this tab, attached above)`;
    } else if (t.pointerOnly) {
      line = `- [${t.ref}] ${quoted} — ${host} — already provided above`;
    } else if (!t.available) {
      line = `- [${t.ref}] ${quoted} — ${host} — unavailable, URL only`;
      line += t.url ? ` — ${t.url}` : '';
    } else {
      const els = Number.isFinite(t.elementCount) ? Math.round(t.elementCount) : 0;
      line = `- [${t.ref}] ${quoted} — ${host} — ${formatChars(t.textLength)} text, ${els} links — not attached`;
      const take = Math.min(TAB_EXCERPT_CHARS, budget);
      if (take >= TAB_EXCERPT_FLOOR) {
        budget -= take;
        const ex = String(t.excerpt || '').slice(0, take).replace(/\s+/g, ' ').trim();
        if (ex) excerptLine = `  > Excerpt: ${ex}`;
      }
    }
    entries.push(excerptLine ? { ref: t.ref, tabId: t.tabId, line, excerptLine } : { ref: t.ref, tabId: t.tabId, line });
  }

  return { rendered: entries.map((e) => (e.excerptLine ? `${e.line}\n${e.excerptLine}` : e.line)).join('\n'), entries };
}

/**
 * Build the auto follow-up `input` for one read_tab cycle.
 *
 * @param {{ref:string,title:string,url:string,host?:string}} refData
 * @param {object|null} capture  pageContext-shaped ({visibleText,...}) or null
 * @param {{ textBudget?: number, reason?: 'request'|'duplicate'|'budget' }} [opts]
 * @returns {{ input: string, kind: 'content'|'unavailable'|'duplicate'|'budget' }}
 */
export function buildTabFollowUp(refData, capture, opts) {
  const o = opts || {};
  const host = refData.host || hostOf(refData.url);
  const quoted = refData.title ? `"${refData.title}"` : host || refData.url;
  const header = `## Auto-attached: tab [${refData.ref}] ${quoted}${host ? ` — ${host}` : ''}`;
  const urlLine = refData.url ? `- URL: ${refData.url}` : '';
  const head = urlLine ? `${header}\n${urlLine}` : header;

  if (o.reason === 'budget') {
    return {
      input: `${head}\n(tab-read budget for this turn exhausted — wrap up with what you have)`,
      kind: 'budget',
    };
  }
  if (o.reason === 'blank') {
    return {
      input: `${head}\n(that tab is on a blank/new-tab page — nothing to read)`,
      kind: 'blank',
    };
  }
  if (o.reason === 'duplicate') {
    return {
      input: `${head}\n(content already provided above — continue with what you have)`,
      kind: 'duplicate',
    };
  }
  if (!capture || typeof capture !== 'object') {
    return {
      input: `${head}\n(tab no longer available — continue with what you have)`,
      kind: 'unavailable',
    };
  }

  const budget = Number.isInteger(o.textBudget) && o.textBudget > 0 ? o.textBudget : 12000;
  const text = String(capture.visibleText || '—empty—').substring(0, budget);
  return {
    input:
      `${head}\n` +
      '```text\n' +
      `${text}\n` +
      '```\n' +
      'Continue with the user\'s request using this content.',
    kind: 'content',
  };
}

/**
 * Extract validated read_tab requests from a Zo actions array. Malformed
 * entries are ignored (never fatal — unknown actions already no-op in
 * executeDomAction).
 * @returns {Array<{ref:string}>}
 */
export function extractReadTabRequests(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((a) => a && typeof a === 'object' && a.type === 'read_tab' && typeof a.ref === 'string' && a.ref.trim())
    .map((a) => ({ ref: a.ref.trim() }));
}

// ---- conversation-state helpers (peer of context-policy's active-tab state) ----

/**
 * Record that a tab's full content was sent at a given page hash — the
 * send-once rule extended from one tab to N. Returns a NEW state object.
 */
export function noteTabSent(state, tabId, pageHash) {
  return { ...(state || {}), tabsSent: { ...((state && state.tabsSent) || {}), [String(tabId)]: pageHash } };
}

/** True when this tab's content was already sent at exactly this page hash. */
export function isTabSentAt(state, tabId, pageHash) {
  return !!(state && state.tabsSent && state.tabsSent[String(tabId)] === pageHash);
}

/**
 * Cheap content key for an already-captured TabContext: the manifest-excerpt
 * dedup compares these (url + title — the same navigation-signal precision
 * computePageHash uses; mid-page content changes ride under it, which is
 * acceptable: threading retains the stale 500-char hint and `read_tab` /
 * `read_page` re-pull full content on demand).
 */
export function tabContentKey(t) {
  if (!t || typeof t !== 'object') return '';
  return `${t.url || ''}|${t.title || ''}`;
}

/**
 * Follow-up token thinning for referenced tabs (send-once excerpts): a tab
 * whose content key was already sent to Zo — recorded in the per-chat
 * conversation state's `tabManifestSent` — rides as a pointer-only manifest
 * line ("already provided above") instead of re-sending its 500-char
 * excerpt. Zo's conversation threading retains the excerpt; the manifest line
 * keeps the T-ref alive for read_tab escalation.
 *
 * Pure. Returns { contexts, sentMap }: the thinned per-turn array (inputs not
 * mutated) and the updated dedup map to persist (every sent tab is recorded,
 * so a LATER turn's unchanged tab dedups even if THIS turn is the first send).
 *
 * @param {Array<object>} tabContexts  this turn's tab contexts (pre-ref assignment)
 * @param {Record<string,string>|undefined} sentMap  prior `tabManifestSent`
 */
export function thinTabExcerpts(tabContexts, sentMap) {
  const prior = sentMap && typeof sentMap === 'object' ? sentMap : {};
  const contexts = [];
  const next = { ...prior };
  for (const t of Array.isArray(tabContexts) ? tabContexts : []) {
    if (!t || typeof t !== 'object' || t.tabId == null) continue;
    const key = tabContentKey(t);
    const alreadySent = key && prior[String(t.tabId)] === key;
    if (alreadySent) {
      contexts.push({ ...t, pointerOnly: true, excerpt: '' });
    } else {
      contexts.push({ ...t });
      if (key) next[String(t.tabId)] = key;
    }
  }
  return { contexts, sentMap: next };
}

/**
 * Auto-reference the ACTIVE browser tab on tier-0 turns (reads + same-page
 * follow-ups — any turn whose page content is NOT attached): unless the user
 * already referenced it, prepend it so it becomes T1 in the manifest. Pure;
 * returns the input array as-is when there is nothing to add.
 *
 * @param {Array<object>} tabContexts  this turn's referenced tabs (strip order)
 * @param {object|null} activeTabCtx  the active tab's TabContext (or null when
 *   it couldn't be captured — chrome:// pages, missing tabId). A blank/new-tab
 *   active tab is NEVER auto-referenced (cold start carries no page pointer).
 * @returns {Array<object>}
 */
export function ensureActiveTabRef(tabContexts, activeTabCtx) {
  const hasActive = activeTabCtx && typeof activeTabCtx === 'object' && activeTabCtx.tabId != null;
  const blankActive = hasActive && isBlankPage(activeTabCtx.url);
  if (!Array.isArray(tabContexts)) {
    return hasActive && !blankActive ? [{ ...activeTabCtx, isActive: true }] : [];
  }
  // No-op paths return the input array unchanged (reference-stable).
  if (!hasActive || blankActive) return tabContexts;
  if (tabContexts.some((t) => t && typeof t === 'object' && t.tabId === activeTabCtx.tabId)) return tabContexts; // user already referenced it — keep their ref order
  return [{ ...activeTabCtx, isActive: true }, ...tabContexts];
}
