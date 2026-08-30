/**
 * i18n scaffolding (#68) — `chrome.i18n` with `_locales/en/` as the default
 * locale; UI strings only (prompt templates / action-schema docs stay English
 * — they are LLM instructions to Zo, not user-facing text).
 *
 * Pure core: `createT(getMessage)` takes any `chrome.i18n.getMessage`-shaped
 * function, so tests run against the real `_locales/en/messages.json` without
 * chrome. The page-level pass (`applyI18nDom`) walks data-i18n attributes:
 *
 *   data-i18n               → textContent
 *   data-i18n-placeholder   → placeholder attr
 *   data-i18n-title         → title attr
 *   data-i18n-aria          → aria-label attr
 *
 * Missing keys resolve to '' (chrome.i18n semantics); `t()` returns the key's
 * message or '' — call sites must tolerate it (the guard test in
 * tests/i18n.test.ts fails CI when any data-i18n key is absent from en).
 */

/** @param {(key: string, substitutions?: any) => string | undefined} getMessage */
export function createT(getMessage) {
  return function t(key, substitutions) {
    if (typeof key !== 'string' || !key) return '';
    try {
      const out = getMessage(key, substitutions);
      return typeof out === 'string' ? out : '';
    } catch {
      return '';
    }
  };
}

/** The page-bound instance (chrome.i18n when available, else a no-op). */
export const i18n = createT((key, subs) => {
  try {
    return typeof chrome !== 'undefined' && chrome.i18n ? chrome.i18n.getMessage(key, subs) : undefined;
  } catch {
    return undefined;
  }
});

export function applyI18nDom(doc = (typeof document !== 'undefined' ? document : undefined), t = i18n) {
  if (!doc || !doc.querySelectorAll) return 0;
  let applied = 0;
  const set = (el, attr, value) => {
    if (!value) return;
    if (attr) el.setAttribute(attr, value);
    else el.textContent = value;
    applied++;
  };
  for (const el of doc.querySelectorAll('[data-i18n]')) set(el, null, t(el.getAttribute('data-i18n')));
  for (const el of doc.querySelectorAll('[data-i18n-placeholder]')) set(el, 'placeholder', t(el.getAttribute('data-i18n-placeholder')));
  for (const el of doc.querySelectorAll('[data-i18n-title]')) set(el, 'title', t(el.getAttribute('data-i18n-title')));
  for (const el of doc.querySelectorAll('[data-i18n-aria]')) set(el, 'aria-label', t(el.getAttribute('data-i18n-aria')));
  return applied;
}
