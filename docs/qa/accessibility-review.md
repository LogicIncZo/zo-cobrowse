# Accessibility review — round 1 (0.3.6)

**Round:** 2026-09-25, on the frozen v0.3.5.0 surface (dev `f501f82`). Spec:
`docs/superpowers/specs/2026-09-25-0.3.6-a11y-ux-slate-design.md` ·
Ticket: [#392](https://github.com/LogicIncZo/zo-cobrowse/issues/392). Cadence: the
standing review-lane rule (BACKLOG.md) — this lane had never run.
**Method:** three parallel deep-dives — side panel (keyboard/focus + semantics lanes),
options page (all four lanes), and cross-cutting lanes (write-assist shadow-DOM widget,
motion + five-theme contrast sweep with computed WCAG ratios, platform/strings). Every
finding below cites file:line from the sweep; contrast ratios are computed from the
exact theme tokens (`styles.css`), not estimated.

**Summary verdict: a strong base with systematic, quick-fix-scale gaps.** Prior a11y
investment is real (`role=log` streaming log, aria-pressed toggles, native
`details/summary`, the #304 activedescendant shim, the #309 hit-target sweep, amber
`:focus-visible` ring everywhere, zero positive tabindex, both pages `lang=en`).
Round-1 gaps cluster into: keyboard-inoperable controls (2 P1s), an AA-failing primary
button (1 P1), zero `prefers-reduced-motion` coverage, sub-4.5:1 faint text across all
five themes, and missing focus management on every popup/dialog. All fixed in-round
(ledger below); nothing needed the `0.3.6.N` lane.

## Lane 1 — Keyboard & focus — 🔴 was failing (2 P1, fixed in-round)

- **P1 (fixed):** history conversation cards were clickable `<div>`s — keyboard users
  could not open any past conversation (`sidepanel.js:1724,1818`). Now button-based.
- **P1 (fixed):** chat-tab close ✕ was a non-focusable `<span>` (14×14, invisible
  until mouse hover) — keyboard users could not close tabs (`sidepanel.js:1338-1345`,
  `styles.css:590-608`). Now a real button, revealed on `:focus-visible`, ≥24px.
- **P2s (fixed):** status dot click-to-options on a `span[role=img]` (`sidepanel.html:28`);
  `＋` folder-arm affordance mouse-only (`sidepanel.js:3699-3707`); composer popup rows
  wired to `mousedown` only so Enter on a focused row was a silent no-op
  (`sidepanel.js:3459/3610/3710`); quick-action row removal rebuilt the list via
  `innerHTML` and dropped focus to `<body>` (`options.js:439-448`); theme popover,
  Create-Mode overlay, recipe library dialog, history view and the write-assist popover
  all lacked open-focus/Esc/close-restore management (their ledger rows below).
- Esc coverage was otherwise consistent (stream cancel, pickers, context menu); no
  focus traps; no positive tabindex anywhere.

## Lane 2 — Semantics & ARIA — 🟡 was partially failing (fixed in-round)

Solid: `#messages` is `role="log" aria-live="polite"` (streamed output announces);
toggles carry `aria-pressed`; reasoning collapses are real buttons/`details`;
icon-only header buttons named; the select shim implements a full listbox pattern.
Fixed in-round: options settings nav now a real `tablist/tab/tabpanel` with
`aria-selected` + arrow keys (was class-only show/hide, `options.html:313-320`);
`#tab-strip` `role=listbox` violated by `aria-pressed` buttons → `role=group`
(`sidepanel.html:122`); `#tab-strip-collapse` gained `aria-expanded`; status toast and
inline statuses are `role=status` live regions (saves/errors now announce); secret
Show/Hide buttons got unambiguous names + `aria-pressed`; quick-action inputs and
composer/history-search inputs got `aria-label`s (placeholder-only names); recipe
library trigger gained `aria-haspopup` + `aria-expanded`; write-assist popover gained
`role=dialog` + name + a `role=status` "draft ready" announcement; history-row icon
buttons carry `aria-label`s.

## Lane 3 — Visual & motion — 🔴 was failing (1 P1 + systematic contrast/motion, fixed in-round)

- **P1 (fixed):** `.btn-primary` rendered white text on the amber→indigo gradient —
  **2.03:1** dark / 3.28:1 light on the amber stop (`options.html:142-147`). The single
  Save Settings button failed AA. Dark text on the gradient now.
- **Contrast (fixed):** `--text-faint` text sat at **2.53–3.24:1 across all five
  themes** (placeholders, metadata, hints, tab-close glyph; `styles.css:64,124,252,292,332`)
  — the token was lifted to ≥4.5:1 per theme; light-theme inline-status amber/green/red
  pairs (2.58–3.7:1) moved to theme-scoped status colors; widget `.zo-wa-note`
  hardcoded `#b54708` (2.97:1) → theme token; widget icon border (1.47:1 vs the 3:1
  non-text floor) darkened.
- **Motion (fixed):** `prefers-reduced-motion` had **zero occurrences** in `extension/`
  while five `@keyframes` loop infinitely (chat-tab-pulse, pulse ×2, spin,
  msg-processing-pulse, zo-wa-rot), ~30 unguarded transitions run, and 11 sites use
  `behavior:'smooth'`. A shared reduced-motion kill-switch now covers `styles.css` +
  the widget CSS, and smooth scrolls are gated on `matchMedia`.
- **Hit targets (fixed):** remaining sub-24px controls floored (chat-tab close 14px,
  history row buttons 22px, code-copy 20px, update-banner dismiss 20px, WA icon 22px);
  hover-only reveals now also reveal on focus/`focus-within` (history row buttons, tab
  close) — a keyboard-focused control is no longer invisible.
- Focus styles were already clean (global amber `:focus-visible`, no `outline:none`).

## Lane 4 — Platform & strings — ✅ clean (nits fixed)

No positive tabindex, no `aria-hidden` misuse, no `role=presentation` on interactives,
no `alert()`/`confirm()`-only error paths (two `confirm()` calls kept — native and
announced), `lang="en"` on both pages. Nits fixed: ambiguous "Show"/"Hide" names,
dead `.msg-footer-fb` CSS, undefined `--bg`/`--radius` vars in options.html,
`aria-label="Show reasoning"` overriding the richer visible name. **i18n census gap
closed:** the census only diffed `_locales` keys — aria-label strings were uncounted;
the census now includes the aria-label surface and its current strings are pinned.

## Findings ledger (round 1)

| # | Severity | Item | Disposition |
|---|---|---|---|
| 1 | **P1** | History cards keyboard-inoperable (clickable divs) | **Fixed in-round** |
| 2 | **P1** | Chat-tab ✕ keyboard-inoperable (span, 14px, hover-only) | **Fixed in-round** |
| 3 | **P1** | `.btn-primary` white-on-amber text 2.03–3.28:1 (Save button fails AA) | **Fixed in-round** |
| 4 | P2 | Focus management absent on popups/dialogs (theme popover, mode overlay, recipe library, history view, write-assist popover; incl. stream re-render dropping widget focus) | **Fixed in-round** |
| 5 | P2 | `prefers-reduced-motion` uncovered (5 infinite keyframes, ~30 transitions, 11 smooth scrolls) | **Fixed in-round** |
| 6 | P2 | `--text-faint` text 2.53–3.24:1 in all five themes | **Fixed in-round** (token lifted per theme) |
| 7 | P2 | Options tabs lack tab semantics; toast/status not live regions; Show/Hide ambiguous | **Fixed in-round** |
| 8 | P2 | Popup rows mousedown-only; status-dot/`＋` span controls; quick-action focus loss | **Fixed in-round** |
| 9 | P2 | Light-theme inline-status colors + widget note/icon-border contrast | **Fixed in-round** |
| 10 | P3 | Hit targets <24px (close ✕, history row buttons, code-copy, banner dismiss, WA icon); hover-only reveals invisible when focused | **Fixed in-round** |
| 11 | P3 | `#tab-strip` listbox mismatch; `tab-strip-collapse`/recipe-lib state attributes; chat tablist arrows/`aria-controls`; mic recording state CSS-only | **Fixed in-round** (tablist arrows + mic recording state included) |
| 12 | nit | aria-label strings uncounted by i18n census; dead CSS; undefined vars; reasoning label override | **Fixed in-round** (census extended + pinned) |

Light/sepia/forest/ocean placeholder contrast verified ≥4.5:1 post-fix; all
`--text-muted`/`--text-soft`/`--zo-primary` pairs already passed and were kept.

`bun run verify` + e2e green; no prompt changes (evals untouched).

---

# Accessibility review — round 2 (bash, unreleased surface)

**Round:** 2026-09-26, on dev `60ec406` + the unreleased navigate-fix/diagnostics-share
branch (`fix/panel-navigate-debug-share`, 877441a) — the first pass over the new
diagnostics UI plus the lanes round 1 did not cover. **Method:** static evidence sweep
(file:line cited per finding) over the write-assist shadow-DOM widget, dynamic state
surfacing (chat tabs, message footers, history view), and the options-page hit-target
sheet; contrast values computed from the exact theme tokens; every fix landed with an
e2e assertion in the existing #307/#309/#342-family specs.

## Round-2 findings ledger

| # | Severity | Item | Disposition |
|---|---|---|---|
| 13 | **P2** | Write-assist shadow-DOM focus indicators: only `.zo-wa-instr` had an outline (`content.js:717`); Close ✕ / Enhance / Accept / Cancel / Retry / follow-up chips had none, and the page's global amber `:focus-visible` ring cannot cross the shadow boundary → WCAG 2.4.7 fail for every widget control | **Fixed in-round** — per-theme `--wa-focus` token (light `#2962b8`, dark `#8ab4f8`, both ≥3:1 on `--wa-bg`) + `:focus-visible` rules on all widget interactives; proven by the new spec-16 shadow-activeElement probe |
| 14 | **P2** | Backgrounded-chat streaming state was color-only: a decorative pulsing dot + mouse-only `title` tooltip; the tab's accessible name never mentioned it → WCAG 1.4.1 fail (`sidepanel.js` renderChatTabs) | **Fixed in-round** — `aria-label` carries "— generating…", dot + 📌 pin are `aria-hidden`; asserted in spec 20 on both backgrounding paths |
| 15 | P3 | History-card glyph buttons (✎ Rename, ⬇ Export, ⧉ Copy id, ↗ Open in Zo, ✕ Delete) resolved names only via `title` fallback — technically named per accname, but fragile and the copy-id title leaks the thread id into the name (`sidepanel.js:1838-1888`) | **Fixed in-round** — explicit `aria-label`s; asserted in spec 37 |
| 16 | P3 | History rename input was placeholder-named ("Chat title") — the exact class of gap round 1 fixed for composer/search inputs, missed here (`sidepanel.js:1948-1953`) | **Fixed in-round** — `aria-label="Rename conversation"`; asserted in spec 37 |
| 17 | P3 | Per-turn context-tier + screenshot footer chips are `<span>`s with `title`-only tooltips — the context-policy decision (what was sent and why) invisible to SRs (`sidepanel.js:2417-2432`) | **Fixed in-round** — `aria-label` = "Context sent this turn: \<tier\> — \<reason\>"; asserted in spec 37 |
| 18 | P3 | `.btn-sm` computed ≈23px in both sheets — sub-24 target (WCAG 2.5.8); the spec-39 options sweep passed only via sub-pixel rounding | **Fixed in-round** — `min-height: 24px` on both `.btn-sm` rules (`styles.css:1628`, `options.html:152`); spec-39 sweeps harden it |

## Checked, passing (no action)

- **New diagnostics-share UI** (unreleased): `#share-status` is `role=status`, the
  button is a named real `<button>`, the global options ring and the disclosure text
  apply; disabled-until-Debug-mode with the note explaining why.
- **Error cards announce**: `.msg-error` lands inside `#messages` (`role="log"`) so
  "Response interrupted" + detail + named ↻ Retry all reach SRs.
- **history-card `<mark>` highlight**: amber 35% mix over card bg — computed
  **13.96:1** light / **7.74:1** dark against the inherited text color.
- **Code-copy / jump-to-latest / empty-state chips**: real named buttons.
- **Token + API-key inputs**: `autocomplete="off"` (deliberate for secrets);
  username field likewise.
- **Forced-colors (Windows High Contrast)**: qualitative pass — all interactive
  chrome keeps borders/text (no background-only affordances); not gated by a test.

`bun test` + `bun run verify` + full e2e green. No prompt changes (evals untouched).
