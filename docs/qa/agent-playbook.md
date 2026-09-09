# QA Agent Playbook — zo-cobrowse issue-hunting pipeline

The QA agent is this document. Any agent session (or the owner) that can run
`bun` + Playwright executes a **round** by following it top to bottom. No other
context is required. Spec: `docs/superpowers/specs/2026-09-10-qa-agent-design.md`
· Implementation plan: `docs/superpowers/plans/2026-09-10-qa-agent.md`.

## When to run

On demand — at minimum once per 0.2.8 stabilization round and before any
release-prep PR. One round ≈ 30–60 min of agent work.

## Prerequisites

- `bun install` done; Playwright Chromium installed (`bun x playwright install chromium` if launches fail with "Executable doesn't exist").
- Repo root; clean tree; on a branch off current `dev`.
- The mock Zo API is fully local — no external services, no network.
- If another agent shares the working tree: git add by explicit path only, and never `git reset` without verifying the branch + SHA.

## Operational rules (learned the hard way — round 0)

1. **A RED matrix spec is a finding, not a broken test.** First decide
   *spec-wrong vs code-wrong* by reading the relevant extension code (or
   dumping state). Fix the spec if the code matches its documented contract;
   write a finding file if the code is wrong, and mark the spec
   `test.fixme()` with a `// finding: qa-<key>` comment in the SAME round.
   Never delete or loosen a spec to force green.
2. **Never enable Playwright tracing (`trace:`) on the qa-matrix project.**
   Playwright's CDP tracer contends with the extension's `chrome.debugger`
   fast-path and silently breaks background stream accumulation on tab close —
   this produced `qa-stream-accumulation-debugger-conflict`. Failure
   screenshots are fine; traces are not.
3. **Clear the mock's request recorder at test start**
   (`clearRecordedRequests()` in `beforeEach`) whenever a spec asserts on
   `recordedAsks()`/`lastAskBody()` — the mock server accumulates `__requests`
   across runs (`reuseExistingServer`), so stale entries from earlier runs will
   masquerade as fresh ones.
4. **Two sends in one test:** a cobrowse-envelope turn may park its actions
   (the `#actions-bar` Run All / Skip bar appears). Skip it before the next
   send or the composer stays blocked.
5. **Probes over guessing:** to decide spec-wrong vs code-wrong, replicate the
   failing flow in a one-off bun probe inside `e2e/qa-matrix/results/`
   (gitignored) and dump real state (`chrome.storage.local` via
   `panel.evaluate`). Delete the probe when done.

## Round procedure

Run the four lanes in order, then consolidate. Keep raw lane output in the
transcript — only consolidated findings hit the queue.

### Lane 1 — Matrix (scripted, always)

```bash
bun run qa:matrix        # or: bun run qa (validation + matrix)
```

Every RED spec = a candidate finding (`source: matrix`). Attach the failing
spec name + the state dump. Apply Operational rule 1 on reds.

### Lane 2 — Explorer (LLM, budget 30 min)

Dispatch one subagent with this charter:

> You are the QA explorer for the zo-cobrowse Chrome extension. Launch the
> real extension with the existing harness (`e2e/helpers/extension.ts`,
> `openHarness`) against the mock fixture site (`http://127.0.0.1:3179` —
> pages `/`, `/form.html`, `/checkout.html`, `/long.html`, `/writing.html`),
> exactly like `e2e/qa-matrix/m1-chat-tabs.spec.ts` does. Freestyle-hunt for
> broken flows the scripted matrix does not cover: rapid tab switches,
> mid-stream interruptions, history/options/picker edge cases, write-assist
> dismissal paths, odd input (empty, 10k chars, emoji, HTML in text).
> Budget: 30 minutes. For every anomaly record: what you did (exact steps),
> what you expected, what happened, screenshot paths, and the file:line you
> suspect. Do NOT fix anything. Return the anomaly list as your final message.

Explorer anomalies become candidates (`source: explorer`) only with concrete
repro steps recorded.

### Lane 3 — Review lanes (LLM, pick 2 per round, rotate)

Dispatch one subagent per charter; each returns candidates with `file:line`
evidence. Rotate targets so every shipped surface gets covered across rounds.

