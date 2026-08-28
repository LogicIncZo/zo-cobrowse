# Zo Co-browse — AGENTS.md

Compact project index for agents working on this codebase.

## Overview

Chrome MV3 extension + optional WebSocket backend that connects the browser to [Zo Computer](https://zocomputer.com) as the AI co-browsing backend. Zo sees the page DOM, uses its full toolchain (DuckDB, skills, web search, files, integrations), and returns browser actions (click, fill, navigate, extract, scroll).

## Branching & release flow

Git-flow model — see `CONTRIBUTING.md` for the full rules. Short version:

- `dev` (protected) — integration branch. Branch from it, PR back to it.
- `main` (protected) — latest working release code. Promote via PR from `dev`.
- `feature/*` / `fix/*` / `chore/*` — one branch per unit of work.
- Releases are deliberate: `git tag vX.Y.Z && git push origin vX.Y.Z` triggers
  `.github/workflows/release.yml`. Merging to `main` does **not** release.

## To understand quickly

- **`extension/background.js`** — entry point for the service worker. All Zo API communication, message routing, config persistence, conversation_id tracking. Key functions: `getActiveTabContext(tabId, tier, modeId)` (CDP eval fast-path via `debugger` perm; capture is **tier-gated** — 0=url only, 1=+text, 2=+clickable+forms w/ selectors, 3=+screenshot; the returned context carries the source `tabId`), `askZoStream()`/`_askZoStreamImpl()` (primary streaming path), `askZo()` (non-streaming fallback), `executeActions()` (per-action executor loop with the #26 submit backstop), `runExecuteActions()` (the #26 two-phase fill_form gate: live `{pull:'form'}` capture → `isSensitiveForm` → park `{needsConfirm,…}` or execute; re-derived on `confirmed:true`), `testConnection()`, `generateMode()` (LLM custom-Mode generator). Prompt assembly is imported from `lib/prompt.js` (`buildPrompt(mode, pageContext, userQuery, {effectiveTier})`); both ASK_ZO call sites thread `effectiveTier` (from the sidepanel's context policy) + `modeOverrides` (Settings builtin edits) + `chatId`/`conversationId` (per-chat Zo threads — the payload id wins over the ambient `zoConversationId` global, and the effective id is echoed back on `STREAM_DONE.conversationId`). Top-level helpers: `safePost()`, `isRetriableStreamError()`, `msgThreadId()`.
- **`extension/content.js`** — injected into web pages. `captureContext(tier, {pull})` extracts URL/title/visibleText/formFields/clickable elements, **tier-gated** (0=url only, 1=+text, 2=+elements; screenshots for tier 3 are captured by the background); `opts.pull` ('page'/'dom'/'form') raises the capture caps for the pull loop (#24). `executeDomAction()` runs click/fill/extract/scroll/wait/navigate/done in the DOM. Communicates via `chrome.runtime.onMessage` (`CAPTURE_CONTEXT`, `EXECUTE_ACTION`).
- **`extension/sidepanel.js`** — chat UI (largest file). Manages conversations (map keyed by id in `chrome.storage.local` `cobrowse_convos`, max 50 messages each; active id + open-tab ids ride along) and the **chat tab bar** (`#chat-tabs`, ops from `lib/chat-tabs.js`): several chats open at once, ✕/middle-click to close (one stays open), pulsing dot while a backgrounded chat streams. History view: list/switch/delete + `#history-search` live search + ✎ inline rename. Streaming path: `streamPort` / `handleStreamMessage`, guarded by a per-query `streamSession.sessionId` + `streamSession.chatId` (streams survive tab switches — background chats accumulate into their own conversation, actions park as `conv.pendingActions` instead of auto-running, switching back re-creates the live bubble). Sends `ASK_ZO` (with `modeId` + `customModes` + `effectiveTier` + `modeOverrides` + `chatId`/`conversationId`), `GET_PAGE_CONTEXT` (with `tier` + `modeId`), `NEW_CONVERSATION`, `EXECUTE_ACTIONS` to background — all intra-extension `chrome.runtime` messaging, never external. Mode lifecycle: `loadModes` / `applyMode` / `rebuildModeOptions` / `startModeCreation`. **Prompt inspector**: `renderPromptInspector` — a live, collapsible preview of the exact prompt (via `lib/prompt.js#describePrompt`), with the context-policy decision + approx-LLM-token estimate (prompt size, not auth tokens); recomputes as you type. Zo-parity chat surface: composer-shell user bubbles + mention pills, bare assistant prose, inline/collapsible reasoning, tool-trace action cards, per-turn footer (`addMessageFooter` — Copy/mode/model/time/feedback), Zo error card (`addErrorCard` — "Response interrupted" + Retry), Esc-to-cancel stream (`cancelStream()`), Send disabled when empty, relative timestamps (`relativeTime()`). Suppresses raw action-JSON during streaming (`looksLikeActionJson`). **Composer reference pickers (#28)**: `/` opens the skills popup, `%` the workspace-files browser (same popup machinery as `@`; selections arm **send-once** chips — `pickedSkills`/`pickedFiles` ride the next ASK_ZO as `skills`/`workspaceFiles`, render as `## Skills to Run` / `## Referenced Files` prompt sections, then clear; backed by background MCP calls `LIST_SKILLS`/`LIST_WORKSPACE_DIR`).
- **`extension/lib/`** — pure ES modules with no `chrome.*`/DOM deps. `modes.js` (`BUILTIN_MODES`, `resolveMode(modeId, customModes, overrides)` — 3rd arg applies sparse built-in overrides, `mergeOverride`, `EDITABLE_MODE_FIELDS`, `presetToMode`, `ACTION_SCHEMA_COMPACT` — the Mode system, single source of truth for what each Mode's prompt contains + its context tier), `prompt.js` (`buildPrompt()` + `describePrompt()` — THE prompt assembler, single source of truth shared by background, the sidepanel inspector, the Settings editor, and the test-prompts harness; `_compose` tags parts once so the string + structured views never drift), `context-policy.js` (`decideTurn()` — the per-turn opt-in DOM + send-once decision; `computePageHash`, `stripToPointer`, session-state helpers), `bang-commands.js` (`parseBangCommand()`, discriminated union on `kind`, each command carries a `mode` field; `kind:'context'` = the `!context`/`!dom` one-turn context attach), `intent.js` (`detectIntent()`, `shouldDowngradeToJsonDisabled()` — classifies a free-text query as action vs read-only so Co-browse mode answers read-only intents like "Summarize" in plain markdown instead of forcing the JSON action envelope), `tab-contexts.js` (tab contexts — tabs as VSCode-style references: `buildTabManifest()` manifest+excerpt renderer, `buildTabFollowUp()` read_tab turn assembler, `extractReadTabRequests()`, per-tab send-once helpers; refs T1…Tn assigned in strip order), `pull.js` (#24 context-on-demand: `extractPullRequests()`, `buildPullFollowUp()` + `pullHash`/`pullTier`/`pullCaptureOpts` — the generalized read_tab loop's pure half for `read_page`/`get_dom`/`get_form`), `mcp.js` (#28 — MCP JSON-RPC envelope + response parsing: `mcpRequest`/`mcpNotification`/`initializeParams`/`toolCallParams`/`parseMcpMessage`/`toolText`/`isToolError`; the fetch transport stays in background.js), `pickers.js` (#28 composer pickers: `safeWorkspacePath` (traversal confinement to `/home/workspace`), `shellQuote`, `skillsListCommand`/`dirListCommand`, `unescapeRepr`/`extractMarkedStdout` (the MCP bash tool wraps stdout in a Python-repr CmdResult), `parseLsEntries`/`parseSkillFrontmatter`/`parseSkillsBundle`, `buildSkillLines`/`buildFileLines`), `chat-tabs.js` (chat tabs — pure ops for the sidepanel tab bar: `openChatTab`/`closeChatTab`/`activateChatTab`/`pruneChatTabs` over an ordered `{openIds, activeId}` state (LRU-evict at 8, last-tab guard), `tabTitleFor`, `renameConversation`, `searchConversations`), `parse-output.js` (`parseZoOutput()` + `stripCodeFence()` — the parse half of `finishStream`, shared with the stream replay harness), `formfill.js` (#26 — the form-fill gate's pure half: `isSensitiveForm(fields, url)` sensitivity heuristic (password/card/CVV/expiry fields, sensitive URLs), `redactValue`, `reviewRows(action, fields)` which blanks secret values so they never round-trip the review card and joins captured `question` text), `vision.js` (#25 — the vision gate: `shouldCaptureScreenshot` / `findModelEntry` / `modelVisionSupport` / `catalogIsStale` / `visionModelSuggestion`; tier-3 capture skips models the catalog flags `supports_images:false`, unknown keeps capturing), `config.js` (the `DEFAULTS` config object + storage keys, incl. `MODE_OVERRIDES`). Unit-tested directly.
- **`extension/options.html`/`.js`** — settings UI. The access token + Zo.space endpoint are saved to `chrome.storage.local` (sensitive — deliberately NOT synced across devices, per `config.js` `SENSITIVE_KEYS`); model + persona go to `chrome.storage.sync`. Test connection flow + "Reset to defaults". **✎ Prompts card** (`initPromptsEditor`): tune each Mode's 5 knobs (systemPrompt, instructions, contextTier, textBudget, expectJson) with a live preview; built-ins persist sparse overrides to `storage.local['cobrowse_mode_overrides']` (originals never mutated; Reset deletes the entry), custom Modes edit in place. Loads `lib/modes.js` + `lib/prompt.js` via dynamic `import()` (options.js stays a classic script).
- **`backend/relay.ts`** — optional HTTP+WebSocket service for multi-participant sessions. Not required for single-user co-browsing.
- **`extension/AGENTS.md`** — Zo API reference (endpoints, auth, SSE event types). Read before touching API calls in `background.js`.
- **`skill/`** — the Zo-side companion to the extension: co-browse personas, preset library, and the action-schema protocol (`skill/SKILL.md`, `skill/references/presets.md`; presets sync via `skill/scripts/sync-presets.ts`). Presets feed the Mode system through `presetToMode` in `modes.js`.

## Key patterns

- **Two-channel approach**: `/zo/ask` for AI inference + action generation; Zo.space API routes for quick data queries (DuckDB, research).
- **Streaming is the primary path** (`askZoStream` / `_askZoStreamImpl` in background ↔ `streamPort` / `handleStreamMessage` in sidepanel), hardened end-to-end: per-query `sessionId` isolation, `safePost()` that no-ops on dead ports, `port.onDisconnect` → marks `port._dead`, `isRetriableStreamError()` retries only transient errors and emits `STREAM_RECONNECT` before retrying, 60s thinking-indicator liveness timeout. The older non-streaming `askZo()` is retained as fallback. Per-session **SSE shape discovery** (`emitStreamDiagnostic` / `STREAM_DIAGNOSTIC` → `streamShape`) records which event types/fields Zo actually emits (tool traces / sources / streaming reasoning may be dropped today) so the rich-content gap can be closed. See `QA_REPORT.md` § "Streaming support" before touching this path.
- **Conversation threading — per chat**: each conversation carries its own `zoThreadId` (persisted in `cobrowse_convos`); the sidepanel sends it as `ASK_ZO.conversationId` and persists the id the background echoes back (`STREAM_DONE.conversationId` / non-streaming response). background.js's `zoConversationId` global remains only as the **ambient** thread for callers without a chat (context menu, omnibox); `read_tab` follow-up cycles re-enter with the latest captured id (`loop.threadId`) so a mid-loop rotation can't strand the continuation. Context-policy dedup state (`cobrowse_ctx_state:<chatId>`) and tab-context `tabsSent` are keyed per chat the same way.
- **Chat tabs — one stream, survives switches**: the tab bar (`lib/chat-tabs.js` + `renderChatTabs`) keeps ≤8 chats open; `switchToConversation` no longer cancels the in-flight stream — `streamSession.chatId` routes chunks: visible DOM for the active chat, silent accumulation + `saveConversationById` for backgrounded ones (their actions park as `conv.pendingActions`, restored via `restorePendingActionsFor` — never auto-run against a page the user isn't watching; switching back re-creates the live bubble). Tab-context chip toggles are per chat (`chatTabRefs` Map, stash/restore on switch).
- **Context policy — opt-in DOM + send-once** (`lib/context-policy.js#decideTurn`, wired in sidepanel `sendQuery`): read turns send URL/title only (tier 0) by default — DOM is token-costly and explicit; `!context <question>` attaches the Mode's full context for ONE turn; action turns (expectJson && not read-downgraded) attach on the first turn of a conversation and re-attach on page-hash change (url/title/text-length/element-counts), relying on `conversation_id` threading otherwise. The decision's `effectiveTier` rides the `ASK_ZO` message to the background and gates prompt sections in `buildPrompt` — the sidepanel inspector shows the same decision, so preview and send can't diverge. Policy state (page hash + turn counter — non-secret) lives in `chrome.storage.session` keyed **per chat** (`cobrowse_ctx_state:<chatId>`), reset on new conversation. **Tier-0 turns auto-reference the active tab**: whenever page content is NOT attached (reads, same-page follow-ups), the active browser tab rides along as T1 (manifest line + 500-char excerpt, banner-free capture) — Zo always knows what page you're on; `read_tab` escalates (`lib/tab-contexts.js#ensureActiveTabRef`, spec `docs/superpowers/specs/2026-08-15-auto-active-tab-design.md`). The sidepanel also adopts browser-tab switches for DISPLAY via `chrome.tabs.onActivated` (`adoptActiveTabDisplay` — tabs API only, no capture/banner); the real Mode-tier capture happens per send.
- **Tab contexts — tabs as references, not payloads**: other tabs (chip strip above the composer, or `@` autocomplete toggling the same chips) ride along as a compact `## Referenced Tabs` manifest + 500-char excerpt per tab (`lib/tab-contexts.js`; refs T1…Tn, 8KB total excerpt budget). If Zo needs more it returns `read_tab {ref}`; the background chains the capture + follow-up turn INSIDE the stream (`finishStreamWithTabLoop` — before `STREAM_DONE`, so the continuation renders into the same live bubble; max 3 cycles/turn, send-once per tab page-hash via `tabsSent` in the per-chat conversation state). Background-tab captures pass `{skipDebugger:true}` so the "is being debugged" banner never appears on unfocused tabs. Context-only by design — no cross-tab DOM actions (still ticket #10).
- **Graceful fallback**: content script (`chrome.tabs.sendMessage`) tried first for context/actions; falls back to `chrome.scripting.executeScript` if content script not loaded.
- **No output_format in API calls**: Zo didn't support `array` type in the `output_format` schema. Instead, the prompt asks for JSON and the code parses it from the text response. Only `cobrowse` mode uses the JSON `{reasoning,actions}` envelope; read-only modes (`ask`/`research`/`summarize`/`extract`/`visual`) stream plain markdown.
- **Text safety**: route all output through `addMessageDOM('assistant')` (escapes + markdown + `appendChild`); `safeText`/`String()` coercion at every text sink. Don't use `addMessage('bot')` — it skips markdown.
- **Reasoning — inline, not a separate bubble**: the `reasoning` field Zo returns alongside `actions` is surfaced via `addReasoningBubble(parentMsgEl, reasoning)` in sidepanel.js. Short reasoning renders **inline as muted prose** above the answer; longer reasoning collapses into a "💭 Thought" trace header (Zo model — mirrors Zo's "Response interrupted — retried ▸" pattern). Rendered through `markdownToHtml` + `safeText` (same safety as assistant messages). It no-ops on empty reasoning (so `ask`/`visual` modes are unaffected). Reasoning is persisted with the assistant message (`{role, text, reasoning, timestamp}`) and re-rendered from history. It arrives only in the final `STREAM_DONE` payload (no incremental streaming of reasoning yet).

## Permissions

From `manifest.json`:
- `debugger`, `contextMenus`, `sidePanel`, `storage`, `activeTab`, `tabs`, `scripting`, `tts`
- `host_permissions`: `https://api.zo.computer/*`, `https://*.zo.space/*`, `https://*.zocomputer.io/*`, `http://*/*`, `https://*/*`

> `debugger` is required for the CDP eval fast-path in `getActiveTabContext()`; Chrome shows a standard "is being debugged" banner while it runs. All permissions above are exercised by code paths that have tests.

## Tests & scripts

```bash
bun test tests/       # unit + integration suite (also: npm test)
bun test tests/ --watch  # watch mode (npm run test:watch)
bun run test:e2e      # real-Chromium Playwright E2E (mock Zo API; e2e/)
bun run verify        # loop-engineering gate → scripts/verify.sh (tests + lint + transpile)
bun run setup-hooks   # one-time: installs the committed pre-commit gate (scripts/install-hooks.sh)
bun run lint          # release-readiness checks → scripts/check-release.sh
bun run package       # zip extension/ → zo-cobrowse.zip
```

[![CI](https://github.com/CCAgentOrg/zo-cobrowse/actions/workflows/ci.yml/badge.svg)](https://github.com/CCAgentOrg/zo-cobrowse/actions/workflows/ci.yml)

**879 tests across 39 files (0 failures, 2321 expect() calls)) + 22 Playwright E2E tests across 12 spec files (`e2e/`, incl. the ZO_DEMO-gated `demo-open-all.spec.ts` demo-recording spec).** Every extension JS file transpiles cleanly via `bun build` (checked by `bun run verify` and CI). The committed pre-commit hook (`scripts/hooks/pre-commit`) runs `bun run verify` before every commit as a hard gate — bypass with `git commit --no-verify`. CI runs the same checks on every branch push + PRs into both `main` and `dev`; the separate `e2e` job (installs Playwright Chromium — browsers cached via `actions/cache` keyed on `bun.lock` — and runs `bun run test:e2e`) fires on PRs into `main`/`dev`, pushes to the protected branches, and manual `workflow_dispatch` — **not** on feature-branch pushes (the PR gates the same code); tags `v*` trigger the dormant Release workflow (`release.yml`). Adding a feature means adding/updating the corresponding test file under `tests/`.

**Integration layer (`tests/integration/`)** loads the real background.js/content.js/sidepanel.js on a fake-chrome message bus (`tests/helpers/chrome-mock.ts` — real port pairs, storage, tabs routing) with a recording SSE fetch mock (`tests/helpers/zo-fetch-mock.ts`, incl. gated `deferredSse` streams). bun shares the module registry across test files: import extension scripts with unique `?file=` cache-busters, and keep ONE sidepanel instance per process (all panel scenarios live in `extension-flow.test.ts`).

**Browser E2E (`e2e/`)**: Playwright + persistent context loads the real extension in new-headless Chromium against `e2e/mock-zo/server.mjs` (local mock Zo API streaming real SSE + static fixture site; scenarios keyed off the prompt's `## User Request`). The sidepanel opens as a tab (CDP can't drive the real panel shell); `senderTabId()` in background.js keeps captures/actions routed to the web tab, never the extension's own pages. See `QA_REPORT.md` for the audit history. **Demo recording** (`e2e/demo-open-all.spec.ts`): `ZO_DEMO=1 bun x playwright test -c e2e/playwright.config.ts demo-open-all` records the #27 link-chips + Open-all flow via `recordVideo` (harness `launchExtension` passes `viewport`/`recordVideo` through), then `ffmpeg -i <panel.webm> -pix_fmt yuv420p demo/open-all-demo.mp4`; skipped in the normal suite, artifacts gitignored.

## Ticket & feature status

- **Shipped tickets (#01–#09, #12, #13, #21-style work, #26 form-fill 2026-08-21):** screenshot/vision, right-click context menu, streaming action timeline, skill runner, NL→DuckDB, keyboard shortcuts, command templates, automations, save-page, onboarding, omnibox. Plus (2026-08-15, `feature/tab-interface`): **chat tabs** — multiple chats open as sidepanel tabs with per-chat Zo threads, streams surviving switches, and history-view rename/search.
- **Not started / backlog (#10, #11, #14, #15):** multi-tab context, web store listing, page monitoring, shared sessions. `backend/relay.ts` exists for #15 but extension integration is undone.
- **Streaming architecture:** hardened end-to-end this round (see `QA_REPORT.md` § "Streaming support").

**Authoritative, current status lives in `BACKLOG.md` (feature roadmap) and `QA_REPORT.md` (audit/remediation log).** Per-ticket specs are in `tickets/`. This file is a quick index — update those two docs when status changes rather than maintaining tables here.

> Note: older revisions of this file referenced `brainstorming/ZO_AFFINITY_RANKING.md`; that file does not exist in this repo. The Zo-affinity analysis is summarized in `BACKLOG.md`'s tier table instead.

## Verification layer (Zod schemas) — read before adding features

Contracts are defined as **Zod schemas** in `tests/schemas/` and used by the tests as the single source of truth. Prefer schema validation over scattered `.toContain()` string checks.

| Schema file | Validates | Used by |
|-------------|-----------|---------|
| `tests/schemas/manifest.ts` | full `manifest.json` (MV3 shape, commands, omnibox, icons, permissions) | `tests/manifest.test.ts` |
| `tests/schemas/actions.ts` | the Zo action protocol (`navigate`/`click`/`fill`/`extract`/`scroll`/`wait`/`done`) | `tests/message-contract.test.ts` |
| `tests/schemas/messages.ts` | every message type passed sidepanel ↔ background ↔ content | `tests/message-contract.test.ts` |
| `tests/schemas/config.ts` | the `DEFAULTS` config object | (config tests) |
| `tests/schemas/bang-commands.ts` | `parseBangCommand()` output (discriminated union on `kind`) | `tests/bang-commands.test.ts` |
| `tests/schemas/prompt.ts` | `describePrompt()` structured output (sections, tier, intent, token estimate) | `tests/prompt.test.ts` |
| `tests/schemas/context-policy.ts` | `decideTurn()` decision + conversation state | `tests/context-policy.test.ts` |
| `tests/schemas/modes.ts` | Mode objects + sparse `OverrideSchema` (builtin override catalog) | `tests/modes.test.ts`, `tests/mode-overrides.test.ts` |
| `tests/schemas/tab-contexts.ts` | TabContext, tab manifest, `read_tab` action, follow-up output, history `tabRefs` | `tests/tab-contexts.test.ts` |
| `tests/schemas/chat-tabs.ts` | TabsState, Conversation (with `zoThreadId`/`pendingActions`), ChatSummary, RenameResult | `tests/chat-tabs.test.ts` |

**Two contract tests guard the boundaries:**
- `tests/message-contract.test.ts` — asserts background.js has a `case` for **every** message type in the schema, AND that the schema isn't missing any handler background.js already implements. Add a new message type → add it to the schema or this test fails.

**Pattern for pure logic:** extract into `extension/lib/<name>.js` as an ES module (no `chrome.*`/DOM deps), import it from the consuming extension script (which must be loaded as `type="module"` in its HTML), and unit-test it by importing directly + validating output against its Zod schema. See `extension/lib/bang-commands.js` ↔ `tests/bang-commands.test.ts` as the reference.

When you add a feature: extend the relevant schema first, then write the code + a test that validates the code's output against the schema. This catches structural regressions that `.toContain()` misses.

## When to use this

- User wants "co-browsing", "browser AI", "extension that controls the page"
- User mentions Parchi, Browser OS, Dia, Comet as references
- User wants Zo to see what they're browsing and act through the browser
- User reports extension bugs (context capture failures, 422 errors, JSON parse errors)

## Files to edit

| Task | File |
|------|------|
| Change prompt/action schema | `extension/lib/prompt.js` → `buildPrompt()`/`describePrompt()` + `extension/lib/modes.js` → `ACTION_SCHEMA_COMPACT` + `extension/lib/intent.js` → `detectIntent()` (action-vs-read classification that downgrades JSON modes for read-only queries) |
| Tune a Mode's prompts/tier (user-facing editor) | `extension/options.js` → `initPromptsEditor` + `extension/lib/modes.js` → `mergeOverride`/`EDITABLE_MODE_FIELDS` (overrides persist under `STORAGE.MODE_OVERRIDES` = `cobrowse_mode_overrides`) |
| Add/edit a Mode | `extension/lib/modes.js` → `BUILTIN_MODES` (add a schema test in `tests/modes.test.ts`) |
| Edit Zo-side presets/personas | `skill/` (`skill/SKILL.md`, `skill/references/presets.md`) |
| Add new action type | `extension/content.js` + `extension/background.js` → `executeDomAction()` |
| Fix context capture | `extension/background.js` → `getActiveTabContext()` + `extension/content.js` → `captureContext(tier, {pull})` (+ `lib/pull.js` for the on-demand pull variants: `read_page` / `get_dom` / `get_form`) |
| Change when/how much context is sent | `extension/lib/context-policy.js` → `decideTurn()` (+ its wiring in sidepanel `sendQuery`) |
| Change conversation display | `extension/sidepanel.js` → `addMessage()`, `sendQuery()` |
| Add settings field | `extension/options.html` + `extension/options.js` |
| Update manifest | `extension/manifest.json` |
| Add/modify test | `tests/*.test.ts` |
| Modify backend relay | `backend/relay.ts` |
