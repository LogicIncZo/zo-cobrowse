# QA Agent — in-repo issue-hunting pipeline (design spec)

- **Date:** 2026-09-10
- **Status:** Approved by owner (2026-09-10, in-session)
- **Related:** `docs/superpowers/specs/2026-09-03-0.2.8-stabilization-slate-design.md` (the bash this serves — this pipeline industrializes its "Find" step), `docs/qa/manual-panel-checklist.md`, `QA_REPORT.md`, `BACKLOG.md`

## Intent

0.2.0–0.2.7 shipped a large surface fast; the 0.2.8 stabilization bash needs bugs found faster than manual checklist passes allow. This spec defines a **QA agent**: an in-repo, agent-executable pipeline that hunts for issues on two grounds — **runtime** (driving the real extension in Chromium) and **code review** (judgment over shipped features) — and funnels everything into **one local findings queue** that gates releases.

Owner decisions pinned in-session (2026-09-10):

1. Both hunting grounds, one pipeline.
2. Packaged as an **in-repo agent workflow** (playbook + scripts + queue) — any agent session runs it on demand; no CI-scheduled LLM hunting.
3. Findings land **locally first**; the owner triages; confirmed bugs get GitHub issues per the existing 0.2.8 per-bug loop. Nothing auto-files.
4. **Release gate: the local findings queue must be empty.** Every finding is either fixed or logged on GitHub before a release ships — GitHub is the system of record for unfixed bugs.
5. Runtime exploration = **scenario matrix + freestyle explorer** (deterministic regression base, plus an LLM pass hunting novel flows).

## 1. Architecture — three pieces

| Piece | Location | Role |
|---|---|---|
| Playbook | `docs/qa/agent-playbook.md` | The agent's definition: round procedure, lane dispatch prompts, consolidation rules, triage workflow, stable-key conventions. A fresh agent session reads it and runs a full round with zero verbal context. |
| Scripts | `scripts/qa/validate-findings.ts`, `scripts/qa/qa-gate.sh` | Zod-validate every findings file (frontmatter + dedup by stable key); gate = validate + fail when the queue is non-empty. |
| Queue | `docs/qa/findings/` | One markdown file per finding. **Presence in the dir = unhandled.** Empty dir = releasable. |

Entry points (`package.json`):

- `bun run qa` — the cheap deterministic half: matrix suite + findings validation + queue status report. No LLM needed; anyone/CI can run it.
- `bun run qa:gate` — validation + empty-queue check; exit 1 with a listing of open findings otherwise.

## 2. Finding record, queue lifecycle, gate

One file per finding, e.g. `docs/qa/findings/qa-chat-tabs-close-mid-stream.md`:

```markdown
---
key: qa-chat-tabs-close-mid-stream
title: Closing a chat tab mid-stream orphans the stream session
severity: P1            # P1 | P2 | P3 | P3-flake
surface: chat-tabs      # surface name matching manual-panel-checklist sections
source: explorer        # matrix | explorer | review
found: 2026-09-10
---
Body: description, repro steps, evidence (file:line, screenshot path,
conversation id), suggested fix.
```

Frontmatter is the Zod contract (`tests/schemas/qa-findings.ts`): `key` matches `^qa-[a-z0-9-]+$` and is the dedup unit; `issue` is deliberately **not** a field — filing removes the file (see lifecycle).

**Lifecycle:**

1. Written by the consolidating agent at round end.
2. Owner triages each file:
   - **Fix** → normal `fix/*` branch per the 0.2.8 per-bug loop; the fix PR **deletes the finding file** (and still ships its regression test in `e2e/` or `tests/` per house pattern).
   - **File** → `gh issue create` (`bug` label, milestone `0.2.8`, evidence pasted), then **delete the finding file** and record `filed #<issue>` in the round's QA_REPORT.md entry. The GitHub issue carries the unfixed bug from there.
   - **Dismiss** → delete the file; append the dismissal + reason to QA_REPORT.md (a one-line entry if no round is in flight).
3. Dedup happens **before** writing: the consolidating agent matches lane candidates against each other, against open queue files (stable key + title similarity), and against GitHub (`gh issue list --label bug --milestone 0.2.8` keyword search). No duplicate files, ever.

**Gate semantics (owner-confirmed):** the gate checks the queue **directory is empty**. A known-but-unfixed bug does **not** block a release *if it is logged on GitHub* (filing clears the local queue; the 0.2.8 milestone tracks it). This matches the bash's own rule — unfixed bugs live on GitHub, the local queue only holds untriaged/unfiled findings.

**Gate wiring:** a CI `qa-gate` job in `.github/workflows/ci.yml` running `bun run qa:gate`, **required on PRs into `main`** (same pattern as the existing `drift` job gating release merges). Deliberately **not** part of the pre-commit `verify` gate — fix-work commits mid-round must not block while findings are open. Also run locally before any release-prep PR.

