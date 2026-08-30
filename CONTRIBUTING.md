# Contributing to Zo Co-browse

## Branching model

This repo follows a git-flow-style model with two protected long-lived branches:

```
main   (protected)  ← always the latest working release code; releases are cut here
  ▲
  │  PR (CI must be green)
  │
dev    (protected)  ← integration branch; where features merge together
  ▲
  │  PR (CI must be green)
  │
feature/*  fix/*  chore/*   ← one branch per unit of work, branched from dev
```

**Rules:**

1. **Branch from `dev`, merge back to `dev`.** Every feature/fix/chore branch starts at `dev` and returns to `dev` via pull request. CI must be green to merge.
2. **`dev` → `main` is a PR.** Promotion to `main` stabilizes it for release. CI must be green; `main` is kept strictly up-to-date before merge (no stale merges).
3. **No direct pushes to `main` or `dev`.** Both are protected — all changes land via PR. (Admins can force-bypass in an emergency; don't make it a habit.)
4. **Releases are deliberate, not automatic.** To cut a release from `main`:
   ```bash
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   The tag triggers `.github/workflows/release.yml`, which re-verifies the tree, builds the zip, and publishes a GitHub Release with auto-generated notes.
5. **Never commit secrets.** API tokens live in `chrome.storage.local` at runtime, not in the repo.

> Merging to `main` does **not** publish a release — it only keeps `main` releasable. The `v*` tag is the release trigger.

## Development Setup

1. Clone the repo
2. Run `bun install` (installs zod + bun-types)
3. Run `bun run setup-hooks` (installs the pre-commit verification gate)
4. Run `bun test` — all 494 tests should pass
5. Load `extension/` as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked)

**Start every change from `dev`:**
```bash
git checkout dev && git pull
git checkout -b feature/<short-description>
```

## Development Loop (verify before commit)

This repo is set up for **loop engineering**: every change is verified before it
is committed, and `bun run verify` is the single gate that runs all of it:

```bash
bun run verify   # = tests (bun test) → release checks (lint) → transpile check
```

- `bun run setup-hooks` (one-time) points `core.hooksPath` at `scripts/hooks/`,
  so a committed **pre-commit hook** runs `bun run verify` on every `git commit`
  and **blocks the commit** if anything fails. No husky needed.
- The hook is a hard gate — bypass it deliberately with `git commit --no-verify`.
- CI runs the same checks on every branch push and on PRs into both `main` and
  `dev` (`.github/workflows/ci.yml`), so verification also runs remotely.
- The gate itself is just `scripts/verify.sh`: keep new checks there if you add
  any (e.g. a new transpile target), and they run in both the hook and CI.

## Project Structure

```
zo-cobrowse/
├── extension/          # Chrome extension (service worker, side panel, options)
│   ├── lib/            # Shared modules (config, modes, intent, bang-commands)
│   ├── icons/          # Extension icons (16, 48, 128)
│   ├── sidepanel.html  # Co-browse side panel UI
│   ├── background.js   # Service worker (Zo API calls, action execution)
│   ├── content.js      # Content script (DOM capture, action dispatch)
│   ├── options.html    # Options page (API URL, model, persona)
│   └── manifest.json   # Chrome extension manifest (V3)
├── tests/              # Bun test suite (494 tests across 23 files)
│   ├── schemas/        # Zod schemas for data contracts
│   └── helpers/        # Test helpers (chrome mock)
├── backend/            # WebSocket relay for shared sessions
├── scripts/            # Release checking, verification gate, git hooks
├── AGENTS.md           # Project index & state tracking
├── PRIVACY.md          # Privacy policy (for Chrome Web Store)
├── CHECKLIST.md        # Human verification checklist
└── QA_REPORT.md        # QA report & known issues
```

## Running Tests

```bash
bun run verify        # Full gate: tests + release checks + transpile check
bun run test:watch    # Watch mode (auto-rerun on changes)
```

## Code Style

- **No runtime dependencies beyond zod** — the extension loads nothing from npm at runtime
- Chrome API calls use callback pattern (MV3 service worker)
- New browser action types must be added to `tests/schemas/actions.ts` Zod schema
- Config defaults live in `extension/lib/config.js`
- Chrome mocks live in `tests/helpers/chrome-mock.ts`

## Pull Request Process

1. Run `bun run verify` — all 494 tests plus release/transpile checks pass
2. Update `CHANGELOG.md` (and `CHECKLIST.md`) if the change is user-visible
3. Update the ticket completion table in `AGENTS.md` if implementing a tracked feature
4. Open a PR against `dev` (not `main`) — CI runs the same `verify` gate.
   Promotion from `dev` → `main` is a separate, deliberate PR.

## Release demos

Every tagged release ships a narrated feature-demo video in `demo/`:

- **Artifact:** `demo/zo-cobrowse-demo-<YYYY-MM-DD>.mp4` (2–3 min, 1280×720, en-IN narration)
- **Regenerate:** `bash demo/harness/build/make_demo.sh` (see `demo/harness/README.md`)
- **New feature in the release → new scene:** add a narration segment to
  `demo/harness/build/narration.txt` and matching beats to the harness
  choreography in `demo/harness/site/harness.html`, then regenerate and commit
  the new MP4 alongside the release.
- The pipeline is generalized as the Zo skill `Skills/feature-demo-video/`
  (agent-side, not part of this repo); the harness in this repo is its
  reference implementation.

## Adding a New Action Type

1. Add the action kind to `ACTION_KINDS` in `tests/schemas/actions.ts`
2. Add the discriminator union member to `ActionSchema`
3. Implement the handler in `extension/background.js` `executeActions()`
4. Add tests in `tests/actions.test.ts`
5. Add content script handler in `extension/content.js` if needed
