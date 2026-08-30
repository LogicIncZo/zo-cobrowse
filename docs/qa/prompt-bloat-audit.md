# Prompt-bloat audit — per-section token costs (#71)

**Generated:** 2026-08-30 by `bun scripts/prompt-audit/prompt-audit.ts` (deterministic fixture; ~4 chars/token heuristic, same as `estimateTokens`).

## Mode × turn-shape totals

| Mode (tier) | fresh action | read (downgraded) | tier-0 follow-up | +2 referenced tabs | +skill +files | tier-0 +tabs(thin) |
|---|---:|---:|---:|---:|---:|---:
| 🤖 Co-browse (2) | ~1560 | ~1275 | ~407 | ~1327 | ~1646 | ~171 |
| 💬 Ask (1) | ~940 | ~934 | ~160 | ~986 | ~1026 | ~188 |
| 📥 Extract (2) | ~1310 | ~1303 | ~156 | ~1355 | ~1395 | ~185 |
| 🖼️ Visual (3) | ~1734 | ~1728 | ~126 | ~1780 | ~1820 | ~155 |
| 🪶 Lean (0) | ~216 | ~210 | ~212 | ~262 | ~302 | ~241 |

## Section costs — Co-browse (the heaviest mode), by turn shape


### fresh action — ~1560 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 2% |
| page | 29 | 2% |
| content (3253 chars) | 814 | 52% |
| elements (50 elements) | 320 | 21% |
| forms (6 fields) | 54 | 3% |
| userRequest | 15 | 1% |
| tail | 301 | 19% |

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

### tier-0 follow-up — ~407 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 7% |
| page | 29 | 7% |
| userRequest | 12 | 3% |
| tail | 339 | 83% |

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

### +skill +files — ~1646 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 2% |
| page | 29 | 2% |
| skills (1 skill) | 54 | 3% |
| files (2 files) | 41 | 2% |
| content (3253 chars) | 814 | 49% |
| elements (50 elements) | 320 | 19% |
| forms (6 fields) | 54 | 3% |
| userRequest | 6 | 0% |
| tail | 301 | 18% |

### tier-0 +tabs(thin) — ~171 tokens total

| Section | ~tokens | % of prompt |
|---|---:|---:|
| system | 27 | 16% |
| page | 29 | 17% |
| tabs (1 tab) | 30 | 18% |
| userRequest | 11 | 6% |
| tail | 74 | 43% |

## Findings (2026-08-30)

1. **Tier-0 duplication — FIXED in #70** (same milestone): Lean/read turns carried two overlapping not-attached disclaimers (~120 tokens).
2. **`system` + `tail` dominate light turns** — on tier-0 turns, ~90% of tokens are systemPrompt + instructions/tail. Cross-mode instruction overlap is the next audit target: persona, mode systemPrompt, and mode instructions each restate the no-submit/no-secrets rules (#26). Consolidating into ONE shared rule block (referenced, not repeated) is the top candidate — requires an evals refresh per touched prompt.
3. **`elements` + `forms` scale with page complexity** — already capped (50 els / 30 forms) and tier-gated; the caps look right. `read_page`/`get_dom` pulls bypass budgets by design (user asked).
4. **Tabs/skills/files sections are cheap** (tens of tokens each) and send-once-thinned — no action.
5. **Screenshot sections embed base64** — billed by Zo's backend as image tokens, not text; our `approxTokens` (chars/4) massively OVERSTATES them — flagged here so the table isn't misread (visual mode totals include the fixture data URL).

## Discipline

Any trim lands with before/after totals from this table + a `bun run evals:live` refresh (case ids stable). No intuition-driven rewording.