Malformed finding files fail validation, and therefore the gate — an unparseable queue cannot gate a release.

## 3. The round — four lanes, one consolidation

A **round** is the unit of work: run the lanes, consolidate, report. Each round appends an entry to `QA_REPORT.md` (existing convention: scope, findings count, filed issues, fixes).

1. **Matrix lane** (scripted, no LLM): `bunx playwright test -c e2e/qa-matrix/playwright.config.ts` — deterministic scenario specs per shipped surface against the real extension + `e2e/mock-zo/server.mjs`, reusing the existing `launchExtension` harness. A failing spec becomes a finding (`source: matrix`).
2. **Explorer lane** (LLM subagent): freestyle-drives the extension against the mock fixture site within a per-lane time budget (default 30 minutes; tuned per round in the playbook), hunting flows the matrix doesn't script. Output: anomaly list with repro attempts + screenshot paths; only anomalies with concrete evidence become findings (`source: explorer`).
3. **Review lanes** (LLM subagents, themed charters, target one or two shipped features per round): (a) spec-vs-implementation conformance, (b) text-safety / unsafe-sink scan (`safeText`/`String()` sinks, innerHTML, markdown paths), (c) error-path & resource cleanup (ports, listeners, timers, SW lifetime), (d) race/state-machine review (`streamSession`, chat-tab switches, handoff transitions). Candidates need file:line evidence (`source: review`).
4. **Consolidation** (orchestrating agent): dedupes per §2, drops unevidenced candidates, writes finding files, appends the QA_REPORT round entry, prints the queue status.

## 4. Matrix specs — `e2e/qa-matrix/`

- Own Playwright project (`e2e/qa-matrix/playwright.config.ts`, mirrored from `e2e/playwright.config.ts` — same webServer/mock-zo setup, `testDir` pointed at the new dir) so the PR-gating 34-spec `bun run test:e2e` suite stays fast. QA rounds run a big matrix without taxing every PR.
- Round-1 surfaces (top of the manual-panel-checklist): **chat tabs** (open/switch/close mid-stream, backgrounded accumulation, pendingActions restore), **history** (search, rename, delete), **options** (tabbed panes, prompts editor, dirty marker), **write-assist** (textarea + contenteditable popover flows), **composer pickers** (`/` skills, `%` files, send-once chips).
- The matrix grows one or two surfaces per round; it never shrinks. Explorer-pinned bugs get their repro pinned as a matrix spec **first** (repro-before-fix), then the fix ships the permanent regression spec in the normal `e2e/` suite.
- Matrix specs are verification scenarios, not the regression net — the regression net remains `tests/` + `e2e/`.

## 5. Error handling

- **Explorer can't reproduce deterministically** → finding files anyway with the attempted steps; triage decides (matrix spec pinning is the expected next step).
- **Matrix flakes** → the existing e2e rerun-once policy; a persistent flake becomes a `severity: P3-flake` finding instead of a silent skip or a disabled test.
- **Concurrent sessions** (another agent shares this working tree): file-per-finding minimizes collision surface; the playbook's consolidation step re-reads the queue dir immediately before writing.
- **Gate race** (finding written while a release PR is open): the CI job runs on the PR head — a finding added after the run doesn't block retroactively; the release-prep local `qa:gate` run is the backstop.

## 6. Testing the pipeline itself

- `tests/qa-findings.test.ts` — Zod schema + `validate-findings.ts` against fixture findings: valid, malformed frontmatter, bad severity enum, duplicate key.
- Gate script test — fixture dirs (empty / has findings / has malformed file) exercised via spawned subprocess asserting exit codes.
- CI `qa-gate` job green on an empty queue from day one.
- Success criteria for the agent: a fresh agent session runs a complete round from `docs/qa/agent-playbook.md` alone; a seeded finding blocks `qa-gate`; round 1 produces either findings files or a documented-clean QA_REPORT entry.

## 7. Docs updates

- `AGENTS.md` — Tests & scripts table (`qa` / `qa:gate` rows) + verification-layer table row for `tests/schemas/qa-findings.ts`.
- `CONTRIBUTING.md` — release-gate rule: dev→main promotions require an empty findings queue (qa-gate green).
- `BACKLOG.md` — the QA agent recorded under the 0.2.8 bash section as bash tooling.
- `QA_REPORT.md` — gains the round-entry format the playbook prescribes.
- `docs/superpowers/specs/2026-09-03-0.2.8-stabilization-slate-design.md` — verification matrix gains an asset row for this pipeline.

## 8. Scope boundary (YAGNI)

No auto-filing of GitHub issues. No scheduled/nightly CI hunting. No per-surface agent fleet. No findings database — plain files. No LLM inside `bun run qa`. The matrix is hand-grown per round. If round cadence later justifies automation (nightly matrix in CI, auto-filed deduped issues), that's a follow-up spec, not this one.
