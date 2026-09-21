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
import { shouldDowngradeToJsonDisabled } from './lib/intent.js';
import { BUNDLED_SKILL_PATH, PROTOCOL_SKILL_PATH, SKILL_STATE_KEY, injectVersion, parseInstalledVersion } from './lib/protocol-skill.js';
import { parseZoOutput, stripCodeFence } from './lib/parse-output.js';
import { buildDecideRequest, parseDecideResponse, shouldAct, doneGateQuestion, matchChoiceQuestion, redactStateForJev, jevDecideImpl, DEFAULT_JEV_API_URL, DEFAULT_JEV_MODEL } from './lib/jev.js';
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
import { isSensitiveForm, isSensitiveSubmitProbe } from './lib/formfill.js';
import { conversationToMarkdown, slugifyTitle } from './lib/export.js';
import {
  createRun as handoffCreateRunPure,
  transition as handoffTransition,
  tally as handoffTally,
  recordVisit as handoffRecordVisit,
  park as handoffPark,
  withinBudget as handoffWithinBudget,
  checkBoundary as handoffCheckBoundary,
  isSubmitish as handoffIsSubmitish,
  isFillish as handoffIsFillish,
  recordObs as handoffRecordObs,
  addComposePark,
  resolveComposePark,
  buildContinuationTurn,
  continuationPayload as handoffContinuationPayload,
  DEFAULT_BUDGET,
} from './lib/handoff.js';
import {
  buildEnhancePrompt,
  buildEnhanceFollowUpPrompt,
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
  shellQuote,
  extractMarkedStdout,
  parseSkillsBundle,
  parseLsEntries,
} from './lib/pickers.js';
import {
  validateRecipe,
  substituteParams,
  bumpVersion,
  healPrompt,
  parseRecipeHealResponse,
  assembleDraftRecipe,
  assembleComposedDraft,
  generateRecipePrompt,
  composeCleanupPrompt,
  parseGeneratedRecipe,
  withoutParamDefaults,
  literalFillValueCount,
  generateValuePrompt,
  recipeSaveTarget,
  serializeRecipe,
  driftedFromWorkspace,
  patchHealedCues,
  buildRecipeSkillExport,
} from './lib/recipes.js';
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
      // Success after a retry — tell the panel explicitly that the banner can
      // drop (the sidepanel's STREAM_RECONNECT_DONE case was dead code until
      // this post existed; the first chunk also clears it, this is the honest contract).
      const result = await _askZoStreamImpl(port, msg);
      if (attempt > 1) safePost(port, { sessionId: msg.sessionId, type: 'STREAM_RECONNECT_DONE' });
      return result;
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
  // #339: no owner-specific default — empty means space-backed features are
  // off until the user sets their Zo username (which derives this host).
  zoSpaceEndpoint: '',
  zoPersonaId: '',          // optional: pin the persona sent to the API
  zoActiveMode: 'cobrowse', // active Mode id (replaces personaMode + presets)
  // Jev (0.3.4 Lane J) — ships dark; jevEnabled false = zero behavioral delta.
  jevEnabled: false,
  jevModel: 'jev-latest',
  jevPickConfidence: 0.8, // choice hooks (click-target picks)
  jevDoneConfidence: 0.9, // noul hooks (done-gates) — NOT comparable to choice
  zoAccessToken: '',
  enableScreenshots: true,  // global kill-switch; per-Mode tiers also gate capture
  enableWriteAssist: true,  // textarea write-assist floating icon (content script)
  enabledMenus: {        // which context menu items are active
    page: true,
    selection: true,
    link: true,
    editable: true,
  },
  // !handoff run budget (#158) — config-resident so it is tunable via
  // storage.sync; DEFAULT_BUDGET (lib/handoff.js) is the numeric source.
  cobrowse_handoff_budget: { ...DEFAULT_BUDGET },
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

// Lane B 2-0 (observability): script-eval completion, measured from worker
// start — the compute half of the SW cold start the #67 baseline names as the
// dominant cost. Stamped into the ring as soon as debug mode resolves.
const SW_EVAL_DONE = perfNow();

try {
  chrome.storage.sync.get({ debugMode: false }, (res) => {
    debugLog.setEnabled(!!(res && res.debugMode));
    debugLog.push('startup', 'worker-eval', SW_EVAL_DONE);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.debugMode) debugLog.setEnabled(!!changes.debugMode.newValue);
  });
} catch { /* storage unavailable */ }


