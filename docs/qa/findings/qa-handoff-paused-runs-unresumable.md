---
key: qa-handoff-paused-runs-unresumable
title: Paused handoff runs can never resume (or abort) — "resume to continue" is a dead letter
severity: P1
surface: handoff
source: review
found: 2026-09-10
---
**What breaks:** the SW-restart sweep pauses running runs with the notice
"extension restarted — resume to continue" (background.js:2124-2135), but **no
resume path exists anywhere**: the `'resume'` transition is defined in the
state machine's allowed transitions (lib/handoff.js:98-99) yet has **zero call
sites** in background.js/sidepanel.js; there is no `HANDOFF_RESUME` message
type (tests/schemas/messages.ts:31-33 — only START/STOP/STATUS/UPDATE); and
the panel offers no resume control — on pause it removes the stop line and
prints only the reason (sidepanel.js:305-315). A paused run can never leave
`paused` until the browser closes. The schema comment even promises "paused …
resumable" (tests/schemas/handoff.ts:18).

**Same root cause, second symptom:** spec line 62 promises "closing the run
tab aborts" — `closeChatTabById` (sidepanel.js:1153-1163) only calls
`cancelStream()` with no HANDOFF_STOP; the port disconnect makes the
background pause with "panel closed mid-run" (background.js:2189-2193), which
is then stuck in `paused` forever (nothing sends STOP once the line is gone).
tests/schemas/handoff.ts:22-23 documents `aborted // run tab closed` —
contradicted by the code.

**Spec refs:** 0.2.7 slate spec line 58 ("resumes, never strands") and line 62
("closing the run tab aborts"); AGENTS.md handoff block.

**Fix direction:** add a `HANDOFF_RESUME` message (schema + handler) that
re-chains the next turn from the paused run's state, wire a resume affordance
in the panel's pause line, and send HANDOFF_STOP (abort) from
`closeChatTabById` for the run's chat.
