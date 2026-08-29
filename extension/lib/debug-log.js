/**
 * Debug-mode diagnostics ring buffer (#67) — the instrument behind the
 * evidence-first perf pass and panel-only bug reports.
 *
 * Pure and injectable (no chrome.*): the background owns one instance and
 * feeds it metadata-only events (message types, capture durations, stream
 * phases). PRIVACY CONTRACT, enforced here: entries carry kinds, labels,
 * durations and small scalar extras only — strings are truncated, non-scalar
 * extras are dropped — never page text, prompts, or tokens.
 *
 * @param {{ max?: number, now?: () => number }} opts
 * @returns {{
 *   setEnabled(on: boolean): void,
 *   isEnabled(): boolean,
 *   push(kind: string, label: string, durMs?: number, extra?: object): void,
 *   entries(): Array<object>,
 *   clear(): void,
 * }}
 */
export function createDebugLog({ max = 500, now = Date.now } = {}) {
  let enabled = false;
  let buf = [];
  let dropped = 0;

  const cleanExtra = (extra) => {
    if (!extra || typeof extra !== 'object') return undefined;
    const out = {};
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string') out[k] = v.slice(0, 120);
      // anything else (objects/arrays/functions) is dropped — metadata only
    }
    return Object.keys(out).length ? out : undefined;
  };

  return {
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) { buf = []; dropped = 0; }
    },
    isEnabled() {
      return enabled;
    },
    push(kind, label, durMs, extra) {
      if (!enabled) return;
      if (buf.length >= max) {
        buf.shift();
        dropped++;
      }
      const entry = { ts: now(), kind: String(kind).slice(0, 40), label: String(label).slice(0, 120) };
      if (typeof durMs === 'number' && Number.isFinite(durMs)) entry.durMs = Math.round(durMs * 100) / 100;
      const ex = cleanExtra(extra);
      if (ex) entry.extra = ex;
      buf.push(entry);
    },
    entries() {
      return { entries: [...buf], dropped, enabled };
    },
    clear() {
      buf = [];
      dropped = 0;
    },
  };
}
