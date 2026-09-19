---
key: qa-recipe-list-no-origin-drift
title: "`!recipe list` drops the origin/drift info the extended RECIPE_LIST payload carries (#256 conformance)"
severity: P3
surface: recipes
source: review
found: 2026-09-19
---
**Spec:** issue #256 UX §1 — "No auto-sync in R2. Local and workspace copies may
drift; `!recipe list` (extended payload) shows `origin` + which copy is newer so
drift is *visible*, not hidden."

**What ships:** `recipeList()` extends the payload (origin, source, updatedAt,
params) and the R3 library popup badges workspace-sourced rows (🌐 + path), but
the `!recipe list` bang still renders the pre-R2 line (`- **name** vX — N steps ·
draft`) — a user managing recipes over the command line never sees where a recipe
came from, so local-vs-workspace drift is invisible on that surface.

**Which copy is newer:** resolvable without extra MCP calls — after any save the
round-trip + drift-bump rule keeps the workspace artifact's `version` ≥ the local
one, and both copies carry `version`; rendering `origin` + `version` per line
answers the visibility requirement.

**Suggested direction:** extend the `!recipe list` renderer to append the origin
path (workspace-sourced entries) and the version; no new payload fields needed.
