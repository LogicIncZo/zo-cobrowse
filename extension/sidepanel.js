// Zo Co-browse — Side Panel Logic

import { parseBangCommand, BANG_COMMANDS } from './lib/bang-commands.js';
import { BUILTIN_MODES, DEFAULT_MODE_ID, resolveMode, presetToMode, normalizeActions, isContextAction } from './lib/modes.js';
import { looksLikeActionJson } from './lib/intent.js';
import { reviewRows, fillBatchRows } from './lib/formfill.js';
import {
  createConversationState,
  decideTurn,
  computePageHash,
  loadConversationState,
  saveConversationState,
} from './lib/context-policy.js';
import { describePrompt } from './lib/prompt.js';
import { assignRefs, ensureActiveTabRef, isBlankPage, thinTabExcerpts } from './lib/tab-contexts.js';
import { visionModelSuggestion, modelVisionSupport, findModelEntry } from './lib/vision.js';
import { extractUrls, MAX_LINK_CHIPS } from './lib/links.js';
import { WORKSPACE_ROOT, filterPickerEntries } from './lib/pickers.js';
import {
  openChatTab,
  closeChatTab,
  activateChatTab,
  pruneChatTabs,
  tabTitleFor,
  renameConversation,
  searchConversations,
} from './lib/chat-tabs.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Constants ----
const MAX_HISTORY = 50;
const OLD_STORAGE_KEY = 'cobrowse_history';
// Defensive guard: if background never replies and the port stays alive,
// the thinking indicator would persist forever. This clears it + re-enables
// input after the deadline so the panel is never stuck.
const THINKING_TIMEOUT_MS = 60000;
let thinkingTimeout = null;
function startThinkingTimeout() {
  clearThinkingTimeout();
  thinkingTimeout = setTimeout(() => {
    thinkingTimeout = null;
    const thinking = msgsEl?.querySelector('.msg-thinking');
    if (thinking) thinking.remove();
    stopStreamTimer();
    if (streamSession.active) {
      streamSession.active = false;
      streamSession.msgEl = null;
      streamSession.fullText = '';
      streamSession.reasoningText = '';
      streamSession.startTime = 0;
    }
    if (typeof input !== 'undefined' && input) input.disabled = false;
    if (typeof sendBtn !== 'undefined' && sendBtn) sendBtn.disabled = false;
  }, THINKING_TIMEOUT_MS);
}
function clearThinkingTimeout() {
  if (thinkingTimeout) { clearTimeout(thinkingTimeout); thinkingTimeout = null; }
}
// ---- Safe text helper ----
function safeText(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try { const s = JSON.stringify(v); return typeof s === 'string' ? s : ''; }
  catch { return ''; }
}

const STORAGE_CONVERSATIONS_KEY = 'cobrowse_convos';
const STORAGE_ACTIVE_KEY = 'cobrowse_active_id';
const STORAGE_TABS_KEY = 'cobrowse_open_tabs'; // open chat-tab ids (ordered)
const STORAGE_MODES_KEY = 'cobrowse_modes';
const STORAGE_OVERRIDES_KEY = 'cobrowse_mode_overrides'; // per-built-in sparse overrides
const STORAGE_LEGACY_PRESETS_KEY = 'cobrowse_presets'; // migrated once, then ignored
const STORAGE_ACTIONS_KEY = 'zoQuickActions';

// ---- Theme ----
const THEME_STORAGE_KEY = 'cobrowse_theme';
let currentTheme = '';

const THEMES = {
  '':      { name: 'System',   icon: '◐', label: 'Follow system' },
  'dark':  { name: 'Dark',     icon: '☾', label: 'Midnight Observatory' },
  'light': { name: 'Light',    icon: '☀', label: 'Sunlit Observatory' },
  'sepia': { name: 'Sepia',    icon: '♨', label: 'Warm Paper' },
  'forest':{ name: 'Forest',   icon: '♣', label: 'Deep Grove' },
  'ocean': { name: 'Ocean',    icon: '⊡', label: 'Deep Water' },
};

async function loadTheme() {
  const saved = await chrome.storage.sync.get(THEME_STORAGE_KEY);
  currentTheme = saved[THEME_STORAGE_KEY] || '';
  applyTheme(currentTheme, true);
}

function applyTheme(theme, skipPersist) {
  currentTheme = theme;
  const effective = theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', effective);
  const btn = document.getElementById('theme-toggle');
  const info = THEMES[theme] || THEMES[''];
  if (btn) btn.textContent = info.icon;
  if (!skipPersist) chrome.storage.sync.set({ [THEME_STORAGE_KEY]: theme });
}

function showThemePopover() {
  let popover = document.getElementById('theme-popover');
  if (!popover) {
    popover = document.createElement('div');
    popover.id = 'theme-popover';
    popover.className = 'theme-popover';
    const themeKeys = ['', 'dark', 'light', 'sepia', 'forest', 'ocean'];
    for (const key of themeKeys) {
      const t = THEMES[key];
      const opt = document.createElement('button');
      opt.className = `theme-option${key === currentTheme ? ' selected' : ''}`;
      opt.dataset.theme = key;
      opt.innerHTML = `<div class="theme-swatch ${key || 'system'}"></div><span class="theme-label">${t.icon} ${t.name}</span>`;
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        applyTheme(key);
        closeThemePopover();
      });
      popover.appendChild(opt);
    }
    document.getElementById('theme-toggle').parentElement.appendChild(popover);
  }
  popover.classList.add('open');
  document.addEventListener('click', closeThemePopoverOutside, true);
}

function closeThemePopover() {
  const popover = document.getElementById('theme-popover');
  if (popover) popover.classList.remove('open');
  document.removeEventListener('click', closeThemePopoverOutside, true);
}

function closeThemePopoverOutside(e) {
  const popover = document.getElementById('theme-popover');
  const btn = document.getElementById('theme-toggle');
  if (popover && !popover.contains(e.target) && e.target !== btn) {
    closeThemePopover();
  }
}

// ---- Quick Actions (user-manageable chips) ----
const DEFAULT_QUICK_ACTIONS = [
  { label: 'Summarize', prompt: 'Summarize this page in 3-5 bullet points.' },
  { label: 'Extract links', prompt: 'Extract all links from this page.' },
  { label: 'Fill forms', prompt: 'Identify all form fields on this page and fill them with relevant test data.' },
  { label: 'Page data', prompt: 'Extract all structured data (tables, lists, prices, dates, contacts) from this page.' },
];

// ---- State ----
let config = { hasToken: false };
let conversations = {};     // all conversations keyed by id
let activeId = null;        // current conversation id
let tabsState = { openIds: [], activeId: null }; // chat tab bar (lib/chat-tabs.js ops)
const chatTabRefs = new Map(); // chatId → Set<tabId> — per-chat tab-context toggles
let pendingActions = null;
let pendingActionsReasoning = '';   // reasoning to attach to the done-answer bubble
let currentContext = null;
let actionRunning = false;
let isHistoryView = false;
let cachedModels = [];      // cache LIST_MODELS response for label lookup

// ---- STT state ----
let recognition = null;
let isRecording = false;
let sttInterim = '';
let sttLang = 'en-US';

// ---- TTS state ----
let ttsAutoRead = false;
let ttsRate = 1.0;
let ttsVoice = '';
let ttsLang = 'en-US';
let isSpeaking = false;
let currentTtsBtnEl = null;

// ---- DOM refs ----
const msgsEl = $('#messages');
const input = $('#query-input');
const sendBtn = $('#send-btn');
const micBtn = $('#mic-btn');
const statusDot = $('#status-dot');
const pageUrl = $('#page-url');
const modelSelect = $('#model-select');
const personaSelect = $('#persona-select');
const actionsBar = $('#actions-bar');
const actionsReasoning = $('#actions-reasoning');
const runAllBtn = $('#run-all-btn');
const skipBtn = $('#skip-btn');
const newChatBtn = $('#new-chat-btn');
const historyBtn = $('#history-btn');
const helpBtn = $('#help-btn');
const chatTabsEl = $('#chat-tabs');
const chatView = $('#chat-view');
const historyViewEl = $('#history-view');
const historyList = $('#history-list');
const historySearch = $('#history-search');
const backToChatBtn = $('#back-to-chat-btn');
const modeSelect = $('#mode-select');
const createModeBtn = $('#create-mode-btn');

// ---- Modes ----
// Built-in Modes live in extension/lib/modes.js (imported as BUILTIN_MODES).
// Custom Modes are user-generated via the ✦ button and stored under
// STORAGE_MODES_KEY. The active Mode id is persisted under 'zoActiveMode'.

let customModes = {};
// Per-built-in-id sparse overrides (Settings editor). Merged into resolved
// Modes via resolveMode(id, customModes, modeOverrides).
let modeOverrides = {};
let activeModeId = DEFAULT_MODE_ID;
// Per-conversation context policy state (opt-in DOM + send-once). Hydrated
// from chrome.storage.session in finishInit(); reset on new conversation.
let contextState = createConversationState();


// ---- Init ----
init();

async function init() {
  bindEvents(); // bind FIRST so events always work even if async setup fails
  await loadConfig();
  await loadTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => loadTheme());
  updateStatus(config.hasToken);
  const { [OB_KEY]: obDone = false } = await chrome.storage.sync.get(OB_KEY);
  if (!obDone) { showOnboarding(); return; }
  await finishInit();
}

/** Remaining init — called on normal start and from completeOnboarding() */
async function finishInit() {
  try {
    // Load Modes (customModes + modeOverrides + activeModeId) BEFORE the first
    // capture so refreshPageContext resolves the tier with overrides applied.
    await loadModes();
    await refreshPageContext();
    await checkPendingQuery();
    await migrateOldFormat();
    await loadConversations();
    await fetchModelsAndPersonas();
    await loadQuickActions();
    await loadTtsConfig();
    initTabStrip();
    initJumpToLatest();
    connectStreamingPort();
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[STORAGE_ACTIONS_KEY]) {
        const actions = changes[STORAGE_ACTIONS_KEY].newValue;
        renderQuickActions(actions || []);
      }
      // Hot-reload the active Mode when it changes in storage (another tab
      // picked a different mode, or a test flipped it). Re-sync the dropdown
      // + re-capture so the new tier takes effect on the next send.
      if (changes.zoActiveMode?.newValue && changes.zoActiveMode.newValue !== activeModeId) {
        activeModeId = changes.zoActiveMode.newValue;
        syncModeSelect();
        refreshPageContext().then(renderPromptInspector);
      }
      // Hot-reload builtin overrides when the Settings editor saves them, and
      // re-capture so a raised contextTier actually takes effect immediately.
      if (changes[STORAGE_OVERRIDES_KEY]) {
        modeOverrides = changes[STORAGE_OVERRIDES_KEY].newValue || {};
        refreshPageContext().then(renderPromptInspector);
      }
    });
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'PENDING_ZO_QUERY' && msg.text) {
        input.value = msg.text;
        sendQuery();
      }
      // Ctrl+Shift+N shortcut: the background broadcasts NEW_CONVERSATION; the
      // panel starts a fresh chat locally (its startNewConversation also tells
      // the background to reset the ambient Zo thread).
      if (msg.type === 'NEW_CONVERSATION' && msg.source === 'shortcut') {
        startNewConversation();
      }
    });
    renderPromptInspector(); // first paint once modes + context are loaded
  } catch (e) {
    console.error('finishInit error:', e);
  } finally {
    renderView();
  }
}

/** Check if a context menu click stored a pending query */
async function checkPendingQuery() {
  try {
    // Retry a few times to handle race with background writing storage
    let pending = null;
    for (let i = 0; i < 5; i++) {
      const result = await chrome.storage.session.get('pendingZoQuery');
      pending = result.pendingZoQuery;
      if (pending) break;
      await new Promise(r => setTimeout(r, 300));
    }
    if (!pending) return;
    await chrome.storage.session.remove('pendingZoQuery');
    input.value = pending.text;
    currentContext = pending.context;
    // Automatically fire the query
    await sendQuery();
  } catch (e) {
    console.warn('checkPendingQuery failed:', e);
  }
}

async function loadConfig() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  if (resp) config = resp;
  // The active Mode + persona are sourced directly from storage so the panel
  // stays in sync with options.js across reloads.
  const saved = await chrome.storage.sync.get(['zoActiveMode', 'zoPersonaId']);
  if (saved.zoPersonaId) config.selectedPersona = saved.zoPersonaId;
  syncModeSelect();
}

// Reflect activeModeId into the #mode-select dropdown.
function syncModeSelect() {
  if (modeSelect) modeSelect.value = activeModeId;
}

// ---- Onboarding ----

const OB_KEY = 'cobrowse_onboarding_done';
const OB_STEP_KEY = 'cobrowse_onboarding_step';

const OB_STEPS = [
  {
    title: 'Welcome to Zo Co-browse',
    desc: 'Your browser, supercharged with AI.',
    body: '<p>Zo Co-browse connects your browser to Zo Computer — your personal AI server. Zo can see what\'s on the page, answer questions, fill forms, extract data, run DuckDB queries, and even create automations — all from this side panel.</p><p>Let\'s get you set up in 30 seconds.</p>',
  },
  {
    title: 'Connect Your Zo',
    desc: 'You need a Zo Computer account to use Co-browse.',
    body: '<p>If you haven\'t already, sign up at <a href="https://zocomputer.com" target="_blank">zocomputer.com</a> — it\'s free.</p><p>Already have an account? Great — the next step is to add your API token.</p>',
  },
  {
    title: 'Add Your API Token',
    desc: 'This connects the extension to your Zo.',
    body: '<ol style="text-align:left;margin:0 auto;max-width:340px;line-height:1.8"><li>Open your Zo <strong>Settings → Advanced → Access Tokens</strong></li><li>Create a new token (or copy an existing one)</li><li>Paste it in the <strong>extension settings</strong> (gear icon below)</li></ol><p style="margin-top:12px">💡 Your token is stored locally and never shared.</p>',
  },
  {
    title: 'Test Your Connection',
    desc: 'Let\'s make sure everything works.',
    body: '<p>Click <strong>Test Connection</strong> below, or open the extension settings and hit "Test Connection" there.</p><p>If it works, you\'re all set! You can ask Zo anything about the page you\'re on.</p>',
    final: true,
  },
];

async function showOnboarding() {
  const chatView = document.getElementById('chat-view');
  const obView = document.getElementById('onboarding-view');
  if (!obView) return;
  chatView.classList.add('hidden');
  obView.classList.remove('hidden');

  const { [OB_STEP_KEY]: step = 0 } = await chrome.storage.sync.get(OB_STEP_KEY);
  renderOnboardingStep(step);
}

function renderOnboardingStep(step) {
  const s = OB_STEPS[step];
  if (!s) { completeOnboarding(); return; }
  document.getElementById('ob-title').textContent = s.title;
  document.getElementById('ob-desc').textContent = s.desc;
  document.getElementById('ob-body').innerHTML = s.body;

  const backBtn = document.getElementById('ob-back');
  const nextBtn = document.getElementById('ob-next');
  backBtn.classList.toggle('hidden', step === 0);
  nextBtn.textContent = s.final ? '🚀 Get Started' : 'Next →';

  const stepsEl = document.getElementById('ob-steps');
  stepsEl.innerHTML = OB_STEPS.map((_, i) =>
    `<span class="ob-dot${i === step ? ' ob-dot-active' : ''}${i < step ? ' ob-dot-done' : ''}"></span>`
  ).join('');

  chrome.storage.sync.set({ [OB_STEP_KEY]: step });
}

function handleOnboardingNext() {
  chrome.storage.sync.get(OB_STEP_KEY, ({ [OB_STEP_KEY]: s }) => {
    const next = (s || 0) + 1;
    if (next >= OB_STEPS.length) {
      completeOnboarding();
    } else {
      renderOnboardingStep(next);
    }
  });
}

function handleOnboardingBack() {
  chrome.storage.sync.get(OB_STEP_KEY, ({ [OB_STEP_KEY]: s }) => {
    if ((s || 0) > 0) renderOnboardingStep(s - 1);
  });
}

async function completeOnboarding() {
  await chrome.storage.sync.set({ [OB_KEY]: true, [OB_STEP_KEY]: 0 });
  const obView = document.getElementById('onboarding-view');
  if (obView) obView.classList.add('hidden');
  await finishInit();
  // Welcome message — added after finishInit so it survives loadConversations() DOM reset
  const msg = '🎉 **Onboarding complete!** Try asking Zo something about this page.';
  addMessage('assistant', msg);
}
function updateStatus(connected) {
  statusDot.className = `dot ${connected ? 'dot-connected' : 'dot-disconnected'}`;
  statusDot.title = connected ? 'Zo connected' : 'Not configured — open settings';
}

function bindEvents() {
  // Model/Persona selection — save to chrome.storage.sync so background picks it up
  modelSelect.addEventListener('change', () => {
    config.selectedModel = modelSelect.value;
    chrome.storage.sync.set({ zoModel: modelSelect.value });
  });
  personaSelect.addEventListener('change', () => {
    config.selectedPersona = personaSelect.value;
    chrome.storage.sync.set({ zoPersonaId: personaSelect.value });
  });

  // Send (disabled while the input is empty, like Zo's Send button)
  const syncSendBtn = () => { sendBtn.disabled = !input.value.trim() || actionRunning; };
  input.addEventListener('input', syncSendBtn);
  input.addEventListener('input', schedulePromptInspector);
  input.addEventListener('input', onComposerInputForTabs);
  input.addEventListener('input', onComposerInputForPickers);
  input.addEventListener('keyup', syncSendBtn);
  syncSendBtn();
  sendBtn.addEventListener('click', () => { sendQuery(); });
  // Tab-context `@` autocomplete keys. Captured on the WRAPPER so Enter-to-
  // select fires before the send-on-Enter listener registered on the input.
  const inputWrap = $('.input-wrap');
  if (inputWrap) {
    inputWrap.addEventListener('keydown', onComposerKeydownForTabs, true);
    inputWrap.addEventListener('keydown', onComposerKeydownForPickers, true);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeTabAutocomplete(); sendQuery(); }
    // Esc cancels an in-flight stream (Zo: "Press Esc to stop").
    if (e.key === 'Escape' && streamSession.active) { cancelStream(); e.preventDefault(); }
  });

  // Mic button — STT
  if (micBtn) {
    micBtn.addEventListener('click', () => { startRecording(); });
  }

  // Chips (event delegation for dynamically rendered chips)
  const chipsContainer = $('#action-chips');
  if (chipsContainer) {
    chipsContainer.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) {
        input.value = chip.textContent.trim();
        sendQuery();
      }
    });
  }

  // Mode selection — the single source of truth for how Zo behaves + context.
  modeSelect.addEventListener('change', applyMode);
  createModeBtn.addEventListener('click', startModeCreation);

  // Theme toggle
  const themeToggle = $('#theme-toggle');
  if (themeToggle) themeToggle.addEventListener('click', showThemePopover);

  // Pending actions
  runAllBtn.addEventListener('click', runPendingActions);
  skipBtn.addEventListener('click', () => {
    hidePendingActionsBar();
    clearStoredPendingActions(activeId);
  });

  // New conversation
  newChatBtn.addEventListener('click', startNewConversation);

  // History toggle
  historyBtn.addEventListener('click', toggleHistoryView);
  backToChatBtn.addEventListener('click', toggleHistoryView);
  if (historySearch) historySearch.addEventListener('input', () => renderHistoryView());
  helpBtn.addEventListener('click', () => chrome.tabs.create({ url: 'https://cashlessconsumer.zo.space/co-browse' }));

  // Open settings on status dot click (not double-click)
  statusDot.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Onboarding navigation
  const obNext = $('#ob-next');
  const obBack = $('#ob-back');
  const obSkip = $('#ob-skip');
  if (obNext) obNext.addEventListener('click', handleOnboardingNext);
  if (obBack) obBack.addEventListener('click', handleOnboardingBack);
  if (obSkip) obSkip.addEventListener('click', completeOnboarding);
}

