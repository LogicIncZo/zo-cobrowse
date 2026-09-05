// Zo Co-browse — Shared Config Module
// Single source of truth for all config keys, defaults, load/save helpers.

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
};

export const DEFAULTS = {
  [STORAGE.API_URL]: 'https://api.zo.computer/zo/ask',
  [STORAGE.MODEL]: '',
  [STORAGE.SPACE_ENDPOINT]: 'https://cashlessconsumer.zo.space',
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
};

const SENSITIVE_KEYS = new Set([STORAGE.TOKEN, STORAGE.SPACE_ENDPOINT]);

/** Load config from storage, merging with DEFAULTS.
 *  Sensitive keys (token, endpoint) come from storage.local;
 *  everything else from storage.sync. Returns a Promise. */
export function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE.TOKEN, STORAGE.SPACE_ENDPOINT], (local) => {
      chrome.storage.sync.get(null, (sync) => {
        const config = { ...DEFAULTS };
        // Apply local-storage values (sensitive)
        for (const k of [STORAGE.TOKEN, STORAGE.SPACE_ENDPOINT]) {
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
