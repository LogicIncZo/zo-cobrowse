// Post a message to a streaming port, tolerating disconnects.
// Marks the port dead on failure and returns false so callers can stop
// retrying instead of throwing "disconnected port object" up the stack.
import {
  resolveMode,
  presetToMode,
  DEFAULT_MODE_ID,
  normalizeActions,
  isContextAction,
} from './lib/modes.js';
import { buildPrompt } from './lib/prompt.js';
import { parseZoOutput, stripCodeFence } from './lib/parse-output.js';
// safeText stays the local one (line ~156) — do NOT import it here.
import {
  STRIP_MAX_TABS,
  hostOf,
  isBlankPage,
  isCapturableUrl,
  isTabSentAt,
  noteTabSent,
} from './lib/tab-contexts.js';
import {
  extractPullRequests,
  buildPullFollowUp,
  pullHash,
  pullTier,
  pullCaptureOpts,
  MAX_PULL_CYCLES,
} from './lib/pull.js';
import { isSensitiveForm } from './lib/formfill.js';
import {
  buildEnhancePrompt,
  parseEnhanceResponse,
} from './lib/write-assist.js';
import {
  buildGenerateModePrompt,
  buildRunSkillPrompt,
  buildCreateAutomationPrompt,
  buildListAutomationsPrompt,
  buildTestConnectionPrompt,
} from './lib/zo-prompts.js';
import {
  loadConversationState,
  saveConversationState,
  computePageHash,
} from './lib/context-policy.js';
import {
  shouldCaptureScreenshot,
  findModelEntry,
  CATALOG_TTL_MS,
} from './lib/vision.js';
import {
  mcpRequest,
  mcpNotification,
  initializeParams,
  toolCallParams,
  parseMcpMessage,
  toolText,
  isToolError,
} from './lib/mcp.js';
import {
  WORKSPACE_ROOT,
  skillsListCommand,
  dirListCommand,
  safeWorkspacePath,
  extractMarkedStdout,
  parseSkillsBundle,
  parseLsEntries,
} from './lib/pickers.js';
import { createSessionCache } from './lib/sw-cache.js';
import { createDebugLog } from './lib/debug-log.js';

function safePost(port, msg) {
  if (!port || port._dead) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    port._dead = true;
    return false;
  }
}

// True when an error is transient enough to justify a stream retry.
// Non-retriable: missing token (config), auth (401/403), bad request (400),
// missing-content-type, plain text parse errors.
function isRetriableStreamError(err) {
  const m = safeText(err && err.message).toLowerCase();
  if (!m) return true; // unknown — give it one retry
  if (m.includes('token') || m.includes('not configured')) return false;
  if (m.includes('zo api error: 4')) return false; // 4xx (auth/bad request)
  if (m.includes('parse error')) return false;
  return true; // network / 5xx / aborted → retry
}

async function askZoStream(port, msg) {
  const maxRetries = 3;
  const baseDelay = 1000;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Port went away (panel closed) — stop immediately, no more API calls.
    if (port._dead) {
      throw new Error('Port disconnected');
    }
    try {
      if (attempt > 1) {
        // Announce the retry first, then the banner. *_DONE is only sent
        // after the final attempt succeeds (handled implicitly by the
        // successful return below, which clears the banner via STREAM_CHUNK).
        if (!safePost(port, { sessionId: msg.sessionId, type: 'STREAM_RECONNECT', attempt, maxRetries })) {
          throw new Error('Port disconnected');
        }
      }
      return await _askZoStreamImpl(port, msg);
    } catch (err) {
      lastError = err;
      // Don't retry if the port is gone or the error is non-transient.
      if (port._dead || !isRetriableStreamError(err)) throw err;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ---- Stream content extraction ----
// Zo's /zo/ask SSE stream is documented (AGENTS.md) as:
//   event: FrontendModelResponse → text in data.content
//   event: End                   → full answer in data.output
//   event: Error                 → message in data.message
// But the per-event payload shape varies across model providers behind Zo
// (OpenAI delta.content, Anthropic delta.text, nested message.content, etc.)
// and the docs don't fully specify it. Extract from any known field so a
// valid response is never dropped and shown as "Done." (ticket #29).

// Strip a single leading ```lang ... ``` code fence **only when the whole
// string is one fenced block**. Zo's cobrowse mode wraps the JSON action
// envelope in a ```json fence; without this, finishStream's JSON.parse fails
// and the actions are silently dropped. Read-only modes emit markdown prose
// that may contain inline code blocks — those must NOT be stripped, so the
// guard is strict (one fence, nothing after the closing fence except ws).
// stripCodeFence lives in lib/parse-output.js (imported above).

// Summarize a FunctionToolResult payload for the "Explored" trace. Tool
// results (esp. research/bash) can be huge; truncate to keep the side panel
// readable. Preserves the success/error signal for the card status.
function summarizeToolResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result.slice(0, 300);
  // Standard shape: { content: { stdout, stderr, returncode } | string, outcome }
  const content = result.content;
  let body = '';
  if (typeof content === 'string') {
    body = content;
  } else if (content && typeof content === 'object') {
    body = safeText(content.stdout || content.text || content.message || '');
    if (content.stderr) body += (body ? '\n' : '') + safeText(content.stderr);
  } else if (result.output != null) {
    body = safeText(result.output);
  } else {
    try { body = JSON.stringify(result); } catch { body = safeText(result); }
  }
  return body.slice(0, 300);
}

function extractStreamContent(parsed) {
  if (parsed == null) return '';
  // Direct scalar fields (Zo canonical: content/output/text/response/message)
  if (typeof parsed.content === 'string') return parsed.content;
  if (typeof parsed.output === 'string') return parsed.output;
  if (typeof parsed.text === 'string') return parsed.text;
  if (typeof parsed.response === 'string') return parsed.response;
  // OpenAI-style chat completion: choices[0].delta.content
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  if (choice?.delta?.content) return safeText(choice.delta.content);
  if (choice?.message?.content) return safeText(choice.message.content);
  // Anthropic-style: delta.text / content_block_delta
  if (parsed.delta?.text) return safeText(parsed.delta.text);
  if (parsed.delta?.content) return safeText(parsed.delta.content);
  if (parsed.delta?.content_delta) return safeText(parsed.delta.content_delta);
  // Nested message.content
  if (parsed.message?.content) return safeText(parsed.message.content);
  // output may be an object (e.g. {reasoning, actions}) — stringify as last resort
  if (parsed.output != null && typeof parsed.output === 'object') {
    return safeText(JSON.stringify(parsed.output));
  }
  return '';
}

// ---- Safe text helper ----
// Also defined in ./lib/prompt.js (pure copy, so the inspector + Settings
// editor can use it without chrome.* deps). Kept here because the SSE test
// harnesses VM-extract it from background.js source by name as a boundary
// marker. buildPrompt itself is imported from ./lib/prompt.js.
function safeText(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try { const s = JSON.stringify(v); return typeof s === 'string' ? s : ''; }
  catch { return ''; }
}

// Zo Co-browse — Background Service Worker
// Manages Zo API communication, settings, and message routing

const DEFAULTS = {
  zoApiUrl: 'https://api.zo.computer/zo/ask',
  zoModel: '',
  zoSpaceEndpoint: 'https://cashlessconsumer.zo.space',
  zoPersonaId: '',          // optional: pin the persona sent to the API
  zoActiveMode: 'cobrowse', // active Mode id (replaces personaMode + presets)
  zoAccessToken: '',
  enableScreenshots: true,  // global kill-switch; per-Mode tiers also gate capture
  enableWriteAssist: true,  // textarea write-assist floating icon (content script)
  enabledMenus: {        // which context menu items are active
    page: true,
    selection: true,
    link: true,
    editable: true,
  },
};

let config = { ...DEFAULTS };
// Vision catalog cache (#25): /models/catalog is no-auth + cheap, but we
// don't want to block every tier-3 turn on a fetch. Backed by
// chrome.storage.session so it survives MV3 SW restarts (same #73 fix as the
// skills list). A failed fetch returns null = MISS = retried, never cached.
const catalogCacheStore = createSessionCache({
  storage: chrome.storage.session,
  key: 'cobrowse_catalog_cache',
  ttlMs: CATALOG_TTL_MS,
});

// Track Zo API conversation ID for multi-turn context. This global is the
// AMBIENT thread (context menu / omnibox callers); the sidepanel's chat tabs
// each carry their own thread id on the ASK_ZO payload and win when present.
let zoConversationId = null;
// Recover conversation ID from session storage (survives MV3 SW restart but not browser close)
chrome.storage.session.get('zoConversationId').then(s => {
  if (s.zoConversationId) zoConversationId = s.zoConversationId;
}).catch(e => console.debug('session.get(zoConversationId):', e));

/** Coerce a payload thread id to a trimmed string ('' when absent). */
function msgThreadId(conversationId) {
  return typeof conversationId === 'string' ? conversationId.trim() : '';
}

/**
 * Tab id for routing page work (capture / actions / navigation). The
 * extension's OWN pages opened as tabs — most commonly the side panel URL,
 * which users (and the e2e harness) legitimately open as a normal tab — must
 * never be captured or acted on: treating them as "no tab" makes the caller
 * fall through to the active web tab, which is always the user's intent.
 */
function senderTabId(sender) {
  const url = (sender && sender.tab && sender.tab.url) || '';
  return /^(chrome-extension|chrome|about|edge|devtools):/i.test(url) ? undefined : sender?.tab?.id;
}

// ---- Debug diagnostics (#67) ----
// Metadata-only ring buffer (lib/debug-log.js enforces the privacy contract:
// kinds/labels/durations/small scalar extras — never page text or tokens).
// Gated by Settings → Features → Debug mode (storage.sync `debugMode`,
// default OFF); exported only when the user clicks "Copy diagnostics".
const debugLog = createDebugLog();

function perfNow() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

try {
  chrome.storage.sync.get({ debugMode: false }, (res) => debugLog.setEnabled(!!(res && res.debugMode)));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.debugMode) debugLog.setEnabled(!!changes.debugMode.newValue);
  });
} catch { /* storage unavailable */ }


// ---- Init ----
chrome.storage.sync.get(
  ['zoApiUrl', 'zoModel', 'zoPersonaId', 'zoActiveMode', 'enableScreenshots', 'enableWriteAssist', 'enabledMenus'],
  (result) => {
    if (result.zoApiUrl) config.zoApiUrl = result.zoApiUrl;
    if (result.zoModel) config.zoModel = result.zoModel;
    if (result.zoPersonaId) config.zoPersonaId = result.zoPersonaId;
    if (result.zoActiveMode) config.zoActiveMode = result.zoActiveMode;
    if (result.enableScreenshots !== undefined) config.enableScreenshots = result.enableScreenshots;
    if (result.enableWriteAssist !== undefined) config.enableWriteAssist = result.enableWriteAssist;
      if (result.enabledMenus) config.enabledMenus = { ...config.enabledMenus, ...result.enabledMenus };
  }
);
// Sensitive config from storage.local (not synced)
chrome.storage.local.get(
  ['zoAccessToken', 'zoSpaceEndpoint'],
  (result) => {
    if (result.zoAccessToken) config.zoAccessToken = result.zoAccessToken;
    if (result.zoSpaceEndpoint) config.zoSpaceEndpoint = result.zoSpaceEndpoint;
  }
);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (changes.zoApiUrl?.newValue) config.zoApiUrl = changes.zoApiUrl.newValue;
  if (changes.zoModel?.newValue) config.zoModel = changes.zoModel.newValue;
  if (changes.zoPersonaId?.newValue) config.zoPersonaId = changes.zoPersonaId.newValue;
  if (changes.zoActiveMode?.newValue) config.zoActiveMode = changes.zoActiveMode.newValue;
  if (changes.zoAccessToken?.newValue) config.zoAccessToken = changes.zoAccessToken.newValue;
  else if (changes.zoAccessToken?.oldValue && !changes.zoAccessToken?.newValue) config.zoAccessToken = undefined;
  if (changes.zoSpaceEndpoint?.newValue) config.zoSpaceEndpoint = changes.zoSpaceEndpoint.newValue;
  else if (changes.zoSpaceEndpoint?.oldValue && !changes.zoSpaceEndpoint?.newValue) config.zoSpaceEndpoint = undefined;
    if (changes.enabledMenus?.newValue) { config.enabledMenus = { ...config.enabledMenus, ...changes.enabledMenus.newValue }; recreateContextMenus(); }
  if (changes.enableScreenshots?.newValue !== undefined) config.enableScreenshots = changes.enableScreenshots.newValue;
  if (changes.enableWriteAssist?.newValue !== undefined) config.enableWriteAssist = changes.enableWriteAssist.newValue;
});