// ---- View switching ----

function renderView() {
  if (isHistoryView) {
    renderHistoryView();
  } else {
    renderChatView();
  }
}

function renderChatView() {
  isHistoryView = false;
  historyViewEl.classList.add('hidden');
  chatView.classList.remove('hidden');
  historyBtn.classList.remove('active');
  historyBtn.title = 'History';
}

function toggleHistoryView() {
  // If switching to history, save current conversation first
  if (!isHistoryView) {
    saveCurrentConversation();
    if (historySearch) historySearch.value = ''; // fresh list each visit
  }
  isHistoryView = !isHistoryView;
  renderView();
}

// ---- Multi-conversation storage ----

async function migrateOldFormat() {
  const result = await chrome.storage.local.get(OLD_STORAGE_KEY);
  const oldMessages = result[OLD_STORAGE_KEY];
  if (!oldMessages || !Array.isArray(oldMessages) || oldMessages.length === 0) return;

  // Create a conversation from the old flat history
  const id = generateId();
  const firstUserMsg = oldMessages.find(m => m.role === 'user');
  conversations[id] = {
    id,
    title: firstUserMsg ? String(firstUserMsg.text || '').substring(0, 60) : 'Previous session',
    createdAt: oldMessages[0]?.timestamp || Date.now(),
    updatedAt: Date.now(),
    messages: oldMessages,
  };
  activeId = id;
  tabsState = openChatTab(tabsState, id); // the migrated chat opens as its tab

  await saveConversations();
  await chrome.storage.local.remove(OLD_STORAGE_KEY);
}

function generateId() {
  return 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function loadConversations() {
  const result = await chrome.storage.local.get([STORAGE_CONVERSATIONS_KEY, STORAGE_ACTIVE_KEY, STORAGE_TABS_KEY]);
  conversations = result[STORAGE_CONVERSATIONS_KEY] || {};
  activeId = result[STORAGE_ACTIVE_KEY] || null;

  // Restore the open-tab set; pre-tab-bar installs have no stored set, so the
  // active chat opens as the single tab (upgrade default).
  const storedOpen = Array.isArray(result[STORAGE_TABS_KEY]) ? result[STORAGE_TABS_KEY] : [];
  tabsState = pruneChatTabs({ openIds: storedOpen, activeId }, Object.keys(conversations));

  // If no active conversation, create one
  if (!activeId || !conversations[activeId]) {
    createNewConversation();
    renderCurrentConversation(); // fresh chat: system message + empty-state chips
  } else {
    if (!tabsState.openIds.length) tabsState = openChatTab(tabsState, activeId);
    renderCurrentConversation();
  }

  // Per-chat context-policy state (dedup must not leak across chats).
  contextState = await loadConversationState(activeId);

  renderChatTabs();
  // Stored pending actions (chat was backgrounded when its stream finished)
  // re-arm the Run All / Skip bar on load, not just on switch.
  restorePendingActionsFor(activeId);
  // Update history button badge
  updateHistoryBadge();
}

async function saveConversations() {
  await chrome.storage.local.set({
    [STORAGE_CONVERSATIONS_KEY]: conversations,
    [STORAGE_ACTIVE_KEY]: activeId,
    [STORAGE_TABS_KEY]: tabsState.openIds,
  });
}

function getActiveConversation() {
  return conversations[activeId] || null;
}

/**
 * Heal an assistant message persisted before the action-normalization fix.
 * Old code saved the raw `{reasoning, actions}` JSON blob as `msg.text` when
 * Zo returned key-first actions; those messages re-render as raw JSON forever,
 * even after the parse-path fix. This detects such blobs and splits them back
 * into the done.response (as text) + reasoning, so old conversations render
 * correctly on load. New messages already carry the resolved text/reasoning
 * and pass through unchanged. Non-JSON text is returned as-is.
 */
function healAssistantMessage(msg) {
  if (!msg || msg.role !== 'assistant') return msg;
  const text = typeof msg.text === 'string' ? msg.text : '';
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return msg;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return msg; }
  if (!parsed || typeof parsed !== 'object') return msg;
  // Only treat it as a leaked payload if it has the signature fields.
  if (!('reasoning' in parsed) && !('actions' in parsed)) return msg;
  const actions = normalizeActions(parsed.actions);
  const doneAction = actions.find(a => a.type === 'done');
  const healedText = safeText(doneAction?.response) || safeText(parsed.reasoning) || text;
  const healedReasoning = msg.reasoning || safeText(parsed.reasoning) || undefined;
  // Mark so we don't re-parse every render.
  return { ...msg, text: healedText, reasoning: healedReasoning, healed: true };
}

function createNewConversation() {
  const id = generateId();
  conversations[id] = {
    id,
    title: 'New Chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  activeId = id;
  tabsState = openChatTab(tabsState, id); // every chat opens as a tab
  saveConversations();
}

/**
 * Stamp + persist one conversation (auto-title from the first user message).
 * Targets the ACTIVE chat by default; background-stream persistence passes
 * the streaming chat's id explicitly. Also refreshes the tab bar (title may
 * have auto-titled).
 */
async function saveConversationById(id = activeId) {
  const conv = conversations[id];
  if (!conv) return;
  conv.updatedAt = Date.now();
  // Auto-title from first user message
  const firstUserMsg = conv.messages.find(m => m.role === 'user');
  if (firstUserMsg && conv.title === 'New Chat') {
    conv.title = String(firstUserMsg.text || '').substring(0, 60);
  }
  await saveConversations();
  renderChatTabs();
}

async function saveCurrentConversation() {
  await saveConversationById(activeId);
}

async function ensureActiveConversation() {
  const conv = getActiveConversation();
  if (!conv) {
    createNewConversation();
  }
}

// ---- Empty-state starter chips ----
// An empty chat shows mode-agnostic starting points as clickable chips that
// prefill the composer — the panel answers "what can I even ask?" at a glance.
// The card removes itself the moment a real message lands.
const EMPTY_STATE_CHIPS = [
  { label: '📝 Summarize this page', value: 'Summarize this page' },
  { label: '❓ What is on this page?', value: '!context What are the main points on this page?' },
  { label: '📥 Extract the links', value: 'Extract all links on this page as a list' },
  { label: '🔬 Research this topic', value: 'Research this page\'s topic and give me the key facts' },
];
function renderEmptyState() {
  let card = document.getElementById('empty-state');
  if (card) card.remove();
  card = document.createElement('div');
  card.id = 'empty-state';
  card.className = 'empty-state';
  const hint = document.createElement('div');
  hint.className = 'empty-state-hint';
  hint.textContent = 'Try asking:';
  card.appendChild(hint);
  const chipRow = document.createElement('div');
  chipRow.className = 'empty-state-chips';
  for (const chip of EMPTY_STATE_CHIPS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'empty-state-chip';
    btn.textContent = chip.label;
    btn.title = chip.value;
    btn.addEventListener('click', () => {
      input.value = chip.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
    chipRow.appendChild(btn);
  }
  card.appendChild(chipRow);
  msgsEl.appendChild(card);
}

// ---- Jump to latest ----
// While a stream is live (or after new content lands) the log no longer
// force-scrolls under the user's finger; a ⬇ pill appears whenever the view
// is scrolled away from the bottom and snaps back on click.
const JUMP_LATEST_THRESHOLD = 240;
function msgsNearBottom() {
  return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < JUMP_LATEST_THRESHOLD;
}
function initJumpToLatest() {
  const btn = document.getElementById('jump-latest');
  if (!btn) return;
  btn.addEventListener('click', () => {
    msgsEl.scrollTop = msgsEl.scrollHeight;
    btn.classList.add('hidden');
  });
  msgsEl.addEventListener('scroll', () => {
    btn.classList.toggle('hidden', msgsNearBottom());
  }, { passive: true });
}

function renderCurrentConversation() {
  msgsEl.innerHTML = '';
  const conv = getActiveConversation();
  if (!conv || !conv.messages.length) {
    addMessageDOM('system', 'Connected to Zo. Ask me about this page, or tell me what to do.');
    renderEmptyState();
    return;
  }
  for (const msg of conv.messages) {
    const m = msg.role === 'assistant' ? healAssistantMessage(msg) : msg;
    const opts = m.role === 'assistant'
      ? { timestamp: m.timestamp, durationMs: m.durationMs, contextTier: m.contextTier, contextReason: m.contextReason }
      : {};
    const el = addMessageDOM(m.role, m.text, opts);
    if (m.role === 'assistant' && m.reasoning) addReasoningBubble(el, m.reasoning);
    if (m.role === 'assistant' && m.tools) addExploredRegion(el, m.tools);
    // Link chips re-derive deterministically from the persisted text —
    // nothing extra is stored (auto-referencing fires only on Open all).
    if (m.role === 'assistant') addLinkChipsCard(el, extractUrls(m.text));
    if (m.role === 'user' && Array.isArray(m.tabRefs)) renderTabRefPills(el, m.tabRefs);
    if (m.role === 'user') {
      const userBody = el && el.querySelector ? el.querySelector('.msg-body') : null;
      if (userBody) {
        for (const s of (m.skillRefs || [])) appendMentionPill(userBody, `⚡ ${safeText(s && s.name)}`);
        for (const f of (m.fileRefs || [])) appendMentionPill(userBody, `📄 ${safeText(f && f.path).split('/').pop()}`);
      }
    }
  }
}

async function startNewConversation() {
  // The in-flight stream belongs to the OLD chat — cancel it (a new chat with
  // a stale live bubble would be confusing).
  cancelStream();
  // Save current if it has messages
  const current = getActiveConversation();
  if (current && current.messages.length > 0) {
    await saveCurrentConversation();
  }
  stashTabRefs(); // remember this chat's tab-context toggles

  // Reset Zo conversation on the backend
  chrome.runtime.sendMessage({ type: 'NEW_CONVERSATION' });

  // Create new conversation (opens its tab)
  createNewConversation();

  // Reset the per-conversation context policy state — a new chat is eligible
  // for a fresh full-context attach (opt-in DOM / send-once), keyed per chat.
  contextState = createConversationState();
  await saveConversationState(activeId, contextState);
  restoreTabRefs(); // loads the new chat's (empty) toggle set

  // A new chat describes the browser tab the user is on NOW (display-only
  // adopt — no capture/banner); the full capture happens at the first send.
  adoptActiveTabDisplay();

  renderPromptInspector();

  // Clear UI
  msgsEl.innerHTML = '';
  addMessageDOM('system', 'Connected to Zo. Ask me about this page, or tell me what to do.');
  renderEmptyState();

  // If in history view, switch back
  if (isHistoryView) {
    isHistoryView = false;
    renderView();
  }

  renderChatTabs();
  updateHistoryBadge();
}

/**
 * Switch the active chat. The in-flight stream is NOT cancelled — it keeps
 * accumulating into its own conversation (routed by streamSession.chatId) and
 * its tab shows a pulse; switching back re-creates the live bubble.
 */
async function switchToConversation(id) {
  if (id === activeId) {
    if (isHistoryView) { isHistoryView = false; renderView(); }
    return;
  }

  // Save current conversation + its UI state first
  await saveCurrentConversation();
  stashTabRefs();

  // Switch (opening the tab covers history-view switches to unopened chats)
  activeId = id;
  tabsState = openChatTab(tabsState, id);
  await saveConversations();

  // Per-chat context-policy state + tab-ref toggles
  contextState = await loadConversationState(activeId);
  restoreTabRefs();
  hidePendingActionsBar();
  renderCurrentConversation();
  restorePendingActionsFor(id);

  // If this chat is the one generating, re-create the live bubble from the
  // accumulated session state and restart the elapsed timer.
  if (streamSession.active && streamSession.chatId === id) {
    streamSession.msgEl = addMessageDOM('assistant', '', { streaming: true });
    const body = streamSession.msgEl.querySelector('.msg-body');
    if (body && streamSession.reasoningText) {
      const details = document.createElement('details');
      details.className = 'msg-stream-reasoning';
      const summary = document.createElement('summary');
      summary.className = 'msg-stream-reasoning-summary';
      summary.textContent = '💭 Thought';
      const content = document.createElement('div');
      content.className = 'msg-stream-reasoning-content';
      const span = document.createElement('span');
      span.className = 'msg-thought';
      span.textContent = streamSession.reasoningText;
      content.appendChild(span);
      details.appendChild(summary);
      details.appendChild(content);
      body.appendChild(details);
    }
    if (body && streamSession.fullText && !looksLikeActionJson(streamSession.fullText)) {
      const span = document.createElement('span');
      span.className = 'msg-streaming-text';
      span.textContent = streamSession.fullText;
      body.appendChild(span);
    }
    startStreamTimer(streamSession.msgEl);
  } else if (streamSession.active) {
    // Another chat is generating — the composer stays disabled until it ends
    // (one stream at a time); the pulsing tab dot says where.
    input.disabled = true;
    sendBtn.disabled = true;
  }

  renderChatTabs();
  renderPromptInspector();

  // If in history view, switch back to chat
  if (isHistoryView) {
    isHistoryView = false;
    renderView();
  }
}

async function deleteConversation(id) {
  // A generating chat can't outlive its stream — cancel first.
  if (streamSession.active && streamSession.chatId === id) cancelStream();
  delete conversations[id];
  chatTabRefs.delete(id);
  tabsState = pruneChatTabs(tabsState, Object.keys(conversations));
  if (activeId === id) {
    // If deleting active, find another or create new
    const ids = Object.keys(conversations);
    if (tabsState.openIds.length && tabsState.activeId) {
      activeId = tabsState.activeId;
    } else if (ids.length > 0) {
      activeId = ids[0];
      tabsState = openChatTab(tabsState, activeId);
    } else {
      createNewConversation();
    }
    contextState = await loadConversationState(activeId);
    restoreTabRefs();
    hidePendingActionsBar();
    renderCurrentConversation();
    restorePendingActionsFor(activeId);
  }
  await saveConversations();
  renderChatTabs();
  updateHistoryBadge();
  if (isHistoryView) {
    renderHistoryView();
  }
}

// ---- Chat tab bar ----

/** Render the open-chat tab strip (call after any conversation mutation). */
function renderChatTabs() {
  if (!chatTabsEl) return;
  tabsState = pruneChatTabs(tabsState, Object.keys(conversations));
  if (activeId && tabsState.openIds.includes(activeId)) {
    tabsState = activateChatTab(tabsState, activeId);
  }
  chatTabsEl.replaceChildren();
  if (tabsState.openIds.length <= 1) return; // a single tab adds noise, not value
  const streamingId = streamSession.active ? streamSession.chatId : null;
  for (const id of tabsState.openIds) {
    const convo = conversations[id];
    if (!convo) continue;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'chat-tab' + (id === activeId ? ' chat-tab-active' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(id === activeId));
    tab.title = tabTitleFor(convo) + (id === streamingId ? ' — generating…' : '');
    if (id === streamingId) {
      const dot = document.createElement('span');
      dot.className = 'chat-tab-stream-dot';
      tab.appendChild(dot);
    }
    const label = document.createElement('span');
    label.className = 'chat-tab-label';
    label.textContent = tabTitleFor(convo);
    tab.appendChild(label);
    const close = document.createElement('span');
    close.className = 'chat-tab-close';
    close.textContent = '✕';
    close.title = 'Close tab';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeChatTabById(id);
    });
    tab.appendChild(close);
    tab.addEventListener('click', () => switchToConversation(id));
    // Middle-click closes, like a browser tab.
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeChatTabById(id);
      }
    });
    chatTabsEl.appendChild(tab);
  }
}

/** Close one chat tab (the conversation itself stays in history). */
async function closeChatTabById(id) {
  if (streamSession.active && streamSession.chatId === id) cancelStream();
  const next = closeChatTab(tabsState, id);
  if (next.activeId && next.activeId !== activeId) {
    await switchToConversation(next.activeId);
    return; // switchToConversation already saved + re-rendered
  }
  tabsState = next;
  await saveConversations();
  renderChatTabs();
}

function listConversationSummaries() {
  return searchConversations(conversations, '', { activeId });
}

function updateHistoryBadge() {
  const count = Object.keys(conversations).length;
  historyBtn.textContent = count > 1 ? `☰ ${count}` : '☰';
  historyBtn.title = count > 1 ? `History (${count} conversations)` : 'History';
}

// ---- History view ----

function renderHistoryView() {
  historyViewEl.classList.remove('hidden');
  chatView.classList.add('hidden');
  historyBtn.classList.add('active');

  const query = historySearch ? historySearch.value : '';
  const summaries = searchConversations(conversations, query, { activeId });
  historyList.innerHTML = '';

  if (summaries.length === 0) {
    historyList.innerHTML = `<div class="history-empty">${query ? 'No matching chats.' : 'No past conversations yet.'}</div>`;
    return;
  }

  // Group by date
  const groups = groupByDate(summaries);
  for (const [label, items] of Object.entries(groups)) {
    const groupEl = document.createElement('div');
    groupEl.className = 'history-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'history-group-label';
    labelEl.textContent = label;
    groupEl.appendChild(labelEl);

    for (const item of items) {
      const card = document.createElement('div');
      card.className = `history-card${item.isActive ? ' history-card-active' : ''}`;
      card.dataset.convId = item.id;

      const titleEl = document.createElement('div');
      titleEl.className = 'history-card-title';
      appendHighlighted(titleEl, item.title, query);

      // Main column: title + one-line preview of the opening ask (identifying
      // a chat without opening it). No snippet → title-only, layout unchanged.
      const mainEl = document.createElement('div');
      mainEl.className = 'history-card-main';
      mainEl.appendChild(titleEl);
      if (item.snippet) {
        const snippetEl = document.createElement('div');
        snippetEl.className = 'history-card-snippet';
        appendHighlighted(snippetEl, item.snippet, query);
        mainEl.appendChild(snippetEl);
      }

      const metaEl = document.createElement('div');
      metaEl.className = 'history-card-meta';
      const timeStr = formatTime(item.updatedAt);
      metaEl.textContent = `${item.messageCount} msg · ${timeStr}`;

      const renameBtn = document.createElement('button');
      renameBtn.className = 'history-card-rename';
      renameBtn.textContent = '✎';
      renameBtn.title = 'Rename conversation';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startCardRename(card, item);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'history-card-delete';
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Delete conversation';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this conversation?')) {
          deleteConversation(item.id);
        }
      });

      card.appendChild(mainEl);
      card.appendChild(metaEl);
      card.appendChild(renameBtn);
      card.appendChild(deleteBtn);

      card.addEventListener('click', () => switchToConversation(item.id));

      groupEl.appendChild(card);
    }

    historyList.appendChild(groupEl);
  }
}

/** Append `text` into `el`, wrapping case-insensitive `query` matches in
 * <mark> (safe DOM nodes only — no innerHTML). No query → plain text. */