// ---- Init ----
chrome.storage.sync.get(
  ['zoApiUrl', 'zoModel', 'zoPersonaId', 'zoActiveMode', 'enableScreenshots', 'enableWriteAssist', 'enabledMenus', 'cobrowse_handoff_budget', 'zoWebOrigin', 'jevEnabled', 'jevModel', 'jevPickConfidence', 'jevDoneConfidence'],
  (result) => {
    if (result.zoApiUrl) config.zoApiUrl = result.zoApiUrl;
    if (result.zoModel) config.zoModel = result.zoModel;
    if (result.zoPersonaId) config.zoPersonaId = result.zoPersonaId;
    if (result.zoActiveMode) config.zoActiveMode = result.zoActiveMode;
    if (result.enableScreenshots !== undefined) config.enableScreenshots = result.enableScreenshots;
    if (result.enableWriteAssist !== undefined) config.enableWriteAssist = result.enableWriteAssist;
      if (result.enabledMenus) config.enabledMenus = { ...config.enabledMenus, ...result.enabledMenus };
    // #158: a stored handoff budget overrides the config default.
    if (result.cobrowse_handoff_budget) config.cobrowse_handoff_budget = { ...config.cobrowse_handoff_budget, ...result.cobrowse_handoff_budget };
    // #233: the panel reads zoWebOrigin from GET_CONFIG — load it at startup
    // so the ↗ chip works on first open without waiting for a storage change.
    if (result.zoWebOrigin !== undefined) config.zoWebOrigin = result.zoWebOrigin;
    // Jev knobs (0.3.4 Lane J).
    if (result.jevEnabled !== undefined) config.jevEnabled = result.jevEnabled;
    if (result.jevModel) config.jevModel = result.jevModel;
    if (result.jevPickConfidence !== undefined) config.jevPickConfidence = result.jevPickConfidence;
    if (result.jevDoneConfidence !== undefined) config.jevDoneConfidence = result.jevDoneConfidence;
  }
);
// Sensitive config from storage.local (not synced)
chrome.storage.local.get(
  ['zoAccessToken', 'zoSpaceEndpoint', 'jevApiKey', 'jevApiUrl'],
  (result) => {
    if (result.zoAccessToken) config.zoAccessToken = result.zoAccessToken;
    if (result.zoSpaceEndpoint) config.zoSpaceEndpoint = result.zoSpaceEndpoint;
    if (result.jevApiKey) config.jevApiKey = result.jevApiKey;
    if (result.jevApiUrl) config.jevApiUrl = result.jevApiUrl;
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
  if (changes.jevApiKey?.newValue) config.jevApiKey = changes.jevApiKey.newValue;
  else if (changes.jevApiKey?.oldValue && !changes.jevApiKey?.newValue) config.jevApiKey = undefined;
  if (changes.jevApiUrl?.newValue) config.jevApiUrl = changes.jevApiUrl.newValue;
    if (changes.enabledMenus?.newValue) { config.enabledMenus = { ...config.enabledMenus, ...changes.enabledMenus.newValue }; recreateContextMenus(); }
  if (changes.enableScreenshots?.newValue !== undefined) config.enableScreenshots = changes.enableScreenshots.newValue;
  if (changes.enableWriteAssist?.newValue !== undefined) config.enableWriteAssist = changes.enableWriteAssist.newValue;
  // Jev knobs (0.3.4 Lane J) — sync side.
  if (changes.jevEnabled?.newValue !== undefined) config.jevEnabled = changes.jevEnabled.newValue;
  if (changes.jevModel?.newValue) config.jevModel = changes.jevModel.newValue;
  if (changes.jevPickConfidence?.newValue !== undefined) config.jevPickConfidence = changes.jevPickConfidence.newValue;
  if (changes.jevDoneConfidence?.newValue !== undefined) config.jevDoneConfidence = changes.jevDoneConfidence.newValue;
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
    case 'JEV_TEST': {
      jevTest().then(sendResponse);
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
      debugLog.setTrace(`exec:${request.handoffRunId || request.tabId || 'ambient'}`);
      runExecuteActions(domActions, request.tabId || senderTabId(sender), { confirmed: request.confirmed, boundaryMode: request.boundaryMode }).then((res) => {
        sendResponse(res);
        debugLog.setTrace(null);
        // Lane E: the completing turn of a handoff run continues the loop here
        // (execute → continuation turn → repeat until done()/budget).
        if (request.handoffRunId) handoffAfterExecute(request.handoffRunId, request, res);
      });
      return true;
    }
    case 'HANDOFF_START': {
      // {chatId, tabId, goal, boundaryMode?, budget?} → {ok, run}. The run
      // starts in 'priming'; the panel's first ASK_ZO (carrying handoffRunId)
      // flips it to 'running' and registers the loop's turn context.
      const run = handoffCreateRunPure({
        chatId: request.chatId,
        goal: request.goal,
        boundaryMode: request.boundaryMode,
        // #158: explicit request budget wins; else the config default
        // (storage.sync `cobrowse_handoff_budget`); else the lib default.
        budget: request.budget || config.cobrowse_handoff_budget || undefined,
      });
      run.tabId = request.tabId;
      handoffPut(run).then((saved) => sendResponse({ ok: true, run: saved }));
      return true;
    }
    case 'HANDOFF_STOP': {
      handoffGet({ runId: request.runId }).then(async (run) => {
        if (!run) return sendResponse({ ok: false, error: 'no such handoff run' });
        handoffTurnCtx.delete(request.runId);
        // C2: stopping a compose run by any path (✕ on the line, tab close)
        // disarms the compose session — the human-obs producer goes with it.
        if (run.compose) {
          await composeStore.clear();
          composeBroadcastRecordState(false).catch(() => {});
        }
        // A run that already left the loop (done/aborted) has nothing to stop.
        // Saving it again would re-fire handoffMaybeNotify + re-push
        // HANDOFF_UPDATE, showing the user a second "Handoff done" line for a
        // run that ended once (#160). Report it as a no-op instead.
        if (run.status === 'done' || run.status === 'aborted') {
          return sendResponse({ ok: false, run, error: `run already ${run.status}` });
        }
        const res = handoffTransition(run, 'abort', { now: Date.now(), reason: safeText(request.reason) || 'stopped by user' });
        const saved = await handoffPut(res.ok ? res.run : run);
        sendResponse({ ok: res.ok, run: saved, error: res.ok ? undefined : res.error });
      });
      return true;
    }
    case 'HANDOFF_RESUME': {
      // {runId} → {ok, run, continuationQuery}. Paused runs are resumable
      // from the panel (#164): transition to running and hand back the
      // continuation turn text — the PANEL re-issues it as an ASK_ZO carrying
      // handoffRunId, which re-registers the loop's turn context on its live
      // port (the old ctx died with the pause/port).
      handoffGet({ runId: request.runId }).then(async (run) => {
        if (!run) return sendResponse({ ok: false, error: 'no such handoff run' });
        if (!['paused', 'blocked'].includes(run.status)) {
          return sendResponse({ ok: false, error: `run is ${run.status}, not resumable` });
        }
        const res = handoffTransition(run, 'resume', { now: Date.now(), reason: 'resumed from panel' });
        if (!res.ok) return sendResponse({ ok: false, error: res.error });
        const saved = await handoffPut(res.run);
        sendResponse({ ok: true, run: saved, continuationQuery: buildContinuationTurn(saved) });
      });
      return true;
    }
    case 'HANDOFF_PAUSE': {
      // {runId, reason?} → {ok, run}. Panel-side honest pause (#165): a
      // handoff turn that falls back to non-streaming cannot drive the loop,
      // so the panel pauses the run (priming included — the transition table
      // allows pause from priming) instead of stranding it.
      handoffGet({ runId: request.runId }).then(async (run) => {
        if (!run) return sendResponse({ ok: false, error: 'no such handoff run' });
        const res = handoffTransition(run, 'pause', { now: Date.now(), reason: safeText(request.reason) || 'paused' });
        handoffTurnCtx.delete(request.runId);
        const saved = await handoffPut(res.ok ? res.run : run);
        sendResponse({ ok: res.ok, run: saved, error: res.ok ? undefined : res.error });
      });
      return true;
    }
    case 'HANDOFF_STATUS': {
      handoffGet(request.runId ? { runId: request.runId } : { chatId: request.chatId }).then((run) => sendResponse({ ok: true, run }));
      return true;
    }
    case 'RECIPE_START': {
      // #220: {chatId, tabId?, source:{workspacePath|localName}, paramValues?}
      // → {ok, run} | {ok:false, needsParams, params}. The player is
      // background-resident and deterministic — the panel only displays.
      recipeStart(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_RESUME': {
      // {runId, force?} — verify the pending human checkpoint's postcondition
      // (force = manual fallback) and continue playback.
      recipeResume(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_STOP': {
      // {runId, reason?} — abort a live run (chat-tab close uses this too).
      recipeStop(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_STATUS': {
      recipeGet(request.runId ? { runId: request.runId } : { chatId: request.chatId }).then((run) => sendResponse({ ok: true, run }));
      return true;
    }
    case 'RECIPE_RENAME': {
      // R3 (#257): {name, newName} — library key + recipe.name move together;
      // runs are self-contained and keep their copied name.
      recipeRename(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_DELETE': {
      // R3 (#257): local library entry only — workspace files are the user's
      // source of truth and are never removed by the extension.
      recipeDelete(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_IMPORT': {
      // R3 (#257): {path} — read_file → validateRecipe → local library.
      recipeImport(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_EXPORT': {
      // R3 (#257): {names, skillName?} — deterministic write_file bundle
      // (SKILL.md + references/recipes.md). Documentation, never execution.
      recipeExport(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_SAVE_HEALED': {
      // R2 (#256): {runId} → {ok, path, version} — push a healed run's cue
      // patches into the recipe's workspace origin file (parameterized copy,
      // cues only). The panel offer fires this; never automatic.
      recipeSaveHealed(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_SAVE': {
      // R2 (#256): {name, path?, confirm?} → {ok, path, version} | {ok:false,
      // exists:true, path} (overwrite needs confirm) | {ok:false, error}.
      recipeSave(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_COMPOSE_SAVE': {
      // 0.3.2 C1 (#289): {runId, name} → {ok, name, version, steps, params} |
      // {ok:false, error, errors?} — assemble a completed handoff run's
      // observation log into a validated composed draft in the local library.
      recipeComposeSave(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_COMPOSE_START': {
      // 0.3.2 C2 (#290): {chatId, tabId, goal, name?} → {ok, run} — a compose
      // session: handoff run with the compose boundary + recorder armed; Zo
      // drives, parks at values/ambiguity, never fills or submits.
      recipeComposeStart(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_COMPOSE_RESUME': {
      // {runId?, parkId, text?} → {ok, run, continuationQuery} — the human
      // resolved a park; the panel re-issues the continuation as ASK_ZO.
      recipeComposeResume(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_COMPOSE_STOP': {
      // {runId?} → {ok, run} — abort the compose session + disarm recording.
      recipeComposeStop(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_LIST': {
      // `!recipe list` — the local learned-recipes library + any live run.
      recipeList().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_RECORD_START': {
      // #220 recorder: arm a session (content scripts arm per navigation).
      recipeRecordStart(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    case 'RECIPE_RECORD_PEEK': {
      // Content scripts ask on every page load so the recorder re-arms.
      recipeRecordPeek().then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'RECIPE_OBS': {
      // One observation record: the recorder's store (if recording), AND the
      // live compose run's obs (C2 second producer, source:'human').
      Promise.all([recipeRecordObserve(request.obs), composeObserve(request.obs)])
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'RECIPE_RECORD_STOP': {
      // Assemble + clean + validate + save the learned recipe.
      recipeRecordStop().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
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
    case 'SAVE_CONVERSATION': {
      saveConversationToWorkspace(request.conversation, request.savePath).then(sendResponse);
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
    zoWebOrigin: config.zoWebOrigin || '',
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
  // #53 write-assist popover stream — its own port name and lifecycle, so the
  // panel's cobrowse-stream machinery (sessionId routing, pull loop) stays out.
  if (port.name === 'cobrowse-wa-stream') {
    port.onDisconnect.addListener(() => { port._dead = true; });
    port.onMessage.addListener(async (msg) => {
      if (msg.type !== 'WA_ENHANCE') return;
      try {
        await enhanceStream(port, msg);
      } catch (err) {
        safePost(port, { type: 'WA_ERROR', error: `Failed: ${err.message}` });
      }
    });
    return;
  }
  if (port.name !== 'cobrowse-stream') return;

  // Track disconnects so streaming code can stop posting to a dead port
  // instead of throwing "Attempting to use a disconnected port object".
  port.onDisconnect.addListener(() => { port._dead = true; });

  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case 'ASK_ZO': {
        const __t0 = perfNow(); // #67 stream-duration telemetry
        // Lane B 2-0: tag every diagnostics entry of this turn so an export
        // groups into per-turn timelines.
        debugLog.setTrace(`turn-${msg.sessionId}${msg.chatId ? `:${msg.chatId}` : ''}`);
        // Lane E: a handoff turn registers its loop context (memory-only —
        // an SW restart loses it and the orphan pause marks the run paused),
        // and the first turn flips the run priming → running.
        if (msg.handoffRunId) {
          handoffTurnCtx.set(msg.handoffRunId, { port, msg });
          handoffGet({ runId: msg.handoffRunId }).then((run) => {
            if (run && run.status === 'priming') {
              const res = handoffTransition(run, 'start', { now: Date.now() });
              if (res.ok) handoffPut(res.run);
            }
          });
        }
        try {
          await askZoStream(port, msg);
          debugLog.push('stream', 'askZoStream:done', perfNow() - __t0, { tier: msg.effectiveTier });
        } catch (err) {
          debugLog.push('stream', 'askZoStream:error', perfNow() - __t0, { tier: msg.effectiveTier });
          // Final failure after retries (or a non-retriable error). Only try
          // to surface it if the port is still alive.
          safePost(port, { sessionId: msg.sessionId, type: 'STREAM_ERROR', error: `Failed: ${err.message}` });
        }
        debugLog.setTrace(null);
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

chrome.runtime.onInstalled.addListener((details) => {
  recreateContextMenus();
  // Lane D stale-build guard (#109): after an extension UPDATE, open tabs
  // keep running the OLD content script until they navigate — the recurring
  // "still broken after git pull + reload" trap. Re-inject the fresh
  // content.js into eligible open tabs and leave a one-time banner flag for
  // the panel.
  if (details.reason === 'update') {
    chrome.storage.session.set({ cobrowse_updated_at: Date.now() }).catch((e) => console.debug('session.set:', e));
    reinjectContentScripts();
  }
});

// Re-inject content.js into open http(s) tabs. Excluded by the query:
// chrome:// pages, extension pages, about: — everything content.js itself
// refuses to run on (its PAGE_DEAD guard). Tabs where injection fails
// (discarded, restricted) are skipped silently.
async function reinjectContentScripts() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch { /* tab ineligible — skip */ }
    }
  } catch (e) {
    console.debug('reinjectContentScripts:', e);
  }
}
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
  // #235: action turns check the protocol-skill install (verified read-back
  // lets buildPrompt slim the tail); read/downgraded turns skip entirely.
  // #237: an established per-chat thread (echo already arrived) lets read
  // follow-ups ride the stub tail. Handoff/heal turns use their own
  // assemblers (_followUpInput bypasses buildPrompt) — exempt by design.
  const protocolSkill = mode.expectJson && !shouldDowngradeToJsonDisabled(mode, userQuery)
    ? await ensureProtocolSkill()
    : null;
  const establishedThread = !!loop.threadId;
  const prompt = msg._followUpInput || buildPrompt(mode, pageContext, userQuery, { effectiveTier, ...(msg.shotOnly ? { screenshotOnly: true } : {}), tabContexts: loop.tabContexts, skills: msg.skills, workspaceFiles: msg.workspaceFiles, ...(protocolSkill ? { protocolSkill } : {}), ...(establishedThread ? { establishedThread: true } : {}) });

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
    // #300: chained turns (handoff continuations) carry the capture tier they
    // used so the footer context-tier chip can render for unattended turns.
    ...(Number.isInteger(extra.contextTier)
      ? { contextTier: extra.contextTier, contextReason: extra.contextReason }
      : {}),
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
  // #300: a chained turn marks its own capture on the turn message — forward
  // it so STREAM_DONE (and the footer chip) reflects what actually ran.
  if (!Number.isInteger(extra?.contextTier) && Number.isInteger(loop?.msg?.contextTier)) {
    extra = { ...extra, contextTier: loop.msg.contextTier, contextReason: loop.msg.contextReason };
  }
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

  // Workspace-file pull (#52): read_file. No tab, no capture — the file text
  // comes from the MCP `read_file` tool, confined to /home/workspace by
  // safeWorkspacePath. Send-once per path (`file:<path>` in the per-chat
  // tabsSent state, under the 'file' key — no tab id exists to key on); a
  // failed read is NOT marked sent so Zo can retry it after correcting course.
  if (req.type === 'read_file') {
    const chatId = loop.msg?.chatId;
    const state = await loadConversationState(chatId);
    const rawPath = typeof req.path === 'string' ? req.path : '';
    const path = safeWorkspacePath(rawPath, WORKSPACE_ROOT);
    const hash = pullHash('read_file', path || rawPath);
    const alreadySent = isTabSentAt(state, 'file', hash);
    let res = null;
    if (!path) {
      res = { ok: false, error: `Path must be an absolute path inside ${WORKSPACE_ROOT}.` };
    } else if (!alreadySent) {
      res = await readWorkspaceFile(path);
    }
    const fu = buildPullFollowUp(
      'read_file',
      { path: path || rawPath },
      res && res.ok ? { content: res.content } : null,
      alreadySent && !res ? { reason: 'duplicate' } : {}
    );
    if (res && res.ok && !alreadySent) {
      await saveConversationState(chatId, noteTabSent(state, 'file', hash));
    }
    emitPullTrace(port, sid, req, { title: path || rawPath }, fu, loop.cyclesUsed);
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

/** Tool-trace card for one pull cycle (the sidepanel's STREAM_TOOL channel).
 *  `n` (the loop cycle number) only read_file uses — distinct paths pulled in
 *  one turn must not share a callId, or the result phase updates the wrong card. */
function emitPullTrace(port, sid, req, target, fu, n) {
  const fileBase = req.type === 'read_file' && req.path
    ? String(req.path).split('/').filter(Boolean).pop()
    : '';
  const callId = `pull-${sid}-${req.type}${req.ref ? '-' + req.ref : ''}${req.type === 'read_file' ? `-${Number.isInteger(n) ? n : 'x'}` : ''}`;
  safePost(port, {
    sessionId: sid,
    type: 'STREAM_TOOL',
    phase: 'call',
    callId,
    toolName: req.ref ? `read_tab ${req.ref}` : fileBase ? `read_file ${fileBase}` : req.type,
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

  const protocolSkill = mode.expectJson && !shouldDowngradeToJsonDisabled(mode, userQuery)
    ? await ensureProtocolSkill()
    : null;
  const threadId = msgThreadId(conversationId);
  const prompt = buildPrompt(mode, pageContext, userQuery, { effectiveTier, ...(shotOnly ? { screenshotOnly: true } : {}), skills, workspaceFiles, ...(protocolSkill ? { protocolSkill } : {}), ...(threadId ? { establishedThread: true } : {}) });
  // Per-chat threading: the sidepanel sends the chat's stored thread id; the
  // global stays as the fallback for ambient callers (context menu, omnibox).

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

/**
 * #52 read_file pull source: one MCP `read_file` call for a workspace file.
 * Paths are validated + confined to /home/workspace (safeWorkspacePath) before
 * the tool sees them. Args shape is pinned by the drift baseline
 * (scripts/zo-drift/baseline/mcp-tools.json: required `target_file`, optional
 * line-range flags we don't need — whole file). Response shape is
 * live-verified (probe-read-file.ts): a JSON array [fileText, fileRefLine],
 * NOT a bash-style Python-repr CmdResult and NOT plain text. Missing files
 * come back isError:true → mcpToolCall throws → {ok:false}. Never throws —
 * callers get {ok, path, content} or {ok:false, error}.
 */
async function readWorkspaceFile(pathInput) {
  if (!config.zoAccessToken) return { ok: false, error: 'Zo access token not configured.' };
  const path = safeWorkspacePath(typeof pathInput === 'string' ? pathInput : '', WORKSPACE_ROOT);
  if (!path) {
    return { ok: false, error: `Path must be an absolute path inside ${WORKSPACE_ROOT}.` };
  }
  try {
    const result = await mcpToolCall('read_file', { target_file: path });
    const raw = toolText(result);
    // Live-verified 2026-09-14 (tests/test-prompts/probe-read-file.ts): the
    // tool returns a JSON ARRAY — [0] is the file text, [1] a `kind='file_ref'`
    // descriptor line. Unwrap when it parses so the follow-up carries the
    // clean file text, not the wrapper; non-array/plain text falls through.
    let content = raw;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') content = parsed[0];
    } catch { /* not JSON — use as-is */ }
    if (!content || !content.trim()) {
      return { ok: false, error: 'File is empty or unreadable.' };
    }
    return { ok: true, path, content };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---- protocol-skill install (#235) ------------------------------------------
// The extension bundles a versioned "cobrowse protocol" Zo skill and installs
// it into the user's workspace so action turns slim their tail to a skill
// pointer + envelope demand. Pure halves (paths, version parse/inject, slim
// tail text) live in lib/protocol-skill.js + lib/prompt.js; this is the
// impure half: bundled-artifact fetch, MCP read/write, one-shot ask fallback,
// session state. Per the slate invariant the slim tail engages ONLY on a
// verified read-back at the current extension version.

let protocolSkillMemo = null; // per-worker memo over the session-storage state

async function readSkillState() {
  try {
    const bag = await chrome.storage.session.get(SKILL_STATE_KEY);
    return bag[SKILL_STATE_KEY] || protocolSkillMemo;
  } catch {
    return protocolSkillMemo; // session storage unavailable (tests) — memo only
  }
}

async function writeSkillState(state) {
  protocolSkillMemo = state;
  try {
    await chrome.storage.session.set({ [SKILL_STATE_KEY]: state });
  } catch { /* memo is the fallback */ }
}

/**
 * Versioned install: read the installed copy → write when missing/stale →
 * verify by canary read-back. MCP write_file first; the proven one-shot
 * agent-write prompt (save-page pattern) is the fallback. Total failure pins
 * the checked version so the session stops retrying and keeps the inline tail.
 */
async function installProtocolSkill(extVersion) {
  let bundled;
  try {
    const r = await fetch(chrome.runtime.getURL(BUNDLED_SKILL_PATH));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bundled = await r.text();
    if (!bundled.trim()) throw new Error('empty artifact');
  } catch (err) {
    return { installed: false, checkedVersion: extVersion, reason: `bundled artifact unreadable: ${err?.message || err}` };
  }
  const content = injectVersion(bundled, extVersion);
  // read_file returns a JSON array [fileText, fileRefLine] (live-verified
  // #52 shape) — unwrap before parsing the frontmatter version.
  const readInstalled = async () => {
    const result = await mcpToolCall('read_file', { target_file: PROTOCOL_SKILL_PATH });
    const raw = toolText(result);
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0];
    } catch { /* plain text — use as-is */ }
    return raw;
  };
  // Already at this version? Skip the write.
  try {
    if (parseInstalledVersion(await readInstalled()) === extVersion) {
      return { installed: true, checkedVersion: extVersion, version: extVersion, via: 'mcp' };
    }
  } catch { /* missing or MCP hiccup → (re)install below */ }
  try {
    await mcpToolCall('write_file', { target_file: PROTOCOL_SKILL_PATH, content });
    if (parseInstalledVersion(await readInstalled()) === extVersion) {
      return { installed: true, checkedVersion: extVersion, version: extVersion, via: 'mcp' };
    }
    return { installed: false, checkedVersion: extVersion, reason: 'read-back verification failed' };
  } catch (err) {
    try {
      await oneShotWorkspaceWrite(PROTOCOL_SKILL_PATH, content);
      if (parseInstalledVersion(await readInstalled()) === extVersion) {
        return { installed: true, checkedVersion: extVersion, version: extVersion, via: 'ask' };
      }
    } catch { /* fall through */ }
    return { installed: false, checkedVersion: extVersion, reason: err?.message || String(err) };
  }
}

/**
 * One-shot agent-write fallback — mirrors savePageToWorkspace's non-streaming
 * write prompt (deliberately NOT a buildPrompt/askZo call: no recursion, no
 * thread, no conversation id).
 */
async function oneShotWorkspaceWrite(path, content) {
  const prompt = `Write the following content to the file at path \`${path}\` in my workspace. Create the directory if it does not exist. Use write_file or equivalent. Do not respond with anything other than a confirmation with the file path.\n\n---CONTENT START---\n${content}\n---CONTENT END---`;
  const resp = await fetch(config.zoApiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.zoAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: prompt, model_name: config.zoModel || undefined }),
  });
  if (!resp.ok) throw new Error(`Zo API error: ${resp.status}`);
  await resp.json().catch(() => ({}));
}

/**
 * Checked once per extension version per session (chrome.storage.session —
 * survives MV3 worker restarts): verified installs pin for the session; a
 * version bump (extension update) re-checks on the next action turn.
 */
async function ensureProtocolSkill() {
  const extVersion = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest().version : null;
  if (!extVersion || !config.zoAccessToken) return null;
  const state = await readSkillState();
  if (state && state.checkedVersion === extVersion) return state;
  const next = await installProtocolSkill(extVersion);
  await writeSkillState(next);
  return next;
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

  // Test 2: Zo.space endpoint (optional since #339 — skipped, not failed,
  // when unconfigured)
  let spaceOk = false;
  if (config.zoSpaceEndpoint) {
    try {
      const r = await fetch(config.zoSpaceEndpoint, { method: 'HEAD' });
      spaceOk = r.ok || r.status === 301 || r.status === 302;
    } catch {
      // spaceOk stays false
    }
  }

  return { success: zoOk, zoApi: zoOk, zoSpace: spaceOk };
}

/** Jev connectivity probe (0.3.4 Lane J1, JEV_TEST). One noul ping against
 *  the configured decide endpoint — proves the key + wire format work and
 *  reports latency. Never throws; works even while jevEnabled is false so
 *  the user can validate a key before opting in. */
async function jevTest() {
  if (!config.jevApiKey) {
    return { ok: false, error: 'Jev API key not configured.' };
  }
  const url = config.jevApiUrl || DEFAULT_JEV_API_URL;
  const body = buildDecideRequest({
    model: config.jevModel || DEFAULT_JEV_MODEL,
    state: 'Jev connectivity probe from the Zo Co-browse extension.',
    questions: { probe: { type: 'noul', instructions: 'The state is a connectivity probe sent by a browser extension. The probe reached the model.' } },
  });
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      signal: controller.signal,
      method: 'POST',
      headers: { Authorization: `Bearer ${config.jevApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: `Jev endpoint returned ${res.status}${txt ? ' — ' + txt.slice(0, 140) : ''}` };
    }
    const parsed = parseDecideResponse(await res.json().catch(() => null));
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, latencyMs: Date.now() - t0, model: parsed.model, usage: parsed.usage, answer: parsed.answers.probe || null };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'Jev request timed out after 10s.' : `Jev probe failed: ${err.message}`;
    return { ok: false, error: msg };
  }
}

/** Jev decide transport (0.3.4 Lane J2): the lib impl with this worker's
 *  config + fetch; state passes through the redaction boundary so secrets
 *  never reach TypeSafe AI. Never throws — every failure carries a reason. */
async function jevDecide(state, questions) {
  const r = await jevDecideImpl(
    fetch,
    {
      apiUrl: config.jevApiUrl || DEFAULT_JEV_API_URL,
      apiKey: config.jevApiKey,
      model: config.jevModel || DEFAULT_JEV_MODEL,
    },
    redactStateForJev(state),
    questions,
  );
  debugLog.push('jev', r.ok ? 'decide' : 'decide-fallback', r.latencyMs, r.ok ? undefined : { reason: r.reason });
  return r;
}

/** Jev gating precheck: the fast path only exists for opted-in, keyed users. */
function jevReady() {
  return !!(config.jevEnabled && config.jevApiKey);
}

/** Fresh clickable-candidate inventory for the pick hook (the Zo action path
 *  fails without candidates; the tier-2 capture already lists clickables). */
async function fetchClickableCandidates(tabId) {
  try {
    const cap = await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_CONTEXT', tier: 2 });
    return (((cap && cap.clickable) || []))
      .filter((c) => (c.text || '').trim())
      .slice(0, 20)
      .map((c) => ({ text: c.text, selector: c.selector }));
  } catch {
    return [];
  }
}

/** Hook B — click-pick (#342): rescue a failed click by asking Jev which
 *  near-miss candidate matches the planner's description. High confidence →
 *  the winner's selector; anything else → the existing failure (and its
 *  healer/handoff path) stands untouched. */
async function jevPickClickTarget(action, candidates) {
  const description = safeText(action.text || action.cue || '').slice(0, 120);
  if (!description) return { ok: false, reason: 'no description to match' };
  const labeled = candidates.map((c, i) => ({ id: `c${i}`, label: safeText(c.text || c.question || '').slice(0, 60) }));
  if (!labeled.some((c) => c.label)) return { ok: false, reason: 'no labeled candidates' };
  const r = await jevDecide({ url: '', title: '', candidates: labeled }, matchChoiceQuestion(description, labeled));
  if (!r.ok) return { ok: false, reason: r.reason };
  const ans = r.answers.target;
  const idx = Number(String(ans && ans.choice || '').replace(/^c/, ''));
  const conf = ans && typeof ans.confidence === 'number'
    ? ans.confidence
    : (ans && ans.probabilities ? (ans.probabilities[ans.choice] ?? 0) : 0);
  if (!shouldAct(conf, config.jevPickConfidence)) {
    return { ok: false, reason: `low confidence (${Number(conf).toFixed(2)} < ${config.jevPickConfidence})`, latencyMs: r.latencyMs };
  }
  const winner = candidates[idx];
  if (!winner || !winner.selector) return { ok: false, reason: 'picked candidate has no selector', latencyMs: r.latencyMs };
  return { ok: true, selector: winner.selector, question: description, confidence: conf, latencyMs: r.latencyMs };
}

/** Hook A — done-gate (#342): is the run's goal ALREADY satisfied on the page
 *  the fresh capture just saw? A confident yes (noul ≥ jevDoneConfidence)
 *  completes the run without the continuation's Zo round-trip; low confidence
 *  or any failure returns false and the chain proceeds exactly as before. */
async function jevDoneGate(run, pageContext) {
  const goal = safeText(run && run.goal || '').slice(0, 300);
  if (!goal || !pageContext) return null;
  const gate = await jevDecide(
    {
      url: safeText(pageContext.url || ''),
      title: safeText(pageContext.title || ''),
      pageText: safeText(pageContext.visibleText || '').replace(/\s+/g, ' ').trim().slice(0, 800),
    },
    doneGateQuestion(goal),
  );
  if (!gate.ok) return null;
  const noul = gate.answers.goal_done && gate.answers.goal_done.noul;
  if (typeof noul !== 'number' || !shouldAct(noul, config.jevDoneConfidence)) return null;
  return { noul, latencyMs: gate.latencyMs };
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
// ── Handoff runs (Lane E, #101) ─────────────────────────────────────────────
// Delegate-mode loops: the user primes a goal (!handoff), Zo works unattended
// up to a boundary (lib/handoff owns the pure state machine + boundary rules).
// Event-driven, never SW-resident: each turn's EXECUTE_ACTIONS completion
// triggers the continuation check. Run state persists to storage.session so
// an MV3 worker restart PAUSES a run (never strands it); the memory-only turn
// context is what dies with the worker.

const handoffStore = {
  key: 'cobrowse_handoff_runs',
  async load() {
    const o = await chrome.storage.session.get(this.key);
    return (o && o[this.key]) || {};
  },
  async save(runs) {
    await chrome.storage.session.set({ [this.key]: runs });
  },
};

// runId → { port, msg } — the turn template the loop replays with a fresh
// continuation prompt. Deliberately NOT persisted: when the worker restarts
// the orphan-pause sweep below marks the run paused instead.
const handoffTurnCtx = new Map();

async function handoffNotify(run) {
  try { await chrome.runtime.sendMessage({ type: 'HANDOFF_UPDATE', run }); } catch { /* no panel open */ }
}

async function handoffPut(run) {
  const runs = await handoffStore.load();
  runs[run.runId] = run;
  await handoffStore.save(runs);
  handoffUpdateBadge(runs);
  handoffMaybeNotify(run);
  await handoffNotify(run);
  return run;
}

// Extension-badge marker while any handoff run is live (Lane E item 12) —
// visible even with the panel closed. Defensive: the action API may be
// unavailable in test/mock contexts.
function handoffUpdateBadge(runs) {
  const live = Object.values(runs).some((r) => r.status === 'running' || r.status === 'priming');
  try {
    if (live) {
      chrome.action.setBadgeBackgroundColor({ color: '#5b8def' });
      chrome.action.setBadgeText({ text: '▶' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch { /* no action API here */ }
}

// One-shot notification when a run finishes or parks at the boundary — the
// point of delegating is walking away. Paused/aborted stay panel-only (the
// user either caused them or can resume from the panel).
function handoffMaybeNotify(run) {
  if (run.status !== 'done' && run.status !== 'blocked') return;
  try {
    chrome.notifications.create(`handoff-${run.runId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: run.status === 'done' ? 'Zo handoff finished' : 'Zo handoff needs you',
      message: `${safeText(run.goal).slice(0, 120)}${run.stopReason ? ' — ' + safeText(run.stopReason).slice(0, 120) : ''}`,
    });
  } catch { /* notifications unavailable */ }
}

async function handoffGet({ runId, chatId } = {}) {
  const runs = await handoffStore.load();
  if (runId) return runs[runId] || null;
  if (chatId) {
    return Object.values(runs).find((r) => r.chatId === chatId && !['done', 'aborted'].includes(r.status)) || null;
  }
  return null;
}

// SW restart: a running (or priming — turn 1 never landed) run lost its turn
// context — pause it honestly so the panel can offer resume instead of the
// user waiting on a dead loop. (#165: priming runs were skipped and stranded.)
(function handoffPauseOrphans() {
  handoffStore.load().then(async (runs) => {
    let dirty = false;
    for (const run of Object.values(runs)) {
      if (run.status === 'running' || run.status === 'priming') {
        const res = handoffTransition(run, 'pause', { now: Date.now(), reason: 'extension restarted — resume to continue' });
        if (res.ok) { runs[run.runId] = res.run; dirty = true; }
      }
    }
    if (dirty) await handoffStore.save(runs);
  }).catch(() => { /* storage unavailable — nothing to sweep */ });
})();

// C1 (#289): the compose sink. One value-stripped observation record per
// executed action ({source:'zo'}) plus one per boundary park
// ({source:'boundary'}) — the raw material assembleComposedDraft turns into a
// draft when the user saves the run. Values NEVER land here: fill actions'
// `value` is dropped unconditionally (defense-in-depth with the #243
// redaction round), only targeting cues ride along. `actions` must be the
// SAME isContextAction-filtered list the executor saw — res.results is
// index-aligned with it (F2, review round 1).
function handoffObsRecords(actions, res, pageUrl) {
  const results = (res && res.results) || [];
  const records = [];
  const cuesFromAction = (a) => [
    ...(a.selector ? [{ strategy: 'selector', value: String(a.selector) }] : []),
    ...(a.text ? [{ strategy: 'text', value: String(a.text) }] : []),
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const a = actions[i] || {};
    if (!r || !r.type || r.type === 'done') continue;
    if (r.handoffParked) {
      records.push({
        source: 'boundary',
        op: r.type,
        url: pageUrl,
        cues: cuesFromAction(a),
        reason: safeText(r.error || 'refused by the run boundary'),
        ts: Date.now(),
      });
      continue;
    }
    if (!r.ok) continue; // failed attempts aren't steps — the retry (if any) records the working cue
    if (r.type === 'navigate') {
      records.push({ source: 'zo', op: 'navigate', url: String(a.url || pageUrl), ts: Date.now() });
      continue;
    }
    if (['click', 'fill', 'check', 'extract'].includes(r.type)) {
      records.push({
        source: 'zo',
        op: r.type,
        url: pageUrl,
        cues: cuesFromAction(a),
        ...(r.type === 'click' && handoffIsSubmitish(a) ? { submitish: true } : {}),
        ...(r.type === 'check' && a.checked !== undefined ? { checked: !!a.checked } : {}),
        ...(r.type === 'extract' ? { evidenceKey: safeText(a.evidenceKey || a.text || '') } : {}),
        ts: Date.now(),
      });
    }
    // scroll/wait/read_* results are traversal noise — not steps, dropped.
  }
  return records;
}

async function handoffAfterExecute(runId, request, res) {
  try {
    let run = await handoffGet({ runId });
    if (!run || run.status !== 'running') return;
    // Same filter the executor saw — res.results is index-aligned with the
    // DOM actions only (context/pull actions never reach it).
    const actions = (request.actions || []).filter((a) => a && !isContextAction(a));
    const results = (res && res.results) || [];

    // Compose sink (C1 #289): remember what this turn executed/parked before
    // anything else — records persist even when the run ends on this turn.
    const obs = handoffObsRecords(actions, res, request.url);
    if (obs.length) run = handoffRecordObs(run, obs);

    // Tally the completed turn; navigations from successful navigate actions.
    const navOk = results.filter((r) => r && r.type === 'navigate' && r.ok).length;
    run = handoffTally(run, { turns: 1, navigations: navOk });
    if (navOk) {
      try {
        const tab = await chrome.tabs.get(request.tabId);
        if (tab?.url) run = handoffRecordVisit(run, tab.url);
      } catch { /* tab gone — visit tracking skips it */ }
    }
    // Park boundary refusals so the user can perform them from the review card.
    for (const r of results) {
      if (r && r.handoffParked) run = handoffPark(run, r.action || { type: r.type }, r.error, request.url);
    }

    // C2 (#290): compose turns never chain past a park — the human acts on
    // the page and resolves it. Two park sources: the boundary REFUSING a
    // fillish/submitish action (kind: value/checkpoint), and Zo explicitly
    // asking via done(response:"PARK: …") (kind: value/choice).
    if (run.compose) {
      const refused = results.filter((r) => r && r.handoffParked);
      for (const r of refused) {
        const a = r.action || {};
        const fillish = handoffIsFillish(a);
        run = addComposePark(run, {
          kind: fillish ? 'value' : 'checkpoint',
          question: fillish
            ? `Fill the form${a.text ? ` (${safeText(a.text).slice(0, 60)})` : ''} on the page`
            : `Review and click ${safeText(a.text || a.selector || 'the control').slice(0, 60)} yourself`,
          action: {
            type: a.type,
            ...(a.selector ? { selector: safeText(a.selector).slice(0, 120) } : {}),
            ...(a.text ? { text: safeText(a.text).slice(0, 60) } : {}),
          },
          url: request.url,
        });
      }
      const doneAct = results.find((r) => r && r.type === 'done') || actions.find((a) => a && a.type === 'done');
      const doneResp = safeText(doneAct?.response || '');
      if (!refused.length && doneResp.startsWith('PARK:')) {
        const parts = doneResp.slice(5).split('|').map((s) => s.trim()).filter(Boolean);
        run = addComposePark(run, {
          kind: parts.length > 1 ? 'choice' : 'value',
          question: parts[0] || 'Your turn',
          ...(parts.length > 1 ? { options: parts.slice(1) } : {}),
          url: request.url,
        });
      }
      if ((run.parks || []).some((p) => !p.resolved)) {
        const t = handoffTransition(run, 'block', { now: Date.now(), reason: 'compose parked — waiting for you' });
        await handoffPut(t.ok ? t.run : run);
        return; // no continuation: the human resolves the park first
      }
    }

    // done() ends the run — its response is the deliverable.
    const doneResult = results.find((r) => r && r.type === 'done') || actions.find((a) => a && a.type === 'done');
    if (doneResult) {
      const reason = safeText(doneResult.response || '').slice(0, 200) || 'goal reached';
      const t = handoffTransition(run, 'complete', { now: Date.now(), reason });
      handoffTurnCtx.delete(runId);
      // C2: a compose session that completed naturally disarms — the human
      // producer goes with the run (review F4).
      if (t.ok && t.run.compose) {
        await composeStore.clear();
        composeBroadcastRecordState(false).catch(() => {});
      }
      await handoffPut(t.ok ? t.run : run);
      return;
    }

    // Budget exhausted → blocked: the run cannot continue without the user's
    // call (wrap up vs raise the budget), so it needs their attention — the
    // 'blocked' status is what fires the one-shot "needs you" notification
    // (#157). The panel offers ▶ Resume, same as a paused run.
    const budget = handoffWithinBudget(run);
    if (!budget.ok) {
      const t = handoffTransition(run, 'block', { now: Date.now(), reason: budget.reason });
      handoffTurnCtx.delete(runId);
      await handoffPut(t.ok ? t.run : run);
      return;
    }

    await handoffPut(run);
    handoffChainNextTurn(runId);
  } catch (e) {
    console.debug('handoffAfterExecute:', e);
  }
}

async function handoffChainNextTurn(runId) {
  const ctx = handoffTurnCtx.get(runId);
  const run = await handoffGet({ runId });
  if (!ctx || !run || run.status !== 'running') return;
  const { port, msg } = ctx;
  if (port._dead) {
    const t = handoffTransition(run, 'pause', { now: Date.now(), reason: 'panel closed mid-run' });
    handoffTurnCtx.delete(runId);
    await handoffPut(t.ok ? t.run : run);
    return;
  }
  // Fresh page state for the driven tab — Zo navigated since the last capture.
  const captureTier = msg.effectiveTier || 1;
  let pageContext = null;
  try {
    pageContext = await getActiveTabContext(run.tabId, captureTier, msg.modeId);
  } catch { /* capture failed — Zo can still pull (read_page) */ }

  // Hook A (#342): before spending a Zo turn on the continuation, ask the
  // fast path whether the goal is ALREADY satisfied on this page. A confident
  // yes completes the run — no Zo round-trip. Compose runs skip the gate:
  // their completion is Zo's done() + the save/rehearsal flow. Low confidence
  // or any Jev failure chains the Zo turn exactly as before.
  if (!run.compose && jevReady() && pageContext) {
    const gate = await jevDoneGate(run, pageContext);
    if (gate) {
      const t = handoffTransition(run, 'complete', {
        now: Date.now(),
        reason: `⚡ Jev done-gate: goal already complete (noul ${gate.noul.toFixed(2)}, ${gate.latencyMs}ms) — no Zo turn spent`,
      });
      handoffTurnCtx.delete(runId);
      await handoffPut(t.ok ? t.run : run);
      return;
    }
  }

  const turnMsg = handoffContinuationPayload(msg, {
    sessionId: `${msg.sessionId}-h${run.usage.turns + 1}-${Date.now() % 100000}`,
    // Thread continuity: turn 1's conversation_id echo (the ambient global,
    // just updated by the previous turn's header) — without this every
    // continuation opens a FRESH Zo thread that never saw the goal.
    conversationId: msg.conversationId || zoConversationId || undefined,
    // Continuation prompt only — the instructions rode turn 1 and live in the
    // thread; re-sending them (marker included) confuses marker routing.
    userQuery: buildContinuationTurn(run),
    pageContext,
    runId,
    // #300: the capture THIS turn performed — surfaces as the footer chip.
    contextTier: captureTier,
    contextReason: 'handoff continuation capture',
  });
  askZoStream(port, turnMsg).catch(async () => {
    // Stream failed mid-run — blocked, not paused: the run cannot proceed
    // unattended and the user (who walked away by design) must be told. The
    // panel offers ▶ Resume (#157).
    const r = await handoffGet({ runId });
    if (r && r.status === 'running') {
      const t = handoffTransition(r, 'block', { now: Date.now(), reason: 'stream error mid-run' });
      handoffTurnCtx.delete(runId);
      await handoffPut(t.ok ? t.run : r);
    }
  });
}

// ---- Compose sessions (0.3.2 C2, #290) -------------------------------------
// `!recipe compose <goal>`: a handoff-engine run with the COMPOSE boundary —
// Zo drives (navigate + non-submitish clicks; the boundary REFUSES fills and
// submits in code), parks at values/ambiguity/checkpoints, and the human's
// on-page actions stream into the same obs log via the recorder listeners
// (source:'human' — the second producer). Completion rides C1: ↧ Save as
// recipe → composed draft → mandatory rehearsal.

const composeStore = {
  key: 'cobrowse_recipe_compose',
  async load() {
    const o = await chrome.storage.session.get(this.key);
    return (o && o[this.key]) || null;
  },
  async save(s) { await chrome.storage.session.set({ [this.key]: s }); },
  async clear() { await chrome.storage.session.remove(this.key); },
};

// The recorder's re-arm broadcast, shared with compose — content scripts only
// care THAT recording is armed, not which flavor started it.
function composeBroadcastRecordState(armed) {
  return recipeBroadcastRecordState(armed);
}

async function recipeComposeStart({ chatId, tabId, goal, name } = {}) {
  const safeGoal = safeText(goal);
  if (!safeGoal) return { ok: false, error: 'compose needs a goal — `!recipe compose <goal>`' };
  // One armed session at a time (the recorder's rule, extended to compose).
  const rec = await recipeRecStore.load();
  if (rec && rec.armed) return { ok: false, error: `already recording "${rec.name}" — stop it first` };
  const compose = await composeStore.load();
  if (compose && compose.armed) {
    const live = await handoffGet({ runId: compose.runId });
    if (live && !['done', 'aborted'].includes(live.status)) {
      return { ok: false, error: `a compose session is already live ("${safeText(live.compose?.name || live.goal)}") — stop it first` };
    }
  }
  // One live run per chat (mirrors the library popup's one-run rule).
  const liveRun = await handoffGet({ chatId });
  if (liveRun) return { ok: false, error: 'this chat already has a live run — stop it before composing' };

  const run = handoffCreateRunPure({
    chatId,
    goal: safeGoal,
    boundaryMode: 'compose',
    budget: config.cobrowse_handoff_budget || undefined,
  });
  run.compose = { name: safeText(name) || slugifyTitle(safeGoal, 48) || `composed-${new Date().toISOString().slice(0, 10)}` };
  if (tabId) run.tabId = tabId;
  await handoffPut(run);
  await composeStore.save({ armed: true, runId: run.runId, startedAt: Date.now() });
  composeBroadcastRecordState(true).catch(() => {});
  return { ok: true, run };
}

async function recipeComposeStop({ runId, reason } = {}) {
  const compose = await composeStore.load();
  const targetId = safeText(runId) || (compose ? compose.runId : '');
  const run = targetId ? await handoffGet({ runId: targetId }) : null;
  if (!run) return { ok: false, error: 'no live compose session' };
  await composeStore.clear();
  composeBroadcastRecordState(false).catch(() => {});
  if (['done', 'aborted'].includes(run.status)) return { ok: true, run };
  const res = handoffTransition(run, 'abort', { now: Date.now(), reason: safeText(reason) || 'compose stopped' });
  const saved = await handoffPut(res.ok ? res.run : run);
  return { ok: true, run: saved };
}

// Resolve a park: the human filled the page / picked an option / did the step
// by hand. Hands back the continuation turn — the PANEL re-issues it as an
// ASK_ZO carrying handoffRunId (the #164 mechanism re-registers the loop).
async function recipeComposeResume({ runId, parkId, text } = {}) {
  const compose = await composeStore.load();
  const targetId = safeText(runId) || (compose ? compose.runId : '');
  const run = targetId ? await handoffGet({ runId: targetId }) : null;
  if (!run || !run.compose) return { ok: false, error: 'no compose session for this run' };
  if (!['blocked', 'paused'].includes(run.status)) {
    return { ok: false, error: `run is ${run.status}, not waiting on you` };
  }
  let next = run;
  if (parkId) {
    const rec = (run.parks || []).find((p) => p.parkId === safeText(parkId) && !p.resolved);
    if (!rec) return { ok: false, error: 'that park is already resolved (or unknown)' };
    next = resolveComposePark(next, safeText(parkId), safeText(text) || 'done on the page');
  }
  const res = handoffTransition(next, 'resume', { now: Date.now(), reason: 'park resolved' });
  if (!res.ok) return { ok: false, error: res.error };
  const saved = await handoffPut(res.run);
  const pending = (saved.parks || []).find((p) => !p.resolved);
  const parkLine = pending
    ? `[compose park] Another step still needs the human: ${safeText(pending.question)} — work around it or park again.`
    : `[compose park resolved] The human ${safeText(text) ? `did: ${safeText(text).slice(0, 120)}` : 'completed the parked step on the page'}. Continue toward the goal.`;
  return { ok: true, run: saved, continuationQuery: `${buildContinuationTurn(saved)}\n\n${parkLine}` };
}

// C2: during a compose session the recorder's human events stream into the
// RUN's obs log (source:'human') — the second producer of the composed draft.
// Values ride ONLY here, from the human's own keyboard; the recorder's #243
// redaction already stripped sensitive ones upstream.
const COMPOSE_OBS_OPS = ['navigate', 'click', 'fill', 'check', 'attach', 'extract'];
async function composeObserve(obs) {
  const session = await composeStore.load();
  if (!session || !session.armed || !obs || typeof obs !== 'object' || !obs.op) return;
  if (!COMPOSE_OBS_OPS.includes(obs.op)) return;
  const run = await handoffGet({ runId: session.runId });
  if (!run || !run.compose || ['done', 'aborted'].includes(run.status)) return;
  // Whitelist the fields the recorder emits — nothing else reaches the obs
  // log (the artifact's raw material) from a runtime message (review F7).
  await handoffPut(handoffRecordObs(run, {
    source: 'human',
    op: String(obs.op),
    ...(typeof obs.url === 'string' ? { url: obs.url.slice(0, 500) } : {}),
    ...(Array.isArray(obs.cues) ? { cues: obs.cues } : {}),
    ...(obs.op === 'fill' && typeof obs.value === 'string' ? { value: obs.value.slice(0, 2000) } : {}),
    ...(typeof obs.checked === 'boolean' ? { checked: obs.checked } : {}),
    ...(typeof obs.submitish === 'boolean' ? { submitish: obs.submitish } : {}),
    ...(typeof obs.fieldSensitive === 'boolean' ? { fieldSensitive: obs.fieldSensitive } : {}),
    ...(typeof obs.pageSensitive === 'boolean' ? { pageSensitive: obs.pageSensitive } : {}),
    ...(obs.op === 'extract' || obs.op === 'attach' ? { evidenceKey: safeText(obs.evidenceKey || '') } : {}),
    ts: Date.now(),
  }));
}

// ---- Recipes: deterministic player (#220) ---------------------------------
// Plays a saved Recipe step by step with NO LLM turn. Same lifecycle contract
// as the handoff loop: event-driven, never SW-resident — each step is one
// short async continuation, run state persists to storage.session before and
// after every step, and an MV3 worker restart PAUSES the run (never strands
// it; `waiting_human` checkpoints survive — the user is off paying anyway).
// Design: docs/superpowers/specs/2026-09-14-recipes-design.md

const recipeStore = {
  key: 'cobrowse_recipe_runs',
  async load() {
    const o = await chrome.storage.session.get(this.key);
    return (o && o[this.key]) || {};
  },
  async save(runs) {
    await chrome.storage.session.set({ [this.key]: runs });
  },
};

// Learned + healed recipes (draft artifacts), keyed by name. storage.local —
// they are user artifacts meant to survive the browser, but they are NOT
// settings (never synced).
const recipeLibrary = {
  key: 'cobrowse_recipes',
  async load() {
    const o = await chrome.storage.local.get(this.key);
    return (o && o[this.key]) || {};
  },
  async save(lib) {
    await chrome.storage.local.set({ [this.key]: lib });
  },
};

async function recipeNotify(run) {
  // Snapshot: runtime messages are structured-cloned in real Chrome — send a
  // frozen copy so a live run object mutating between saves can't rewrite
  // what earlier pushes already delivered.
  let snapshot = run;
  try { snapshot = JSON.parse(JSON.stringify(run)); } catch { /* send as-is */ }
  try { await chrome.runtime.sendMessage({ type: 'RECIPE_UPDATE', run: snapshot }); } catch { /* no panel open */ }
}

async function recipePut(run) {
  const runs = await recipeStore.load();
  runs[run.runId] = run;
  await recipeStore.save(runs);
  await recipeNotify(run);
  return run;
}

async function recipeGet({ runId, chatId } = {}) {
  const runs = await recipeStore.load();
  if (runId) return runs[runId] || null;
  if (chatId) {
    return Object.values(runs).find((r) => r.chatId === chatId && !['done', 'aborted'].includes(r.status)) || null;
  }
  return null;
}

// One-shot notification at the moments a possibly-away user is needed or the
// run finished — mirrors handoffMaybeNotify.
function recipeMaybeNotify(run) {
  if (!['waiting_human', 'blocked', 'done'].includes(run.status)) return;
  const titles = { waiting_human: 'Recipe needs you', blocked: 'Recipe run blocked', done: 'Recipe finished' };
  try {
    chrome.notifications.create(`recipe-${run.runId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: titles[run.status],
      message: `${safeText(run.name).slice(0, 120)}${run.stopReason || run.humanTitle ? ' — ' + safeText(run.stopReason || run.humanTitle).slice(0, 120) : ''}`,
    });
  } catch { /* notifications unavailable */ }
}

// SW restart: a running/healing run lost its in-flight continuation. Pause it
// honestly — resume replays the CURRENT step (auto steps are re-runnable).
// waiting_human checkpoints are NOT swept: the parked state is durable.
(function recipePauseOrphans() {
  recipeStore.load().then(async (runs) => {
    let dirty = false;
    for (const run of Object.values(runs)) {
      if (run.status === 'running' || run.status === 'healing') {
        run.status = 'paused';
        run.stopReason = 'extension restarted — resume to continue';
        run.updatedAt = Date.now();
        dirty = true;
      }
    }
    if (dirty) await recipeStore.save(runs);
  }).catch(() => { /* storage unavailable — nothing to sweep */ });
})();

// Load a recipe artifact from the workspace (MCP read_file) or the local
// learned-recipes library.
async function recipeLoad(source) {
  if (source && source.localName) {
    const lib = await recipeLibrary.load();
    const recipe = lib[source.localName];
    return recipe ? { ok: true, recipe } : { ok: false, error: `no saved recipe named "${source.localName}" (!recipe list shows what's saved)` };
  }
  const res = await readWorkspaceFile(String((source && source.workspacePath) || ''));
  if (!res.ok) return { ok: false, error: res.error };
  try {
    return { ok: true, recipe: JSON.parse(res.content) };
  } catch (e) {
    return { ok: false, error: `recipe is not valid JSON: ${e.message}` };
  }
}

async function recipeTabUrl(tabId) {
  try { return (await chrome.tabs.get(tabId)).url || ''; } catch { return ''; }
}

// {{evidenceKey}} interpolation for the done message — params were already
// substituted at start; evidence only exists at run time.
function recipeInterpolateEvidence(text, evidence) {
  return String(text || '').replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (m, key) => {
    const hit = (evidence || []).find((e) => e.key === key);
    return hit ? hit.value : m;
  });
}

async function recipeStart(request) {
  const loaded = await recipeLoad(request.source || {});
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const recipe = loaded.recipe;
  const verdict = validateRecipe(recipe);
  if (!verdict.ok) {
    return { ok: false, error: `invalid recipe: ${verdict.errors[0]}`, errors: verdict.errors };
  }
  const values = request.paramValues || {};
  const missing = (recipe.params || []).filter((p) => p.required && values[p.name] === undefined && p.default === undefined);
  if (missing.length) {
    // The panel renders a params card and re-sends with paramValues.
    return { ok: false, needsParams: true, params: recipe.params };
  }
  const sub = substituteParams(recipe, values);
  if (!sub.ok) return { ok: false, error: sub.errors.join('; ') };

  const now = Date.now();
  // C1 (#289): a composed draft's first run is its rehearsal — checkpoints
  // are unskippable and success promotes the library entry.
  const composedRehearsal = recipe.composedBy === 'zo' && recipe.verified !== true;
  const run = {
    runId: `rec-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    recipeId: recipe.id,
    name: recipe.name,
    origin: request.source.localName ? `local:${request.source.localName}` : String(request.source.workspacePath || 'recipe'),
    version: recipe.version,
    chatId: request.chatId,
    status: 'running',
    stepIndex: 0,
    stepsTotal: sub.recipe.steps.length,
    params: values,
    evidence: [],
    healCount: 0,
    ...(composedRehearsal ? { composedRehearsal: true } : {}),
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    // The substituted recipe rides the run so playback is deterministic and
    // survives an SW restart without re-reading the workspace.
    recipe: sub.recipe,
  };
  if (request.tabId) run.tabId = request.tabId;
  await recipePut(run);
  recipePlayStep(run.runId).catch((e) => console.debug('recipePlayStep:', e));
  return { ok: true, run };
}

// Park a run as blocked — the deterministic loop cannot continue (cue miss,
// backstop refusal, failed precondition). Terminal for this PR; the healer
// takes cue-misses over in the next round.
async function recipeBlock(runId, reason) {
  const run = await recipeGet({ runId });
  if (!run || ['done', 'aborted', 'blocked'].includes(run.status)) return run;
  run.status = 'blocked';
  run.stopReason = safeText(reason).slice(0, 200);
  run.updatedAt = Date.now();
  const saved = await recipePut(run);
  recipeMaybeNotify(saved);
  return saved;
}

async function recipeAdvance(runId) {
  const run = await recipeGet({ runId });
  if (!run || run.status !== 'running') return;
  run.stepIndex += 1;
  run.updatedAt = Date.now();
  if (run.stepIndex >= run.stepsTotal) {
    // Ran off the end without a done step — still a completion, honestly noted.
    const promoteNote = await recipePromoteComposed(run);
    run.status = 'done';
    run.stopReason = promoteNote ? `recipe finished (no done step) — ${promoteNote}` : 'recipe finished (no done step)';
    const saved = await recipePut(run);
    recipeMaybeNotify(saved);
    return;
  }
  await recipePut(run);
  recipePlayStep(runId).catch((e) => console.debug('recipePlayStep:', e));
}

// C1 (#289): a composed draft's rehearsal just finished — promote the library
// entry (verified:true, draft:false, patch bump) so the next run skips the
// rehearsal. Missing entry (deleted mid-run) promotes nothing. Returns the
// honest note to append to the run's done line, or '' for non-rehearsals.
async function recipePromoteComposed(run) {
  if (!run.composedRehearsal) return '';
  const lib = await recipeLibrary.load();
  const entry = lib[run.name];
  if (!entry) return 'rehearsal finished — the recipe is no longer in the library, nothing to promote';
  // Promote the artifact that actually rehearsed — a mid-run replacement
  // under the same name never earned verified.
  if (entry.id !== run.recipeId) return 'rehearsal finished — the library entry was replaced mid-run, nothing to promote';
  entry.verified = true;
  entry.draft = false;
  entry.version = bumpVersion(entry.version, 'patch') || entry.version;
  entry.updatedAt = Date.now();
  lib[run.name] = entry;
  await recipeLibrary.save(lib);
  return '✅ Rehearsal passed — recipe verified';
}

async function recipePlayStep(runId) {
  const run = await recipeGet({ runId });
  if (!run || run.status !== 'running') return;
  const recipe = run.recipe;
  const i = run.stepIndex;
  const step = recipe.steps[i];
  const prev = i > 0 ? recipe.steps[i - 1] : null;

  // Runtime re-check of the E-INVARIANT — a patched/healed artifact can never
  // smuggle an undeclared submit past validateRecipe's load-time check.
  if (step.type === 'click' && step.submitish === true && (!prev || prev.type !== 'human')) {
    await recipeBlock(runId, 'submitish click not immediately after a human step (invariant)');
    return;
  }

  if (step.type === 'navigate') {
    const before = await recipeTabUrl(run.tabId);
    try {
      await chrome.tabs.update(run.tabId, { url: step.url });
    } catch (e) {
      await recipeBlock(runId, `navigate failed: ${e.message}`);
      return;
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(300);
      const url = await recipeTabUrl(run.tabId);
      if (step.expectUrl ? url.includes(step.expectUrl) : (url && url !== before)) break;
    }
    const url = await recipeTabUrl(run.tabId);
    if (step.expectUrl && !url.includes(step.expectUrl)) {
      await recipeBlock(runId, `expectUrl failed — wanted "${step.expectUrl}", still on ${url || 'unknown page'}`);
      return;
    }
    await recipeAdvance(runId);
    return;
  }

  if (step.type === 'human') {
    run.status = 'waiting_human';
    run.humanTitle = step.title;
    run.updatedAt = Date.now();
    const saved = await recipePut(run);
    recipeMaybeNotify(saved);
    return;
  }

  if (step.type === 'done') {
    const promoteNote = await recipePromoteComposed(run);
    run.status = 'done';
    const message = recipeInterpolateEvidence(step.message, run.evidence) || 'recipe complete';
    run.stopReason = promoteNote ? `${message} — ${promoteNote}` : message;
    run.updatedAt = Date.now();
    const saved = await recipePut(run);
    recipeMaybeNotify(saved);
    return;
  }

  // Auto steps (fill/click/check/attach/waitFor/extract) → the executor.
  let dataB64;
  if (step.type === 'attach') {
    const file = await recipeFetchFileBase64(step.path);
    if (!file.ok) {
      await recipeBlock(runId, `attach: ${file.error}`);
      return;
    }
    dataB64 = file.dataB64;
  }

  // #228: generate-at-runtime fill — the value is drafted when the step plays.
  if (step.type === 'fill' && step.generate) {
    await recipeGenerateFill(runId, step);
    return;
  }

  // Sensitive-page arming for click steps: payment submits are NEVER
  // auto-clicked, declared or not. Declared (submitish:true) steps park here;
  // UNdeclared clicks ride with the sensitive flag so the executor can probe
  // the resolved target — a form's submit control refuses in-page (#266) and
  // the refusal parks below. (The #26 backstop inside executeActions cannot
  // cover this: it gates on action.type === 'click', and this action is a
  // recipe_step.)
  let sensitive = false;
  if (step.type === 'click') {
    const pre = await captureFormFields(run.tabId);
    if (pre) sensitive = isSensitiveForm(pre.formFields, pre.url).sensitive;
    if (sensitive && step.submitish === true) {
      await recipeBlock(runId, 'sensitive/payment page — the submit stays yours (declare it inside the human checkpoint)');
      return;
    }
  }

  const res = await executeActions([{ type: 'recipe_step', step, dataB64, sensitive }], run.tabId, { recipe: true, sensitive });
  const r = (res.results && res.results[0]) || { ok: false, error: res.error || 'no result' };
  if (!r.ok) {
    if (r.refused === 'sensitive-submit') {
      await recipeBlock(runId, 'sensitive/payment page — the submit stays yours (declare it inside the human checkpoint)');
      return;
    }
    if (r.cueMiss) {
      // Cue-miss → exactly one re-ground turn (the healer) patches the cues,
      // bumps the version, caches the healed copy, and retries. No heal
      // budget left, or a failed heal → blocked.
      await recipeHeal(runId, step, r);
      return;
    }
    await recipeBlock(runId, `${step.type}: ${r.error}`);
    return;
  }
  if (step.type === 'extract') {
    const runNow = await recipeGet({ runId });
    runNow.evidence.push({ key: step.evidenceKey, label: step.label, value: String(r.value ?? ''), ts: Date.now() });
    runNow.updatedAt = Date.now();
    await recipePut(runNow);
  }
  await recipeAdvance(runId);
}

// attach bytes come from the workspace over the MCP bash tool (`base64 -w0`) —
// read_file is text-oriented and would corrupt binaries. ~1 MB cap (the RTI
// worked example's limit).
async function recipeFetchFileBase64(pathInput) {
  if (!config.zoAccessToken) return { ok: false, error: 'Zo access token not configured.' };
  const path = safeWorkspacePath(typeof pathInput === 'string' ? pathInput : '', WORKSPACE_ROOT);
  if (!path) return { ok: false, error: `path must be inside ${WORKSPACE_ROOT}` };
  try {
    const result = await mcpToolCall('bash', { cmd: `base64 -w0 ${shellQuote(path)}` });
    const raw = extractMarkedStdout(toolText(result)) || toolText(result);
    const dataB64 = String(raw || '').replace(/\s+/g, '');
    if (!dataB64) return { ok: false, error: 'empty base64 output' };
    if (dataB64.length > 1_400_000) return { ok: false, error: 'file too large for attach (cap ~1 MB)' };
    return { ok: true, dataB64 };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// RECIPE_RESUME: verify the pending checkpoint's postcondition (URL via a
// cheap capture; cue via a bounded waitFor probe), then continue. force:true
// is the manual fallback — the user asserts they're done, we record a warning.
async function recipeResume(request = {}) {
  const { runId, force } = request;
  const run = await recipeGet({ runId });
  if (!run) return { ok: false, error: 'no such recipe run' };
  if (!['waiting_human', 'paused', 'blocked'].includes(run.status)) {
    return { ok: false, error: `run is ${run.status}, not resumable` };
  }

  // #228: a pending generated-text review resolves here — Fill (with the
  // possibly-edited text) or Discard. Discarding parks the run blocked; a
  // later resume replays the step and generates a fresh draft.
  if (run.status === 'waiting_human' && run.pendingReview) {
    if (request.discard) {
      run.status = 'blocked';
      run.stopReason = 'generated text discarded';
      run.pendingReview = undefined;
      run.updatedAt = Date.now();
      const saved = await recipePut(run);
      recipeMaybeNotify(saved);
      return { ok: true, run: saved };
    }
    const finalText = typeof request.reviewText === 'string' && request.reviewText.trim()
      ? request.reviewText
      : run.pendingReview.text;
    const step = run.recipe.steps[run.stepIndex];
    run.pendingReview = undefined;
    run.humanTitle = undefined;
    run.status = 'running';
    run.updatedAt = Date.now();
    await recipePut(run);
    recipeFillValue(run.runId, step, finalText).catch((e) => console.debug('recipeFillValue:', e));
    return { ok: true, run };
  }

  const step = run.recipe.steps[run.stepIndex];

  if (run.status === 'waiting_human' && step && step.type === 'human') {
    // C1 (#289): a composed draft's rehearsal has NO manual fallback —
    // "verify or abort" is what makes the promotion mean something.
    if (force && run.composedRehearsal) {
      return { ok: false, error: 'rehearsal checkpoints must be verified — complete the step, or abort the run; the draft stays unverified', run };
    }
    if (step.timeoutMinutes && !force && Date.now() - run.updatedAt > step.timeoutMinutes * 60000) {
      return { ok: false, error: `checkpoint timed out (${step.timeoutMinutes} min) — resume with "skip check" to continue anyway`, run };
    }
    if (!force) {
      if (step.resumeOn.url) {
        const cap = await getActiveTabContext(run.tabId, 0, null).catch(() => null);
        const url = (cap && cap.url) || '';
        if (!url.includes(step.resumeOn.url)) {
          return { ok: false, error: `resume condition not met — still on ${url || 'an unknown page'}`, run };
        }
      }
      if (step.resumeOn.cue) {
        const probe = await executeActions(
          [{ type: 'recipe_step', step: { type: 'waitFor', cue: step.resumeOn.cue, timeoutMs: 2500 } }],
          run.tabId, {},
        );
        if (!probe.ok) {
          return { ok: false, error: 'resume condition not met — the expected element is not on the page', run };
        }
      }
    }
    if (force) {
      // #270: the manual fallback is honest — record that the postcondition
      // was never verified (the spec's "continue with a warning recorded").
      run.warnings = [...(run.warnings || []), `checkpoint "${safeText(step.title)}" skipped — postcondition not verified (manual fallback)`];
    }
    run.stepIndex += 1;
    run.humanTitle = undefined;
  }

  run.status = 'running';
  run.stopReason = undefined;
  run.updatedAt = Date.now();
  await recipePut(run);
  recipePlayStep(run.runId).catch((e) => console.debug('recipePlayStep:', e));
  return { ok: true, run };
}

async function recipeStop({ runId, reason } = {}) {
  const run = await recipeGet({ runId });
  if (!run) return { ok: false, error: 'no such recipe run' };
  if (['done', 'aborted'].includes(run.status)) {
    return { ok: false, run, error: `run already ${run.status}` };
  }
  run.status = 'aborted';
  run.stopReason = safeText(reason) || 'stopped by user';
  run.updatedAt = Date.now();
  const saved = await recipePut(run);
  return { ok: true, run: saved };
}

// R2 (#256): write a local-library recipe back to workspace JSON. The gate
// order matters: only validated recipes ever reach write_file (rule 2 of the
// 0.3.1 slate — a written file can never contain a state the player would
// refuse). Existence probing reuses read_file (the loader's transport); a
// content-drifted overwrite bumps the patch version first so the workspace
// copy stays the newest artifact.
async function recipeSave({ name, path, confirm } = {}) {
  const lib = await recipeLibrary.load();
  const key = safeText(name);
  const recipe = lib[key];
  if (!recipe) return { ok: false, error: `no local recipe named "${key}" (!recipe list shows what's saved)` };
  const verdict = validateRecipe(recipe);
  if (!verdict.ok) return { ok: false, error: `invalid recipe: ${verdict.errors[0]}`, errors: verdict.errors };
  const target = recipeSaveTarget(recipe.name || key, path);
  if (!target.ok) return { ok: false, error: target.error };
  if (!config.zoAccessToken) return { ok: false, error: 'Zo access token not configured.' };

  const probe = await readWorkspaceFile(target.path);
  const exists = probe.ok;
  if (exists && confirm !== true) {
    return { ok: false, exists: true, path: target.path, error: `${target.path} already exists — confirm the overwrite` };
  }

  let out = recipe;
  if (exists && driftedFromWorkspace(recipe, probe.content)) {
    out = { ...recipe, version: bumpVersion(recipe.version, 'patch') };
  }
  const stamped = { ...out, origin: target.path, updatedAt: Date.now() };
  try {
    await mcpToolCall('write_file', { target_file: target.path, content: serializeRecipe(stamped) });
  } catch (err) {
    return { ok: false, error: `write_file failed: ${err?.message || err}` };
  }
  lib[key] = stamped;
  await recipeLibrary.save(lib);
  return { ok: true, path: target.path, version: stamped.version };
}

// 0.3.2 C1 (#289): turn a COMPLETED handoff run's observation log into a
// composed draft recipe. Same pipeline as the recorder's stop: deterministic
// assembly → best-effort LLM cleanup (compose variant; output must pass
// validateRecipe or the deterministic draft is kept) → validate → library put
// with composed provenance. Values never reach the artifact: the sink stripped
// them, and assembleComposedDraft births every Zo fill as a param WITHOUT a
// default. Save is idempotent per name (library upsert).
async function recipeComposeSave({ runId, name } = {}) {
  const run = await handoffGet({ runId });
  if (!run) return { ok: false, error: 'no such handoff run' };
  if (run.status !== 'done') {
    return { ok: false, error: `run is ${run.status} — only a completed run can be composed` };
  }
  const safeName = safeText(name) || `composed-${new Date().toISOString().slice(0, 10)}`;

  // 1) Deterministic draft (retry collapse, nav dedup, boundary parks →
  // human checkpoints, Zo fills → params without defaults).
  const assembled = assembleComposedDraft(safeName, run.goal, run.obs);
  if (!assembled.ok) return { ok: false, error: assembled.errors?.[0] || 'could not compose a draft from this run' };
  let recipe = assembled.recipe;
  let llmCleaned = false;
  let note;

  // 2) Best-effort LLM cleanup — the compose variant of the recorder's pass.
  // A cleaned draft that fails validateRecipe is discarded for the
  // deterministic one, never tolerated.
  if (config.zoAccessToken) {
    try {
      const resp = await fetch(config.zoApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.zoAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: composeCleanupPrompt(recipe),
          model_name: config.zoModel || undefined,
        }),
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        const parsed = parseGeneratedRecipe(String(data?.output ?? ''));
        if (parsed.ok && literalFillValueCount(parsed.recipe.steps) > 0) {
          note = 'LLM draft rejected (literal fill value) — kept the deterministic draft';
        } else if (parsed.ok) {
          // Adopt-time backstop: a cleanup reply can never inject a param
          // default — composed values are human-supplied on every run.
          const merged = { ...recipe, params: withoutParamDefaults(parsed.recipe.params), steps: parsed.recipe.steps, updatedAt: Date.now() };
          const verdict = validateRecipe(merged);
          if (verdict.ok) {
            recipe = merged;
            llmCleaned = true;
            note = parsed.note;
          } else {
            note = `LLM draft rejected (${verdict.errors[0]}) — kept the deterministic draft`;
          }
        } else {
          note = `LLM cleanup unusable (${parsed.error}) — kept the deterministic draft`;
        }
      } else {
        note = `LLM cleanup HTTP ${resp.status} — kept the deterministic draft`;
      }
    } catch (e) {
      note = `LLM cleanup failed (${e?.message || e}) — kept the deterministic draft`;
    }
  }

  // 3) The gate, whichever draft survived.
  const finalVerdict = validateRecipe(recipe);
  if (!finalVerdict.ok) {
    return { ok: false, error: `composed draft failed validation: ${finalVerdict.errors[0]}`, errors: finalVerdict.errors };
  }

  // 4) Library put with composed provenance — the first replay is the
  // rehearsal that verifies it.
  const lib = await recipeLibrary.load();
  const stamped = {
    ...recipe,
    draft: true,
    composedBy: 'zo',
    verified: false,
    goal: safeText(run.goal),
    updatedAt: Date.now(),
  };
  lib[safeName] = stamped;
  await recipeLibrary.save(lib);
  return {
    ok: true,
    name: safeName,
    version: stamped.version,
    steps: stamped.steps.length,
    params: stamped.params.length,
    llmCleaned,
    note,
    warnings: finalVerdict.warnings,
  };
}

// R2 (#256): the heal write-back. The origin file stays the parameterized
// artifact — only the healed steps' cues are patched in (patchHealedCues
// refuses structurally diverged files), then the same validate → write →
// cache pipeline as recipeSave. One explicit user click; never automatic.
async function recipeSaveHealed({ runId } = {}) {
  const run = await recipeGet({ runId });
  if (!run) return { ok: false, error: 'run not found' };
  if (!(run.healedSteps || []).length) return { ok: false, error: 'this run recorded no healed cues' };
  const origin = safeText(run.origin);
  if (!safeWorkspacePath(origin)) return { ok: false, error: `run origin "${origin}" is not a workspace file` };
  if (!config.zoAccessToken) return { ok: false, error: 'Zo access token not configured.' };
  const probe = await readWorkspaceFile(origin);
  if (!probe.ok) return { ok: false, error: `cannot read ${origin}: ${probe.error}` };
  let wsRecipe;
  try {
    wsRecipe = JSON.parse(probe.content);
  } catch (e) {
    return { ok: false, error: `workspace recipe is not valid JSON: ${e.message}` };
  }
  const patched = patchHealedCues(wsRecipe, run.healedSteps);
  if (!patched.ok) return { ok: false, error: patched.error };
  const verdict = validateRecipe(patched.recipe);
  if (!verdict.ok) return { ok: false, error: `invalid recipe: ${verdict.errors[0]}`, errors: verdict.errors };
  const stamped = { ...patched.recipe, version: bumpVersion(patched.recipe.version, 'patch') || patched.recipe.version, origin, updatedAt: Date.now() };
  try {
    await mcpToolCall('write_file', { target_file: origin, content: serializeRecipe(stamped) });
  } catch (err) {
    return { ok: false, error: `write_file failed: ${err?.message || err}` };
  }
  const lib = await recipeLibrary.load();
  lib[run.recipeId] = stamped; // both copies carry the healed cues now
  await recipeLibrary.save(lib);
  run.healedSaved = true;
  run.updatedAt = Date.now();
  await recipePut(run);
  return { ok: true, path: origin, version: stamped.version };
}

async function recipeList() {
  const lib = await recipeLibrary.load();
  const runs = await recipeStore.load();
  const live = Object.values(runs).find((r) => !['done', 'aborted'].includes(r.status));
  // qa-recipe-rows-no-last-run: the runs store is already in hand — derive
  // each recipe's most recent run status so library rows can badge it.
  const lastRunByRecipe = new Map();
  for (const r of Object.values(runs)) {
    const prev = lastRunByRecipe.get(r.recipeId);
    if (!prev || (r.updatedAt || 0) > (prev.updatedAt || 0)) lastRunByRecipe.set(r.recipeId, r);
  }
  const lastRunStatus = (recipe) => {
    // Library entries are user storage — null/corrupt values must not throw.
    const run = recipe && typeof recipe === 'object' ? lastRunByRecipe.get(recipe.id) : null;
    return run ? { status: run.status, endedAt: run.updatedAt || null } : null;
  };
  return {
    ok: true,
    // R3 (#257): the library popup's payload — params (defaults stripped:
    // they're local-only), provenance, and the source discriminator. The
    // library is user storage: a corrupt entry still lists (key-fallback
    // name, 0 steps) so it's visible and deletable — never a crash.
    recipes: Object.entries(lib).map(([key, r]) => ({
      name: (r && typeof r.name === 'string' && r.name) ? r.name : key,
      version: (r && typeof r.version === 'string') ? r.version : '?',
      steps: Array.isArray(r?.steps) ? r.steps.length : 0,
      draft: !!(r && r.draft),
      // C1 (#289): composed provenance — the popup badges 🤖 drafts and
      // their unverified state.
      composedBy: r?.composedBy === 'zo' ? 'zo' : undefined,
      verified: r?.verified === true,
      goal: typeof r?.goal === 'string' ? r.goal : undefined,
      origin: r?.origin,
      source: r?.origin && String(r.origin).startsWith('/home/workspace') ? 'workspace' : 'local',
      updatedAt: (r && (r.updatedAt || r.createdAt)) || null,
      params: (Array.isArray(r?.params) ? r.params : []).map((p) => ({ name: p.name, required: !!p.required, question: p.question || '' })),
      lastRun: lastRunStatus(r),
    })),
    liveRun: live ? { runId: live.runId, name: live.name, status: live.status } : null,
  };
}

// R3 (#257): rename — the library key AND recipe.name move together. Refuses
// empty/colliding targets; runs keep their own copied name (self-contained).
async function recipeRename({ name, newName } = {}) {
  const lib = await recipeLibrary.load();
  const key = safeText(name);
  const next = safeText(newName).trim();
  const recipe = lib[key];
  if (!recipe) return { ok: false, error: `no local recipe named "${key}"` };
  if (!next || /[/\\:]/.test(next)) return { ok: false, error: 'new name must be non-empty (no slashes/colons)' };
  if (next === key) return { ok: true, name: next };
  if (lib[next]) return { ok: false, error: `"${next}" already exists in the library` };
  const verdict = validateRecipe(recipe);
  if (!verdict.ok) return { ok: false, error: `invalid recipe: ${verdict.errors[0]}` };
  lib[next] = { ...recipe, name: next, updatedAt: Date.now() };
  delete lib[key];
  await recipeLibrary.save(lib);
  return { ok: true, name: next };
}

// R3 (#257): delete — local entry only, never the workspace source file.
async function recipeDelete({ name } = {}) {
  const lib = await recipeLibrary.load();
  const key = safeText(name);
  if (!lib[key]) return { ok: false, error: `no local recipe named "${key}"` };
  delete lib[key];
  await recipeLibrary.save(lib);
  return { ok: true };
}

// R3 (#257): import — same gate the run path uses (read_file → parse →
// validateRecipe), stamped with the workspace origin so drift is visible.
async function recipeImport({ path } = {}) {
  const target = safeWorkspacePath(String(path || ''));
  if (!target) return { ok: false, error: `path must be inside ${WORKSPACE_ROOT}` };
  const res = await readWorkspaceFile(target);
  if (!res.ok) return { ok: false, error: res.error };
  let recipe;
  try {
    recipe = JSON.parse(res.content);
  } catch (e) {
    return { ok: false, error: `recipe is not valid JSON: ${e.message}` };
  }
  const verdict = validateRecipe(recipe);
  if (!verdict.ok) return { ok: false, error: `invalid recipe: ${verdict.errors[0]}`, errors: verdict.errors };
  const stamped = { ...recipe, origin: target, updatedAt: Date.now() };
  const lib = await recipeLibrary.load();
  lib[recipe.name] = stamped;
  await recipeLibrary.save(lib);
  return { ok: true, name: stamped.name, version: stamped.version, path: target };
}

// R3 (#257): export — the deterministic bundle write (validate → build →
// write_file per file). Never an LLM-authored transformation.
async function recipeExport({ names, skillName } = {}) {
  const lib = await recipeLibrary.load();
  const list = (Array.isArray(names) ? names : []).map((n) => lib[safeText(n)]);
  if (!list.length || list.some((r) => !r)) return { ok: false, error: 'no matching local recipes' };
  const bundle = buildRecipeSkillExport(list, { skillName });
  if (!bundle.ok) return bundle;
  if (!config.zoAccessToken) return { ok: false, error: 'Zo access token not configured.' };
  const written = [];
  for (const f of bundle.files) {
    try {
      await mcpToolCall('write_file', { target_file: f.path, content: f.markdown });
      written.push(f.path);
    } catch (err) {
      return { ok: false, error: `write_file failed for ${f.path}: ${err?.message || err}`, paths: written };
    }
  }
  return { ok: true, skillName: bundle.skillName, paths: written };
}

// The healer (#220): on a cue miss, ONE re-ground turn — a redacted tier-2
// capture + the failed cues + the page's near-miss candidates go to a one-shot
// Zo call (generateMode pattern: plain JSON POST, no conversation_id, no
// stream port). A parseable cue patch updates the run's copy, bumps the
// version, caches the healed recipe in the local library, and retries the
// step. Everything else blocks the run honestly.
async function recipeHeal(runId, step, missResult) {
  let run = await recipeGet({ runId });
  if (!run || run.status !== 'running') return;
  if ((run.healCount || 0) >= 1) {
    await recipeBlock(runId, `cue miss — ${missResult.error} (heal budget spent)`);
    return;
  }
  if (!config.zoAccessToken) {
    await recipeBlock(runId, `cue miss — ${missResult.error} (no Zo token for the healer)`);
    return;
  }
  run.status = 'healing';
  run.updatedAt = Date.now();
  await recipePut(run);

  // Redaction: the healer gets field STRUCTURE (labels/questions/selectors),
  // never live values — strip them defensively before anything leaves.
  const cap = await getActiveTabContext(run.tabId, 2, null).catch(() => null);
  const pageContext = cap && !cap.error ? {
    url: cap.url,
    title: cap.title,
    formFields: (Array.isArray(cap.formFields) ? cap.formFields : []).map((f) => ({ ...f, value: undefined })),
  } : null;

  try {
    const resp = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: healPrompt(run.recipe, step, missResult, pageContext),
        model_name: config.zoModel || undefined,
      }),
    });
    if (!resp.ok) {
      await recipeBlock(runId, `healer HTTP ${resp.status} — cue miss: ${missResult.error}`);
      return;
    }
    const data = await resp.json().catch(() => ({}));
    const parsed = parseRecipeHealResponse(String(data?.output ?? ''));
    if (!parsed.ok) {
      await recipeBlock(runId, `healer: ${parsed.error}`);
      return;
    }
    run = await recipeGet({ runId });
    if (!run || run.status !== 'healing') return;
    run.recipe.steps[run.stepIndex].cues = parsed.cues;
    // The heal write-back (#256) patches these into the ORIGIN file later —
    // the run copy is substituted, so only {index, type, cues} travel.
    run.healedSteps = [...(run.healedSteps || []), { index: run.stepIndex, type: run.recipe.steps[run.stepIndex].type, cues: parsed.cues }];
    run.version = bumpVersion(run.version, 'patch') || run.version;
    run.healCount = (run.healCount || 0) + 1;
    run.updatedAt = Date.now();
    run.status = 'running';
    const lib = await recipeLibrary.load();
    lib[run.recipeId] = run.recipe; // healed copy cached under the recipe id
    await recipeLibrary.save(lib);
    await recipePut(run);
    recipePlayStep(run.runId).catch((e) => console.debug('recipePlayStep:', e));
  } catch (e) {
    await recipeBlock(runId, `healer failed: ${e?.message || e}`);
  }
}

// ---- Recipe recorder (#220): learn a recipe from a manual run --------------
// `!recipe record` arms a session; the content recorder (armed per navigation
// via RECIPE_RECORD_PEEK) streams observation records (RECIPE_OBS — sensitive
// field values never leave the page). Stop assembles the deterministic draft,
// runs a best-effort LLM cleanup whose output must pass validateRecipe (the
// E-INVARIANT machine-checks the learned artifact), and saves it to the local
// library under the session name — `!recipe run <name>` replays it.

const recipeRecStore = {
  key: 'cobrowse_recipe_recording',
  async load() {
    const o = await chrome.storage.session.get(this.key);
    return (o && o[this.key]) || null;
  },
  async save(s) {
    await chrome.storage.session.set({ [this.key]: s });
  },
  async clear() {
    await chrome.storage.session.remove(this.key);
  },
};

async function recipeRecordStart({ chatId, name } = {}) {
  const existing = await recipeRecStore.load();
  if (existing && existing.armed) {
    return { ok: false, error: `already recording "${existing.name}" — stop it first (✕ on the recording line)` };
  }
  // One armed session at a time (C2 #290): a live compose session owns the
  // recorder listeners.
  const compose = await composeStore.load();
  if (compose && compose.armed) {
    const live = await handoffGet({ runId: compose.runId });
    if (live && !['done', 'aborted'].includes(live.status)) {
      return { ok: false, error: `a compose session is live ("${safeText(live.compose?.name || live.goal)}") — stop it first` };
    }
  }
  const session = {
    armed: true,
    name: safeText(name) || `recorded-${new Date().toISOString().slice(0, 10)}`,
    chatId: chatId || '',
    obs: [],
    startedAt: Date.now(),
  };
  await recipeRecStore.save(session);
  // Live tabs arm NOW — a fresh page arms via RECIPE_RECORD_PEEK instead.
  recipeBroadcastRecordState(true).catch(() => {});
  return { ok: true, name: session.name };
}

// Tell every content script the armed state changed (best-effort per tab).
async function recipeBroadcastRecordState(armed) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  await Promise.all(tabs.filter((t) => t.id != null).map((t) =>
    chrome.tabs.sendMessage(t.id, { type: 'RECIPE_RECORD_STATE', armed }).catch(() => {}),
  ));
}

async function recipeRecordPeek() {
  const s = await recipeRecStore.load();
  const c = await composeStore.load();
  const armed = !!(s && s.armed) || !!(c && c.armed);
  return { ok: true, armed, name: s && s.armed ? s.name : (c && c.armed ? 'compose' : undefined) };
}

async function recipeRecordObserve(obs) {
  const s = await recipeRecStore.load();
  if (!s || !s.armed) return { ok: false, error: 'no recording armed' };
  if (obs && typeof obs === 'object' && obs.op) {
    s.obs.push(obs);
    await recipeRecStore.save(s);
  }
  return { ok: true };
}

async function recipeRecordStop() {
  const s = await recipeRecStore.load();
  if (!s || !s.armed) return { ok: false, error: 'no recording armed' };
  await recipeRecStore.clear();
  recipeBroadcastRecordState(false).catch(() => {});
  if (!s.obs.length) return { ok: false, error: 'nothing was recorded — click through a flow first' };

  // 1) Deterministic draft (sensitive-page collapse + invariant authoring).
  const assembled = assembleDraftRecipe(s.obs, s.name);
  if (!assembled.ok) return { ok: false, error: assembled.errors?.[0] || 'could not assemble a draft' };
  let recipe = assembled.recipe;
  let llmCleaned = false;
  let note;

  // 2) Best-effort LLM cleanup — param defaults stripped from the prompt
  // (recorded values stay local). A cleaned draft that fails validateRecipe
  // is discarded for the deterministic one, never tolerated.
  if (config.zoAccessToken) {
    try {
      const resp = await fetch(config.zoApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.zoAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: generateRecipePrompt(recipe),
          model_name: config.zoModel || undefined,
        }),
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        const parsed = parseGeneratedRecipe(String(data?.output ?? ''));
        if (parsed.ok && literalFillValueCount(parsed.recipe.steps) > 0) {
          note = 'LLM draft rejected (literal fill value) — kept the deterministic draft';
        } else if (parsed.ok) {
          // Adopt-time backstop: the reply can never inject a param default —
          // recorded values stay local and human-sourced.
          const merged = { ...recipe, params: withoutParamDefaults(parsed.recipe.params), steps: parsed.recipe.steps, updatedAt: Date.now() };
          const verdict = validateRecipe(merged);
          if (verdict.ok) {
            recipe = merged;
            llmCleaned = true;
            note = parsed.note;
          } else {
            note = `LLM draft rejected (${verdict.errors[0]}) — kept the deterministic draft`;
          }
        } else {
          note = `LLM cleanup unusable (${parsed.error}) — kept the deterministic draft`;
        }
      } else {
        note = `LLM cleanup HTTP ${resp.status} — kept the deterministic draft`;
      }
    } catch (e) {
      note = `LLM cleanup failed (${e?.message || e}) — kept the deterministic draft`;
    }
  }

  // The gate, whichever draft survived.
  const finalVerdict = validateRecipe(recipe);
  if (!finalVerdict.ok) {
    return { ok: false, error: `learned recipe failed validation: ${finalVerdict.errors[0]}` };
  }

  const lib = await recipeLibrary.load();
  lib[s.name] = recipe;
  await recipeLibrary.save(lib);
  return {
    ok: true,
    name: s.name,
    steps: recipe.steps.length,
    params: recipe.params.length,
    llmCleaned,
    note,
    warnings: finalVerdict.warnings,
    recipe,
  };
}

// #228: draft a fill value with ONE one-shot Zo call (no tools, no browsing —
// same shape as the healer). Optional `contextFile` rides along as fenced
// source material from the workspace. `maxChars` is a hard cap: over-length
// output parks the run rather than silently clipping. `review: true` parks
// the run with an editable preview card before anything is written.
async function recipeGenerateFill(runId, step) {
  let run = await recipeGet({ runId });
  if (!run || run.status !== 'running') return;
  if (!config.zoAccessToken) {
    await recipeBlock(runId, 'generate fill needs a Zo token — configure one in settings');
    return;
  }

  let contextBlock = '';
  if (step.generate.contextFile) {
    const file = await readWorkspaceFile(step.generate.contextFile);
    if (!file.ok) {
      await recipeBlock(runId, `generate contextFile unreadable: ${file.error}`);
      return;
    }
    const body = file.content.slice(0, 12000);
    contextBlock = `\n\nSource material from the workspace (${step.generate.contextFile}):\n\n\`\`\`text\n${body}\n\`\`\``;
  }

  try {
    const resp = await fetch(config.zoApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.zoAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: generateValuePrompt(step) + contextBlock,
        model_name: config.zoModel || undefined,
      }),
    });
    if (!resp.ok) {
      await recipeBlock(runId, `generate HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json().catch(() => ({}));
    const text = String(data?.output ?? '').trim();
    if (!text) {
      await recipeBlock(runId, 'generate returned an empty value');
      return;
    }
    const cap = step.generate.maxChars;
    if (cap && text.length > cap) {
      await recipeBlock(runId, `generated text is over the field cap (${text.length} > ${cap} chars) — tighten the prompt or raise maxChars`);
      return;
    }
    if (step.generate.review === true) {
      run = await recipeGet({ runId });
      if (!run || run.status !== 'running') return;
      run.status = 'waiting_human';
      run.humanTitle = 'Review generated text';
      run.pendingReview = { text };
      run.updatedAt = Date.now();
      const saved = await recipePut(run);
      recipeMaybeNotify(saved);
      return;
    }
    await recipeFillValue(runId, step, text);
  } catch (e) {
    await recipeBlock(runId, `generate failed: ${e?.message || e}`);
  }
}

// Write the (generated or review-edited) value through the executor as a
// plain fill; record it as evidence when the step declares an evidenceKey.
async function recipeFillValue(runId, step, text) {
  const run = await recipeGet({ runId });
  if (!run || run.status !== 'running') return;
  const concrete = { ...step, value: text };
  delete concrete.generate;
  const res = await executeActions([{ type: 'recipe_step', step: concrete }], run.tabId, { recipe: true });
  const r = (res.results && res.results[0]) || { ok: false, error: res.error || 'no result' };
  if (!r.ok) {
    if (r.cueMiss) {
      await recipeHeal(runId, step, r); // cue repair still applies to generate fills
      return;
    }
    await recipeBlock(runId, `fill: ${r.error}`);
    return;
  }
  if (step.evidenceKey) {
    const runNow = await recipeGet({ runId });
    runNow.evidence.push({ key: step.evidenceKey, label: step.label || 'Generated text', value: text, ts: Date.now() });
    runNow.updatedAt = Date.now();
    await recipePut(runNow);
  }
  await recipeAdvance(runId);
}

async function runExecuteActions(domActions, target, { confirmed, boundaryMode } = {}) {
  const hasFill = domActions.some((a) => a.type === 'fill_form' || a.type === 'fill');
  // Click-only batches capture too: on sensitive pages the submit backstop
  // needs the verdict, and the per-action sidepanel loop sends clicks alone.
  const hasClick = domActions.some((a) => a.type === 'click');
  if (!hasFill && !hasClick) return executeActions(domActions, target, { boundaryMode });
  const pre = await captureFormFields(target);
  if (!pre) {
    // Unreadable page (no content script / capture failed): execute without a
    // review, stamped so the card can say "unverified form - no review". A
    // page we can't read is also a page whose fields we can't resolve - expect
    // per-field misses rather than silent wrong fills.
    return { ...await executeActions(domActions, target, { boundaryMode }), unverifiedForm: true };
  }
  const verdict = isSensitiveForm(pre.formFields, pre.url);
  if (verdict.sensitive && !confirmed) {
    if (hasFill) {
      return { needsConfirm: true, actions: domActions, fields: pre.formFields, url: pre.url, reasons: verdict.reasons };
    }
    // Click-only: nothing to review — execute with the backstop armed.
    return executeActions(domActions, target, { sensitive: true, boundaryMode });
  }
  return executeActions(domActions, target, { sensitive: verdict.sensitive, boundaryMode });
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
      if (isSensitiveSubmitProbe(probe)) {
        // #163: on a handoff run the refusal is a PARK, not a failure — the
        // user still performs it from the review card, so it must reach the
        // run's park log / "Parked for the user" count like any boundary stop.
        results.push({
          ok: false, type: 'click', blocked: true,
          ...(opts.boundaryMode ? { handoffParked: true, action } : {}),
          error: 'blocked submit on sensitive page - review and submit yourself',
        });
        continue;
      }
    }

    // Co-browse contract (user rule): once Zo has filled a form on this page,
    // it never clicks ANY action button (submit/OK/Next/Continue/Create/…) —
    // the user reviews and clicks. Links stay allowed (navigation ≠ form
    // action). The entry clears when the tab navigates elsewhere. Recipe
    // steps (opts.recipe, #220) are exempt: a declared click was authored
    // deliberately — the sensitive-page probe below still guards submits.
    if (action.type === 'click' && filledPages.has(tabId)) {
      let currentUrl = '';
      try { currentUrl = (await chrome.tabs.get(tabId)).url || ''; } catch { /* tab gone */ }
      if (currentUrl && currentUrl !== filledPages.get(tabId)) {
        filledPages.delete(tabId); // navigated away - the contract is satisfied
      } else if (currentUrl && !opts.recipe) {
        const probe = await probeClickTarget(tabId, action.selector);
        const isActionButton = probe && (
          probe.tag === 'button' ||
          (probe.tag === 'input' && (probe.type === 'submit' || probe.type === 'button')) ||
          probe.role === 'button');
        if (isActionButton) {
          results.push({
            ok: false, type: 'click', blocked: true,
            ...(opts.boundaryMode ? { handoffParked: true, action } : {}),
            error: 'blocked action-button click after a form fill - review the page and click it yourself',
          });
          continue;
        }
      }
    }

    // Handoff boundary (Lane E): readonly/no-submit/compose runs PARK
    // interactive actions instead of executing them — the user performs them
    // later from the review card. Push + continue: parking must not stop
    // sibling actions. isFillish covers fill_form too (review F1: the
    // canonical batch-fill shape must not bypass the compose/no-submit gate).
    if (opts.boundaryMode && (action.type === 'click' || handoffIsFillish(action))) {
      const verdict = handoffCheckBoundary(action, opts.boundaryMode);
      if (!verdict.allowed) {
        results.push({ ok: false, type: action.type, blocked: true, handoffParked: true, action, error: verdict.reason });
        continue;
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

    // Hook B (#342): a failed CLICK (not-found, empty/invalid selector,
    // cue-ladder miss — any non-blocked click failure) gets one Jev pick
    // among the page's clickable candidates. Confidence ≥ jevPickConfidence
    // → the winner is executed as a concrete click (same rails: this is a
    // plain click action re-entering the executor); anything else keeps the
    // original failure. Blocked actions (sensitive/backstop/boundary) never
    // reach here — they `continue` above.
    if (result && !result.ok && action.type === 'click' && jevReady()) {
      const candidates = (Array.isArray(result.candidates) && result.candidates.length)
        ? result.candidates
        : await fetchClickableCandidates(tabId);
      if (candidates.length) {
        const pick = await jevPickClickTarget(action, candidates);
        if (pick.ok && pick.selector) {
          let retry = null;
          try {
            const resp = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action: { type: 'click', selector: pick.selector } });
            retry = resp || null;
          } catch { retry = null; }
          if (!retry || !retry.ok) {
            try {
              const [r2] = await chrome.scripting.executeScript({ target: { tabId }, func: executeDomAction, args: [{ type: 'click', selector: pick.selector }] });
              retry = r2.result;
            } catch (e2) { retry = { ok: false, error: e2.message }; }
          }
          if (retry && retry.ok) {
            result = { ...retry, jev: { picked: true, question: pick.question, confidence: pick.confidence, latencyMs: pick.latencyMs } };
          } else {
            result = { ...result, jev: { fallback: 'pick did not execute' } };
          }
        } else {
          result = { ...result, jev: { fallback: pick.reason || 'unavailable' } };
        }
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
      case 'recipe_step': {
        // #220 twin of content.js#executeRecipeStep — inlined cue resolution
        // (reuses the resolveFieldTarget copy above) because this function is
        // serialized and cannot close over module scope.
        const rStep = action.step || {};
        const rOp = rStep.type;
        const rClickableByText = (txt) => {
          const norm = String(txt || '').toLowerCase().trim();
          if (!norm) return null;
          for (const c of document.querySelectorAll('a, button, [role=button], [onclick], input[type=submit], input[type=button], [type=submit]')) {
            if ((c.textContent || '').trim().toLowerCase().includes(norm)) return c;
          }
          return null;
        };
        const rValidCss = (sel) => {
          if (!sel || typeof sel !== 'string' || /:has-text|:text\(|:has\(/i.test(sel)) return false;
          try { document.querySelector(sel); return true; } catch { return false; }
        };
        const rResolveCues = (cues) => {
          const tried = [];
          for (const c of cues || []) {
            let el = null;
            if (c.strategy === 'selector') {
              if (rValidCss(c.value)) el = document.querySelector(c.value);
            } else if (c.strategy === 'text') {
              el = rClickableByText(c.value);
            } else {
              el = resolveFieldTarget(c.value, null) || rClickableByText(c.value);
            }
            if (el) return { el, tried };
            tried.push(`${c.strategy}=${c.value}`);
          }
          return { el: null, tried };
        };
        const rCollectCandidates = () => {
          const out = [];
          for (const c of document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button]')) {
            const text = ((c.textContent || '') || (c.value || '')).trim().slice(0, 60);
            if (!text) continue;
            out.push({ text });
            if (out.length >= 12) return out;
          }
          for (const f of document.querySelectorAll('input, textarea, select')) {
            if (f.type === 'hidden') continue;
            out.push({ text: f.name || f.id || '' });
            if (out.length >= 24) break;
          }
          return out;
        };
        if (rOp === 'waitFor') {
          const deadline = Date.now() + Math.min(rStep.timeoutMs || 5000, 15000);
          if (rStep.url && !rStep.cue) {
            // #267: URL-condition wait — poll the tab's own URL. Not a cue
            // miss (nothing to heal); a plain timeout parks the run.
            const pollUrl = () => {
              if (String(location.href).includes(rStep.url)) { resolve({ ok: true, type: 'waitFor' }); return; }
              if (Date.now() >= deadline) {
                resolve({ ok: false, type: 'waitFor', error: `waitFor: URL never matched ${rStep.url}` });
                return;
              }
              setTimeout(pollUrl, 200);
            };
            pollUrl();
            break;
          }
          const poll = () => {
            const { el, tried } = rResolveCues(rStep.cue ? [rStep.cue] : []);
            if (el) { resolve({ ok: true, type: 'waitFor' }); return; }
            if (Date.now() >= deadline) {
              resolve({ ok: false, type: 'waitFor', cueMiss: true, tried, error: 'waitFor timed out' });
              return;
            }
            setTimeout(poll, 200);
          };
          poll();
          break;
        }
        if (rOp === 'navigate' || rOp === 'human' || rOp === 'done') {
          resolve({ ok: true, type: rOp });
          break;
        }
        const { el: rEl, tried: rTried } = rResolveCues(rStep.cues);
        if (!rEl) {
          resolve({ ok: false, type: rOp, cueMiss: true, tried: rTried, candidates: rCollectCandidates(), error: `no element matched cues: ${rTried.join('; ')}` });
          break;
        }
        (async () => {
          switch (rOp) {
            case 'click':
              if (action.sensitive) {
                // #266: probe before clicking — a form's submit control is
                // never auto-clicked on a sensitive page. Inline twin of
                // lib/formfill.js#isSensitiveSubmitProbe (this function is
                // serialized and cannot import).
                const pForm = !!(rEl.form || rEl.closest('form'));
                const pText = String((rEl.textContent || '') || (rEl.value || '')).trim();
                const pSubmit = pForm && (rEl.type === 'submit' || /submit|pay|checkout|order|place|buy/i.test(pText));
                if (pSubmit) {
                  return { ok: false, type: 'click', refused: 'sensitive-submit', probeText: pText.slice(0, 80) };
                }
              }
              rEl.scrollIntoView({ block: 'center' });
              rEl.click();
              return { ok: true, type: 'click' };
            case 'fill': {
              const setVal2 = (node, raw) => {
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
              setVal2(rEl, String(rStep.value == null ? '' : rStep.value));
              return { ok: true, type: 'fill' };
            }
            case 'check': {
              const want = rStep.checked !== false;
              rEl.checked = want;
              rEl.dispatchEvent(new Event('input', { bubbles: true }));
              rEl.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, type: 'check', checked: want };
            }
            case 'attach': {
              if (rEl.tagName !== 'INPUT' || rEl.type !== 'file') {
                return { ok: false, type: 'attach', error: 'cue resolved to a non-file input' };
              }
              const bin = atob(String(action.dataB64 || ''));
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              const name = String(rStep.path || 'attachment').split('/').pop();
              const dt = new DataTransfer();
              dt.items.add(new File([bytes], name, { type: 'application/octet-stream' }));
              rEl.files = dt.files;
              rEl.dispatchEvent(new Event('input', { bubbles: true }));
              rEl.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, type: 'attach', file: name };
            }
            case 'extract':
              return {
                ok: true,
                type: 'extract',
                value: rStep.attribute ? rEl.getAttribute(rStep.attribute) : (rEl.textContent || '').trim(),
              };
          }
          return { ok: false, type: rOp, error: `Unknown recipe step: ${rOp}` };
        })()
          .then((res) => resolve(rTried.length ? { ...res, tried: rTried } : res))
          .catch(reject);
        break;
      }
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

/**
 * #51: conversation → workspace markdown write. Mirrors savePageToWorkspace's
 * one-shot agent-write prompt (deliberately NOT MCP bash — consistency with
 * save-page, which never used MCP either). Content = the same
 * conversationToMarkdown serializer the local ⬇ download uses.
 */
async function saveConversationToWorkspace(conversation, savePath) {
  if (!config.zoAccessToken) return { ok: false, error: 'Zo access token not configured. Open settings to set it up.' };
  const conv = conversation && typeof conversation === 'object' ? conversation : {};
  const title = typeof conv.title === 'string' && conv.title.trim() ? conv.title.trim() : 'Zo conversation';
  const path = (typeof savePath === 'string' && savePath.trim()) || `Documents/research/${slugifyTitle(title)}.md`;
  const markdown = conversationToMarkdown({ title, messages: Array.isArray(conv.messages) ? conv.messages : [] });

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
    return { ok: true, path, response: data.output || '' };
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

/**
 * #53 write-assist popover STREAM: a thin SSE reader over /zo/ask that feeds
 * the popover live deltas. Deliberately NOT _askZoStreamImpl — that path's
 * sessionId routing, pull loop, and panel-coupled finishStream are all wrong
 * for a page-embedded popover. Emits on the port:
 *   WA_DELTA {delta, raw}  — incremental text piece + accumulated raw stream
 *   WA_DONE  {text, conversationId?} — full parsed tag content + thread echo
 *   WA_ERROR {error}
 * `msg.conversationId` (when present) threads a follow-up chip turn onto the
 * popover's short-lived Zo thread. Cancellation is the port dying: the
 * disconnect listener aborts the fetch.
 */
async function enhanceStream(port, msg) {
  if (config.enableWriteAssist === false) {
    safePost(port, { type: 'WA_ERROR', error: 'Write assist is disabled in the extension options.' });
    return;
  }
  if (!config.zoAccessToken) {
    safePost(port, { type: 'WA_ERROR', error: 'No access token configured. Save one in the extension options.' });
    return;
  }
  const req = msg || {};
  const threadId = typeof req.conversationId === 'string' ? req.conversationId : '';
  const prompt = threadId && req.priorText
    ? buildEnhanceFollowUpPrompt({
        priorText: req.priorText,
        instruction: req.instruction,
        field: req.field,
        page: req.page,
        acceptsMarkdown: !!(req.field && req.field.markdown),
      })
    : buildEnhancePrompt({
        text: req.text,
        instruction: req.instruction,
        field: req.field,
        page: req.page,
        acceptsMarkdown: !!(req.field && req.field.markdown),
      });
  const controller = new AbortController();
  const onDisconnect = () => controller.abort();
  port.onDisconnect.addListener(onDisconnect);
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
        conversation_id: threadId || undefined,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      const body = await resp.text().catch(() => '');
      safePost(port, { type: 'WA_ERROR', error: `Zo API error: ${resp.status} ${body.substring(0, 200)}`.trim() });
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType = '';
    let raw = '';
    let threadEcho = '';
    let done = false;
    while (!done) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed.startsWith('event:')) { currentEventType = trimmed.slice(6).trim(); continue; }
        const dataMatch = trimmed.match(/^data:\s?(.*)$/);
        if (!dataMatch) continue;
        const data = dataMatch[1].trim();
        if (!data) continue;
        if (currentEventType === 'completed' || currentEventType === 'End' || currentEventType === 'failed') {
          if (currentEventType === 'failed') {
            let errMsg = 'Stream failed';
            try { const p2 = JSON.parse(data); errMsg = (p2 && (p2.error || p2.message)) || errMsg; } catch {}
            safePost(port, { type: 'WA_ERROR', error: errMsg });
            return;
          }
          // Thread echo: the terminal payload carries conversation_id when the
          // server created a fresh thread. Absent = chips degrade to fresh
          // threads (the prior text still rides the follow-up prompt).
          try {
            const p3 = JSON.parse(data);
            if (p3 && typeof p3.conversation_id === 'string') threadEcho = p3.conversation_id;
          } catch {}
          done = true;
          break;
        }
        // Text pieces only — thinking deltas are invisible to the popover and
        // narration is dropped by the tag protocol at parse time anyway.
        try {
          const parsed = JSON.parse(data);
          let piece = '';
          if (currentEventType === 'PartStartEvent') {
            const part = parsed.part || {};
            if ((part.part_kind || '') === 'text') piece = safeText(part.content || '');
          } else if (currentEventType === 'PartDeltaEvent') {
            const delta = parsed.delta || {};
            if ((delta.part_delta_kind || '') === 'text') piece = safeText(delta.content_delta || '');
          } else {
            piece = extractStreamContent(parsed) || '';
          }
          if (piece) {
            raw += piece;
            safePost(port, { type: 'WA_DELTA', delta: piece, raw });
          }
        } catch { /* non-JSON line — ignore */ }
      }
    }
    const { text } = parseEnhanceResponse(raw);
    if (!text) {
      safePost(port, { type: 'WA_ERROR', error: 'Zo returned an empty response.' });
      return;
    }
    safePost(port, { type: 'WA_DONE', text, conversationId: threadEcho || undefined });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // cancelled via port.disconnect / timeout
    safePost(port, { type: 'WA_ERROR', error: `Enhance failed: ${err.message}` });
  } finally {
    clearTimeout(timer);
    port.onDisconnect.removeListener(onDisconnect);
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
  // #339: the space endpoint is user-derived (Zo username) and optional —
  // report honestly instead of querying someone else's space.
  if (!config.zoSpaceEndpoint) {
    return { ok: false, error: 'Zo.space endpoint not configured — set your Zo username in Settings → Connection.' };
  }
  const endpoint = config.zoSpaceEndpoint;
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

