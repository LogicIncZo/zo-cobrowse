---
key: qa-handoff-done-refire-race
title: HANDOFF_STOP on a done run re-fires the completion notification and duplicate panel line
severity: P3
surface: handoff
source: review
found: 2026-09-10
---
**What breaks:** `HANDOFF_STOP` on an already-`done` run still calls
`handoffPut(run)` (background.js:452) → `handoffMaybeNotify` re-fires
(2101-2111, same notification id) and re-pushes `HANDOFF_UPDATE`; the panel
(with `activeHandoffRun` already null) falls into the terminal branch and adds
a duplicate "✅ Handoff done" system line (sidepanel.js:305-315). Narrow race —
the stop button is removed on done — but the handler lacks a terminal-status
guard, and Chrome may replace-but-re-alert on the same notification id.

**Fix direction:** early-return in the HANDOFF_STOP handler when the run is
already terminal (done/aborted), and guard the panel's terminal branch against
a second update for the same run id.