function appendHighlighted(el, text, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      el.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    el.appendChild(document.createTextNode(text.slice(i, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + q.length);
    el.appendChild(mark);
    i = idx + q.length;
  }
}

/**
 * Inline rename: swap the card's title for an input. Enter/blur commits
 * (via lib renameConversation — empty no-ops), Esc cancels. Re-renders the
 * list + tab bar on commit.
 */
function startCardRename(card, item) {
  const titleEl = card.querySelector('.history-card-title');
  if (!titleEl || card.querySelector('.history-rename-input')) return;
  const inputEl = document.createElement('input');
  inputEl.className = 'history-rename-input';
  inputEl.type = 'text';
  inputEl.value = item.title;
  inputEl.maxLength = 60;
  inputEl.placeholder = 'Chat title';
  inputEl.addEventListener('click', (e) => e.stopPropagation());
  inputEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  inputEl.addEventListener('blur', () => commit(true));

  let settled = false;
  function commit(save) {
    if (settled) return;
    settled = true;
    if (save) {
      const r = renameConversation(conversations, item.id, inputEl.value);
      if (r.changed) {
        conversations = r.convos;
        saveConversations().then(renderChatTabs);
      }
    }
    renderHistoryView();
  }

  titleEl.replaceWith(inputEl);
  inputEl.focus();
  inputEl.select();
}

function groupByDate(summaries) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const thisWeek = today - now.getDay() * 86400000;
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const groups = {};
  for (const item of summaries) {
    let label;
    if (item.updatedAt >= today) label = 'Today';
    else if (item.updatedAt >= yesterday) label = 'Yesterday';
    else if (item.updatedAt >= thisWeek) label = 'This Week';
    else if (item.updatedAt >= thisMonth) label = 'This Month';
    else label = 'Older';
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  }
  return groups;
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---- Page Context ----
async function refreshPageContext() {
  // Capture at the active Mode's tier — INCLUDING any built-in override, so a
  // user raising a Mode's contextTier in Settings actually captures the
  // higher-tier fields (the per-turn effectiveTier from decideTurn can only
  // thin what was captured; it can never widen it).
  const mode = resolveMode(activeModeId, customModes, modeOverrides);
  const resp = await chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT', tier: mode.contextTier, modeId: activeModeId });
  if (resp && !resp.error) {
    currentContext = resp;
    pageUrl.textContent = resp.title || resp.url;
    pageUrl.title = resp.url;
  } else {
    pageUrl.textContent = '— no page —';
    currentContext = null;
  }
}

/**
 * Lightweight display adoption of a browser tab: URL/title/tabId straight
 * from the tabs API — NO capture, so NO debugger banner. Keeps the page bar,
 * 📎 strip ("this tab" marker), and inspector describing the tab the user is
 * actually on between sends (the full Mode-tier capture still happens per
 * send in refreshPageContext). Replaces currentContext wholesale — stale
 * text from the previous tab must never ride under a new URL.
 */
async function adoptActiveTabDisplay(tabId) {
  try {
    let id = tabId;
    if (id == null) {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      id = t?.id;
    }
    if (id == null) return;
    const tab = await chrome.tabs.get(id);
    if (!tab || !tab.url) return;
    currentContext = { url: tab.url, title: tab.title || '', tabId: tab.id, viewport: currentContext?.viewport };
    pageUrl.textContent = tab.title || tab.url;
    pageUrl.title = tab.url;
    renderPromptInspector();
    refreshOpenTabs(); // moves the ◈ this-tab marker
  } catch { /* tab gone — keep the last known page */ }
}

// ---- Prompt inspector ----
// Live preview of the exact prompt that will be sent to Zo for the current
// input + active Mode, including the context-policy decision (effective tier,
// opt-in / send-once reason) and a rough token estimate. Computed client-side
// from the shared lib/prompt.js so it never drifts from what the background
// actually sends.
const TIER_NAMES = ['Pointer (URL only)', 'Text', 'Elements', 'Screenshot'];
let promptInspectorTimer = null;
function schedulePromptInspector() {
  clearTimeout(promptInspectorTimer);
  promptInspectorTimer = setTimeout(renderPromptInspector, 150);
}
function renderPromptInspector() {
  const summary = document.getElementById('prompt-inspector-summary');
  const meta = document.getElementById('prompt-inspector-meta');
  const pre = document.getElementById('prompt-preview');
  if (!summary || !meta || !pre) return;

  const raw = input.value.trim();
  // If the user is typing a bang, preview the resolved query + its policy effect
  // (so !context shows full context attaching).
  let bang = null;
  if (raw.startsWith('!')) {
    bang = parseBangCommand(raw);
  }
  const isContextBang = !!bang && bang.kind === 'context';
  const query = bang && typeof bang.query === 'string' && bang.query
    ? bang.query
    : (raw || '(your question)');
  // A mode-switching bang (!summarize, !extract, !research, !qa/!ask) resolves
  // to a different Mode for the turn — mirror sendQuery so the preview matches
  // the actual send rather than always showing the active Mode.
  const bangModeId = bang && bang.kind === 'command' && bang.mode ? bang.mode : null;

  const mode = resolveMode(bangModeId || activeModeId, customModes, modeOverrides);
  const pageHash = currentContext ? computePageHash(currentContext, mode.contextTier) : null;
  const decision = decideTurn({
    mode,
    query,
    bang: isContextBang ? bang : null,
    state: contextState,
    pageHash,
    pageBlank: isBlankPage(currentContext?.url || ''),
  });
  const described = describePrompt(mode, currentContext, query, { effectiveTier: decision.effectiveTier, tabContexts: previewTabContexts({ includeActive: decision.effectiveTier === 0 }), skills: pickedSkills, workspaceFiles: pickedFiles });

  summary.textContent = `🔎 Prompt preview · ~${described.approxTokens} tokens`;
  meta.replaceChildren();
  const chip = (label, value) => {
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = label + ' ';
    span.appendChild(b);
    span.appendChild(document.createTextNode(value));
    return span;
  };
  meta.appendChild(chip('Mode:', `${mode.icon} ${mode.name}`));
  meta.appendChild(chip('Context:', TIER_NAMES[decision.effectiveTier] || `Tier ${decision.effectiveTier}`));
  const reasonSpan = document.createElement('span');
  reasonSpan.textContent = decision.reason;
  meta.appendChild(reasonSpan);
  pre.textContent = described.prompt;
}

// ---- Fetch models and personas ----
async function fetchModelsAndPersonas() {
  // Restore saved selections from chrome.storage.sync
  const saved = await chrome.storage.sync.get(['zoModel', 'zoPersonaId']);
  if (saved.zoModel) config.selectedModel = saved.zoModel;
  if (saved.zoPersonaId) config.selectedPersona = saved.zoPersonaId;

  const modelsResp = await chrome.runtime.sendMessage({ type: 'LIST_MODELS' });
  if (modelsResp?.success && Array.isArray(modelsResp.models)) {
    cachedModels = modelsResp.models; // Cache for label lookup in message footer
    modelSelect.innerHTML = '<option value="">Default model</option>';
    for (const m of modelsResp.models) {
      const opt = document.createElement('option');
      // API returns { model_name, label, vendor, type, ... }
      opt.value = m.model_name || m.id || '';
      opt.textContent = m.label || m.name || m.model_name || m.id;
      if (opt.value === config.selectedModel) opt.selected = true;
      modelSelect.appendChild(opt);
    }
  } else {
    cachedModels = [];
    modelSelect.innerHTML = '<option value="">Models unavailable</option>';
  }

  const personasResp = await chrome.runtime.sendMessage({ type: 'LIST_PERSONAS' });
  if (personasResp?.success && Array.isArray(personasResp.personas)) {
    personaSelect.innerHTML = '<option value="">Zo (default)</option>';
    for (const p of personasResp.personas) {
      const opt = document.createElement('option');
      opt.value = p.id || p.name || '';
      opt.textContent = p.name || p.id || '';
      if (opt.value === config.selectedPersona) opt.selected = true;
      personaSelect.appendChild(opt);
    }
  }
}

// ---- Bang Commands (!) — Quick Command Templates (#07) ----
// Logic extracted to lib/bang-commands.js for unit testing (see tests/bang-commands.test.ts).

// Render a DuckDB query result as an inline table in the chat.
// Expects { columns: string[], rows: any[][], rowCount, sql } from background.js
function addDuckdbResult(resp) {
  if (!resp.columns || !resp.rows) {
    addMessage('assistant', 'Query returned no rows.');
    return;
  }
  const msg = document.createElement('div');
  msg.className = 'msg msg-assistant duckdb-result';
  const table = renderTable(resp.columns, resp.rows);
  msg.innerHTML = `<div class="db-sql"><code>${escapeHtml(resp.sql || '')}</code></div>${table}`;
  msgsEl.appendChild(msg);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

// Build an HTML table string from columns + rows.
function renderTable(columns, rows) {
  const thead = columns.map(c => `<th>${escapeHtml(c)}</th>`).join('');
  const tbody = rows.map(r =>
    `<tr>${r.map(cell => `<td>${escapeHtml(cell == null ? '' : String(cell))}</td>`).join('')}</tr>`
  ).join('');
  return `<div class="db-table-wrap"><table class="db-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

function escapeHtml(s) {
  s = safeText(s);
  if (s === '') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');
}

// ---- Action Timeline (#03) ----
// Renders an inline "⚡ Performed N actions · <duration>" tool-trace card in
// the chat stream (Zo's "Explored N steps Ns" analog), with grouped cards
// inside. Repeated consecutive actions collapse into a single card with a
// "× N" count.
const ACTION_META = {
  click:     { icon: '👆', label: 'Click' },
  fill:      { icon: '✏️', label: 'Fill' },
  fill_form: { icon: '📝', label: 'Fill form' },
  scroll:    { icon: '📜', label: 'Scroll' },
  navigate:  { icon: '🔗', label: 'Navigate' },
  extract:   { icon: '📋', label: 'Extract' },
  wait:      { icon: '⏳', label: 'Wait' },
  done:      { icon: '✅', label: 'Done' },
};

function actionDetail(action) {
  if (action.response) return '';
  if (action.type === 'fill_form') return action.values?.length ? `${action.values.length} fields` : '';
  return action.selector || action.url || action.value || action.ms || '';
}

/**
 * Stable identity key for an action, used to detect consecutive repeats that
 * should collapse into one timeline card (e.g. multiple clicks on the same
 * selector). Two actions share a key iff they are operationally identical.
 */
function actionKey(action) {
  if (!action || typeof action !== 'object') return '';
  return [action.type, action.selector || '', action.url || '',
          action.value || '', action.attribute || '',
          action.direction || '', String(action.ms || '')].join('|');
}

/**
 * Group consecutive identical actions into runs, matching zo.computer's
 * "Ran command · 3 times" pattern. Returns objects of shape
 * { action, count, indices: number[] } preserving original order; non-
 * consecutive duplicates stay separate. Pure (no DOM deps) → unit-testable.
 *
 * @param {object[]} actions
 * @returns {{ action: object, count: number, indices: number[] }[]}
 */
function groupActions(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const key = actionKey(a);
    const prev = out[out.length - 1];
    if (prev && actionKey(prev.action) === key) {
      prev.count++;
      prev.indices.push(i);
    } else {
      out.push({ action: a, count: 1, indices: [i] });
    }
  }
  return out;
}

// Format an elapsed duration in ms as a compact human string (e.g. "42s", "4m 57s").
function formatDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 1) return '<1s';
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

// Relative timestamp like Zo's message footer ("1d", "5m", "just now").
// Pure (no chrome.* / DOM deps) so it's unit-testable directly.
function relativeTime(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '';
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? '1m' : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1h' : `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? '1d' : `${d}d`;
  // Week vs month boundary at 30 days: 7–29 days read as weeks, 30+ as months.
  // (30d ≈ 4.3 weeks, but reads as "1mo" not "4w"; 21d stays "3w".)
  if (d < 30) {
    const w = Math.floor(d / 7);
    return w === 1 ? '1w' : `${w}w`;
  }
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo === 1 ? '1mo' : `${mo}mo`;
  const y = Math.floor(d / 365);
  return y === 1 ? '1y' : `${y}y`;
}

// Per-turn message footer (Zo footer parity): Copy, mode chip, model chip,
// relative timestamp, and feedback (Good / Bad / Loved it). Rendered inside
// an assistant message (left-aligned) after the body. Feedback is stored
// locally on the history entry (no backend).
function addMessageFooter(parentMsgEl, opts = {}) {
  if (!parentMsgEl || parentMsgEl.querySelector('.msg-footer')) return null;
  const { timestamp, modeName, modelName, durationMs, contextTier, contextReason } = opts;
  const footer = document.createElement('div');
  footer.className = 'msg-footer';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'msg-footer-btn msg-footer-copy';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Copy this message';
  const body = parentMsgEl.querySelector('.msg-body');
  copyBtn.addEventListener('click', async () => {
    const text = body ? body.textContent || '' : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    } catch { /* clipboard unavailable */ }
  });
  footer.appendChild(copyBtn);

  if (modeName) {
    const modeChip = document.createElement('span');
    modeChip.className = 'msg-footer-chip msg-footer-mode';
    modeChip.textContent = safeText(modeName);
    modeChip.title = 'Mode';
    footer.appendChild(modeChip);
  }
  if (modelName) {
    const modelChip = document.createElement('span');
    modelChip.className = 'msg-footer-chip msg-footer-model';
    // Look up label from cached models, fallback to modelName
    const modelDisplay = cachedModels.find(m => (m.model_name || m.id) === modelName)?.label || modelName;
    modelChip.textContent = safeText(modelDisplay);
    modelChip.title = 'Model';
    footer.appendChild(modelChip);
  }

  // Context-tier chip: shows how much page context this turn actually sent
  // (the decideTurn policy outcome) — makes the token story visible per turn.
  if (Number.isInteger(contextTier)) {
    const CTX_ICONS = ['🔗', '📝', '🧩', '📷'];
    const CTX_NAMES = ['URL only', 'Text', 'Elements', 'Screenshot'];
    const ctxChip = document.createElement('span');
    ctxChip.className = 'msg-footer-chip msg-footer-context';
    ctxChip.textContent = `${CTX_ICONS[contextTier] || '🔗'} ${CTX_NAMES[contextTier] || 'Tier ' + contextTier}`;
    ctxChip.title = safeText(contextReason) || 'Context sent this turn';
    footer.appendChild(ctxChip);
  }

  if (timestamp) {
    const timeEl = document.createElement('span');
    timeEl.className = 'msg-footer-time';
    // Relative timestamp + total request duration (e.g. "just now · 4s").
    const dur = formatDuration(durationMs);
    timeEl.textContent = dur ? `${relativeTime(timestamp)} · ${dur}` : relativeTime(timestamp);
    footer.appendChild(timeEl);
  }

  parentMsgEl.appendChild(footer);
  return footer;
}

// Zo-style error card: "Response interrupted" heading + the technical detail
// (status/model/body) + a Retry button that re-sends the last query. Rendered
// as a normal .msg so it flows in the chat and is persisted like other errors.
function addErrorCard(errorText, onRetry) {
  const div = document.createElement('div');
  div.className = 'msg msg-error';
  const body = document.createElement('div');
  body.className = 'msg-body';

  const title = document.createElement('div');
  title.className = 'error-card-title';
  title.textContent = 'Response interrupted';

  const detail = document.createElement('div');
  detail.className = 'error-card-detail';
  detail.textContent = safeText(errorText) || 'An unexpected error occurred.';

  const actionsEl = document.createElement('div');
  actionsEl.className = 'error-card-actions';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-sm btn-primary error-card-retry';
  retry.textContent = '↻ Retry';
  retry.addEventListener('click', () => { if (onRetry) onRetry(); });
  actionsEl.appendChild(retry);

  body.appendChild(title);
  body.appendChild(detail);
  body.appendChild(actionsEl);
  div.appendChild(body);
  msgsEl.appendChild(div);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  return div;
}

function renderActionTimeline() {
  if (!pendingActions) return;
  // Render inline in the chat stream (not in the separate #actions-bar), so a
  // run reads top-to-bottom as part of the turn like zo.computer. The bar's
  // Run All / Skip buttons still drive execution via their own handlers.
  let run = document.getElementById('action-run');
  if (run) run.remove();
  run = document.createElement('div');
  run.id = 'action-run';
  run.className = 'msg msg-action-run';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'action-run-header';
  header.setAttribute('aria-expanded', 'false');
  header.setAttribute('aria-label', 'Show action steps');
  header.innerHTML =
    '<span class="action-run-caret">▸</span>' +
    '<span class="action-run-label">⚡ Performing actions…</span>' +
    '<span class="action-run-count"></span>' +
    '<span class="action-run-duration"></span>';
  header.addEventListener('click', () => {
    const expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', String(!expanded));
    header.setAttribute('aria-label', expanded ? 'Show action steps' : 'Hide action steps');
    const caret = header.querySelector('.action-run-caret');
    if (caret) caret.textContent = expanded ? '▸' : '▾';
    const body = run.querySelector('.action-run-body');
    if (body) body.hidden = expanded;
  });
  run.appendChild(header);

  const body = document.createElement('div');
  body.className = 'action-run-body';
  body.hidden = true;  // collapsed by default
  const timeline = document.createElement('div');
  timeline.id = 'action-timeline';
  body.appendChild(timeline);
  run.appendChild(body);

  // Grouped cards: consecutive identical actions collapse to one card.
  const groups = groupActions(pendingActions);
  for (const g of groups) {
    const meta = ACTION_META[g.action.type] || { icon: '•', label: g.action.type };
    const card = document.createElement('div');
    card.className = 'action-card pending';
    card.classList.add(`action-card-${g.action.type}`);
    // Map every original index in this group to the same card so
    // updateActionCard(i) resolves the group's card for any member action.
    for (const idx of g.indices) card.dataset.index = card.dataset.index || String(idx);
    card.dataset.indices = g.indices.join(',');
    card.innerHTML =
      `<span class="action-icon">${meta.icon}</span>` +
      `<span class="action-label">${meta.label}</span>` +
      `<span class="action-detail">${actionDetail(g.action)}</span>` +
      (g.count > 1 ? `<span class="action-count">× ${g.count}</span>` : '') +
      `<span class="action-status">pending</span>`;
    timeline.appendChild(card);
  }

  msgsEl.appendChild(run);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  // Keep the control bar (Run All / Skip) visible during the run.
  actionsBar.classList.remove('hidden');
}

function updateActionCard(index, status, error) {
  const timeline = document.getElementById('action-timeline');
  if (!timeline) return;
  // A grouped card covers multiple original indices; match by membership.
  const card = [...timeline.querySelectorAll('.action-card')].find((c) =>
    (c.dataset.indices || '').split(',').map(Number).includes(index)
  );
  if (!card) return;
  card.classList.remove('pending', 'running', 'done', 'error');
  card.classList.add(status);
  const statusEl = card.querySelector('.action-status');
  if (statusEl) statusEl.textContent = status === 'error' && error ? error : status;
}

// Update the inline run header summary (label + step count + duration).
function updateActionRunHeader(label, count, durationMs) {
  const run = document.getElementById('action-run');
  if (!run) return;
  const labelEl = run.querySelector('.action-run-label');
  const countEl = run.querySelector('.action-run-count');
  const durEl = run.querySelector('.action-run-duration');
  if (labelEl && label) labelEl.textContent = label;
  if (countEl && count) countEl.textContent = `· ${count} step${count === 1 ? '' : 's'}`;
  if (durEl) durEl.textContent = durationMs != null ? `· ${formatDuration(durationMs)}` : '';
}

/** Editable review card for a parked sensitive fill_form (#26). Resolves with
 *  the (possibly edited) fill_form action on confirm, or null on cancel.
 *  Secret rows render "left for you 🔑" — values for password/card fields are
 *  never round-tripped through the card (reviewRows blanks them). */
function renderFormReview(payload) {
  return new Promise((resolve) => {
    const fills = (payload.actions || []).filter((a) => a && (a.type === 'fill_form' || a.type === 'fill'));
    if (!fills.length) { resolve(null); return; }
    const rows = fillBatchRows(fills, payload.fields);
    const host = document.createElement('div');
    host.className = 'msg form-review-card';
    let hostName = '';
    try { hostName = new URL(payload.url).host; } catch { hostName = safeText(payload.url || ''); }
    const title = document.createElement('div');
    title.className = 'form-review-title';
    title.textContent = `Review before filling — ${hostName}`;
    host.appendChild(title);
    for (const r of payload.reasons || []) {
      const chip = document.createElement('span');
      chip.className = 'form-review-chip';
      chip.textContent = safeText(r);
      host.appendChild(chip);
    }
    const edits = new Map(); // row index → edited value
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const line = document.createElement('label');
      line.className = 'form-review-row';
      if (row.secret) {
        line.textContent = `${row.target}: left for you 🔑`;
      } else {
        line.textContent = row.target + ' ';
        const input = document.createElement('input');
        input.dataset.target = row.target;
        input.value = row.value;
        input.addEventListener('input', () => edits.set(ri, input.value));
        line.appendChild(input);
      }
      host.appendChild(line);
    }
    const confirm = document.createElement('button');
    confirm.className = 'btn btn-primary form-review-confirm';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost form-review-cancel';
    confirm.textContent = `Fill ${rows.filter((r) => !r.secret).length} fields`;
    cancel.textContent = 'Cancel';
    confirm.addEventListener('click', () => {
      // Confirmed batch — same order/count as `fills`; edits mapped back via
      // the rows' ai/vi back-references.
      const confirmed = fills.map((a) => a.type === 'fill_form' ? { ...a, values: (a.values || []).map((v) => ({ ...v })) } : { ...a });
      for (const [ri, val] of edits) {
        const row = rows[ri];
        if (row.kind === 'fill_form') confirmed[row.ai].values[row.vi] = { ...confirmed[row.ai].values[row.vi], value: val };
        else confirmed[row.ai] = { ...confirmed[row.ai], value: val };
      }
      // Secret rows NEVER round-trip — "left for you 🔑" means the proposed
      // value is dropped even if the user never touched the input (live-
      // observed: models propose password/card values despite the prompt rule).
      for (const row of rows) {
        if (!row.secret) continue;
        if (row.kind === 'fill_form') confirmed[row.ai].values[row.vi] = { ...confirmed[row.ai].values[row.vi], value: '' };
        else confirmed[row.ai] = { ...confirmed[row.ai], value: '' };
      }
      host.remove();
      resolve(confirmed);
    });
    cancel.addEventListener('click', () => {
      host.remove();
      resolve(null);
    });
    host.append(confirm, cancel);
    msgsEl.appendChild(host);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });
}

