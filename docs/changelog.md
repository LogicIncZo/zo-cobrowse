# Changelog

The full, versioned history lives in the repo's
[CHANGELOG.md](https://github.com/LogicIncZo/zo-cobrowse/blob/dev/CHANGELOG.md).
This page mirrors everything **unreleased** on `dev`.

## Unreleased

_Nothing unreleased — the latest is [0.3.6.2](#changelog-v0362)._

## [0.3.6.2] — 2026-09-26 {#changelog-v0362}

### Fixed

- **Diagnostics share transport (v0.3.6.1 follow-up).** dpaste.com rejected
  the upload (HTTP 400) because the form body went out without the
  urlencoded content-type header — now sent. The dead 0x0.st fallback is
  replaced with paste.debian.net (anonymous JSON API, 24-hour expiry,
  pastes hidden by default). Both hosts live-verified.

## [0.3.6.1] — 2026-09-26 {#changelog-v0361}

### Fixed

- **Navigate actions now actually navigate.** The sidepanel's direct NAVIGATE
  path (a `navigate` action outside handoff/recipe flows) has been dead since
  the first commit: the panel sent no `tabId`, the background could not infer
  one (the panel is an extension page — no `sender.tab`), and the rejection
  was swallowed while the panel still rendered Zo's "Navigated…" done text.
  Now the panel sends the capture's source `tabId`, the background falls back
  to the active non-extension tab when it is absent, and a failed navigation
  renders a persisted error line instead of the done-response lie.
  Regression-tested end-to-end (`e2e/03-actions.spec.ts`).

### Added

- **User-triggered diagnostics sharing (Settings → Features → Debug).** Next
  to 📋 Copy diagnostics there is now 🔗 Share diagnostics (24h link): one
  click composes the anonymous, metadata-only bundle (`lib/debug-share.js` —
  debug ring + settings allowlist only; page text, prompts, tokens, browsed
  URLs, conversation ids, and identifying config never included) and uploads
  it to dpaste.com (fallback 0x0.st) with a 24-hour auto-expiry and copies
  the link. Nothing is sent unless you click; hosts need no account/auth.
- **Observability: navigation and Jev now leave evidence.** With Debug mode
  on, the diagnostics ring records every NAVIGATE outcome, each Jev hook
  invocation (`pick` / `resolve-pick` / `done-gate` — served or refused,
  confidence, latency), and diagnostics shares.
- **Accessibility round 2 (bash).** Ledger round 2 in
  `docs/qa/accessibility-review.md` (#13–#18, all fixed in-round): the
  write-assist widget's shadow-DOM controls now show a per-theme focus ring
  (the page ring can't cross the shadow boundary); a backgrounded chat that
  is still generating states "— generating…" in the tab's accessible name
  instead of a color-only pulse; history-card glyph buttons and the rename
  input carry explicit accessible names; the per-turn context-tier chip
  announces its decision + reason; `.btn-sm` floored to the 24px hit-target.

## [0.3.4.3] — 2026-09-22

### Fixed — !handoff bug bash (#368–#372, PRs #373–#377)

Second owner-directed 0.3.4 stabilization round, over the Lane E delegate loop (evidence: `tests/test-prompts/probe-handoff-bash.ts`).

- **Prose-only turns no longer strand the run (#368, PR #373)** — blocked with the prose as the reason; ▶ Resume continues.
- **Resumed runs re-prime with full context (#369, PR #374)** — no more tier-0 crawl on the resume path (#351 class).
- **One live run per chat (#370, PR #375)** — a second `!handoff` refuses, mirroring compose.
- **No Jev click machinery on readonly runs (#371, PR #376)** — prompt vocabulary + executor pick calls suppressed run-scoped.
- **Orphan sweep clears the ▶ badge (#372, PR #377)**.

## [0.3.4.2] — 2026-09-22

### Fixed — prompt-efficiency bug bash (#355–#358, PRs #359–#362)

Owner-directed bash over every prompt the extension sends to `/zo/ask` (evidence harness: `tests/test-prompts/probe-bloat-0342.ts`).

- **Jev-Assisted block gated on the post-downgrade decision (#355, PR #359)** — no dead 148-token action block on read-downgraded Co-browse turns.
- **Visual mode drops the tier-2 selector lists (#356, PR #360)** — `domSections` knob omits ~1.3k dead Elements/Forms tokens from read-only screenshot turns.
- **Jev-Assisted block tightened 148→123 tokens (#357, PR #361)** — guardrails test-pinned.
- **One-shot workspace-write prompt deduped (#358, PR #362)** — three inline copies → `buildWorkspaceWritePrompt()`; byte-identical, anti-drift tested.

Evals: `visual-describe` cache refreshed live (PR #363); 24/24.

## [0.3.4.1] — 2026-09-22

### Fixed — compose creator stabilization 1 (#351, PR #352)

Diagnosed from a real `!recipe compose file an RTI` run (4.3-minute turn at tier 0): the sticky DOM toggle capped the compose priming turn to a URL-only pointer, Zo drove blind — fetching pages itself, reading the protocol skill via `read_file` (came back polluted with workspace index content), and reconstructing the action grammar from repo scrapes. The compose bang also double-added the user bubble.

- **Run-priming turns bypass the sticky DOM cap** — compose and handoff priming sends attach the Mode's full context regardless of the toggle; the prompt inspector mirrors it (preview parity). Manual chats keep the cap — token discipline stays the user's call.
- **Compose turns keep the FULL action tail** (`noSlimTail`) — no slim "go read the skill" pointer, so a polluted/failed workspace read mid-compose can't happen; the grammar rides in-prompt. Panel preview mirrors.
- **Single user bubble** for the compose bang (the standard send path already renders it).
- **Compose continuations clamp capture to tier ≥ 2** — parks and cue re-planning always see elements + forms.

Tests: 1519 unit/integration across 64 files; e2e gate added (`e2e/27-recipe-compose.spec.ts`: DOM off + compose → the priming ask carries `## Elements`, one user bubble).

## [0.3.4.0] — 2026-09-21

### Added — Jev support + settings rationalization (0.3.4 slate: #339–#343, PRs #344–#348)

Five lanes from the 2026-09-20 owner intake, planned on a live comparative probe (Jev 340–512 ms vs Zo 15–36 s per decision, 40–74×, 4/4 agreement) and shipped one full zo-loop cycle per lane; milestone `0.3.4` drained. Stabilization ships as `0.3.4.N` points on bug reports.

- **Settings: Zo username + token (#339, PR #344).** The Connection pane asks exactly two things — your Zo username slug and your access token; `deriveZoHosts()` fills the Zo.space endpoint and Zo web origin live (hand-edited Advanced values win, override-not-rewrite). The three endpoint fields moved into a collapsed Advanced section, and the owner-specific default space endpoint is GONE — fresh profiles get none, and space-backed features say so instead of silently querying someone else's tenant.
- **One save (#340, PR #345).** Exactly one Save Settings — sticky at the form end, visible from every tab, carrying the dirty marker. The duplicate in-card submit and the Prompts editor's scoped Save are gone; the editor's draft persists via the global save, and switching Modes auto-persists the outgoing edited draft (a failing draft blocks the switch instead of losing edits).
- **Jev foundation (#341, PR #346).** `lib/jev.js` (pure): decide-request builder, never-throw response parser, per-type confidence routing (noul vs choice confidences are not comparable — vendor model notes), question builders (click-choice, done-gate, cue-match), and the `redactStateForJev` boundary. Config: key + endpoint ride storage.local; enable/model/thresholds ride storage.sync. The options ⚡ Jev card ships DARK — off, no key — with a one-question Test probe (`JEV_TEST`) that works before opting in.
- **Jev fast path (#342, PR #347).** Done-gate: before a chained handoff turn, Jev (`noul` ≥ `jevDoneConfidence`) answers "is the goal already achieved on this page?" — a confident yes completes the run without the Zo round-trip (compose runs exempt). Click-pick: a failed click gets ONE Jev `choice` over the tab's clickable candidates (≥ `jevPickConfidence`) — a confident winner executes; anything else falls back verbatim. Every state passes the redaction boundary; timeline cards carry `⚡ Jev pick` / `⚡ Jev fallback` provenance. With Jev off, every flow is byte-identical.
- **The marriage — Zo drives Jev (#343, PR #348).** A config-gated prompt section (`## Jev-Assisted Steps`) teaches Zo the `{type:"click", pick:{question}}` vocabulary (default prompts byte-identical — offline evals 24/24 from cache); the executor's two-pass structure resolves picks in-page over a fresh candidate inventory and re-enters EVERY rail (sensitive submit probe, post-fill backstop, handoff boundary) on the resolved click — a Jev resolution can never bypass a gate. Low confidence parks the step: runs re-plan via the next Zo continuation (siblings continue), plain chats show the honest failed card.

Adversarial review caught two real defects pre-merge: CI's #309 hit-target sweep flagged the Jev card's sub-24 controls (fixed), and the J3 review round closed the J2 raw re-execution bypass (resolved clicks now re-enter every rail). Tests: 1516 unit/integration across 64 files (~4966 expects); 121 Playwright e2e across 43 numbered specs + 4 demo-gated. Live probe: `tests/test-prompts/probe-jev.ts`.

## [0.3.3.0] — 2026-09-20

### Fixed — UX bash (0.3.3 slate: #296–#315, PRs #316–#335)

Twenty atomic UX/a11y tickets from the 2026-09-19 comprehensive audit (static walkthrough + a Playwright probe driving the real extension through ~45 states × themes with a computed CSS audit). Every ticket ran the full zo-loop factory cycle with adversarial review; milestone `0.3.3` drained. Known issues will be addressed in `0.3.3.N` stabilization points.

- **Header & chrome (#296, #297, PRs #316, #317).** At dock width the header brand collapses to the icon so the page title keeps a ≥16-character budget (`e2e/28`); controls-bar labels bumped to 11px over a readable token, gated by a committed CSS-audit walker (`e2e/helpers/css-audit.ts` — computed WCAG contrast per theme, transitions frozen, `color(srgb)` parsing).
- **Messages & footers (#298–#302, PRs #318–#322).** A `--text-soft` readable floor (≥4.5:1) across all seven theme blocks with `--zo-muted-foreground` repointed — footer time/chips/reasoning/system notes clear WCAG AA in every theme (`e2e/30`); active-chat stream errors now persist as `{role:'error'}` records and re-render as the error card with working Retry after reload (`e2e/31`); handoff/compose continuation turns stamp the capture tier they actually used, so the context-tier chip appears exactly where users cannot watch the capture (`e2e/32`); the recipe run line is ONE live element (started → progress → terminal — inversion structurally impossible) with an inline ≥24px stop control; Skip on parked actions posts a persisted system note (count + action types; boundary wording for handoff parks).
- **Composer & pickers (#303–#306, PRs #323–#326).** The three set-once toggles render as one wrapping chip row instead of three permanent rows (`e2e/33`); all three picker popups carry a keyboard hint footer, an amber accent edge on the active row (≥3:1 non-text contrast), and `aria-activedescendant` wiring (`e2e/34`); same-title tabs get VSCode-style path disambiguation in the strip, the @ popup, AND the prompt manifest — unique titles byte-identical (`e2e/35`); the prompt inspector gains a Copy button (raw prompt to clipboard) with letter-spacing pinned normal (`e2e/36`).
- **Accessibility (#307–#310, PRs #327–#330).** Every icon-only control carries an accessible name, swept in e2e across panel + options (`e2e/37`); connection status mirrors into an sr-only text twin (WCAG 1.4.1, `e2e/38`); one 24px hit-target floor over 23 sub-24 controls — the sweep also caught the header theme button rendering the options switch's knob (`e2e/39`); one global `:focus-visible` ring, all `outline: none` strips removed (`e2e/40`).
- **Settings & onboarding (#311–#313, PRs #331–#333).** The prompts editor LIVE PREVIEW is pinned populated-on-load + Mode-switch (`e2e/41`); the Theme card moved to the About pane as "Appearance" with live-sync intact (`e2e/42`); the first-run tour now carries an in-card **Open settings** button and references no nonexistent gear icon or Test Connection control.
- **Recipes surface & i18n readiness (#314, #315, PRs #334, #335).** Recipe-library rows keep ▶ Run inline and move Save/Export/Rename/Delete into a per-row ⋯ overflow (Delete's two-click confirm with red styling lives in the menu); i18n surface (a) — onboarding, error cards, empty state — extracted via `tOr(key, englishLiteral)` (`_locales/en`: 14 → 35 keys) with a census gate pinned in `bun run lint` (the prompt-budget-gate pattern); surfaces (b)–(e) follow as `0.3.3.N` points.

Adversarial review rounds per ticket; the CI e2e job caught and fixed one wrong fixture assertion in review. Tests: 1482 unit/integration across 63 files (~4834 expects); 106 Playwright e2e across 42 numbered specs + 4 demo-gated.

## [0.3.2.0] — 2026-09-19

### Added — Zo-composed recipes (#289 C1, #290 C2)

- **Save a Zo-run as a recipe (#289).** A completed `!handoff` run's flow becomes a validated draft recipe (↧ Save as recipe on the done card) — boundary parks become human checkpoints, Zo fills become params with no default.
- **`!recipe compose <goal>` (#290).** Zo walks the flow to compose a recipe and never fills or submits (enforced in code): park cards ask you for values, choices, and submits; your on-page actions become the draft's defaults.
- **Rehearsal.** Composed drafts verify on their first run — checkpoints cannot be skipped; passing the rehearsal marks the recipe verified.




## [0.2.7.1] — 2026-09-05

### Fixed — stabilization round (2026-09-05 end-to-end pass)
- **Esc-to-stop works anywhere in the panel (#133).** The "Press Esc to stop"
  gesture previously only fired while the composer was focused. Esc now
  cancels the in-flight stream from the panel level; autocomplete popups
  consume Esc first (closing a popup never cancels the stream).
- **Chat-tab streaming dot is background-only (#135)** — no longer renders on
  the tab the user is already watching.
- **Handoff done no longer repeats the digest (#138)** — the completion status
  line is compact; the deliverable renders once, as the turn's answer.
- **"Fill 1 fields" → "Fill 1 field" (#139)** — plural fixed on the review
  confirm button and the fill_form card meta.

### Added — regression coverage (#137)
- e2e specs `19-error-paths`, `20-chat-tabs-parking`, `21-history-ops`,
  `22-bang-commands`; mock Zo `unauthorized` (401) + `fill-slow` scenarios.
- Drift: Zo MCP catalog pruned 93→79 tools upstream; baselines re-pinned
  (#136), snapshot floor test loosened (required-tools loop is the real gate).

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