- **(a) Spec-vs-impl conformance:** "Read `<spec under docs/superpowers/specs/>`
  for feature X, then the implementation (`extension/…`). List every behavior
  the spec promises that the code does not deliver (or delivers differently).
  Evidence: spec quote + file:line."
- **(b) Text-safety / unsafe sinks:** "Hunt every path where extension-owned or
  page-derived text reaches the DOM in `extension/sidepanel.js`,
  `extension/content.js`, `extension/options.js`: innerHTML/insertAdjacentHTML/
  execCommand sinks lacking `safeText`/`String()` coercion or markdown
  escaping. Evidence: sink + the taint path."
- **(c) Error paths & resource cleanup:** "In `extension/background.js` +
  `extension/sidepanel.js`, hunt unhandled rejections, ports/listeners/timers
  leaked across the MV3 service-worker lifetime, and state left wedged after a
  failed stream. Evidence: file:line + the failure sequence."
- **(d) Race / state-machine review:** "Review `streamSession` handling,
  chat-tab switch/close during streams, and `lib/handoff.js` transitions for
  interleavings that drop, duplicate, or mis-route messages. Evidence: the
  interleaving, step by step."

### Lane 4 — Consolidation

1. Collect candidates from lanes 1–3.
2. **Dedup:** drop a candidate if (i) another candidate this round covers the
   same defect, (ii) an open queue file covers it (compare `key`/title/defect),
   or (iii) a GitHub issue already covers it:
   `gh issue list --label bug --milestone "0.2.8" --state open --search "<keywords>"`.
3. For each surviving candidate, verify it yourself (re-run the repro, or
   confirm the code path by reading). Unevidenced candidates die here.
4. Write one file per finding per the template below.
5. Append the round entry to `QA_REPORT.md` (template below).
6. Print the queue status: `bun scripts/qa/validate-findings.ts`.

## Finding file template

`docs/qa/findings/qa-<surface>-<slug>.md` — key = file name = stable dedup unit.

```markdown
---
key: qa-chat-tabs-close-mid-stream
title: Closing a chat tab mid-stream orphans the stream session
severity: P1            # P1 blocker | P2 broken-but-workaroundable | P3 cosmetic | P3-flake
surface: chat-tabs      # matches manual-panel-checklist section names
source: explorer        # matrix | explorer | review
found: 2026-09-10
---
What breaks, then: repro steps (exact), expected vs actual, evidence
(file:line, screenshot path, conversation id), suggested fix if obvious.
```

## Triage (the owner, or an agent explicitly asked to triage)

Per finding file, exactly one of:

- **Fix** → `fix/*` branch per the 0.2.8 per-bug loop; the fix PR deletes the
  finding file AND ships the regression test (`tests/` or `e2e/`), and un-fixmes
  any `test.fixme()` spec carrying its key.
- **File** → `gh issue create --label bug --milestone "0.2.8"` with the body,
  then delete the finding file and record `filed #<n>` in QA_REPORT.md.
- **Dismiss** → delete the file; one-line QA_REPORT note (duplicate/wontfix/by-design).

The queue (presence of `docs/qa/findings/*.md`) gates releases:
`bun run qa:gate`. Empty queue = releasable.

## QA_REPORT round-entry template

```markdown
## YYYY-MM-DD — QA agent round N
**Branch:** `<branch>` · **Scope:** <surfaces/lanes run>
### Findings
| key | severity | surface | source | disposition |
|-----|----------|---------|--------|-------------|
| qa-… | P1 | chat-tabs | explorer | fixed in #<pr> / filed #<issue> / open |
**Queue:** X open at start → Y at close (fixed a, filed b, dismissed c).
```

## Growth policy

The matrix grows one or two surfaces per round and never shrinks. Round 0
shipped m1–m4 (chat tabs, history+options, write-assist, pickers) and filed
`qa-stream-accumulation-debugger-conflict` + `qa-pickers-skills-section-residue`.
Candidates for the next round: handoff-run flows (`!handoff` readonly run),
context-menu/omnibox entries, tier-gating capture matrix specs, `!context`
bang-command flows, and the DevTools-open variant of the debugger-conflict
finding.
