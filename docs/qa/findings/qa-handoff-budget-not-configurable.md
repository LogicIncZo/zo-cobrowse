---
key: qa-handoff-budget-not-configurable
title: Handoff budget defaults live outside config DEFAULTS and are not user-tunable
severity: P3
surface: handoff
source: review
found: 2026-09-10
---
**What breaks:** spec line 61 promises "max turns / navigations / minutes
(defaults in `config.js` `DEFAULTS`, schema'd)". `DEFAULT_BUDGET` lives in
`extension/lib/handoff.js:20`; `extension/lib/config.js` has no handoff keys;
and the panel never sends a budget override — HANDOFF_START carries only
chatId/tabId/goal/boundaryMode (sidepanel.js:4650-4656). The budget schema
exists (tests/schemas/handoff.ts:27-33) but the promised placement and
configurability do not.

**Fix direction:** move the defaults into `config.js DEFAULTS` (schema'd via
tests/schemas/config.ts) and pass an optional budget on HANDOFF_START; an
options-card control can follow later.
