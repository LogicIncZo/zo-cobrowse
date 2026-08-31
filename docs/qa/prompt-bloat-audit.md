# Prompt-bloat audit — per-section token costs (#71)

**Generated:** 2026-08-31 by (post-trim regeneration) `bun scripts/prompt-audit/prompt-audit.ts` (deterministic fixture; ~4 chars/token heuristic, same as `estimateTokens`).

## Mode × turn-shape totals

| Mode (tier) | fresh action | read (downgraded) | tier-0 follow-up | +2 referenced tabs | +skill +files | tier-0 +tabs(thin) |
|---|---:|---:|---:|---:|---:|---:
| 🤖 Co-browse (2) | ~1518 | ~1275 | ~364 | ~1327 | ~1617 | ~134 |
| 💬 Ask (1) | ~940 | ~934 | ~160 | ~986 | ~1040 | ~188 |
| 📥 Extract (2) | ~1310 | ~1303 | ~156 | ~1355 | ~1409 | ~185 |
| 🖼️ Visual (3) | ~1734 | ~1728 | ~126 | ~1780 | ~1834 | ~155 |
| 🪶 Lean (0) | ~179 | ~173 | ~175 | ~225 | ~279 | ~204 |

## Section costs — Co-browse (the heaviest mode), by turn shape


### fresh action — ~1518 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 2% |
| page | 29 | 2% |
| content (3253 chars) | 814 | 54% |
| elements (50 elements) | 320 | 21% |
| forms (6 fields) | 54 | 4% |
| userRequest | 15 | 1% |
| tail | 259 | 17% |

### read (downgraded) — ~1275 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 2% |
| page | 29 | 2% |
| content (3253 chars) | 814 | 64% |
| elements (50 elements) | 320 | 25% |
| forms (6 fields) | 54 | 4% |
| userRequest | 9 | 1% |
| tail | 22 | 2% |

### tier-0 follow-up — ~364 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 7% |
| page | 29 | 8% |
| userRequest | 12 | 3% |
| tail | 296 | 81% |

### +2 referenced tabs — ~1327 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 2% |
| page | 29 | 2% |
| tabs (2 tabs) | 51 | 4% |
| content (3253 chars) | 814 | 61% |
| elements (50 elements) | 320 | 24% |
| forms (6 fields) | 54 | 4% |
| userRequest | 10 | 1% |
| tail | 22 | 2% |

### +skill +files — ~1617 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 2% |
| page | 29 | 2% |
| skills (1 skill) | 54 | 3% |
| files (2 files) | 55 | 3% |
| content (3253 chars) | 814 | 50% |
| elements (50 elements) | 320 | 20% |
| forms (6 fields) | 54 | 3% |
| userRequest | 6 | 0% |
| tail | 259 | 16% |

### tier-0 +tabs(thin) — ~134 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 20% |
| page | 29 | 22% |
| tabs (1 tab) | 30 | 22% |
| userRequest | 11 | 8% |
| tail | 37 | 28% |

## Findings (2026-08-31)

1. **Tier-0 duplication — FIXED in #70** (same milestone): Lean/read turns carried two overlapping not-attached disclaimers (~120 tokens).
2. **`system` + `tail` dominate light turns** — on tier-0 turns, ~90% of tokens are systemPrompt + instructions/tail. **Cross-mode instruction overlap — TRIMMED 2026-08-31 (Lane A)**: the no-submit/no-secrets rules (#26) were restated in the schema tail AND cobrowse instructions; they now live once in `lib/prompt.js#SHARED_SAFETY_RULES` and compose a single time per action turn. Measured below.
3. **`elements` + `forms` scale with page complexity** — already capped (50 els / 30 forms) and tier-gated; the caps look right. `read_page`/`get_dom` pulls bypass budgets by design (user asked).
4. **Tabs/skills/files sections are cheap** (tens of tokens each) and send-once-thinned — no action.
5. **Screenshot sections embed base64** — billed by Zo's backend as image tokens, not text; our `approxTokens` (chars/4) massively OVERSTATES them — flagged here so the table isn't misread (visual mode totals include the fixture data URL).

## 2026-08-31 trim results — shared safety-rule block (Lane A)

**Change:** the #26 no-secrets / never-click-after-fill rules were removed from
`ACTION_SCHEMA_COMPACT` and from cobrowse `instructions`, and now live once in
`lib/prompt.js#SHARED_SAFETY_RULES`, composed only on action (`expectJson`) turns.

**Before/after** (same audit fixture; "before" measured at pre-trim `dev` — 2bc362b — via a
temp worktree, so the delta is purely the trim):

| Co-browse turn shape | before | after | Δ |
|---|---:|---:|---:|
| fresh action | ~1560 | ~1518 | **−42** |
| tier-0 follow-up (action) | ~407 | ~364 | **−43** |
| +skill +files | ~1660 | ~1617 | **−43** |
| read (downgraded) | ~1275 | ~1275 | 0 (envelope not attached → rules not attached) |

Every action turn sheds one duplicated copy of the rules (~10% of a tier-0 action turn's
tail). Read-only modes and turns are byte-identical.

**Gates:** evals cache refreshed live (19/19; the three cobrowse action cases re-fetched and
green — note: Zo's server-default model was disabled upstream at refresh time, so the refresh
pinned a live-catalog model via the new `EVALS_MODEL` env; case ids unchanged).

## Discipline

Any trim lands with before/after totals from this table + a `bun run evals:live` refresh (case ids stable). No intuition-driven rewording.

