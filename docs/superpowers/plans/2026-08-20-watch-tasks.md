# Watch & Scheduled Tasks (#29) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser-local page watches (snapshot → diff → Zo semantic verdict → notify) and scheduled prompts, managed in a sidepanel Tasks view, with a monitor→act bridge that seeds a confirm-gated follow-up turn.

**Architecture:** All task logic is pure (`extension/lib/tasks.js`: factories, scheduling math, text diff, prompt builders, verdict parsing); the background owns `chrome.alarms` lifecycle, the check pipeline (reuse the #24 capture path), non-streaming `askZo` verdicts, and `chrome.notifications`/badge; the sidepanel gains a Tasks view and the bridge seeds a normal `sendQuery` turn. Spec: `docs/superpowers/specs/2026-08-20-watch-tasks-design.md`. Consumes the form-fill confirm gate + cross-tab routing if those plans have landed; otherwise ships without the act step's form automation (it simply streams as a normal turn).

**Tech Stack:** `chrome.alarms` + `chrome.notifications` (new permissions), `chrome.storage.local`, existing capture + `askZo` machinery, bun:test + fake-chrome extensions, Playwright e2e.

## Global Constraints

- Task specs are serializable JSON (a future cloud scheduler + FCM must be able to adopt them verbatim — no in-memory-only state).
- Honest timing: all UI copy says "**at least** every N min" — `chrome.alarms` batches; never promise precision.
- Local-only v1: checks run while the browser is open; no background/cloud claims anywhere in UX.
- Verdict parse failure ⇒ treat as relevant with the raw-diff summary (false positive beats silent miss).
- Pure module boundaries: `lib/tasks.js` has no `chrome.*`/DOM; background does the I/O.
- One `chrome.alarms` alarm per task; the storage task list is the source of truth, alarms are a derivative (re-asserted on startup).
- `bun run verify` green before every commit; 7 new message types must land in `tests/schemas/messages.ts` in the same task as their background handlers (contract test).

---

### Task 1: Schema — TaskSpec + TaskRun

**Files:**
- Create: `tests/schemas/tasks.ts`
- Test: `tests/tasks.test.ts` (begins here, extended by Tasks 2–4)

**Interfaces:**
- Produces:
  - `WatchTask { id, kind:'watch', url, selector?, label, condition, frequencyMin ∈ {1,5,15,60,360,1440}, act?: { prompt }, paused, createdAt, lastCheckAt?, lastChangedAt?, snapshot? }`
  - `ScheduleTask { id, kind:'schedule', prompt, modeId?, url?, intervalMin?, dailyAt?: { hhmm: 'HH:MM', days: number[1..7] }, paused, createdAt, lastRunAt? }`
  - `TaskRun { id, taskId, at, kind: 'check'|'run', relevant?, summary, diffExcerpt? }`
  - Storage keys: `cobrowse_tasks` (array), `cobrowse_task_runs:<id>` (capped 20, FIFO).

- [ ] **Step 1: Write the schema**

```ts
import { z } from "zod";

// #29 Watch & Scheduled Tasks — browser-local task specs. Serializable by
// design so a future cloud scheduler (Zo-side + FCM) can adopt them verbatim.

export const FREQ_CHOICES = [1, 5, 15, 60, 360, 1440] as const;

export const ActConfig = z.object({ prompt: z.string().min(1) });

export const WatchTask = z.object({
  id: z.string().min(1),
  kind: z.literal("watch"),
  url: z.string().url(),
  selector: z.string().optional(),
  label: z.string().min(1),
  condition: z.string(),
  frequencyMin: z.number().int().refine((n) => (FREQ_CHOICES as readonly number[]).includes(n)),
  act: ActConfig.optional(),
  paused: z.boolean(),
  createdAt: z.number(),
  lastCheckAt: z.number().optional(),
  lastChangedAt: z.number().optional(),
  snapshot: z.string().optional(),
});

export const DailyAt = z.object({
  hhmm: z.string().regex(/^\d{2}:\d{2}$/),
  days: z.array(z.number().int().min(1).max(7)).min(1),
});

export const ScheduleTask = z.object({
  id: z.string().min(1),
  kind: z.literal("schedule"),
  prompt: z.string().min(1),
  modeId: z.string().optional(),
  url: z.string().url().optional(),
  intervalMin: z.number().int().positive().optional(),
  dailyAt: DailyAt.optional(),
  paused: z.boolean(),
  createdAt: z.number(),
  lastRunAt: z.number().optional(),
});

export const Task = z.discriminatedUnion("kind", [WatchTask, ScheduleTask]);

export const TaskRun = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  at: z.number(),
  kind: z.enum(["check", "run"]),
  relevant: z.boolean().optional(),
  summary: z.string(),
  diffExcerpt: z.string().optional(),
});

export const TASK_STORAGE_KEY = "cobrowse_tasks";
export const RUNS_KEY_PREFIX = "cobrowse_task_runs:";
export const RUNS_CAP = 20;
```

- [ ] **Step 2: Smoke-validate + commit**

Run: `bun test tests/` (schema compiles; no test uses it yet — Task 2 starts that).
Expected: PASS.

```bash
git add tests/schemas/tasks.ts
git commit -m "feat(tasks): TaskSpec/TaskRun Zod schemas (#29)"
```

---

### Task 2: `lib/tasks.js` — factories, alarm names, due math

**Files:**
- Create: `extension/lib/tasks.js`
- Test: `tests/tasks.test.ts`

**Interfaces:**
- Produces: `taskAlarmName(id)` → `'task:' + id`; `FREQUENCY_CHOICES`; `createWatchTask({url, selector, label, condition, frequencyMin, act})` → WatchTask (id via `newId()` = `crypto.randomUUID?` — pure module can't assume crypto in tests: accept an injected `id` or use a module counter + Date.now: `'t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)`); `createScheduleTask({prompt, modeId, url, intervalMin, dailyAt})`; `nextRunDue(task, now)` → timestamp (watch: `lastCheckAt + frequencyMin*60000`; schedule interval: `lastRunAt + intervalMin*60000`; schedule dailyAt: next matching day/time); `alarmPeriodMin(task)` → number (dailyAt ⇒ 1440 + handler checks the day, else frequencyMin/intervalMin).

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "bun:test";
import { createWatchTask, createScheduleTask, nextRunDue, taskAlarmName, alarmPeriodMin } from "../extension/lib/tasks.js";
import { Task, WatchTask as WatchTaskSchema, ScheduleTask as ScheduleTaskSchema } from "./schemas/tasks";

describe("factories", () => {
  it("build schema-valid tasks (paused=false, createdAt set)", () => {
    const w = createWatchTask({ url: "https://x.dev/", label: "Price", condition: "price < 50", frequencyMin: 15 });
    expect(WatchTaskSchema.safeParse(w).success).toBe(true);
    expect(w.paused).toBe(false);
    const s = createScheduleTask({ prompt: "summarize", dailyAt: { hhmm: "09:00", days: [1, 2, 3, 4, 5] } });
    expect(ScheduleTaskSchema.safeParse(s).success).toBe(true);
  });
});

describe("nextRunDue", () => {
  const NOW = Date.UTC(2026, 7, 20, 12, 0); // Thu 2026-08-20 12:00 UTC
  it("watch: lastCheck + frequency", () => {
    const w = { ...createWatchTask({ url: "https://x.dev/", label: "L", condition: "", frequencyMin: 15 }), lastCheckAt: NOW };
    expect(nextRunDue(w, NOW)).toBe(NOW + 15 * 60_000);
  });
  it("schedule dailyAt: next weekday 9am from Thursday noon", () => {
    const s = createScheduleTask({ prompt: "p", dailyAt: { hhmm: "09:00", days: [1, 2, 3, 4, 5] } });
    const due = nextRunDue({ ...s, lastRunAt: NOW }, NOW); // from Thu 12:00 → Fri 09:00
    expect(new Date(due).getUTCDay()).toBe(5);
    expect(new Date(due).getUTCHours()).toBe(9);
  });
});

describe("alarm naming", () => {
  it("derives a stable alarm name", () => {
    expect(taskAlarmName("abc")).toBe("task:abc");
  });
});
```

- [ ] **Step 2: FAIL run** → `bun test tests/tasks.test.ts` (module missing).

- [ ] **Step 3: Implement**

```js
// Tasks (#29) — pure scheduling/diff/prompt logic for watches + scheduled
// commands. No chrome.*, no DOM, no fetch: the background owns I/O. Specs are
// plain JSON so a future cloud scheduler can adopt them verbatim.

export const FREQUENCY_CHOICES = [1, 5, 15, 60, 360, 1440];

export function taskAlarmName(id) {
  return 'task:' + id;
}

function newId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function createWatchTask({ url, selector, label, condition, frequencyMin, act }) {
  return {
    id: newId(),
    kind: 'watch',
    url: String(url || ''),
    ...(selector ? { selector: String(selector) } : {}),
    label: String(label || 'Watch'),
    condition: String(condition || ''),
    frequencyMin: FREQUENCY_CHOICES.includes(frequencyMin) ? frequencyMin : 15,
    ...(act && act.prompt ? { act: { prompt: String(act.prompt) } } : {}),
    paused: false,
    createdAt: Date.now(),
  };
}

export function createScheduleTask({ prompt, modeId, url, intervalMin, dailyAt }) {
  return {
    id: newId(),
    kind: 'schedule',
    prompt: String(prompt || ''),
    ...(modeId ? { modeId: String(modeId) } : {}),
    ...(url ? { url: String(url) } : {}),
    ...(Number.isInteger(intervalMin) && intervalMin > 0 ? { intervalMin } : {}),
    ...(dailyAt && dailyAt.hhmm ? { dailyAt } : {}),
    paused: false,
    createdAt: Date.now(),
  };
}

export function alarmPeriodMin(task) {
  if (task.kind === 'watch') return task.frequencyMin;
  if (task.dailyAt) return 1440; // daily alarm; the handler checks the day
  return task.intervalMin || 1440;
}

/** Display/decision math: when is this task next due? (alarms stay the driver) */
export function nextRunDue(task, now = Date.now()) {
  if (task.kind === 'watch') return (task.lastCheckAt || task.createdAt) + task.frequencyMin * 60000;
  if (task.dailyAt) {
    const [h, m] = task.dailyAt.hhmm.split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const d = new Date(now + i * 86400000);
      if (!task.dailyAt.days.includes(d.getUTCDay())) continue;
      const cand = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
      if (cand > (task.lastRunAt || 0)) return cand;
    }
  }
  return (task.lastRunAt || task.createdAt) + (task.intervalMin || 1440) * 60000;
}
```

- [ ] **Step 4: PASS run + commit**

Run: `bun test tests/tasks.test.ts` → PASS.

```bash
git add extension/lib/tasks.js tests/tasks.test.ts
git commit -m "feat(tasks): task factories, alarm naming, due-date math"
```

---

### Task 3: `lib/tasks.js` — `diffText`

**Files:**
- Modify: `extension/lib/tasks.js`
- Test: `tests/tasks.test.ts` (extend)

**Interfaces:**
- Produces: `diffText(oldText, newText)` → `{ changed: boolean, oldExcerpt: string, newExcerpt: string }` — common prefix/suffix trim, then up to 1500 chars of the changed region from each side; identical/no-op whitespace-only changes ⇒ `changed: false`. `summarizeDiff(diff)` → one-line `"a…b"` join for the notification fallback.

- [ ] **Step 1: Failing tests**

```ts
import { diffText, summarizeDiff } from "../extension/lib/tasks.js";

describe("diffText", () => {
  it("no change on identical text", () => {
    expect(diffText("same\ntext", "same\ntext").changed).toBe(false);
  });
  it("detects a middle edit and excerpts just the region", () => {
    const d = diffText("alpha\nOLD\nomega", "alpha\nNEW\nomega");
    expect(d.changed).toBe(true);
    expect(d.oldExcerpt).toContain("OLD");
    expect(d.newExcerpt).toContain("NEW");
    expect(d.oldExcerpt).not.toContain("omega");
  });
  it("handles append-only changes and null old", () => {
    expect(diffText(null, "fresh").changed).toBe(true);
    const d = diffText("base", "base\nadded");
    expect(d.newExcerpt).toContain("added");
  });
  it("caps excerpts at 1500 chars", () => {
    const d = diffText("", "x".repeat(5000));
    expect(d.newExcerpt.length).toBeLessThanOrEqual(1500);
  });
  it("whitespace-only diffs do not count", () => {
    expect(diffText("a  b\nc", "a b\nc").changed).toBe(false);
  });
});

describe("summarizeDiff", () => {
  it("joins old→new on one line", () => {
    expect(summarizeDiff({ changed: true, oldExcerpt: "OLD", newExcerpt: "NEW" })).toBe('OLD → NEW');
  });
});
```

- [ ] **Step 2: FAIL run** → missing exports.

- [ ] **Step 3: Implement**

```js
const EXCERPT_CAP = 1500;

/** Trim the common prefix/suffix lines, then excerpt the changed middle. */
export function diffText(oldText, newText) {
  const a = String(oldText == null ? '' : oldText).trim();
  const b = String(newText == null ? '' : newText).trim();
  if (a === b) return { changed: false, oldExcerpt: '', newExcerpt: '' };
  const al = a.split('\n');
  const bl = b.split('\n');
  let start = 0;
  while (start < al.length && start < bl.length && al[start] === bl[start]) start++;
  let endA = al.length, endB = bl.length;
  while (endA > start && endB > start && al[endA - 1] === bl[endB - 1]) { endA--; endB--; }
  const oldExcerpt = al.slice(start, endA).join('\n').slice(0, EXCERPT_CAP);
  const newExcerpt = bl.slice(start, endB).join('\n').slice(0, EXCERPT_CAP);
  return { changed: true, oldExcerpt, newExcerpt };
}

export function summarizeDiff(diff) {
  if (!diff || !diff.changed) return '';
  const o = (diff.oldExcerpt || '').replace(/\n/g, ' ').slice(0, 120);
  const n = (diff.newExcerpt || '').replace(/\n/g, ' ').slice(0, 120);
  return n && o ? `${o} → ${n}` : (n || o);
}
```

- [ ] **Step 4: PASS run + commit**

```bash
git add extension/lib/tasks.js tests/tasks.test.ts
git commit -m "feat(tasks): diffText — common-trim line diff with capped excerpts"
```

---

### Task 4: `lib/tasks.js` — prompts + verdict parsing

**Files:**
- Modify: `extension/lib/tasks.js`
- Test: `tests/tasks.test.ts` (extend)

**Interfaces:**
- Consumes: `stripCodeFence` from `extension/lib/parse-output.js` (existing export — verify the exact name; it is documented as the shared parse half).
- Produces: `verdictPrompt(task, diff)` → string; `schedulePrompt(task)` → string; `parseVerdict(text)` → `{ relevant: boolean, summary: string } | null` (null on unparseable — caller treats as relevant w/ fallback).

- [ ] **Step 1: Failing tests**

```ts
import { verdictPrompt, schedulePrompt, parseVerdict } from "../extension/lib/tasks.js";

describe("verdictPrompt", () => {
  it("carries condition + both excerpts and demands JSON", () => {
    const p = verdictPrompt({ condition: "price < 50" }, { changed: true, oldExcerpt: "$60", newExcerpt: "$45" });
    expect(p).toContain("price < 50");
    expect(p).toContain("$60");
    expect(p).toContain("$45");
    expect(p).toMatch(/\{"relevant"/);
  });
});

describe("parseVerdict", () => {
  it("parses plain and fenced JSON", () => {
    expect(parseVerdict('{"relevant":true,"summary":"dropped"}')).toEqual({ relevant: true, summary: "dropped" });
    expect(parseVerdict('```json\n{"relevant":false,"summary":"nope"}\n```')).toEqual({ relevant: false, summary: "nope" });
  });
  it("returns null on prose/garbage", () => {
    expect(parseVerdict("The price changed!")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });
});

describe("schedulePrompt", () => {
  it("wraps the saved prompt with the mode + optional page note", () => {
    const p = schedulePrompt({ prompt: "summarize", modeId: "summarize" });
    expect(p).toContain("summarize");
  });
});
```

- [ ] **Step 2: FAIL run.**

- [ ] **Step 3: Implement**

```js
import { stripCodeFence } from './parse-output.js';

/** The semantic-verdict turn: did the change match the user's condition? */
export function verdictPrompt(task, diff) {
  const cond = (task.condition || '').trim();
  return 'You are monitoring a web page for a user. ' +
    `Their watch condition: ${cond || 'ANY change on the page'}. ` +
    'The page just changed. OLD content:\n---\n' + (diff.oldExcerpt || '(nothing)') +
    '\n---\nNEW content:\n---\n' + (diff.newExcerpt || '(nothing)') + '\n---\n' +
    'Decide whether the change matches the condition, and summarize what changed in one short sentence. ' +
    'Respond with ONLY JSON {"relevant": boolean, "summary": string}.';
}

/** Wrapper for scheduled-command turns (mode + optional page handled upstream). */
export function schedulePrompt(task) {
  return String(task.prompt || '').trim();
}

export function parseVerdict(text) {
  const raw = stripCodeFence(String(text == null ? '' : text).trim());
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    if (typeof v.relevant === 'boolean' && typeof v.summary === 'string') {
      return { relevant: v.relevant, summary: v.summary.slice(0, 200) };
    }
  } catch { /* fall through */ }
  return null;
}
```

- [ ] **Step 4: PASS run + commit**

```bash
git add extension/lib/tasks.js tests/tasks.test.ts
git commit -m "feat(tasks): verdict/schedule prompt builders + parseVerdict"
```

---

### Task 5: Manifest permissions + message schema + CRUD handlers + alarm lifecycle

**Files:**
- Modify: `extension/manifest.json` (permissions += `"alarms"`, `"notifications"`)
- Modify: `tests/schemas/manifest.ts` (expected permissions list)
- Modify: `tests/schemas/messages.ts` (`MESSAGE_TYPES` += `TASK_LIST`, `TASK_CREATE`, `TASK_UPDATE`, `TASK_DELETE`, `TASK_TOGGLE`, `TASK_RUN_NOW`, `TASK_ACT_ARM`)
- Modify: `extension/background.js` (import `lib/tasks.js`; storage helpers `loadTasks`/`saveTasks`; 7 handlers; `ensureTaskAlarms()` called at top-level + `chrome.runtime.onInstalled`; `chrome.alarms.onAlarm` listener skeleton → `runTaskById(id)` in Task 6)
- Test: `tests/manifest.test.ts` (auto via schema), `tests/message-contract.test.ts` (auto), `tests/integration/` (CRUD behavior)

**Interfaces:**
- Produces (message contract):
  - `TASK_CREATE { task: WatchInput|ScheduleInput }` → `{ ok, task }`; also creates the alarm.
  - `TASK_LIST {}` → `{ ok, tasks: Task[], runs: Record<taskId, TaskRun[]> }` (runs joined for the view).
  - `TASK_UPDATE { id, patch }` → `{ ok, task }` (patch validated against the schema; alarm re-created).
  - `TASK_DELETE { id }` → `{ ok }` (alarm cleared, runs key removed).
  - `TASK_TOGGLE { id }` → `{ ok, task }` (flips `paused`; pause clears the alarm, resume re-creates).
  - `TASK_RUN_NOW { id }` → `{ ok, run? }` (delegates to the Task-6 pipeline; safe to call manually at any time).
  - `TASK_ACT_ARM { taskId, runId }` → `{ ok }` (bridge — Task 8).

- [ ] **Step 1: Failing tests** — manifest schema updated first:

In `tests/schemas/manifest.ts`, add `"alarms"` and `"notifications"` to the expected permissions array (its current shape asserts the exact permission list). In the integration file:

```ts
it("task CRUD round-trips and manages alarms", async () => {
  const created = await chrome.runtime.sendMessage({
    type: "TASK_CREATE",
    task: { kind: "watch", url: "https://x.dev/", label: "P", condition: "price drop", frequencyMin: 15 },
  });
  expect(created.ok).toBe(true);
  expect(chromeMock.alarmNames()).toContain(`task:${created.task.id}`);

  const toggled = await chrome.runtime.sendMessage({ type: "TASK_TOGGLE", id: created.task.id });
  expect(toggled.task.paused).toBe(true);
  expect(chromeMock.alarmNames()).not.toContain(`task:${created.task.id}`);

  const listed = await chrome.runtime.sendMessage({ type: "TASK_LIST" });
  expect(listed.tasks).toHaveLength(1);

  const gone = await chrome.runtime.sendMessage({ type: "TASK_DELETE", id: created.task.id });
  expect(gone.ok).toBe(true);
  expect(chromeMock.alarmNames()).toHaveLength(0);
});
```

- [ ] **Step 2: FAIL run** → `bun test tests/manifest.test.ts tests/integration -t "task"` (permissions rejected; unknown message types).

- [ ] **Step 3: Implement**

1. `extension/manifest.json` permissions array += `"alarms", "notifications"`; `tests/schemas/manifest.ts` expectation updated to match.
2. `tests/schemas/messages.ts` — append the 7 types.
3. background.js:

```js
import { taskAlarmName, alarmPeriodMin, createWatchTask, createScheduleTask } from './lib/tasks.js';

const TASKS_KEY = 'cobrowse_tasks';

async function loadTasks() {
  const { [TASKS_KEY]: tasks } = await chrome.storage.local.get(TASKS_KEY);
  return Array.isArray(tasks) ? tasks : [];
}
async function saveTasks(tasks) {
  await chrome.storage.local.set({ [TASKS_KEY]: tasks });
}
function upsertAlarm(task) {
  if (task.paused) return chrome.alarms.clear(taskAlarmName(task.id));
  return chrome.alarms.create(taskAlarmName(task.id), { periodInMinutes: Math.max(1, alarmPeriodMin(task)) });
}
async function ensureTaskAlarms() {
  for (const t of await loadTasks()) await upsertAlarm(t);
}
ensureTaskAlarms(); // SW cold start — storage is the source of truth
chrome.runtime.onInstalled.addListener(ensureTaskAlarms);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name && alarm.name.startsWith('task:')) runTaskById(alarm.name.slice(5));
});
```

Plus the seven router cases mapping 1:1 to the Interfaces contract above (`TASK_CREATE` validates via the factories — invalid `kind`/`frequencyMin` returns `{ ok:false, error:'invalid task' }`; `TASK_RUN_NOW` initially stubs to `{ ok:true }` and calls `runTaskById`, whose body lands in Task 6).

- [ ] **Step 4: PASS runs + commit**

Run: `bun test tests/manifest.test.ts tests/message-contract.test.ts tests/integration`
Expected: PASS.

```bash
git add extension/manifest.json tests/schemas/manifest.ts tests/schemas/messages.ts extension/background.js tests/integration
git commit -m "feat(tasks): task CRUD + alarm lifecycle + alarms/notifications permissions"
```

---

### Task 6: Check pipeline — capture, diff, verdict, notify, history, auto-pause

**Files:**
- Modify: `extension/background.js` (`runTaskById`, `runWatchCheck`, `captureForWatch`, `appendRun`, `notifyTask`, badge upkeep)
- Test: `tests/integration/` (extend — requires Task 8's chrome-mock additions if not already present)

**Interfaces:**
- Consumes: `diffText`, `summarizeDiff`, `verdictPrompt`, `parseVerdict` (Tasks 3–4); `askZo` (existing non-streaming); the #24 capture path (`CAPTURE_CONTEXT` tier-1 `{pull:'page'}` + selector text via a small `executeScript`).
- Produces: `runWatchCheck(task)` → appends a `TaskRun` (kind `'check'`), updates `snapshot`/`lastCheckAt`/`lastChangedAt`, notifies on relevant, auto-pauses after 3 consecutive capture failures; `notifyTask(task, run)` → `chrome.notifications.create('task:<id>:<runId>', { type:'basic', iconUrl:'icons/icon128.png', title: task.label, message: run.summary })` + unread badge (`chrome.action.setBadgeText`); `appendRun(run)` → storage FIFO at `RUNS_CAP`.

- [ ] **Step 1: Failing test**

```ts
it("watch check: change → verdict → notification + run history", async () => {
  const { task } = await createWatchOnFixture("https://x.dev/watch"); // helper: TASK_CREATE + fixture page serving text
  const first = await chrome.runtime.sendMessage({ type: "TASK_RUN_NOW", id: task.id }); // baseline snapshot
  expect(first.ok).toBe(true);
  fixtureServer.setWatchText("Price: $45 (was $60)");                 // flip the fixture
  const second = await chrome.runtime.sendMessage({ type: "TASK_RUN_NOW", id: task.id });

  expect(second.run.relevant).toBe(true);            // mocked Zo verdict
  expect(second.run.summary).toMatch(/price/i);
  expect(chromeMock.notifications()).toHaveLength(1); // task notification created
  const listed = await chrome.runtime.sendMessage({ type: "TASK_LIST" });
  expect(listed.runs[task.id]).toHaveLength(2);
});

it("auto-pauses after 3 consecutive capture failures", async () => {
  const { task } = await createWatchOnFixture("https://x.dev/gone"); // 404 fixture
  for (let i = 0; i < 3; i++) await chrome.runtime.sendMessage({ type: "TASK_RUN_NOW", id: task.id });
  const listed = await chrome.runtime.sendMessage({ type: "TASK_LIST" });
  expect(listed.tasks[0].paused).toBe(true);
});
```

(The Zo fetch mock serves `{"relevant": true, "summary": "Price dropped to $45"}` for verdict-prompt inputs — key the mock on the "monitoring a web page" prefix.)

- [ ] **Step 2: FAIL run.**

- [ ] **Step 3: Implement**

```js
async function captureForWatch(task) {
  const [existing] = await chrome.tabs.query({ url: task.url });
  const opened = !existing;
  const tab = existing || await chrome.tabs.create({ url: task.url, active: false });
  try {
    if (tab.status === 'loading') await waitForTabComplete(tab.id, 10000).catch(() => {});
    let cap = null;
    try {
      cap = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_CONTEXT', tier: 1, pull: 'page' });
    } catch {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.body.innerText });
      cap = { visibleText: r.result };
    }
    let text = (cap && cap.visibleText) || '';
    if (task.selector) {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel) => { const el = document.querySelector(sel); return el ? el.textContent : '\u0000nomatch'; },
        args: [task.selector],
      });
      if (r.result === '\u0000nomatch') return { ok: false, error: `selector no longer matches: ${task.selector}` };
      text = String(r.result || '');
    }
    return { ok: true, text: text.trim(), url: (cap && cap.url) || task.url };
  } finally {
    if (opened) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function runWatchCheck(task) {
  const cap = await captureForWatch(task);
  const tasks = await loadTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (!cap.ok) {
    task.failStreak = (task.failStreak || 0) + 1;
    await appendRun({ id: rid(), taskId: task.id, at: Date.now(), kind: 'check', summary: `check failed: ${cap.error}` });
    if (task.failStreak >= 3) { task.paused = true; await upsertAlarm(task); }
    tasks[idx] = task; await saveTasks(tasks);
    return { ok: true, run: null };
  }
  delete task.failStreak;
  const diff = task.snapshot ? diffText(task.snapshot, cap.text) : { changed: true, oldExcerpt: '', newExcerpt: cap.text.slice(0, 1500) };
  task.snapshot = cap.text;
  task.lastCheckAt = Date.now();
  tasks[idx] = task; await saveTasks(tasks);
  if (!diff.changed) return { ok: true, run: null };
  task.lastChangedAt = Date.now();

  let relevant = true;
  let summary = summarizeDiff(diff);
  if (task.condition && task.condition.trim()) {
    const resp = await askZo(null, verdictPrompt(task, diff), config.zoModel);
    const verdict = parseVerdict(resp && resp.text);
    if (verdict) { relevant = verdict.relevant; summary = verdict.summary; }
  }
  const run = { id: rid(), taskId: task.id, at: Date.now(), kind: 'check', relevant, summary, diffExcerpt: diff.newExcerpt.slice(0, 800) };
  await appendRun(run);
  if (relevant) await notifyTask(task, run);
  return { ok: true, run };
}

async function notifyTask(task, run) {
  await chrome.notifications.create(`task:${task.id}:${run.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: task.label,
    message: run.summary || 'Watched page changed',
  });
  const unread = await bumpUnread(1);
  await chrome.action.setBadgeText({ text: unread ? String(unread) : '' });
}
```

`waitForTabComplete` = `chrome.tabs.onUpdated` promise wrapper (or poll `chrome.tabs.get` every 250 ms — poll is simpler and test-friendly). `appendRun` implements the `RUNS_CAP` FIFO. `runTaskById(id)` dispatches `kind==='watch'` → `runWatchCheck`, `kind==='schedule'` → Task 7's `runScheduleTask`.

- [ ] **Step 4: PASS run + commit**

Run: `bun test tests/integration tests/tasks.test.ts`
Expected: PASS.

```bash
git add extension/background.js tests/integration
git commit -m "feat(tasks): watch check pipeline — capture/diff/verdict/notify + auto-pause"
```

---

### Task 7: Scheduled-command execution

**Files:**
- Modify: `extension/background.js` (`runScheduleTask` + day-of-week guard in `runTaskById`)
- Test: `tests/integration/` (extend)

**Interfaces:**
- Consumes: `askZo` + `buildPrompt`/`resolveMode` (existing) — the turn runs with the task's Mode and, when `task.url` is set, the page context captured by `captureForWatch({ url: task.url })`.
- Produces: `TaskRun { kind:'run', summary: <first 200 chars of Zo's output> }` + notification when the output is non-empty; `dailyAt` tasks only fire when `new Date().getUTCDay()` is in `days` (the alarm is daily; the guard skips other days).

- [ ] **Step 1: Failing test**

```ts
it("scheduled command runs its prompt and records the output run", async () => {
  const created = await chrome.runtime.sendMessage({
    type: "TASK_CREATE",
    task: { kind: "schedule", prompt: "Say the word pineapple", intervalMin: 60 },
  });
  const r = await chrome.runtime.sendMessage({ type: "TASK_RUN_NOW", id: created.task.id });
  expect(r.run.kind).toBe("run");
  expect(r.run.summary).toMatch(/pineapple/i); // fetch mock echoes the prompt
  const listed = await chrome.runtime.sendMessage({ type: "TASK_LIST" });
  expect(listed.runs[created.task.id][0].kind).toBe("run");
});
```

- [ ] **Step 2: FAIL run.**

- [ ] **Step 3: Implement**

```js
async function runScheduleTask(task) {
  let pageContext = null;
  if (task.url) {
    const cap = await captureForWatch({ url: task.url });
    if (cap.ok) pageContext = { url: task.url, title: task.label || task.url, visibleText: cap.text.slice(0, 4000) };
  }
  const mode = resolveMode(task.modeId || 'ask', config.customModes || []);
  const prompt = buildPrompt(mode, pageContext, schedulePrompt(task), {});
  const resp = await askZo(pageContext, prompt, config.zoModel);
  const text = String((resp && resp.text) || '').trim();
  const run = { id: rid(), taskId: task.id, at: Date.now(), kind: 'run', summary: text.slice(0, 200) || '(no output)' };
  await appendRun(run);
  if (text) await notifyTask(task, run);
  const tasks = await loadTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  tasks[idx].lastRunAt = Date.now();
  await saveTasks(tasks);
  return { ok: true, run };
}
```

And in `runTaskById`: `if (task.dailyAt && !task.dailyAt.days.includes(new Date().getUTCDay())) return { ok: true, skipped: 'not scheduled today' };`

- [ ] **Step 4: PASS run + commit**

```bash
git add extension/background.js tests/integration
git commit -m "feat(tasks): scheduled-command execution with mode + optional page context"
```

---

### Task 8: chrome-mock — alarms + notifications + badge

**Files:**
- Modify: `tests/helpers/chrome-mock.ts`
- Test: exercised by Tasks 5–7 (already written against these APIs)

**Interfaces:**
- Produces: `chrome.alarms` (`create`/`clear`/`clearAll` storing periods; `fire(name)` helper to simulate alarms in tests; `onAlarm` listener list), `chrome.notifications` (`create` recording ids+options; `onClicked` listener list; `fireClick(id)` helper), `chrome.action.setBadgeText` recorder. Exposed on the mock object the tests already receive.

- [ ] **Step 1: Implement the mock APIs** — small in-memory maps + listener arrays following the file's existing style (storage/tabs routing show the pattern). Add `alarmNames()`, `notifications()`, `fireAlarm(name)`, `fireNotificationClick(id)` accessors for test assertions.

- [ ] **Step 2: Wire the alarm-driven path**

Add one integration scenario proving the alarm path equals the manual path:

```ts
it("alarm fire routes to the task check", async () => {
  const { task } = await createWatchOnFixture("https://x.dev/watch");
  chromeMock.fireAlarm(`task:${task.id}`);
  await waitUntil(async () => (await runCount(task.id)) === 1);
});
```

- [ ] **Step 3: Run + commit**

Run: `bun test tests/integration` → PASS.

```bash
git add tests/helpers/chrome-mock.ts tests/integration
git commit -m "test(tasks): fake-chrome alarms/notifications/badge + alarm-fire path"
```

---

### Task 9: Sidepanel — Tasks view + create form + run history

**Files:**
- Modify: `extension/sidepanel.html` (header `🗂` toggle button; `#tasks-view` section — mirror the history view's structure)
- Modify: `extension/sidepanel.css` (or wherever styles live — follow the history-view classes)
- Modify: `extension/sidepanel.js` (view switching fn beside the history toggle; `renderTasks`; create-form handlers)
- Test: `tests/integration/extension-flow.test.ts`

**Interfaces:**
- Consumes: the 7 task messages (Task 5) + `TASK_RUN_NOW`.
- Produces: Tasks view with list rows (kind icon 👁/⏰, label, `next check ~Nmin` / `paused`, unread dot, ▷ run-now, ⏸/▶ toggle, 🗑 delete, expandable run history) + create form (URL prefilled from the active tab via the existing tab-context helpers; optional CSS selector; NL condition; frequency select from `FREQUENCY_CHOICES` with "at least every …" labels; "Let Zo act" disclosure arming `act.prompt`) + badge cleared on view open (`chrome.action.setBadgeText({ text: '' })` via a background passthrough or direct call — the sidepanel shares extension APIs).

- [ ] **Step 1: Failing test**

```ts
it("tasks view: create a watch from the current page, run now, see the run row", async () => {
  (panelDoc.getElementById("tasks-view-btn") as HTMLElement).click();
  (panelDoc.querySelector("#task-url") as HTMLInputElement).value = "https://x.dev/watch";
  (panelDoc.querySelector("#task-condition") as HTMLInputElement).value = "price drop";
  (panelDoc.querySelector("#task-create") as HTMLElement).click();
  await expectAsync_pollUntil(() => panelDoc.querySelectorAll(".task-row").length === 1);

  (panelDoc.querySelector(".task-row .task-run-now") as HTMLElement).click();
  await waitUntil(() => panelDoc.querySelector(".task-run-row"));
  expect(panelDoc.querySelector(".task-run-row")!.textContent).toMatch(/price/i);
});
```

- [ ] **Step 2: FAIL run.**

- [ ] **Step 3: Implement** — follow the history view's DOM-safety rules (`safeText`, `appendChild`, no innerHTML for user data):

```js
async function renderTasks() {
  const resp = await chrome.runtime.sendMessage({ type: 'TASK_LIST' });
  const list = $('#tasks-list');
  list.textContent = '';
  await chrome.action.setBadgeText({ text: '' });
  for (const t of resp.tasks || []) {
    const row = document.createElement('div');
    row.className = 'task-row' + (t.paused ? ' paused' : '');
    const title = document.createElement('span');
    title.className = 'task-label';
    title.textContent = `${t.kind === 'watch' ? '👁' : '⏰'} ${safeText(t.label)}`;
    const due = document.createElement('span');
    due.className = 'task-due';
    due.textContent = t.paused ? 'paused' : `next ~${relativeTime(nextRunDue(t))}`;
    const run = buttonEl('▷', 'task-run-now', () => chrome.runtime.sendMessage({ type: 'TASK_RUN_NOW', id: t.id }).then(() => renderTasks()));
    const toggle = buttonEl(t.paused ? '▶' : '⏸', 'task-toggle', () => chrome.runtime.sendMessage({ type: 'TASK_TOGGLE', id: t.id }).then(renderTasks));
    const del = buttonEl('🗑', 'task-delete', () => chrome.runtime.sendMessage({ type: 'TASK_DELETE', id: t.id }).then(renderTasks));
    row.append(title, due, run, toggle, del);
    appendRunRows(row, (resp.runs || {})[t.id] || []);
    list.appendChild(row);
  }
}
```

Create form submit → `TASK_CREATE` with `createWatchTask`-shaped input (build the object in the panel with the same field names; the background validates via the factories). "Let Zo act" checkbox reveals a textarea for `act.prompt`. Honest-copy footer: "Checks run while the browser is open — timing is best-effort."

- [ ] **Step 4: PASS run + commit**

Run: `bun test tests/integration/extension-flow.test.ts` → PASS.

```bash
git add extension/sidepanel.html extension/sidepanel.js extension/sidepanel.css tests/integration/extension-flow.test.ts
git commit -m "feat(tasks): sidepanel Tasks view — list/create/run-now/history + badge clear"
```

---

### Task 10: Monitor→act bridge

**Files:**
- Modify: `extension/background.js` (`TASK_ACT_ARM` handler; `chrome.notifications.onClicked` routing)
- Modify: `extension/sidepanel.js` (on-visible check for an armed act → seeded turn)
- Test: `tests/integration/` (notification-click → armed session state → seeded sendQuery)

**Interfaces:**
- Produces: notification click on `task:<id>:<runId>` → focus the task's tab (`chrome.tabs.query({url})` + `update active`, creating it if gone) + `chrome.sidePanel.open({ tabId })` (gesture-qualified) + `chrome.storage.session.set({ ['cobrowse_task_act:' + taskId]: { runId, prompt: task.act.prompt, url: task.url, at: Date.now() } })`. The sidepanel, when it becomes visible, reads any armed act younger than 10 min, consumes it (remove key), and seeds the composer with the act prompt on that tab — a **normal** `sendQuery` turn (context policy, streaming, `pendingActions`, form-fill confirm gate all apply as-is). No auto-execution.

- [ ] **Step 1: Failing test**

```ts
it("notification click arms + focuses; the panel consumes the armed act", async () => {
  const { task, run } = await createWatchAndFireRelevantChange(); // Tasks 6 helpers
  chromeMock.fireNotificationClick(`task:${task.id}:${run.id}`);
  await waitUntil(() => chromeMock.activeTabUrl() === "https://x.dev/watch");
  const armed = await chrome.storage.session.get(`cobrowse_task_act:${task.id}`);
  expect(armed[`cobrowse_task_act:${task.id}`].prompt).toBeTruthy();
  // panel visibility handler consumes it → composer seeded
  await panelBecomesVisible();
  expect((panelDoc.getElementById("chat-input") as HTMLTextAreaElement).value).toContain(task.act.prompt);
});
```

- [ ] **Step 2: FAIL run.**

- [ ] **Step 3: Implement** — background `onClicked`:

```js
chrome.notifications.onClicked.addListener(async (notifId) => {
  const m = notifId.match(/^task:([^:]+):(.+)$/);
  if (!m) return;
  const tasks = await loadTasks();
  const task = tasks.find((t) => t.id === m[1]);
  if (!task) return;
  let [tab] = await chrome.tabs.query({ url: task.url });
  if (!tab) tab = await chrome.tabs.create({ url: task.url });
  await chrome.tabs.update(tab.id, { active: true });
  if (task.act && task.act.prompt) {
    await chrome.storage.session.set({ [`cobrowse_task_act:${task.id}`]: { runId: m[2], prompt: task.act.prompt, url: task.url, at: Date.now() } });
  }
  await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
```

Sidepanel: in the existing visibility/init path, scan `chrome.storage.session` keys starting `cobrowse_task_act:`; entries < 10 min old → remove key, focus the referenced tab chip (tab-contexts), prefill `#chat-input` with `prompt`, leave **sending to the user** (one reviewed gesture — consistent with "nothing auto-runs").

- [ ] **Step 4: PASS run + commit**

```bash
git add extension/background.js extension/sidepanel.js tests/integration
git commit -m "feat(tasks): monitor→act bridge — notification click arms a seeded, user-sent turn"
```

---

### Task 11: e2e — watch scenario

**Files:**
- Modify: `e2e/mock-zo/server.mjs` (fixture route `/watch` whose body text alternates on a `?state=` param or flips per request count; verdict response for "monitoring a web page" prompts)
- Create: `e2e/13-watch-tasks.spec.ts`

- [ ] **Step 1: Spec**

```ts
test("watch: create, run-now baseline, page changes, run again → relevant run row", async ({ page }) => {
  const { panel, page: webTab } = await launchExtension({ url: "http://127.0.0.1:3179/watch" });
  await panel.locator("#tasks-view-btn").click();
  await panel.locator("#task-condition").fill("when the price changes");
  await panel.locator("#task-create").click();
  await expect(panel.locator(".task-row")).toHaveCount(1);

  await panel.locator(".task-run-now").click(); // baseline snapshot
  await expect(panel.locator(".task-run-row")).toHaveCount(0); // no change yet

  mockServer.setWatchState("b"); // flip fixture content
  await panel.locator(".task-run-now").click();
  await expect(panel.locator(".task-run-row")).toHaveCount(1);
  await expect(panel.locator(".task-run-row")).toContainText(/price/i);
});
```

- [ ] **Step 2: Full gates + commit**

Run: `bun run test:e2e -- e2e/13-watch-tasks.spec.ts && bun run verify && bun run test:e2e`
Expected: green.

```bash
git add e2e/mock-zo/server.mjs e2e/13-watch-tasks.spec.ts
git commit -m "test(tasks): e2e — watch run-now cycle against a flipping fixture"
```
