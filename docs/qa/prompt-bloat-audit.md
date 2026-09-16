# Prompt-bloat audit — per-section token costs (#71)

**Generated:** 2026-09-16 (post-#236-trim regeneration) by `bun scripts/prompt-audit/prompt-audit.ts` (deterministic fixture; ~4 chars/token heuristic, same as `estimateTokens`).

## Mode × turn-shape totals

| Mode (tier) | fresh action | read (downgraded) | tier-0 follow-up | +2 referenced tabs | +skill +files | tier-0 +tabs(thin) |
|---|---:|---:|---:|---:|---:|---:
| 🤖 Co-browse (2) | ~1450 | ~1272 | ~287 | ~1324 | ~1550 | ~136 |
| 💬 Ask (1) | ~937 | ~931 | ~147 | ~983 | ~1037 | ~176 |
| 📥 Extract (2) | ~1293 | ~1287 | ~130 | ~1339 | ~1393 | ~159 |
| 🖼️ Visual (3) | ~1734 | ~1728 | ~116 | ~1780 | ~1834 | ~145 |
| 🪶 Lean (0) | ~164 | ~158 | ~160 | ~210 | ~264 | ~189 |

## Section costs — Co-browse (the heaviest mode), by turn shape


### fresh action — ~1450 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 24 | 2% |
| page | 29 | 2% |
| content (3253 chars) | 814 | 56% |
| elements (50 elements) | 320 | 22% |
| forms (6 fields) | 54 | 4% |
| userRequest | 15 | 1% |
| tail | 194 | 13% |

### read (downgraded) — ~1272 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 24 | 2% |
| page | 29 | 2% |
| content (3253 chars) | 814 | 64% |
| elements (50 elements) | 320 | 25% |
| forms (6 fields) | 54 | 4% |
| userRequest | 9 | 1% |
| tail | 22 | 2% |

### tier-0 follow-up — ~287 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 24 | 8% |
| page | 29 | 10% |
| userRequest | 12 | 4% |
| tail | 222 | 77% |

### +2 referenced tabs — ~1324 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 24 | 2% |
| page | 29 | 2% |
| tabs (2 tabs) | 51 | 4% |
| content (3253 chars) | 814 | 61% |
| elements (50 elements) | 320 | 24% |
| forms (6 fields) | 54 | 4% |
| userRequest | 10 | 1% |
| tail | 22 | 2% |

### +skill +files — ~1550 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 24 | 2% |
| page | 29 | 2% |
| skills (1 skill) | 54 | 3% |
| files (2 files) | 55 | 4% |
| content (3253 chars) | 814 | 53% |
| elements (50 elements) | 320 | 21% |
| forms (6 fields) | 54 | 3% |
| userRequest | 6 | 0% |
| tail | 194 | 13% |

### tier-0 +tabs(thin) — ~136 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 24 | 18% |
| page | 29 | 21% |
| tabs (1 tab) | 30 | 22% |
| userRequest | 11 | 8% |
| tail | 42 | 31% |

## Findings (2026-08-31, #2 updated 2026-09-16)

1. **Tier-0 duplication — FIXED in #70** (same milestone): Lean/read turns carried two overlapping not-attached disclaimers (~120 tokens).
2. **`system` + `tail` dominate light turns** — on tier-0 turns, ~90% of tokens are systemPrompt + instructions/tail. **Cross-mode instruction overlap — TRIMMED (Lane A 2026-08-31: shared safety rules; round 2 2026-09-16 #236: not-attached contract ×3 → ×1, fill_form preference schema-only, pull annotations terse, persona dedup).** Measured below.
3. **`elements` + `forms` scale with page complexity** — already capped (50 els / 30 forms) and tier-gated; the caps look right. `read_page`/`get_dom` pulls bypass budgets by design (user asked).
4. **Tabs/skills/files sections are cheap** (tens of tokens each) and send-once-thinned — no action.
5. **Screenshot sections embed base64** — billed by Zo's backend as image tokens, not text; our `approxTokens` (chars/4) massively OVERSTATES them — flagged here so the table isn't misread (visual mode totals include the fixture data URL).

## 2026-09-16 trim results — round 2 (#236)

**Changes:** (1) the "page not attached" contract collapsed to ONE exported sentence
(`lib/modes.js#NOT_ATTACHED_CONTRACT`) used by the generic tier-0 clarifier, the
read-downgrade tier-0 tail, and lean's instructions — prompt.js's guard now matches
exact inclusion instead of a regex over prose; (2) the fill_form preference dropped
from cobrowse `instructions` (it restated the schema line); (3) the five pull-action
annotations in `ACTION_SCHEMA_COMPACT` collapsed to one trailing "fetch context only"
tag (drops the read_file absolute-path note); (4) persona `systemPrompt`s share
`ZO_PERSONA` and dropped clauses restated elsewhere (extract/lean duplicated their
own instructions; "the page they're on" deduped).

**Before/after** (same audit fixture; "before" = this audit regenerated at pre-trim
`dev` — 1475fce — so the delta is purely the trim. Note: the committed 2026-08-31
tables were stale — the #52 `read_file` annotation had added ~28 tok to every action
turn without a regeneration):

| Mode | fresh action | read (downgr.) | tier-0 follow-up | +2 tabs | +skill +files | tier-0 +tabs(thin) |
|---|---:|---:|---:|---:|---:|---:|
| 🤖 Co-browse | 1546 → **1450** (−96) | 1275 → 1272 | 392 → **287** (−105) | 1327 → 1324 | 1645 → **1550** (−95) | 134 → 136 |
| 💬 Ask | 940 → 937 | 934 → 931 | 160 → **147** (−13) | 986 → 983 | 1040 → 1037 | 188 → 176 (−12) |
| 📥 Extract | 1310 → **1293** (−17) | 1303 → 1287 | 156 → **130** (−26) | 1355 → 1339 | 1409 → 1393 | 185 → 159 (−26) |
| 🖼️ Visual | 1734 → 1734 | 1728 → 1728 | 126 → **116** (−10) | 1780 → 1780 | 1834 → 1834 | 155 → 145 (−10) |
| 🪶 Lean | 179 → **164** (−15) | 173 → 158 | 175 → 160 | 225 → 210 | 279 → 264 | 204 → 189 |

Per-turn tails: Co-browse fresh-action tail 287 → **194** (−93); tier-0 follow-up tail
324 → **222** (−102). One honesty note: the thin tab shape (+2) now correctly states
the contract — the old guard regex was accidentally suppressed by tab-manifest
"— not attached" lines; exact-inclusion matching on the shared sentence fixes that
(the disclaimer now appears exactly once on every tier-0 shape).

**Gates:** `bun run evals:live` refresh (case ids stable); checkers
(`noClickAfterFill`/`noSubmitClick`/`noSecretFills`/`validActionEnvelope`) unchanged
and green; `ACTION_SCHEMA_COMPACT` length guard re-pinned to the measured ceiling.

## Discipline

Any trim lands with before/after totals from this table + a `bun run evals:live` refresh (case ids stable). No intuition-driven rewording.
