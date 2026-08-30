// Handoff (Lane E) — pure half of delegate-mode runs: the user primes a goal,
// Zo works unattended up to a hard boundary. This module owns the run state
// machine, budget accounting, the boundary checker (generalizing the #26
// no-submit rule), and the continuation-turn prompt assembler. Pure ES module,
// no chrome.*/DOM deps — the background (item 10) drives it and persists runs
// to chrome.storage.session so an MV3 service-worker restart RESUMES a run
// instead of stranding it. The run loop itself is event-driven (execute →
// continuation turn → repeat), never SW-resident.
//
// Spec: docs/superpowers/specs/2026-08-30-0.2.7-slate-design.md § Lane E.
// Contract: tests/schemas/handoff.ts.

// ── Boundary modes ──────────────────────────────────────────────────────────
// 'readonly'   — the 0.2.7 reference scenario: navigate/extract/scroll/read
//                only. Zero form interaction, zero boundary ambiguity.
// 'no-submit'  — 0.3.0 form scenarios: fill allowed, submit-ish clicks parked
//                (generalizes the #26 no-submit rule; per-site grants are the
//                #47 autonomy dial, out of scope here).

export const DEFAULT_BUDGET = { maxTurns: 12, maxNavigations: 25, maxMinutes: 20 };

const READONLY_ALLOWED = new Set([
  'navigate', 'extract', 'scroll', 'wait', 'done',
  'read_tab', 'read_page', 'get_dom', 'get_form',
]);

// Submit/terminal-action hints for 'no-submit' mode — the #26 no-submit rule
// as a checker. Matched against the action's selector AND any text the model
// quoted for the target (e.g. click {selector: "button", text: "Place order"}).
const SUBMITISH = [
  'submit', 'sign in', 'signin', 'log in', 'login', 'sign up', 'register',
  'place order', 'checkout', 'pay', 'purchase', 'buy now', 'complete order',
  'delete', 'remove', 'send', 'post', 'publish', 'confirm purchase',
];
const SUBMITISH_SELECTOR = [
  'type="submit"', "type='submit'", '[type=submit]', '[type="submit"]',
  '#submit', '.submit', '#checkout',
];

export function isSubmitish(action) {
  const hay = [
    String(action?.selector || ''),
    String(action?.text || ''),
    String(action?.value || ''),
  ].join(' ').toLowerCase();
  if (!hay) return false;
  if (SUBMITISH_SELECTOR.some((s) => hay.includes(s))) return true;
  return SUBMITISH.some((w) => hay.includes(w));
}

/** Boundary decision for one Zo action under this run's mode.
 * @returns {{allowed: true} | {allowed: false, reason: string}} */
export function checkBoundary(action, boundaryMode) {
  const type = String(action?.type || '');
  if (boundaryMode === 'readonly') {
    if (READONLY_ALLOWED.has(type)) return { allowed: true };
    return {
      allowed: false,
      reason: `READ-ONLY handoff: "${type}" is not permitted — the user performs interactive steps themselves`,
    };
  }
  // 'no-submit' — everything except submit-ish clicks/fills passes.
  if ((type === 'click' || type === 'fill') && isSubmitish(action)) {
    return {
      allowed: false,
      reason: `no-submit handoff: "${type}" targets a terminal action (submit/pay/delete…) — parked for the user`,
    };
  }
  return { allowed: true };
}

// ── Run lifecycle ───────────────────────────────────────────────────────────

/** Create a run. Status starts at 'priming'; transition('start') begins the loop.
 * @param {{chatId: string, goal: string, boundaryMode?: 'readonly'|'no-submit',
 *           budget?: Partial<typeof DEFAULT_BUDGET>, runId?: string, now?: number}} opts */