/** Per-field ✓/✗ rows inside a fill_form timeline card (#26). One card, N
 *  field outcomes — mirrors the card-per-action convention of the timeline. */
function renderFillFormFieldResults(index, result) {
  const timeline = document.getElementById('action-timeline');
  if (!timeline) return;
  const card = [...timeline.querySelectorAll('.action-card')].find((c) =>
    (c.dataset.indices || '').split(',').map(Number).includes(index),
  );
  if (!card) return;
  if (result.unverifiedForm) {
    const note = document.createElement('div');
    note.className = 'field-result field-result-note';
    note.textContent = '⚠️ unverified form — page was unreadable, no review shown';
    card.appendChild(note);
  }
  for (const f of result.fields || []) {
    const row = document.createElement('div');
    row.className = 'field-result';
    row.textContent = f.ok ? `✓ ${f.target}` : `✗ ${f.target} — ${safeText(f.error || 'failed')}`;
    card.appendChild(row);
  }
}

// ---- Execute pending actions ----
async function runPendingActions() {
  if (!pendingActions || actionRunning) return;
  // Snapshot the array so the Skip button nulling `pendingActions` mid-loop
  // can't cause a TypeError on the next length read.
  const actions = pendingActions;
  actionRunning = true;
  runAllBtn.disabled = true;
  skipBtn.disabled = false;

  const runStartTime = Date.now();
  renderActionTimeline();
  // Live header: count includes the done action.
  updateActionRunHeader('⚡ Performing actions…', actions.length, null);

  // Target the active WEB tab, never one of the extension's own pages (the
  // side panel URL opened as a tab is a legitimate user state — actions must
  // not run against it). Prefer the active non-extension tab, else the first
  // non-extension tab in the window.
  const openTabs = await chrome.tabs.query({ currentWindow: true });
  const webTabs = openTabs.filter((t) => !/^(chrome-extension|chrome|about|edge|devtools):/i.test(t.url || ''));
  const tabId = (webTabs.find((t) => t.active) || webTabs[0])?.id;
  if (!tabId) {
    addMessage('error', 'No active tab to execute actions on.');
    pendingActions = null;
    actionsBar.classList.add('hidden');
    actionRunning = false;
    runAllBtn.disabled = false;
    return;
  }

  // Batch sensitivity pre-flight (#26): ONE capture + at most ONE review
  // card per page for the whole fill batch. Models drift between fill_form
  // and plain fill actions; per-action parking would mean N review cards for
  // N fields (or worse, N auto-cancels). Benign forms execute right here —
  // the pre-flight IS the execution; sensitive ones park for one review.
  const fillIdxs = [];
  for (let i = 0; i < actions.length; i++) {
    const t = actions[i] && actions[i].type;
    if (t === 'fill' || t === 'fill_form') fillIdxs.push(i);
  }
  if (fillIdxs.length) {
    const fillActions = fillIdxs.map((i) => actions[i]);
    const applyFillResults = (resp, acts) => {
      const results = Array.isArray(resp?.results) ? resp.results : (resp && !resp.needsConfirm ? [resp] : []);
      acts.forEach((a, k) => {
        const r = results[k];
        const ok = r ? r.ok !== false : resp?.ok === true;
        if (a.type === 'fill_form' && r?.fields) renderFillFormFieldResults(fillIdxs[k], r);
        updateActionCard(fillIdxs[k], ok ? 'done' : 'error', ok ? undefined : safeText(r?.error || resp?.error || 'failed'));
      });
    };
    let fillResp = await chrome.runtime.sendMessage({ type: 'EXECUTE_ACTIONS', actions: fillActions, tabId });
    if (fillResp?.needsConfirm) {
      const decision = await renderFormReview(fillResp);
      if (!decision) {
        fillIdxs.forEach((i) => updateActionCard(i, 'error', 'skipped'));
        addMessageDOM('assistant', 'Skipped the form fill — nothing was entered. You can fill it yourself or ask again.');
        fillResp = null;
      } else {
        fillResp = await chrome.runtime.sendMessage({ type: 'EXECUTE_ACTIONS', actions: decision, tabId, confirmed: true });
      }
    }
    if (fillResp && !fillResp.needsConfirm) {
      applyFillResults(fillResp, fillActions);
      if (fillResp.ok === false) addMessage('error', `Action failed: ${fillResp.error || 'unknown error'}`);
    }
  }

  for (let i = 0; i < actions.length; i++) {
    // Stop if the user clicked Skip (nulls pendingActions) between awaits.
    if (!pendingActions) break;
    let action = actions[i];
    if (action.type === 'done') {
      updateActionCard(i, 'done');
      if (action.response) {
        const doneEl = addMessage('assistant', action.response);
        // Attach the reasoning bubble to the answer element (the message the
        // user actually reads), not the (possibly empty) streamed-text element.
        addReasoningBubble(doneEl, pendingActionsReasoning);
        addLinkChipsCard(doneEl, extractUrls(action.response));
      }
      continue;
    }
    // Fill-family actions were handled by the batch pre-flight above.
    if (action.type === 'fill' || action.type === 'fill_form') continue;
    updateActionCard(i, 'running');
    // No separate inline ".msg-action" message — the card in the run timeline
    // is the inline record now (avoids the prior duplicate rendering).
    const actionStart = Date.now();
    let result = await chrome.runtime.sendMessage({
      type: 'EXECUTE_ACTIONS',
      actions: [action],
      tabId,
    });
    if (!result?.ok) {
      const err = result?.error || 'unknown error';
      updateActionCard(i, 'error', err);
      addMessage('error', `Action failed: ${err}`);
      break;
    }
    updateActionCard(i, 'done');
    await new Promise((r) => setTimeout(r, 600));
    await refreshPageContext();
  }

  const elapsed = Date.now() - runStartTime;
  const completedCount = actions.length;
  // Finalize the inline run header: "⚡ Performed N actions · <duration>"
  // (Zo's "Explored N steps Ns" analog).
  updateActionRunHeader('⚡ Performed actions', completedCount, elapsed);

  pendingActions = null;
  pendingActionsReasoning = '';
  clearStoredPendingActions(activeId);
  setTimeout(() => actionsBar.classList.add('hidden'), 1200);
  actionRunning = false;
  runAllBtn.disabled = false;
}

/**
 * Actions that finished streaming while their chat was backgrounded are
 * stored on the conversation (conv.pendingActions). Switching to that chat
 * restores the Run All / Skip bar WITHOUT auto-running — the user decides
 * (the page may have changed since).
 */
function restorePendingActionsFor(id) {
  const conv = conversations[id];
  const stored = conv && conv.pendingActions;
  if (!stored || !Array.isArray(stored.actions) || !stored.actions.length) return;
  pendingActions = stored.actions;
  pendingActionsReasoning = safeText(stored.reasoning);
  actionsReasoning.textContent = `🧠 ${pendingActionsReasoning.substring(0, 200)}`;
  actionsBar.classList.remove('hidden');
}

function hidePendingActionsBar() {
  pendingActions = null;
  pendingActionsReasoning = '';
  actionsBar.classList.add('hidden');
}

/** Clear a chat's stored pending actions (Run All finished or Skipped). */
function clearStoredPendingActions(id) {
  const conv = conversations[id];
  if (conv && conv.pendingActions) {
    delete conv.pendingActions;
    saveConversations();
  }
}

// ---- Messages ----
/**
 * Append a message. Renders into the visible chat AND persists it — except
 * when `opts.chatId` targets a non-active chat (background-stream
 * persistence): then it only persists. Returns the DOM element (null for
 * background writes).
 */
function addMessage(role, text, opts = {}) {
  text = safeText(text);
  const chatId = opts.chatId || activeId;
  const isBackground = !!chatId && chatId !== activeId;
  let div = null;
  if (!isBackground) {
    div = addMessageDOM(role, text, opts);
    // Auto-read assistant messages via TTS
    if (role === 'assistant' && ttsAutoRead && text) {
      speakText(text);
    }
  }
  // Persist non-system, non-thinking messages to the target conversation
  if (role !== 'system' && role !== 'thinking') {
    const conv = conversations[chatId];
    if (conv) {
      conv.messages.push({ role, text, timestamp: Date.now() });
      // Trim to MAX_HISTORY per conversation
      if (conv.messages.length > MAX_HISTORY) {
        conv.messages = conv.messages.slice(-MAX_HISTORY);
      }
      saveConversationById(chatId);
    }
  }
  return div;
}


/** Upgrade every <pre> in a rendered message with a Copy button. Idempotent —
 * safe to call again on containers that already got their buttons. */function enhanceCodeBlocks(container) {
  if (!container || !container.querySelectorAll) return;
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.querySelector('.code-copy-btn')) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.title = 'Copy code';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const code = (pre.querySelector('code') || pre).textContent || '';
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = 'Copied ✓';
      } catch {
        btn.textContent = '✕';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
    pre.appendChild(btn);
  }
}