// Open side panel on toolbar icon click (global scope — takes effect on every SW wake-up).
// setPanelBehavior covers the click; no separate action.onClicked listener needed.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- Message handler ----
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // #67: metadata-only hop record (message type + coarse shape flags — no payloads).
  debugLog.push('msg', request.type || 'unknown', undefined, {
    tier: typeof request.effectiveTier === 'number' ? request.effectiveTier : undefined,
    shotOnly: request.shotOnly === true ? true : undefined,
  });
  switch (request.type) {
    case 'GET_DEBUG_LOG': {
      sendResponse(debugLog.entries());
      return true;
    }
    case 'CLEAR_DEBUG_LOG': {
      debugLog.clear();
      sendResponse({ ok: true });
      return true;
    }
    case 'GET_PAGE_CONTEXT': {
      getActiveTabContext(senderTabId(sender), request.tier, request.modeId).then(sendResponse);
      return true;
    }
    case 'ASK_ZO': {
      askZo(request.pageContext, request.userQuery, request.modelName, request.personaId, request.modeId, request.customModes, request.effectiveTier, request.modeOverrides, request.conversationId, request.skills, request.workspaceFiles, !!request.shotOnly).then(sendResponse);
      return true;
    }
    case 'RECREATE_CONTEXT_MENUS':
      recreateContextMenus();
      sendResponse({ ok: true });
      return true;
    case 'TEST_CONNECTION': {
      testConnection().then(sendResponse);
      return true;
    }
    case 'GET_CONFIG': {
      sendResponse(sanitizedConfig());
      return true;
    }
    case 'NEW_CONVERSATION': {
      zoConversationId = null;
      chrome.storage.session.set({ zoConversationId: null }).catch(e => console.debug('session.set:', e));
      sendResponse({ ok: true });
      return true;
    }
    case 'LIST_MODELS': {
      listModels().then(sendResponse);
      return true;
    }
    case 'GET_VISION_CATALOG': {
      // #25: the sidepanel asks for the no-auth catalog to show a vision-model
      // suggestion when the user picks Visual mode without a vision model.
      fetchModelCatalog().then((models) => sendResponse({ success: true, models }));
      return true;
    }
    case 'LIST_PERSONAS': {
      listPersonas().then(sendResponse);
      return true;
    }
    case 'LIST_SKILLS': {
      // #28 `/` picker: enumerate the user's Zo skills (workspace Skills
      // folder) over the MCP server's bash tool. Cached ~5 min, session-backed
      // (survives SW restarts, #73). `total` = total skill folders seen, so
      // the picker can say "+N more" when folders were skipped.
      listSkills(!!request.force).then((r) => sendResponse({ ok: true, skills: r.skills, total: r.totalFolders ?? undefined }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    case 'LIST_WORKSPACE_DIR': {
      // #28 `%` picker: one `ls -1F` of a workspace path (validated + confined
      // to /home/workspace by safeWorkspacePath in listWorkspaceDir).
      listWorkspaceDir(request.path).then(sendResponse);
      return true;
    }
    case 'EXECUTE_ACTIONS': {
      // Context-only pull actions never reach the DOM — the background
      // consumes them in the stream loop (finishStreamWithPullLoop); filter
      // here so a degenerate Zo response that still asks after the budget
      // note no-ops safely.
      const domActions = (request.actions || []).filter((a) => a && !isContextAction(a));
      runExecuteActions(domActions, request.tabId || senderTabId(sender), { confirmed: request.confirmed }).then(sendResponse);
      return true;
    }
    case 'ENHANCE_TEXT': {
      // Textarea write-assist: the content script's in-page widget sends the
      // focused field's data; we build the prompt (lib/write-assist), call Zo
      // one-shot (no conversation_id -> fresh thread, no ambient rotation),
      // and return the improved text for the widget to preview + fill back.
      enhanceText(request).then(sendResponse);
      return true;
    }
    case 'GET_OPEN_TABS': {
      // Tab-context chip strip source: capturable tabs in the current window,
      // most recently used first, capped.
      chrome.tabs.query({ currentWindow: true }).then((allTabs) => {
        const list = (allTabs || [])
          .filter((t) => isCapturableUrl(t.url))
          .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
          .slice(0, STRIP_MAX_TABS)
          .map((t) => ({ tabId: t.id, title: t.title || '', url: t.url, host: hostOf(t.url), active: !!t.active }));
        sendResponse({ tabs: list });
      }).catch(() => sendResponse({ tabs: [] }));
      return true;
    }
    case 'GET_TAB_CONTEXTS': {
      getTabContexts(request.tabIds || [], request.activeTabId || null).then(sendResponse);
      return true;
    }
    case 'NAVIGATE': {
      const navTabId = request.tabId || senderTabId(sender);
      if (!navTabId || !request.url) {
        sendResponse({ ok: false, error: 'NAVIGATE requires tabId and url' });
        return false;
      }
      chrome.tabs.update(navTabId, { url: request.url }).then(() =>
        sendResponse({ ok: true })
      ).catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    case 'GENERATE_MODE': {
      generateMode(request.description).then(sendResponse);
      return true;
    }
    case 'SAVE_PAGE': {
      savePageToWorkspace(request.pageContext, request.savePath).then(sendResponse);
      return true;
    }
    case 'RUN_SKILL': {
      runSkill(request.skillName, request.pageContext).then(sendResponse);
      return true;
    }
    case 'CREATE_AUTOMATION': {
      createAutomation(request.instruction || '', request.rrule || 'FREQ=DAILY', request.pageContext).then(sendResponse);
      return true;
    }
    case 'LIST_AUTOMATIONS': {
      listAutomations().then(sendResponse);
      return true;
    }
    case 'DUCKDB_QUERY': {
      runDuckdbQuery(request.naturalQuery).then(sendResponse);
      return true;
    }
  }
});

// ---- Core ----

function sanitizedConfig() {
  return {
    zoApiUrl: config.zoApiUrl,
    zoModel: config.zoModel,
    zoPersonaId: config.zoPersonaId,
    zoActiveMode: config.zoActiveMode,
    enableScreenshots: config.enableScreenshots,
    enableWriteAssist: config.enableWriteAssist,
    enabledMenus: config.enabledMenus,
    zoSpaceEndpoint: config.zoSpaceEndpoint,
    hasToken: !!config.zoAccessToken,
    zoConversationId: zoConversationId,
  };
}

// ---- Route context capture and action execution through content script ----
// ---- Timeout wrapper ----
function withTimeout(promise, ms = 8000, label = 'operation') {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(id)), timeout]);
}

// ---- Debugger-based page eval (primary path, mirrors Kilo Code pattern) ----

const debuggerTabMap = new Map();

async function attachDebugger(tabId) {
  if (debuggerTabMap.get(tabId)?.attached) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerTabMap.set(tabId, { attached: true });
    return true;
  } catch {
    return false;
  }
}

function detachDebugger(tabId) {
  if (debuggerTabMap.get(tabId)?.attached) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    debuggerTabMap.delete(tabId);
  }
}

// Detach debugger when tab closes — prevents stale debugger sessions
chrome.tabs.onRemoved.addListener((tabId) => {
  detachDebugger(tabId);
});

async function evalInPage(tabId, expression, timeoutMs = 8000) {
  if (!await attachDebugger(tabId)) return { ok: false, error: 'debugger unavailable' };
  try {
    const result = await withTimeout(
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }),
      timeoutMs,
      'Runtime.evaluate'
    );
    return { ok: true, value: result?.result?.value };
  } catch (e) {
    detachDebugger(tabId);
    return { ok: false, error: e.message };
  }
}

function makeActionEval(action) {
  const a = JSON.stringify(action);
  return `(() => {
    const a = ${a};
    try {
      if (a.type === 'navigate' || a.type === 'done') return { ok: true, type: a.type };
      let el = a.selector ? document.querySelector(a.selector) : null;
      if (a.selector && !el) {
        // Playwright :has-text()/:text() fallback — not valid CSS.
        const hm = a.selector.match(/:has-text\(\s*["']([^"']+)["']\s*\)|:text\(\s*["']([^"']+)["']\s*\)/i);
        if (hm) {
          const ht = (hm[1] || hm[2]).toLowerCase().trim();
          for (const c of document.querySelectorAll('a, button, [role=button], [onclick], input[type=submit], input[type=button]')) {
            if ((c.textContent || '').trim().toLowerCase().includes(ht)) { el = c; break; }
          }
        }
      }
      if (a.selector && !el) return { ok: false, error: 'Element not found: ' + a.selector, type: a.type };
      switch (a.type) {
        case 'click':
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true, type: 'click' };
        case 'fill':
          el.focus();
          el.value = '';
          el.value = a.value;
          if (el.tagName === 'SELECT' && el.selectedIndex === -1) {
            var _want = String(a.value == null ? '' : a.value).trim().toLowerCase();
            if (_want) {
              var _opts = [].slice.call(el.options || []);
              var _opt = _opts.find(function(o){ return (o.textContent || '').trim().toLowerCase() === _want; }) ||
                _opts.find(function(o){ return (o.textContent || '').trim().toLowerCase().indexOf(_want) === 0; });
              if (_opt) el.value = _opt.value;
            }
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, type: 'fill' };
        case 'extract':
          return { ok: true, type: 'extract', value: (a.attribute ? el.getAttribute(a.attribute) : el.textContent?.trim()) || '' };
        case 'scroll':
          const amt = a.amount || innerHeight * 0.7;
          scrollBy({ left: 0, top: a.direction === 'up' ? -amt : amt, behavior: 'smooth' });
          return { ok: true, type: 'scroll' };
        case 'wait':
          return new Promise(r => setTimeout(() => r({ ok: true, type: 'wait' }), a.ms || 1000));
        default:
          return { ok: false, error: 'Unknown action: ' + a.type };
      }
    } catch(e) { return { ok: false, error: e.message, type: a.type }; }
  })()`;
}



async function getActiveTabContext(tabId, tier, modeId, opts) {
  const __t0 = perfNow(); // #67 capture-duration telemetry
  try {
    return await getActiveTabContextImpl(tabId, tier, modeId, opts);
  } finally {
    debugLog.push('capture', opts?.pull ? `capture:${opts.pull}` : 'capture', perfNow() - __t0, { tier });
  }
}

