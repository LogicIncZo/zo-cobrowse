---
key: qa-handoff-run-state-leaks-across-chats
title: activeHandoffRun is panel-global — manual sends in other chats get conscripted as handoff turns; non-streaming fallback strands the run in priming
severity: P1
surface: handoff
source: review
found: 2026-09-10
---
**What breaks (a):** `activeHandoffRun` is a panel global, not per-chat, and
is never cleared on conversation switch (reset points: sidepanel.js:170-172,
307, 4665 only). While set, *every* send in *any* chat carries
`handoffRunId` (sidepanel.js:4907) and executes via `executeHandoffBatch`
(sidepanel.js:4450-4453), overwriting the loop's turn context including the Zo
thread id (background.js:924, 2206). A manual query typed in another chat
mid-run is conscripted as a handoff continuation turn — violating cross-cutting
rule 4 ("unattended execution only ever starts from an explicit !handoff")
in spirit: the run hijacks unrelated chats.

**What breaks (b) — deterministic strand:** the non-streaming fallback
(sidepanel.js:4921-4937) omits `handoffRunId` from its ASK_ZO payload (no
handoffRunId line in the payload), and the onMessage ASK_ZO case
(background.js:366) neither registers turn context nor flips
priming→running — so if turn 1 of a run falls back to non-streaming, the run
stays `priming` forever, `activeHandoffRun` stays set (badge ▶ stuck,
background.js:2087 counts `priming` as live), and any later ordinary send
attaches the stale `handoffRunId`, can flip the run to `running`, and chains a
handoff loop from a non-`!handoff` query. Related: the SW-restart sweep pauses
only `running` runs (background.js:2128), never stuck `priming` ones.

**Fix direction:** key `activeHandoffRun` per chat (like streamSession.chatId
and the context-state maps); clear it in switchToConversation; register/advance
run state in the non-streaming path or make the fallback refuse handoff turns;
include `priming` in the restart sweep's staleness handling.
