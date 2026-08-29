# Changelog

The full, versioned history lives in the repo's
[CHANGELOG.md](https://github.com/LogicIncZo/zo-cobrowse/blob/dev/CHANGELOG.md).
This page mirrors everything **unreleased** on `dev`.

## [Unreleased]

### Added — UX polish + context transparency
- **📷 Image toggle (send-once screenshot)** — a chip at the end of the tab
  strip arms ONE turn with a page screenshot: no `!context` prefix, no Mode
  hunting. Arming flips the MODE dropdown to Visual (unchecking before send
  restores it); the send forces tier 3, shows a 📷 Screenshot pill on the
  user bubble, then auto-clears the toggle (Mode stays Visual). The prompt
  inspector mirrors the force before sending, and the capture itself stays
  truthful (the vision gate can still skip a non-vision model; the 📷 footer
  chip only lights when pixels actually rode the turn).
- **Context-tier chip on every assistant footer** — 🔗 URL only / 📝 Text /
  🧩 Elements / 📷 Screenshot, tooltip = the context-policy decision reason;
  persisted on the message so history re-renders keep it. Makes the per-turn
  token story visible without opening the prompt inspector.
- **Empty-state starter chips** — a fresh chat shows four clickable starting
  points (summarize / `!context` peek / extract links / research) that prefill
  the composer; the card retires itself on the first message.
- **Copy button on code blocks** — every rendered fenced block gets a Copy
  button (clipboard write + label flip). Also fixes a double-escape bug where
  code blocks displayed literal `&#39;` entities.
- **⬇ Latest pill** — appears when the chat log is scrolled away from the
  bottom (e.g. while reading during a stream); clicks snap back.

### Fixed — 📷 screenshots never reached Zo on real Chrome
- **`<all_urls>` host permission**: `chrome.tabs.captureVisibleTab` requires the literal
  `<all_urls>` pattern (or an activeTab gesture) — the manifest's scoped wildcards
  (`http://*/*` + `https://*/*`) do NOT qualify, so every tier-3 turn silently failed
  capture with "Either the '<all_urls>' or 'activeTab' permission is required." and
  shipped text-only context while the UI implied pixels were attached. The manifest now
  declares `<all_urls>`.
- **Honest failure surfacing**: a failed or skipped capture on a tier-3 turn is recorded
  in `pageContext.screenshotError` (vision-gate skip, disabled setting, or the capture
  error itself). The 📷 Screenshot pill on the user bubble now renders only when the
  image actually rode the turn; otherwise an inline system warning explains what
  happened instead of silently degrading to text-only.

### Fixed — follow-up context (token optimization)
- **Send-once tab excerpts**: referenced-tab manifests re-sent their 500-char
  excerpt on EVERY turn for unchanged pages. Tabs already sent at the same
  url+title now ride as a pointer-only manifest line ("already provided
  above") — the T-ref stays alive for `read_tab` escalation while the excerpt
  rides Zo's conversation threading. Dedup state persists per chat
  (`tabManifestSent` in the session context state); the prompt inspector
  preview mirrors it, so preview and send can't diverge.
- **No-thread re-attach guard**: same-page follow-up dedup trusted
  `conversation_id` threading even when the thread was never established
  (retry after a stream that died before the conversation_id echo → a fresh
  Zo thread holds nothing). `decideTurn` now takes `hasThread`; without a
  thread, action turns re-attach full context.
- **Single-chunk streams rendered empty bubbles**: a stream whose whole answer
  arrived in the PartStart event created the live bubble with no streaming
  span, and STREAM_DONE's markdown replace skipped it. Now rendered.
- **Wrong mode chip after `!mode` bangs**: the STREAM_DONE footer resolved the
  active Mode instead of the turn's (bang-overridden) mode.

### Added — settings + chat-list usability
- **Settings tabbed UI** — the section-nav chips became real tabs
  (Connection / Model & Persona / Prompts / Features / Actions / About): one
  pane visible at a time, no page-long scroll. The last tab persists across
  visits; `#card-*` deep links still land on the right pane (hash clicks
  included); Save stays visible below the panes.
- **Token Show/Hide** — reveal button on the access-token field.
- **Fixed status toast** — Save feedback used to render at the very bottom of
  the page, invisible from the Save button; now a fixed toast.
- **Unsaved-changes marker** — editing flags both Save buttons with a •
  (autosave controls excluded); clears on save.
- **Runtime version** — the About card reads the version from the live
  manifest (was hardcoded "v0.0.1"); repo links repointed to LogicIncZo.
- **Chat-list preview snippets** — each history card shows a one-line preview
  of the conversation's opening ask (first user message, collapsed).
- **Search highlighting** — history search matches are `<mark>`-highlighted
  in titles and snippets.