async function getActiveTabContextImpl(tabId, tier, modeId, opts) {
  // Normalize the tier. tier 0 = URL/title/viewport only; 1 = +text;
  // 2 = +clickable+forms (with selectors); 3 = +screenshot. Unknown → 2.
  const t = (typeof tier === 'number' && tier >= 0 && tier <= 3) ? tier : 2;
  // opts.pull — capture-shape hint from the pull loop (#24): 'page' raises the
  // text budget (read_page), 'dom' raises element caps (get_dom), 'form'
  // returns all form fields (get_form). Null/unknown = normal prompt capture.
  const pull = opts && typeof opts.pull === 'string' ? opts.pull : null;
  const textBudget = pull === 'page' ? 20000 : (t >= 1 ? 4000 : 2000); // upper bound at capture; Mode re-slices in buildPrompt
  const formCap = pull === 'form' ? 300 : pull === 'dom' ? 150 : 30;
  const clickCap = pull === 'dom' ? 200 : 50;
  // opts.skipDebugger — skip the CDP fast-path. Used for background-tab
  // captures (tab contexts / read_tab) so the "is being debugged" banner
  // never appears on a tab the user isn't looking at.
  const skipDebugger = !!(opts && opts.skipDebugger);

  let tab;
  if (tabId) {
    // Look up the full tab so we have windowId for captureVisibleTab; fall
    // back to the synthesized object if the lookup fails (tab closed, etc.).
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = { id: tabId };
    }
  } else {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  }
  if (!tab?.id) return { error: 'No active tab' };

  // Cold start: a blank/new-tab page has no content to capture — return
  // metadata only, before any capture path (no debugger attach/banner, no
  // doomed script injections). The `blank` stamp lets the read_tab loop and
  // the sidepanel treat it as "no page" rather than a capture failure.
  if (isBlankPage(tab.url)) {
    return { url: tab.url || '', title: tab.title || '', tabId: tab.id, blank: true };
  }

  let context;

  // Inlined selector builder — kept in sync with content.js buildSelector.
  // Used by the CDP + executeScript paths so tier-2 selectors work everywhere,
  // not just when the content script is present.
  const SEL_HELPER = `function sel(el){
    if(el.id)try{return '#'+CSS.escape(el.id);}catch(e){}
    if(el.name && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName))return el.tagName.toLowerCase()+'[name="'+CSS.escape(el.name)+'"]';
    var s=el.tagName.toLowerCase();
    if(el.className&&typeof el.className==='string'){var cs=el.className.trim().split(/\\s+/).filter(Boolean).slice(0,3);if(cs.length)s+=cs.map(function(c){return '.'+(window.CSS&&CSS.escape?CSS.escape(c):c);}).join('');}
    var p=el.parentElement;if(p){var sib=Array.from(p.children).filter(function(x){return x.tagName===el.tagName;});if(sib.length>1){s+=':nth-of-type('+(sib.indexOf(el)+1)+')';}}
    return s;
  }`;

  // Path 1: Debugger-based eval (fastest, works on any page)
  if (!skipDebugger) {
    try {
    var captureExpr;
    if (t === 0) {
      captureExpr = `(function(){return{url:location.href,title:document.title,viewport:{w:window.innerWidth,h:window.innerHeight}};})()`;
    } else if (t === 1) {
      captureExpr = `(function(){var m=document.querySelector('main,article,[role=main],#content,.content');var b=document.body;var tx=(m||b)?.innerText||'';return{url:location.href,title:document.title,visibleText:tx.substring(0,${textBudget}),viewport:{w:window.innerWidth,h:window.innerHeight}};})()`;
    } else {
      captureExpr = `(function(){${SEL_HELPER}
        var m=document.querySelector('main,article,[role=main],#content,.content');var b=document.body;var tx=(m||b)?.innerText||'';
        function qfor(el){var lab=el.id?document.querySelector('label[for="'+(window.CSS&&CSS.escape?CSS.escape(el.id):el.id)+'"]'):null;if(lab&&(lab.textContent||'').trim())return lab.textContent.trim().substring(0,120);var ar=(el.getAttribute('aria-label')||'').trim();if(ar)return ar.substring(0,120);var sc=el;for(var i=0;i<8&&sc;i++){var sib=sc.previousElementSibling;while(sib){var t=(sib.innerText||'').trim();if(t&&t.length<=160&&!/^(ok|next|submit|start|back)$/i.test(t)&&!sib.querySelector('button, a[href], input, textarea, select'))return t.replace(/\\s+/g,' ').substring(0,120);sib=sib.previousElementSibling;}sc=sc.parentElement;}return '';}
        var ff=[];document.querySelectorAll('input:not([type=hidden]),textarea,select').forEach(function(el){var r=el.getBoundingClientRect();if(r.width===0||r.height===0)return;ff.push({tag:el.tagName.toLowerCase(),type:el.type||'text',name:el.name||el.id||'',selector:sel(el),placeholder:el.placeholder||'',question:qfor(el)});});
        var ck=[];document.querySelectorAll('a,button,[role=button],[onclick],input[type=submit],input[type=button]').forEach(function(el){var r=el.getBoundingClientRect();if(r.width<8||r.height<8)return;var tx=(el.textContent||el.value||'').trim().substring(0,60);if(!tx)return;ck.push({text:tx,tag:el.tagName.toLowerCase(),selector:sel(el)});});
        return{url:location.href,title:document.title,visibleText:tx.substring(0,${textBudget}),formFields:ff.slice(0,${formCap}),clickable:ck.slice(0,${clickCap}),viewport:{w:window.innerWidth,h:window.innerHeight}};
      })()`;
    }
    var result = await evalInPage(tab.id, captureExpr, 5000);
    if (result.ok && result.value && result.value.url) context = result.value;
    } catch(e) {
      // debugger not available — fall through
    }
  }

  // Path 2: Content script
  if (!context) {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_CONTEXT', tier: t, pull });
      if (resp && !resp.error) context = resp;
    } catch {
      // content script not injected — fall through
    }
  }

  // Path 3: executeScript fallback
  if (!context) {
    try {
      let captureFn;
      if (t === 0) {
        captureFn = () => ({ url: location.href, title: document.title, viewport: { w: window.innerWidth, h: window.innerHeight } });
      } else if (t === 1) {
        captureFn = (pull) => {
          const m = document.querySelector('main, article, [role="main"], #content, .content');
          const text = (m || document.body)?.innerText || '';
          return { url: location.href, title: document.title, visibleText: text.substring(0, pull === 'page' ? 20000 : 4000), viewport: { w: window.innerWidth, h: window.innerHeight } };
        };
      } else {
        captureFn = (pull) => {
          // Inlined selector builder (mirror of content.js buildSelector).
          function sel(el) {
            if (el.id) { try { return '#' + CSS.escape(el.id); } catch (e) {} }
            if (el.name && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
            let s = el.tagName.toLowerCase();
            if (el.className && typeof el.className === 'string') { const cs = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3); if (cs.length) s += cs.map((c) => '.' + (window.CSS && CSS.escape ? CSS.escape(c) : c)).join(''); }
            const p = el.parentElement; if (p) { const sib = Array.from(p.children).filter((x) => x.tagName === el.tagName); if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')'; }
            return s;
          }
          // Nearest question title (mirror of content.js#nearestQuestion):
          // explicit label/aria first, then title-above-field sibling climb.
          function nearestQuestion(el) {
            const id = el.id;
            if (id) {
              const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              if (lab && (lab.textContent || '').trim()) return lab.textContent.trim().slice(0, 120);
            }
            const aria = (el.getAttribute('aria-label') || '').trim();
            if (aria) return aria.slice(0, 120);
            let scope = el;
            for (let i = 0; i < 8 && scope; i++) {
              let sib = scope.previousElementSibling;
              while (sib) {
                const txt = (sib.innerText || '').trim();
                if (txt && txt.length <= 160 && !/^(ok|next|submit|start|back)$/i.test(txt) &&
                    !sib.querySelector('button, a[href], input, textarea, select')) {
                  return txt.replace(/\s+/g, ' ').slice(0, 120);
                }
                sib = sib.previousElementSibling;
              }
              scope = scope.parentElement;
            }
            return '';
          }
          const formCap = pull === 'form' ? 300 : pull === 'dom' ? 150 : 30;
          const clickCap = pull === 'dom' ? 200 : 50;
          const m = document.querySelector('main, article, [role="main"], #content, .content');
          const text = (m || document.body)?.innerText || '';
          const formFields = [];
          document.querySelectorAll('input:not([type="hidden"]), textarea, select').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            formFields.push({ tag: el.tagName.toLowerCase(), type: el.type || 'text', name: el.name || el.id || '', selector: sel(el), placeholder: el.placeholder || '', question: nearestQuestion(el) });
          });
          const clickable = [];
          document.querySelectorAll('a, button, [role="button"], [onclick], input[type="submit"], input[type="button"]').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return;
            const tx = (el.textContent || el.value || '').trim().substring(0, 60);
            if (!tx) return;
            clickable.push({ text: tx, tag: el.tagName.toLowerCase(), selector: sel(el) });
          });
          return { url: location.href, title: document.title, visibleText: text.substring(0, 4000), formFields: formFields.slice(0, formCap), clickable: clickable.slice(0, clickCap), viewport: { w: window.innerWidth, h: window.innerHeight } };
        };
      }
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureFn, args: [pull] });
      context = result?.result || { error: 'Could not capture context' };
    } catch (err) {
      context = { error: err.message };
    }
  }

  // Capture screenshot only when the tier asks for it (3), the global
  // kill-switch hasn't disabled screenshots, AND the selected model can
  // plausibly consume an image (#25 vision gate). A non-vision model
  // would make the capture pure token waste; the catalog lookup is
  // no-auth + cached, and unknown support falls through to capture
  // (backward-compatible with pre-#25 behavior).
  // Every non-capture path on a tier-3 turn records WHY in
  // context.screenshotError — a forced Visual turn must never silently
  // degrade to text-only (the 📷 toggle's honest-feedback contract).
  if (t >= 3 && context && !context.error) {
    if (config.enableScreenshots === false) {
      context.screenshotError = 'Screenshots are disabled in Zo settings';
    } else {
      try {
        const catalog = await fetchModelCatalog();
        const entry = findModelEntry(catalog, config.zoModel);
        if (shouldCaptureScreenshot(entry, { tier: t, enableScreenshots: config.enableScreenshots })) {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg' });        context.screenshotDataUrl = dataUrl;
          if (!dataUrl) context.screenshotError = 'Screenshot capture returned empty data';
        } else {
          context.screenshotError = `Model “${config.zoModel || 'default'}” doesn't support images — pick a vision model to use the 📷 toggle`;
        }
      } catch (e) {
        console.warn('Screenshot capture skipped:', e.message);
        context.screenshotError = e.message;
      }
    }
  }

  // Stamp the source tab so callers (sidepanel currentContext) can key
  // active-tab logic off it — GET_TAB_CONTEXTS' isActive dedup and the
  // auto-referenced active tab both depend on this id.
  if (context && !context.error && !('tabId' in context)) {
    context.tabId = tab.id;
  }

  return context;
}

// ---- Prompt assembly (shared by streaming + non-streaming paths) ----
// buildPrompt() + compactEl/compactForm/safeText live in ./lib/prompt.js now
// (pure, shared with the side-panel inspector + Settings editor). The two
// call sites below pass { effectiveTier } when the context policy has thinned
// the turn to a lower tier than the Mode's default.
// ---- Tab contexts (referenced tabs as manifest + excerpt) ----

/**
 * Capture tier-2 context for each referenced tab (skipDebugger — background
 * tabs must not get the debugger banner) and reduce it to the TabContext
 * shape the prompt manifest + chip pills consume. Never throws: a dead tab or
 * failed capture degrades to available:false (manifest line: "unavailable,
 * URL only").
 */
async function getTabContexts(tabIds, activeTabId) {
  const out = await Promise.all((tabIds || []).map(async (tabId) => {
    const base = { tabId, title: '', url: '', host: '', textLength: 0, elementCount: 0, excerpt: '', isActive: tabId === activeTabId, available: false };
    try {
      const tab = await chrome.tabs.get(tabId);
      base.title = tab.title || '';
      base.url = tab.url || '';
      base.host = hostOf(base.url);
      // Blank/new-tab pages have nothing to capture — keep the degraded base
      // (they never appear in the chip strip; this covers direct GET_TAB_CONTEXTS callers).
      if (isBlankPage(base.url)) return base;
      const c = await getActiveTabContext(tabId, 2, null, { skipDebugger: true });
      if (c && !c.error) {
        base.available = true;
        base.textLength = (c.visibleText || '').length;
        base.elementCount = Array.isArray(c.clickable) ? c.clickable.length : 0;
        base.excerpt = (c.visibleText || '').slice(0, 500);
      }
    } catch { /* tab closed or capture failed — keep the degraded base */ }
    return base;
  }));
  return { tabs: out };
}

