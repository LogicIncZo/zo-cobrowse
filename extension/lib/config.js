// Zo Co-browse — Shared Config Module
// Single source of truth for all config keys, defaults, load/save helpers.

import { DEFAULT_BUDGET } from './handoff.js';

export const STORAGE = {
  THEME: 'cobrowse_theme',
  TOKEN: 'zoAccessToken',
  MODEL: 'zoModel',
  PERSONA_ID: 'zoPersonaId',
  // Legacy persona-routing keys (read once for migration, then ignored):
  LITE_PERSONA_ID: 'zoLitePersonaId',
  FULL_PERSONA_ID: 'zoFullPersonaId',
  PERSONA_MODE: 'personaMode',
  // Mode system (replaces presets + personaMode):
  ACTIVE_MODE: 'zoActiveMode',
  CUSTOM_MODES: 'cobrowse_modes',
  // Per-built-in-id sparse overrides (editable knobs only). A catalog like
  // CUSTOM_MODES — intentionally NOT in DEFAULTS.
  MODE_OVERRIDES: 'cobrowse_mode_overrides',
  SPACE_ENDPOINT: 'zoSpaceEndpoint',
  // Zo username slug (#339) — the one user-known fact the derived hosts come
  // from: https://<slug>.zo.space + https://<slug>.zo.computer. Non-sensitive
  // (a name, not a credential); rides storage.sync.
  ZO_USERNAME: 'zoUsername',
  // Jev (TypeSafe AI System One) — 0.3.4 Lane J. The fast path ships DARK:
  // jevEnabled defaults false and nothing behavioral changes until the user
  // opts in with a key. Key + endpoint are storage.local (sensitive-routing);
  // the knobs ride storage.sync. Thresholds are PER-TYPE (noul vs choice
  // confidences are not comparable per the vendor's model notes).
  JEV_API_KEY: 'jevApiKey',
  JEV_API_URL: 'jevApiUrl',
  JEV_ENABLED: 'jevEnabled',
  JEV_MODEL: 'jevModel',
  JEV_PICK_CONFIDENCE: 'jevPickConfidence',
  JEV_DONE_CONFIDENCE: 'jevDoneConfidence',
  ENABLE_SCREENSHOTS: 'enableScreenshots',
  ENABLE_WRITE_ASSIST: 'enableWriteAssist',
  ENABLED_MENUS: 'enabledMenus',
  QUICK_ACTIONS: 'zoQuickActions',
  TTS_LANG: 'zoTtsLang',
  TTS_RATE: 'zoTtsRate',
  TTS_VOICE: 'zoTtsVoice',
  TTS_AUTO_READ: 'zoTtsAutoRead',
  API_URL: 'zoApiUrl',
  // Zo web UI origin (e.g. https://<slug>.zo.computer) — enables the
  // "#con_…" copy chip + ↗ Open-in-Zo deep link (0.2.8.0). Not a credential.
  ZO_WEB_ORIGIN: 'zoWebOrigin',
  // !handoff run budget (#158): maxTurns/maxNavigations/maxMinutes. The
  // numeric defaults live in lib/handoff.js (DEFAULT_BUDGET) — this key makes
  // them config-resident and overridable via storage.sync.
  HANDOFF_BUDGET: 'cobrowse_handoff_budget',
};

export const DEFAULTS = {
  [STORAGE.API_URL]: 'https://api.zo.computer/zo/ask',
  [STORAGE.MODEL]: '',
  // No owner-specific default (#339): an empty space endpoint means the
  // space-backed features degrade with a "set your Zo username" hint until
  // the user configures one — never silently inherit someone else's space.
  [STORAGE.SPACE_ENDPOINT]: '',
  [STORAGE.ZO_USERNAME]: '',
  [STORAGE.JEV_API_KEY]: '',
  [STORAGE.JEV_ENABLED]: false,
  [STORAGE.JEV_MODEL]: 'jev-latest',
  [STORAGE.JEV_PICK_CONFIDENCE]: 0.8,
  [STORAGE.JEV_DONE_CONFIDENCE]: 0.9,
  [STORAGE.PERSONA_ID]: '',
  [STORAGE.ACTIVE_MODE]: 'cobrowse',
  [STORAGE.ENABLE_SCREENSHOTS]: true,
  [STORAGE.ENABLE_WRITE_ASSIST]: true,
  [STORAGE.ENABLED_MENUS]: { page: true, selection: true, link: true, editable: true },
  [STORAGE.THEME]: '',
  [STORAGE.TTS_LANG]: '',
  [STORAGE.TTS_RATE]: 1.0,
  [STORAGE.TTS_VOICE]: '',
  [STORAGE.TTS_AUTO_READ]: false,
  [STORAGE.QUICK_ACTIONS]: [],
  [STORAGE.ZO_WEB_ORIGIN]: '',
  [STORAGE.HANDOFF_BUDGET]: { ...DEFAULT_BUDGET },
};

