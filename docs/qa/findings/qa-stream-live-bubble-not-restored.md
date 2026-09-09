---
key: qa-stream-live-bubble-not-restored
title: Switching back to a streaming chat shows no live progress until the stream completes
severity: P3
surface: streaming
source: explorer
found: 2026-09-10
---
**What breaks:** per AGENTS.md, "switching back re-creates the live bubble".
Observed instead: after ＋ new chat B and immediately clicking back to chat A
mid-stream, no streaming bubble renders for the remainder of the stream — the
complete answer pops in at once at completion. The turn is NOT lost (answer +
footer correct at the end); the live-progress re-creation is.

**Status: single observation — needs a confirm rerun** before prioritizing
(explorer probe p3 variant A; 10s assertion window with the full answer
arriving at the end).

**Suspect:** `extension/sidepanel.js:1027-1050` — the re-create replays
`streamSession.fullText`/`reasoningText` at switch time, but subsequent deltas
don't re-attach to the fresh `streamSession.msgEl` (or the re-create never
fired on that path). Possibly the milder face of
`qa-chat-switch-stream-answer-lost` (same stale-session guard region).

**Fix direction:** when re-creating the live bubble, keep it bound to
`streamSession` so subsequent deltas append (re-point `msgEl` instead of a
one-shot text replay).