function markdownToHtml(md) {
  if (!md) return '';  // Escape HTML to prevent XSS
  var html = escapeHtml(md);

  // Horizontal rules
  html = html.replace(/^-{3,}$/gm, '<hr>');

  // Headings (### → <h3>, #### → <h4>, etc.)
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Code blocks: triple backtick with optional language. `html` is ALREADY
  // fully escaped above — re-escaping the code here would double-escape
  // (&#39; showing up literally in the block and in Copy).
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
    var cls = lang ? ' class="lang-' + escapeHtml(lang) + '"' : '';
    return '<pre><code' + cls + '>' + code.trim() + '</code></pre>';
  });
  // Inline code
  html = html.replace(/`([^`]+)`/g, function(_, c) { return '<code>' + escapeHtml(c) + '</code>'; });

  // Tables: markdown pipe tables
  html = html.replace(/\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/g, function(_, headerRow, bodyRows) {
    var headers = headerRow.split('|').filter(function(c) { return c.trim(); });
    var thead = '<thead><tr>' + headers.map(function(h) { return '<th>' + h.trim() + '</th>'; }).join('') + '</tr></thead>';
    var tbody = '<tbody>';
    var rows = bodyRows.trim().split('\n');
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].split('|').filter(function(c) { return c.trim(); });
      if (cells.length) {
        tbody += '<tr>' + cells.map(function(c) { return '<td>' + c.trim() + '</td>'; }).join('') + '</tr>';
      }
    }
    tbody += '</tbody>';
    return '<table>' + thead + tbody + '</table>';
  });

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links — only allow safe URL schemes
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, function(_, text, url) {
    var safeUrl = url.trim();
    // Only http:, https:, mailto:, and relative paths are allowed
    if (!/^(https?:\/\/|mailto:|\/|#)/i.test(safeUrl)) {
      return text; // render as plain text instead of a link
    }
    return '<a href="' + safeUrl.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
  });
  // Bare URL auto-linking — wrap http(s):// URLs in anchor tags
  html = html.replace(/(?<!=\"|>)(https?:\/\/[^\s<\"\)\]>,;!?]+)/g, function(_, url) {
    var safeUrl = url.replace(/[<>]/g, '');
    if (!/^(https?:)/i.test(safeUrl)) return url;
    return '<a href="' + safeUrl.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">' + safeUrl + '</a>';
  });

  // Lists + paragraphs: single-pass line processor
  var lines = html.split('\n');
  var out = [];
  var listTag = null;
  var listStart = -1;
  function flushList(i) {
    if (listStart === -1) return;
    var tag = listTag;
    out.push('<' + tag + '>');
    for (var li = listStart; li < i; li++) {
      var item = lines[li].replace(/^\d+\.\s+|^[-*]\s+/, '');
      out.push('<li>' + item + '</li>');
    }
    out.push('</' + tag + '>');
    listStart = -1;
    listTag = null;
  }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\d+\.\s/.test(line)) {
      if (listTag === 'ul' && listStart !== -1) flushList(i);
      if (listStart === -1) { listStart = i; listTag = 'ol'; }
    } else if (/^[-*]\s/.test(line)) {
      if (listTag === 'ol' && listStart !== -1) flushList(i);
      if (listStart === -1) { listStart = i; listTag = 'ul'; }
    } else if (/^\s*$/.test(line) && listStart !== -1) {
      flushList(i);
    } else {
      if (listStart !== -1) flushList(i);
      out.push(line);
    }
  }
  if (listStart !== -1) flushList(lines.length);
  html = out.join('\n');

  // Paragraphs for double newlines (must run last)
  var paras = html.split('\n\n').filter(function(p) { return p.trim(); });
  if (paras.length > 1) {
    html = paras.map(function(p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).join('');
  } else {
    html = html.replace(/\n/g, '<br>');
  }
  return html;
}

function addMessageDOM(role, text, opts = {}) {
  text = safeText(text);
  // First real message retires the empty-state starter card.
  if (role !== 'system' && role !== 'thinking') {
    const emptyCard = document.getElementById('empty-state');
    if (emptyCard) emptyCard.remove();
  }
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  const body = document.createElement('div');
  body.className = 'msg-body';

  // All roles render markdown (user input is prose too, matching Zo's
  // composer-shell which renders TipTap/ProseMirror). markdownToHtml +
  // safeText keep every text sink escaped — never raw innerHTML of
  // untrusted text.
  body.innerHTML = markdownToHtml(text);
  enhanceCodeBlocks(body);

  div.appendChild(body);

  // TTS speaker button on assistant and system messages (only non-empty)
  if ((role === 'assistant' || role === 'system') && text && text.trim()) {
    const ttsBtn = document.createElement('button');
    ttsBtn.className = 'tts-btn msg-tts-btn';
    ttsBtn.textContent = '🔊';
    ttsBtn.title = 'Read aloud';
    ttsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      speakText(text, ttsBtn);
    });
    div.appendChild(ttsBtn);
  }

  // Assistant-turn footer (Zo parity): Copy / mode / model / time.
  // Suppressed while streaming (`opts.streaming`) — the live processing
  // timer takes its place and the full footer is rendered at STREAM_DONE.
  // History re-render passes `opts.timestamp` / `opts.durationMs` so
  // reloaded messages keep their original time + total request duration.
  if (role === 'assistant' && !opts.streaming) {
    const mode = resolveMode(activeModeId, customModes);
    addMessageFooter(div, {
      timestamp: opts.timestamp || Date.now(),
      modeName: mode.name,
      modelName: config.selectedModel || undefined,
      durationMs: opts.durationMs,
      contextTier: opts.contextTier,
      contextReason: opts.contextReason,
    });
  }

  msgsEl.appendChild(div);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  return div;
}

// Render a page/file mention pill (Zo file-mention badge) and append it
// to a user message body. `label` is the page title or filename; an inline
// SVG file icon leads, matching Zo's data-testid="file-mention-badge".
// Pure DOM, text-safed. Returns the pill element.
function appendMentionPill(userBody, label) {
  if (!userBody) return null;
  const pill = document.createElement('span');
  pill.className = 'msg-mention';

  const icon = document.createElement('span');
  icon.className = 'msg-mention-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 18 16" width="18" height="16"><path d="M3.25 1A2.25 2.25 0 0 0 1 3.25v9.5A2.25 2.25 0 0 0 3.25 15h11.5A2.25 2.25 0 0 0 17 12.75v-8a2.25 2.25 0 0 0-2.25-2.25H9.915a.75.75 0 0 1-.385-.107L7.742 1.321A2.25 2.25 0 0 0 6.585 1zM2.5 3.25a.75.75 0 0 1 .75-.75h3.335a.75.75 0 0 1 .385.107l1.788 1.072c.35.21.75.321 1.157.321h4.835a.75.75 0 0 1 .75.75V5h-13z"></path></svg>';

  const labelEl = document.createElement('span');
  labelEl.className = 'msg-mention-label';
  labelEl.textContent = safeText(label);

  pill.appendChild(icon);
  pill.appendChild(labelEl);
  userBody.appendChild(pill);
  return pill;
}

// ---- Tab contexts (referenced tabs as VSCode-style context) ----
// A chip strip above the composer lists the window's capturable tabs; toggled
// chips ride along with the next message as a compact manifest + excerpt
// (refs T1…Tn). `@` in the composer is a keyboard shortcut to toggle the same
// chips. Full content is pulled on demand via Zo's read_tab action (the
// background chains the follow-up inside the stream).

const tabRefsEnabled = new Set(); // tabIds currently referenced
let openTabs = [];                // last GET_OPEN_TABS result (recency order)
let openTabsQuerySeq = 0;         // latest-issued query owns the strip (stale
                                  // responses must not overwrite fresher ones)
let tabStripCollapsed = false;

function initTabStrip() {
  if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return;
  const collapseBtn = document.getElementById('tab-strip-collapse');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      tabStripCollapsed = !tabStripCollapsed;
      const caret = collapseBtn.querySelector('.tab-strip-caret');
      if (caret) caret.textContent = tabStripCollapsed ? '▸' : '▾';
      renderTabStrip();
    });
  }
  refreshOpenTabs();
  // Keep the strip fresh when the user refocuses the panel.
  window.addEventListener('focus', refreshOpenTabs);
  // Track browser-tab switches: adopt the newly active tab for DISPLAY (page
  // bar + strip + inspector). Scoped to this panel's window — another
  // window's tab switch must not repaint our page. No capture happens here
  // (no debugger banner); the real Mode-tier capture is per send.
  if (chrome.tabs?.onActivated) {
    chrome.tabs.onActivated.addListener(async (info) => {
      try {
        const win = await chrome.windows.getCurrent();
        if (win && info.windowId !== win.id) return;
      } catch { /* fall through — adopt anyway */ }
      adoptActiveTabDisplay(info.tabId);
    });
  }
}

async function refreshOpenTabs() {
  const seq = ++openTabsQuerySeq;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_OPEN_TABS' });
    // A newer query (e.g. openAllLinks' own refresh, issued after all tabs
    // were created) must win — an earlier trigger's late response would
    // otherwise repaint the strip from a pre-creation snapshot.
    if (seq !== openTabsQuerySeq) return;
    openTabs = (resp && Array.isArray(resp.tabs)) ? resp.tabs : [];
    // Drop toggles for tabs that no longer exist — in the active set AND in
    // every chat's stashed set.
    const live = new Set(openTabs.map((t) => t.tabId));
    for (const id of [...tabRefsEnabled]) {
      if (!live.has(id)) tabRefsEnabled.delete(id);
    }
    for (const set of chatTabRefs.values()) {
      for (const id of [...set]) {
        if (!live.has(id)) set.delete(id);
      }
    }
    renderTabStrip();
  } catch { /* background unavailable — keep last render */ }
}

function renderTabStrip() {
  const wrap = document.getElementById('tab-contexts');
  const strip = document.getElementById('tab-strip');
  const countEl = document.getElementById('tab-strip-count');
  if (!wrap || !strip) return;
  if (!openTabs.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  if (countEl) countEl.textContent = `(${tabRefsEnabled.size}/${openTabs.length})`;

  strip.replaceChildren();
  strip.classList.toggle('collapsed', tabStripCollapsed);
  if (tabStripCollapsed) return;

  for (const t of openTabs) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tab-chip' + (tabRefsEnabled.has(t.tabId) ? ' tab-chip-on' : '');
    const label = safeText(t.host || t.title || t.url).slice(0, 24);
    chip.textContent = (t.active ? '◈ ' : '') + label;
    chip.title = safeText(t.title || t.url) + (t.active ? ' — this tab' : '') +
      (tabRefsEnabled.has(t.tabId) ? ' — referenced (click to remove)' : ' — click to reference as context');
    chip.setAttribute('aria-pressed', String(tabRefsEnabled.has(t.tabId)));
    chip.addEventListener('click', () => {
      toggleTabRef(t.tabId);
    });
    strip.appendChild(chip);
  }
}

function toggleTabRef(tabId) {
  if (tabRefsEnabled.has(tabId)) tabRefsEnabled.delete(tabId);
  else tabRefsEnabled.add(tabId);
  renderTabStrip();
  closeTabAutocomplete();
  renderPromptInspector();
}

/** Mention pills for a sent message's referenced tabs (re-render from history). */
function renderTabRefPills(userMsgEl, tabRefs) {
  const userBody = userMsgEl && userMsgEl.querySelector ? userMsgEl.querySelector('.msg-body') : null;
  if (!userBody) return;
  for (const tr of (tabRefs || [])) {
    appendMentionPill(userBody, safeText(tr && (tr.host || tr.title) || (tr && tr.ref) || ''));
  }
}

/** Stash the active chat's tab-context toggles (before switching chats). */
function stashTabRefs() {
  if (activeId) chatTabRefs.set(activeId, new Set(tabRefsEnabled));
}

/** Load the active chat's toggles into the strip (after switching chats). */
function restoreTabRefs() {
  const saved = activeId ? chatTabRefs.get(activeId) : null;
  tabRefsEnabled.clear();
  if (saved) for (const id of saved) tabRefsEnabled.add(id);
  renderTabStrip();
  renderPromptInspector();
}

/**
 * Inspector preview: synthesized TabContexts from the current toggle state
 * (openTabs metadata; no capture). The real send replaces these with fresh
 * captures (stats + excerpt) — refs and ordering match, so the preview shows
 * the exact manifest structure that will go out. `includeActive` mirrors
 * sendQuery's tier-0 auto-reference (active tab as T1, not toggled).
 */
function previewTabContexts({ includeActive = false } = {}) {
  const picked = openTabs.filter((t) => tabRefsEnabled.has(t.tabId));
  let autoActive = null;
  if (includeActive) {
    autoActive = openTabs.find((t) => t.active && t.tabId === (currentContext && currentContext.tabId))
      || openTabs.find((t) => t.active)
      || null;
    if (autoActive && tabRefsEnabled.has(autoActive.tabId)) autoActive = null; // already referenced
  }
  const list = [...(autoActive ? [autoActive] : []), ...picked];
  if (!list.length) return [];
  // Mirror the send path's send-once excerpt dedup so the preview shows the
  // same "already provided above" pointer lines the real prompt will carry
  // (tabContentKey is url|title — both available here).
  const thinned = thinTabExcerpts(list, contextState && contextState.tabManifestSent);
  return assignRefs(thinned.contexts.map((t) => ({
    tabId: t.tabId,
    title: t.title || '',
    url: t.url || '',
    host: t.host || '',
    textLength: 0,
    elementCount: 0,
    excerpt: '',
    isActive: !!t.active,
    available: true,
    ...(t.pointerOnly ? { pointerOnly: true } : {}),
  })));
}

/**
 * Fetch fresh TabContexts for every referenced tab (called per send — excerpts
 * are always fresh). Returns { tabContexts, dropped } where dropped are tabs
 * that closed since they were toggled (they never reach the manifest).
 */
async function fetchTabContextsForSend() {
  if (!tabRefsEnabled.size) return { tabContexts: [], dropped: [] };
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'GET_TAB_CONTEXTS', tabIds: [...tabRefsEnabled], activeTabId: currentContext?.tabId ?? null });
  } catch { /* fall through with empty */ }
  const tabs = (resp && Array.isArray(resp.tabs)) ? resp.tabs : [];
  const dropped = tabs.filter((t) => !t.url); // no url → tab closed (chrome.tabs.get threw)
  const alive = tabs.filter((t) => t.url);
  // Recency order (openTabs) decides ref numbering T1…Tn, matching the strip.
  const order = new Map(openTabs.map((t, i) => [t.tabId, i]));
  alive.sort((a, b) => (order.get(a.tabId) ?? 999) - (order.get(b.tabId) ?? 999));
  return { tabContexts: assignRefs(alive), dropped };
}

/**
 * One tab's TabContext (banner-free content-script capture) — used to
 * auto-reference the ACTIVE browser tab on tier-0 turns. Null when the
 * capture fails or the tab is gone.
 */
async function fetchTabContext(tabId) {
  if (tabId == null) return null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_TAB_CONTEXTS', tabIds: [tabId], activeTabId: tabId });
    const t = resp && Array.isArray(resp.tabs) ? resp.tabs[0] : null;
    return t && t.url ? t : null;
  } catch {
    return null;
  }
}

// -- `@` autocomplete: a keyboard path to toggle chips. Typing `@query` opens
// the same tab list; selecting toggles the chip and swallows the typed token.

let tabAcItems = [];
let tabAcIndex = 0;

function closeTabAutocomplete() {
  const popup = document.getElementById('tab-autocomplete');
  if (popup) popup.classList.add('hidden');
  tabAcItems = [];
  tabAcIndex = 0;
}

function renderTabAutocomplete(filterText) {
  const popup = document.getElementById('tab-autocomplete');
  if (!popup) return;
  const q = (filterText || '').toLowerCase();
  tabAcItems = openTabs.filter((t) => {
    const hay = `${t.title || ''} ${t.host || ''} ${t.url || ''}`.toLowerCase();
    return !q || hay.includes(q);
  });
  if (!tabAcItems.length) { closeTabAutocomplete(); return; }
  tabAcIndex = 0;
  popup.replaceChildren();
  tabAcItems.forEach((t, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tab-ac-item' + (i === tabAcIndex ? ' tab-ac-active' : '');
    item.textContent = (t.active ? '◈ ' : '') + safeText(t.host || t.title || t.url).slice(0, 30);
    item.title = safeText(t.title || t.url);
    item.addEventListener('mousedown', (e) => { e.preventDefault(); selectTabAutocomplete(i); });
    popup.appendChild(item);
  });
  popup.classList.remove('hidden');
}

function selectTabAutocomplete(i) {
  const t = tabAcItems[i];
  if (!t) return;
  // Swallow the typed `@…` token (from the token start through the caret).
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = before.match(/(^|\s)@(\S*)$/);
  if (m) {
    const start = before.length - m[0].length + m[1].length;
    const end = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, start) + input.value.slice(end);
    input.focus();
  }
  toggleTabRef(t.tabId);
  closeTabAutocomplete();
  syncSendBtn();
}

function onComposerInputForTabs() {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = before.match(/(^|\s)@(\S*)$/);
  if (m) renderTabAutocomplete(m[2]);
  else closeTabAutocomplete();
}

function onComposerKeydownForTabs(e) {
  const popup = document.getElementById('tab-autocomplete');
  if (!popup || popup.classList.contains('hidden') || !tabAcItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    tabAcIndex = (tabAcIndex + (e.key === 'ArrowDown' ? 1 : tabAcItems.length - 1)) % tabAcItems.length;
    popup.querySelectorAll('.tab-ac-item').forEach((el, i) => el.classList.toggle('tab-ac-active', i === tabAcIndex));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    selectTabAutocomplete(tabAcIndex);
  } else if (e.key === 'Escape') {
    closeTabAutocomplete();
  }
}

// ---- Composer reference pickers (#28): `/` skills + `%` workspace files ----
// Same interaction model as the `@` tab autocomplete: typing the trigger char
// at a token start opens a popup above the composer; Enter/Tab/click selects;
// selection attaches a chip for the NEXT turn only (send-once — skills are an
// invocation, files a reference). Skills are enumerated from the Zo workspace
// Skills folder over MCP (LIST_SKILLS); files browse /home/workspace via
// `ls -1F` (LIST_WORKSPACE_DIR). Directory rows navigate; `..` climbs (never
// above the workspace root).

let skillsCache = null;        // { list: SkillEntry[], fetchedAt } — panel lifetime
let skillsFetchInFlight = null;
const pickedSkills = [];       // chips armed for the next send
const pickedFiles = [];
let filesDir = { path: WORKSPACE_ROOT, entries: null, loading: false };

const skillAc = { items: [], index: 0 };
const fileAc = { items: [], index: 0 };

const SKILLS_PANEL_TTL_MS = 5 * 60 * 1000;

function closeSkillPopup() {
  const popup = document.getElementById('skill-autocomplete');
  if (popup) popup.classList.add('hidden');
  skillAc.items = [];
  skillAc.index = 0;
}

function closeFilePopup() {
  const popup = document.getElementById('file-autocomplete');
  if (popup) popup.classList.add('hidden');
  fileAc.items = [];
  fileAc.index = 0;
}

function closeAllPickerPopups() {
  closeSkillPopup();
  closeFilePopup();
}

async function ensureSkillsLoaded(force = false) {
  const fresh = skillsCache && (Date.now() - skillsCache.fetchedAt) < SKILLS_PANEL_TTL_MS;
  if ((skillsCache && fresh) && !force) return skillsCache.list;
  if (skillsFetchInFlight) return skillsFetchInFlight;
  skillsFetchInFlight = (async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'LIST_SKILLS' });
      if (resp && resp.ok && Array.isArray(resp.skills)) {
        skillsCache = { list: resp.skills, fetchedAt: Date.now() };
        return resp.skills;
      }
      return null; // error rendered by the popup, not a thrown crash
    } catch {
      return null;
    } finally {
      skillsFetchInFlight = null;
    }
  })();
  return skillsFetchInFlight;
}

function renderSkillPopup(filterText) {
  const popup = document.getElementById('skill-autocomplete');
  if (!popup) return;
  const list = skillsCache ? skillsCache.list : null;
  if (!list) {
    popup.replaceChildren();
    popup.appendChild(pickerNoteItem(skillsFetchInFlight ? 'Loading skills…' : 'Skills unavailable — check your Zo token.'));
    popup.classList.remove('hidden');
    skillAc.items = [];
    return;
  }
  const items = filterPickerEntries(list, filterText);
  if (!items.length) { closeSkillPopup(); return; }
  skillAc.items = items;
  skillAc.index = 0;
  popup.replaceChildren();
  items.slice(0, 8).forEach((s, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'picker-item' + (i === 0 ? ' picker-item-active' : '');
    const name = document.createElement('span');
    name.className = 'picker-item-name';
    name.textContent = `⚡ ${s.name}`;
    item.appendChild(name);
    const desc = String(s.description || '').slice(0, 120);
    if (desc) {
      const d = document.createElement('span');
      d.className = 'picker-item-desc';
      d.textContent = desc;
      item.appendChild(d);
    }
    item.title = `${s.name}\n${s.description || ''}`;
    item.addEventListener('mousedown', (e) => { e.preventDefault(); selectSkill(i); });
    popup.appendChild(item);
  });
  popup.classList.remove('hidden');
}

function selectSkill(i) {
  const s = skillAc.items[i];
  if (!s) return;
  if (!pickedSkills.some((p) => p.id === s.id)) pickedSkills.push({ id: s.id, name: s.name, description: s.description });
  swallowTriggerToken('/');
  closeSkillPopup();
  renderPickerChips();
  syncSendBtn();
  renderPromptInspector();
}

async function loadFilesDir(path) {
  filesDir = { path, entries: null, loading: true };
  renderFilePopup('', true);
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'LIST_WORKSPACE_DIR', path });
    if (resp && resp.ok && resp.path === path && Array.isArray(resp.entries)) {
      filesDir = { path, entries: resp.entries, loading: false };
    } else {
      filesDir = { path, entries: null, loading: false, error: (resp && resp.error) || 'Directory unavailable.' };
    }
  } catch {
    filesDir = { path, entries: null, loading: false, error: 'Background unavailable.' };
  }
  renderFilePopup('', true);
}

function renderFilePopup(filterText, keepFilter) {
  const popup = document.getElementById('file-autocomplete');
  if (!popup) return;
  popup.replaceChildren();
  const header = document.createElement('div');
  header.className = 'picker-item picker-item-note';
  header.textContent = `📄 ${filesDir.path}`;
  popup.appendChild(header);
  if (filesDir.loading) {
    popup.appendChild(pickerNoteItem('Loading…'));
    popup.classList.remove('hidden');
    fileAc.items = [];
    return;
  }
  if (!filesDir.entries) {
    popup.appendChild(pickerNoteItem(filesDir.error || 'Directory unavailable.'));
    popup.classList.remove('hidden');
    fileAc.items = [];
    return;
  }
  const rows = [];
  if (filesDir.path !== WORKSPACE_ROOT) rows.push({ name: '..', path: parentOf(filesDir.path), kind: 'up' });
  for (const e of filesDir.entries) rows.push(e);
  const filter = keepFilter ? '' : filterText;
  const items = filterPickerEntries(rows, filter);
  if (!items.length) { popup.appendChild(pickerNoteItem('No matches.')); popup.classList.remove('hidden'); fileAc.items = []; return; }
  fileAc.items = items;
  fileAc.index = 0;
  items.slice(0, 8).forEach((e, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'picker-item' + (i === 0 ? ' picker-item-active' : '');
    const name = document.createElement('span');
    name.className = 'picker-item-name';
    name.textContent = e.kind === 'dir' ? `📂 ${e.name}/` : e.kind === 'up' ? '⬆ ..' : `📄 ${e.name}`;
    item.appendChild(name);
    const sub = document.createElement('span');
    sub.className = 'picker-item-desc';
    sub.textContent = e.path || e.name;
    item.appendChild(sub);
    item.addEventListener('mousedown', (ev) => { ev.preventDefault(); selectFileRow(i); });
    popup.appendChild(item);
  });
  popup.classList.remove('hidden');
}

function selectFileRow(i) {
  const e = fileAc.items[i];
  if (!e) return;
  if (e.kind === 'up' || e.kind === 'dir') {
    // Navigate; keep the `%` token so the user keeps filtering as they browse.
    loadFilesDir(e.path);
    return;
  }
  if (!pickedFiles.some((p) => p.path === e.path)) pickedFiles.push({ path: e.path });
  swallowTriggerToken('%');
  closeFilePopup();
  renderPickerChips();
  syncSendBtn();
  renderPromptInspector();
}

function pickerNoteItem(text) {
  const note = document.createElement('div');
  note.className = 'picker-item picker-item-note';
  note.textContent = text;
  return note;
}

function parentOf(path) {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? WORKSPACE_ROOT : path.slice(0, idx);
}

/** Remove the typed `/…` or `%…` token (trigger char through the caret). */
function swallowTriggerToken(trigger) {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const re = new RegExp(`(^|\\s)\\${trigger}(\\S*)$`);
  const m = before.match(re);
  if (m) {
    const start = before.length - m[0].length + m[1].length;
    const end = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, start) + input.value.slice(end);
    input.focus();
  }
}

function onComposerInputForPickers() {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const slash = before.match(/(^|\s)\/(\S*)$/);
  const pct = before.match(/(^|\s)%(\S*)$/);
  if (slash) {
    closeFilePopup();
    ensureSkillsLoaded().then(() => renderSkillPopup(slash[2]));
    renderSkillPopup(slash[2]); // immediate render from cache (or loading note)
  } else if (pct) {
    closeSkillPopup();
    // First open (or after an error): fetch the current directory's listing.
    if (!filesDir.entries && !filesDir.loading) loadFilesDir(filesDir.path);
    renderFilePopup(pct[2]);
  } else {
    closeSkillPopup();
    closeFilePopup();
  }
}

function onComposerKeydownForPickers(e) {
  const skillPopup = document.getElementById('skill-autocomplete');
  const filePopup = document.getElementById('file-autocomplete');
  const inSkill = skillPopup && !skillPopup.classList.contains('hidden') && skillAc.items.length;
  const inFile = filePopup && !filePopup.classList.contains('hidden') && fileAc.items.length;
  if (!inSkill && !inFile) return;
  const ac = inSkill ? skillAc : fileAc;
  const popup = inSkill ? skillPopup : filePopup;
  const select = inSkill ? selectSkill : selectFileRow;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : ac.items.length - 1)) % ac.items.length;
    const buttons = [...popup.querySelectorAll('button.picker-item')];
    buttons.forEach((el, i) => el.classList.toggle('picker-item-active', i === ac.index));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    select(ac.index);
  } else if (e.key === 'Escape') {
    closeAllPickerPopups();
  }
}

/** Chips armed for the next turn (send-once): ⚡ skill invocations + 📄 file refs. */
function renderPickerChips() {
  const wrap = document.getElementById('picker-chips');
  if (!wrap) return;
  wrap.replaceChildren();
  if (!pickedSkills.length && !pickedFiles.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  const addChip = (label, title, onRemove) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'picker-chip';
    const text = document.createElement('span');
    text.textContent = label;
    const x = document.createElement('span');
    x.className = 'picker-chip-x';
    x.textContent = '✕';
    chip.appendChild(text);
    chip.appendChild(x);
    chip.title = title;
    chip.addEventListener('click', onRemove);
    wrap.appendChild(chip);
  };
  for (const s of pickedSkills) {
    addChip(`⚡ ${s.name}`, `${s.description || s.name} — runs on the next send`, () => {
      const idx = pickedSkills.indexOf(s);
      if (idx !== -1) pickedSkills.splice(idx, 1);
      renderPickerChips();
      renderPromptInspector();
    });
  }
  for (const f of pickedFiles) {
    addChip(`📄 ${f.path.split('/').pop()}`, `${f.path} — attached to the next send`, () => {
      const idx = pickedFiles.indexOf(f);
      if (idx !== -1) pickedFiles.splice(idx, 1);
      renderPickerChips();
      renderPromptInspector();
    });
  }
}

// Collapsible "💭 Thinking" bubble rendered above an assistant message body,
// showing the reasoning field Zo returns alongside its actions. No-ops on
// empty reasoning so non-reasoning modes (ask/visual) are unaffected.
// Collapsed by default; click the header to expand.
/**
 * Derive a short, plain-text summary of a reasoning string for the collapsed
 * 💭 Thought bubble header (matches zo.computer, which shows e.g.
 * "Inspecting site responsiveness issues" rather than a char count).
 *
 * First sentence wins; otherwise the first ~80 chars. Markdown markers
 * (#, *, `, >, -, leading list bullets) are stripped so the preview reads as
 * prose. Pure (no DOM deps) so it's unit-testable directly.
 *
 * @param {string} text
 * @param {number} [max=80]
 * @returns {string}
 */
