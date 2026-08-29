# Lean Mode — URL-only, no page interaction

**Date:** 2026-08-29
**Status:** Approved design (Approach A of three considered)
**Scope:** extension only — `extension/lib/modes.js`, `extension/lib/prompt.js`, tests, docs

## Problem

Sometimes the user doesn't want Zo to interact with the page at all. They want to
hand Zo a URL + a query and let Zo work entirely server-side: fetch the page
itself (if accessible — they accept that geoblocked/paywalled URLs may fail),
take notes, and cross-reference its memory.

Today the **transport** for this already exists: the context policy
(`decideTurn`) sends tier 0 (URL + title only) for every read turn by default.
What's missing is the **contract**: there is no Mode whose system prompt,
instructions, and response format express "you will not see the page, fetch it
yourself, never act". Worse, on tier-0 turns the existing read Modes'
instructions say *"Answer using the page content provided"* — which is false
when no content is attached — and the generic read-downgrade tail
(`prompt.js`) says the same. Zo receives a URL it doesn't know it may fetch.

## Design

Two changes, both small.

### 1. New built-in Mode `lean`

Added to `BUILTIN_MODES` in `extension/lib/modes.js` (7th builtin, after
`visual`):

```js
lean: {
  id: 'lean',
  name: 'Lean',
  systemPrompt: "You are Zo — the user's AI companion. You receive only the current page's URL and title plus the user's request; you do NOT see the page itself.",
  instructions:
    'The page content is NOT attached. If you need the page, fetch the URL ' +
    'yourself with your web tools; if it is inaccessible, paywalled, or ' +
    'geoblocked, say so plainly instead of guessing. Never return browser ' +
    'actions — this Mode cannot control the page. When the request is ' +
    'note-shaped (note/remember/file/save this), write the note and ' +
    'cross-reference your memory.',
  contextTier: TIER.POINTER,  // 0 — URL + title only, always
  textBudget: 1000,           // inert at tier 0; matches visual
  expectJson: false,          // plain markdown; no action envelope, ever
  builtin: true,
}
```

Resulting prompt shape (the leanest the extension can send while still pointing
Zo at the page):

```
<systemPrompt>

## Page
- URL: …
- Title: …
- Viewport: 1920x1080

## User Request
<query>

<instructions>
Respond in plain markdown.
```

Nothing else is new UI: the Mode lands in the sidepanel dropdown via
`rebuildModeOptions`, is user-tunable in Settings → Prompts via the existing
sparse-override machinery (`mergeOverride`/`EDITABLE_MODE_FIELDS`), and the
assistant footer already shows the 🔗 URL-only context-tier chip.

### 2. Tier-0 honesty fix in `prompt.js` (all Modes)

In `_compose()`:

- **Downgrade tail** (`jsonDisabled` branch): when `tier === 0`, replace
  *"Answer the request directly using the page content provided."* with a
  tier-0 variant: *"Only the page URL and title are attached — fetch the page
  yourself if you need its content. Answer the request directly."*
- **Mode-owned instructions**: for every Mode, when `tier === 0` and a page
  pointer exists (`!noPagePointer`), append one clarifier line to the `tail`
  section: *"Page content was not attached this turn — only the URL and title
  above. If you need the page's content, fetch it yourself (web fetch, or
  read_page)."* The `read_page` mention keeps this safe on the one tier-0 case
  where the Mode IS an action mode (Co-browse same-page follow-ups): Zo can
  still pull content through the sanctioned action instead of drifting to
  browser-side assumptions.

This is a genuine bug fix independent of Lean Mode: `ask`/`research`/
`summarize` turns hit the lying tail today on every default read turn.

### Context-policy interplay (no code change)

- `lean` has `expectJson:false`, so `decideTurn` classifies every turn as
  read → `effectiveTier` 0, always. There is no attach path.
- `!context` / manual refresh attach "at the Mode's tier" — for Lean that is
  tier 0, so they cannot escalate. This is by design: the user picks Lean
  precisely to keep the payload at URL-only; to give Zo the page, switch Modes.
- Tab references (T1…Tn) and `read_tab` still work in Lean Mode: they are
  prompt sections, not DOM captures, and `read_tab` is a context-only follow-up
  handled by the background loop. `read_page`/`get_dom`/`get_form` pull actions
  are also still honored by the background (they capture the page the user is
  on — consistent with "Zo doesn't act, it reads"). No gating change.

### Screenshot toggle interaction

The 📷 toggle forces `effectiveTier` 3 for one turn regardless of Mode. In Lean
Mode this still works (a screenshot rides in, Visual-style) — but it contradicts
Lean's contract. No code change: the toggle is an explicit user override, same
as `!context`, and the inspector shows the escalated tier. Users who want Lean
don't arm the toggle.

## Error handling

No new failure modes: tier-0 capture is the cheapest path (`getActiveTabContext`
returns url/title without touching content scripts at higher tiers). If the URL
is unreachable by Zo's server-side fetch, the instructions require Zo to say so
instead of guessing — the failure surfaces in the answer, not silently.

## Testing

- `tests/modes.test.ts` — `lean` present in `BUILTIN_MODES`, validates against
  the modes schema (`contextTier` 0, `expectJson` false, `builtin` true);
  `resolveMode('lean', …)` round-trips; sparse override editing works.
- `tests/prompt.test.ts` —
  - `buildPrompt(leanMode, tier0Ctx, q)` contains `## Page` + `## User Request`
    and NO `## Page Content` / `## Elements` / `## Forms` / `## Screenshot`;
    tail contains the mode instructions + no action schema.
  - Downgrade path: Co-browse + read query + `effectiveTier` 0 → tail uses the
    tier-0 variant, not "page content provided".
  - Clarifier line: `ask` mode with `effectiveTier` 0 → tail includes the
    "not attached" clarifier; with tier 1 → absent.
- `tests/context-policy.test.ts` — `decideTurn` with a Lean-like mode
  (`expectJson:false`) always resolves `effectiveTier` 0, including on
  `forceRefresh`.
- No schema changes needed: `tests/schemas/modes.ts` validates by shape; the
  prompt schema (`tests/schemas/prompt.ts`) already carries tier + sections.
- E2E: none required (no new UI surface; the mock routes on `## User Request`
  content, unaffected).

## Docs

- `AGENTS.md` — Mode list mention (one line) + prompt.js bullet.
- Root `CHANGELOG.md` `[Unreleased]` + mirror in `docs/changelog.md`.
- `BACKLOG.md` not affected (new idea, lands directly).

## Rejected alternatives

- **`!lean` bang command** — per-turn plumbing (schema union + sidepanel
  wiring) for a need that is a session-long posture, not a one-turn one; Modes
  already give per-conversation persistence.
- **Tail fix only, no Mode** — cheapest, but the system prompts of existing
  modes still claim "You see the page they're on" and the user cannot persist
  the lean posture.
