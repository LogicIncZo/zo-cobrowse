---
key: qa-handoff-chained-turns-re-send-chips
title: Continuation turns replay turn-1's send-once chips (skills/workspaceFiles/tabContexts/shot) every turn
severity: P2
surface: handoff
source: review
found: 2026-09-10
---
**What breaks:** `handoffChainNextTurn` spreads `...msg` when building the
continuation payload (background.js:2200-2212), so turn 1's `skills`,
`workspaceFiles`, `tabContexts`, and `shotOnly` ride *every* chained turn
(consumed at background.js:1219, 1232). `## Skills to Run` re-renders and the
skill re-executes on each continuation — the exact "re-runs the skill
uninvited" outcome the send-once contract exists to prevent
(sidepanel.js:4703-4705) — and stale tab excerpts are re-billed. The spec
defines the continuation turn as just a progress report + continue prompt
(line 58).

**Related finding:** `qa-pickers-skills-section-residue` (panel-side follow-up
asks re-render the section too — distinct path, same user-visible defect
class; fix both under the send-once contract).

**Fix direction:** strip send-once fields (`skills`, `workspaceFiles`,
`tabContexts`, `shotOnly`) from the spread when building continuation
payloads.
