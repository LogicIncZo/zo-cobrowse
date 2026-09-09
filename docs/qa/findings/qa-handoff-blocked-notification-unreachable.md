---
key: qa-handoff-blocked-notification-unreachable
title: "Blocked" status is never set — the "handoff needs you" notification can never fire
severity: P3
surface: handoff
source: review
found: 2026-09-10
---
**What breaks:** spec line 63 promises one-shot `chrome.notifications` for
"handoff done / blocked". `handoffMaybeNotify` handles both
(background.js:2101-2111), but nothing ever calls `transition(run, 'block')` —
every loop stop uses `pause` instead (budget background.js:2171, port dead
2190, stream error 2217, SW restart 2129). Status `blocked` is unreachable, so
the "Zo handoff needs you" notification never fires: a user who walked away
gets notified only on `done()`, not when the run pauses on budget exhaustion
or a boundary pause.

**Fix direction:** either transition to `blocked` (instead of `pause`) for
boundary/budget stops that need user input, or extend the notification trigger
to cover the pause reasons that require attention.