function reasoningSummary(text, max = 80) {
  const raw = safeText(text);
  if (!raw || !raw.trim()) return '';
  // Strip markdown structural markers so the preview reads as prose.
  const cleaned = raw
    .replace(/^#{1,6}\s+/gm, '')      // headings
    .replace(/^\s*[-*+]\s+/gm, '')    // list bullets
    .replace(/^\s*>\s?/gm, '')        // blockquotes
    .replace(/`{1,3}/g, '')           // inline/code fences
    .replace(/\*\*?([^*]+)\*\*?/g, '$1') // bold
    .replace(/__?([^_]+)__?/g, '$1')     // bold/italic _
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → text
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  // First sentence (terminated by . ! ?) if it fits; else truncate.
  const sentenceEnd = cleaned.search(/[.!?]\s/);
  let summary;
  if (sentenceEnd !== -1 && sentenceEnd + 1 <= max) {
    summary = cleaned.slice(0, sentenceEnd + 1).trim();
  } else {
    summary = cleaned.slice(0, max).trim();
    if (cleaned.length > max) summary += '…';
  }
  return summary;
}

// Inline reasoning, rendered above the assistant answer (Zo model).
// Zo surfaces the model's thinking as prose interleaved with the work,
// not a separate bubble. We mirror that:
//   - short reasoning (<= INLINE_REASONING_MAX chars, single line) renders
//     inline as muted prose directly above the answer — no collapse;
//   - longer reasoning collapses into a "💭 Thought" trace header (like
//     Zo's "Response interrupted — retried ▸" pattern) that expands to
//     the full reasoning.
// No-ops on empty reasoning so non-reasoning modes (ask/visual) are
// unaffected. Idempotent: skips if a reasoning block is already present.
const INLINE_REASONING_MAX = 120;

function addReasoningBubble(parentMsgEl, reasoning, inlineMax = INLINE_REASONING_MAX) {
  if (!parentMsgEl) return;
  const text = safeText(reasoning);
  if (!text || !text.trim()) return;

  // Don't add a duplicate (e.g. on re-render from history)
  if (parentMsgEl.querySelector('.msg-reasoning')) return;

  const isInline = text.length <= inlineMax && !text.includes('\n');

  const block = document.createElement('div');
  block.className = isInline ? 'msg-reasoning msg-reasoning-inline' : 'msg-reasoning';

  if (isInline) {
    // Inline muted prose, no collapse.
    block.innerHTML = markdownToHtml(text);
  } else {
    // Collapsible trace header.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'reasoning-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Show reasoning');
    const caret = document.createElement('span');
    caret.className = 'reasoning-caret';
    caret.textContent = '▸';
    const label = document.createElement('span');
    label.className = 'reasoning-label';
    label.textContent = '💭 Thought';
    toggle.appendChild(caret);
    toggle.appendChild(label);
    // Collapsed preview: a one-line gist of the reasoning.
    const summary = reasoningSummary(text);
    if (summary) {
      const summaryEl = document.createElement('span');
      summaryEl.className = 'reasoning-summary';
      summaryEl.textContent = `— ${summary}`;
      toggle.appendChild(summaryEl);
    }

    const content = document.createElement('div');
    content.className = 'reasoning-content';
    content.hidden = true;
    content.innerHTML = markdownToHtml(text);

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      toggle.setAttribute('aria-label', expanded ? 'Show reasoning' : 'Hide reasoning');
      caret.textContent = expanded ? '▸' : '▾';
      content.hidden = expanded;
    });

    block.appendChild(toggle);
    block.appendChild(content);
  }

  // Insert above the message body so it reads: reasoning → answer
  const body = parentMsgEl.querySelector('.msg-body');
  if (body) {
    parentMsgEl.insertBefore(block, body);
  } else {
    parentMsgEl.insertBefore(block, parentMsgEl.firstChild);
  }
}

// Render persisted explored tools (from history) as a static 🔍 Explored
// region above the answer body. Mirrors the live STREAM_TOOL cards but is
// non-interactive (cards are already resolved with their outcome).
function addExploredRegion(parentMsgEl, tools) {
  if (!parentMsgEl) return;
  if (!Array.isArray(tools) || !tools.length) return;
  if (parentMsgEl.querySelector('.msg-explored')) return; // idempotent
  const block = document.createElement('div');
  block.className = 'msg-explored msg-explored-static';
  const label = document.createElement('div');
  label.className = 'msg-explored-label';
  label.textContent = '🔍 Explored';
  const list = document.createElement('div');
  list.className = 'msg-explored-list';
  for (const t of tools) {
    const card = document.createElement('div');
    card.className = 'msg-tool-card ' + (t.outcome === 'error' ? 'msg-tool-error' : 'msg-tool-done');
    const head = document.createElement('div');
    head.className = 'msg-tool-head';
    const icon = document.createElement('span');
    icon.className = 'msg-tool-icon';
    icon.textContent = t.outcome === 'error' ? '✗' : '✓';
    const name = document.createElement('span');
    name.className = 'msg-tool-name';
    name.textContent = safeText(t.toolName) || 'tool';
    head.appendChild(icon);
    head.appendChild(name);
    card.appendChild(head);
    const result = safeText(t.result);
    if (result) {
      const details = document.createElement('details');
      details.className = 'msg-tool-result';
      const summary = document.createElement('summary');
      summary.textContent = 'result';
      const pre = document.createElement('div');
      pre.className = 'msg-tool-result-body';
      pre.textContent = result;
      details.appendChild(summary);
      details.appendChild(pre);
      card.appendChild(details);
    }
    list.appendChild(card);
  }
  block.appendChild(label);
  block.appendChild(list);
  const body = parentMsgEl.querySelector('.msg-body');
  if (body) parentMsgEl.insertBefore(block, body);
  else parentMsgEl.appendChild(block);
}

// ---- Link chips + "Open all (N)" (research answers → tabs, backlog #27) ----

/**
 * Open every URL: first tab foreground, rest background. The opened tabs
 * become reference chips for the ACTIVE chat (chip strip + @-mention +
 * read_tab follow-ups — the #27 synergy). Single failures never stop the rest.
 */
async function openAllLinks(links) {
  const urls = (links || []).map((l) => l && l.url).filter(Boolean);
  if (!urls.length) return;
  const openedIds = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const tab = await chrome.tabs.create({ url: urls[i], active: i === 0 });
      if (tab && tab.id != null) openedIds.push(tab.id);
    } catch { /* individual open failure — keep going */ }
  }
  if (!openedIds.length) return;
  for (const id of openedIds) tabRefsEnabled.add(id);
  if (activeId) chatTabRefs.set(activeId, new Set(tabRefsEnabled));
  refreshOpenTabs();
  renderTabStrip();
  renderPromptInspector();
}

/**
 * Attach the link-chips card to an assistant message: one chip per URL
 * (label = host, click opens foreground) + an "Open all (N)" button. Only
 * rendered for ≥2 unique URLs (a single link is already clickable in the
 * rendered markdown). Idempotent — safe on history re-render.
 */
function addLinkChipsCard(parentMsgEl, links) {
  if (!parentMsgEl) return null;
  const list = (links || []).filter((l) => l && typeof l === 'object' && typeof l.url === 'string');
  if (list.length < 2) return null;
  if (parentMsgEl.querySelector('.msg-links')) return null; // idempotent
  const shown = list.slice(0, MAX_LINK_CHIPS);
  const hiddenCount = list.length - shown.length;

  const card = document.createElement('div');
  card.className = 'msg-links';
  const head = document.createElement('div');
  head.className = 'msg-links-head';
  head.textContent = `🔗 ${list.length} link${list.length === 1 ? '' : 's'}`;
  card.appendChild(head);

  const chips = document.createElement('div');
  chips.className = 'msg-links-chips';
  for (const l of shown) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'msg-link-chip';
    chip.textContent = safeText(l.host || l.url);
    chip.title = safeText(l.url);
    chip.addEventListener('click', () => {
      chrome.tabs.create({ url: l.url, active: true });
    });
    chips.appendChild(chip);
  }
  if (hiddenCount > 0) {
    const more = document.createElement('span');
    more.className = 'msg-links-more';
    more.textContent = `+${hiddenCount} more`;
    chips.appendChild(more);
  }
  card.appendChild(chips);

  const openAll = document.createElement('button');
  openAll.type = 'button';
  openAll.className = 'msg-links-open-all';
  openAll.textContent = `Open all (${shown.length})`;
  openAll.addEventListener('click', () => openAllLinks(shown));
  card.appendChild(openAll);

  parentMsgEl.appendChild(card);
  return card;
}

// ---- Presets ----

async function loadModes() {
  // One-time migration: legacy 'cobrowse_presets' → 'cobrowse_modes'.
  const both = await chrome.storage.local.get([STORAGE_MODES_KEY, STORAGE_LEGACY_PRESETS_KEY]);
  if (!both[STORAGE_MODES_KEY] && both[STORAGE_LEGACY_PRESETS_KEY]) {
    const migrated = {};
    for (const [id, preset] of Object.entries(both[STORAGE_LEGACY_PRESETS_KEY])) {
      // Map legacy preset ids to new Mode ids where they diverge.
      let modeId = id;
      if (modeId === 'scrape') modeId = 'extract';
      else if (modeId === 'qa') modeId = 'ask';
      migrated[modeId] = presetToMode({ ...preset, id: modeId });
    }
    customModes = migrated;
    await chrome.storage.local.set({ [STORAGE_MODES_KEY]: customModes });
  } else {
    customModes = both[STORAGE_MODES_KEY] || {};
  }
  // Load per-built-in overrides (Settings editor). Hot-reload when Settings saves.
  const ov = await chrome.storage.local.get(STORAGE_OVERRIDES_KEY);
  modeOverrides = (ov && ov[STORAGE_OVERRIDES_KEY]) || {};
  rebuildModeOptions();

  // Restore last used Mode. Migrate legacy 'zoActivePreset' → 'zoActiveMode'.
  const activeKeys = await chrome.storage.local.get(['zoActivePreset']);
  const activeModeSaved = await chrome.storage.sync.get(['zoActiveMode']);
  let restored = activeModeSaved.zoActiveMode || activeKeys.zoActivePreset;
  if (restored === 'scrape') restored = 'extract';
  else if (restored === 'qa') restored = 'ask';
  activeModeId = restored || DEFAULT_MODE_ID;
  syncModeSelect();
}

async function saveCustomModes() {
  await chrome.storage.local.set({ [STORAGE_MODES_KEY]: customModes });
}

function applyMode() {
  const id = modeSelect.value || DEFAULT_MODE_ID;
  const mode = resolveMode(id, customModes);
  activeModeId = id;
  chrome.storage.sync.set({ zoActiveMode: id });
  rebuildModeOptions();
  syncModeSelect();
  const desc = mode.description ? ` ${mode.description}` : '';
  addSystemMessage(`🔄 **${mode.icon} ${mode.name}** mode active.${desc}`);
  renderPromptInspector();
  // #25: Visual mode (tier 3) needs a vision-capable model. If the
  // selected model is known to not support images, suggest one that does.
  if (mode.contextTier >= 3 && config.selectedModel) {
    checkVisionModelSuggestion();
  }
}

/**
 * #25 — fetch the no-auth model catalog and, if the selected model can't
 * process images, surface a suggestion (or a warning when no vision model
 * exists in the catalog). Non-fatal: catalog unavailable = no suggestion.
 */
async function checkVisionModelSuggestion() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_VISION_CATALOG' });
    if (!resp?.success || !Array.isArray(resp.models) || resp.models.length === 0) return;
    const suggestion = visionModelSuggestion(resp.models, config.selectedModel);
    if (!suggestion) return;
    if (suggestion.kind === 'suggest') {
      addSystemMessage(
        `⚠️ **Visual mode needs a vision model.** ${suggestion.reason} ` +
        `Switch to **${suggestion.suggestedLabel}** in the model dropdown, or screenshots will be skipped.`
      );
    } else {
      addSystemMessage(
        `⚠️ **Visual mode needs a vision model.** ${suggestion.reason} ` +
        `Screenshots will be skipped until a vision-capable model is selected.`
      );
    }
  } catch (e) {
    console.debug('checkVisionModelSuggestion:', e.message);
  }
}

function rebuildModeOptions() {
  if (!modeSelect) return;
  const currentVal = activeModeId;

  modeSelect.innerHTML = '';
  for (const [id, m] of Object.entries(BUILTIN_MODES)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${m.icon} ${m.name}`;
    modeSelect.appendChild(opt);
  }

  // Separator + custom Modes
  const customIds = Object.keys(customModes);
  if (customIds.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '⎯ Custom ⎯';
    modeSelect.appendChild(sep);
    for (const [id, m] of Object.entries(customModes)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${m.icon || '✨'} ${m.name}`;
      opt.title = m.description || '';
      modeSelect.appendChild(opt);
    }
  }

  if (currentVal) modeSelect.value = currentVal;
}

async function startModeCreation() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:999;';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;width:280px;">
      <h3 style="font-size:14px;margin:0 0 8px;color:var(--text);">Create Mode with Zo</h3>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px;">Describe what you want this Mode to do:</p>
      <textarea id="mode-desc-input" style="width:100%;height:80px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px;font-size:13px;resize:none;font-family:var(--font);" placeholder="e.g. Extract all product prices and availability from shopping pages"></textarea>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button id="generate-mode-confirm" class="btn btn-primary btn-sm" style="flex:1;">Generate ✨</button>
        <button id="generate-mode-cancel" class="btn btn-sm">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const descInput = overlay.querySelector('#mode-desc-input');
  descInput.focus();

  overlay.querySelector('#generate-mode-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#generate-mode-confirm').addEventListener('click', async () => {
    const desc = descInput.value.trim();
    if (!desc) return;
    overlay.remove();

    addSystemMessage(`🤖 Generating Mode for: "${desc}"...`);
    const resp = await chrome.runtime.sendMessage({
      type: 'GENERATE_MODE',
      description: desc,
    });

    // Remove the generating message
    const msgs = msgsEl.querySelectorAll('.msg-system');
    if (msgs.length > 0) msgs[msgs.length - 1].remove();

    if (resp.error) {
      addSystemMessage(`❌ Failed to create Mode: ${resp.error}`);
      return;
    }

    const mode = resp.mode;
    if (!mode || !mode.name || !mode.systemPrompt) {
      addSystemMessage('❌ Zo returned an incomplete Mode. Try again with a more specific description.');
      return;
    }

    const id = 'custom_' + Date.now();
    customModes[id] = { ...mode, id, builtin: false };
    await saveCustomModes();
    rebuildModeOptions();

    // Select the new Mode
    activeModeId = id;
    syncModeSelect();
    chrome.storage.sync.set({ zoActiveMode: id });
    addSystemMessage(`✅ Custom Mode **${mode.name}** created and activated.`);
  });
}

function addSystemMessage(text) {
  // Route through addMessageDOM: HTML-escapes, parses markdown (so **bold**
  // renders), and uses appendChild instead of `innerHTML +=` which thrashed
  // the whole tree and destroyed existing TTS-button listeners.
  addMessageDOM('system', text);
}

async function loadQuickActions() {
  const result = await chrome.storage.sync.get(STORAGE_ACTIONS_KEY);
  const actions = result[STORAGE_ACTIONS_KEY];
  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    // First run — seed defaults
    await chrome.storage.sync.set({ [STORAGE_ACTIONS_KEY]: DEFAULT_QUICK_ACTIONS });
    renderQuickActions(DEFAULT_QUICK_ACTIONS);
  } else {
    renderQuickActions(actions);
  }
}

function renderQuickActions(actions) {
  const container = $('#action-chips');
  if (!container) return;
  container.innerHTML = '';
  for (const a of actions) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = a.label;
    chip.title = a.prompt;
    container.appendChild(chip);
  }
}

// ---- STT (Speech-to-Text) ----

function startRecording() {
  if (isRecording) { stopRecording(); return; }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    addMessageDOM('error', 'Speech recognition not supported in this browser. Try Chrome.');
    return;
  }

  // Request microphone access first — Chrome blocks SpeechRecognition in
  // extension pages without an explicit getUserMedia grant. Once the user
  // approves, start recognition.
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      // Stop the stream immediately — we only needed the permission prompt
      stream.getTracks().forEach(t => t.stop());

      try {
        recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = sttLang;

        recognition.onresult = (event) => {
          let final = '';
          sttInterim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              final += event.results[i][0].transcript;
            } else {
              sttInterim += event.results[i][0].transcript;
            }
          }
          if (final) {
            input.value = (input.value + ' ' + final).trim();
          }
          // Show interim in placeholder
          if (sttInterim) {
            input.placeholder = '🎤 ' + sttInterim;
          }
        };

        recognition.onerror = (event) => {
          stopRecording();
          if (event.error !== 'no-speech' && event.error !== 'aborted') {
            addMessageDOM('error', `🎤 STT error: ${event.error}`);
          }
        };

        recognition.onend = () => {
          stopRecording();
        };

        recognition.start();
        isRecording = true;
        micBtn.classList.add('recording');
        micBtn.textContent = '🔴';
        micBtn.title = 'Stop recording';
      } catch (err) {
        addMessageDOM('error', `🎤 STT error: ${err.message}`);
      }
    })
    .catch((err) => {
      addMessageDOM('error', `🎤 Microphone access denied: ${err.message}. Grant microphone permission in Chrome settings.`);
    });
}

function stopRecording() {
  if (recognition) {
    try { recognition.stop(); } catch {}
    recognition = null;
  }
  isRecording = false;
  micBtn.classList.remove('recording');
  micBtn.textContent = '🎤';
  micBtn.title = 'Voice input (STT)';
  if (sttInterim) {
    input.value = (input.value + ' ' + sttInterim).trim();
    sttInterim = '';
  }
  input.placeholder = 'Ask Zo about this page...';
}

// ---- TTS (Text-to-Speech) ----

async function loadTtsConfig() {
  const saved = await chrome.storage.sync.get(['zoTtsAutoRead', 'zoTtsLang', 'zoTtsRate', 'zoTtsVoice']);
  ttsAutoRead = saved.zoTtsAutoRead || false;
  ttsLang = saved.zoTtsLang || 'en-US';
  ttsRate = parseFloat(saved.zoTtsRate) || 1.0;
  ttsVoice = saved.zoTtsVoice || '';
}

/** Speak text using chrome.tts (extension-native API — no autoplay restrictions). */
function speakText(text, triggerEl) {
  if (!text || !text.trim()) return;

  // If the same button is clicked while speaking, stop and return
  if (isSpeaking && triggerEl && triggerEl === currentTtsBtnEl) {
    stopSpeaking();
    return;
  }

  // If something else is speaking (e.g. auto-read), stop it and continue to speak new text
  if (isSpeaking) {
    chrome.tts.stop();
    isSpeaking = false;
    if (currentTtsBtnEl) {
      currentTtsBtnEl.textContent = '🔊';
      currentTtsBtnEl.title = 'Read aloud';
      currentTtsBtnEl.classList.remove('speaking');
      currentTtsBtnEl = null;
    }
  }

  const plain = text
    .replace(/[*_#`\[\]]/g, '')
    .replace(/\n{2,}/g, '. ')
    .trim();
  if (!plain) return;

  isSpeaking = true;
  if (triggerEl) {
    currentTtsBtnEl = triggerEl;
    triggerEl.textContent = '⏹';
    triggerEl.title = 'Stop';
    triggerEl.classList.add('speaking');
  }

  chrome.tts.speak(plain, {
    lang: ttsLang,
    rate: ttsRate,
    voiceName: ttsVoice || undefined,
    onEvent: (event) => {
      if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
        isSpeaking = false;
        if (currentTtsBtnEl) {
          currentTtsBtnEl.textContent = '🔊';
          currentTtsBtnEl.title = 'Read aloud';
          currentTtsBtnEl.classList.remove('speaking');
          currentTtsBtnEl = null;
        }
      }
    },
  });
}

