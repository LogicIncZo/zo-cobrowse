// Zo Co-browse — Options / Settings Logic

const $ = (sel) => document.querySelector(sel);

// ---- Theme ----
const THEME_STORAGE_KEY = 'cobrowse_theme';
const OPTIONS_THEME_SELECTOR = 'options-theme';

// Theme names indexed by value (empty = system)
const THEME_NAMES = {
  '': 'System',
  'dark': 'Observatory Dark',
  'light': 'Observatory Light',
  'sepia': 'Sepia',
  'forest': 'Forest',
  'ocean': 'Ocean',
};

function loadOptionsTheme() {
  chrome.storage.sync.get(THEME_STORAGE_KEY, (result) => {
    const theme = result[THEME_STORAGE_KEY] || '';
    const effective = theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', effective);
    const sel = document.getElementById(OPTIONS_THEME_SELECTOR);
    if (sel) sel.value = theme;
  });
}

function applyOptionsTheme(theme) {
  const effective = theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', effective);
  chrome.storage.sync.set({ [THEME_STORAGE_KEY]: theme });
}

// ---- Debug diagnostics (#67) ----
// The background records metadata-only timings while debugMode is on; this
// exports them via clipboard (nothing leaves the browser otherwise).
async function refreshDebugControls(on) {
  const btn = document.getElementById('copy-diagnostics');
  const status = document.getElementById('debug-status');
  if (!btn) return;
  btn.disabled = !on;
  if (!on) {
    if (status) status.textContent = '';
    return;
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOG' });
    if (status) {
      status.textContent = resp && Array.isArray(resp.entries)
        ? `${resp.entries.length} event(s) recorded${resp.dropped ? ` · ${resp.dropped} dropped (ring full)` : ''}`
        : '';
    }
  } catch { /* background unavailable */ }
}

