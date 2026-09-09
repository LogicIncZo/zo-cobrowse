---
key: qa-action-timeline-html-injection
title: Action timeline renders model/page-derived action fields into innerHTML unescaped
severity: P2
surface: action-timeline
source: review
found: 2026-09-10
---
**What breaks:** `renderActionTimeline` (sidepanel.js:1945-1950) builds each
action card via `card.innerHTML = …${actionDetail(g.action)}…`, and
`actionDetail()` (sidepanel.js:1666-1672) returns raw `action.selector ||
action.url || action.value || action.ms` — no `escapeHtml`, no
`textContent`. This is the only sink in the panel that puts model/page-derived
free text into `innerHTML` unescaped, violating the house text-safety rule
(AGENTS.md: "safeText/String() coercion at every text sink").

**Taint path:** page content (ids, classes, field names, form values captured
by `captureContext`) → Zo's action JSON echoes those strings verbatim
(`normalizeActions` constrains `type` but passes string fields through,
`extension/lib/modes.js:276`) → `STREAM_DONE.msg.actions` →
`pendingActions` (sidepanel.js:4475) → the innerHTML sink on run
(line 2105). Second entry: backgrounded-chat `conv.pendingActions`
(line 4219) → `restorePendingActionsFor` (line 2224) → same render.

**Impact:** MV3 CSP (`script-src 'self'`) blocks inline handlers, so this is
markup injection into the trusted `chrome-extension://` panel — UI
spoofing/phishing forms, injected `<img>`/link exfil beacons — not guaranteed
script execution. A hostile page can plant markup in an attribute value or
field name that Zo quotes back in an action.

**Fix shape (one-liner pattern used everywhere else in the file):** escape the
detail — `escapeHtml(actionDetail(g.action))` — or assemble the card with
`textContent` like the sibling paths do (`renderFillFormFieldResults`
line 2089, `updateActionCard` line 1971). The existing timeline tests
(tests/sidepanel.test.ts:736-905) assert group counts only; add an escaping
assert to pin the fix.
