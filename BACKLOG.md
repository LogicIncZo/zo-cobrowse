# Zo Co-browse — Backlog

> Updated 2026-08-20 — v0.1.0 released 2026-08-19; **0.2.0 planned** (see the 🎯 section).
> All QA-report findings from the 2026-08-08 round are **resolved**
> (see `QA_REPORT.md` remediation log). Remaining items are feature work.
> An **infrastructure round** (2026-08-09) added the loop-engineering gate, CI on
> all branches, and a dormant release workflow — see below.

## Current state

- **Branches:** `Rewritet` merged → `main` (fast-forward, 22 commits); working tree clean
- **Tests:** ✅ **534 pass / 0 fail** (24 files, 1381 expect() calls)
- **Loop engineering:** `bun run verify` gate + committed hard-gate pre-commit hook (`bun run setup-hooks` to install)
- **CI/CD:** CI runs on every branch push + PR to `main` (tests + transpile + release checks + zip artifact); `.github/workflows/release.yml` publishes `v*` tag releases (used for v0.0.2)
- **Streaming:** hardened end-to-end (sessionId isolation, port-disconnect safety, retry correctness, 60s liveness timeout)
- **P0/P1/P2/P3 QA findings:** all closed (P2-31 deferred by design — see below)
- **Release:** ✅ **v0.1.0** tagged + GitHub release published (2026-08-19). Next milestone: **v0.2.0** (section below); Chrome Web Store submission (#11) stays its own 0.2.x milestone

## ✅ Completed this round

| IDs | Summary |
|-----|---------|
| B-01 | Fix malformed `background.test.ts` → green suite |
| B-02..05 | P0: context-menu crash, persona dropdown, enabledMenus key, addSystemMessage XSS |
| B-06..08, B-11 | Streaming port disconnect + retry lifecycle (safePost, onDisconnect, input re-enable) |
| B-07 | sessionId echo on all STREAM_* messages |
| B-09 | Delete dead duplicate `sendQuery` (~120 LOC) |
| B-10 | Snapshot `pendingActions` against Skip race |
| B-12..13 | enabledMenus startup load + content.js navigate/done/default |
| B-14..15 | Correct shortcut docs + Reset-to-defaults |
| B-16..20 | Background robustness (fullText guard, captureVisibleTab tab, NAVIGATE validation, testConnection casing, apiOrigin) |
| B-21..26 | Sidepanel robustness (dead vars, thinking timeout, text coercion, STREAM_DONE normalize, config cleanup, sandbox CSP removal, tts-rate input) |
| B-27..30, B-32 | P3 polish (bot→assistant, badge normalize, dead code removal, session.catch) |
| B-28 | Action timeline + DuckDB CSS |

## Deferred (by design)

- **B-31** — Default `zoSpaceEndpoint` is tenant-specific (`cashlessconsumer.zo.space`). Left as-is because it's the documented working integration host (AGENTS.md references it as the landing page) and changing it would break the active setup. Users can override via the `#space-endpoint` field.

## 🚀 Feature backlog (from `AGENTS.md`)

| Tier | Ticket | Status | Notes |
|------|--------|--------|-------|
| Tier 1 | #16 Scheduled AI Commands | → folded into **#29** (0.2.0) | Unify with monitoring under one task engine |
| Tier 1 | #17 Web Monitoring & Page Change Detection | → folded into **#29** (0.2.0) | Zo verdicts + notifications; cloud checks deferred |
| Tier 1 | #18 Shared Sessions (multi-participant) | P1 — `backend/relay.ts` exists, extension integration not done | Deferred past 0.2.0 (analysis §5) |
| Tier 1 | #19 Multi-Model Selection UI | spec'd — **0.2.0** | `docs/superpowers/specs/2026-08-20-model-picker-design.md` |
| Tier 1 | #20 Tab Compare / Side-by-Side | P1 — depends on #10 | After #10's actions half (0.2.0) |
| Tier 2 | #21 Page Context Export (PDF/MD) | P2 | |
| Tier 2 | #14 Page Monitoring (basic) | → folded into **#29** (0.2.0) | |
| Parity | #10 Multi-Tab Context | P3 — context half DONE (`feature/tab-contexts`): tab references (manifest + excerpt + `read_tab` on-demand, chip strip + `@` mention); cross-tab actions + tab management remain — **spec'd for 0.2.0** (see 🎯 section) | Spec: docs/superpowers/specs/2026-08-14-tab-contexts-design.md + 2026-08-20-cross-tab-actions-design.md |
| Parity | Chat tabs + chat management (no ticket) | DONE 2026-08-15 (`feature/tab-interface`): chat tab bar (≤8 open, per-chat Zo threads + context state, streams survive switches, parked `pendingActions`), history-view rename + search | Spec: docs/superpowers/specs/2026-08-15-chat-tabs-design.md; follow-ups (pin/export, multi-window sync) open |
| Parity | #27 Cold-start + research → "open all" tabs | DONE 2026-08-15 (`feature/newtab`): blank/new-tab pages skip page context entirely (no debug banner, no hard-block, no T1/`## Page` noise — `isBlankPage`/`pageBlank`); link-chips card + `Open all (N)` on prose answers (first-fg/rest-bg) auto-adds opened tabs as reference chips. **E2E coverage + demo video added 2026-08-18** (`chore/verify-open-all`): `e2e/09-open-all.spec.ts` (card render, Open all → real tabs, first-fg active-tab check, strip `(3/4)` referenced chips, single-chip foreground open) against a new `links` mock scenario; demo recording via `ZO_DEMO=1 bun x playwright test -c e2e/playwright.config.ts demo-open-all` → `demo/open-all-demo.mp4` (gitignored artifact) | Spec: docs/superpowers/specs/2026-08-15-cold-start-open-all-design.md |
| Parity | Image/file upload, #23 Workflow Recording, Download files, Risk dialogs, #11 Web Store Listing | P3–P4 | |

## 🎯 0.2.0 — planned 2026-08-20 (competitive round)

Scope chosen in-session ("Everything" option) against a full competitive scan of the Aug-2026 field — agentic browsers (Comet/Dia/Opera/Fellou, Atlas sunset), companion extensions, monitoring + agentic-checkout categories. Full analysis + deferred-with-rationale list: **`docs/superpowers/specs/2026-08-20-0.2.0-competitive-analysis.md`**. Owner decision: features only — **no** #11 store listing in this milestone.

| ID | Feature | Design spec | Implementation plan | Notes |
|----|---------|-------------|---------------------|-------|
| #19 | Model picker — per-chat override, catalog badges (👁 vision / ⭐ free / ⚠ deprecated), options-page pre-token fix | [model-picker-design](docs/superpowers/specs/2026-08-20-model-picker-design.md) | [plan](docs/superpowers/plans/2026-08-20-model-picker.md) | build **first** (smallest; `ASK_ZO.modelName` plumbing already exists) |
| #26 | Form-fill — batch `fill_form` by label cues + confirm-before-fill review card + submit backstop + no-secrets rule | [form-fill-design](docs/superpowers/specs/2026-08-20-form-fill-design.md) | [plan](docs/superpowers/plans/2026-08-20-form-fill.md) | layer 1 (`get_form`) shipped with #24; the pre-fill review table is a differentiator nobody ships |
| #10 | Cross-tab actions — `"tab":"Tn"` targeting + `open_tab`/`close_tab`/`switch_tab` verbs, tab-routed parked actions | [cross-tab-actions-design](docs/superpowers/specs/2026-08-20-cross-tab-actions-design.md) | [plan](docs/superpowers/plans/2026-08-20-cross-tab-actions.md) | completes the 0.1.0 context half |
| #29 | Watch & Scheduled Tasks — page watches (snapshot→diff→Zo verdict→notify) + scheduled prompts + monitor→act bridge | [watch-tasks-design](docs/superpowers/specs/2026-08-20-watch-tasks-design.md) | [plan](docs/superpowers/plans/2026-08-20-watch-tasks.md) | **unifies #14 + #16 + #17**; bridge = the wedge (detect → notify → act → *confirm*) |

**Build order: #19 → #26 → #10 → #29** (each independently shippable; #29's bridge consumes the other three). Deferred past 0.2.0 with rationale (analysis §5): memory, voice, post-hoc undo, payment rails, #15/#18 shared sessions, cloud/browser-closed checks (FCM), #20, #21, #11.

## 🧪 Proposed 2026-08-15 — brainstormed, pending triage

> Design-exploration outcomes (approach already chosen, not yet spec'd or built).
> Suggested build order: **#24 → #25 → #26** — #25's verification spike is tiny/independent and can go first or parallel; #26's quality layer depends on #24's `get_form`.
> API facts verified against the live OpenAPI spec (2026-08-15): `/zo/ask` accepts **string `input` only** — no attachment, image, or content-block fields, and there are **no MCP/tools/integrations endpoints**. `/models/catalog` (no-auth, cached) exposes `supports_images` per model.
> #28 appended 2026-08-16 (intake request) — independent of #24–#26 except the optional `read_file` pull, which would reuse #24's loop.

| ID | Feature | Chosen approach | Notes |
|----|---------|-----------------|-------|
| #24 | Context-on-demand (pull protocol) | **DONE 2026-08-16 (`feature/pull-contexts`)**: `lib/pull.js` generalizes the read_tab loop into a pull mechanism — new context-only actions `read_page` / `get_dom` / `get_form` fetch full page text / the complete element map / all form fields INSIDE the same stream (`finishStreamWithPullLoop`, shared 3-cycle budget, send-once per `kind:page-hash` via `tabsSent`). `CONTEXT_ACTION_NAMES` + `isContextAction` gate every executor path (also fixes the latent bug where canonical `read_tab` was stripped by `normalizeActions`). | True **MCP server** (relay-hosted browser tools, Zo as MCP client) remains a research spike — note Zo NOW exposes its own toolchain as an MCP server (2026-08-18, used by #28); a browser-tools MCP serving Zo would be the inverse direction. If built, pull actions translate 1:1 into MCP tools. Cost: each pull = one extra LLM round-trip. |
| #25 | Vision-gated screenshots | **DONE 2026-08-16 (`feature/vision-gated-screenshots`)**: `lib/vision.js` gates tier-3 `captureVisibleTab` on `/models/catalog` `supports_images` — non-vision models skip the capture (token + IPC savings), unknown support keeps capturing (backward-compatible). New no-auth catalog fetch (`fetchModelCatalog`, 5-min cache, `GET_VISION_CATALOG` message); sidepanel suggests a vision model when Visual mode is picked with a known non-vision model. **Live probe still pending** — the verify-then-gate step 1 (does the data-URL image actually reach a vision model?) needs a one-time live run via `tests/test-prompts/`; until then the gate trusts the catalog flag. | If the eventual probe fails, this becomes transport-discovery work — tier 3 is dead until Zo adds image support to the API. |
| #26 | Form filling: batch + robust + confirm | Three layers: (1) `get_form` pull action → complete form schema (all fields, types, options, required, label associations) — the robustness fix for budget-sliced 30-field capture; (2) batch `fill_form` action — selector→value map applied atomically, field targeting via label text / `aria-labelledby` / placeholder proximity (not bare CSS selectors), rendered as ONE action-timeline card with per-field results; (3) confirm-before-fill for sensitive forms (heuristic: password/card/CVV fields or login/checkout URLs) — Zo proposes the value map, sidepanel shows an editable review table, one Confirm executes. | **Saved profiles/identities explicitly out of scope** (owner decision 2026-08-15). Depends on #24 for `get_form`; batch fill + confirm UX could ship independently if triaged first. |
| #27 | Cold-start research → "open all" tabs | **SHIPPED 2026-08-15 — see the DONE row in the table above** (kept here only as the original proposal text). | Superseded by the feature-backlog row. |
| #28 | Composer reference pickers: `/` skills + `%` Zo files | **DONE 2026-08-18 (`feature/composer-pickers`)**: both pickers ship over Zo's **live MCP server** (`api.zo.computer/mcp` — discovered 2026-08-18, superseding the "no listing API" constraint below). `/` enumerates `/home/workspace/Skills` (SKILL.md frontmatter → name/description) via one `bash` round-trip (`LIST_SKILLS`, 5-min cache); selecting arms a send-once ⚡ chip that rides the turn as a `## Skills to Run` prompt section (Zo reads its own SKILL.md server-side). `%` browses the workspace via validated `ls -1F` calls (`LIST_WORKSPACE_DIR`, dirs navigate, `⬆ ..` climbs, paths confined to `/home/workspace` — traversal rejected client-side); picked files ride as a paths-only `## Referenced Files` manifest. Chips preview in the prompt inspector; `lib/mcp.js` + `lib/pickers.js` are the pure halves. Original proposal text: mimic Zo's UI reference affordances reusing the `@` tab-autocomplete machinery as the template; `@` stays tabs; Zo-UI's `@`-files maps to `%`. | **Follow-up not built:** the optional `read_file {path}` pull action (would mirror `read_tab` through #24's generalized pull loop). **MCP facts (live-verified):** server `zo-tools v1.0.0`, 96 tools, initialize → `mcp-session-id` header → tools/call; `list_directory` recurses + truncates at 1000 entries (why the pickers use `bash`); the `bash` tool wraps stdout in a Python-repr `CmdResult(...)`; **no skills-listing tool** — skills are folders, `/root/.agents/skills` is other-agent CLIs (excluded by owner decision). |