// ---- Streaming port handler ----

/** Persistent port connections from sidepanel for streaming Zo responses. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cobrowse-stream') return;

  // Track disconnects so streaming code can stop posting to a dead port
  // instead of throwing "Attempting to use a disconnected port object".
  port.onDisconnect.addListener(() => { port._dead = true; });

  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case 'ASK_ZO': {
        const __t0 = perfNow(); // #67 stream-duration telemetry
        try {
          await askZoStream(port, msg);
          debugLog.push('stream', 'askZoStream:done', perfNow() - __t0, { tier: msg.effectiveTier });
        } catch (err) {
          debugLog.push('stream', 'askZoStream:error', perfNow() - __t0, { tier: msg.effectiveTier });
          // Final failure after retries (or a non-retriable error). Only try
          // to surface it if the port is still alive.
          safePost(port, { sessionId: msg.sessionId, type: 'STREAM_ERROR', error: `Failed: ${err.message}` });
        }
        break;
      }
      case 'NEW_CONVERSATION': {
        zoConversationId = null;
        chrome.storage.session.set({ zoConversationId: null }).catch(e => console.debug('session.set:', e));
        break;
      }
    }
  });
});

// ---- Context Menu ----

const CONTEXT_MENU_ITEMS = [
  { id: 'cobrowse-page',      title: 'Ask Zo about this page',      contexts: ['page'] },
  { id: 'cobrowse-save',      title: 'Save page to Zo workspace',   contexts: ['page'] },
  { id: 'cobrowse-selection', title: 'Ask Zo about this selection', contexts: ['selection'] },
  { id: 'cobrowse-link',      title: 'Ask Zo about this link',      contexts: ['link'] },
  { id: 'cobrowse-fill',      title: 'Ask Zo to fill this field',   contexts: ['editable'] },
];

function recreateContextMenus() {
  chrome.contextMenus.removeAll(() => {
    const menus = config.enabledMenus || DEFAULTS.enabledMenus;
    for (const item of CONTEXT_MENU_ITEMS) {
      if (menus[item.contexts[0]]) {
        chrome.contextMenus.create({
          id: item.id,
          title: item.title,
          contexts: item.contexts,
        });
      }
    }
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let query = '';
  let contextType = info.menuItemId;

  switch (info.menuItemId) {
    case 'cobrowse-page':
      query = 'Analyze this page and give me a summary of what it contains.';
      break;
    case 'cobrowse-save': {
      // Save page content to Zo workspace
      try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        await new Promise(r => setTimeout(r, 500));
        const pageContext = await getActiveTabContext(tab.id);
        const result = await savePageToWorkspace(pageContext);
        await chrome.storage.session.set({ pendingZoQuery: { text: result.ok ? `✅ Saved to ${result.path}` : `❌ Save failed: ${result.error}`, source: 'save', personaId: null } });
        chrome.runtime.sendMessage({ type: 'PENDING_ZO_QUERY', text: result.ok ? `✅ Saved to ${result.path}` : `❌ Save failed: ${result.error}`, source: 'save' }).catch(() => {});
      } catch (err) {
        console.error('Save from context menu error:', err);
      }
      return;
    }
    case 'cobrowse-selection':
      query = info.selectionText
        ? `Explain or act on this selection: ${info.selectionText.substring(0, 2000)}`
        : 'Analyze this page.';
      break;
    case 'cobrowse-link':
      query = info.linkUrl
        ? `Visit and analyze this link: ${info.linkUrl}`
        : 'Analyze this link.';
      break;
    case 'cobrowse-fill':
      query = 'Fill this form field based on the page context.';
      break;
  }

  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    // Small delay for sidepanel to initialize
    await new Promise(r => setTimeout(r, 500));
    // Store pending query for sidepanel to pick up
    await chrome.storage.session.set({ pendingZoQuery: { text: query, source: contextType, personaId: null } });
    // Broadcast to sidepanel if already open — also clear so subsequent init checks don't re-fire
    chrome.runtime.sendMessage({ type: 'PENDING_ZO_QUERY', text: query, source: contextType }).catch(() => {});
  } catch (err) {
    console.error('Context menu error:', err);
  }
});

// Re-create context menus on every service worker wake-up (MV3: SW restarts lose menus)
recreateContextMenus();

// Also re-create on install and browser start

// Clean up debugger state when detached (tab closed, user pressed F12, etc.)
if (chrome.debugger) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) detachDebugger(source.tabId);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  recreateContextMenus();
});
chrome.runtime.onStartup.addListener(() => recreateContextMenus());

// ── Keyboard Shortcuts (chrome.commands) ──
// Commands are registered in manifest.json. MV3 does not support dynamic
// registration; users remap them at chrome://extensions/shortcuts
chrome.commands.onCommand.addListener(async (command, tab) => {
  const activeTab = tab || (await getActiveTab());
  if (!activeTab) return;
  const windowId = activeTab.windowId;

  // Every shortcut opens the side panel first
  try {
    await chrome.sidePanel.open({ windowId });
  } catch (err) {
    console.error('Keyboard shortcut: could not open side panel:', err);
    return;
  }

  // Default: just open the panel (no query). Used by _execute_action.
  let query = '';
  let source = command;

  switch (command) {
    case 'summarize-page':
      query = 'Summarize this page in 3-5 bullet points and highlight anything actionable.';
      source = 'shortcut-summarize';
      break;
    case 'new-chat':
      // Signal sidepanel to start a fresh conversation, then open
      query = '';
      source = 'shortcut-new-chat';
      break;
    case 'extract-page':
      query = 'Extract the key data from this page into a structured table.';
      source = 'shortcut-extract';
      break;
    case '_execute_action':
      // Plain toolbar button / open-panel shortcut — no query
      return;
  }

  // Small delay for sidepanel to initialize before we hand off the query
  await new Promise(r => setTimeout(r, 400));

  if (source === 'shortcut-new-chat') {
    chrome.runtime
      .sendMessage({ type: 'NEW_CONVERSATION', source: 'shortcut' })
      .catch(() => {});
    return;
  }

  await chrome.storage.session.set({ pendingZoQuery: { text: query, source } });
  chrome.runtime
    .sendMessage({ type: 'PENDING_ZO_QUERY', text: query, source })
    .catch(() => {});
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ── Omnibox Commands (chrome.omnibox) ──
// Users type "zo <query>" in the address bar. We provide suggestions for
// known !commands and route everything else to the side panel as a query.
const OMNIBOX_COMMANDS = {
  'summarize': 'Summarize this page',
  'extract': 'Extract structured data from this page',
  'research': 'Deep research on the current page topic',
  'help': 'Show available Zo commands',
};

chrome.omnibox.onInputStarted.addListener(() => {
  chrome.omnibox.setDefaultSuggestion({
    description: 'zo — Ask Zo about this page (type a question or command)',
  });
});

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) {
    chrome.omnibox.setDefaultSuggestion({
      description: 'zo — Type a question or !command (try: summarize, extract, research)',
    });
    return;
  }

  // Check if user is typing a known command
  const matching = Object.entries(OMNIBOX_COMMANDS)
    .filter(([cmd]) => cmd.startsWith(trimmed));

  if (matching.length) {
    const suggestions = matching.map(([cmd, desc]) => ({
      content: cmd,
      description: `zo ${cmd} — ${desc}`,
    }));
    suggest(suggestions);
    chrome.omnibox.setDefaultSuggestion({
      description: `zo ${trimmed} — ${matching[0][1]}`,
    });
  } else {
    chrome.omnibox.setDefaultSuggestion({
      description: `zo ${text} — Ask Zo: "${text}"`,
    });
  }
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const query = text.trim();
  if (!query) return;

  // Normalize !commands typed without the bang
  let normalizedQuery = query;
  if (OMNIBOX_COMMANDS[query.toLowerCase()]) {
    normalizedQuery = `!${query.toLowerCase()}`;
  }

  // Open side panel and push the query
  const tab = await getActiveTab();
  if (tab) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    await sleep(300);
    await chrome.storage.session.set({
      pendingZoQuery: { text: normalizedQuery, source: 'omnibox', ts: Date.now() },
    });
  }
});
async function _askZoStreamImpl(port, msg) {
  const { pageContext, userQuery, modelName, personaId, modeId, customModes, effectiveTier, modeOverrides } = msg;
  const sid = msg.sessionId;

  if (!config.zoAccessToken) {
    safePost(port, { sessionId: sid, type: 'STREAM_ERROR', error: '❌ Zo access token not configured. Open extension settings to set it up.' });
    return;
  }

  // Resolve the Mode — single source of truth for prompt + context tier.
  const mode = resolveMode(modeId || config.zoActiveMode || DEFAULT_MODE_ID, customModes || {}, modeOverrides || {});
  // Persona is now orthogonal: the dropdown chooses it, else it falls back to
  // the configured default persona id. No lite/full routing.
  const resolvedPersonaId = personaId || config.zoPersonaId || '';

  // Pull-loop state (#24 — read_tab / read_page / get_dom / get_form).
  // Created fresh for a user turn; the follow-up cycles below re-enter with
  // _loop + _followUpInput (the pre-assembled follow-up bypasses buildPrompt —
  // it is a tool-result turn, not a user turn). `threadId` carries the per-chat
  // Zo thread: initialized from the payload's stored id, then advanced at each
  // capture point so a mid-loop rotation can't strand follow-up cycles on a
  // stale thread.
  const loop = msg._loop || {
    tabContexts: Array.isArray(msg.tabContexts) ? msg.tabContexts.filter((t) => t && typeof t === 'object') : [],
    cyclesUsed: 0,
    budgetSent: false,
    threadId: msgThreadId(msg.conversationId) || null,
    msg,
    mode,
  };

  // effectiveTier is resolved by the side-panel context policy (opt-in DOM +
  // send-once) and passed on the ASK_ZO payload. When absent (legacy callers),
  // buildPrompt falls back to the Mode's configured tier.
  // #69: msg.shotOnly (DOM toggle off + 📷 armed) renders the ## Screenshot
  // section at tier 0 — pixels ride even though the DOM is capped out.
  const prompt = msg._followUpInput || buildPrompt(mode, pageContext, userQuery, { effectiveTier, ...(msg.shotOnly ? { screenshotOnly: true } : {}), tabContexts: loop.tabContexts, skills: msg.skills, workspaceFiles: msg.workspaceFiles });

  try {
    const response = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        input: prompt,
        model_name: (modelName || config.zoModel) || undefined,
        // Per-chat thread id first (chat tabs); the global covers ambient callers.
        conversation_id: (loop.threadId ?? zoConversationId) || undefined,
        stream: true,
        ...(resolvedPersonaId ? { persona_id: resolvedPersonaId } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const errMsg = `Zo API error: ${response.status}${body ? ' — ' + body.substring(0, 200) : ''}`;
      safePost(port, { sessionId: sid, type: 'STREAM_ERROR', error: errMsg });
      // Surface 4xx as a thrown retriable=false error so the retry wrapper stops.
      if (response.status >= 400 && response.status < 500) {
        const e = new Error(errMsg); throw e;
      }
      return;
    }

    // Handle non-streaming JSON responses (models that don't support SSE)
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const data = await response.json();
        if (data.conversation_id) { zoConversationId = data.conversation_id; loop.threadId = data.conversation_id; chrome.storage.session.set({ zoConversationId }).catch(e => console.debug('session.set:', e)); }
        await finishStreamWithPullLoop(port, sid, data.output || '', {}, loop);
      } catch (e) {
        safePost(port, { sessionId: sid, type: 'STREAM_ERROR', error: `Non-streaming parse error: ${e.message}` });
      }
      return;
    }

    // Capture conversation_id from response headers
    const convHeaderId = response.headers.get('x-conversation-id');
    if (convHeaderId) { zoConversationId = convHeaderId; loop.threadId = convHeaderId; chrome.storage.session.set({ zoConversationId }).catch(e => console.debug('session.set:', e)); }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    // Three live channels, parsed from the real Zo SSE protocol (PartStartEvent
    // / PartDeltaEvent / FunctionToolCall|ResultEvent / completed). See
    // tests/test-prompts/qa-notes.md — the documented FrontendModelResponse/End
    // protocol is never emitted by the live API; these are what it actually sends.
    // - partKinds: maps a part `index` → 'thinking'|'text'|'tool-call'|'tool-return'
    //   (PartStartEvent declares the kind; PartDeltaEvent may repeat it in
    //   delta.part_delta_kind). Lets us route each delta to the right channel.
    // - reasoningText: accumulated thinking-channel text, streamed live via
    //   STREAM_REASONING and passed to finishStream so STREAM_DONE carries it.
    const partKinds = {};
    let reasoningText = '';
    // Stream-shape discovery: per-session union of fields seen for each SSE
    // `event:` type, plus any events we don't consume. The runtime shape is
    // genuinely unknown (previous captures never surfaced richer events like
    // tool traces / sources / streaming reasoning). This collector makes it
    // observable: log once per stream + forward in STREAM_DONE.diagnostic so
    // the side panel can surface it and we can close the gap.
    const eventShapes = {};
    sessionEventShapes = eventShapes;

    let currentEventType = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('event: ')) {
          currentEventType = trimmed.slice(7).trim();
          continue;
        }
        // Also handle event: without trailing space (valid SSE)
        if (trimmed.startsWith('event:')) {
          currentEventType = trimmed.slice(6).trim();
          continue;
        }

        // Handle both data: (with space) and data: (without space)
        const dataMatch = trimmed.match(/^data:\s?(.*)$/);
        if (dataMatch) {
          const data = dataMatch[1].trim();
          if (!data) continue;

          // End event — stream completed
          if (currentEventType === 'End') {
            let endPayload = fullText;  // default: keep any streamed text
            if (data !== '{}' && data !== '') {
              try {
                const parsed = JSON.parse(data);
                // Don't clobber accumulated streamed text with the final payload
                // unless we never received incremental chunks.
                if (!fullText) {
                  // Prefer the documented output field, then any content field.
                  // Pass the parsed object straight through to finishStream so it
                  // can normalize actions (key-first → type-first) and resolve the
                  // done.response without first stringifying then re-parsing.
                  const endContent = typeof parsed.output === 'string' ? parsed.output : '';
                  endPayload = endContent || extractStreamContent(parsed) || parsed;
                }
              } catch {}
            }
            finishStreamWithPullLoop(port, sid, endPayload, { reasoning: reasoningText }, loop);
            currentEventType = '';
            return;
          }

          // Error event
          if (currentEventType === 'Error') {
            try {
              const parsed = JSON.parse(data);
              safePost(port, { sessionId: sid, type: 'STREAM_ERROR', error: parsed.message || 'Stream error' });
            } catch {
              safePost(port, { sessionId: sid, type: 'STREAM_ERROR', error: data });
            }
            currentEventType = '';
            return;
          }

          // Terminal: real Zo streams end with `event: completed` (status
          // succeeded/failed), NOT `End`. Treat as the canonical terminal —
          // but a `completed` payload that reports status:"failed" carries a
          // server-side error (HTTP is still 200); surface it instead of
          // finishing "empty".
          if (currentEventType === 'completed') {
            let failedMsg = '';
            try {
              const parsed = JSON.parse(data);
              if (parsed && parsed.status === 'failed') failedMsg = safeText(parsed.error || parsed.message) || 'Stream failed';
            } catch { /* empty/non-JSON payload = plain success terminal */ }
            if (failedMsg) {
              safePost(port, { sessionId: sid, type: 'STREAM_ERROR', error: failedMsg });
            } else {
              await finishStreamWithPullLoop(port, sid, fullText, { reasoning: reasoningText }, loop);
            }
            currentEventType = '';
            return;
          }

          // Terminal: a failed run is reported as `event: failed` with
          // {status:"failed", error, error_type, failure_kind, ...} — over
          // HTTP 200 (live-verified 2026-08-19, e.g. "Unknown model: …").
          // Without this branch the error payload is dropped and the turn
          // surfaces as an empty response.
          if (currentEventType === 'failed') {
            let errMsg = 'Stream failed';
            try {
              const parsed = JSON.parse(data);
              errMsg = safeText(parsed.error || parsed.message) || errMsg;
              if (parsed.error_type) errMsg += ` (${parsed.error_type})`;
            } catch { /* keep the generic message */ }
            safePost(port, { sessionId: sid, type: 'STREAM_ERROR', error: errMsg });
            currentEventType = '';
            return;
          }

          try {
            const parsed = JSON.parse(data);
            // Stream-shape discovery: fold this chunk's top-level field names
            // into the per-event union for this session. Also record events we
            // otherwise ignore (tool_use/sources/citation/... if any).
            const key = currentEventType || '(no event)';
            eventShapes[key] = eventShapes[key] || new Set();
            Object.keys(parsed).forEach((k) => eventShapes[key].add(k));

            // ── Real Zo protocol (see tests/test-prompts/qa-notes.md) ──────────
            // PartStartEvent declares a new part's kind and carries its first
            // content piece. Route that piece to the right channel immediately
            // (otherwise the first token of every part is lost).
            if (currentEventType === 'PartStartEvent') {
              const part = parsed.part || {};
              if (part.part_kind) partKinds[parsed.index] = part.part_kind;
              const kind = part.part_kind || partKinds[parsed.index] || '';
              const piece = safeText(part.content || part.args);
              if (piece && kind) {
                if (kind === 'thinking') {
                  reasoningText += piece;
                  // For chronological feed, send only the delta (not cumulative text)
                  safePost(port, { sessionId: sid, type: 'STREAM_REASONING', text: piece });
                } else if (kind === 'text') {
                  fullText += piece;
                  // For chronological feed, send only the delta (not cumulative text)
                  // so the side panel can append each piece without repetition.
                  safePost(port, { sessionId: sid, type: 'STREAM_CHUNK', text: piece });
                }
              }
              currentEventType = '';
              continue;
            }
            // PartDeltaEvent is the workhorse: incremental content with an
            // explicit part_delta_kind ('thinking' for reasoning, 'text' for
            // the answer). Routing on this kind is what keeps the three
            // channels separate instead of concatenated into one fullText.
            if (currentEventType === 'PartDeltaEvent') {
              const delta = parsed.delta || {};
              const kind = delta.part_delta_kind || partKinds[parsed.index] || '';
              const piece = safeText(delta.content_delta);
              if (piece && kind) {
                if (kind === 'thinking') {
                  reasoningText += piece;
                  // For chronological feed, send only the delta (not cumulative text)
                  safePost(port, { sessionId: sid, type: 'STREAM_REASONING', text: piece });
                } else if (kind === 'text') {
                  fullText += piece;
                  // For chronological feed, send only the delta (not cumulative text)
                  // so the side panel can append each piece without repetition.
                  safePost(port, { sessionId: sid, type: 'STREAM_CHUNK', text: piece });
                } else if (kind === 'tool-call' || kind === 'tool-return') {
                  // Tool arg/result deltas stream into the tool-call part; the
                  // structured FunctionTool events below carry the canonical
                  // call/result, so delta pieces are folded into diagnostics
                  // only (the side panel renders the structured card).
                }
              } else {
                // Unknown shape — fall back to content extraction so a valid
                // response is never dropped (OpenAI/Anthropic/etc. providers).
                const content = extractStreamContent(parsed);
                if (content) {
                  fullText += content;
                  safePost(port, { sessionId: sid, type: 'STREAM_CHUNK', text: content });
                }
              }
              currentEventType = '';
              continue;
            }
            // FunctionToolCallEvent — a tool was invoked. Surface as the
            // "Explored" channel (🔍 in the side panel).
            if (currentEventType === 'FunctionToolCallEvent' || (parsed.event_kind === 'function_tool_call')) {
              const part = parsed.part || {};
              safePost(port, {
                sessionId: sid,
                type: 'STREAM_TOOL',
                phase: 'call',
                callId: part.tool_call_id,
                toolName: part.tool_name,
                args: safeText(part.args),
              });
              currentEventType = '';
              continue;
            }
            // FunctionToolResultEvent — a tool returned. Mark the card done/error.
            if (currentEventType === 'FunctionToolResultEvent' || (parsed.event_kind === 'function_tool_result')) {
              const result = parsed.result || {};
              const part = parsed.part || {};
              safePost(port, {
                sessionId: sid,
                type: 'STREAM_TOOL',
                phase: 'result',
                callId: part.tool_call_id || result.tool_call_id,
                toolName: part.tool_name || result.tool_name,
                outcome: result.outcome || (result.error ? 'error' : 'success'),
                result: summarizeToolResult(result),
              });
              currentEventType = '';
              continue;
            }

            // ── Documented protocol (synthetic fixtures) + legacy fallback ─────
            // FrontendModelResponse / data-only / OpenAI / Anthropic shapes.
            const content = extractStreamContent(parsed);
            if (content) {
              fullText += content;
              safePost(port, { sessionId: sid, type: 'STREAM_CHUNK', text: fullText });
            }
            // Legacy finish check for non-Zo SSE formats (OpenAI, Anthropic style)
            if (parsed.done || parsed.finish_reason || parsed.type === 'final' || parsed.type === 'complete' || parsed.type === 'End') {
              if (parsed.output && !fullText) fullText = safeText(parsed.output);
              else if (parsed.type === 'End' && parsed.reasoning && !fullText) fullText = safeText(parsed);
              await finishStreamWithPullLoop(port, sid, fullText, { reasoning: reasoningText }, loop);
              return;
            }
          } catch {
            // Plain text SSE (e.g. [DONE])
            if (data === '[DONE]') {
              await finishStreamWithPullLoop(port, sid, fullText, { reasoning: reasoningText }, loop);
              return;
            }
            fullText += safeText(data);
            safePost(port, { sessionId: sid, type: 'STREAM_CHUNK', text: fullText });
          }
        }
      }
    }

    // Stream ended (no End event received — graceful fallback)
    await finishStreamWithPullLoop(port, sid, fullText, { reasoning: reasoningText }, loop);
  } catch (err) {
    // No STREAM_ERROR post here (QA finding D): askZoStream may retry this
    // error, and a transient error post kills the panel's session before the
    // Reconnecting banner can show. Terminal surfacing belongs to the ASK_ZO
    // handler's catch — after retries are exhausted — and to the specific
    // branches above that post AND return/throw non-retriably.
    throw err;
  }
}

