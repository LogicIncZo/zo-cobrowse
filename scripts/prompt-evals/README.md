# Prompt evals

Scores every prompt the extension can send to `/zo/ask` against deterministic,
offline-reproducible checkers — so prompt edits are measurable instead of vibes.

```bash
bun run evals           # offline — grade the committed cache (CI-safe, no token)
bun run evals:live      # live — fetch missing/stale responses (.env ZO_API_KEY)
bun run evals:live -- --force          # refetch every live case
bun run evals:live -- --only checkout  # one case by id substring
```

## How it works

- `cases.ts` — the catalog (18 cases): all 6 builtin Modes via `lib/prompt.js`,
  the write-assist enhance prompt (`lib/write-assist.js`, incl. tag protocol,
  plain-vs-markdown, maxLength, honest-copy), the Mode generator, and the
  utility prompts (`lib/zo-prompts.js`). Cases import the REAL builders, so a
  prompt edit automatically invalidates its eval.
- `checkers.ts` — deterministic scorers: action-envelope validity (Zod protocol),
  the no-click-after-fill user rule, no-submit-click, no-secret-fills (#26),
  write-assist tag protocol + plain-text + no-invented-numbers, markdown table,
  brevity caps, strict generateMode JSON, and static prompt-shape assertions.
- `run.ts` — per-case `sha256(prompt)` keys a committed cache in `cache/`.
  Offline runs grade the cache and go STALE for any prompt that changed —
  fixing the prompt means re-running live and committing the refreshed
  response, so tuning always ends with evidence in the diff.
- `tests/prompt-evals.test.ts` — CI smoke: catalog shape + checker behavior.

## Safety

`create-automation` and `run-skill` are marked `live: false`: they instruct Zo
to use real tools (create a real automation / execute workspace commands), so
they are graded statically and NEVER sent by the harness.

## Tuning loop

1. `bun run evals:live` → read the failing check names + details.
2. Edit the prompt (in `extension/lib/*.js` — the single source the extension
   and these evals share).
3. Re-run live for the affected cases (`--only <id>`), then `bun run evals`
   offline to confirm 18/18, and commit prompt + cache together.

Round 1 result (2026-08-28): 18/18 after fixing two eval cases — the original
checkout case asked for a fill with no values and Zo correctly refused to
invent data on a payment page; list-automations hit a transient 502. Prompt
wording itself needed no changes; the contracts held on live runs.
