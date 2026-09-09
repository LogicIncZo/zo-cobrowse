---
key: qa-chat-switch-stream-answer-lost
title: Concurrent second turn + rapid tab switches permanently loses a chat's streamed answer (no recovery)
severity: P1
surface: streaming
source: explorer
found: 2026-09-10
---
**What breaks:** when a second chat's send lands near the tail of chat A's
in-flight stream (the composer lock drops as A's stream ends) and the user
rapidly alternates tabs A↔B (~120 ms apart), chat A's completion is dropped
entirely: only the user bubble renders, no answer/footer/error card, the
storage record keeps `nMsgs:1`, and a panel reload does NOT recover the
answer. Permanent data loss.

**Repro (3× consecutive, explorer probes p1/p4/p5):**
1. Fresh harness; send `answer slowly: …A` in chat A (~10s stream).
2. While it streams, ＋ new chat B; send a query in B timed to land as A's
   stream ends (send button re-enables at A's tail).
3. Rapidly alternate A↔B ~8 times; land on A; wait 30s+.
4. A shows user bubble only; `cobrowse_convos` record for A has 1 message.

**Suspect:** `extension/sidepanel.js:3976` — the stale-session guard
(`msg.sessionId !== streamSession.sessionId`) drops A's tail/STREAM_DONE after
chat B's send bumps `streamSession.sessionId` (sidepanel.js:4880); the
one-stream-at-a-time composer lock (sidepanel.js:1052) is meant to prevent
overlap but a retry-clicked send slips through at the old stream's tail.
`switchToConversation` (sidepanel.js:1001) save/restore is also in play.

**Contrast:** `qa-stream-accumulation-debugger-conflict` loses accumulation
only under CDP contention; this reproduces with no debugger involved — plain
UI timing. The scripted specs (m1, 20-chat-tabs) never send a concurrent
second turn and wait out streams before switching, which is why this survived
them.

**Fix direction:** route stale-session stream tails by chatId into
`saveConversationById` instead of dropping them (the guard should only stop
DOM rendering, never accumulation), and/or make the session bump re-key the
in-flight stream rather than orphan it.