// Per-session stream-shape collector (see _askZoStreamImpl). finishStream
// reads + clears it so the STREAM_DONE envelope can carry a diagnostic of the
// events/fields Zo actually emitted. Module-level because finishStream is
// reached from many terminal branches in the stream loop.
let sessionEventShapes = null;

/**
 * Emit a shape-diagnostic in STREAM_DONE (and console) describing the SSE
 * events/fields Zo actually produced this stream. This is how we learn whether
 * richer content (tool traces, sources, streaming reasoning) is available but
 * currently unparsed — the repo has never captured a real rich chunk.
 */
function emitStreamDiagnostic(port, sid) {
  if (!sessionEventShapes || !Object.keys(sessionEventShapes).length) return;
  const diagnostic = {};
  for (const [ev, fields] of Object.entries(sessionEventShapes)) {
    diagnostic[ev] = Array.from(fields).sort();
  }
  try { console.debug('[zo-cobrowse] stream shape:', diagnostic); } catch {}
  safePost(port, { sessionId: sid, type: 'STREAM_DIAGNOSTIC', diagnostic });
  sessionEventShapes = null;
}

// parseZoOutput lives in lib/parse-output.js (imported above); finishStream
// is its render half.
function finishStream(port, sid, output, extra = {}) {
  const { reasoning: parsedReasoning, actions, rawOutput, plainText, normalizedOutput } = parseZoOutput(output);

  // Live-streamed reasoning (from PartDeltaEvent thinking deltas) wins over
  // any envelope reasoning — it is the real per-token thinking channel and
  // arrives incrementally. Envelope reasoning is a fallback for the legacy
  // {reasoning,actions} object path.
  let reasoning = parsedReasoning;
  if (extra && extra.reasoning) {
    reasoning = safeText(extra.reasoning) || reasoning;
  }

  // Build the user-facing fullText from the resolved response.
  const doneAction = actions.find(a => a.type === 'done');
  const safeDoneResponse = safeText(doneAction?.response);
  const fullText = safeDoneResponse || plainText || reasoning || rawOutput || safeText(normalizedOutput);

  safePost(port, {
    sessionId: sid,
    type: 'STREAM_DONE',
    reasoning,
    actions,
    fullText,
    // The effective Zo thread id for this stream (per-chat when the sidepanel
    // sent one) — echoed back so the sidepanel persists it on the chat.
    conversationId: extra.conversationId,
  });
  // Stream-shape discovery: surface which events/fields Zo actually emitted.
  emitStreamDiagnostic(port, sid);
}

