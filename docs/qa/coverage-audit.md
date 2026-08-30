# Test Coverage Audit — 0.2.6 (#66)

**Date:** 2026-08-30 · **Baseline:** dev `c678dd1` · 1012 tests / 43 files, all green.
**Reproduce:** `bun run test:coverage` (CI runs the same on every push/PR and uploads an lcov artifact — job `test`, step "Upload coverage").

## Per-module snapshot (line / branch %)

| Module | Line % | Branch % | Verdict |
|---|---|---|---|
| `extension/lib/*` (17 modules) | 80–100 | 78–100 | ✅ **net complete** — every module under a Zod schema contract (see AGENTS.md verification table); `formfill.js` (80/78) is the weakest, on its secret-detection edge cases |
| `extension/background.js` | 60 | 42 | ⚠️ exercised via the integration bus for the main paths (ASK_ZO stream, picks, watch, executors); dark: SSE reconnect/retry corners, context-menu/omnibox/automation handlers |
| `extension/sidepanel.js` | 62 | 56 | ⚠️ same harness; dark: chat-tab render branches, history view, theme popover, mode-creation flow |
| `extension/content.js` | 41 | 36 | ⚠️ capture + write-assist covered; dark: `executeDomAction` branches (scroll/wait/extract variants), form-resolve fallbacks — the e2e suite covers several of these in a real browser instead |
| `tests/helpers/*` | 61–80 | — | harness code; uncovered branches are tolerance paths |
| `tests/schemas/*` | 100 | 100 | ✅ |

## Structural blind spots (the audit's real findings)

1. **The side-panel shell is untestable by automation.** Playwright opens the panel as a *tab*; CDP cannot drive the real panel UI. This is exactly how #62 shipped: native `<select>` popups dead on mouse click in the panel only. **Mitigation shipped this milestone:** the release manual-QA checklist (`docs/qa/manual-panel-checklist.md`) — run before every `dev → main` promotion; any new panel-shell-sensitive control must appear on it.
2. **`content.js` DOM-executor branches** are covered e2e-first (specs 03/07/11–15) rather than unit-first — acceptable, but the vm/happy-dom harness should grow executor scenarios when a bug lands there (pattern: `tests/integration/content-flow.test.ts`).
3. **Background SSE retry/reconnect corners** (`isRetriableStreamError`, port-disconnect mid-retry) are partially covered by `tests/integration/` deferred-SSE mocks; the uncovered remainder needs a `deferredSse` scenario per retry path — queued for 0.2.7, not blocking (last real-world failure class there was fixed + regression-tested in PR #31).

## Ratchet policy

- **No hard threshold yet** — a cliff gate on day one would be red (sidepanel/content are structurally DOM-heavy). Policy: *report-only in CI* (lcov artifact on every run) + this committed audit is refreshed each milestone; any module that **drops** vs. the previous audit blocks its own PR in review.
- Revisit a numeric ratchet in 0.2.7 once the #67 debug-mode telemetry gives real usage-weighted hot paths.

## Gap-fill landed this milestone (for the record)

| PR | Tests added |
|---|---|
| #76 | `tests/sw-cache.test.ts` (9) + mcp-flow restart-survival + truncate/recover cycle |
| #77 | tier-0 single-disclaimer dedupe tests |
| #78 | theme live-sync (panel) + write-assist dark class (content) |
| #79 | e2e honest zero-voice TTS state |
| #80 | same-host tab disambiguation (strip + @ popup) |
| #81 | header-page layout contract tests |
| #82 | e2e folder-as-context round-trip |
| #83 | DOM-toggle cap matrix + screenshot-only prompt + integration |
| #84 | select-shim interaction test (change → applyMode) |