async function copyDiagnostics() {
  const status = document.getElementById('debug-status');
  const btn = document.getElementById('copy-diagnostics');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOG' });
    const text = JSON.stringify({
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      version: chrome.runtime.getManifest().version,
      ...resp,
    }, null, 2);
    await navigator.clipboard.writeText(text);
    if (btn) btn.textContent = '✅ Copied';
    if (status) status.textContent = `Copied ${resp?.entries?.length ?? 0} event(s) — paste into your bug report.`;
  } catch (err) {
    if (status) status.textContent = `Export failed: ${err?.message || err}`;
  } finally {
    setTimeout(() => { if (btn) btn.textContent = '📋 Copy diagnostics'; }, 2000);
  }
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', async () => {
  loadOptionsTheme();
  // Listen for system theme changes when no override is set
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', loadOptionsTheme);

  const form = document.getElementById('settings-form');
  const testBtn = document.getElementById('test-btn');
  const statusMsg = document.getElementById('status-message');
  const tokenInput = document.getElementById('access-token');
  const spaceEndpointInput = document.getElementById('space-endpoint');
  const modelStatus = document.getElementById('model-status');
  const themeSelect = document.getElementById(OPTIONS_THEME_SELECTOR);

  // Runtime version from the manifest — never a hardcoded (stale) string.
  const versionEl = document.getElementById('ext-version');
  try {
    if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch { /* manifest unavailable in tests */ }

  // Token show/hide — the password field hides the secret from shoulder-surfers
  // but users need to verify a pasted token.
  const tokenToggle = document.getElementById('token-toggle');
  if (tokenToggle) {
    tokenToggle.addEventListener('click', () => {
      const show = tokenInput.type === 'password';
      tokenInput.type = show ? 'text' : 'password';
      tokenToggle.textContent = show ? 'Hide' : 'Show';
      tokenToggle.title = show ? 'Hide token' : 'Show token';
    });
  }

  // Unsaved-changes dirty tracking. The form saves ONLY on submit, but two
  // controls autosave (model select, quick-action rows) — mark them so they
  // don't falsely flag the form as dirty.
  let dirtyEls = [];
  const markDirty = () => {
    if (dirtyEls.length) return;
    dirtyEls = [...form.querySelectorAll('button[type="submit"]')];
    dirtyEls.forEach((b) => b.classList.add('save-dirty'));
    if (statusMsg && !statusMsg.textContent) {
      statusMsg.textContent = 'Unsaved changes — remember to Save Settings.';
      statusMsg.className = 'inline-status pending';
    }
  };
  const clearDirty = () => {
    dirtyEls.forEach((b) => b.classList.remove('save-dirty'));
    dirtyEls = [];
  };
  form.addEventListener('input', (e) => {
    if (e.target.closest('#quick-actions-list') || e.target.id === 'model') return; // autosave controls
    markDirty();
  });
  form.addEventListener('change', (e) => {
    if (e.target.closest('#quick-actions-list') || e.target.id === 'model') return;
    markDirty();
  });

  // Persona field (the Mode is chosen in the side panel; here we only pin the
  // default persona that executes requests).
  const personaSelect = document.getElementById('persona-select');

  // Theme selector
  if (themeSelect) {
    themeSelect.addEventListener('change', () => applyOptionsTheme(themeSelect.value));
  }

  // ── Section tabs: one pane visible at a time (no page-long scroll) ──
  // Each .settings-tab shows its .tab-pane and hides the others; the last
  // visited tab persists in localStorage so reopening Settings lands where
  // you left off. Deep links (#card-*) still work: a matching card's pane
  // is activated.
  const nav = document.getElementById('settings-nav');
  if (nav) {
    const tabs = [...nav.querySelectorAll('.settings-tab')];
    const activate = (paneId, save = true) => {
      const pane = document.getElementById(paneId);
      if (!pane) return false;
      for (const t of tabs) t.classList.toggle('active', t.dataset.pane === paneId);
      for (const p of document.querySelectorAll('.tab-pane')) p.hidden = p.id !== paneId;
      if (save) { try { localStorage.setItem('cobrowse_settings_tab', paneId); } catch { /* storage unavailable */ } }
      return true;
    };
    for (const t of tabs) t.addEventListener('click', () => activate(t.dataset.pane));
    // Same-document #card-* navigations (hash clicks/updates after load).
    window.addEventListener('hashchange', () => {
      if (!location.hash.startsWith('#card-')) return;
      const card = document.querySelector(location.hash);
      const pane = card && card.closest('.tab-pane');
      if (pane) activate(pane.id, false);
    });
    // A #card-* deep link (e.g. from an old bookmark) opens that card's pane.
    if (location.hash.startsWith('#card-')) {
      const card = document.querySelector(location.hash);
      const pane = card && card.closest('.tab-pane');
      if (pane) activate(pane.id, false);
    } else {
      let initial = 'pane-connection';
      try { initial = localStorage.getItem('cobrowse_settings_tab') || initial; } catch { /* storage unavailable */ }
      if (!activate(initial, false)) activate('pane-connection', false);
    }
  }

  // Quick Actions management
  let quickActions = [];

  function getModelValue() {
    const el = document.getElementById('model');
    return el ? el.value : '';
  }

  function getModelEl() {
    return document.getElementById('model');
  }

  function renderQuickActionsEditor() {
    const area = document.getElementById('quick-actions-list');
    if (!area) return;
    area.innerHTML = '';
    const actions = quickActions.length ? quickActions : [{ label: '', prompt: '' }];
    actions.forEach((action, i) => {
      const row = document.createElement('div');
      row.className = 'qa-row';
      row.innerHTML = `
        <input type="text" class="qa-label" placeholder="Label" value="${escapeHtml(action.label)}" data-index="${i}" />
        <input type="text" class="qa-prompt" placeholder="Prompt" value="${escapeHtml(action.prompt)}" data-index="${i}" />
        <button class="qa-remove" data-index="${i}" ${actions.length === 1 ? 'disabled' : ''}>✕</button>
      `;
      area.appendChild(row);
    });
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Load config — sensitive fields from storage.local, rest from storage.sync
  chrome.storage.local.get(['zoAccessToken', 'zoSpaceEndpoint'], (localResult) => {
    chrome.storage.sync.get([
      'zoModel', 'zoPersonaId',
      'zoQuickActions',
      'zoTtsLang', 'zoTtsRate', 'zoTtsAutoRead', 'enabledMenus', 'enableScreenshots', 'enableWriteAssist'
    ], (syncResult) => {
      const token = localResult.zoAccessToken;
      const spaceEndpoint = localResult.zoSpaceEndpoint;
      if (token) tokenInput.value = token;
      if (spaceEndpoint) spaceEndpointInput.value = spaceEndpoint;

      // Persona — single default; the side panel's Mode selector does the routing.
      const personaId = syncResult.zoPersonaId || '';
      personaSelect.value = personaId;

      quickActions = syncResult.zoQuickActions || [];
      renderQuickActionsEditor();
      if (token) populateModels(token, syncResult.zoModel);
      if (token) populatePersonas(token, personaSelect, personaId);

      // Restore TTS fields
      const langInput = document.getElementById('tts-lang');
      const rateInput = document.getElementById('tts-rate');
      const autoReadCheck = document.getElementById('tts-auto-read');
      if (langInput) langInput.value = syncResult.zoTtsLang || 'en-US';
      if (rateInput) rateInput.value = syncResult.zoTtsRate || '1.0';
      if (autoReadCheck) autoReadCheck.checked = syncResult.zoTtsAutoRead || false;

      // Restore screenshot toggle
      const screenshotsCheck = document.getElementById('enable-screenshots');
      if (screenshotsCheck) screenshotsCheck.checked = syncResult.enableScreenshots !== false;

      // Restore write-assist toggle
      const writeAssistCheck = document.getElementById('enable-write-assist');
      if (writeAssistCheck) writeAssistCheck.checked = syncResult.enableWriteAssist !== false;

      // Debug diagnostics (#67)
      const debugCheck = document.getElementById('debug-mode');
      if (debugCheck) debugCheck.checked = !!syncResult.debugMode;
      refreshDebugControls(!!syncResult.debugMode);
    });
  });

  // Token change → fetch models
  tokenInput.addEventListener('change', () => {
    const token = tokenInput.value.trim();
    if (token) populateModels(token, getModelValue());
  });

  // Debug diagnostics (#67): apply immediately (the ring is cheap + local),
  // and also persist via the normal Save mapping.
  document.getElementById('debug-mode')?.addEventListener('change', (e) => {
    const on = !!e.target.checked;
    chrome.storage.sync.set({ debugMode: on });
    refreshDebugControls(on);
  });
  document.getElementById('copy-diagnostics')?.addEventListener('click', copyDiagnostics);

  // Quick Actions live editing
  document.getElementById('quick-actions-list')?.addEventListener('input', (e) => {
    const index = parseInt(e.target.dataset.index);
    if (isNaN(index)) return;
    const labels = document.querySelectorAll('.qa-label');
    const prompts = document.querySelectorAll('.qa-prompt');
    const actions = [];
    labels.forEach((l, i) => {
      const label = l.value.trim();
      const prompt = prompts[i]?.value?.trim() || '';
      if (label && prompt) actions.push({ label, prompt });
    });
    quickActions = actions;
    chrome.storage.sync.set({ zoQuickActions: quickActions });
  });

  document.getElementById('quick-actions-list')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('qa-remove')) {
      const index = parseInt(e.target.dataset.index);
      if (!isNaN(index)) {
        quickActions.splice(index, 1);
        chrome.storage.sync.set({ zoQuickActions: quickActions });
        renderQuickActionsEditor();
      }
    }
  });

  // "Add row" button
  const addRowBtn = document.getElementById('add-qa-row');
  if (addRowBtn) {
    addRowBtn.addEventListener('click', () => {
      quickActions.push({ label: '', prompt: '' });
      renderQuickActionsEditor();
    });
  }

  // Save
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) {
      statusMsg.textContent = 'Access token is required.';
      statusMsg.className = 'inline-status err';
      return;
    }
    // Store sensitive data separately in storage.local (not synced across devices)
    chrome.storage.local.set({
      zoAccessToken: token,
      zoSpaceEndpoint: spaceEndpointInput.value.trim() || 'https://cashlessconsumer.zo.space',
    }, () => {
      // Non-sensitive config stays in storage.sync
      chrome.storage.sync.set({
        zoModel: getModelValue(),
        zoPersonaId: personaSelect.value,
        zoQuickActions: quickActions,
        zoTtsLang: (document.getElementById('tts-lang')?.value || 'en-US').trim(),
        zoTtsRate: (document.getElementById('tts-rate')?.value || '1.0').trim(),
        zoTtsAutoRead: !!(document.getElementById('tts-auto-read')?.checked),
        enableScreenshots: !!(document.getElementById('enable-screenshots')?.checked),
        enableWriteAssist: !!(document.getElementById('enable-write-assist')?.checked),
        debugMode: !!(document.getElementById('debug-mode')?.checked),
      enabledMenus: {
        page: document.getElementById('menu-ask-page')?.checked ?? true,
        selection: document.getElementById('menu-ask-selection')?.checked ?? true,
        link: document.getElementById('menu-ask-link')?.checked ?? true,
        editable: document.getElementById('menu-fill-editable')?.checked ?? false,
      },
      }, () => {
        statusMsg.textContent = '✅ Saved!';
        statusMsg.className = 'inline-status ok';
        clearDirty();
        setTimeout(() => { statusMsg.textContent = ''; statusMsg.className = 'inline-status'; }, 3000);
      });
    });
  });

  // Test connection
  testBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (!token) {
      statusMsg.textContent = 'Enter an access token first.';
      statusMsg.className = 'inline-status err';
      return;
    }
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    statusMsg.textContent = 'Testing…';
    statusMsg.className = 'inline-status pending';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const r = await fetch('https://api.zo.computer/zo/ask', {
        signal: controller.signal,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: 'Reply with just: ZO_OK' }),
      });
      clearTimeout(timeout);
      const text = await r.text();
      if (r.ok && text.includes('ZO_OK')) {
        statusMsg.textContent = '✅ Connection successful!';
        statusMsg.className = 'inline-status ok';
      } else {
        statusMsg.textContent = `⚠️ API returned ${r.status}`;
        statusMsg.className = 'inline-status err';
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        statusMsg.textContent = '❌ Request timed out after 15s. Check your token and internet.';
      } else {
        statusMsg.textContent = `❌ ${err.message}`;
      }
      statusMsg.className = 'inline-status err';
    }
    testBtn.disabled = false;
    testBtn.textContent = 'Test Connection';
  });

  // Reset to defaults — clears all stored config (sync + local sensitive),
  // then reloads the page so inputs rehydrate from DEFAULTS.
  const resetBtn = document.getElementById('reset-defaults');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (!confirm('Reset all Zo Co-browse settings to defaults? This clears your token, endpoint, model, and preferences on this device.')) return;
      // Sensitive (local) + non-sensitive (sync) keys are cleared together.
      const syncKeys = ['zoModel', 'zoPersonaId', 'zoActiveMode', 'zoQuickActions', 'zoTtsLang', 'zoTtsRate', 'zoTtsAutoRead', 'enabledMenus', 'enableScreenshots', 'enableWriteAssist', 'cobrowse_theme'];
      const localKeys = ['zoAccessToken', 'zoSpaceEndpoint', 'cobrowse_mode_overrides'];
      Promise.all([
        new Promise((r) => chrome.storage.sync.remove(syncKeys, r)),
        new Promise((r) => chrome.storage.local.remove(localKeys, r)),
      ]).then(() => {
        statusMsg.textContent = '✅ Reset to defaults. Reloading…';
        statusMsg.className = 'inline-status ok';
        setTimeout(() => location.reload(), 800);
      }).catch(() => {
        statusMsg.textContent = '❌ Reset failed.';
        statusMsg.className = 'inline-status err';
      });
    });
  }

  // Quick nav to Zo settings
  const goToZoBtn = document.getElementById('go-to-zo-settings');
  if (goToZoBtn) {
    goToZoBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://cashlessconsumer.zo.computer/?t=settings&s=advanced' });
    });
  }

  // ---- Prompts editor (mode tuning) ----
  // Dynamic import keeps options.js a classic script (the test suite parses it
  // via new Function(code)); the libs are pure ES modules shared with the
  // side panel + background.
  try {
    const [{ BUILTIN_MODES, mergeOverride, EDITABLE_MODE_FIELDS }, { describePrompt }] = await Promise.all([
      import('./lib/modes.js'),
      import('./lib/prompt.js'),
    ]);
    initPromptsEditor(BUILTIN_MODES, mergeOverride, EDITABLE_MODE_FIELDS, describePrompt);
  } catch (err) {
    console.warn('Prompts editor failed to load:', err);
  }
});

