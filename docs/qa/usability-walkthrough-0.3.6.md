# Usability walkthrough — 0.3.6 (#393, closing the #244 loop)

**Round:** 2026-09-25, on the 0.3.6 candidate surface (dev `f264dbc` — v0.3.5.0 + the
a11y round PRs #394–#398). Instrument: `docs/qa/manual-panel-checklist.md` (#254
scaffold). Spec: `docs/superpowers/specs/2026-09-25-0.3.6-a11y-ux-slate-design.md`.
**Method note (honest deviation):** computer-use was unavailable in this session, so
the walk ran through the Playwright extension harness — the REAL extension (all four
scripts), real Chromium, mock Zo server — with the panel as a tab. Every flow item was
walked with screenshot evidence (`/tmp/zo-walk/*.png`, 12 frames). The genuinely
shell-only items (docked-panel behaviors the checklist exists for) were **not**
walkable this way and remain with the owner's pre-promotion pass — which is the
checklist's own standing gate.

## Passes

- **Pass 1 — fresh install (seeded-config caveat):** the harness seeds a token +
  mock endpoints at launch, so the true "no token → honest error card" onboarding
  step was not reproducible here; that path stays covered by the error-card e2e
  specs. Everything else in the onboarding journey was walked as captured.
- **Pass 2 — existing profile (daily flows):** configured profile against the mock —
  asks, modes, pickers, history, theme, save flow.

## Section verdicts (checklist order)

| Section | Verdict | Evidence / notes |
|---|---|---|
| Empty state + starter chips | ✅ | `01` — chips render, "Connected to Zo" banner, prompt-inspector bar (~259 tok) |
| Ask → streamed answer | ✅ | `02`/`06` — user bubble + tab pill, 💭 Thought collapse, answer, footer (Copy · Mode · Elements · `#con_…` · time) |
| Options: two-field connection (0.3.4) | ✅ | `03` — Username + Token primary, endpoints in Advanced `<details>`, derivation hints |
| ONE save + toast | ✅ | `04` — single sticky Save; "✅ Saved!" toast (now `role=status`, announces — m2 fix #398 verified) |
| Mode switch | 🔴 **F1** | panel `#mode-select` change **kills the page** — see finding below |
| Prompt inspector | ✅ | bar renders + token estimate updates per Mode (07/08 steps; inspector live preview) |
| `/` skills picker | ✅ | `09` — instant rows (e2e-skill, websh), highlight, `↑↓ navigate · ↵ select · Esc close` hints |
| `%` files picker | ✅ | `10` — workspace rows render; ＋ folder arm visually present |
| History: search/restore | ✅ | `11`/`12` — live search matches, cards restore; rename/export buttons present (a11y round made them 24px + focus-revealed) |
| Theme popover live repaint | ✅ | `13` — popover opens focused, options render; panel repaints (Esc closes, refocuses — #395) |
| Write-assist popover | ⏭ skipped | fixture page has no textarea in this run; covered by e2e/16 + qa-matrix m3 |
| Keyboard focus ring spot check | ✅ | `15` — amber ring on Tab stops after the composer |
| Gated flows (fill review, handoff, recipe checkpoints) | ✅ by proxy | dedicated scripted coverage (e2e/22, e2e/23 + qa-matrix) — not re-walked here |
| Shell-only items (dropdowns-in-shell #62, dock width #296, stale-build banner #109, TTS ear check, SR spot check) | 👤 owner | not walkable as a tab — standing pre-promotion gate |

## Findings

**F1 — RESOLVED as a test-environment bug, not a product bug (2026-09-25, same day).**
Playwright's `selectOption` on the panel's Mode select killed the whole headless
Chromium window (both tabs, no new tabs possible — reproducible on v0.3.5.0 AND dev).
Bisection: (1) dispatching the change from the page (the exact user-visible path) is
**completely healthy** — the Mode applies, the system message renders, the page
survives; (2) `selectOption` on ANY panel select dies (Model too), while the same
call on options-page and site selects is fine — the panel's selects are the ones
hidden behind the #304/#62 shim (`.select-shim-native` = display:none data store),
and `selectOption` against a hidden select deterministically crashes new-headless
Chromium. Disposition: harness now exports `setPanelMode()` (page-side dispatch) for
all future panel-Mode coverage; the product needs no change (Mode switching verified
working end-to-end). No e2e spec had ever switched the panel's Mode, which is why
this surfaced only in the walkthrough.

**F2 — P3 — unidentified stray glyph, panel message canvas.** A small tilted-pencil
icon renders at the viewport's right-middle (≈x1010, y228 @1280×720) in EVERY panel
state — empty (`01`) and after exchanges (`02`, where a second instance appears lower)
— constant position across content changes, resembling the write-assist icon but NOT
it (the panel does not load content.js). Needs identification (fixed-position control
leaking?) and removal or labeling. Screenshots `01`/`02`.

**F3 — note — harness config seeding.** `openHarness` seeds token + endpoints, so
automation cannot walk the true first-run error path; recommend the harness gain a
`seedConfig: false` opt for onboarding walkthroughs. (No product action.)

**Fixed during this round (from the same friction hunt):** qa-m2 prompts-editor
status/status-stuck — root-caused to a silent native-validation block
(`step="100"` stepMismatch ate every real submit) + #340's draft-first save order;
fixed in #398.

## 0.3.4/0.3.5 additions to the checklist (landed in this round's docs commit)

- ⚡ Jev card: enable → key Show/Hide → **Test Jev** probe → thresholds; disabled
  state shows no Jev vocabulary in runs.
- ONE Save Settings sticky bar: dirty marker appears on edit, clears on save; toast
  announces (role=status).
- Connection pane: Username + Token only; Advanced hosts derive from the slug;
  hand-edited values win.
- Zo-drift: `bun run check:drift` green (owner-facing releases only).

## Close-out

#244's waived walkthrough debt is discharged by this log (the issue itself stays
closed per the 2026-09-18 waiver comment). F1 blocks the v0.3.6.0 gate until fixed
or owner-waived; F2/F3 filed as noted. Checklist updated with the additions above.
