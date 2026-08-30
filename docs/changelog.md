# Changelog

The full, versioned history lives in the repo's
[CHANGELOG.md](https://github.com/LogicIncZo/zo-cobrowse/blob/dev/CHANGELOG.md).
This page mirrors everything **unreleased** on `dev`.

## [Unreleased]


### Fixed — `Reconnecting…` banner actually shows on transient stream failures (#95)
- **The banner was dead code on the exact path it was built for (QA finding D, P4)**: on a
  retriable network error the background posted a `STREAM_ERROR` *before* retrying, which the
  panel treats as terminal — the session died, the "➳ Reconnecting… attempt 2 of 3" banner was
  ignored, and recovery only rendered through the inactive-`STREAM_DONE` fallback.
- The streaming impl no longer posts premature errors: retriable failures stay silent during
  backoff (the banner shows via `STREAM_RECONNECT`), and the one terminal `STREAM_ERROR` arrives
  only after all retries are exhausted. 4xx/in-stream Zo errors keep their specific messages.

### Fixed — Test Connection & Settings honor the configured API endpoint (#94)
- **New "API Endpoint" field** in Settings → Connection: `zoApiUrl` existed in storage (and was
  seeded by the e2e harness) but had no UI — self-hosted / overridden gateways were unconfigurable.
- **Test Connection now tests what you configured**: it posted to a hardcoded
  `https://api.zo.computer/zo/ask`, so a custom endpoint could never pass (QA finding B, P3).
  It now posts to the field's value (default unchanged) and error messages quote the actual URL
  tried. The model/persona dropdown loaders derive their `/models/available` +
  `/personas/available` URLs from the same origin. Reset-to-defaults clears the field.

### Fixed — `@` tabs and chip strip show page titles (#72)
- The `@` tab autocomplete and the tab-context chip strip rendered bare hostnames — with two
  `github.com` tabs open the entries were indistinguishable. Both now lead with the page title
  (host dimmed/secondary in the popup; host + full URL in tooltips).

### Fixed — skills picker (`/`) re-fetched on every open
- **Cache survives service-worker restarts (#73)**: the MV3 SW is killed after ~30s idle, which
  wiped the in-memory 5-min skills cache — the `/` picker showed "Loading skills…" on essentially
  every open. New `lib/sw-cache.js` (`createSessionCache()`) keeps the memory fast-path but backs
  the cache with `chrome.storage.session`, so it survives worker restarts; the vision model-catalog
  cache gets the same treatment (`cobrowse_skills_list` / `cobrowse_catalog_cache`).
- **Truncated listings are loud, not silent**: the skills bash listing now carries a
  `##SKILL_COUNT n` line, and a listing cut short by a server-side output cap surfaces an honest
  error ("truncated or unparseable — refresh to retry") instead of a silent empty list. When the
  workspace holds more skill folders than were listed (folders without a parseable SKILL.md head),
  the picker shows "+N more skill folders not listed — ⟳ refreshes."

### Added — `%` picker: hand Zo a whole FOLDER as context (#74)
- Directory rows in the `%` browser gained a **＋** affordance beside click-to-navigate: arming a
  folder rides its path in `## Referenced Files` (Zo lists/recurses server-side — the wire format
  was already paths-only). Folder chips render 📁 with a trailing slash; the section instruction
  line now teaches "files: read them; directories: list/recurse as needed."

### Fixed — theme consistency across surfaces (#65)
- **Live theme sync**: changing the theme in the sidepanel popover now updates an open Settings
  tab immediately (and vice versa) — both surfaces follow `storage.onChanged` for
  `cobrowse_theme` instead of only reading it at load.
- **Write-assist popover follows the theme**: the page-injected shadow-DOM widget now resolves
  `cobrowse_theme` (dark → dark widget; light/sepia/forest/ocean → light; system mirror follows
  `prefers-color-scheme`, live) via CSS custom properties + a `:host(.zo-wa-dark)` block — it no
  longer ships hardcoded light colors.

### Added — sticky DOM context toggle (#69)
- A **🧩 DOM** toggle now sits beside the 📷 Image toggle in the tab-strip row. When OFF, **no page
  DOM is ever attached** — `decideTurn` caps every turn to the URL/title pointer, whatever the Mode
  or context policy decided (including `!context`, which shows an inline note when capped). The
  setting is sticky (`storage.sync`, default on) and the tier chip / prompt inspector show the cap
  reason, so preview and send can't diverge.
- **Precedence**: an armed 📷 with the DOM off ships pixels as a **screenshot-only** turn — tier 0
  with just `## Screenshot` (`shotOnly` rides ASK_ZO; `buildPrompt` renders the section via
  `opts.screenshotOnly`). The tier-0 auto-active-tab reference (T1 excerpt) is also capped — OFF
  means URL/title pointer only. While capped, the policy state doesn't record the capture hash, so
  re-enabling re-attaches normally instead of trusting a "context already sent" that never went out.

### Fixed — tier-0 prompt bloat (#70)
- **Exactly ONE content-not-attached disclaimer per tier-0 turn**: Lean turns and
  read-downgraded turns stacked the generic honesty tail on top of a disclaimer already present
  in the prompt (~120 tokens of pure duplication every tier-0 turn). The generic tail is now
  suppressed when Lean's contract instructions or the read-downgrade short variant already
  disclaimed. `lean-pointer` eval cache refreshed live.

### Fixed — Model/Persona/Mode dropdowns open on mouse click in the side panel (#62)
- Native `<select>` popups don't open on mouse click inside the side-panel shell (a Chromium
  quirk invisible to our tab-based e2e — keyboard still worked). The three controls-bar dropdowns
  now render through a **select shim**: the native select stays in the DOM as the data source
  (every existing `change` listener, including Settings-override merging, untouched) while a
  custom trigger + popup — the same pattern as the `@`/`/`/`%` pickers — handles the interaction,
  with full keyboard support (↑/↓/Enter/Esc).

### Changed — page title folded into the header (#63)
- The standalone page-bar row (◈ + page title) cost a full vertical line. The title now lives in
  the header between the brand and the action buttons — truncating, with the full URL as tooltip —
  reclaiming one line of chat space. `#page-url` id and painting logic unchanged.

### Added — TTS voice picker (#64)
- Settings → Speech gains a **TTS Voice** dropdown (the speak path already passed `voiceName`
  from `zoTtsVoice` — there was just no way to set it). Populated from `chrome.tts.getVoices()`,
  filtered by the configured language prefix, "System default" when unset; re-filters when the
  language changes. Zero-voice systems (headless, minimal Linux) get an honest disabled state
  with a hint instead of an empty list.

### Added — debug mode + perf baseline (#67)
- Settings → **Debug & Diagnostics**: a toggle that turns on a metadata-only timing ring in the
  background (message hops, capture durations, stream durations — capped at 500 events) plus a
  **Copy diagnostics** export for bug reports. Privacy enforced in `lib/debug-log.js`: scalar
  extras only, strings truncated, never page text/prompts/tokens; disabling clears the buffer.
- `docs/qa/perf-baseline.md`: the evidence-first baseline — prompt/policy compute measured at
  microseconds (not worth optimizing), the real costs named (SW cold start, message hops, stream
  latency) with an on-device measurement recipe using the new instrument.

### Added — i18n scaffolding (#68)
- `chrome.i18n` is wired for future localization: `_locales/en/messages.json` (default locale),
  manifest `name`/`description` via `__MSG_` placeholders (strings byte-identical — asserted),
  a pure `lib/i18n.js` (`t()` + `applyI18nDom()` walking `data-i18n*` attributes), and a pilot
  set of sidepanel strings migrated. **Scope: UI strings only** — prompt templates stay English
  (they're LLM instructions, not user-facing text). CI guard test: every `data-i18n` key must
  resolve in every locale dir; message entries must carry translator descriptions.

### Added — prompt-bloat audit (#71)
- `bun scripts/prompt-audit/prompt-audit.ts` runs `describePrompt` across the mode × turn-shape
  matrix and writes **`docs/qa/prompt-bloat-audit.md`** — per-section token-cost tables. Findings:
  tier-0 duplication already fixed (#70); the next trim target is cross-mode instruction overlap
  (no-submit/no-secrets rules restated across persona/systemPrompt/instructions); elements/forms
  caps look right; tabs/skills/files sections are cheap; `approxTokens` overstates screenshot
  sections (base64 bills as image tokens, not text). Trims land only with before/after totals +
  an evals refresh.

### Added — test safety net + real-panel manual QA checklist (#66)
- **Coverage audit** (`docs/qa/coverage-audit.md`): a per-module line/branch snapshot of the
  suite with verdicts and the dark corners named (background SSE retry/reconnect, sidepanel
  render branches) — the basis for what this slate's tests cover.
- **Coverage report in CI**: `bun run test:coverage` runs on every push/PR and uploads an lcov
  artifact (advisory — no hard threshold while the bigger files are still climbing).
- **Real-panel manual QA checklist** (`docs/qa/manual-panel-checklist.md`): the structured
  release gate for the class of bugs automation structurally cannot see (the side-panel shell
  isn't CDP-drivable, so our e2e drives the panel as a tab — exhibit A: #62). Dropdowns,
  toggles, theming, pickers — each with the expected result spelled out.

## [0.2.5] — 2026-08-30

### Changed — mode surface rationalized (5 modes, leaner prompts)
- **Lean Mode 🪶 (URL-only, no page interaction)** — a new built-in Mode that
  sends only the URL + title (tier 0) and a fetch-it-yourself contract: Zo
  never sees the page, fetches the URL itself with its web tools when needed
  (and says so plainly when the page is inaccessible/geoblocked instead of
  guessing), never returns browser actions, and writes + cross-references
  notes when the request is note-shaped. Spec:
  `docs/superpowers/specs/2026-08-29-lean-mode-design.md`.
- **Mode lineup 6 → 5** — Summarize and Research merged into **Ask** (they
  were tier-1 readers differing only in query phrasing). Chats with them
  active migrate to Ask on load; `!summarize` / `!research` keep working in
  Ask; per-mode Settings overrides migrate onto Ask only when Ask had none.
- **Tier-0 honesty in every prompt** — turns that attach only the URL/title no
  longer claim "using the page content provided"; the tail now says content
  was not attached and licenses Zo to fetch the URL itself (or `read_page` on
  action-mode follow-ups). Applies to all modes on tier-0 turns.
- **Bang aliases trimmed** — `!qa` (use `!ask`) and `!dom`/`!ctx` (use
  `!context`) removed; `!help` now lists the full, accurate canonical set.
- **Quick-action chips fixed** — chips now send their stored prompt (the
  click handler previously sent the display label and ignored `prompt`), and
  the defaults are cut to two non-duplicative entries (Fill forms with test
  data, Extract links); custom chips in Options are untouched.
### Added — typed-schema coverage completed
- Every module in `extension/lib/` now has a Zod contract under `tests/schemas/`:
  five new schema files (parse-output, mcp, vision, intent, zo-prompts) cover the
  Zo response parser's channel triple, the MCP JSON-RPC envelopes, the live
  `/models/catalog` entries + vision-gate outputs, the intent classification,
  and the generate-mode reply (external Zo data). Schema-conformance blocks were
  wired into the corresponding test files; the runtime stays plain JS by design.

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