// ---- Prompts editor implementation ----
function initPromptsEditor(BUILTIN_MODES, mergeOverride, EDITABLE_MODE_FIELDS, describePrompt) {
  const OVERRIDES_KEY = 'cobrowse_mode_overrides';
  const CUSTOM_MODES_KEY = 'cobrowse_modes';
  const TIER_NAMES = ['URL only', 'Text', 'Elements', 'Screenshot'];

  const modeSelect = document.getElementById('prompt-mode-select');
  const sysEl = document.getElementById('prompt-system');
  const instrEl = document.getElementById('prompt-instructions');
  const tierEl = document.getElementById('prompt-tier');
  const budgetEl = document.getElementById('prompt-budget');
  const jsonEl = document.getElementById('prompt-json');
  const saveBtn = document.getElementById('prompt-save');
  const resetBtn = document.getElementById('prompt-reset');
  const statusEl = document.getElementById('prompt-status');
  const previewPre = document.getElementById('prompt-preview-pre');
  const previewMeta = document.getElementById('prompt-preview-meta');
  if (!modeSelect || !saveBtn) return;

  let overrides = {};
  let customModes = {};
  let currentId = null;
  const isBuiltin = (id) => !!BUILTIN_MODES[id];

  const flash = (msg, ok = true) => {
    statusEl.textContent = msg;
    statusEl.className = 'inline-status ' + (ok ? 'ok' : 'err');
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'inline-status'; }, 2500);
  };

  function draftMode() {
    const base = isBuiltin(currentId)
      ? mergeOverride(BUILTIN_MODES[currentId], overrides[currentId] || {})
      : (customModes[currentId] || BUILTIN_MODES.cobrowse);
    return {
      ...base,
      systemPrompt: sysEl.value,
      instructions: instrEl.value,
      contextTier: Math.max(0, Math.min(3, parseInt(tierEl.value, 10) || 0)),
      textBudget: Math.max(0, parseInt(budgetEl.value, 10) || 0),
      expectJson: !!jsonEl.checked,
    };
  }

  function renderPreview() {
    if (!previewPre) return;
    const mode = draftMode();
    const ctx = {
      url: 'https://example.com/docs', title: 'Sample page',
      visibleText: 'Sample page body text used for the prompt preview.',
      clickable: [{ text: 'Get started', tag: 'a', selector: '#cta' }],
      formFields: [{ tag: 'input', type: 'email', selector: '#email', placeholder: 'Email' }],
      viewport: { w: 1280, h: 800 },
    };
    const d = describePrompt(mode, ctx, 'Example question for this Mode');
    previewPre.textContent = d.prompt;
    if (previewMeta) {
      previewMeta.replaceChildren();
      const chip = (label, val) => {
        const s = document.createElement('span');
        const b = document.createElement('b'); b.textContent = label + ' ';
        s.appendChild(b); s.appendChild(document.createTextNode(String(val)));
        return s;
      };
      previewMeta.appendChild(chip('Context:', TIER_NAMES[d.tier] || `Tier ${d.tier}`));
      previewMeta.appendChild(chip('Format:', d.expectJson ? 'JSON actions' : 'Markdown'));
      previewMeta.appendChild(chip('≈ Tokens:', d.approxTokens));
    }
  }

  function fill(id) {
    currentId = id;
    const base = isBuiltin(id)
      ? mergeOverride(BUILTIN_MODES[id], overrides[id] || {})
      : (customModes[id] || BUILTIN_MODES.cobrowse);
    sysEl.value = base.systemPrompt || '';
    instrEl.value = base.instructions || '';
    tierEl.value = String(base.contextTier ?? 2);
    budgetEl.value = String(base.textBudget ?? 2000);
    jsonEl.checked = !!base.expectJson;
    resetBtn.disabled = !(isBuiltin(id) && overrides[id]);
    renderPreview();
  }

  async function load() {
    const both = await chrome.storage.local.get([OVERRIDES_KEY, CUSTOM_MODES_KEY]);
    overrides = (both && both[OVERRIDES_KEY]) || {};
    customModes = (both && both[CUSTOM_MODES_KEY]) || {};
    modeSelect.innerHTML = '';
    for (const id of Object.keys(BUILTIN_MODES)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${BUILTIN_MODES[id].icon} ${BUILTIN_MODES[id].name} (built-in)`;
      modeSelect.appendChild(opt);
    }
    const customIds = Object.keys(customModes);
    if (customIds.length) {
      const sep = document.createElement('option');
      sep.disabled = true; sep.textContent = '—— Custom ——';
      modeSelect.appendChild(sep);
      for (const id of customIds) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${customModes[id].icon || '✨'} ${customModes[id].name || id} (custom)`;
        modeSelect.appendChild(opt);
      }
    }
    fill(modeSelect.value || Object.keys(BUILTIN_MODES)[0]);
  }

  modeSelect.addEventListener('change', () => fill(modeSelect.value));
  [sysEl, instrEl, tierEl, budgetEl, jsonEl].forEach((el) => {
    if (el) el.addEventListener('input', renderPreview);
  });

  saveBtn.addEventListener('click', async () => {
    const id = modeSelect.value;
    const draft = draftMode();
    if (!draft.systemPrompt || !draft.instructions) {
      flash('System prompt and instructions are required.', false);
      return;
    }
    if (isBuiltin(id)) {
      // Store only the editable knobs that differ from the base built-in.
      const base = BUILTIN_MODES[id];
      const ov = {};
      for (const k of EDITABLE_MODE_FIELDS) {
        if (draft[k] !== base[k]) ov[k] = draft[k];
      }
      if (Object.keys(ov).length) overrides[id] = ov;
      else delete overrides[id];
      await chrome.storage.local.set({ [OVERRIDES_KEY]: overrides });
    } else {
      customModes[id] = { ...customModes[id], ...draft, id, builtin: false };
      await chrome.storage.local.set({ [CUSTOM_MODES_KEY]: customModes });
    }
    flash('✅ Saved');
    fill(id);
  });

  resetBtn.addEventListener('click', async () => {
    const id = modeSelect.value;
    if (!isBuiltin(id)) return;
    delete overrides[id];
    await chrome.storage.local.set({ [OVERRIDES_KEY]: overrides });
    fill(id);
    flash('Reset to original');
  });

  load();
}

