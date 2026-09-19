---
key: qa-skill-export-label-provenance
title: "SKILL.md export carries page-recorded labels/questions — guide should state the provenance boundary"
severity: P3
surface: recipes
source: review
found: 2026-09-19
---
**Finding:** `buildRecipeSkillExport` redacts VALUES (param defaults, captured
literals, contextFile contents) but step detail legitimately includes
page-recorded TEXT: cue values (labels/questions), `human` checkpoint titles +
instructions, and `generate.prompt` strings. A recipe recorded on a page with
manipulative copy can carry that copy into a SKILL.md that Zo later reads.

**Why this is acceptable (documented, not fixed):** export happens only on an
explicit per-row click; the bundle is user-inspectable plain JSON-adjacent
markdown in the user's own workspace; and the pinned R3 boundary keeps execution
extension-side — Zo reading the skill can describe/suggest but never run steps,
so injected text cannot trigger actions. Same trust level the #243 round accepted
for recorder label capture.

**Gap:** the user guide's export section says values are redacted but is silent
about labels/questions riding along — a user could mistake a page-authored
string in SKILL.md for extension-authored text.

**Suggested direction:** one guide paragraph under Skill export: labels,
checkpoint text, and generate prompts come from the pages you recorded and are
worth a skim before sharing a bundle.
