---
key: qa-recipe-rows-no-last-run
title: "Library rows omit last-run status (#257 conformance)"
severity: P3
surface: recipes
source: review
found: 2026-09-19
---
**Spec:** issue #257 UX §Library surface — "Rows: name, `vX.Y.Z`, step count,
param chips (`applicant*` = required), source badge (local / workspace path),
**last-run status if a run exists**."

**What ships:** rows render name/version/steps/params/source but no run status —
`recipeList()` already loads the runs store (for `liveRun`) but only surfaces the
single live run; terminal last-run status per recipe is dropped on the floor even
though the data is in hand.

**Suggested direction:** derive `lastRun: {status, endedAt}` per recipeId in
`recipeList()` (latest run by updatedAt from the runs store) and render a badge
(▶ running / ✅ done / ⛔ blocked…) on rows; live run keeps the existing confirm
behavior.
