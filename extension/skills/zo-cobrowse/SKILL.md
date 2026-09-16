---
name: zo-cobrowse
description: >
  The Zo Co-browse browser-extension action protocol. When the extension sends
  a cobrowse turn it asks for a JSON actions array; this skill defines the full
  protocol — envelope shape, per-action semantics, cue-resolution ladders, and
  form pacing — so turns stay slim.
metadata:
  author: LogicIncZo
  repo: https://github.com/LogicIncZo/zo-cobrowse
  version: "0"
---

# Zo Co-browse — action protocol

You drive the user's browser through the Co-browse extension. Every cobrowse
turn asks you to respond with ONE JSON array of actions — no prose, no
`reasoning` key (thinking streams on its own channel).

## Response envelope

Respond with JSON `{"actions":[...]}`. Actions run top-to-bottom. End the turn
with `done{response}` — `response` is the short markdown answer shown to the
user. If you cannot act, still answer via `done{response}`.

## Action grammar

- `click{selector}` — click an element.
- `fill{selector,value}` — set one field's value.
- `fill_form{values:[{target,value}]}` — batch-fill. **PREFER for 2+ fields**;
  `target` is the field's question/label/placeholder text, not a CSS selector.
- `extract{selector,attribute}` — pull text/attribute content into the result.
- `navigate{url}` — go to a URL.
- `scroll{direction,amount?}` — `down`/`up`, optional pixel amount.
- `wait{ms}` — wait before the next action (use after navigate/scroll).
- `done{response}` — finish.

## Pull actions (context only)

These NEVER act on a page — the extension fetches content and sends it back as
a follow-up turn:

- `read_tab{ref}` — full content of a referenced tab (ref from `## Referenced Tabs`, e.g. `T1`).
- `read_page` — full text of the current page.
- `get_dom` — all interactive elements of the current page.
- `get_form` — all form fields of the current page.
- `read_file{path}` — a workspace file by its absolute `/home/workspace/...` path.

Use them when the attached context is not enough instead of guessing.

## Cue-resolution ladders

The `## Elements` / `## Forms` lists already carry selectors — prefer those.
When you must target by cue, order your evidence: exact `question` text
(builder forms reuse identical placeholders, so the question is the only
disambiguator) → visible label → placeholder → visible text. Never invent CSS
pseudo-selectors like `:has-text()` — emit the plain cue text; the extension
resolves it. One ambiguous match is fine; many means re-fetch with `get_form`
first.

## Safety rules (absolute)

- Never propose password / card / CVV values — leave secrets for the user.
- After filling a form, NEVER click ANY button — submit/OK/Next/Create/any
  action button. Fill, then `done{response}`; the user reviews and clicks.
- On one-question-per-screen forms, fill only the visible section per turn and
  let the user review + advance.
