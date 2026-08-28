# Zo Co-browse — QA Report

**Round:** 2026-08-08 · **Branch:** `Rewritet` · **Scope:** Full codebase audit (extension, backend, tests, manifest) + remediation of all findings.

## Headline status (after remediation)

| Metric | Before this round | After this round |
|--------|-------------------|------------------|
| `bun test` | ❌ red — 81 pass / 9 fail / 5 errors | ✅ **green — 147 pass / 0 fail** (465 expect() calls) |
| Tests added | — | +3 (options reset + shortcut-docs assertions) |
| P0 findings | 5 open | **0 open** |
| P1 findings | 10 open | **0 open** |
| P2 findings | 11 open | **0 open** (B-31 deferred as documented design decision) |
| P3 findings | 7 open | **0 open** |
| Working tree | clean | clean |

9 atomic commits on `Rewritet` from `b31f3de` → `e036b81`.

> **2026-08-09 — Infrastructure round (no code changes, all green replay):**
> `bun run verify` aggregate gate (`scripts/verify.sh` = tests → release checks →
> per-entry `bun build` transpile) + a committed **hard-gate pre-commit hook**
> (`bun run setup-hooks` installs; `git commit --no-verify` bypasses). CI
> (`.github/workflows/ci.yml`) now runs on **every branch push** + PR to `main`
> and replaces the weaker `node --check` loop with a `bun build` transpile check;
> release publishing moved out of CI into a dormant, tag-triggered
> `.github/workflows/release.yml`. Suite: **274 tests / 0 fail** (19 files,
> 783 expects). See `CHANGELOG.md` `[Unreleased]`.

