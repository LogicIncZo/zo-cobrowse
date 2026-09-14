# Updates

New features in Zo Co-browse, newest first. Each entry explains what shipped;
open **How to use it** for the hands-on steps.

## Recipes — repeatable multi-page workflows <span class="badge-new">NEW</span> {#recipes}

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
