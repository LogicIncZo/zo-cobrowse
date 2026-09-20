# Updates

New features in Zo Co-browse, newest first. Each entry explains what shipped;
open **How to use it** for the hands-on steps.

## A more legible, more reachable panel <span class="badge-new">NEW</span> {#ux-bash}

_2026-09-20 · [#296](https://github.com/LogicIncZo/zo-cobrowse/issues/296)–[#315](https://github.com/LogicIncZo/zo-cobrowse/issues/315) · v0.3.3.0_

Twenty fixes from a full UX audit of the panel, options, and onboarding — the
theme is legibility and reachability:

- **Everything is readable in every theme.** Footer text, chips, labels, and
  reasoning prose now clear WCAG AA contrast in all six themes — including
  sepia and the light default that had been failing quietly.
- **Keyboard and screen-reader users get real affordances.** Every icon button
  announces what it does; the connection status has a text form; a consistent
  focus ring shows keyboard users where they are; all 24-pixel hit targets.
- **Nothing vanishes.** A failed turn keeps its error card (with working
  Retry) across reloads; skipping parked actions leaves a note in the chat
  saying exactly what was skipped.
- **Unattended turns are transparent.** Handoff continuation turns show the
  context-tier chip — what Zo could see — right on the turn.
- **Details that were almost right.** Same-titled tabs are now distinguishable
  everywhere (including in the prompt Zo receives); the first-run tour points
  at a real Open-settings button instead of a gear icon that never existed;
  the prompt inspector has a Copy button; the theme setting lives under
  About → Appearance.

## Teach by stating: Zo composes your recipes <span class="badge-new">NEW</span> {#recipe-compose}

_2026-09-19 · [#289](https://github.com/LogicIncZo/zo-cobrowse/issues/289) + [#290](https://github.com/LogicIncZo/zo-cobrowse/issues/290) · v0.3.2.0_

The strongest recipe-authoring act is the one you already did: watching Zo
complete a flow. Two new ways to turn that into a reusable artifact:

- **Save a Zo-run as a recipe.** When a `!handoff` run finishes, the done card
  offers **↧ Save as recipe**. The executed steps — minus everything Zo was
  refused — become a draft: refused actions turn into human checkpoints, and
  anything Zo filled becomes a parameter *you* fill on every run (Zo-invented
  values are discarded, never saved). A cleanup pass tidies the steps; the
  artifact must pass the same validator every recipe answers to.
- **`!recipe compose <goal>`.** Zo walks a flow to compose a recipe and is
  **never allowed to fill or submit — enforced in code, not by politeness**.
  When a form blocks the path, a park card asks you to fill it on the page;
  when two controls are ambiguous, you pick; submits stay yours. Your
  on-page actions become the draft's defaults. `!recipe compose stop` ends it.
- **The first run verifies.** Composed drafts are marked
  🤖 composed · unverified. Their first replay is a **rehearsal** — checkpoints
  cannot be skipped — and passing it marks the recipe verified. A failed or
  abandoned rehearsal leaves it a draft, honestly.

## Recipes go portable — workspace write-back, library panel, skill export <span class="badge-new">NEW</span> {#recipe-library}

_2026-09-19 · [#256](https://github.com/LogicIncZo/zo-cobrowse/issues/256) + [#257](https://github.com/LogicIncZo/zo-cobrowse/issues/257) · v0.3.1.0 / v0.3.1.1_

The recipes story from [September 14](#recipes) closes its roadmap — your
learned flows are no longer stuck in one browser:

- **Save to workspace.** Any learned recipe writes back to
  `/home/workspace/recipes/<name>.json` — plain, inspectable JSON that follows
  you across machines. The learned-recipe card offers the save; an existing
  target asks before overwriting; drifted content bumps the patch version so
  the newest artifact always wins.
- **Healed cues persist.** When a run self-heals a recipe that came from the
  workspace, the completion card offers **↥ Save healed cues** — the fix is
  patched into the source file (parameters intact), so the next run from that
  file doesn't pay the heal cost again.
- **🧾 Recipe library panel.** A new button by the composer opens every saved
  flow: run it, rename it, delete it (local only — workspace files are never
  touched), import a workspace JSON (invalid files show the validator's exact
  errors), or export it.
- **SKILL.md export.** One click bundles a recipe to
  `/home/workspace/Skills/<name>/SKILL.md` following the Zo skill format, so
  Zo itself can *suggest* a saved flow when it recognizes the task.
  Documentation only — flows still execute in the extension's deterministic
  player, never Zo-side, and captured values are redacted before anything
  leaves the browser.
- **v0.3.1.1 polish** (stabilization round): `!recipe list` shows where each
  recipe lives and its last-run status; library rows badge the last run; the
  popup links to the [guide](https://logicinczo.github.io/zo-cobrowse/guide/recipes).

<details>
<summary><b>How to use it</b></summary>

**Save a learned recipe to the workspace** — right after recording, the
"🧠 Learned locally" card offers the one-click save, or from the command line:

```
!recipe save my-flow                    ! → /home/workspace/recipes/my-flow.json
!recipe save my-flow recipes/custom.json --force   ! custom path, overwrite
```

**Open the library:** press **🧾 Recipes** by the composer's option row. Each
row shows name, version, steps, required parameters (`*`), where it lives
(💻 local vs 🌐 workspace), and its last-run status. **▶ Run** starts it
(the params card appears for required parameters), **✎ Rename** edits inline,
**🗑 Delete** removes the local entry after a confirming second click.

**Import from the workspace:** paste a path into the popup's
`/home/workspace/recipes/…` footer and press **＋ Import** — the file is
validated before it lands, and bad files explain exactly which rule they broke.

**Export a skill:** **⤓ Export** on a row writes
`/home/workspace/Skills/<name>/SKILL.md` (+ `references/recipes.md`) — give it
a skim before sharing: values are redacted, but labels and checkpoint text come
from the pages you recorded. Full details in the
[recipes guide](https://logicinczo.github.io/zo-cobrowse/guide/recipes).

</details>

## Recipes — repeatable multi-page workflows {#recipes}

_2026-09-14 · [#220](https://github.com/LogicIncZo/zo-cobrowse/issues/220)_

A **recipe** is a saved, multi-page workflow you can replay anytime — the
extension drives your tab step by step (navigate, fill, check, attach,
extract), and **pauses at the steps only a human should do**: captcha, OTP,
payment. Nothing is improvised: playback is deterministic, so the same recipe
does the same thing every run.

Highlights:

- **Human checkpoints by design.** Payment/OTP/captcha steps are declared
  `human` steps — the run parks, shows you a card with instructions, and
  resumes only after verifying you actually landed where you said you would
  (e.g. the post-payment page). Payment submits are *never* auto-clicked —
  that's enforced in the recipe format itself, not just promised.
- **Typed parameters.** Fields that change per run (name, department, financial
  year) are `{{parameters}}`; a card prompts for them when the run starts.
- **Self-healing.** If a page changed and a step's cues no longer match, the
  run asks Zo once to repair the cues, bumps the recipe's version, and retries.
- **Learn by doing.** Record a flow manually once — the extension watches,
  writes the recipe draft, and Zo cleans it up. Sensitive pages you visited
  while recording become human checkpoints automatically, and sensitive field
  values are never recorded.
- **Evidence.** Steps can extract values (a registration number, an application
  ID) that are reported in the chat when the run finishes — and can feed later
  steps.
- **Attach files.** Steps can attach a workspace file (PDF, image, up to ~1 MB)
  to a form's file input.
- **Zo drafts field values at run time.** A fill step can be marked
  *generated*: when the run reaches it, Zo writes the field's content fresh —
  from a prompt in the recipe and optionally a workspace document — while your
  contact details stay static. Generated values can require your review before
  they're filled.

<details>
<summary><b>How to use it</b></summary>

**Run a recipe** (a JSON file in your Zo workspace, e.g.
`recipes/rti-filing.json`):

```
!recipe run recipes/rti-filing.json
```

- If the recipe has parameters, a card appears — fill them and press
  **Start run**.
- The 🧾 progress line shows where the run is; **✕ stop** aborts.
- At a human checkpoint, do the manual part on the page (pay, enter the OTP),
  then press **Done — verify**. If the automatic check can't confirm your
  step, **Skip check** continues anyway.
- Extracted evidence lands in the chat when the run finishes.

**Learn a recipe from a manual run:**

```
!recipe record my-flow
```

Click through the flow yourself (multiple pages are fine), then press
**✕ stop** on the ⏺ recording line. The learned recipe is saved locally —
replay it with `!recipe run my-flow`. Sensitive pages you visited while
recording become human checkpoints automatically.

**Manage:**

```
!recipe list        # what's saved (workspace recipes load by path)
!recipe stop        # stop the live run (or an in-progress recording)
```

A recipe is plain JSON — steps, cue arrays (label/question/aria/selector —
never a single brittle selector), and `{{parameters}}`. Author one in
`/home/workspace/recipes/` and run it by path.

**Have Zo draft a field at run time** (#228) — static where you want it,
generated where you don't:

```json
{
  "type": "fill",
  "cues": [{ "strategy": "question", "value": "RTI Application text" }],
  "evidenceKey": "application_text",
  "generate": {
    "prompt": "Draft an RTI application to the PIO of {{department}} requesting the FY {{fy}} annual report. Formal, first person. Applicant: {{applicant}}.",
    "maxChars": 3000,
    "contextFile": "/home/workspace/notes/draft-points.md",
    "review": true
  }
}
```

`review: true` shows you the draft (editable) before it fills; generated text
lands in the run's evidence either way.

</details>

## 0.2.9 — quick wins <span class="badge-ver">v0.2.9</span> {#0-2-9}

_2026-09-14_

Four quality-of-life features shipped together:

- **Read workspace files in chat** — Zo can pull a file from your workspace
  into the conversation on demand (`read_file`), so "summarize the notes I
  saved" just works.
- **Pinned chat tabs** — pin the chats you keep coming back to; they stay
  first, survive restarts, and restore where you left them. Chats also export
  as Markdown.
- **Export everywhere** — `!export` saves the conversation as Markdown, the
  page as a note, or opens a reader-view PDF; chats can be written straight to
  your Zo workspace.
- **Write-assist, live** — the ✎ Zo icon on text fields now **streams** its
  suggestion as it's written, and follow-up chips (Shorter / Formaler / your
  own) rework the result in place.

<details>
<summary><b>How to use it</b></summary>

- **read_file**: just ask — "pull up `notes/rti-checklist.md` and summarize
  it". Zo fetches it from the workspace itself.
- **Pin a chat**: right-click a chat tab → pin. Pinned tabs sort first and
  survive browser restarts.
- **Export**: `!export` (Markdown download) · `!export page` (page as note) ·
  `!export pdf` (reader-view PDF) · `!export recipes/my-note.md` (write to
  your workspace).
- **Write-assist**: focus any text field, click the ✎ Zo icon, describe the
  improvement — the result streams in live. Use the chips to iterate
  (Shorter, Formaler, or a custom instruction), then **Accept** to fill.

</details>

## 0.2.8 — the stabilization bash <span class="badge-ver">v0.2.8.x</span> {#0-2-8}

_2026-08 → 2026-09-14_

Fifteen point releases (`0.2.8.0` – `0.2.8.15`) that verified and hardened
everything shipped in 0.2.0–0.2.7: honest screenshot failures, Zo web deep
links (open any conversation on zo.computer), streaming and form-fill fixes,
and a QA-agent pass that closed every finding it filed. No new features by
design — this was the "trust what's there" release train.

## 0.2.7 — handoff: delegate a goal to Zo <span class="badge-ver">v0.2.7</span> {#0-2-7}

_2026-09-03_

`!handoff <goal>` gives Zo a goal it works **unattended and read-only**: it
navigates your tabs, extracts, compares — and reports back a digest. Boundary
rules park anything it shouldn't do (clicks, fills) for you to run from the
review card; a ▶ badge shows while it works; runs survive service-worker
restarts and can be resumed.

<details>
<summary><b>How to use it</b></summary>

```
!handoff compare the pricing across these five product tabs
```

- Zo works the pages read-only and posts a digest when done (or when it needs
  you).
- **✕ stop** on the progress line aborts; **▶ Resume** continues a paused run.
- Anything parked by the read-only boundary lands in the review bar — you run
  those yourself.

</details>

## Earlier highlights <span class="badge-ver">v0.2.0–0.2.5</span> {#earlier}

- **Form-fill with review (0.2.0)** — Zo batches form fills by question text;
  sensitive forms (password/card/CVV) gate behind a review card, and Zo never
  clicks submit for you.
- **Chat tabs (0.2.2)** — several conversations open at once; streams survive
  switching.
- **Modes, rationalized (0.2.5)** — five built-ins (Co-browse, Ask, Extract,
  Visual, Lean 🪶), editable in Settings, plus the `!context` one-turn attach
  and the prompt inspector.
- **Vision gate (0.2.4)** — the 📷 toggle sends a real screenshot; models
  without vision are flagged honestly.
