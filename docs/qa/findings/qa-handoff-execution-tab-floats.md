---
key: qa-handoff-execution-tab-floats
title: Handoff actions follow browser focus instead of the pinned run tab
severity: P2
surface: handoff
source: review
found: 2026-09-10
---
**What breaks:** spec line 57 pins handoff runs to ONE tab ("Single-tab
sequential runs — the handoff drives ONE tab"). But actions execute against
the panel's *current* `currentContext.tabId` (sidepanel.js:4538), and
`adoptActiveTabDisplay` overwrites `currentContext` on every
`chrome.tabs.onActivated` (sidepanel.js:2633 → 1478). `run.tabId` (stamped at
HANDOFF_START, background.js:443) is used only for the continuation capture
(background.js:2198). A mid-run browser-tab switch therefore redirects the
run's DOM actions to whatever tab the user focused, while Zo is shown the
pinned tab's capture — the model acts on one page while believing it is on
another.

**Fix direction:** execute handoff actions against `run.tabId` (the stamped
pin) rather than the display-adopted context, or re-capture + re-pin when the
run's tab changes and surface the switch in the run progress line.
