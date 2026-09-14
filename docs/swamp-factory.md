# Swamp factory — the improvement loop as a gated state machine

`scripts/swamp/factory.yaml` is a standing [`@swamp/software-factory`](https://swamp-club.com/extensions/@swamp/software-factory)
instance for this repo: **one factory, run on loop, keeps improving the
codebase.** Work items flow `intake → implement → verify → adversarial review
→ merge`, one after another, forever. It is deliberately **not** a release
cadence: the 0.2.8 spec §4 "one fix = one release" rule is not encoded —
merged items simply land on `done`, and releases are owner-called items in
the same machine, batching whatever is already on `dev`.

**One work item = one unit of improvement.** Fix/improve items use the issue
number (`155`); release items are named `rel-0.2.8.N`.

The ground rule, in one line: **Swamp mirrors CI, never replaces it.** The
engine never talks to GitHub or bun — the driving agent runs the repo's own
commands and records their outcomes as schema-validated evidence, and every
gated transition re-checks that evidence. GitHub Actions (`qa-gate`, `drift`
jobs) remains the actual release enforcement; the factory disciplines *local
agent runs* so an agent cannot walk the loop around a gate.

## The drive loop

The factory instance is created once and persists. An agent (or you) keeps
the loop fed:

```bash
# 0. one-time: swamp repo init  (machine-local .swamp/ state, self-gitignored)

# 1. pick the next item — in priority order:
#      docs/qa/findings/*.md  →  0.2.8-milestone GitHub issues  →  BACKLOG queued polish
swamp model method run zo-loop start --input workItem=155

# 2. drive it — `status` is the entrypoint; it says what the stage requires next
swamp model method run zo-loop status --input workItem=155

# 3. prove the stage ran, then do the work it demands:
swamp model method run zo-loop record_dispatch --input workItem=155 --input stageId=intake
swamp model method run zo-loop record_artifact --input workItem=155 \
  --input name=intake-decision \
  --input payload='{"kind":"fix","issueRef":"#155","rationale":"P1 streaming loss"}'

# 4. move along a transition (blocked transitions fail with per-gate reasons)
swamp model method run zo-loop advance --input workItem=155 --input transition=fix

# 5. when the item lands on done — pick the next one. The loop continues.
```

`record_dispatch` is not optional: the engine refuses to advance out of a
stage that never recorded execution, so stages cannot be silently skipped —
and it feeds the runaway-loop guard (a third re-dispatch of the same stage
entry hard-fails as `runaway-loop-suspected`).

Many items can be in flight at once (per-item namespaced run data); the
merge stage is where items naturally serialize on the owner's attention.

## One-time setup

```bash
swamp repo init                                              # machine-local; edits .gitignore itself
swamp model create @swamp/software-factory zo-loop
swamp model edit zo-loop        # paste scripts/swamp/factory.yaml under globalArguments
swamp model method run zo-loop validate
swamp model method run zo-loop describe   # Mermaid + stage/transition tables
```

The instance definition lands at `models/@swamp/software-factory/zo-loop.yaml`
(gitignored — machine-local state; `scripts/swamp/factory.yaml` is the
committed source of truth). Re-sync after editing it by pasting again.

## Stage ↔ gate ↔ repo command map

| Stage | Work | Advance requires |
|---|---|---|
| `intake` (initial) | classify: fix/improve · release · close | `intake-decision` artifact → `fix` / `release` / `close` |
| `implementing` | branch from `dev` (fix/chore/feature), implement + regression test, PR → `dev` | `fix-summary` artifact + `pull-request` evidence |
| `verifying` | `bun run verify` via `record-gate.sh` | `gate-verify` evidence, `status: succeeded` |
| `review` | adversarial review of the PR diff; findings with severities | fresh `change-review` (kind: findings) with **no blocking critical/high** |
| `merge` | `gh pr checks` until green; **owner merges** — then next item | `ci-run` success evidence + `merge-approval` approval |
| `release-prep` | `chore(release)` bump, dev→main PR | `gate-qa`/`gate-drift`/`gate-lint` evidence **exitCode 0** + `release-approval` approval |
| `tagging` | tag on `main`, push | `tag-ref` evidence |
| `publishing` | `gh run watch` on `release.yml` | `release-run` success evidence → `done` |

Loop-backs: verify failure and review `rework` → `implementing`; red CI →
`implementing`; a red release gate → `postpone` (item closes; new work items
for whatever blocked); a red release workflow → `release-prep`. `abort`
(owner-approved) is available from anywhere. `maxCycles` (5) on
`implementing`/`release-prep` parks thrashing runs for a human.

## Rules

- **Gate evidence comes only from `scripts/swamp/record-gate.sh`** for the
  command gates (`gate-verify`, `gate-qa`, `gate-drift`, `gate-lint`). It
  runs the command from the repo root, captures exit code + short sha, prints
  the JSON payload and the exact `record_evidence` invocation, and exits with
  the command's exit code.
- **Approvals are cycle-scoped.** Any rework loop-back invalidates stale
  approvals and stale evidence automatically — a re-fix re-runs the gates and
  re-review.
- **The review stage never silently passes.** A clean pass still records the
  `change-review` artifact (empty or informational entries); `findings-clear`
  blocks critical/high, and freshness forces re-review after rework.
- **Human approvals are the autonomy dial.** `merge-approval` and
  `release-approval` are yours alone; the loop runs unattended up to each
  gate and parks there. Removing a gate is a deliberate, reviewed edit (the
  schema test pins the approvals that exist today).
- Stage prompts are **inline** on purpose (repo constraint files are not
  resolvable from the model definition); they quote the loop rules and exact
  commands so any agent can drive a stage from `status` alone.
- Dry-run the machine on a throwaway item (`start --input workItem=999`) and
  wipe it with `reset --input workItem=999 --input confirm=reset`.

## Testing

`tests/swamp-factory.test.ts` (runs in `bun run verify`) parses the committed
YAML against `tests/schemas/swamp-factory.ts` and asserts the load-bearing
invariants: single `intake` entry, all transition targets resolve, human
approvals on merge/release/abort, evidence-gated verify + release commands,
review findings blocking the merge, and — pinned structurally — **the merge
flow never routes into `release-prep`** (releases stay decoupled from fixes).
Hand edits that weaken the machine fail the suite.

## Upgrade path (deliberately out of scope)

- A Swamp workflow runner for `bun run verify` would let `verifying` become a
  zero-LLM `workflow` stage gated by `workflow-succeeded` (platform-verified,
  not agent-attested). Until then the local gate rides `record-gate.sh`
  evidence and the authoritative verify stays CI + the pre-commit hook.
- `work.constraints` pointing at repo files, once path resolution outside the
  extension's own tree is supported.