/**
 * finishStream, extended with the read_tab loop (tab contexts). When Zo's
 * response asks to read a referenced tab and the per-turn cycle budget allows,
 * the background: emits a tab-read tool-trace card (STREAM_TOOL), captures the
 * tab (send-once per page hash), and re-enters the stream with the follow-up
 * input — all BEFORE the final STREAM_DONE, so the continuation renders into
 * the same live assistant bubble. `loop` is undefined for callers without tab
 * contexts (legacy paths finish immediately).
 */
async function finishStreamWithPullLoop(port, sid, output, extra, loop) {
  if (!loop || port._dead) {
    finishStream(port, sid, output, extra);
    return;
  }
  // Every finish from here on belongs to this stream's Zo thread — echo it.
  const withThread = { ...extra, conversationId: loop.threadId ?? undefined };
  const reqs = extractPullRequests(parseZoOutput(output).actions);
  if (!reqs.length) {
    finishStream(port, sid, output, withThread);
    return;
  }

  const req = reqs[0]; // one pull per cycle; Zo re-asks for the next in its reply
  if (loop.cyclesUsed >= MAX_PULL_CYCLES || loop.budgetSent) {
    // Budget exhausted (or already told once): send the wrap-up note once,
    // then finish normally even if Zo asks again (pulls no-op downstream).
    loop.budgetSent = true;
    const fu = buildPullFollowUp(req.type, pullTargetFor(req, loop, null), null, { reason: 'budget' });
    loop.cyclesUsed++;
    emitPullTrace(port, sid, req, null, fu);
    await _askZoStreamImpl(port, { ...loop.msg, sessionId: sid, _followUpInput: fu.input, _loop: loop });
    return;
  }

  loop.cyclesUsed++;

  if (req.type === 'read_tab') {
    const tabCtx = (loop.tabContexts || []).find((t) => t && t.ref === req.ref);
    if (!tabCtx) {
      // Unknown/stale ref — tell Zo conversationally so it can recover.
      const fu = buildPullFollowUp('read_tab', { ref: req.ref, title: '', url: '', host: '' }, null);
      emitPullTrace(port, sid, req, null, fu);
      await _askZoStreamImpl(port, { ...loop.msg, sessionId: sid, _followUpInput: fu.input, _loop: loop });
      return;
    }

    const tier = Math.min(Number.isInteger(loop.mode?.contextTier) ? loop.mode.contextTier : 2, 2); // screenshots impossible for background tabs
    const capture = await getActiveTabContext(tabCtx.tabId, tier, null, { skipDebugger: !tabCtx.isActive });
    // A blank capture (new/blank tab navigated to mid-stream) is unreadable —
    // same degraded shape as a failed capture, but with its own reason.
    const good = capture && !capture.error && !capture.blank ? capture : null;
    const pageHash = good ? computePageHash(good, tier >= 1 ? tier : 1) : `closed-${tabCtx.tabId}`;
    // Send-once state is per chat (loop.msg.chatId) — tabsSent dedup must not
    // leak across the sidepanel's chat tabs.
    const chatId = loop.msg?.chatId;
    const state = await loadConversationState(chatId);
    const alreadySent = isTabSentAt(state, tabCtx.tabId, pullHash('read_tab', pageHash));
    const fu = buildPullFollowUp(
      'read_tab',
      tabCtx,
      good,
      capture && capture.blank
        ? { reason: 'blank' }
        : alreadySent
          ? { reason: 'duplicate' }
          : { textBudget: loop.mode?.textBudget }
    );
    if (!alreadySent && good) {
      await saveConversationState(chatId, noteTabSent(state, tabCtx.tabId, pullHash('read_tab', pageHash)));
    }
    emitPullTrace(port, sid, req, tabCtx, fu);
    await _askZoStreamImpl(port, { ...loop.msg, sessionId: sid, _followUpInput: fu.input, _loop: loop });
    return;
  }

  // Active-page pull: read_page / get_dom / get_form. The acting tab is the
  // active web tab (same resolution as send-time capture — ASK_ZO streams
  // arrive from the sidepanel with no usable sender tab).
  const tier = pullTier(req.type);
  const capture = await getActiveTabContext(loop.msg?.tabId || undefined, tier, null, pullCaptureOpts(req.type));
  const good = capture && !capture.error && !capture.blank ? capture : null;
  const pageHash = good ? computePageHash(good, tier) : 'page-unavailable';
  const chatId = loop.msg?.chatId;
  const state = await loadConversationState(chatId);
  const hash = pullHash(req.type, pageHash);
  const sentKey = good?.tabId ?? 'page';
  const alreadySent = isTabSentAt(state, sentKey, hash);
  const fu = buildPullFollowUp(
    req.type,
    pullTargetFor(req, loop, good),
    good,
    capture && capture.blank
      ? { reason: 'blank' }
      : alreadySent
        ? { reason: 'duplicate' }
        : { textBudget: loop.mode?.textBudget }
  );
  if (!alreadySent && good) {
    await saveConversationState(chatId, noteTabSent(state, sentKey, hash));
  }
  emitPullTrace(port, sid, req, pullTargetFor(req, loop, good), fu);
  await _askZoStreamImpl(port, { ...loop.msg, sessionId: sid, _followUpInput: fu.input, _loop: loop });
}

/** {title,url} header target for a pull's follow-up: fresh capture first,
 *  falling back to the send-time pageContext (tier-0 turns still have it). */
function pullTargetFor(req, loop, capture) {
  const pc = (capture && !capture.error && capture) || (loop && loop.msg && loop.msg.pageContext) || {};
  return { title: pc.title || '', url: pc.url || '' };
}

/** Tool-trace card for one pull cycle (the sidepanel's STREAM_TOOL channel). */
function emitPullTrace(port, sid, req, target, fu) {
  const callId = `pull-${sid}-${req.type}${req.ref ? '-' + req.ref : ''}`;
  safePost(port, {
    sessionId: sid,
    type: 'STREAM_TOOL',
    phase: 'call',
    callId,
    toolName: req.ref ? `read_tab ${req.ref}` : req.type,
    args: safeText((target && (target.host || target.title)) || ''),
  });
  safePost(port, {
    sessionId: sid,
    type: 'STREAM_TOOL',
    phase: 'result',
    callId,
    outcome: fu.kind === 'unavailable' ? 'error' : 'ok',
    result: `${fu.kind}`,
  });
}

async function askZo(pageContext, userQuery, modelName, personaId, modeId, customModes, effectiveTier, modeOverrides, conversationId, skills, workspaceFiles, shotOnly) {
  if (!config.zoAccessToken) {
    return { error: '❌ Zo access token not configured. Open extension settings to set it up.' };
  }

  // Resolve the Mode — single source of truth for prompt + context tier.
  const mode = resolveMode(modeId || config.zoActiveMode || DEFAULT_MODE_ID, customModes || {}, modeOverrides || {});
  const resolvedPersonaId = personaId || config.zoPersonaId || '';

  const prompt = buildPrompt(mode, pageContext, userQuery, { effectiveTier, ...(shotOnly ? { screenshotOnly: true } : {}), skills, workspaceFiles });
  // Per-chat threading: the sidepanel sends the chat's stored thread id; the
  // global stays as the fallback for ambient callers (context menu, omnibox).
  const threadId = msgThreadId(conversationId);

  try {
    const response = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        input: prompt,
        model_name: (modelName || config.zoModel) || undefined,
        conversation_id: threadId || undefined,
        ...(resolvedPersonaId ? { persona_id: resolvedPersonaId } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        error: `Zo API error: ${response.status}${body ? ' — ' + body.substring(0, 200) : ''}`,
      };
    }

    const data = await response.json();
    // Echo the effective thread id back so the sidepanel can persist it per chat.
    let effectiveId = threadId;
    if (data.conversation_id) { zoConversationId = data.conversation_id; effectiveId = data.conversation_id; chrome.storage.session.set({ zoConversationId }).catch(e => console.debug('session.set:', e)); }
    return { success: true, output: data.output, conversationId: effectiveId };
  } catch (err) {
    return { error: `Connection failed: ${err.message}` };
  }
}

// Derive the API origin from config.zoApiUrl so a self-hosted / overridden
// endpoint is respected instead of always hitting api.zo.computer.
function apiOrigin() {
  try {
    return new URL(config.zoApiUrl).origin;
  } catch {
    return 'https://api.zo.computer';
  }
}