export function createRun(opts) {
  const now = opts.now ?? Date.now();
  const runId = opts.runId || `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    runId,
    chatId: opts.chatId,
    goal: opts.goal,
    boundaryMode: opts.boundaryMode || 'readonly',
    budget: { ...DEFAULT_BUDGET, ...(opts.budget || {}) },
    usage: { turns: 0, navigations: 0, startedAt: now },
    status: 'priming',
    pagesVisited: [],
    parkLog: [],
    createdAt: now,
    updatedAt: now,
  };
}

const TRANSITIONS = {
  priming: ['start', 'abort'],
  running: ['pause', 'block', 'complete', 'abort'],
  paused: ['resume', 'abort'],
  blocked: ['resume', 'abort'],
  done: [],
  aborted: [],
};

/** Apply one lifecycle event. Pure: returns a NEW run object on success and
 * never mutates the input. Invalid transitions are reported, not thrown, so
 * callers can log and continue.
 * @returns {{ok: true, run: object} | {ok: false, error: string, run: object}} */
export function transition(run, event, extra = {}) {
  const allowed = TRANSITIONS[run.status] || [];
  if (!allowed.includes(event)) {
    return { ok: false, error: `cannot ${event} from ${run.status}`, run };
  }
  const next = { ...run, status: eventToStatus(event), updatedAt: extra.now ?? Date.now() };
  if (event === 'block' && extra.reason) next.stopReason = extra.reason;
  if ((event === 'complete' || event === 'abort') && extra.reason && !next.stopReason) {
    next.stopReason = extra.reason;
  }
  return { ok: true, run: next };
}

function eventToStatus(event) {
  return { start: 'running', pause: 'paused', resume: 'running', block: 'blocked', complete: 'done', abort: 'aborted' }[event];
}

/** Bump usage counters. Pure. */
export function tally(run, { turns = 0, navigations = 0 } = {}) {
  return {
    ...run,
    usage: {
      ...run.usage,
      turns: run.usage.turns + turns,
      navigations: run.usage.navigations + navigations,
    },
    updatedAt: Date.now(),
  };
}

/** Record a visited URL (deduped consecutive, capped) — feeds the progress line. */
export function recordVisit(run, url) {
  const pages = run.pagesVisited;
  if (pages[pages.length - 1] === url) return run;
  const next = [...pages, String(url)];
  if (next.length > 100) next.splice(0, next.length - 100);
  return { ...run, pagesVisited: next, updatedAt: Date.now() };
}

/** Park an action that crossed the boundary — the user performs it later from
 * the existing pendingActions review card. Pure. */
export function park(run, action, reason, url) {
  return {
    ...run,
    parkLog: [...run.parkLog, { action, reason, url, ts: Date.now() }].slice(-50),
    updatedAt: Date.now(),
  };
}

/** Budget verdict for continuing the loop.
 * @param {object} run
 * @param {number} [now]
 * @returns {{ok: true} | {ok: false, reason: string}} */
export function withinBudget(run, now = Date.now()) {
  const { budget, usage } = run;
  if (usage.turns >= budget.maxTurns) {
    return { ok: false, reason: `turn budget exhausted (${usage.turns}/${budget.maxTurns})` };
  }
  if (usage.navigations >= budget.maxNavigations) {
    return { ok: false, reason: `navigation budget exhausted (${usage.navigations}/${budget.maxNavigations})` };
  }
  const minutes = (now - usage.startedAt) / 60000;
  if (minutes >= budget.maxMinutes) {
    return { ok: false, reason: `time budget exhausted (${Math.floor(minutes)}/${budget.maxMinutes} min)` };
  }
  return { ok: true };
}

// ── Prompt assembly (pure text; the background appends these to ASK_ZO) ─────

/** The handoff instruction block appended to the first turn's prompt. Carries
 * the stable `handoff-run` marker (e2e fixtures route on it, like write-assist). */
export function handoffInstructions(run) {
  const lines = [
    '## Handoff Run',
    '',
    `You are operating UNATTENDED (handoff-run marker). Goal: ${run.goal}`,
    '',
    'Rules:',
    '- Work autonomously: navigate, read, extract, and move on without waiting for the user.',
    run.boundaryMode === 'readonly'
      ? '- This run is READ-ONLY: use navigate/extract/scroll/wait only. Never click or fill — park interactive steps by noting them and moving on.'
      : '- You may fill forms, but NEVER click terminal actions (submit/order/pay/delete/send) — park them and continue.',
    '- Each reply must end with either tool calls to continue the work, or a final done() whose response is the deliverable (e.g. the digest).',
    '- Be budget-aware: when the goal is met (or nearly met), finish with done() rather than extra verification loops.',
  ];
  return lines.join('\n');
}

/** The continuation turn: a progress report + go-on prompt sent as the next
 * ASK_ZO user message after a turn whose actions ended without done().
 * @param {object} run
 * @param {{lastSummary?: string, now?: number}} [opts] */
export function buildContinuationTurn(run, opts = {}) {
  const b = withinBudget(run, opts.now ?? Date.now());
  const budgetLine = b.ok
    ? `Budget: ${run.budget.maxTurns - run.usage.turns} turns / ${run.budget.maxNavigations - run.usage.navigations} navigations left.`
    : `Budget reached: ${b.reason}`;
  return [
    `[handoff-run continuation] Progress report:`,
    `- Pages visited: ${run.pagesVisited.length}${run.pagesVisited.length ? ` (latest: ${run.pagesVisited[run.pagesVisited.length - 1]})` : ''}`,
    `- Parked for the user: ${run.parkLog.length}`,
    opts.lastSummary ? `- Last turn: ${opts.lastSummary}` : null,
    `- ${budgetLine}`,
    '',
    b.ok
      ? 'Continue toward the goal, or call done() with the final deliverable if it is already met.'
      : 'Stop here: call done() now with what you have gathered so far.',
  ].filter((l) => l !== null).join('\n');
}

/** One-line status for the panel's progress chip. */
export function runProgress(run, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - run.usage.startedAt) / 60000));
  const label = { priming: 'starting', running: 'working', paused: 'paused', blocked: 'needs you', done: 'done', aborted: 'stopped' }[run.status];
  return `${label} · ${run.pagesVisited.length} pages · ${run.usage.turns}/${run.budget.maxTurns} turns · ${run.parkLog.length} parked · ${mins}m`;
}
