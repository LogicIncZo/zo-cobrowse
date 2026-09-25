---
key: qa-mode-switch-page-death
title: Panel Mode switch kills the page (renderer death, automation-reproducible on v0.3.5.0 and dev)
severity: P2
surface: Daily chat flow — Mode select
source: review
found: 2026-09-25
---

**Repro (usability walkthrough #393, A/B-verified):** on the panel, change
`#mode-select` to any other Mode (`selectOption`, any index). The panel page dies
mid-change — no console output, no pageerror, no network error; the Page object
reports closed. Reproduces identically on the **v0.3.5.0 build** and current `dev`
(A/B via `ZO_E2E_EXT=/tmp/zo-ext-335` against a worktree copy of the tagged
`extension/`).

**Never automation-covered:** no e2e or matrix spec has ever `selectOption`'d the
PANEL's mode select (only the options-page `#prompt-mode-select`) — this is the
first automated walk of the path.

**Why owner confirmation is requested:** Mode switching is a daily shell action and
the owner has not reported breakage — the trigger may be headless-specific (the
e2e/matrix environment runs new-headless Chromium). If the real shell reproduces it
(open panel → change Mode → panel dies), this is P1; if shell-safe, triage as a
headless-env crash (still worth fixing — it blinds every future automation pass over
Mode switching).

**Concrete next step:** reproduce in the shell; if real, bisect `applyMode`'s
storage-write → `storage.onChanged` → re-render loop in `sidepanel.js` (the death is
renderer-level, so suspect a runaway mutation/recursion triggered by the change
event). Automation repro: the walkthrough probe
(`zz-crash.spec.ts` pattern — `selectOption({index:1})` then `page.isClosed()`).

**Filed by:** the 0.3.6 usability walkthrough (F1).