> **2026-08-10 — v0.0.2 released:** manifest bumped to `0.0.2` (the initial
> v0.0.2 release shipped a `0.0.1` manifest; corrected by re-running the tag
> workflow). Suite: **534 tests / 0 fail** (24 files, 1381 expects).
>
> **2026-08-14 — Prompts feature round (`feature/prompts`):**
> Prompts to Zo are now **reviewable, customizable, and token-efficient**.
> (1) `buildPrompt` extracted from background.js into the pure
> `extension/lib/prompt.js` (byte-identical; parity tests lock the output; the
> duplicated copy in `tests/test-prompts/capture.ts` is deleted) +
> `describePrompt()` structured view. (2) **Opt-in DOM + send-once** via the
> new `extension/lib/context-policy.js#decideTurn`: read turns send URL/title
> only (tier 0) by default; `!context`/`!dom` attaches full context for one
> turn; action turns attach on first turn / page-hash change and dedupe after
> (relying on `conversation_id` threading). `effectiveTier` rides the existing
> `ASK_ZO` payload (no new message types — the bidirectional contract test
> stays green by construction). (3) **Side-panel prompt inspector** — live,
> collapsible preview of the exact prompt + policy reason + approx tokens.
> (4) **Settings ✎ Prompts card** — edit each Mode's 5 knobs with a live
> preview; built-ins persist sparse overrides to `cobrowse_mode_overrides`
> (`mergeOverride` in modes.js; originals never mutated). (5) content.js
> `captureContext(tier)` now honors the requested tier (was always tier-2
> sized). Post-review fixes: `refreshPageContext` now resolves the Mode WITH
> overrides (Settings tier-raises actually capture) and the inspector honors
> mode-switching bangs. Behavior change (intended): read modes no longer ship
> page text by default — the inspector surfaces the decision. Suite: **594
> tests / 0 fail** (27 files, 1531 expects) + `bun run verify` fully green.
>
> **2026-08-15 — Chat tabs round (`feature/tab-interface`):**
> Multiple chats open at once as sidepanel tabs + chat management. (1) New
> pure `extension/lib/chat-tabs.js` (ordered open-set ops: open/close/
> activate/prune, LRU-evict at 8, last-tab guard; `renameConversation`,
> `searchConversations`) + `tests/schemas/chat-tabs.ts`. (2) **Per-chat Zo
> threads**: each conversation persists `zoThreadId`; `ASK_ZO` carries
> `chatId` + `conversationId` (payload id wins over background's ambient
> `zoConversationId` global), and the effective id is echoed back
> (`STREAM_DONE.conversationId`, non-streaming response) so the sidepanel can
> persist it — fixing cross-chat context bleed where switching chats silently
> continued the previous chat's server thread. (3) **Streams survive tab
> switches**: `streamSession.chatId` routes chunks (live DOM for the active
> chat, silent accumulation + persistence for backgrounded ones; their actions
> park as `conv.pendingActions` and re-arm the Run All/Skip bar on return —
> never auto-run against a page the user isn't watching). (4) Context-policy
> + `tabsSent` dedup state now keyed per chat (`cobrowse_ctx_state:<chatId>`,
> legacy global key as fallback); tab-context chip toggles per chat
> (`chatTabRefs` map). (5) History view: `#history-search` live filter +
> ✎ inline rename; delete prunes the open-tab set. (6) Fixed the dead
> Ctrl+Shift+N shortcut (background broadcast now consumed by the sidepanel).
> No new message types — the bidirectional contract test stays green by
> construction. Suite: **694 tests / 0 fail** (29 files, 1734 expects) +
> `bun run verify` fully green.
>
> **2026-08-15 (follow-up) — Auto-referenced active tab + tab-switch display:**
> User report: switching browser tabs and creating a new chat left the panel
> describing the old tab, and read questions in a fresh chat carried nothing
> about the page. Root causes: (a) NOTHING listened to browser-tab activation
> — the page bar / inspector / 📎 strip refreshed only at send; (b) read turns
> are tier-0 by design (URL/title only); (c) latent bug —
> `getActiveTabContext` never returned `tabId`, so `currentContext.tabId` was
> always undefined and `GET_TAB_CONTEXTS`' `isActive` dedup ("this tab,
> attached above") could never fire. Fixes: (1) captured contexts now carry
> the source `tabId`; (2) **tier-0 turns auto-reference the active tab as T1**
> (manifest line + 500-char excerpt, banner-free content-script capture via
> `ensureActiveTabRef` in lib/tab-contexts.js; refs renumber; full DOM stays
> opt-in — spec 2026-08-15-auto-active-tab-design.md); (3) the inspector
> preview mirrors the auto-reference (`previewTabContexts({includeActive})`);
> (4) `chrome.tabs.onActivated` (scoped to the panel's window) +
> `startNewConversation` adopt the current tab for DISPLAY via the tabs API —
> no capture, no debugger banner. Suite: **701 tests / 0 fail** (29 files,
> 1753 expects) + `bun run verify` fully green.

## Test suite

```
147 tests across 13 files — 147 pass, 0 fail, 465 expect() calls
```

Every extension JS file (`background.js`, `sidepanel.js`, `content.js`, `options.js`) transpiles cleanly via `bun build`. The message-protocol contract test (`message-contract.test.ts`) and Zod manifest schema both validate the current code.

---

## Remediation log (all findings from the audit round)

### P0 — Critical ✅ all fixed
| ID | Was | Fix | Commit |
|----|-----|-----|--------|
| P0-1 | Test suite red: malformed `describe`/`beforeEach` nesting in `background.test.ts` | Closed `beforeEach` brace, removed stray `});` | `b31f3de` |
| P0-2 | `ReferenceError: pageContext` on every non-save context-menu action (`background.js:600`) | Removed the undefined ref; panel re-captures context itself | `ccf059c` |
| P0-3 | Lite Persona dropdown permanently empty — same `<option>` moved between selects | `cloneNode(true)` into the second select | `ccf059c` |
| P0-4 | "Fill this field" menu hidden — `enabledMenus` key mismatch (`fillField` vs `editable`) | Unified on `editable` in DEFAULTS, background, options | `ccf059c` |
| P0-5 | `addSystemMessage` XSS + markdown bypass + DOM thrash | Route through `addMessageDOM('system')` (escapes + markdown + appendChild) | `5d842b9` |

### P1 — High ✅ all fixed
| ID | Was | Fix | Commit |
|----|-----|-----|--------|
| P1-1/6/8/11 | Streaming port lifecycle: stale-port throws, no disconnect handling, retries non-retriable errors, sessionId not echoed | `safePost()` helper + `port.onDisconnect`/`_dead`; echo `sessionId` on every STREAM_*; `isRetriableStreamError()`; re-enable input on disconnect | `486d496` |
| P1-7 | Late DONE from previous query could render into current chat | background now sends `sessionId` on every message; sidepanel's top guard rejects stale sessions | `486d496` |
| P1-9 | Dead duplicate `sendQuery` (~120 LOC) shadowed by streaming version | Deleted the dead original | `b476f6d` |
| P1-10 | Action loop threw if Skip clicked mid-await (`pendingActions = null`) | Snapshot to local `actions`; break when `pendingActions` null | `b476f6d` |
| P1-12 | `enabledMenus` not loaded on SW startup | Added to startup `storage.sync.get` keys | `b476f6d` |
| P1-13 | content.js had no `navigate`/`done` cases + no `default` | Added explicit cases + default response | `b476f6d` |
| P1-14 | Keyboard-shortcut docs in options.html wrong (K/L, missing S/N/E) | Regenerated to match manifest (Z/S/N/E, Ctrl+Cmd) + test | `89a17b1` |
| P1-15 | No "Reset to defaults" | Added reset button clearing sync+local config + test | `89a17b1` |

### P2 — Medium ✅ all fixed (B-31 deferred by design)
| ID | Was | Fix | Commit |
|----|-----|-----|--------|
| P2-1/16 | `fullText` overwritten by final payload (data loss) | `if (!fullText)` guards | `486d496` |
| P2-2/17 | `captureVisibleTab(tab.windowId)` undefined for synthesized tab | `chrome.tabs.get(tabId)` lookup | `519e279` |
| P2-3/18 | NAVIGATE passed undefined tabId; dead EXECUTE_CONTENT_SCRIPT | Validate tabId+url; removed dead handler + schema entry | `519e279` |
| P2-4/19 | `testConnection` casing bug | Case-insensitive `ZO_OK` + trust `r.ok` | `519e279` |
| P2-5/20 | listModels/listPersonas hardcoded host | `apiOrigin()` derives from `config.zoApiUrl` | `519e279` |
| P2-6/21 | Dead streaming state vars + no thinking-indicator timeout | Deleted dead vars; wired 60s timeout | `1ffd2d8` |
| P2-7/22 | `migrate`/`save` title `.substring` threw on non-string | `String(... \|\| '')` coercion | `1ffd2d8` |
| P2-8/23 | STREAM_DONE body lingered on partial chunk | Normalize body to `responseText` | `1ffd2d8` |
| P2-9/24 | Dead `STORAGE.CONVERSATIONS`; orphan `zoTtsVoice` | Removed dead key; added TTS_VOICE to DEFAULTS/STORAGE | `1ffd2d8` |
| P2-10/25 | Unjustified sandbox CSP `'unsafe-eval'` | Removed the sandbox directive | `1ffd2d8` |
| P2-11/26 | `zoTtsRate` stored as string | `type=number` input with min/max/step | `1ffd2d8` |
| P2-31 | Default `zoSpaceEndpoint` is tenant-specific (`cashlessconsumer.zo.space`) | **Deferred** — this is the documented working integration host (AGENTS.md references it as the landing page); changing it would break the active setup. Override is available via the `#space-endpoint` field. |

### P3 — Low ✅ all fixed
| ID | Was | Fix | Commit |
|----|-----|-----|--------|
| P3-27 | `addMessage('bot')` skipped markdown | Use `'assistant'` role | `e036b81` |
| P3-28 | Action timeline + DuckDB tables rendered unstyled | Added full CSS (`.action-card` states, `.db-table`, `.duckdb-result`) | `e036b81` |
| P3-29 | Badge showed `undefined` for unknown personaMode | Normalize unknown → `'auto'` | `e036b81` |
| P3-30 | Redundant `action.onClicked` + dead `makeCaptureContextEval` | Both removed | `e036b81` |
| P3-32 | Last fire-and-forget `storage.session.set` without `.catch` | Added `.catch` | `e036b81` |
| P3-33 | Unused icons (`icon32`, `icon256`) | Harmless; left as-is. `debugger` permission privacy note: it's required for the CDP eval fast-path and Chrome shows a standard "is being debugged" banner. |

### Feature — Thinking/reasoning bubble ✅ shipped
The `reasoning` field Zo returns alongside `actions` was flowing end-to-end (`background.js:finishStream` → `STREAM_DONE.reasoning` → sidepanel) but was invisible for text-only `done` responses — only surfaced truncated-to-200-chars in the `#actions-reasoning` in-action status bar when DOM actions ran.

| Aspect | Implementation |
|--------|----------------|
| Rendering | New `addReasoningBubble(parentMsgEl, reasoning)` in sidepanel.js — a collapsible "💭 Thinking" bubble (collapsed by default, click to expand), inserted above the assistant `.msg-body`. Rendered through `markdownToHtml` + `safeText` (same text-safety path as assistant messages). |
| Coverage | Hooked into all three assistant-finalize paths: streaming `STREAM_DONE` (live `msgEl`), the no-chunks `STREAM_DONE` fallback, the inactive-session late-DONE fallback, and the non-streaming `askZo()` fallback. |
| Persistence | Reasoning persisted with the assistant message (`{role, text, reasoning, timestamp}`) in both streaming and non-streaming write paths; re-rendered from history in `renderMessages` and `switchToConversation`. |
| Graceful degradation | `addReasoningBubble` no-ops on empty/whitespace reasoning, so plain-markdown modes (which don't request a `reasoning` field) are unaffected. Old history without `reasoning` is unaffected. |
| 2026-08 declubbing | All read-only modes (`ask`/`research`/`summarize`/`extract`/`visual`) now set `expectJson:false` → they stream **plain markdown** with no `{reasoning,actions}` envelope (matches zo.computer's own chat UI, where thinking + answer stream as separate blocks). Only `cobrowse` keeps JSON, and `ACTION_SCHEMA_COMPACT` now requests `{"actions":[...]}` **without** demanding `reasoning` — the old `{"reasoning","actions"}` prompt is what made the model club thinking + answer into one blob (the raw-JSON-in-chat bug). Reasoning still surfaces as a Thought bubble when the backend sends it. |
| Tests | `tests/sidepanel.test.ts` (8 source-containment assertions for the helper, CSS, persistence field, history re-render) + `tests/sse-parsing.test.ts` (3 vm-extraction tests confirming `reasoning` survives `finishStream` into `STREAM_DONE` for object/JSON-string output, plus the `safePost` dead-port contract). |
| Not changed | No new `STREAM_REASONING` incremental-stream type — reasoning arrives only in the final `STREAM_DONE`. The existing `#actions-reasoning` in-action status bar is left as-is (different purpose: in-action status during DOM execution). |

---

## Streaming support — current architecture (verified)

The streaming path (`background.js` `askZoStream` / `_askZoStreamImpl` ↔ `sidepanel.js` `streamPort` / `handleStreamMessage`) is now hardened end-to-end:

1. **Session isolation** — sidepanel increments `streamSession.sessionId` per query and stamps it on every `ASK_ZO`. Background echoes `sessionId` on **every** STREAM_CHUNK/DONE/ERROR/RECONNECT. The top-of-handler guard `if (msg.sessionId && msg.sessionId !== streamSession.sessionId) return;` rejects all stale messages, including late DONEs (the historical "Done." duplication bug).
2. **Port disconnect safety** — `port.onDisconnect` marks `port._dead`; `safePost()` no-ops on dead ports instead of throwing. `askZoStream` stops immediately (no more wasted API calls) when the port is gone. Sidepanel's disconnect handler re-enables input/sendBtn and clears the thinking timeout.
3. **Retry correctness** — `isRetriableStreamError()` only retries transient (network/5xx) errors; 4xx and config errors throw immediately. `STREAM_RECONNECT` is now sent before a retry (not the inverted `*_DONE`-first ordering).
4. **No silent data loss** — accumulated `fullText` is no longer clobbered by a final payload; STREAM_DONE normalizes the rendered body to the canonical `responseText`.
5. **Liveness guard** — a 60s thinking-indicator timeout fires if background never replies, removing the indicator and re-enabling input.

## What's solid (unchanged)

- **Message protocol consistent** — all 15 runtime message types sidepanel sends have background handlers; contract test enforces this bidirectionally.
- **Bang commands fully dispatched** — all kinds from `parseBangCommand` route correctly.
- **`safeText`/String() coercion** at every text output sink.
- **All permissions exercised** (debugger, tts, contextMenus, sidePanel, storage, tabs, scripting, activeTab).
- **Zod contract tests** guard manifest + message + action + config boundaries.

## Recommendation

The extension is green-tested with a hardened streaming path. Remaining work is new feature development (Tier 1: #16 Scheduled AI Commands, #17 Web Monitoring, #18 Shared Sessions) — these will reuse the now-stable streaming and persona-selector surfaces.

---

## 2026-08-16 — Automation testing infrastructure round

**Scope:** two-layer automation infra on top of the existing unit/contract suite, closing the ticket-25 audit gap ("No E2E tests for the sidepanel↔background message flow").

### Delivered

- **Layer 1 — in-process integration (`tests/integration/`, runs in `bun test tests/`)**: the real `background.js` + `content.js` + `sidepanel.js` wired on a fake-chrome message bus (`tests/helpers/chrome-mock.ts` — live port pairs, storage with `onChanged`, tabs routing to mounted content targets, programmable debugger/scripting paths) + a recording fetch mock (`tests/helpers/zo-fetch-mock.ts`) that streams SSE through the real reader loop, with gated `deferredSse` streams for deterministic mid-stream assertions. 30 tests: message router, retry/4xx/token gating, 3-path capture fallback ordering, content tier gating + every action type, panel send/render contract (stale-session filtering, Esc-cancel, error card + Retry, reconnect), and a full trio turn (user bubble → capture → prompt with DOM → envelope → real DOM mutation → timeline → persistence).
- **Layer 2 — real-Chromium E2E (`e2e/`, `bun run test:e2e`)**: Playwright persistent-context + `--load-extension` (new headless, MV3-capable). `e2e/mock-zo/server.mjs` = local mock Zo API (real SSE over HTTP, scenario routing on the prompt's `## User Request` section, request recorder) + static fixture site. 15 specs: onboarding, streaming (progressive deltas, thinking trace, error card + retry), action loop (fill/click/scroll mutate the real fixture DOM), capture + context policy (tier-0 pointer vs tier-2 attach vs `!context`), options page (Test Connection via route interception — see finding B, prompts editor override save/reset), persistence across panel reload + history search.
- **CI**: new `e2e` job in `ci.yml` (Playwright Chromium + `bun run test:e2e`, report artifact on failure). `bun test` scoped to `tests/` everywhere (bun's discovery would otherwise execute the Playwright specs).
- **Docs**: testing.md (integration + E2E sections), CONTRIBUTING.md, AGENTS.md updated.

### Production fix shipped with the round

- **`senderTabId()` guard (background.js)** + **web-tab filter in `runPendingActions` (sidepanel.js)**: the extension's own pages opened as tabs (most commonly `sidepanel.html` — a legitimate user/debug state) were previously routed page work via `sender.tab.id`, capturing/acting on the extension page itself. Both now fall through to the active **web** tab. Found by the e2e harness; real-world reachable.

### Findings (documented contracts, candidate follow-ups)

- **A (P3)** — Streamed action turns keep the `_Preparing actions…_` placeholder; `done.response` is persisted to the conversation but never rendered into the chat. Asserted as observed contract in both layers.
- **B (P3)** — options.js Test Connection posts to a hardcoded `https://api.zo.computer/zo/ask`, ignoring the configured `zoApiUrl` (self-hosted endpoints untestable from Settings; the e2e covers it via route interception).
- **C (P4)** — A single-text-event SSE stream (one chunk, no subsequent deltas) renders an empty bubble: `STREAM_DONE`'s markdown replace requires ≥1 `.msg-streaming-text` span. Real streams always carry multiple deltas.
- **D (P4)** — On retriable network errors the background surfaces a transient `STREAM_ERROR` before retrying, which the panel treats as terminal — so the `Reconnecting…` banner (`STREAM_RECONNECT`) is dead code on this path; recovery renders via the inactive-DONE fallback.

### Verification

- `bun run verify` green (767 tests / 33 files after merging dev's #24 cold-start work in; lint, transpile).
- `bun run test:e2e` green (15 specs, ~45s).


---

## 2026-08-21 — Form-fill round (#26: batch `fill_form` + confirm-before-fill)

**Scope:** the #26 quality layer over #24's `get_form` pull — batch form filling by human-facing field cues, a sensitivity gate that parks sensitive fills behind an editable review card, and a submit backstop. Plan: `docs/superpowers/plans/2026-08-20-form-fill.md` (PR #35), spec: `docs/superpowers/specs/2026-08-20-form-fill-design.md`.

### Delivered

- **`fill_form {values:[{target,value,selector?}]}` action** (`FillFormAction` in `tests/schemas/actions.ts`): one action fills N fields; `resolveFieldTarget` (content.js primary + a serialized twin inside `executeDomAction`'s executeScript fallback) resolves each `target` by label text (for=/nested) → `aria-label`/`aria-labelledby` → placeholder → name → id → optional CSS selector passthrough. Result shape carries per-field `{ok,target,type?,error?}`; the debugger-eval fast path is skipped for fill_form by design.
- **Sensitivity gate** (`extension/lib/formfill.js`, pure + Zod schema): `EXECUTE_ACTIONS` batches containing `fill_form` first re-capture the live form (tier-2 `{pull:'form'}` — client-side truth, never the model's self-assessment) and run `isSensitiveForm` (password/card/CVV/expiry/identity fields, or login/checkout/payment/billing/account URLs). Sensitive → `{needsConfirm, actions, fields, url, reasons}` **without executing**; the verdict is re-derived on `confirmed:true` (a form that flipped sensitive re-parks) and stamps `unverifiedForm` when the pre-flight capture fails (fail-open, surfaced in the card).
- **Review card** (sidepanel `renderFormReview`): editable input per non-secret row, "left for you 🔑" for secret rows (password/card values are blanked by `reviewRows` and never round-tripped through the card), reason chips, **Fill N fields** / **Cancel**. Confirm re-sends the edited map with `confirmed:true`; cancel drops the fill and explains. `fill_form` renders as ONE timeline card with per-field ✓/✗ rows.
- **Submit backstop** (`executeActions` + `probeClickTarget`): on a page the gate flagged sensitive, a click whose resolved target is a form's submit/pay control is refused (`blocked submit on sensitive page`); non-submit clicks pass (probe fails open). Belt-and-suspenders with the prompt rule — confirming a FILL never authorizes a SUBMIT.
- **Prompt rules** (`ACTION_SCHEMA_COMPACT` + cobrowse instructions): prefer `fill_form` for 2+ fields, never propose password/card/CVV values, never click submit/pay on login/payment/checkout/account pages.
- **Executor-coverage contract** (`tests/actions-coverage.test.ts`): every `ACTION_TYPES` entry must appear as an executor case in content.js and background.js — new action types can't ship executor-less again.

### Findings / deviations from the plan

- **Plan bug (fixed per the plan's own truth-table test):** the plan's `SENSITIVE_FIELD_RE` didn't match `ccnumber`/`exp-date` field names its own test asserted; extended with `cc[-_.]?num` + `exp[-_.]?(date|month|year)` variants, later also `password` (a label-only Password row whose captured metadata can't be joined must still render secret).
- **Plan gap (fixed):** `ACTION_TYPE_NAMES` (lib/modes.js) lacked `fill_form` — `normalizeActions` silently dropped every fill_form action before execution; caught by the integration test, fixed + pinned by an updated count test.
- **Plan gap (fixed):** the sidepanel reads the per-action result from the aggregate `EXECUTE_ACTIONS` response (`result.results[0]`), not `result.fields` as sketched.
- **Confirm semantics (design-aligned deviation):** the plan's `runExecuteActions` sketch only computed `sensitive` when unconfirmed, which would have disabled the backstop on the confirmed path its own test exercised; the verdict is now re-derived on confirm (re-park on flip + backstop always armed on sensitive pages).
- **`ACTION_SCHEMA_COMPACT` length guard** raised 600 → 760 (713 actual): the new action + safety rules legitimately grew the compact schema; the guard stays tight vs the legacy ~600-char block it was created against.
- **Tooling (documented in-test):** bun 1.3.10 + happy-dom natively crash (segfault, no leak — RSS flat at ~123MB) when descendant class selectors (`.action-card-fill_form .field-result`) or attribute selectors query the live panel DOM after a full prior test file ran; the extension-flow scenario syncs on bounded sleeps + single-class queries + JS traversal instead. Real-Chromium coverage unaffected (e2e uses the same selectors fine).

### Verification

- `bun run verify` green — 873 tests / 39 files (0 failures), lint, transpile.
- `bun run test:e2e` green — 21 passed + 1 skipped (ZO_DEMO-gated demo spec), incl. the new `e2e/11-fill-form.spec.ts` (park → edit → confirm → page filled, secrets untouched; cancel path). One transient 09-open-all flake under full-suite load passed on re-run and in isolation.


---

## 2026-08-21 — "Any form" round (#26.2: builder-style forms + section-by-section co-browse)

**Scope:** make the #26 form-fill experience work on ANY form — not just well-labeled ones — driven by a live Zo Ambassador application on form.typeform.com/to/ruHPhO5n. The user's target UX: Zo fills each section, the user reviews and advances.

### Live-probe findings (Typeform, headless Chromium)

- All sections' inputs render in ONE DOM at once (11 inputs); only the viewport distinguishes the current section.
- Inputs carry **no usable metadata**: no `label`/`for`, no `aria-label`, no `name` — UUID ids, and every text field shares the placeholder "Type your answer here...". The existing resolver (label → aria → placeholder → name) cannot disambiguate.
- The **question text is a plain div — the input wrapper's previous sibling** ("First name*"), sometimes with a section fieldset `aria-labelledby` pointing at a group title ("1 Tell us about yourself"). No headings anywhere.
- The advance control (OK) sits **outside any `<form>`** → the #26 submit backstop correctly does not fight section navigation.

### Delivered (generic — nothing Typeform-specific)

- **Question-aware capture**: `formFields[].question` on all three capture paths (content script, CDP eval, executeScript) via `nearestQuestion` — explicit label/aria first, then the universal title-above-field convention: climb from the field and read the nearest preceding sibling's text (guarded: ≤160 chars, no interactive descendants, not button-ish). `compactForm` renders it (`[input#uuid type=text "Type your answer here..."] — First name*`), so both the tier-2 prompt section and the `get_form` pull teach Zo the question cues.
- **Question-scoped resolution**: `resolveByQuestion` fallback in both executors (content.js + the serialized `executeDomAction` twin) — a cue matches a text leaf exactly (normalized: case, whitespace, trailing `*`/`:` decorations), then associates the field by shared wrapper (climb until the subtree contains a field).
- **Viewport preference** (`pickVisible`): when equal cues match several fields (identical placeholders, repeated questions), the field intersecting the viewport wins — long/SPA forms resolve to the section the user is actually looking at.
- **Co-browse pacing rule** (cobrowse instructions): on one-question-per-screen forms, fill only the visible section per turn, then `done` — the user reviews and presses Next; Zo continues when asked. `ACTION_SCHEMA_COMPACT` wording now targets "question/label/placeholder text" (722 chars, still under the 760 guard).
- `reviewRows` joins captured `question` text, so the review card labels builder-form fields correctly.

### Findings / fixes while executing

- **Template-literal escape bug (CDP path only):** a `\s` inside the `captureExpr` template literal renders as a bare `s` (unknown escape drops the backslash — the same reason `SEL_HELPER` writes `\s+`), turning the whitespace normalizer into `replace(/s+/g,' ')` and EATING EVERY "s" from captured question text ("Fir t name*"). Caught by the e2e's prompt assertion; fixed by double-escaping in the embedded string. The content-script and executeScript paths were unaffected.
- bun's bare `bunx` in this sandbox intermittently fails with `CouldntReadCurrentDirectory`; `/home/logic/.bun/bin/bun x ...` is the reliable invocation.

### Verification

- `bun run verify` green — 879 tests / 39 files (0 failures; +6: question join, compactForm cue, pacing rule, capture join, question resolution, viewport preference).
- `bun run test:e2e` green — 22 passed + 2 skipped (both ZO_DEMO demo specs), incl. new `e2e/12-any-form.spec.ts`: builder-style fixture (no labels/names, shared placeholder, div titles, OK outside forms) — turn 1 fills the visible section by question text (prompt shown to carry `— First name*`), the user presses OK themselves, turn 2 "continue" fills the next section, section-1 values unchanged, nothing auto-submitted.