function stopSpeaking() {
  chrome.tts.stop();
  isSpeaking = false;
  if (currentTtsBtnEl) {
    currentTtsBtnEl.textContent = '🔊';
    currentTtsBtnEl.title = 'Read aloud';
    currentTtsBtnEl.classList.remove('speaking');
    currentTtsBtnEl = null;
  }
}

// ---- Streaming (port-based) ----

// Declared (not bare-assigned) so the streaming override below is a valid
// reassignment in module (strict) scope. Without this declaration the bare
// `sendQuery = async function () {...}` throws ReferenceError at module
// evaluation, killing the entire side panel on load.
let sendQuery = async function () { /* replaced at the end of this file */ };

let streamPort = null;
// Chronological streaming state. Instead of grouping by channel (Thought/
// Explored/Final), we append every event in the order it arrives to the message
// body — a live feed. The final STREAM_DONE may render a collapsed reasoning
// summary bubble above the body if the user wants a compact view, but the
// full reasoning stream is always visible in chronological order.
let streamSession = { active: false, sessionId: 0, chatId: null, msgEl: null, fullText: '', reasoningText: '', remainingActions: null, startTime: 0 };

// Live "processing" timer: ticks the elapsed time on the in-flight assistant
// bubble's first line until STREAM_DONE replaces it with the real footer
// (which carries the relative timestamp + the total duration).
let streamTimerInterval = null;
function startStreamTimer(msgEl) {
  stopStreamTimer();
  if (!msgEl) return;
  let line = msgEl.querySelector('.msg-processing-timer');
  if (!line) {
    line = document.createElement('div');
    line.className = 'msg-processing-timer';
    msgEl.appendChild(line);
  }
  const tick = () => {
    const elapsed = Date.now() - streamSession.startTime;
    line.textContent = `◷ ${formatDuration(elapsed)} — processing…`;
  };
  tick();
  streamTimerInterval = setInterval(tick, 200);
}
function stopStreamTimer() {
  if (streamTimerInterval) { clearInterval(streamTimerInterval); streamTimerInterval = null; }
}

// Last user query submitted — used by the error card's Retry button.
let lastQuery = '';

// Latest STREAM_DIAGNOSTIC: the SSE event→fields map Zo emitted for the last
// stream. Kept for richer-content rendering (tool traces / sources / streaming
// reasoning); not shown to the user.
let streamShape = null;

// Re-submit the last query (used by the Retry button on the error card).
// Bypasses the empty-input guard since the value lives in the label, not the box.
async function sendQueryFromLabel(label) {
  const text = safeText(label).trim();
  if (!text) return;
  input.value = text;
  await sendQuery();
}

// Cancel the in-flight stream (Zo's "Press Esc to stop"). Disconnects the
// port, clears the session, removes any thinking indicator, and re-enables
// input so the panel is never stuck.
function cancelStream() {
  if (!streamSession.active) return;
  streamSession.active = false;
  clearThinkingTimeout();
  stopStreamTimer();
  const thinking = msgsEl?.querySelector('.msg-thinking');
  if (thinking) thinking.remove();
  if (streamPort) { try { streamPort.disconnect(); } catch {} streamPort = null; }
  streamSession.msgEl = null;
  streamSession.fullText = '';
  streamSession.reasoningText = '';
  streamSession.remainingActions = null;
  streamSession.startTime = 0;
  streamSession.chatId = null;
  if (typeof input !== 'undefined' && input) input.disabled = false;
  if (typeof sendBtn !== 'undefined' && sendBtn) { sendBtn.disabled = !input?.value?.trim(); }
  renderChatTabs();
}

function connectStreamingPort() {
  try {
    const port = chrome.runtime.connect({ name: 'cobrowse-stream' });
    port.onMessage.addListener(handleStreamMessage);
    port.onDisconnect.addListener(() => {
      // Only null if this exact port is still the active one
      // Prevents stale onDisconnect from nulling a freshly reconnected port
      if (streamPort === port) {
        // If streaming session was active, clean up the UI and re-enable
        // input so the user isn't stuck with a permanently disabled panel.
        if (streamSession.active) {
          streamSession.active = false;
          clearThinkingTimeout();
          stopStreamTimer();
          const thinking = msgsEl?.querySelector('.msg-thinking');
          if (thinking) thinking.remove();
          if (typeof input !== 'undefined' && input) input.disabled = false;
          if (typeof sendBtn !== 'undefined' && sendBtn) sendBtn.disabled = false;
        }
        streamPort = null;
      }
    });
    streamPort = port;
  } catch {
    streamPort = null;
  }
}

function handleStreamMessage(msg) {
  // Ignore stale messages from previous sessions
  if (msg.sessionId && msg.sessionId !== streamSession.sessionId) return;
  // True when this stream belongs to a chat the user has switched away from —
  // keep accumulating into streamSession, never touch the visible chat DOM.
  const streamIsBackground = () =>
    streamSession.active && !!streamSession.chatId && streamSession.chatId !== activeId;
  switch (msg.type) {
    case 'STREAM_REASONING': {
      // Live thinking channel (PartDeltaEvent part_delta_kind:"thinking").
      // Append to a collapsible reasoning container in chronological order.
      clearThinkingTimeout();
      msgsEl.querySelectorAll('.msg-reconnecting').forEach(el => el.remove());
      if (!streamSession.active) return;
      streamSession.reasoningText = safeText(msg.text);
      if (streamIsBackground()) return;
      if (!streamSession.msgEl) {
        const thinking = msgsEl.querySelector('.msg-thinking');
        if (thinking) thinking.remove();
        streamSession.msgEl = addMessageDOM('assistant', '', { streaming: true });
        startStreamTimer(streamSession.msgEl);
      }
      streamSession.reasoningText = safeText(msg.text);
      const body = streamSession.msgEl.querySelector('.msg-body');
      if (body) {
        // Lazily create a collapsible reasoning container
        let reasoningContainer = body.querySelector('.msg-stream-reasoning');
        if (!reasoningContainer) {
          reasoningContainer = document.createElement('details');
          reasoningContainer.className = 'msg-stream-reasoning';
          reasoningContainer.open = false; // Collapsed by default
          const summary = document.createElement('summary');
          summary.className = 'msg-stream-reasoning-summary';
          summary.textContent = '💭 Thought';
          reasoningContainer.appendChild(summary);
          const content = document.createElement('div');
          content.className = 'msg-stream-reasoning-content';
          reasoningContainer.appendChild(content);
          body.appendChild(reasoningContainer);
        }
        // Append the new reasoning token to the content area
        const content = reasoningContainer.querySelector('.msg-stream-reasoning-content');
        if (content) {
          const token = document.createElement('span');
          token.className = 'msg-stream-thought';
          token.textContent = safeText(msg.text);
          content.appendChild(token);
        }
      }
      break;
    }
    case 'STREAM_TOOL': {
      // Live "Explored" channel — a tool was called or returned. Append as a
      // card-like block in chronological order.
      clearThinkingTimeout();
      if (!streamSession.active) return;
      if (streamIsBackground()) return;
      if (!streamSession.msgEl) {
        const thinking = msgsEl.querySelector('.msg-thinking');
        if (thinking) thinking.remove();
        streamSession.msgEl = addMessageDOM('assistant', '', { streaming: true });
        startStreamTimer(streamSession.msgEl);
      }
      const body = streamSession.msgEl.querySelector('.msg-body');
      if (!body) break;

      if (msg.phase === 'call') {
        const card = document.createElement('div');
        card.className = 'msg-stream-tool-card';
        card.dataset.callId = safeText(msg.callId) || '';
        const head = document.createElement('div');
        head.className = 'msg-stream-tool-head';
        const icon = document.createElement('span');
        icon.className = 'msg-stream-tool-icon';
        icon.textContent = '▸';
        const name = document.createElement('span');
        name.className = 'msg-stream-tool-name';
        name.textContent = safeText(msg.toolName) || 'tool';
        head.appendChild(icon);
        head.appendChild(name);
        if (msg.args) {
          const argsEl = document.createElement('span');
          argsEl.className = 'msg-stream-tool-args';
          argsEl.textContent = msg.args.length > 120 ? msg.args.slice(0, 120) + '…' : msg.args;
          head.appendChild(argsEl);
        }
        card.appendChild(head);
        body.appendChild(card);
      } else if (msg.phase === 'result') {
        // Match the pending call card (by callId, else the last pending card).
        const callId = safeText(msg.callId);
        let card = callId ? body.querySelector(`.msg-stream-tool-card[data-call-id="${CSS.escape(callId)}"]`) : null;
        if (!card) {
          const pending = body.querySelectorAll('.msg-stream-tool-card');
          card = pending[pending.length - 1] || null;
        }
        if (card) {
          const icon = card.querySelector('.msg-stream-tool-icon');
          if (icon) icon.textContent = msg.outcome === 'error' ? '✗' : '✓';
          card.classList.remove('msg-stream-tool-pending');
          card.classList.add(msg.outcome === 'error' ? 'msg-stream-tool-error' : 'msg-stream-tool-done');
          const result = safeText(msg.result);
          if (result) {
            const details = document.createElement('details');
            details.className = 'msg-stream-tool-result';
            const summary = document.createElement('summary');
            summary.textContent = 'result';
            const pre = document.createElement('div');
            pre.className = 'msg-stream-tool-result-body';
            pre.textContent = result;
            details.appendChild(summary);
            details.appendChild(pre);
            card.appendChild(details);
          }
        }
      }
      break;
    }
    case 'STREAM_CHUNK': {
      // First real progress — cancel the thinking timeout
      clearThinkingTimeout();
      msgsEl.querySelectorAll('.msg-reconnecting').forEach(el => el.remove());
      if (!streamSession.active) return;
      // Co-browse streams the action envelope as text deltas: the raw JSON
      // accumulates here. Never render it as prose; show a placeholder instead.
      // The test runs on the ACCUMULATED text — testing the delta alone leaks
      // every chunk after the first (real Zo streams many small deltas; only
      // chunk 1 starts with '{').
      streamSession.fullText += safeText(msg.text);
      const isActionJson = looksLikeActionJson(streamSession.fullText);
      if (streamIsBackground()) {
        // Background chat: accumulate only; the bubble re-creates on switch-back.
        break;
      }
      if (!streamSession.msgEl) {
        const thinking = msgsEl.querySelector('.msg-thinking');
        if (thinking) thinking.remove();
        streamSession.msgEl = addMessageDOM('assistant', isActionJson ? '_Preparing actions…_' : '', { streaming: true });
        if (isActionJson) {
          // Tag the placeholder so STREAM_DONE can swap it for the done response.
          // The markdown renderer may leave the underscore text as a BARE text
          // node (no <p>/<em>), so wrap matching text nodes in a tagged span.
          const phBody = streamSession.msgEl.querySelector('.msg-body');
          const hits = [...(phBody?.childNodes || [])].filter((n) => /Preparing actions/.test(n.textContent || ''));
          for (const n of hits) {
            if (n.nodeType === 3) { // TEXT_NODE — wrap it
              const span = document.createElement('span');
              span.className = 'msg-actions-placeholder';
              span.textContent = n.textContent;
              phBody.replaceChild(span, n);
            } else {
              n.classList?.add('msg-actions-placeholder');
            }
          }
        }
        startStreamTimer(streamSession.msgEl);
      } else {
        const body = streamSession.msgEl.querySelector('.msg-body');
        if (body && !isActionJson) {
          // During streaming: append plain text for immediate feedback.
          // At STREAM_DONE, this will be replaced with fully-rendered markdown.
          const tokenSpan = document.createElement('span');
          tokenSpan.className = 'msg-streaming-text';
          tokenSpan.textContent = safeText(msg.text);
          body.appendChild(tokenSpan);
        }
      }
      break;
    }
    case 'STREAM_DONE': {
      clearThinkingTimeout();
      const domActions = (msg.actions || []).filter((a) => a.type !== 'navigate' && a.type !== 'done' && !isContextAction(a));
      // Remove any stale thinking indicator regardless of active state
      const staleThinking = msgsEl.querySelector('.msg-thinking');
      if (staleThinking) staleThinking.remove();
      stopStreamTimer();

      if (!streamSession.active) {
        // Stream was cancelled or port disconnected, but we still have a response —
        // show it via fallback message rather than silently dropping it
        if (msg.fullText || msg.reasoning || msg.actions?.length) {
          const fallbackText = safeText(msg.fullText) || safeText(msg.reasoning) || '';
          const fbEl = fallbackText ? addMessage('assistant', fallbackText) : null;
          if (fbEl) addReasoningBubble(fbEl, msg.reasoning);
          const actions = msg.actions || [];
          if (actions.length > 0) handleStreamActions(actions, msg.reasoning);
        }
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
        break;
      }
      // Remove any stale reconnecting banner
      const reconnDone = msgsEl.querySelector('.msg-reconnecting');
      if (reconnDone) reconnDone.remove();
      // Remove thinking indicator (for non-streaming responses where no STREAM_CHUNK was received)
      const thinkingDone = msgsEl.querySelector('.msg-thinking');
      if (thinkingDone) thinkingDone.remove();
      streamSession.active = false;
      // Remove any stale thinking indicator

      // Extract response text for non-action plain-text streaming.
      // When the response carried actions, prefer the done.response and skip
      // any fallback that is the raw action-JSON envelope (which would leak
      // {"actions":[...]} into the chat body when done.response is absent).
      const doneAction = (msg.actions || []).find(a => a.type === 'done');
      const hasActions = (msg.actions || []).some(a => a.type !== 'done' && a.type !== 'navigate');
      const candidateText = safeText(doneAction?.response)
        || (hasActions ? '' : safeText(msg.fullText))
        || (hasActions ? '' : safeText(streamSession.fullText))
        || safeText(msg.reasoning)
        || '';
      const responseText = hasActions && !candidateText
        ? '_Done — see the action timeline above._'
        : candidateText;

      const doneTimestamp = Date.now();
      const doneDuration = streamSession.startTime ? doneTimestamp - streamSession.startTime : 0;

      // ---- Background chat: persist into its conversation, no DOM ----
      if (streamSession.chatId && streamSession.chatId !== activeId) {
        const conv = conversations[streamSession.chatId];
        if (conv) {
          if (msg.conversationId) conv.zoThreadId = msg.conversationId;
          if (responseText) {
            const reasoningVal = safeText(msg.reasoning) || safeText(streamSession.reasoningText) || undefined;
            conv.messages.push({ role: 'assistant', text: responseText, reasoning: reasoningVal, timestamp: doneTimestamp, durationMs: doneDuration || undefined, contextTier: streamSession.effectiveTier, contextReason: streamSession.contextReason });
            if (conv.messages.length > MAX_HISTORY) {
              conv.messages = conv.messages.slice(-MAX_HISTORY);
            }
          }
          // Actions from a backgrounded chat are never auto-run against a page
          // the user isn't looking at — store them as pending for that chat.
          const bgDom = (msg.actions || []).filter((a) => a.type !== 'navigate' && a.type !== 'done' && !isContextAction(a));
          if (bgDom.length) {
            conv.pendingActions = { reasoning: safeText(msg.reasoning), actions: bgDom };
          }
          const bgNav = (msg.actions || []).filter((a) => a.type === 'navigate');
          if (bgNav.length) {
            conv.messages.push({ role: 'system', text: `📍 Navigation to ${safeText(bgNav[0].url)} deferred — re-ask from this chat.`, timestamp: Date.now() });
          }
          saveConversationById(streamSession.chatId);
        }
        renderChatTabs(); // clear the pulse
        input.disabled = false;
        sendBtn.disabled = false;
        streamSession.msgEl = null;
        streamSession.fullText = '';
        streamSession.reasoningText = '';
        streamSession.chatId = null;
        break;
      }
      // Active chat: render + persist below.

      // Chronological feed: the body already contains everything streamed in order
      // (reasoning tokens → tool cards → answer tokens). At this point, replace
      // the streaming text spans with fully-rendered markdown for proper formatting
      // (tables, bold, headings, etc. need complete text to parse correctly).
      if (streamSession.msgEl) {
        const body = streamSession.msgEl.querySelector('.msg-body');
        if (body) {
          // For action turns the accumulated stream text is the raw JSON
          // envelope — render the done response as normal prose instead (and
          // swap the _Preparing actions…_ placeholder for it).
          const leakedJson = looksLikeActionJson(streamSession.fullText);
          const finalText = leakedJson ? responseText : streamSession.fullText;
          const streamingTexts = body.querySelectorAll('.msg-streaming-text');
          const placeholders = body.querySelectorAll('.msg-actions-placeholder');
          if (finalText && (streamingTexts.length > 0 || placeholders.length > 0)) {
            // Replace all streaming text spans with a single fully-rendered markdown block
            const renderedHtml = markdownToHtml(finalText);
            streamingTexts.forEach(el => el.remove());
            placeholders.forEach(el => el.remove());
            body.insertAdjacentHTML('beforeend', renderedHtml);
          } else if (finalText && !body.textContent.trim()) {
            // Single-chunk stream (PartStart carried the whole answer → one
            // chunk created the bubble but no span) — render the full markdown
            // into the still-empty body rather than shipping an empty bubble.
            body.insertAdjacentHTML('beforeend', markdownToHtml(finalText));
          }
        }
        // Add TTS button if not already present (only if there's actual content).
        if (!streamSession.msgEl.querySelector('.tts-btn') && streamSession.msgEl.querySelector('.msg-body')?.textContent.trim()) {
          const ttsBtn = document.createElement('button');
          ttsBtn.className = 'tts-btn msg-tts-btn';
          ttsBtn.textContent = '🔊';
          ttsBtn.title = 'Read aloud';
          ttsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            speakText(responseText, ttsBtn);
          });
          streamSession.msgEl.appendChild(ttsBtn);
        }
      } else {
        // No streaming chunks — fallback to addMessage
        let fallbackEl = null;
        if (responseText) {
          fallbackEl = addMessage('assistant', responseText);
          addReasoningBubble(fallbackEl, msg.reasoning);
        } else if (msg.actions?.length) {
          // Response is in actions — will be rendered by handleStreamActions
        } else if (msg.fullText || msg.reasoning) {
          fallbackEl = addMessage('assistant', safeText(msg.fullText) || safeText(msg.reasoning));
          addReasoningBubble(fallbackEl, msg.reasoning);
        } else {
          // Truly empty response. Don't claim success ("Done.") — surface what
          // the stream actually contained (the STREAM_DIAGNOSTIC event→fields
          // map, when the background collected one) plus where the full shape
          // log lives. Server-side failures normally arrive as a `failed`
          // terminal (STREAM_ERROR error card), so this branch means the stream
          // completed with no recognizable content at all.
          const evts = (streamShape && Object.keys(streamShape).length)
            ? Object.keys(streamShape).map(safeText).join(', ')
            : '';
          addMessage('assistant', '_Zo returned an empty response' + (evts ? ` — received events: ${evts}` : '') + '. If this persists, check the service worker console (chrome://extensions → Inspect views: service worker) for `[zo-cobrowse] stream shape:` to see the actual stream format._');
        }
        if (!hasActions && fallbackEl && responseText) {
          addLinkChipsCard(fallbackEl, extractUrls(responseText));
        }
      }

      // Finalize: stop the live processing timer and render the full footer
      // (Copy / mode / model / timestamp · total-duration) on the streamed bubble.
      stopStreamTimer();
      if (streamSession.msgEl) {
        const timerLine = streamSession.msgEl.querySelector('.msg-processing-timer');
        if (timerLine) timerLine.remove();
        // Resolve the TURN's mode (a !mode bang may differ from the active
        // select) so the footer chip names what actually ran.
        const mode = resolveMode(streamSession.modeId || activeModeId, customModes, modeOverrides);
        addMessageFooter(streamSession.msgEl, {
          timestamp: doneTimestamp,
          modeName: mode.name,
          modelName: config.selectedModel || undefined,
          durationMs: doneDuration,
          contextTier: streamSession.effectiveTier,
          contextReason: streamSession.contextReason,
        });
        // Code blocks in the final rendered markdown get their Copy buttons.
        const doneBody = streamSession.msgEl.querySelector('.msg-body');
        if (doneBody) enhanceCodeBlocks(doneBody);
        // Research answers: link chips + Open all (prose answers only — an
        // action turn's links already ran as navigate/click).
        if (!hasActions && responseText) {
          addLinkChipsCard(streamSession.msgEl, extractUrls(responseText));
        }
      }

      // Persist to conversation (thread id echo + assistant message)
      const conv = getActiveConversation();
      if (conv) {
        if (msg.conversationId) conv.zoThreadId = msg.conversationId;
        if (responseText) {
          const reasoningVal = safeText(msg.reasoning) || safeText(streamSession.reasoningText) || undefined;
          // Persist to conversation (chronological feed is already in the body; just save reasoning)
          conv.messages.push({ role: 'assistant', text: responseText, reasoning: reasoningVal, timestamp: doneTimestamp, durationMs: doneDuration || undefined, contextTier: streamSession.effectiveTier, contextReason: streamSession.contextReason });
          if (conv.messages.length > MAX_HISTORY) {
            conv.messages = conv.messages.slice(-MAX_HISTORY);
          }
        }
        saveCurrentConversation();
      }

      // Handle structured actions (navigate, dom, done)
      const actions = msg.actions || [];
      if (actions.length > 0) {
        handleStreamActions(actions, msg.reasoning);
      }

      // Re-enable input
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      streamSession.msgEl = null;
      streamSession.fullText = '';
      streamSession.reasoningText = '';
      streamSession.chatId = null;
      streamSession.effectiveTier = undefined;
      streamSession.contextReason = undefined;
      streamSession.modeId = undefined;
      break;
    }
    case 'STREAM_ERROR': {
      clearThinkingTimeout();
      stopStreamTimer();
      if (!streamSession.active) return;
      // Remove any stale reconnecting banner
      const reconnErr = msgsEl.querySelector('.msg-reconnecting');
      if (reconnErr) reconnErr.remove();
      streamSession.active = false;
      // Background chat: persist the error into its conversation; no DOM.
      if (streamSession.chatId && streamSession.chatId !== activeId) {
        const conv = conversations[streamSession.chatId];
        if (conv) {
          conv.messages.push({ role: 'error', text: `Response interrupted: ${safeText(msg.error)}`, timestamp: Date.now() });
          saveConversationById(streamSession.chatId);
        }
        renderChatTabs(); // clear the pulse
        input.disabled = false;
        sendBtn.disabled = false;
        streamSession.msgEl = null;
        streamSession.fullText = '';
        streamSession.reasoningText = '';
        streamSession.startTime = 0;
        streamSession.chatId = null;
        break;
      }
      const thinking = msgsEl.querySelector('.msg-thinking');
      if (thinking) thinking.remove();
      // Drop the partial assistant bubble (if any) so the processing timer line doesn't linger.
      if (streamSession.msgEl) {
        const timerLine = streamSession.msgEl.querySelector('.msg-processing-timer');
        if (timerLine) timerLine.remove();
      }
      // Zo error card: "Response interrupted" + technical detail + Retry.
      addErrorCard(msg.error, () => {
        if (lastQuery) sendQueryFromLabel(lastQuery);
      });
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      streamSession.msgEl = null;
      streamSession.fullText = '';
      streamSession.reasoningText = '';
      streamSession.startTime = 0;
      streamSession.chatId = null;
      break;
    }
      case 'STREAM_RECONNECT_DONE': {
      // Successful reconnect — remove the reconnecting banner
      const reconnDone = msgsEl.querySelector('.msg-reconnecting');
      if (reconnDone) reconnDone.remove();
      break;
    }
      case 'STREAM_RECONNECT': {
        if (!streamSession.active) return;
        if (streamIsBackground()) return; // banner belongs to the streaming chat's view
      let reconn = msgsEl.querySelector('.msg-reconnecting');
      if (!reconn) {
        reconn = document.createElement('div');
        reconn.className = 'msg msg-reconnecting';
        reconn.innerHTML = '<div class="msg-body">➳ Reconnecting...</div>';
        msgsEl.appendChild(reconn);
      }
      reconn.querySelector('.msg-body').textContent = '➳ Reconnecting... attempt ' + msg.attempt + ' of ' + msg.maxRetries;
      reconn.scrollIntoView({ behavior: 'smooth' });
      break;
    }
    case 'STREAM_DIAGNOSTIC': {
      // Stream-shape discovery: Zo tells us which SSE events/fields it emitted.
      // Recorded for richer-content rendering (tool traces, sources, streaming
      // reasoning); not shown in the chat stream (the user shouldn't see it).
      streamShape = msg.diagnostic || null;
      break;
    }
  }
}