const SENSITIVE_KEYS = new Set([STORAGE.TOKEN, STORAGE.SPACE_ENDPOINT, STORAGE.JEV_API_KEY, STORAGE.JEV_API_URL]);

/** The Jev decide endpoint default — lives here (not in DEFAULTS) because it
 *  is Advanced-only and rides storage.local via SENSITIVE_KEYS routing. */
DEFAULTS[STORAGE.JEV_API_URL] = 'https://api.typesafe.ai/v1/systemone';

// Zo username slug shape: lowercase DNS-label-ish (letters/digits/hyphens,
// no leading/trailing hyphen, ≤63 chars) — the same class of name zo.space
// and zo.computer hand out. Kept permissive on purpose: validation rejects
// typos, it does not try to mirror the server's exact rules.
const ZO_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Derive the per-user hosts from the Zo username slug (#339).
 *  Returns { spaceEndpoint, webOrigin }, or null when the slug is not a
 *  valid zo username (callers show a validation error). */
export function deriveZoHosts(username) {
  const slug = String(username || '').trim().toLowerCase();
  if (!ZO_SLUG_RE.test(slug)) return null;
  return {
    spaceEndpoint: `https://${slug}.zo.space`,
    webOrigin: `https://${slug}.zo.computer`,
  };
}

/** Load config from storage, merging with DEFAULTS.
 *  Sensitive keys (token, endpoints, Jev key) come from storage.local;
 *  everything else from storage.sync. Returns a Promise. */
const LOCAL_KEYS = [STORAGE.TOKEN, STORAGE.SPACE_ENDPOINT, STORAGE.JEV_API_KEY, STORAGE.JEV_API_URL];
export function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(LOCAL_KEYS, (local) => {
      chrome.storage.sync.get(null, (sync) => {
        const config = { ...DEFAULTS };
        // Apply local-storage values (sensitive)
        for (const k of LOCAL_KEYS) {
          if (local[k] !== undefined) config[k] = local[k];
        }
        // Apply sync-storage values (safe), skip undefined
        for (const [k, v] of Object.entries(sync)) {
          if (v !== undefined && k in DEFAULTS) config[k] = v;
        }
        resolve(config);
      });
    });
  });
}

/** Save config. Token and endpoint go to storage.local (un-synced);
 *  everything else goes to storage.sync. Returns a Promise. */
export function saveConfig(partial) {
  const local = {};
  const sync = {};
  for (const [k, v] of Object.entries(partial)) {
    if (SENSITIVE_KEYS.has(k)) {
      local[k] = v;
    } else {
      sync[k] = v;
    }
  }
  return new Promise((resolve, reject) => {
    const ops = [];
    if (Object.keys(local).length) {
      ops.push(new Promise((r) => chrome.storage.local.set(local, r)));
    }
    if (Object.keys(sync).length) {
      ops.push(new Promise((r) => chrome.storage.sync.set(sync, r)));
    }
    Promise.all(ops).then(resolve).catch(reject);
  });
}

/** Subscribe to config changes. Calls handler(updatedConfig) on every change. */
export function watchConfig(handler) {
  chrome.storage.onChanged.addListener((changes, area) => {
    const relevant = {};
    for (const [k, change] of Object.entries(changes)) {
      if (k in DEFAULTS) {
        relevant[k] = change.newValue;
      }
    }
    if (Object.keys(relevant).length) {
      loadConfig().then(handler);
    }
  });
  // Fire immediately with current config
  loadConfig().then(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
