/**
 * Diagnostics sharing (user-triggered, anonymous, 24h-expiry) — the pure half
 * behind Settings → Share diagnostics. Builds a text bundle from the #67
 * metadata-only debug log and uploads it to an anonymous paste host.
 *
 * PRIVACY POSTURE, load-bearing:
 * - The bundle is composed ONLY from the debug ring (already metadata-only,
 *   enforced in lib/debug-log.js) plus an explicit allowlist of settings —
 *   never page text, prompts, tokens, URLs of browsed pages, conversation
 *   ids, or non-allowlisted config (model ids and workspace origins are
 *   deliberately excluded: a byok model id or a personal zo.space slug
 *   would de-anonymize the report).
 * - Free-form strings (error messages, extras) are scrubbed again here:
 *   URLs reduced to origin+path, opaque identifier runs redacted — defense
 *   in depth even though the ring should never hold them.
 * - Upload happens ONLY on an explicit user click; the default state sends
 *   nothing anywhere. Hosts are anonymous (no account, no auth headers) and
 *   the bundle is requested with a 24-hour expiry.
 */

/** Settings rendered into the bundle — literal allowlist; everything else in
 * storage is invisible to the share path even if the caller passes it. */
export const SETTINGS_SNAPSHOT_KEYS = [
  'debugMode',
  'domContextEnabled',
  'enableScreenshots',
  'enableWriteAssist',
  'jevEnabled',
  'jevModel',
  'jevPickConfidence',
  'jevDoneConfidence',
  'cobrowse_handoff_budget',
  'zoTtsAutoRead',
];

export const DIAG_SHARE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Anonymous paste hosts, tried in order. dpaste.com takes expiry_days (1 =
 * 24h); 0x0.st takes an absolute epoch `expires`. Neither needs an account. */
export const PASTE_HOSTS = [
  {
    name: 'dpaste.com',
    endpoint: 'https://dpaste.com/api/v2/',
    bodyType: 'form',
    fields: (text) => ({ content: text, syntax: 'text', expiry_days: '1' }),
  },
  {
    name: '0x0.st',
    endpoint: 'https://0x0.st/',
    bodyType: 'multipart',
    fields: (text, now) => ({
      file: new Blob([text], { type: 'text/plain' }),
      expires: String(Math.floor(now / 1000) + DIAG_SHARE_EXPIRY_MS / 1000),
    }),
  },
];

const URL_RE = /^https?:\/\//i;
const OPAQUE_RUN_RE = /[A-Za-z0-9_\-]{24,}/g;

/** A browsed URL is quasi-identifying — the share bundle keeps origin+path
 * and drops query/hash (they carry tokens, filters, session keys). */
export function redactUrl(u) {
  try {
    const parsed = new URL(String(u));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return (parsed.origin + parsed.pathname).slice(0, 200);
  } catch {
    return '';
  }
}

/** Last-line scrub for free-form strings: truncate, collapse URLs to their
 * redacted form, and blank out long opaque runs (tokens, ids, signatures). */
