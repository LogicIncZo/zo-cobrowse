---
key: qa-handoff-run-tab-marker-missing
title: Run-tab title marker ("🤖 working…") not implemented — extension badge only
severity: P3
surface: handoff
source: review
found: 2026-09-10
---
**What breaks:** spec line 62 promises a run-tab marker (badge/title
"🤖 working…"). Only the extension badge ▶ exists (background.js:2086-2096);
`extension/lib/chat-tabs.js` has no handoff awareness and `renderChatTabs`
adds no marker to the run's chat tab, so the run's tab is visually
indistinguishable from any other chat while it works. (AGENTS.md claims only
the badge, so this is spec-vs-impl drift, not an AGENTS.md error.)

**Fix direction:** have `tabTitleFor`/`renderChatTabs` prefix the running
run's chat tab with 🤖 (the run's chatId is already known to the panel via
activeHandoffRun).