async function listModels() {
  if (!config.zoAccessToken) return { error: 'No token' };
  try {
    const r = await fetch(`${apiOrigin()}/models/available`, {
      headers: { Authorization: `Bearer ${config.zoAccessToken}` }
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const data = await r.json();
    // API returns { models: [{ model_name, label, vendor, ... }], featured_models_are_free }
    return { success: true, models: data.models || [] };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Fetch the no-auth model catalog (/models/catalog) and cache it for the
 * vision gate (#25). The catalog carries `supports_images` per model.
 * The session-backed cache (#73) deduplicates concurrent callers and
 * survives SW restarts. Returns the models array or null on hard failure
 * (null is a cache MISS — the next call retries; the gate falls back to
 * 'unknown' → captures anyway).
 */
async function fetchModelCatalog(force = false) {
  return catalogCacheStore.get(async () => {
    try {
      const catalogUrl = `${apiOrigin()}/models/catalog`;
      const r = await fetch(catalogUrl);
      if (!r.ok) return null;
      const data = await r.json();
      return Array.isArray(data.models) ? data.models : [];
    } catch (err) {
      console.debug('fetchModelCatalog:', err.message);
      return null;
    }
  }, force);
}

// ---- MCP client (#28 pickers) ----
// Minimal streamable-HTTP MCP client for the pickers' read-only bash calls
// against api.zo.computer/mcp (verified live 2026-08-18: the server accepts a
// stateless tools/list, but tools/call wants an initialized session — so the
// session id is captured once per worker lifetime and lazily re-established).

let mcpSessionId = null;

async function mcpPost(body, expectSession) {
  const r = await fetch(`${apiOrigin()}/mcp`, {
    method: 'POST',
    headers: {
      ...(config.zoAccessToken ? { Authorization: `Bearer ${config.zoAccessToken}` } : {}),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    },
    body,
  });
  if (expectSession) {
    const sid = r.headers.get('mcp-session-id');
    if (sid) mcpSessionId = sid;
  }
  if (!r.ok) throw new Error(`MCP HTTP ${r.status}`);
  return parseMcpMessage(await r.text());
}

async function mcpEnsureSession() {
  if (mcpSessionId) return;
  const init = mcpRequest('initialize', initializeParams());
  const msg = await mcpPost(init.body, true);
  if (!msg || msg.error) throw new Error(msg?.error?.message || 'MCP initialize failed');
  await mcpPost(mcpNotification('notifications/initialized'), false); // fire-and-forget handshake step
}

/**
 * One tools/call over MCP. Re-initializes once when the session was rejected
 * (stale id after a worker suspend) before giving up.
 */
async function mcpToolCall(name, args) {
  await mcpEnsureSession();
  const call = mcpRequest('tools/call', toolCallParams(name, args));
  let msg = await mcpPost(call.body, false);
  if (!msg || (msg.error && /session|initial/i.test(msg.error.message || ''))) {
    mcpSessionId = null;
    await mcpEnsureSession();
    const retry = mcpRequest('tools/call', toolCallParams(name, args));
    msg = await mcpPost(retry.body, false);
  }
  if (!msg) throw new Error('MCP returned an unparseable response');
  if (msg.error) throw new Error(msg.error.message || 'MCP call failed');
  if (isToolError(msg.result)) throw new Error(toolText(msg.result) || 'MCP tool error');
  return msg.result;
}

/**
 * #28 `/` picker source: the user's Zo skills, one bash round-trip that dumps
 * every SKILL.md head (name + description frontmatter). 5-min cache with
 * in-flight dedup, backed by chrome.storage.session so it SURVIVES MV3
 * service-worker restarts (#73 — the in-memory cache was wiped ~every open).
 */
const skillsCacheStore = createSessionCache({
  storage: chrome.storage.session,
  key: 'cobrowse_skills_list',
  ttlMs: 5 * 60 * 1000,
});

async function listSkills(force = false) {
  return skillsCacheStore.get(async () => {
    if (!config.zoAccessToken) throw new Error('Zo access token not configured.');
    const result = await mcpToolCall('bash', { cmd: skillsListCommand() });
    const raw = toolText(result);
    // A server-side output cap cuts the END marker off → extractMarkedStdout
    // nulls. Surface that honestly instead of caching a silent empty list (#73).
    if (extractMarkedStdout(raw) == null) {
      throw new Error('Skills listing came back truncated or unparseable — refresh to retry.');
    }
    return parseSkillsBundle(raw);
  }, force);
}

/**
 * #28 `%` picker source: one `ls -1F` of a workspace directory. Paths are
 * validated + confined to /home/workspace (traversal is rejected, never
 * reaches the shell). Brief per-path cache so popup navigation feels instant.
 */
const dirCache = new Map(); // path → { entries, fetchedAt }
const DIR_TTL_MS = 60 * 1000;

async function listWorkspaceDir(pathInput) {
  if (!config.zoAccessToken) return { ok: false, error: 'Zo access token not configured.' };
  const path = safeWorkspacePath(typeof pathInput === 'string' ? pathInput : '', WORKSPACE_ROOT);
  if (!path) {
    return { ok: false, error: `Path must be an absolute path inside ${WORKSPACE_ROOT}.` };
  }
  const cached = dirCache.get(path);
  if (cached && Date.now() - cached.fetchedAt < DIR_TTL_MS) {
    return { ok: true, path, entries: cached.entries };
  }
  try {
    const result = await mcpToolCall('bash', { cmd: dirListCommand(path) });
    const stdout = extractMarkedStdout(toolText(result));
    if (stdout == null) return { ok: false, error: 'Unparseable directory listing.' };
    const entries = parseLsEntries(stdout, path);
    dirCache.set(path, { entries, fetchedAt: Date.now() });
    return { ok: true, path, entries };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function listPersonas() {
  if (!config.zoAccessToken) return { error: 'No token' };
  try {
    const r = await fetch(`${apiOrigin()}/personas/available`, {      headers: { Authorization: `Bearer ${config.zoAccessToken}` }
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const data = await r.json();
    return { success: true, personas: data.personas || [] };
  } catch (err) {
    return { error: err.message };
  }
}


async function generateMode(description) {
  if (!config.zoAccessToken) {
    return { error: 'No token' };
  }
  try {
    const prompt = buildGenerateModePrompt(description);
    const r = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        input: prompt,
        model_name: config.zoModel || undefined,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { error: `HTTP ${r.status}: ${body.substring(0, 200)}` };
    }
    const data = await r.json();
    const output = data.output;
    try {
      const raw = JSON.parse(output);
      // Backfill to a full Mode via the shared normalizer (presetToMode handles
      // sparse objects and fills tier/budget/expectJson defaults).
      const mode = presetToMode(raw);
      return { success: true, mode: { ...mode, createdAt: Date.now() } };
    } catch {
      return { error: 'Failed to parse Zo response as JSON' };
    }
  } catch (err) {
    return { error: err.message };
  }
}

async function testConnection() {
  if (!config.zoAccessToken) {
    return { success: false, error: 'No access token configured. Save one in settings first.' };
  }

  // Test 1: Zo API
  let zoOk = false;
  try {
    const r = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        input: buildTestConnectionPrompt(),
        model_name: config.zoModel || undefined,
        conversation_id: zoConversationId || undefined,
      }),
    });
    if (r.ok) zoOk = true;
    const body = await r.text();
    // Case-insensitive check; trust r.ok as a fallback so a valid response
    // that doesn't echo the exact literal isn't reported as failure.
    if (!body.toLowerCase().includes('zo_ok')) zoOk = r.ok;
  } catch {
    // zoOk stays false
  }

  // Test 2: Zo.space endpoint
  let spaceOk = false;
  try {
    const r = await fetch(config.zoSpaceEndpoint, { method: 'HEAD' });
    spaceOk = r.ok || r.status === 301 || r.status === 302;
  } catch {
    // spaceOk stays false
  }

  return { success: zoOk, zoApi: zoOk, zoSpace: spaceOk };
}



/** EXECUTE_ACTIONS entry (#26 two-phase gate). A batch containing fill_form
 *  OR plain fill actions first re-captures the LIVE form (client-side truth,
 *  never the model's self-assessment) and runs isSensitiveForm: sensitive ->
 *  respond {needsConfirm,...} without executing; the sidepanel's review card
 *  re-sends with confirmed:true. Plain fills are covered because models drift
 *  off the fill_form preference (live-observed on roboform.com: a 30-field
 *  batch of individual fill{selector} actions incl. password + card fields).
 *  The verdict is re-derived on confirm too - a form that flipped sensitive
 *  since the review re-parks, and the submit backstop inside executeActions
 *  needs the flag either way (confirming a FILL never authorizes a SUBMIT). */
async function runExecuteActions(domActions, target, { confirmed } = {}) {
  const hasFill = domActions.some((a) => a.type === 'fill_form' || a.type === 'fill');
  // Click-only batches capture too: on sensitive pages the submit backstop
  // needs the verdict, and the per-action sidepanel loop sends clicks alone.
  const hasClick = domActions.some((a) => a.type === 'click');
  if (!hasFill && !hasClick) return executeActions(domActions, target);
  const pre = await captureFormFields(target);
  if (!pre) {
    // Unreadable page (no content script / capture failed): execute without a
    // review, stamped so the card can say "unverified form - no review". A
    // page we can't read is also a page whose fields we can't resolve - expect
    // per-field misses rather than silent wrong fills.
    return { ...await executeActions(domActions, target), unverifiedForm: true };
  }
  const verdict = isSensitiveForm(pre.formFields, pre.url);
  if (verdict.sensitive && !confirmed) {
    if (hasFill) {
      return { needsConfirm: true, actions: domActions, fields: pre.formFields, url: pre.url, reasons: verdict.reasons };
    }
    // Click-only: nothing to review — execute with the backstop armed.
    return executeActions(domActions, target, { sensitive: true });
  }
  return executeActions(domActions, target, { sensitive: verdict.sensitive });
}

/** Pre-flight form capture for the sensitivity gate: the #24 get_form pull
 *  shape ({formFields, url}) off the live tab. Null = unreadable -> fail open. */
async function captureFormFields(tabId) {
  try {
    const cap = await getActiveTabContext(tabId, 2, null, { pull: 'form' });
    if (cap && !cap.error && !cap.blank && cap.url) {
      return { formFields: Array.isArray(cap.formFields) ? cap.formFields : [], url: cap.url };
    }
  } catch {
    // unreadable - caller fails open
  }
  return null;
}

// Submit-looking button text for the backstop (probe.type 'submit' alone
// misses <button>Place order</button> without an explicit type attribute).
const SUBMIT_TEXT_RE = /submit|pay|checkout|order|place|buy/i;

// Co-browse contract (user rule): after Zo fills a form on a page, it NEVER
// clicks ANY action button on that page (submit/OK/Next/Create/Continue/…) —
// the user reviews and clicks. tabId → URL of the last fill; cleared when the
// tab navigates elsewhere. The prompt rule is primary; this cannot be ignored.
const filledPages = new Map();

/** Probe a click target for the submit backstop: {form,tag,type,role,text} of
 *  the element, or null on any failure (fail-open - a broken probe must not
 *  brick clicking). */
async function probeClickTarget(tabId, selector) {
  try {
    const resp = await evalInPage(tabId, probeExpr(String(selector || '')), 4000);
    if (resp.ok && resp.value) return resp.value;
  } catch {
    // debugger not available - fall through
  }
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: probeFn, args: [String(selector || '')] });
    return (r && r.result) || null;
  } catch {
    return null;
  }
}

function probeExpr(sel) {
  return '(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');'
    + 'if(!el)return null;'
    + 'return{form:!!el.closest("form"),type:el.type||"",tag:(el.tagName||"").toLowerCase(),role:(el.getAttribute&&el.getAttribute("role"))||"",text:(el.textContent||el.value||"").trim().substring(0,40)};})()';
}

function probeFn(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  return {
    form: !!el.closest('form'),
    type: el.type || '',
    tag: (el.tagName || '').toLowerCase(),
    role: (el.getAttribute && el.getAttribute('role')) || '',
    text: (el.textContent || el.value || '').trim().substring(0, 40),
  };
}

async function executeActions(actions, tabId, opts = {}) {
  if (!tabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs[0]?.id;
    if (!tabId) return { ok: false, error: 'No active tab' };
  }

  const results = [];
  for (const action of actions) {
    if (action.type === 'navigate') {
      await chrome.tabs.update(tabId, { url: action.url });
      results.push({ ok: true, type: 'navigate' });
      continue;
    }
    if (action.type === 'done') {
      results.push({ ok: true, type: 'done', response: action.response });
      continue;
    }

    // Submit backstop (#26): on a page the gate flagged sensitive, a click on
    // a form's submit/pay control is refused - the user reviews and submits.
    // Prompt-side rule alone can be ignored by the model; this cannot.
    if (opts.sensitive && action.type === 'click') {
      const probe = await probeClickTarget(tabId, action.selector);
      const isSubmit = probe && probe.form &&
        (probe.type === 'submit' || SUBMIT_TEXT_RE.test(probe.text || ''));
      if (isSubmit) {
        results.push({ ok: false, type: 'click', blocked: true, error: 'blocked submit on sensitive page - review and submit yourself' });
        continue;
      }
    }

    // Co-browse contract (user rule): once Zo has filled a form on this page,
    // it never clicks ANY action button (submit/OK/Next/Continue/Create/…) —
    // the user reviews and clicks. Links stay allowed (navigation ≠ form
    // action). The entry clears when the tab navigates elsewhere.
    if (action.type === 'click' && filledPages.has(tabId)) {
      let currentUrl = '';
      try { currentUrl = (await chrome.tabs.get(tabId)).url || ''; } catch { /* tab gone */ }
      if (currentUrl && currentUrl !== filledPages.get(tabId)) {
        filledPages.delete(tabId); // navigated away - the contract is satisfied
      } else if (currentUrl) {
        const probe = await probeClickTarget(tabId, action.selector);
        const isActionButton = probe && (
          probe.tag === 'button' ||
          (probe.tag === 'input' && (probe.type === 'submit' || probe.type === 'button')) ||
          probe.role === 'button');
        if (isActionButton) {
          results.push({ ok: false, type: 'click', blocked: true, error: 'blocked action-button click after a form fill - review the page and click it yourself' });
          continue;
        }
      }
    }

    let result;

    // Path 1: Debugger eval (fastest, works even if content script not loaded)
    if (action.selector || action.type === 'scroll') {
      try {
        const resp = await evalInPage(tabId, makeActionEval(action), 8000);
        if (resp.ok && resp.value && resp.value.ok) {
          result = resp.value;
        }
      } catch {
        // debugger not available — fall through
      }
    }

    // Path 2: Content script
    if (!result) {
      try {
        const resp = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action });
        result = resp || { ok: false, error: 'no response' };
      } catch {
        result = null;
      }
    }

    // Path 3: executeScript fallback
    if (!result) {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: executeDomAction, args: [action] });
        result = r.result;
      } catch (err) {
        result = { ok: false, error: err.message };
      }
    }

    results.push(result);
    if (!result?.ok) break;
    // Arm the post-fill action-button contract for this page.
    if ((action.type === 'fill' || action.type === 'fill_form') && result.ok) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url) filledPages.set(tabId, tab.url);
      } catch { /* tab gone - nothing to arm */ }
    }
    if (action.type !== 'wait') await sleep(500);
  }

  const allOk = results.every(r => r && r.ok);
  const failed = results.find(r => r && !r.ok);
  return allOk
    ? { ok: true, results }
    : { ok: false, results, error: (failed && failed.error) || 'Action failed' };
}