function handleStreamActions(actions, reasoning) {
  const navigateActions = actions.filter((a) => a.type === 'navigate');
  const domActions = actions.filter((a) => a.type !== 'navigate' && a.type !== 'done');
  const doneResponse = actions.find((a) => a.type === 'done')?.response;

  if (navigateActions.length) {
    addMessage('assistant', `📍 Navigating to: ${navigateActions[0].url}`);
    chrome.runtime.sendMessage({
      type: 'NAVIGATE',
      url: navigateActions[0].url,
    }).catch(() => {});
    setTimeout(async () => {
      await refreshPageContext();
      if (doneResponse) {
        const el = addMessage('assistant', doneResponse);
        addReasoningBubble(el, reasoning);
      }
    }, 2000);
    return;
  }

  if (domActions.length) {
    pendingActions = domActions;
    pendingActionsReasoning = safeText(reasoning);
    actionsReasoning.textContent = `🧠 ${reasoning?.substring(0, 200) || ''}`;
    actionsBar.classList.remove('hidden');
    runPendingActions();
  }

  // No actions or already handled — input state is managed by STREAM_DONE
}

// Override sendQuery for streaming
sendQuery = async function() {
  const query = input.value.trim();
  if (!query || actionRunning) return;
  lastQuery = query;
  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;

  await ensureActiveConversation();
  // The active chat always has an open tab (covers sends after a storage reset).
  tabsState = openChatTab(tabsState, activeId);
  renderChatTabs();
  await refreshPageContext();
  if (!currentContext) {
    addMessage('error', 'Could not capture page context. Try loading a webpage first.');
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
    return;
  }

  if (!config.hasToken) {
    addMessage('error', 'Zo not configured. Open extension settings to add your access token.');
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
    return;
  }

  // ---- Quick Commands (!) ----
  let effectiveQuery = query;
  let tempMode = null;
  let bangResult = null; // preserved for the context-policy decision below
  if (query.startsWith('!')) {
    const bang = parseBangCommand(query);
    bangResult = bang;
    if (bang.inlineReply) {
      addMessage('user', query);
      addMessage('assistant', bang.inlineReply);
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      return;
    }
    if (bang.isSave) {
      addMessage('user', query);
      addMessage('thinking', 'Saving to workspace...');
      const saveResp = await chrome.runtime.sendMessage({
        type: 'SAVE_PAGE',
        pageContext: currentContext,
        savePath: bang.savePath || '',
      });
      const thinking = msgsEl.querySelector('.msg-thinking');
      if (thinking) thinking.remove();
      if (saveResp && saveResp.error) {
        addMessage('error', saveResp.error);
      } else {
        addMessage('assistant', (saveResp && saveResp.response) || 'Page saved to workspace.');
      }
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      return;
    }
    if (bang.isAuto) {
      addMessage('user', query);
      addMessage('thinking', 'Creating automation...');
      const autoResp = await chrome.runtime.sendMessage({
        type: 'CREATE_AUTOMATION',
        instruction: bang.instruction || '',
        pageContext: currentContext,
      });
      const thinking = msgsEl.querySelector('.msg-thinking');
      if (thinking) thinking.remove();
      if (autoResp && autoResp.error) {
        addMessage('error', autoResp.error);
      } else {
        addMessage('assistant', (autoResp && autoResp.response) || 'Automation created.');
      }
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      return;
    }
    if (bang.isDuckdb) {
      addMessage('user', query);
      addMessage('thinking', 'Querying datasets...');
      const dbResp = await chrome.runtime.sendMessage({
        type: 'DUCKDB_QUERY',
        naturalQuery: bang.naturalQuery,
      });
      const thinking = msgsEl.querySelector('.msg-thinking');
      if (thinking) thinking.remove();
      if (dbResp && dbResp.error) {
        addMessage('error', dbResp.error);
      } else {
        addDuckdbResult(dbResp || {});
      }
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      return;
    }
    effectiveQuery = bang.query;
    tempMode = bang.mode;
  }

  // ---- Tab contexts: referenced tabs ride along as manifest + excerpt ----
  // Fresh capture per send (excerpts are cheap + always current). Refs T1…Tn
  // follow the strip's recency order; closed tabs drop with an inline note.
  const { tabContexts, dropped } = await fetchTabContextsForSend();

  // ---- Picker chips (#28) are send-once: armed skills/files ride THIS turn,
  // then clear. (Skills are an invocation — re-arming them every turn would
  // re-run the skill uninvited.)
  closeAllPickerPopups();
  const turnSkills = pickedSkills.slice();
  const turnFiles = pickedFiles.slice();
  pickedSkills.length = 0;
  pickedFiles.length = 0;
  renderPickerChips();

  const userMsgEl = addMessage('user', query);
  // When a page is captured for this turn, show a Zo-style mention pill
  // (file-mention badge) in the user message so it reads like Zo's
  // composer-shell with an attached file/page reference. Blank/new-tab pages
  // get no pill — a cold-start turn references nothing.
  if (currentContext && (currentContext.title || currentContext.url) && !isBlankPage(currentContext.url || '')) {
    const userBody = userMsgEl && userMsgEl.querySelector
      ? userMsgEl.querySelector('.msg-body')
      : null;
    if (userBody) {
      const host = safeText(currentContext.title || currentContext.url);
      appendMentionPill(userBody, host);
    }
  }
  if (tabContexts.length) {
    renderTabRefPills(userMsgEl, tabContexts.map((t) => ({ ref: t.ref, host: t.host, title: t.title })));
    const conv = getActiveConversation();
    if (conv && conv.messages.length) {
      conv.messages[conv.messages.length - 1].tabRefs = tabContexts.map((t) => ({ ref: t.ref, host: t.host, title: t.title }));
      saveCurrentConversation();
    }
  }
  if (dropped.length) {
    addMessage('system', `📎 ${dropped.length} referenced tab${dropped.length === 1 ? '' : 's'} closed — skipped.`);
  }
  // Picker pills (send-once chips re-render as mention pills, like tab refs).
  if (turnSkills.length || turnFiles.length) {
    const userBody = userMsgEl && userMsgEl.querySelector ? userMsgEl.querySelector('.msg-body') : null;
    if (userBody) {
      for (const s of turnSkills) appendMentionPill(userBody, `⚡ ${s.name}`);
      for (const f of turnFiles) appendMentionPill(userBody, `📄 ${f.path.split('/').pop()}`);
    }
    const conv = getActiveConversation();
    if (conv && conv.messages.length) {
      const last = conv.messages[conv.messages.length - 1];
      if (turnSkills.length) last.skillRefs = turnSkills.map((s) => ({ name: s.name }));
      if (turnFiles.length) last.fileRefs = turnFiles.map((f) => ({ path: f.path }));
      saveCurrentConversation();
    }
  }
  addMessage('thinking', 'Zo is thinking. Press Esc to stop.');
  startThinkingTimeout();

  // Resolve the Mode for this turn: a bang command can override the active
  // Mode for a single turn (tempMode), else use the selected Mode.
  const modeId = tempMode || activeModeId;
  const mode = resolveMode(modeId, customModes, modeOverrides);

  // ---- Context policy: opt-in DOM + send-once ----
  // Decides how much of the captured page context to embed in the prompt this
  // turn (effectiveTier). Reads default to URL-only; !context and action turns
  // attach the Mode's full context; same-page follow-ups dedupe to URL-only.
  // The capture above is at the Mode tier (IPC, not billed tokens); buildPrompt
  // (in the background) thins what actually reaches Zo using effectiveTier.
  const pageHash = computePageHash(currentContext, mode.contextTier);
  const pageBlank = isBlankPage(currentContext?.url || '');
  // Per-chat threading: send the chat's stored Zo thread id (the background
  // echoes the effective id back on STREAM_DONE / the fallback response).
  // Read BEFORE the policy decision — follow-up dedup ("context already sent")
  // is only safe when the Zo thread actually exists; a fresh thread (e.g. a
  // retry after a stream that died before the conversation_id echo) holds
  // nothing, so the decision re-attaches instead of trusting a thread that
  // isn't there.
  const activeConvPre = getActiveConversation();
  const threadId = (activeConvPre && activeConvPre.zoThreadId) || undefined;
  const turnDecision = decideTurn({
    mode,
    query: effectiveQuery,
    bang: bangResult,
    state: contextState,
    pageHash,
    pageBlank,
    hasThread: !!threadId,
  });
  contextState = turnDecision.newState;
  saveConversationState(activeId, contextState);
  const effectiveTier = turnDecision.effectiveTier;

  // ---- Auto-reference the active tab on tier-0 turns ----
  // Whenever the policy thins this turn to URL-only (reads, same-page
  // follow-ups), the active browser tab still rides along as T1 (manifest
  // line + 500-char excerpt) so Zo always knows what page you're on.
  // Banner-free capture (content-script path); full DOM stays opt-in
  // (!context / action turns). Refs renumber so the active tab is T1.
  // Blank/new-tab pages are never auto-referenced (cold start: no page).
  let sendTabContexts = tabContexts;
  if (effectiveTier === 0 && currentContext && currentContext.tabId != null && !pageBlank) {
    const activeRef = await fetchTabContext(currentContext.tabId);
    if (activeRef) sendTabContexts = assignRefs(ensureActiveTabRef(tabContexts, activeRef));
  }

  // ---- Follow-up excerpt dedup (send-once tab manifests) ----
  // Tabs whose content key was already sent ride as pointer-only manifest
  // lines — Zo's conversation threading retains the 500-char excerpts, so
  // re-sending them every turn is pure duplicate tokens. The dedup map lives
  // in the per-chat context state and persists with it.
  const thinned = thinTabExcerpts(sendTabContexts, contextState.tabManifestSent);
  sendTabContexts = assignRefs(thinned.contexts);
  contextState = { ...contextState, tabManifestSent: thinned.sentMap };
  saveConversationState(activeId, contextState);

  renderPromptInspector(); // dedup state advanced — refresh the preview

  // Stash the turn's context decision + mode for the STREAM_DONE footer (the
  // context-tier chip and the correct post-bang mode name) and the persisted
  // assistant record.
  streamSession.effectiveTier = effectiveTier;
  streamSession.contextReason = turnDecision.reason;
  streamSession.modeId = modeId;

  // --- Streaming path: (re)connect port if needed ---
  if (!streamPort) connectStreamingPort();
  if (streamPort) {
    streamSession.sessionId++;
    const thisSessionId = streamSession.sessionId;
    streamSession.active = true;
    streamSession.chatId = activeId; // routes background-stream persistence
    streamSession.msgEl = null;
    streamSession.fullText = '';
    streamSession.reasoningText = '';
    streamSession.startTime = Date.now();
    try {
      streamPort.postMessage({
        sessionId: thisSessionId,
        type: 'ASK_ZO',
        chatId: activeId,
        conversationId: threadId,
        pageContext: currentContext,
        userQuery: effectiveQuery,
        modelName: config.selectedModel || undefined,
        personaId: config.selectedPersona || undefined,
        modeId,
        customModes,
        effectiveTier,
        modeOverrides,
        ...(sendTabContexts.length ? { tabContexts: sendTabContexts } : {}),
        ...(turnSkills.length ? { skills: turnSkills } : {}),
        ...(turnFiles.length ? { workspaceFiles: turnFiles } : {}),
      });
    } catch (e) {
      // Port disconnected between check and postMessage — fall through to non-streaming fallback
      streamSession.active = false;
      streamPort = null;
    }
    if (streamPort) {
      // Response arrives via handleStreamMessage — input re-enabled there
      return;
    }
  }

  // --- Fallback: one-shot sendMessage if port unavailable ---
  const resp = await chrome.runtime.sendMessage({
    type: 'ASK_ZO',
    chatId: activeId,
    conversationId: threadId,
    pageContext: currentContext,
    userQuery: effectiveQuery,
    modelName: config.selectedModel || undefined,
    personaId: config.selectedPersona || undefined,
    modeId,
    customModes,
    effectiveTier,
    modeOverrides,
    ...(sendTabContexts.length ? { tabContexts: sendTabContexts } : {}),
    ...(turnSkills.length ? { skills: turnSkills } : {}),
    ...(turnFiles.length ? { workspaceFiles: turnFiles } : {}),
  });

  // Persist the echoed thread id for this chat (before any early return).
  if (resp && resp.conversationId && activeConvPre) {
    activeConvPre.zoThreadId = resp.conversationId;
    saveConversationById(activeId);
  }

  const thinking = msgsEl.querySelector('.msg-thinking');
  if (thinking) thinking.remove();
  streamSession.active = false;

  if (!resp || resp.error) {
    addMessage('error', (!resp ? 'No response from background. Try reloading the extension.' : resp.error));
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
    return;
  }

  const output = resp.output;
  let reasoning = '';
  let actions = [];

  // Normalize undefined/null/boolean to string for consistent parsing
  const normalizedOutput = (typeof output === 'object' && output !== null) ? output : String(output ?? '');

  if (typeof normalizedOutput === 'object' && normalizedOutput !== null) {
    reasoning = normalizedOutput.reasoning || '';
    actions = normalizeActions(normalizedOutput.actions);
  } else if (typeof normalizedOutput === 'string') {
    try {
      const parsed = JSON.parse(normalizedOutput);
      reasoning = parsed.reasoning || '';
      actions = normalizeActions(parsed.actions);
    } catch {
      reasoning = normalizedOutput;
    }
  }

  const doneAction = actions.find(a => a.type === 'done');
  const hasNavigate = actions.some(a => a.type === 'navigate');
  const doneResponse = doneAction?.response || '';
  const reasoningVal = safeText(reasoning) || undefined;

  if (!actions.length) {
    // Show reasoning or the raw output text, with "Done." only as last resort
    const fallbackText = reasoning || doneResponse || output || '';
    const el = addMessage('assistant', fallbackText || 'Done.');
    addReasoningBubble(el, reasoning);
  } else {
    handleStreamActions(actions, reasoning);
    // handleStreamActions already adds the done response for navigate actions
    // (via its own setTimeout). For non-navigate scenarios, display it here.
    if (doneAction && !hasNavigate) {
      const el = addMessage('assistant', doneResponse || reasoning || output || 'Done.');
      addReasoningBubble(el, reasoning);
    } else if (reasoningVal) {
      // navigate-only actions: persist reasoning with the navigate status message
      const conv = getActiveConversation();
      const last = conv?.messages?.[conv.messages.length - 1];
      if (last && last.role === 'assistant') last.reasoning = reasoningVal;
    }
  }

  // Persist reasoning on the most recent assistant message (addMessage pushed it
  // without reasoning, since reasoning isn't threaded through every caller).
  if (reasoningVal) {
    const conv = getActiveConversation();
    const last = conv?.messages?.[conv.messages.length - 1];
    if (last && last.role === 'assistant' && !last.reasoning) last.reasoning = reasoningVal;
  }

  input.disabled = false;
  sendBtn.disabled = false;
  input.focus();
};