export function scrubText(s) {
  let out = String(s ?? '').slice(0, 200);
  out = out.replace(/https?:\/\/[^\s'"<>]+/gi, (m) => redactUrl(m) || '«url»');
  out = out.replace(OPAQUE_RUN_RE, '«id»');
  return out;
}

/**
 * Render the share bundle as plain text.
 * @param {{
 *   version: string, userAgent: string, sessionId: string, now: number,
 *   entries: Array<{ts:number, kind:string, label:string, durMs?:number, traceId?:string, extra?:object}>,
 *   dropped?: number, enabled?: boolean, settings?: object,
 * }} opts
 * @returns {string}
 */
export function buildDiagnosticsBundle(opts) {
  const {
    version = '', userAgent = '', sessionId = '', now = Date.now(),
    entries = [], dropped = 0, enabled = true, settings = {},
  } = opts || {};

  const lines = [];
  lines.push('# Zo Co-browse diagnostics — anonymous, metadata-only');
  lines.push(`generated: ${new Date(now).toISOString()}`);
  lines.push(`extension: ${scrubText(version)}`);
  lines.push(`platform: ${scrubText(userAgent)}`);
  lines.push('session: (random per install — not linked to any account)');
  if (sessionId) lines.push(`session-id: ${scrubText(sessionId)}`);
  lines.push(`debugMode: ${enabled ? 'on' : 'off'} · events: ${entries.length}${dropped ? ` · ${dropped} dropped (ring full)` : ''}`);
  lines.push('');

  const allow = new Set(SETTINGS_SNAPSHOT_KEYS);
  const rows = Object.entries(settings || {})
    .filter(([k]) => allow.has(k))
    .filter(([, v]) => v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string');
  if (rows.length) {
    lines.push('## Settings (allowlisted, non-identifying)');
    for (const [k, v] of rows) lines.push(`${k}: ${typeof v === 'string' ? scrubText(v) : JSON.stringify(v)}`);
    lines.push('');
  }

  const t0 = entries.length ? entries[0].ts : now;
  lines.push('## Events (relative to first)');
  for (const e of entries.slice(-300)) {
    const rel = ((e.ts - t0) / 1000).toFixed(1);
    let line = `+${rel}s [${e.kind}] ${scrubText(e.label)}`;
    if (typeof e.durMs === 'number') line += ` (${e.durMs}ms)`;
    if (e.traceId) line += ` trace=${scrubText(e.traceId)}`;
    if (e.extra && typeof e.extra === 'object') {
      const parts = Object.entries(e.extra).map(([k, v]) =>
        `${k}=${typeof v === 'string' ? scrubText(v) : JSON.stringify(v)}`);
      line += ` {${parts.join(', ')}}`;
    }
    lines.push(line);
  }
  if (!entries.length) lines.push('(no events recorded)');
  return lines.join('\n');
}

const UPLOAD_TIMEOUT_MS = 15000;

function looksLikeUrl(s) {
  return typeof s === 'string' && /^https?:\/\/\S+$/.test(s.trim());
}

/**
 * Upload `text` to the first host that accepts it. Injectable fetch (same
 * pattern as jevDecideImpl); never throws — failures collapse into one
 * combined error naming every host that was tried.
 * @returns {Promise<{ok:true, url:string, host:string, expiresAt:number}
 *              |{ok:false, error:string}>}
 */
export async function uploadDiagnostics(text, { fetchImpl, now = Date.now() } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, error: 'no fetch transport available' };
  if (!text || !text.trim()) return { ok: false, error: 'nothing to upload — the diagnostics bundle is empty' };

  const failures = [];
  for (const host of PASTE_HOSTS) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), UPLOAD_TIMEOUT_MS) : null;
    try {
      let body;
      if (host.bodyType === 'form') {
        body = new URLSearchParams(host.fields(text, now)).toString();
      } else {
        const fd = new FormData();
        for (const [k, v] of Object.entries(host.fields(text, now))) fd.append(k, v);
        body = fd;
      }
      const res = await doFetch(host.endpoint, {
        method: 'POST',
        body,
        signal: ctl?.signal,
      });
      const out = await res.text();
      if (!res.ok) {
        failures.push(`${host.name}: HTTP ${res.status}${out ? ' — ' + out.slice(0, 120) : ''}`);
        continue;
      }
      if (!looksLikeUrl(out)) {
        failures.push(`${host.name}: unexpected response`);
        continue;
      }
      return { ok: true, url: out.trim(), host: host.name, expiresAt: now + DIAG_SHARE_EXPIRY_MS };
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? `timed out after ${UPLOAD_TIMEOUT_MS / 1000}s` : (err?.message || String(err));
      failures.push(`${host.name}: ${msg}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { ok: false, error: failures.join('; ') || 'no paste host configured' };
}