function executeDomAction(action) {
  // fill_form twin of content.js#resolveFieldTarget — inlined here because
  // this function is serialized into the page by chrome.scripting.executeScript
  // and cannot close over module scope.
  const resolveFieldTarget = (target, selector) => {
    if (selector) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    const t = String(target || '').trim().toLowerCase();
    if (!t) return null;
    const fields = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter((f) => f.type !== 'hidden');
    for (const label of document.querySelectorAll('label')) {
      if ((label.textContent || '').trim().toLowerCase() !== t) continue;
      const forEl = label.htmlFor ? document.getElementById(label.htmlFor) : null;
      const inner = label.querySelector('input, textarea, select');
      const el = forEl || inner;
      if (el) return el;
    }
    const byAria = fields.find((f) =>
      (f.getAttribute('aria-label') || '').trim().toLowerCase() === t ||
      (f.getAttribute('aria-labelledby') || '').trim().split(/\s+/).some((id) => {
        const lab = id && document.getElementById(id);
        return lab && (lab.textContent || '').trim().toLowerCase() === t;
      }));
    if (byAria) return byAria;
    // Viewport preference + question-text fallback (mirror of content.js).
    const pickVisible = (list) => {
      for (const f of list) {
        const r = f.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) return f;
      }
      return list[0] || null;
    };
    const normCue = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:*]+$/, '').trim();
    const byAttr = fields.filter((f) =>
      (f.placeholder || '').trim().toLowerCase() === t ||
      (f.name || '').toLowerCase() === t ||
      (f.id || '').toLowerCase() === t);
    if (byAttr.length) return pickVisible(byAttr);
    const cues = [];
    for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,label,p,span,div,td,th,fieldset')) {
      if (el.querySelector('input, textarea, select')) continue;
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 160) continue;
      if (normCue(txt) !== normCue(t)) continue;
      cues.push(el);
    }
    const candidates = [];
    for (const cue of cues) {
      let scope = cue;
      for (let i = 0; i < 8 && scope; i++) {
        const inner = scope.querySelector('input, textarea, select');
        if (inner) { candidates.push(inner); break; }
        scope = scope.parentElement;
      }
    }
    return candidates.length ? pickVisible(candidates) : null;
  };
  return new Promise((resolve, reject) => {
    let el = action.selector ? document.querySelector(action.selector) : null;
    if (!el && action.selector) {
      // Playwright :has-text()/:text() fallback — not valid CSS.
      const hm = action.selector.match(/:has-text\(\s*["']([^"']+)["']\s*\)|:text\(\s*["']([^"']+)["']\s*\)/i);
      if (hm) {
        const ht = (hm[1] || hm[2]).toLowerCase().trim();
        for (const c of document.querySelectorAll('a, button, [role=button], [onclick], input[type=submit], input[type=button]')) {
          if ((c.textContent || '').trim().toLowerCase().includes(ht)) { el = c; break; }
        }
      }
    }
    if (!el && action.selector) {
      reject(new Error(`Element not found: ${action.selector}`));
      return;
    }
    switch (action.type) {
      case 'click':
        el.scrollIntoView({ block: 'center' });
        el.click();
        resolve({ ok: true, type: 'click' });
        break;
      case 'fill':
      case 'fill_form': {
        // One value-set path for both action kinds: el focuses, value set,
        // selects fall back to OPTION-TEXT matching when the direct value
        // assignment selects nothing (Zo sends visible text, not value attrs).
        const setVal = (node, raw) => {
          node.focus();
          node.value = '';
          node.value = raw;
          if (node.tagName === 'SELECT' && node.selectedIndex === -1) {
            const want = String(raw == null ? '' : raw).trim().toLowerCase();
            if (want) {
              const opts = Array.from(node.options || []);
              const opt = opts.find((o) => (o.textContent || '').trim().toLowerCase() === want) ||
                opts.find((o) => (o.textContent || '').trim().toLowerCase().startsWith(want));
              if (opt) node.value = opt.value;
            }
          }
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        };
        if (action.type === 'fill') {
          setVal(el, action.value);
          resolve({ ok: true, type: 'fill' });
          break;
        }
        const results = [];
        for (const entry of action.values || []) {
          const field = resolveFieldTarget(entry.target, entry.selector);
          if (!field) { results.push({ ok: false, target: entry.target, error: 'no field matched' }); continue; }
          setVal(field, String(entry.value == null ? '' : entry.value));
          results.push({ ok: true, target: entry.target, type: field.type || field.tagName.toLowerCase() });
        }
        const failed = results.filter((r) => !r.ok);
        resolve({
          ok: failed.length === 0,
          type: 'fill_form',
          fields: results,
          ...(failed.length ? { error: `${failed.length} field(s) unmatched: ${failed.map((f) => f.target).join(', ')}` } : {}),
        });
        break;
      }
      case 'extract':
        resolve({
          ok: true,
          type: 'extract',
          value: action.attribute ? el.getAttribute(action.attribute) : el.textContent?.trim(),
        });
        break;
      case 'scroll':
        window.scrollBy({
          left: 0,
          top: action.direction === 'up' ? -(action.amount || 300) : action.amount || 300,
          behavior: 'smooth',
        });
        resolve({ ok: true, type: 'scroll' });
        break;
      case 'wait':
        setTimeout(() => resolve({ ok: true, type: 'wait' }), action.ms || 1000);
        break;
      default:
        reject(new Error(`Unknown action: ${action.type}`));
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Save page content to Zo workspace as markdown (#09)
async function savePageToWorkspace(pageContext, savePath) {
  if (!config.zoAccessToken) return { ok: false, error: 'Zo access token not configured. Open settings to set it up.' };

  // Derive a clean filename from page title or use provided path
  const rawTitle = (pageContext && pageContext.title) || 'untitled';
  const cleanTitle = rawTitle.replace(/[^a-zA-Z0-9\-_ ]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 80);
  const path = savePath || `Documents/research/${cleanTitle}.md`;
  const url = (pageContext && pageContext.url) || '';
  const content = (pageContext && pageContext.visibleText) || '';

  // Build a markdown note with source attribution
  const markdown = `# ${(pageContext && pageContext.title) || 'Untitled'}\n\n> **Source:** ${url}\n\n> **Saved:** ${new Date().toISOString()}\n\n---\n\n${content}\n`;

  // Ask Zo to write the file
  const prompt = `Write the following content to the file at path \`${path}\` in my workspace. Create the directory if it does not exist. Use write_file or equivalent. Do not respond with anything other than a confirmation with the file path.\n\n---CONTENT START---\n${markdown}\n---CONTENT END---`;

  try {
    const resp = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: prompt,
        model_name: config.zoModel || undefined,
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: `Zo API error: ${resp.status} ${resp.statusText}` };
    }
    const data = await resp.json();
    const output = data.output || '';
    return { ok: true, path: path, response: output };
  } catch (err) {
    return { ok: false, error: `Save failed: ${err.message}` };
  }
}

// Run a Zo skill on the current page (#04)
async function runSkill(skillName, pageContext) {
  const prompt = buildRunSkillPrompt(skillName, pageContext);
  try {
    const resp = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: prompt,
        model_name: config.zoModel || undefined,
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: `Zo API error: ${resp.status} ${resp.statusText}` };
    }
    const data = await resp.json();
    return { ok: true, response: data.output || '' };
  } catch (err) {
    return { ok: false, error: `Skill run failed: ${err.message}` };
  }
}

// Textarea write-assist one-shot (feature/textarea-fill). Builds the prompt via
// lib/write-assist, POSTs to /zo/ask with NO conversation_id (fresh thread per
// call — never rotates the ambient zoConversationId), and returns the parsed
// improved text. A 60s AbortController bounds long generations.
async function enhanceText(request) {
  if (config.enableWriteAssist === false) {
    return { ok: false, error: 'Write assist is disabled in the extension options.' };
  }
  if (!config.zoAccessToken) {
    return { ok: false, error: 'No access token configured. Save one in the extension options.' };
  }
  const req = request || {};
  const prompt = buildEnhancePrompt({
    text: req.text,
    instruction: req.instruction,
    field: req.field,
    page: req.page,
    acceptsMarkdown: !!(req.field && req.field.markdown),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: prompt,
        model_name: config.zoModel || undefined,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `Zo API error: ${resp.status} ${body.substring(0, 200)}` };
    }
    const data = await resp.json();
    const { text } = parseEnhanceResponse(data.output);
    if (!text) return { ok: false, error: 'Zo returned an empty response.' };
    return { ok: true, text };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, error: 'Enhance timed out after 60s.' };
    return { ok: false, error: `Enhance failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// Create a scheduled automation from the current page (#08)
async function createAutomation(instruction, rrule, pageContext) {
  const prompt = buildCreateAutomationPrompt(instruction, rrule, pageContext);
  try {
    const resp = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: prompt,
        model_name: config.zoModel || undefined,
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: `Zo API error: ${resp.status} ${resp.statusText}` };
    }
    const data = await resp.json();
    return { ok: true, response: data.output || '' };
  } catch (err) {
    return { ok: false, error: `Automation creation failed: ${err.message}` };
  }
}

// List existing automations (#08)
async function listAutomations() {
  const prompt = buildListAutomationsPrompt();
  try {
    const resp = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: prompt,
        model_name: config.zoModel || undefined,
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: `Zo API error: ${resp.status} ${resp.statusText}` };
    }
    const data = await resp.json();
    return { ok: true, response: data.output || '' };
  } catch (err) {
    return { ok: false, error: `Failed to list automations: ${err.message}` };
  }
}

// Run a natural-language query against Zo's DuckDB datasets via zo.space (#05)
async function runDuckdbQuery(naturalQuery) {
  if (!config.zoAccessToken) {
    return { ok: false, error: 'Zo access token not configured.' };
  }
  const endpoint = config.zoSpaceEndpoint || 'https://cashlessconsumer.zo.space';
  try {
    const resp = await fetch(`${endpoint}/api/cobrowse/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: naturalQuery }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `DuckDB query failed: ${resp.status} ${resp.statusText}${txt ? ' — ' + txt : ''}` };
    }
    const data = await resp.json();
    // Expected shape from the API: { ok: true, columns: [...], rows: [[...], ...], sql: "..." }
    return {
      ok: true,
      columns: data.columns || [],
      rows: data.rows || [],
      sql: data.sql || '',
      rowCount: Array.isArray(data.rows) ? data.rows.length : 0,
    };
  } catch (err) {
    return { ok: false, error: `DuckDB query error: ${err.message}` };
  }
}

