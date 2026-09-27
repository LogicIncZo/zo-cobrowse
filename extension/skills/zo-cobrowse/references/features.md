# Zo Co-browse — feature canon

The complete product surface of the Zo Co-browse Chrome extension. Read this
when the user asks what the product can do, asks "can you…", or when you need
to recommend the right feature for a job. It documents what SHIPPED behavior
is — do not assume features that are not here.

**The boundary that governs everything below:** you act ONLY through the
action envelope on the PAGE (protocol in `SKILL.md`). Everything else —
Mode picker, composer, pickers, toggles, popups, recipe checkpoints — is
user-driven panel UI you cannot touch. When a job needs one of those, tell
the user exactly what to click or type.

## Modes (the Mode picker in the panel)

The user picks one Mode per turn; it decides what context attaches and how
you respond.

- 🤖 **Co-browse** — the default action Mode. Sees URL/title, page text,
  clickable elements + form fields (with selectors), returns the JSON action
  envelope. For anything that acts on the page.
- 💬 **Ask** — the reader Mode. Page text attached, plain-markdown answers,
  no actions. Absorbs the old Summarize/Research intents — "summarize this",
  "research this topic" are Ask work.
- 📊 **Extract** — pull structured data (tables, lists, contacts, prices)
  from the page as markdown.
- 👁 **Visual** — screenshot Mode: you see the page IMAGE and answer from
  pixels. Layout/design/visual questions.
- 🪶 **Lean** — URL-only: no content attaches, you never act. The cheapest
  turn; the user asks you to note things on request.
- **Custom Modes** — the user can create/edit Modes (system prompt,
  instructions, context tier, text budget, JSON expectation) in Settings →
  Prompts, or generate one from a description. Honor what they configure.

**Intent downgrade:** in an action Mode, a read-only request ("summarize
this page") auto-downgrades to a plain-markdown read turn — answer in prose,
not the action envelope.

**Context tiers (what attaches per turn):** 0 = URL/title only · 1 = + page
text · 2 = + clickable elements & forms with selectors · 3 = + screenshot.
Read turns default to tier 0 (DOM is opt-in — it is token-costly); action
turns attach automatically on a conversation's first turn and again when the
page changes. `!context <question>` attaches the Mode's full context for one
turn.

## Bang commands (typed in the composer)

One-shot prompt presets and escapes:

- `!help` (or `!commands`) — list them all.
- `!summarize` · `!extract <what>` · `!research <topic>` · `!ask <question>`
  · `!fill [notes]` — canned prompts routed to the matching Mode.
- `!context <question>` — attach full page context for that one turn.
- `!query <nl>` (alias `!data`) — natural language → DuckDB over the user's
  Zo.space data.
- `!auto <instruction>` — create a scheduled Zo automation.
- `!save [path]` — save the page as markdown into the Zo workspace.
- `!export [conversation|page|pdf|<workspace path>]` — export the
  conversation or the page.
- `!skills` / `!skill <name>` — list / run a Zo workspace skill.
- `!handoff <goal>` — start an unattended run (below).
- `!recipe <run|compose|record|save>` — Recipes (below).

When the user describes a task that matches one of these, recommending the
exact command is more useful than a generic answer.

## Recipes (repeatable multi-page workflows)

Playbooks played deterministically by the extension with NO LLM turns:

- Steps: `navigate / fill / click / check / attach / extract / waitFor /
  human / done`, each targeting elements by cue arrays (resolved like
  form-fill ladders).
- `human` checkpoints **park the run** for the user — captcha, OTP, payment,
  and submits are NEVER automated. This is by design, not a limitation to
  work around.
- `!recipe record <name>` — the user does the task once manually; their
  actions become a draft recipe (sensitive fields never recorded).
- `!recipe compose <goal>` — you author one interactively under strict
  boundaries: your fills/submits are refused and parked for the user to
  perform and confirm.
- `!recipe run <name>` — play it. A missed element fires ONE healer
  (redacted re-capture → cue patch) before the run blocks.
- `!recipe save` — write the recipe to the workspace (`/home/workspace/
  recipes/`); the 🧾 library popup runs/imports/exports them.

**Recommend recipes** when the user describes a repeatable flow ("every week
I have to…") — `!recipe record` or `!recipe compose` is the answer, not a
one-off action turn.

## Handoff runs (unattended, read-only-first)

`!handoff <goal>` — the ONLY way an unattended run starts. You chain
continuation turns (progress report + fresh capture each turn) while the
extension enforces boundaries: submit-ish clicks are refused and parked,
fills are parked per the boundary mode, a budget (turns / navigations /
minutes) pauses the run, and `done{response}` completes it. Paused runs
resume only on an explicit user click. Never propose boundary-violating
actions in a handoff continuation — they will be refused.

## Tabs as context

The user references other tabs via the chip strip above the composer (or `@`
autocomplete). You see a compact manifest + short excerpt per referenced tab
(refs T1…Tn). `read_tab{ref}` pulls a tab's full content. Tabs are
**context-only** — you cannot act in a tab other than the active one.

## Pickers & panel surfaces (user-triggered — you cannot drive these)

- `/` — run one of the user's Zo workspace skills this turn.
- `%` — attach workspace files by path.
- `@` — reference browser tabs.
- 📷 toggle (by the tab strip) — forces a screenshot (tier 3) this turn;
  Mode flips to Visual.
- ⚡ write-assist icon (on focused text fields) — a popover that has you
  enhance/rewrite the field's text; the user Accepts to fill it back.
- 🧾 — the recipe library (run / import / export).

When a user asks "can you rewrite this box for me" or "run my X skill",
point them at the exact surface — the write-assist ⚡ icon, the `/` picker —
instead of attempting it through page actions.

## Diagnostics

Debug mode (Settings) records a metadata-only diagnostics ring (kinds,
labels, durations — never page text or tokens). Sharing is user-triggered
from Settings and posts an anonymous text bundle. If a user reports a bug,
asking them to share diagnostics from Settings is the fast path.

## What you must NOT do

- Act anywhere except the active page via the action envelope. No panel UI,
  no pickers, no browser chrome — guide the user instead.
- Click any submit/OK/Next/action button after filling a form (the
  no-auto-submit rule — `SKILL.md` § Safety rules; the extension also
  backstops it in code).
- Propose actions beyond the protocol grammar, or act inside Recipes beyond
  the boundaries above.
- Assume a feature exists that is not documented here.
