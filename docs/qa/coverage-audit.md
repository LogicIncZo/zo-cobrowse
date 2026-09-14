# Test Coverage Audit — 0.9.0 pre-slate sweep (chore/test-coverage)

**Date:** 2026-09-14 · **Baseline:** `chore/test-coverage` (off dev `a064170`) · 1238 tests / 56 files, all green (`bun run verify`).
**Reproduce:** `bun run test:coverage` (CI runs the same on every push/PR and uploads an lcov artifact — job `test`, step "Upload coverage").
**Previous audit:** 0.2.6 (#66, 2026-08-30, dev `c678dd1`, 1012 tests / 43 files) — superseded by this one.

## Per-module snapshot (line / branch %)

| Module | Line % | Branch % | Verdict |
|---|---|---|---|
| `extension/lib/*` (23 modules) | 88.89–100 | 88.89–100 | ✅ **complete** — every module under a Zod schema contract (see AGENTS.md verification table). `formfill.js` hit **100/100** this sweep (`fillBatchRows` was the last untested export); the former 80/78 weakest spot is gone |
| `extension/background.js` | 67.08 | 47.92 | ⚠️→ see the multi-instance note below: the aggregate now reports only the FIRST `?file=` instance. Behaviorally, every previously-dark utility handler + listener surface is exercised by the new integration files (solo-run evidence below) |
| `extension/sidepanel.js` | 71.18 | 64.61 | ⚠️ same harness; was 70.33/63.03 — gained PENDING_ZO_QUERY pickup, TTS speak/interrupt/stop, STT unsupported-degradation; still dark: chat-tab render branches, history view, mode-creation flow (partially e2e-covered) |
| `extension/content.js` | 12.77 | 12.54 | ⚠️ **aggregate is not meaningful** — content.js runs as one instrumented module instance plus several `new Function` executions (not instrumentable); the number reflects one instance only. Dead-page guard now behaviorally tested |
| `tests/helpers/*` | 61–80 | — | harness code; uncovered branches are tolerance paths |
| `tests/schemas/*` | 100 | 100 | ✅ (`formfill.ts` grew `FillBatchRowSchema`) |

## Reporting artifact: one instance per cache-busted import (read before comparing numbers)

Integration tests import background.js/content.js with unique `?file=` query strings so each
test file gets a module instance bound to ITS fake bus (bun shares one module registry per
process — see `tests/integration/background-flow.test.ts` header). Bun's coverage collapses
those instances to ONE report row per source path, so:

- `extension/background.js` in the aggregate = the first-loaded instance (`background-flow`) only.
  **Solo-run truth for the new files:** `handlers-flow` alone → 40.48/23.16; `listeners-flow` alone → 39.53/19.96 — and their dark-line lists no longer contain the handler/listener ranges this sweep targeted (1026–1102 context menu, 1105–1117 reinject, 1122–1177 commands, 1179–1243 omnibox, 1838–2077 catalog/testConnection/generateMode, 2644–2836 save/skill/automations/DuckDB).
- Keep that quirk in mind for future ratchet comparisons: a "drop" that coincides with import-order changes may be reordering, not regression. Verify with a solo `bun test <file> --coverage` before blocking.

## What this sweep added (+64 tests, +3 files)

| File | Tests | Covers |
|---|---|---|
| `tests/integration/handlers-flow.test.ts` (new) | 24 | SAVE_PAGE (path derivation, markdown attribution, error mapping), RUN_SKILL, CREATE/LIST_AUTOMATIONS (RRULE default), DUCKDB_QUERY, TEST_CONNECTION (green / API-down / r.ok fallback), LIST_MODELS/LIST_PERSONAS, GET_VISION_CATALOG (no-auth + #73 session-cache dedupe), GENERATE_MODE (validated against `GenerateModeResultSchema`), GET_OPEN_TABS (MRU + capturable filter), GET_TAB_CONTEXTS (join + degraded base), NAVIGATE |
| `tests/integration/listeners-flow.test.ts` (new) | 21 | context-menu clicks (page/selection/link/save ✅+❌/fill), `PENDING_ZO_QUERY` parking + broadcast, keyboard commands (new-chat/summarize/extract/_execute_action), omnibox (started/changed/entered, `!`-normalization, no-op guard), onInstalled update→reinject + install no-flag, onStartup menu re-create, debugger onDetach cleanup via a real CDP fast-path capture |
| `tests/integration/no-token-flow.test.ts` (new) | 7 | the no-token guard branches (SAVE_PAGE, DUCKDB_QUERY, LIST_MODELS, LIST_PERSONAS, GENERATE_MODE, TEST_CONNECTION) against a fetch mock that refuses every request — pins "no fetch attempted" |
| `tests/integration/extension-flow.test.ts` (+3) | 3 | PENDING_ZO_QUERY broadcast → composer + auto-send, TTS footer speaker (speak / interrupt / same-button stop), STT mic honest degradation without SpeechRecognition |
| `tests/integration/content-flow.test.ts` (+1) | 1 | dead-page guard: CAPTURE_CONTEXT on `about:` degrades with `Extension context unavailable` (Function-recipe instance) |
| `tests/formfill.test.ts` (+5) | 5 | `fillBatchRows` join matrix (placeholder/question/name/selector), secret blanking + redaction, plain-fill label fallback, non-fill/null tolerance — rows validated against the new `FillBatchRowSchema` |
| `tests/sse-parsing.test.ts` (+3) | 3 | `isRetriableStreamError` directly from source (vm-extracted): retriable (network/5xx/aborted/unknown) vs terminal (token/4xx/parse), case-insensitivity |

## Structural blind spots (unchanged findings)

1. **The side-panel shell is untestable by automation.** Playwright opens the panel as a *tab*; CDP cannot drive the real panel UI. Mitigation: the release manual-QA checklist (`docs/qa/manual-panel-checklist.md`) before every `dev → main` promotion.
2. **`content.js` DOM-executor branches** stay e2e-first (specs 03/07/11–15) — grow vm/happy-dom executor scenarios when a bug lands there (pattern: `tests/integration/content-flow.test.ts`).
3. **Background SSE retry corners** now have direct predicate coverage (`isRetriableStreamError`, this sweep) on top of the end-to-end network-fail/4xx scenarios in `background-flow.test.ts`; a `deferredSse` scenario per remaining retry path is still open, not blocking.

## Ratchet policy (unchanged)

- **No hard threshold** — report-only in CI (lcov artifact on every run) + this committed audit refreshed each milestone; any module that **drops** vs. the previous audit blocks its own PR in review (mind the instance-collapse artifact above before calling a drop).
- Revisit a numeric ratchet once #67 debug-mode telemetry gives real usage-weighted hot paths.
