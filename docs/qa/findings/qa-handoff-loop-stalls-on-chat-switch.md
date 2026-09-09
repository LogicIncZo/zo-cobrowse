---
key: qa-handoff-loop-stalls-on-chat-switch
title: Switching panel chats mid-run silently stalls the handoff loop in running (badge stuck)
severity: P2
surface: handoff
source: review
found: 2026-09-10
---
**What breaks:** the run's chained turns adopt the run's chat's
`streamSession.chatId` (sidepanel.js:3982). If the user switches to another
panel chat mid-run, STREAM_DONE takes the background-chat path
(sidepanel.js:4204-4220): actions park as `conv.pendingActions` and
`handleStreamActions` never runs → no `EXECUTE_ACTIONS` carrying
`handoffRunId` → `handoffAfterExecute` never fires → no continuation turn.
The run stays `running` forever with the ▶ badge stuck (no stall detection
exists). Switching back restores the actions into the plain pendingActions bar
*without* `handoffRunId` (sidepanel.js:2220-2228), which does not restart the
loop. Spec line 53 promises an interruptible-but-live run; instead it dies
quietly.

**Fix direction:** route backgrounded handoff-chat STREAM_DONE into the
handoff tally instead of plain parking (or auto-adopt the run's chat like the
chained-sessionId adoption does), and add a stall watchdog (no continuation
for N minutes → pause with reason).