async function populateModels(token, currentValue) {
  const modelStatus = document.getElementById('model-status');
  const container = document.getElementById('model');
  if (!container || !modelStatus) return;
  modelStatus.textContent = 'Loading models…';
  try {
    const r = await fetch('https://api.zo.computer/models/available', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) { modelStatus.textContent = 'Could not fetch models'; return; }
    const data = await r.json();
    if (!data.models?.length) { modelStatus.textContent = 'No models returned'; return; }
    // Replace the inner HTML of the existing select rather than replacing the node
    // This preserves the reference that getElementById('model') returns
    container.innerHTML = '<option value="">Default model</option>';
    for (const m of data.models) {
      const opt = document.createElement('option');
      opt.value = m.model_name || '';
      opt.textContent = `${m.label || m.model_name || ''}${m.vendor ? ` (${m.vendor})` : ''}`;
      if (opt.value === currentValue) opt.selected = true;
      container.appendChild(opt);
    }
    modelStatus.textContent = `${data.models.length} models loaded`;
    container.addEventListener('change', () => {
      chrome.storage.sync.set({ zoModel: container.value });
    });
  } catch {
    modelStatus.textContent = 'Error loading models';
  }
}

async function populatePersonas(token, select, personaId) {
  try {
    const r = await fetch('https://api.zo.computer/personas/available', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return;
    const data = await r.json();
    if (!data.personas?.length) return;
    select.innerHTML = '<option value="">— Zo (default) —</option>';
    for (const p of data.personas) {
      const opt = document.createElement('option');
      opt.value = p.id || '';
      opt.textContent = p.name || p.id || '';
      select.appendChild(opt);
    }
    select.value = personaId;
  } catch { /* ignore */ }
}
