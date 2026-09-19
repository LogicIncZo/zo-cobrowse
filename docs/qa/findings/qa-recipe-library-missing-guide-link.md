---
key: qa-recipe-library-missing-guide-link
title: "Recipe library popup footer lacks the user-guide link (#257 conformance)"
severity: P3
surface: recipes
source: review
found: 2026-09-19
---
**Spec:** issue #257 UX §Library surface — "Footer: **＋ Import from
workspace…** (path input → `read_file` → `validateRecipe()` → local library) and
a link to the user guide."

**What ships:** the import footer renders, `docs/guide/recipes.md` exists and is
in the VitePress sidebar, but the popup footer has no link to it — the
discoverability story the issue pins (new users find the feature through the
popup) dead-ends at the popup.

**Suggested direction:** a small 📖 Guide link/button in the popup footer opening
the docs-site recipes page (`https://logicinczo.github.io/zo-cobrowse/guide/recipes`
— same host the About pane uses for LogicIncZo links).
