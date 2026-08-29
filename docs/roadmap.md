# Roadmap

Updated 2026-08-29. The **authoritative, living status lives in
[`BACKLOG.md`](https://github.com/LogicIncZo/zo-cobrowse/blob/dev/BACKLOG.md)**
at the repo root — this page is a snapshot for the docs site.

## Current state

- **Release:** ✅ **v0.2.0** tagged + released (2026-08-28). Git-flow model:
  `dev` (integration) → `main` (release); releases are deliberate
  (`git tag vX.Y.Z` → `release.yml`).
- **Tests:** ✅ **972 pass / 0 fail** (42 files, 2641 `expect()` calls) +
  30 Playwright e2e across 16 numbered specs (+2 ZO_DEMO-gated demo specs)
- **Loop engineering:** `bun run verify` gate + committed hard-gate pre-commit
  hook (`bun run setup-hooks` to install)
- **CI/CD:** CI on every branch push + PRs into `main`/`dev` (tests +
  transpile + release checks + zip artifact); a separate e2e job gates PRs
  into the protected branches; the **drift job** gates dev→main release
  merges against pinned Zo-API baselines; `docs.yml` deploys this site to
  GitHub Pages
- **Streaming:** hardened end-to-end (sessionId isolation, port-disconnect
  safety, retry correctness, 60s liveness timeout)

## What shipped most recently

- **v0.2.0 (2026-08-28):** batch `fill_form` with the confirm-before-fill
  review card, sensitivity gate, and the no-auto-submit rule (#26)
- **2026-08-29:** vision-gated screenshots live-verified (#25 — screenshot
  embeds reach vision models), write-assist round 2 (contenteditable editors),
  prompt-eval harness (18/18 on live run), composer pickers (#28), pull
  contexts (#24), chat tabs, cold-start open-all (#27)
- **UX rounds (2026-08-29):** follow-up context fixes (send-once tab excerpts,
  no-thread re-attach guard), context-tier footer chip, empty-state starter
  chips, code-block Copy, ⬇ Latest pill, settings section nav + dirty
  tracking + token reveal, chat-list preview snippets + search highlighting

## Milestones

- **v0.2.1** — carry-over slate: model picker (#19) → cross-tab actions
  (#10) → watch & scheduled tasks (#29)
- **0.3.0** — competitive round 2 ("Memory, Audit & Control"), tracked as
  GitHub issues #46–#54: memory across sessions, autonomy dial + permissions,
  action audit & undo, WebMCP spike, tab compare, export, `read_file` pull,
  write-assist round 3, chat tabs round 2
- **#11 Chrome Web Store listing** — its own milestone after 0.3.0 features

## Deferred by design

- **B-31** — Default `zoSpaceEndpoint` is tenant-specific
  (`cashlessconsumer.zo.space`). Left as-is because it's the documented,
  working integration host; users can override via the `#space-endpoint` field.
- Shared sessions (#15/#18), background/cloud execution, agentic payments,
  voice — rationale in the 0.2.0 / 0.3.0 competitive analyses
  (`docs/superpowers/specs/`).
