---
key: qa-recipe-rename-double-commit
title: "Inline rename can double-commit (Enter + blur race) and surface a spurious error"
severity: P3
surface: recipes
source: review
found: 2026-09-19
---
**What breaks:** the library row's ✎ Rename input commits on Enter AND on blur.
`commit()` is async (awaits `RECIPE_RENAME`): if the user presses Enter and clicks
away before the round-trip lands, blur fires `commit()` a second time with the
same input — the first send already moved the library key, so the second returns
"no local recipe named …" and the panel shows an error for a rename that
succeeded.

**Repro (deterministic):** open library → ✎ → type a new name → Enter →
immediately click another row within the sendMessage round-trip window. In
automation the window is trivially hit; by hand it is a fast-click race.

**Suggested direction:** a `committed` flag on the input's closure — first commit
wins, later Enter/blur no-ops.
