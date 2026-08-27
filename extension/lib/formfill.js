// Form-fill heuristics (#26) — pure logic. What makes a form "sensitive"
// (needs the review card) and how proposed values are masked for display.
// Conservative by design: a false positive costs one review click; a false
// negative auto-fills a sensitive form.

// "ccnum"/"exp-date" variants cover real-world card-field names ("ccnumber",
// "exp_month") that the bare "card"/"expir" stems miss — the #26 plan's own
// truth-table test pinned these. "password" covers label-only password rows
// whose captured metadata couldn't be joined (no placeholder/name match).
const SENSITIVE_FIELD_RE = /password|card|cc[-_.\s]?num|ccv|cvc|cvv|expir|exp[-_.\s]?(date|month|mo|year|yr)|ssn|social|security|tax|pin\b|passport|licen[cs]e/i;
const SENSITIVE_URL_RE = /login|signin|sign-in|signup|sign-up|register|checkout|payment|billing|account|password|banking/i;

/**
 * @param {Array<{type?:string,name?:string,placeholder?:string}>|null} fields — get_form-shape capture
 * @param {string|null} url
 * @returns {{sensitive:boolean,reasons:string[]}}
 */
export function isSensitiveForm(fields, url) {
  const reasons = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    const type = String((f && f.type) || '').toLowerCase();
    const surface = `${(f && f.name) || ''} ${(f && f.placeholder) || ''}`.toLowerCase();
    if (type === 'password') { reasons.push('password field'); break; }
    if (SENSITIVE_FIELD_RE.test(surface)) { reasons.push(`sensitive field "${(f && (f.name || f.placeholder)) || type}"`); break; }
  }
  if (!reasons.length && SENSITIVE_URL_RE.test(String(url || ''))) reasons.push('sensitive page URL');
  return { sensitive: reasons.length > 0, reasons };
}

/** Mask for display. Never used as a value — values come only from the model/user. */
export function redactValue(value) {
  const v = String(value == null ? '' : value);
  if (!v) return '';
  return v.length >= 4 ? '••••' + v.slice(-2) : '••••';
}

/**
 * Join a fill batch (fill_form actions AND/OR plain fill actions — models
 * drift between the two) with captured field metadata for the review card.
 * Rows carry `ai`/`vi` back-references so edits can be mapped onto the
 * original actions. Secret rows (password-type or sensitive-named) carry an
 * EMPTY value — the card shows "left for you", the user's password manager
 * owns secrets.
 */
export function fillBatchRows(actions, fields) {
  const caps = Array.isArray(fields) ? fields : [];
  const rows = [];
  (Array.isArray(actions) ? actions : []).forEach((a, ai) => {
    if (!a) return;
    if (a.type === 'fill_form') {
      (a.values || []).forEach((v, vi) => {
        const meta = caps.find((f) =>
          (f.placeholder && f.placeholder === v.target) ||
          (f.question && f.question === v.target) ||
          (f.name && f.name === v.target) ||
          (v.selector && f.selector === v.selector)) || null;
        const type = String((meta && meta.type) || '').toLowerCase();
        const secret = type === 'password' || SENSITIVE_FIELD_RE.test(String(v.target));
        rows.push({
          kind: 'fill_form', ai, vi, target: v.target,
          value: secret ? '' : String(v.value == null ? '' : v.value),
          type, secret, redacted: redactValue(v.value),
        });
      });
    } else if (a.type === 'fill') {
      // Plain fill targets a selector; label it from the captured metadata
      // when the selector can be joined (by selector or embedded name).
      const sel = String(a.selector || '');
      const meta = caps.find((f) => sel && f.selector === sel) ||
        caps.find((f) => f.name && sel.includes(f.name)) || null;
      const label = (meta && (meta.question || meta.placeholder || meta.name)) || sel || 'field';
      const type = String((meta && meta.type) || '').toLowerCase();
      const secret = type === 'password' || SENSITIVE_FIELD_RE.test(sel) || SENSITIVE_FIELD_RE.test(label);
      rows.push({
        kind: 'fill', ai, vi: null, selector: sel, target: label,
        value: secret ? '' : String(a.value == null ? '' : a.value),
        type, secret, redacted: redactValue(a.value),
      });
    }
  });
  return rows;
}

/**
 * Join a fill_form action's proposed values with captured field metadata for
 * the review card. Secret rows carry an EMPTY value — never round-trips
 * through the card.
 */
export function reviewRows(action, fields) {
  return fillBatchRows([action], fields).map((r) => ({
    target: r.target, value: r.value, type: r.type, secret: r.secret, redacted: r.redacted,
  }));
}
