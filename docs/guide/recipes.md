# Recipes

A **Recipe** is a saved, repeatable multi-page flow — for example an
application form you file every month. Teach it once by recording yourself
clicking through it, then replay it any time: Zo Co-browse drives the pages
deterministically (no AI turn per step), pauses wherever a human is required,
and collects the values you need into the chat.

Recipes are safe by construction:

- **Submits stay human.** A recipe may never click a submit-style button on
  its own — a recipe whose step list violates this refuses to save at all
  (the machine-checked invariant), and a recorded payment step always becomes
  a checkpoint you click yourself.
- **Sensitive pages collapse to one checkpoint.** Record a flow through a
  payment or login page and the recorder will not attempt to script it — the
  whole sensitive stretch becomes a single **human checkpoint**.
- **Values you type are never captured.** Field values you enter while
  recording become *parameters* the replay asks for — the recorded literal
  never lands in the recipe.

## Record a flow

In the panel, run:

```
!recipe record my-flow
```

Click through the flow by hand — across pages if needed — then press **✕
stop** on the recording line. The recorder assembles a draft, asks Zo for a
best-effort cleanup (parameter names, cue fixes), and saves the result into
your local library. Replay it with `!recipe run my-flow`.

Recorder limits worth knowing:

- **OS file dialogs are invisible** to the recorder — an `attach` step is
  parameterized (you pick the file at replay time).
- **Cross-origin iframes and deep shadow DOM** may need a first-run cue fix
  (see Healing below); the recipe plays fine after that.
- **Checkbox clicks record their direction** (check vs uncheck), not a blind
  click.

## Run a recipe

```
!recipe run my-flow              ! a local library recipe
!recipe run recipes/rti.json     ! a workspace file (/home/workspace)
```

The run drives its own tab. If the recipe declares parameters, a params card
collects them first. The progress line above the chat shows the current step;
**✕ stop** aborts.

**Human checkpoints.** When the flow reaches a `human` step (payment, OTP,
captcha, terms…), the run parks and shows a checkpoint card: do the step by
hand, then press **Done — verify** (the run checks the declared postcondition,
e.g. the URL changed) or **Skip check** if you just want to continue.

**Generated fills.** A step can ask Zo to *draft* its value at replay time
instead of taking a parameter — for example "write a short application note".
The run parks with a preview card; edit the draft, **Fill with this**, or
**Discard**. Length is capped by the recipe (`maxChars`); an over-long draft
parks rather than being silently clipped.

**Extraction.** `extract` steps pull values (a registration number, a
reference id) into the run's evidence; the done summary lists them and they
can be interpolated into the final message.

**Healing.** If a step's cues no longer match the page (the site renamed a
field), the run makes exactly **one** repair attempt: it shows Zo the field
structure (never your values) and the near-miss candidates, patches the cues,
and retries. The healed cues are cached locally — and if the recipe came from
a workspace file, the completion line offers **↥ Save healed cues** to push
the fix back to the source file.

## The workspace (R2)

Local library entries live in this browser only. **Save to workspace** writes
a recipe as plain JSON to `/home/workspace/recipes/<name>.json` — portable,
inspectable, and available from any machine you sign into:

- The learned-recipe card offers **↥ Save to workspace** after recording.
- `!recipe save <name> [path]` does the same from the command line
  (an existing target asks for confirmation first; `--force` pre-confirms).
- If the workspace copy drifted, saving bumps the patch version so the newest
  artifact always wins.

The written file is exactly what the player reads back — save, load, and
replay round-trip losslessly.

## The library panel (R3)

The **🧾 Recipes** button (by the composer's option row) opens the recipe
library:

- Each row shows the name, version, step count, parameters (`*` = required),
  and where it lives (💻 local vs 🌐 workspace import).
- **▶ Run** replays (a second click confirms if another run is live),
  **↥ Save** writes it to the workspace, **✎ Rename** and **🗑 Delete**
  manage the local entry, **⤓ Export** bundles it as a Zo skill.
- **＋ Import** pulls a workspace JSON file into the local library — invalid
  files refuse with the validator's exact errors.
- Deleting never touches workspace files; the workspace is your source of
  truth and the extension only ever writes files you explicitly asked for.

## Skill export

**⤓ Export** writes a `SKILL.md` bundle to
`/home/workspace/Skills/<skill-name>/` describing your flows — parameters
(without defaults), step tables, and the human checkpoints. Zo can then
*suggest* a saved flow when it recognizes the task. This is documentation
only: executing a recipe always happens in the extension's deterministic
player, never from the Zo side, and captured values are redacted before any
markdown leaves the browser.

## Commands

| Command | What it does |
|---|---|
| `!recipe record [name]` | Record a manual flow and learn a recipe |
| `!recipe run <path\|name>` | Replay a workspace file or local recipe |
| `!recipe save <name> [path]` | Write a local recipe to the workspace |
| `!recipe list` | Text list of saved recipes |
| `!recipe stop` | Stop the recording or the live run |

The [recipes design spec](https://github.com/LogicIncZo/zo-cobrowse/blob/main/docs/superpowers/specs/2026-09-14-recipes-design.md)
covers the artifact format and the player internals.
