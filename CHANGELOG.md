# Changelog

All notable changes to Zo Co-browse are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project uses [Semantic Versioning](https://semver.org/).
## [Unreleased]

## [0.2.7.1] — 2026-09-05

### Fixed — stabilization round (2026-09-05 end-to-end pass)
- **Esc-to-stop works anywhere in the panel (#133).** The "Press Esc to stop"
  gesture previously only fired while the composer was focused; focus leaves
  the composer in common flows (clicking a message, a chat tab, a footer).
  Esc now cancels the in-flight stream from the panel level; autocomplete
  popups consume Esc first (closing the popup never cancels the stream).
- **Chat-tab streaming dot is background-only (#135).** The pulsing dot now
  marks only background chats that are still generating — it no longer
  renders on the tab the user is already watching.
- **Handoff done no longer repeats the digest (#138).** The run-completion
  status line is compact (`✅ Handoff done`); the deliverable renders once,
  as the turn's answer. Previously the full done() response (with raw
  markdown headings) rendered a second time inside the status line.
- **"Fill 1 fields" → "Fill 1 field" (#139).** Singular/plural fixed on the
  form-review confirm button and the fill_form timeline card meta.

### Added — regression coverage promoted from the stabilization pass (#137)
- Four new e2e specs: `19-error-paths` (Esc cancel incl. focus-outside, 401
  error card, failed-action UX, conversation threading), `20-chat-tabs-parking`
  (streams survive switches; backgrounded actions park — page untouched until
  Run All), `21-history-ops` (rename / export download / delete incl. the
  active chat), `22-bang-commands` (`!summarize`, `!context`, `!handoff` stop,
  digest-renders-once). Mock Zo server gained `unauthorized` (401) and
  `fill-slow` (slow fill envelope) scenarios.
- Drift: Zo pruned its MCP catalog 93→79 tools (removed `use_integration` et
  al.); baselines re-pinned (#136) and the snapshot floor test loosened
  accordingly (the required-tools loop is the real gate).

## [0.2.7] — 2026-09-02

### Changed — Lane B: cold-start lazy-import trim measured and rejected (2b)
- **Micro-bench verdict: no-op by the evidence rule.** The whole SW module graph
  (background.js + all lib/, ~260KB) evaluates in **~10–18ms** (fresh-subprocess samples,
  `scripts/bench-cold-start.ts`) — real cold-start cost is worker-spawn + first-connection
  overhead, which lazy imports can't touch. Lazy-loading surgery would save single-digit ms
  at best, so 2b closes as a documented no-op (numbers in `perf-baseline.md`).
- **2a/2c remain evidence-gated** on the owner's on-device diagnostics export (recipe in
  `perf-baseline.md`), now analyzable thanks to the 2-0 trace correlation.
### Added — observability: per-turn trace correlation in diagnostics (Lane B 2-0)
- **Every diagnostics entry is now trace-tagged**: the background stamps a `traceId`
  (`turn-<sessionId>[:<chatId>]` for streams, `exec:<target>` for action batches) onto
  `lib/debug-log.js` entries, so a "Copy diagnostics" export groups into per-turn timelines
  instead of a flat hop list — the instrument the Lane B perf measurements run on.
- **SW startup is measured**: the worker's script-eval duration (`startup · worker-eval`) is
  recorded once debug mode resolves — the cold-start compute the #67 baseline names as the
  dominant cost.
- Exports are versioned (`version: 2`); the metadata-only privacy contract is unchanged.
  Panel chunk-paint spans land with item 2c, only on evidence.
### Changed — prompt trim: #26 safety rules stated once, not twice (Lane A)
- **One shared rule block**: the no-secrets / never-click-after-fill rules used to ride TWICE on
  every action turn — once at the end of the action schema and again inside cobrowse's
  instructions. They now live once in `lib/prompt.js#SHARED_SAFETY_RULES` and compose a single
  time. Measured (audit fixture, pre-trim worktree vs post-trim): **−42 to −43 tokens on every
  cobrowse action turn** (~10% of a tier-0 action tail); read turns and all other modes
  byte-identical.
- **Evals refreshed live** (19/19 green; cobrowse action cases re-fetched). New `EVALS_MODEL`
  env pins a live-catalog model for refreshes when Zo's server-default model is disabled
  upstream (which it was — `qwen3.8-max-free` 503 `model_not_found` at refresh time).
- Guard tests now assert the schema/instructions do NOT restate the rules and that
  `buildPrompt` composes them exactly once per action turn (zero times on read turns).
### Added — streaming-reasoning probe: incremental thinking live-verified (#110)
- **`tests/test-prompts/probe-streaming-reasoning.ts`** — live SSE probe (event-shape timeline +
  reasoning-key classification, per-model verdict) answering the open question: reasoning
  **does stream incrementally** (GLM53F: 894 thinking-delta events long before the terminal),
  and the panel's existing `STREAM_REASONING` path consumes it. No new implementation was
  needed — the item closes as verified-by-probe (findings in `QA_REPORT.md`). Bonus finding:
  `zo:openai/gpt-5.6-sol` is disabled upstream.
### Fixed — stale-build guard: extension updates refresh open tabs (#109)
- **Kills the "still broken after reload" loop**: after an extension update, open tabs kept
  running the OLD content script until they navigated. The background now re-injects the fresh
  `content.js` into open http(s) tabs on `onInstalled(update)`, and the panel shows a one-time
  dismissible "Extension updated" banner.
- **`content.js` is injection-idempotent**: a window-level guard flag makes re-injection a no-op
  (no double-bound listeners, no duplicate write-assist widget) — verified by test.
### Added — chat export: download a conversation as Markdown (#108)
- **⬇ Export on every history card**: serializes the conversation to a clean Markdown
  transcript — title header, role-labeled turns with timestamps, the 💭 reasoning as a
  blockquote, context-tier chip and duration on Zo turns — and downloads it as
  `zo-chat-<slug>-<date>.md`. System/error rows are omitted; it's the conversation a reader
  wants, not a debug log.
- Pure serializer in `lib/export.js` (schema + unit tests); the panel only triggers the Blob
  download — no new message types.
### Added — handoff polish: badge marker, finish notifications, changelog-drift gate (#103)
- **▶ extension badge while a handoff run is live** — visible even with the panel closed;
  cleared when no run is active.
- **One-shot `chrome.notifications` on handoff done/blocked** ("the point of delegating is
  walking away") with the goal + stop reason; paused/aborted stay panel-only (new
  `notifications` permission).
- **`bun run lint` now fails on docs-changelog drift**: `scripts/sync-changelog.ts --check`
  verifies the docs-site `[Unreleased]` mirror matches root `CHANGELOG.md` (the mirror had
  silently gone empty once); `bun scripts/sync-changelog.ts` re-syncs it.
### Added — `!handoff`: delegate a goal to Zo as an unattended run (#102)
- **`!handoff <goal>`** starts a read-only handoff run from the panel: Zo works the pages
  unattended (navigate/extract/scroll), the panel executes each turn's actions as one batch,
  and the background chains turns until Zo reports the digest via `done()` — budget-capped,
  boundary-parked, stoppable via the ✕ on the live progress line.
- **Chained-turn adoption**: the loop re-enters the stream with derived sessionIds
  (`<base>-h<n>-…`); the panel adopts descendants of its own sent turn instead of dropping
  them as stale, so the whole run renders live in the run's chat tab.
- The run's state pushes (`HANDOFF_UPDATE`) render a compact progress line (pages · turns ·
  parked · minutes) and an honest end card — ✅ done / ⏸️ paused (with reason) / 🛑 stopped.
### Added — handoff run loop: the background half of delegate-mode runs (#101)
- **`HANDOFF_START` / `HANDOFF_STOP` / `HANDOFF_STATUS`** message types (message-contract test
  enforced) + a **`HANDOFF_UPDATE`** background→panel push (declared in a new
  `BACKGROUND_PUSH_TYPES` schema list — pushes get no router case by design).
- **The loop is event-driven, never SW-resident**: each turn's `EXECUTE_ACTIONS` completion
  re-enters `askZoStream` with a continuation turn (progress report + budget line from
  `lib/handoff.js`) and a fresh capture of the driven tab. Run state persists in
  `storage.session` (`cobrowse_handoff_runs`); an MV3 service-worker restart pauses the run
  ("extension restarted — resume to continue") instead of stranding it. `done()` completes;
  budget exhaustion and mid-run failures pause honestly.
- **Boundary enforcement in the executor**: under a run's boundary mode, interactive actions
  (click/fill) are refused *before execution* and parked into the run's park log
  (`handoffParked` results) — parking never stops sibling actions. 0.2.7 runs are `readonly`.
### Changed — version/docs hygiene (#96)
- **`package.json` version mirrors the extension manifest** (was `0.1.0` while the manifest said
  `0.2.5`); `bun run lint` now **fails on drift** between the two files, so the release-prep rule
  ("bump both together") is self-enforcing.
- **`docs/roadmap.md` is a pointer, not a snapshot** — its hand-maintained status claimed v0.2.0
  was current; it now points at the authoritative `BACKLOG.md` / `CHANGELOG.md`.
- **The docs-site changelog mirror is re-synced** — its `[Unreleased]` section had been left empty
  while root `CHANGELOG.md` accumulated the 0.2.6 slate.
- **`STREAM_RECONNECT_DONE` is live**: the sidepanel's handler case existed but nothing posted it;
  the background now sends it after a successful retried attempt (completes the #95 dead-code sweep).
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

## [0.2.6] — 2026-08-30

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

### Fixed — vision gate never matched the live catalog (#25 follow-up)
- **`lib/vision.js#findModelEntry` now matches `value`-keyed entries** —
  `/models/catalog` keys models on `value` (e.g. `zo:openai/gpt-5.6-sol`) and
  carries no `model_name`, so the vision gate previously never matched any
  entry and always fell back to 'unknown' (capturing regardless). Also
  `visionModelSuggestion` now reports the `value` identifier when
  `model_name` is absent.
- **`visual-describe` prompt eval actually tests the screenshot now** — the
  case set `ctx.screenshot` instead of `ctx.screenshotDataUrl`, so the
  `## Screenshot` section never rendered; cache refreshed against a live run.

### Verified — screenshot transport reaches vision models (#25 live probe)
- **The tier-3 screenshot pipeline is confirmed working end-to-end**: the
  markdown data-URL embed inside the string-only `/zo/ask` `input` is
  extracted by Zo's backend and passed to vision models. Live probe
  (`tests/test-prompts/probe-vision.ts`) with shape/color fixtures at
  26KB–589KB (up to 825K chars of base64): models named all shapes/colors and
  contradicted conflicting text context; no size ceiling found. API facts
  recorded in `extension/AGENTS.md`; findings in BACKLOG #25 and the
  2026-08-29 vision-transport design spec. (test(vision): live probe proves the screenshot embed transport works (#25))

## [v0.2.0] - 2026-08-28

Form filling (#26) — the co-browse contract: **Zo fills, you review and
submit.** Everything in this release was driven against live target forms
(a Typeform application, a RoboForm 30-field test page) rather than invented
fixtures, so "any form" is the actual test bar.

### Added — batch fill_form + confirm-before-fill (#26)
- **`fill_form {values:[{target,value}]}`** — one action, N fields, resolved
  by human-facing cues (label text → aria-label/labelledby → placeholder →
  name/id → optional CSS selector passthrough) in the content script and the
  executeScript fallback; one timeline card with per-field ✓/✗.
- **Two-phase sensitivity gate** — before any fill batch executes, the
  background re-captures the LIVE form (`get_form` shape) and runs
  `lib/formfill.js#isSensitiveForm` (password/card/CVV/expiry/identity fields
  or login/checkout/payment/account URLs; never the model's self-assessment).
  Sensitive → the fill **parks** behind an editable review card: one row per
  field, secret rows "left for you 🔑" with proposed values never round-tripped
  (stripped again on confirm), user edits values, then Fill / Cancel. Benign
  forms execute immediately; a batch-level pre-flight keeps it to one capture
  and one card per page regardless of how many fill actions the model emits.
- **Submit backstop** — on pages the gate flags, clicks on a form's
  submit/pay control are refused (armed for click-only batches too); the
  prompt rules say the same thing: fill, then `done` — never auto-submit on
  ANY form, not just sensitive ones.
- **Normal responses for action turns** — the raw action-JSON envelope never
  renders as chat prose: while streaming, a "_Preparing actions…_" placeholder
  shows (guard now tests the accumulated stream text, so multi-delta envelopes
  can't leak chunk-by-chunk); at completion the bubble renders Zo's `done`
  response as normal markdown above the action timeline.

### Added — works on builder-style forms (the "any form" round)
- **Question-aware capture**: every captured field carries its question text
  (`formFields[].question`) on all three capture paths — explicit label/aria
  first, then the title-above-field convention live-probed on Typeform (plain
  div, input wrapper's previous sibling). `compactForm` renders it into the
  prompt and the `get_form` pull: `[input#uuid type=text "Type your answer
  here..."] — First name*`.
- **Question-scoped resolution** (`resolveByQuestion`): fill targets match
  question text (normalized: case, whitespace, trailing `*`/`:`) and resolve
  to the field under that title — forms where every input shares one
  placeholder and carries no label/name now fill correctly.
- **Viewport preference** (`pickVisible`): equal cues resolve to the field the
  user can see — the current section of a one-question-per-screen form.
- **Section-by-section pacing**: on multi-screen forms Zo fills only the
  visible section per turn and stops; the user reviews, advances themselves,
  and asks Zo to continue.
- **Select fills by visible option text**: Zo sends "Visa (Preferred)"; the
  executors fall back to text matching when the value attribute doesn't match.

### Fixed — live-form hardening
- Playwright-style `:has-text()`/`:text()` selectors in click actions resolve
  by button/link text instead of throwing `querySelector` SyntaxErrors.
- Zo's occasionally-invalid action JSON (unescaped double quotes inside CSS
  attribute selectors — `input[name="\30 x"]`) is repaired in a parse
  fallback instead of degrading the whole envelope to plain-text chat.
- Key-first action shapes (`{"fill":{...}}`) normalize alongside `type`-first.
- Secrets proposed by the model despite the prompt rule are stripped from the
  confirmed batch (live-observed; the review card's "left for you" is now
  enforced, not just displayed).
- **After a fill, Zo never clicks ANY action button** (submit/OK/Next/
  Continue/Create… — every page, not just sensitive ones): prompt rule plus a
  hard per-page backstop that blocks button-ish clicks on the last-filled page
  (links stay clickable; the block clears on navigation). The tab-strip
  Open-all race (a stale tabs snapshot could repaint mid-open under load) is
  fixed with a sequence guard on the tab query.

### Docs / planning
- 0.2.0 planning suite: competitive analysis (Comet/Dia/Operator/Fellou/
  Atlas), design specs + implementation plans for #26 form-fill, #19
  multi-tab contexts, #10 cross-tab actions, #29 page monitoring.

### Tests / QA
- **Suite: 891 tests / 0 fail (39 files, 2356 expect calls) + 24 Playwright
  E2E tests across 14 spec files (2 demo-gated).** New e2e coverage:
  sensitive-checkout review card (park → edit → confirm, secrets untouched),
  builder-style any-form (question targeting + pacing), RoboForm-class
  classic form (digit-leading names, broken JSON repair, gate → review →
  fill → select-by-text → no submit), and multi-delta envelope streaming
  (normal prose response, zero JSON in chat).
- Demo recordings: `demo-fill-form` (review card → edit → confirm, panel +
  page stitched) joins `demo-open-all` (both `ZO_DEMO=1`-gated).

## [v0.1.0] - 2026-08-19

First minor bump: everything since v0.0.2 — chat tabs, cold-start research
with "Open all", the context-on-demand pull protocol, vision-gated
screenshots, composer reference pickers, and a hardened streaming failure path.

### Fixed — server-side stream failures now surface the real error
- **`failed` terminal event** (live-verified 2026-08-19): when a Zo run fails
  server-side (e.g. "Unknown model: …"), the API returns **HTTP 200 + SSE**
  and terminates with `event: failed` `{status, error, error_type,
  failure_kind}` — an event the stream loop didn't handle. The error payload
  was dropped and the turn finished empty ("Zo returned an empty response…").
  Both `failed` and a `completed` payload reporting `status:"failed"` now
  surface as a proper error card with the real server message + Retry.
- The empty-response hint previously pointed at a console log that didn't
  exist; it now lists the SSE events actually received (from the
  stream-shape diagnostic) and the real log tag.

### Tests / QA
- `e2e/09-open-all.spec.ts` — the #27 link-chips + "Open all" flow verified
  end-to-end in real Chromium (card contract, first-tab-foreground open,
  opened tabs auto-referenced `(3/4)` in the strip, single-chip foreground
  open), plus a `ZO_DEMO=1`-gated demo-recording spec producing
  `demo/open-all-demo.mp4`.
- CI: Playwright browser binaries cached (`actions/cache` keyed on
  `bun.lock`) — cold install 2m10s → ~15s on hit; the e2e job no longer runs
  duplicate push+PR events (PRs into `main`/`dev`, protected-branch pushes,
  and manual dispatch only); 15-min job timeout guard.
- **Suite: 855 tests / 0 fail (37 files, 2234 expect calls) + 19 Playwright
  E2E tests across 10 spec files (1 demo-gated).**

### Added — #28 Composer reference pickers: `/` skills + `%` Zo files

- **`/` skills picker** — typing `/` at a token start opens a filterable popup
  of your Zo skills, enumerated from `/home/workspace/Skills` over Zo's MCP
  server (`api.zo.computer/mcp`, the same saved token). Each skill folder's
  `SKILL.md` head supplies the label + description. Selecting arms a ⚡ chip;
  on send, a `## Skills to Run` prompt section tells Zo to read each skill's
  SKILL.md server-side and run it as part of the turn.
- **`%` files picker** — typing `%` opens a workspace browser (dirs navigate,
  `⬆ ..` climbs, files attach) backed by validated `ls -1F` MCP calls.
  Picked files ride as a paths-only `## Referenced Files` manifest; Zo
  resolves content with its own file tools.
- **Send-once chips** — picked skills/files render as chips above the
  composer and as mention pills on the sent message; they attach to exactly
  one turn, then clear (a skill is an invocation, not a sticky setting).
  Both sections preview live in the prompt inspector.
- **`lib/mcp.js` + `lib/pickers.js`** — pure MCP JSON-RPC envelope/response
  parsing and picker logic (path confinement to `/home/workspace` with
  traversal rejection before any request, single-quote shell hardening,
  Python-repr `CmdResult` parsing between `__ZO_BEGIN__`/`__ZO_END__`
  markers, SKILL.md frontmatter parsing). Two new message types:
  `LIST_SKILLS` (5-min cache) and `LIST_WORKSPACE_DIR` (60-s per-path cache).
- **MCP facts** (live-verified): server `zo-tools v1.0.0`, 96 tools,
  initialize → `mcp-session-id` header → tools/call; `list_directory`
  recurses + truncates at 1000 entries, so the pickers use `bash` with
  deterministic commands instead.

### Tests (#28)
- `tests/pickers.test.ts` (34) + `tests/schemas/pickers.ts`; integration
  `tests/integration/mcp-flow.test.ts` (session handshake, caching, traversal
  rejection, prompt threading); e2e `e2e/08-pickers.spec.ts` + a mock `/mcp`
  route in `e2e/mock-zo/server.mjs`.
- **Suite: 853 tests / 0 fail (37 files, 2228 expect calls) + 17 Playwright E2E specs.**

### Added — #24 Context-on-demand (pull protocol)

- **Three new context-only actions** — `read_page`, `get_dom`, `get_form`. When
  Zo needs the complete version of the current page's context (full page text
  ~12k chars, the complete interactive-element map, or every form field), it
  emits a pull action instead of guessing from the budget-sliced prompt
  excerpt. The extension captures the requested context and auto-sends it back
  into the conversation as a `## Auto-fetched:` follow-up turn, then Zo continues
  with it. All inside the same stream, before STREAM_DONE.
- **`lib/pull.js`** — the generalized pull mechanism: `extractPullRequests()`,
  `buildPullFollowUp()` (with compact `read_page` / `get_dom` / `get_form`
  serializers + render caps), `pullHash()` (send-once per `kind:page-hash` —
  re-asking an unchanged page returns "already provided above"), and
  `pullTier()`/`pullCaptureOpts()` (capture-shape hints threaded through
  `getActiveTabContext` → `CAPTURE_CONTEXT`).
- **`finishStreamWithPullLoop`** — generalizes the `read_tab` follow-up loop to
  all four pull kinds. Shares the same 3-cycle budget (`MAX_PULL_CYCLES` =
  `MAX_READ_TAB_CYCLES`) so a single user turn can mix reads and pulls without
  runaway round-trips. A tool-trace card (`emitPullTrace` on `STREAM_TOOL`)
  renders the pull in the live bubble.
- **`CONTEXT_ACTION_NAMES` + `isContextAction`** — single source of truth for
  "context-only, never reaches `executeDomAction`". Applied at every executor
  gate (background `EXECUTE_ACTIONS`, sidepanel `STREAM_DONE` + pending-actions
  filter). This also closes a latent bug where a canonical `{type:'read_tab',
  ref:'T1'}` from Zo was silently dropped by `normalizeActions` (it survived
  only in key-first form).

### Changed
- **Capture caps respond to pull hints** — `captureContext(tier, {pull})` and
  `getActiveTabContext(tabId, tier, modeId, {pull})` raise the text budget
  (`read_page`) and element caps (`get_dom`, `get_form`) only on demand;
  normal prompt capture keeps its 30-field / 50-clickable / 8k-char budget.

### Tests
- `tests/pull.test.ts` (16 tests) + `tests/schemas/pull.ts` (protocol schemas
  for `PullRequest`, `FollowUp`, `PullCapture`). Updated
  `tests/schemas/actions.ts` with `ReadPageAction` / `GetDomAction` /
  `GetFormAction` (now 11 action types). Integration: a full
  sidepanel↔background↔content round-trip asserts the loop fires inside the
  stream and `get_form` never reaches the DOM executor. E2E: `e2e/07-pull.spec.ts`
  runs the round-trip in a real Chromium against the mock Zo server.
- **Suite: 814 tests / 0 fail (35 files, 2105 expect calls) + 16 Playwright E2E specs.**

### Added — #25 Vision-gated screenshots

- **`lib/vision.js`** — the vision gate: tier-3 screenshot capture now checks
  `/models/catalog`'s `supports_images` for the selected model. A known
  non-vision model skips the `captureVisibleTab` round-trip and the base64
  data-URL prompt bloat (pure token waste); unknown support keeps capturing
  (backward-compatible — tier 3 worked before this gate existed). Pure
  functions: `findModelEntry`, `modelVisionSupport`, `shouldCaptureScreenshot`,
  `catalogIsStale` (5-min TTL), `visionModelSuggestion`.
- **`fetchModelCatalog()` + `GET_VISION_CATALOG`** — the background fetches the
  no-auth model catalog, caches it for 5 min (in-flight dedup), and serves it
  to the sidepanel for the suggestion UI.
- **Visual-mode suggestion** — picking Visual mode with a known non-vision
  model surfaces a system message suggesting a vision-capable model from the
  catalog (or a warning when none exists).
- **Mode hot-reload fix** — the sidepanel now syncs `activeModeId` when
  `zoActiveMode` changes in storage (another tab's mode change previously
  didn't reflect until reload).

### Tests (#25)
- `tests/vision.test.ts` (21 unit tests) + 2 integration round-trips
  (gate suppresses capture for `supports_images:false`; captures for `:true`).
- Mock Zo server serves `/models/catalog` with `supports_images` per model.
- **Suite: 814 tests / 0 fail (35 files, 2105 expect calls) + 16 Playwright E2E specs.**

### Added — #27 Cold-start + research → "Open all" tabs
- **Blank/new-tab pages skip page context entirely** — asking Zo from
  `chrome://newtab` no longer attaches the CDP debugger (no debug banner),
  no longer renders a `## Page — URL: chrome://newtab/` prompt section, and
  no longer hard-blocks the send when capture fails. Every turn on a blank
  tab is a clean cold start (`isBlankPage`/`pageBlank`).
- **Link-chips card + `Open all (N)`** — a prose answer containing ≥2 unique
  http(s) links renders a `🔗 N links` card under the assistant bubble (one
  host-labelled chip per URL, cap 10). `Open all` opens the first link in
  the foreground and the rest in background tabs, then auto-adds every
  opened tab to the active chat's referenced-tabs strip — so `read_tab`
  follow-ups on Zo's own sources work in one click.

### Added — Chat tabs + chat management
- **Chat tab bar** — several conversations open at once in the sidepanel
  (≤8, LRU eviction), ✕/middle-click close with a last-tab guard, and a
  pulsing dot marks a backgrounded chat that is still streaming.
- **Per-chat Zo threads** — each conversation carries its own
  `zoThreadId`; the ambient thread stays for context-menu/omnibox callers.
- **Streams survive tab switches** — chunks for a backgrounded chat
  accumulate into its own conversation; its actions park as
  `pendingActions` (never auto-run against a page you aren't watching) and
  restore when you switch back.
- **History view** — list/switch/delete conversations with live search and
  inline rename (✎).

## [v0.0.2] - 2026-08-10

Stable release: streaming stability + conversation-experience work promoted
from `dev` (PR #18) with the VitePress docs site (PR #19). Suite: **534 tests /
0 fail** (24 files, 1381 expect calls).

### Added
- **Repo maintenance rules + git-flow model** — formalized a `dev` (integration)
  → `main` (release) branching model with branch protection on both: no direct
  pushes, CI must be green to merge. CI now gates PRs into `dev` as well as
  `main`. Feature/fix/chore branches flow into `dev`, which promotes to `main`
  via PR. Releases remain deliberate (`git tag vX.Y.Z` triggers `release.yml`).
  Documented in `CONTRIBUTING.md` § "Branching model" and `AGENTS.md`.
- **Thinking/reasoning bubble** — `reasoning` returned by Zo surfaces as a
  collapsible "💭 Thinking" bubble above the assistant message, persisted with the
  message and re-rendered from history. (no-op when the backend sends none)
- **zo.computer-style chat UI** — read-only modes (`ask`/`research`/`summarize`/
  `extract`/`visual`) stream **plain markdown** instead of forcing the
  `{reasoning,actions}` JSON envelope, so thinking and answer render as separate
  blocks (fixes the raw-JSON-in-chat bug). Only `cobrowse` keeps the JSON action
  protocol.
- **Inline grouped action timeline** — DOM actions render as a grouped, sticky
  timeline with per-action status (pending → running → done).
- **Reset-to-defaults** in the options page (clears sync + local config).
- **Mode system unification** — `ACTION_SCHEMA_COMPACT` requests only
  `{"actions":[...]}`; lite vs full context tiers stay consistent.
- **Loop-engineering tooling** — `bun run verify` (tests + release checks +
  per-entry transpile) and a committed **hard-gate pre-commit hook** (`bun run
  setup-hooks` to install; `git commit --no-verify` to bypass).
- **CI/CD backbone** — CI now runs on every branch push + PR to `main` (tests,
  transpile check, release checks, package artifact); a dormant tag-triggered
  `Release` workflow is ready to publish `v*` releases with the extension zip.

### Changed
- Streaming path hardened end-to-end: `sessionId` echoed on every `STREAM_*`
  message, stale-port `safePost()` no-throw, retries gated to transient errors
  (`isRetriableStreamError`), 60s thinking-indicator liveness timeout, no silent
  `fullText` clobbering, `STREAM_DONE` normalized to canonical `responseText`.
- Top region of the panel is sticky — only `#messages` scrolls.
- Removed dead duplicate `sendQuery`; action loop snapshots pending actions
  against the Skip race.

### Fixed
- **P0**: `addSystemMessage` XSS + markdown bypass + DOM thrash; context-menu
  crash (`pageContext` ReferenceError); Lite persona dropdown permanently empty;
  `enabledMenus` key mismatch hiding "Fill this field".
- **P1**: streaming port disconnect lifecycle, late-DONE cross-query rendering,
  `enabledMenus` not loaded on service-worker startup, missing `navigate`/`done`
  cases in content.js, wrong keyboard-shortcut docs (options.html).
- **P2**: `fullText` overwritten by final payload, `captureVisibleTab`
  undefined window, NAVIGATE undefined tabId, `testConnection` casing,
  hardcoded API hosts, orphan storage keys, sandbox `'unsafe-eval'` CSP,
  `zoTtsRate` stored as string.
- **P3**: `addMessage('bot')` markdown bypass, unstyled action timeline/DuckDB
  tables, badge showing `undefined` persona, dead action handler, uncaught
  `storage.session.set` promise.
- Persisted history that showed raw JSON blobs is healed on load; key-first
  actions are normalized so reasoning bubbles + done text render.

### Tests / QA
- Suite grown from 81 → **534 tests / 0 fail** (24 files, 1381 expect calls).
- New test files: `action-timeline`, `normalize-actions`, `css-layout`,
  `sse-parsing`, `strict-module`, plus options/reset and shortcut-docs coverage.
- Full P0–P3 audit round closed — see `QA_REPORT.md` for the remediation log.

---
*Pre-tag history (initial MV3 extension + first-round features: side panel,
context menu, keyboard shortcuts, bang commands, screenshots, DuckDB, skills,
automations, save-page, onboarding, presets, themes, omnibox, relay) is inline
in the git history; versioned sections begin at the first tagged release.*

[v0.0.2]: https://github.com/CCAgentOrg/zo-cobrowse/compare/v0.0.1-alpha...v0.0.2
