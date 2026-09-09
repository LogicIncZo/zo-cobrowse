---
key: qa-pickers-skills-section-residue
title: The ## Skills to Run section re-appears on follow-up asks after a skill chip turn (send-once violated)
severity: P2
surface: pickers
source: matrix
found: 2026-09-10
---
**What breaks:** after a turn sent with a picked skill chip (section renders,
chip clears — that part works), every subsequent ask in the same chat carries
the `## Skills to Run` section again — including its instruction
"Run each skill above as part of this turn". Zo is thus re-instructed to run
the skill on turns that never picked it.

**Evidence (matrix lane, m4-pickers.spec.ts, clean `__requests` state):**
- Ask 1 (chip picked): User Request `run the picked skill once`, body contains
  `## Skills to Run` ✓ (correct — the send-once delivery).
- Ask 2 (follow-up): User Request `and now without it`, chip bar empty, yet
  the body still contains the identical `## Skills to Run` block.
- The file chip (`## Referenced Files`) does NOT show the residue — the bug is
  specific to the skills section path.

**Contract violated:** AGENTS.md composer pickers — send-once chips "ride the
next ASK_ZO as `skills` … then clear" (`pickedSkills` in sidepanel.js).

**Suggested direction:** audit how the skills section is composed on
follow-up turns — likely a per-chat state (mirroring the tab-manifest
send-once pointers) keeps re-rendering the section; it should render only on
the turn that carried the pick.
