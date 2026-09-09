---
key: qa-handoff-parked-actions-unreachable
title: Boundary-parked actions never reach the pendingActions review card; sensitive-page refusals bypass the park log entirely
severity: P2
surface: handoff
source: review
found: 2026-09-10
---
**What breaks (a):** spec line 60 promises boundary-violating actions are
parked "into the existing `pendingActions` review card — the user performs
terminal actions". Instead parked actions go to `run.parkLog`
(background.js:2153-2156) and render as a display-only text row in the handoff
batch card (sidepanel.js:4547-4549); nothing adds them to the #26 review card
and no mechanism performs them from it. lib/handoff.js:147-148's comment
claims the review card but nothing implements it.

**What breaks (b):** on sensitive pages the #26 submit backstop
(background.js:2331-2339) fires *before* the handoff boundary check
(2363-2372) and emits `{blocked:true}` **without** `handoffParked` — those
refusals never enter `parkLog`, under-counting "Parked for the user" in
continuation turns / the progress line, and render as "⚠️ failed" instead of
"⛔ parked".

**Fix direction:** emit `handoffParked` from the submit backstop when a run is
active, and merge `parkLog` entries into the review card (or link the batch
card rows to per-action Run buttons).
