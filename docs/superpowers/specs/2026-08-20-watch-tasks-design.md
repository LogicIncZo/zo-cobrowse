# Watch & Scheduled Tasks — page monitors + scheduled AI commands (#29; unifies tickets #14 + BACKLOG #16/#17)

**Date**: 2026-08-20
**Status**: Approved design (0.2.0 planning round)
**Related**: `2026-08-20-0.2.0-competitive-analysis.md` §3.2 (Comet's Tasks = retention mechanic; AI-semantic diff = 2026 monitoring table stakes; monitor→act bridge = our wedge); `2026-08-20-form-fill-design.md` (the bridge parks at its confirm gate); `2026-08-20-cross-tab-actions-design.md` (bridge routing); tickets `tickets/ticket-14-page-monitoring.md`
**Branch (planned)**: `feature/watch-tasks`

## Problem

Two capability gaps, one engine. (1) Zo is blind between conversations: it cannot watch a price, a docs changelog, or a registration button, and it cannot run "every weekday at 9: summarize what changed" — the single strongest retention mechanic in the competitor set (Comet Tasks, Fellou schedules, ChatGPT Tasks). (2) Dedicated monitors (Distill/Visualping/changedetection.io) can detect a change but can't *do* anything about it. The extension has every primitive needed — alarms-capable service worker, a tiered capture pipeline, an LLM channel, a notification surface — but no task model, scheduler, or UI.

## Concept

A **Tasks** view in the sidepanel (third surface alongside chats + history) managing two task kinds over one engine:

- **`watch`** — "watch this page (or a pinned selector / text selection) and tell me when ⟨natural-language condition⟩". Each check captures the target's text, diffs against the last snapshot, and — when the text changed — routes the diff through Zo for a **semantic verdict** (`{relevant, summary}`): "relevant" means the change matches the user's condition, not merely that bytes differ. Relevant changes notify (OS notification + badge) and append to the task's run history.
- **`schedule`** — a saved prompt run at an interval ("every weekday 9am") or daily time, executed headlessly through the existing non-streaming `askZo`, its output stored as the task's run history and summarized in a notification.

The **monitor→act bridge** is the differentiator: a watch may carry `act: { prompt }` ("if the price drops, get me to checkout"). When a relevant change fires and the user clicks the notification, the sidepanel opens focused on the target tab with a ready turn — act prompt + fresh page context — streaming through the normal path, whose actions park under the existing `pendingActions` semantics and the **#26 confirm gate** for forms. Detect → notify → act → *confirm* — no competitor closes that loop in the user's own browser.

### Decisions

| Fork | Decision | Rationale |
|------|----------|-----------|
| Scheduler | **`chrome.alarms`, one alarm per task** (`periodInMinutes` ≥ 1; daily-time tasks use a daily alarm + day-of-week check in the handler — alarms can't express weekdays) | The only durable MV3 scheduler; survives service-worker death. UX copy says "**at least** every N min" — Chrome batches alarms, and promising precision would lie. |
| Where checks run | **Client-side only in v1** (browser open ⇒ checks run; browser closed ⇒ checks pause). Task specs are serializable by design so a Zo-side cloud scheduler + FCM can take over later (Distill's local-free/cloud-paid split) | FCM is the only external wake mechanism and needs backend work + user setup; shipping local-first gets the whole UX shipped now without a dead dependency. |
| How a check captures its page | Reuse an open tab matching the task URL; else `chrome.tabs.create({active:false})` → `document_idle`-ish settle → `CAPTURE_CONTEXT` tier-1 (`{pull:'page'}`) or selector text via the content script → close the tab if we opened it | No new capture path — the #24 pipeline verbatim; hidden-tab capture mirrors the banner-free background-tab discipline. |
| Diff detection | `lib/tasks.js#diffText(oldText, newText)` — common prefix/suffix trim → line-level changed regions (old/new excerpts, capped ~1500 chars each) | Text diff (not visual) matches our DOM-text capture; excerpts are what the LLM verdict + notification summary consume. Visual diff is a Distill-vs-Visualping differentiator we don't need for v1 conditions. |
| Semantic verdict | Changed ⇒ one non-streaming `askZo` call with `verdictPrompt(task, diff)` asking for JSON `{relevant: boolean, summary: string}`; parsed via the existing `stripCodeFence`/`parseZoOutput` machinery. Empty condition ⇒ any change is relevant (pure detector mode) | AI-semantic detection is the 2026 table-stakes differentiator in the monitor category, and the verdict summary *is* the notification text. Failure to parse ⇒ treat as relevant with raw-diff summary (false positive beats silent miss). |
| Scheduled-command execution | Non-streaming `askZo` with optional page context (task URL, if any); output stored as a run — **not** a sidepanel conversation | Keeps user chats untouched; run history is the audit surface. Streaming into a task conversation is a follow-up if users want to converse with results. |
| Notifications | `chrome.notifications.create` (basic, per relevant run, deduped by run id) + `chrome.action.setBadgeText` unread count (cleared on Tasks view open). Notification click → focus target tab + open the sidepanel | OS + badge are the only zero-backend channels; email/Slack need the Zo relay (later). Click-through is what makes the bridge one gesture away. |
| The act step | Notification click (or "Act now" in the run detail) opens the panel with a **seeded turn**: act prompt + fresh context, sent through the normal `sendQuery` path | Reuses streaming, action execution, `pendingActions`, and the #26 confirm gate wholesale — the bridge is orchestration, not a new executor. The user sees and approves everything; nothing auto-runs against an unwatched page (chat-tabs precedent). |
| Task identity | New backlog id **#29**; absorbs tickets #14 (page monitoring) + BACKLOG #16 (scheduled commands) + #17 (web monitoring) | One engine, three old rows — BACKLOG gets folding notes, not deletions (history matters). |
| Permissions | manifest += `"alarms"`, `"notifications"`; `tests/schemas/manifest.ts` updated in the same task | Both are exercised by tested paths (alarm handler, notification click) — the AGENTS.md permissions rule. |

## Data & contracts

- **Zod** (`tests/schemas/tasks.ts`): discriminated union on `kind` —

  ```
  WatchTask  { id, kind:'watch', url, selector?, label, condition, frequencyMin ∈ {1,5,15,60,360,1440},
               act?: { prompt }, paused, createdAt, lastCheckAt?, lastChangedAt?, snapshot? }
  ScheduleTask { id, kind:'schedule', prompt, modeId?, url?, intervalMin? , dailyAt? {hh:mm, days:[1-7]},
               paused, createdAt, lastRunAt? }
  TaskRun { id, taskId, at, kind:'check'|'run', relevant?, summary, diffExcerpt? }
  ```

  Storage: `chrome.storage.local['cobrowse_tasks']` (array of specs) + `['cobrowse_task_runs:' + id]` (capped 20/task, FIFO).
- **`lib/tasks.js`** (pure, no chrome/DOM): `taskAlarmName(id)`, `frequencyChoices()`, `nextRunDue(task, now)` (display), `diffText(old, neu)`, `verdictPrompt(task, diff)`, `schedulePrompt(task)` (wraps the saved prompt with mode + optional context note), `shouldNotify(run)` (dedupe/idempotence helper).
- **Messages** (`tests/schemas/messages.ts` += 7): `TASK_LIST`, `TASK_CREATE`, `TASK_UPDATE`, `TASK_DELETE`, `TASK_TOGGLE`, `TASK_RUN_NOW`, `TASK_ACT_ARM`. Background gains the matching handlers + the `chrome.alarms.onAlarm` listener (contract test enforces the split stays 1:1).

## UX

Sidepanel header gains a 🗂 Tasks toggle beside history. Tasks view: list rows (kind icon, label, next-due / paused, unread dot, ▷ run-now, ⏸ toggle, 🗑 delete) + a create form. **Watch-from-page flow**: "👁 Watch this page" button (or context-menu entry, reusing the existing menu plumbing) prefills URL + title; optional CSS-selector pin; NL condition input ("price below $50", "any new post"); frequency select with the "at least" copy; optional "Let Zo act" disclosure with act prompt. Run detail (expand a row): verdict summaries + diffs, newest first, "Act now" on relevant runs. First-run tooltip states the local-only contract: "Checks run while the browser is open."

## Error handling

- Capture failure (page gone behind a paywall/login, selector no longer matches): run recorded `relevant:false, summary:'check failed: …'`; three consecutive failures ⇒ auto-pause + notification ("Watch paused — page stopped matching").
- Zo verdict failure (network/parse): treated as relevant with the raw excerpt as summary (visible, deduped per run — no retry storm; next scheduled check re-evaluates).
- Alarm churn (clock sleep/wake): alarms are re-asserted from storage on startup (`onInstalled` + SW cold start) — the task list is the source of truth, alarms are a derivative cache.
- Storage overflow: run FIFO cap; tasks list unbounded but tiny (warn > 50 in UI).

## Testing

- Unit: `tests/tasks.test.ts` — `diffText` truth table (no-change, append, middle-edit, resize), `nextRunDue`, prompt builders, against `tests/schemas/tasks.ts` (schema-validate every factory output).
- Integration: extend the fake-chrome mock with alarms + notifications; assert alarm-fire → capture → mock-Zo verdict → notification + badge + run history; auto-pause after 3 failures; startup re-asserts alarms from storage.
- Contract: 7 new message types covered by `tests/message-contract.test.ts` (schema + handler lists stay in lockstep).
- Manifest: permission-list assertion updated (`alarms`, `notifications`).
- e2e: `watch` scenario — mock server flips its fixture between checks (scenario keyed on a query param the background control page toggles); spec drives `TASK_RUN_NOW` and asserts notification + run row. Scheduled-command e2e folded into the same spec (run-now on a `schedule` task asserts a stored run).

## Non-goals

- Cloud scheduling / browser-closed checks (FCM + Zo-side scheduler — v0.3+, additive by design); email/Slack/webhook channels; visual/screenshot diffing; parallel background agents; watch exports; task sharing.
- Existing `CREATE_AUTOMATION`/`LIST_AUTOMATIONS` (Zo-side automations surface) stays untouched — #29 is browser-local; bridging the two models is a later consolidation decision.
