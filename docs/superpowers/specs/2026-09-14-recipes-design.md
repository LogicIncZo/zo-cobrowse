# Recipes Design — repeatable multi-page workflows as a first-class primitive

**Decided:** 2026-09-14 (plan approved by owner; amends #220's out-of-scope list — record-from-manual-browsing pulled into scope per owner direction the same day).
**Issue:** [#220](https://github.com/LogicIncZo/zo-cobrowse/issues/220) · **Milestone:** `0.9.0` · **Delivery:** 4 staged PRs to `dev` (`feature/recipes-schema` → `-player` → `-heal-e2e` → `-recorder`). Tagging `v0.9.0` stays owner-called.

## Charter

Turn the ephemeral multi-page flow ("Zo re-plans from goal text every run; trust-critical steps are parked as exceptions") into a **durable, typed, parameterized artifact** — a Recipe — that a **deterministic player** executes with **no LLM turn per step**, pausing at **declared `human` checkpoints** (captcha / OTP / payment) and resuming on machine-checked postconditions. The v0.2.0 no-auto-submit rule becomes a **schema + runtime guarantee** instead of a prompt rule. Two authoring paths: hand-authored workspace JSON, and **record mode** — the user completes the flow manually once, the extension learns a draft recipe.

Non-goals (this cycle): scheduling/alarms, credential storage (never), branching/looping DSL, cross-tab recordings, panel library UI + SKILL.md share (R3), workspace write-back of healed/learned recipes (R2+).

## 1. The artifact — `extension/lib/recipes.js` (pure)

```js
Recipe {
  id: 'rcp-<slug>', name, version: 'MAJOR.MINOR.PATCH', origin,   // workspace path | 'local' | 'recorded'
  draft?: true,                       // learned, not yet LLM-cleaned / human-reviewed
  createdAt, updatedAt,
  params: [ { name, type: 'string'|'number'|'url', required, question, default? } ],
  steps: Step[]
}

Step (discriminated on type):
  navigate { url, expectUrl? }                       // expectUrl = substring/glob-ish match
  fill     { cues, value }                           // value may contain {{param}}
  click    { cues, submitish? }
  check    { cues, checked? = true }                 // checkbox | radio
  attach   { cues, path }                            // workspace file → base64 → DataTransfer
  extract  { cues, attribute?, evidenceKey, label }  // value lands in run.evidence
  waitFor  { cue? | url?, timeoutMs? ≤ 15000 }       // element- or URL-condition
  human    { title, instructions, resumeOn: { url?, cue? }, timeoutMinutes? }
  done     { message? }
```

`Cue { strategy: 'selector'|'text'|'label'|'aria'|'placeholder'|'question', value }` — a cue **array**, tried in declared order, resolved by the same ladders the executors already use (selector → `isValidCssSelector`/`querySelector`; `text` → clickable text-match; `label`/`aria`/`placeholder`/`question` → the `resolveFieldTarget` ladder). Recorded/learned recipes are resolvable by construction because recording snapshots the same metadata.

**`validateRecipe(recipe)` → `{ok, errors[], warnings[]}`** — the load-bearing function:

- **E-INVARIANT (the #220 guarantee):** a `click{submitish:true}` step is legal **only** as the step immediately following a `human` step. Everything else is a validation error — a recipe that would auto-click a submit button cannot be saved, loaded, or run.
- Errors: unknown step type, empty `cues` on interactive steps, `attach`/`fill` missing value/path, `human` missing `resumeOn`, unknown `{{param}}` reference, duplicate param names, `waitFor` over cap.
- Warnings: selector-only cue array (single strategy, brittle), missing `expectUrl` on `navigate`, missing `question` cues where a label was available.

Also pure: `substituteParams(recipe, values)` (returns `{ok, recipe, errors[]}`), `bumpVersion(v, 'patch'|'minor'|'major')`, `recipeProgress(run, now)` (panel line text), `healPrompt(recipe, step, miss)` and `generateRecipePrompt(draft)` (prompt builders consumed by background; unit + eval tested).

Zod contract: `tests/schemas/recipes.ts` (`RecipeSchema`, `StepSchema` discriminated union, `RecipeRunSchema`, validation-result union) in the established `tests/schemas/handoff.ts` style.

## 2. The player — `extension/background.js`

**Storage:** `cobrowse_recipe_runs` in `chrome.storage.session` (handoff-store pattern): `RecipeRun { runId 'rec-…', recipeId, name, originPath|localName, version, chatId, tabId (pinned), status, stepIndex, params, evidence[{key,label,value,ts}], healCount, stopReason, createdAt, updatedAt }`. Statuses: `running → waiting_human | healing | paused | blocked | done | aborted`; SW-restart orphan sweep (same IIFE pattern as handoff) → `paused` ("extension restarted — resume to continue").

**Messages** (registered in `tests/schemas/messages.ts`; contract test enforces the background cases): `RECIPE_START {chatId, tabId, source: {workspacePath}|{localName}, paramValues?}` · `RECIPE_RESUME {runId, force?}` · `RECIPE_STOP {runId, reason?}` · `RECIPE_STATUS {runId|chatId}` · background push `RECIPE_UPDATE {run}` (mirrors `HANDOFF_UPDATE`; lands in `BACKGROUND_PUSH_TYPES`). `RECIPE_START` flow: load (workspace via `readWorkspaceFile` + `safeWorkspacePath`, or `storage.local['cobrowse_recipes']`) → `JSON.parse` → `validateRecipe` → `substituteParams` (missing required ⇒ `{ok:false, needsParams:true, params}`; the panel renders a params card and re-sends) → pin tab → play.

**Step loop (event-driven, never SW-resident):** one step per async continuation, run state persisted before/after each step; each step is short (executor internal timeouts ≤ 8s, waits ≤ 15s), so between-step idling never strands the SW — and a kill mid-run is honest `paused` via the sweep, resumable from persisted `stepIndex`.

- `navigate` → `chrome.tabs.update` + load wait + `expectUrl` verify (miss → park `blocked`, never guess).
- Auto steps (`fill/click/check/attach/waitFor/extract`) → `executeActions([{type:'recipe_step', step, dataB64?}])` with `opts.recipe` (below). `extract` values append to `run.evidence` + `RECIPE_UPDATE`.
- `human` → persist + status `waiting_human` + `RECIPE_UPDATE` (panel renders the checkpoint card). `RECIPE_RESUME` re-captures the tab and verifies `resumeOn` (URL match / cue present): holds → continue; not yet → honest "condition not met yet" (stay waiting); `force:true` = manual fallback, continue with a warning recorded. `timeoutMinutes` evaluated lazily against `now` on next event (no timers).
- `done` → terminal `RECIPE_UPDATE` with the evidence list; the panel persists it as a system message in the run's conversation.

**Safety layering (the boundary interplay):**

1. Schema: E-INVARIANT at load (learned recipes too — `validateRecipe` gates the save).
2. Runtime: the player re-checks the invariant before executing any `submitish` click (defense in depth; a patched/healed artifact can't smuggle one in).
3. Executor: declared recipe clicks pass `{recipe:{allowPostFillClick:true}}` so the `filledPages` post-fill button block doesn't fire on deliberate steps — but the **sensitive-page submit probe (`SUBMIT_TEXT_RE`) stays always-on**: a payment submit is never auto-clicked; it parks the run `blocked` with "review and pay yourself". `checkBoundary` still gates everything the readonly allowlist excludes.

**Healer (cue-miss):** on `{cueMiss:true, tried[], candidates[]}` → exactly one re-ground per run (`healCount` cap 1): redacted tier-2 capture (`redactValue` on sensitive formFields before any prompt leaves the extension) + failing step + near-miss candidates → `healPrompt` → one-shot `POST /zo/ask {input, model_name}` (the `generateMode` pattern — no conversation_id, no stream port) → `JSON.parse {cues:[…]}` → validate → patch the run's copy, `bumpVersion('patch')`, cache the healed recipe in `storage.local['cobrowse_recipes']` (workspace write-back is future) → retry the step once. Healer fail/timeout/unparseable → `blocked` with reason.

## 3. Content executor — `executeRecipeStep` (content.js + background twin)

New action `{type:'recipe_step', step, dataB64?}` handled by content.js `executeAction` and mirrored in background's serialized `executeDomAction` (the established twin-copy rule). Resolution: try `step.cues` in order; ops map onto existing machinery — click (`scrollIntoView`+`el.click()`), fill (`writeFieldValue` pipeline, SELECT text-match semantics), check (`el.checked` + `fireValueEvents`), attach (base64 → `File` → `DataTransfer` → `input[type=file].files` + change event; ~1 MB cap per the RTI worked example), waitFor (`waitForElement` / URL poll), extract (`textContent`/attribute). Cue-miss returns `{ok:false, cueMiss:true, tried:[…], candidates:[{text,selector}…]}` — near-misses feed the healer prompt. `recipe_step` is player-only: carved out of Zo-facing `ACTION_SCHEMA_COMPACT` (never prompted), added to `tests/schemas/actions.ts` + the coverage-test carve-out sets.

## 4. Record mode — learn a recipe from a manual run (PR 4)

`!recipe record [name]` arms a recording session (background session state; content recorder re-arms per navigation by querying "is a recording live?"). Capture-phase listeners — active **only while armed** — observe clicks, field `change`, checkbox toggles, file-input `change`; each event snapshots cue metadata (the same `nearestQuestion`/aria/placeholder/`buildSelector` helpers) + url/title and pushes `RECIPE_OBS {op, cues, url, title, value?}`.

- **Privacy by construction:** sensitive fields (`SENSITIVE_FIELD_RE`) never emit values; all events on a sensitive page (`isSensitiveForm`/`SENSITIVE_URL_RE`) collapse into ONE `human` checkpoint — the user's manual payment/OTP *is* the declared hand-over (`resumeOn` = post-page URL). Non-sensitive values become suggested param defaults, stored locally only; **values are redacted before any LLM call**.
- **Assembly (background, `RECIPE_RECORD_STOP`):** ordered events → step draft (dedupe navigations, `expectUrl` = origin+path, `submitish` via `isSubmitish` heuristics, manual attach → parameterized `attach` step) → one-shot `generateRecipePrompt` LLM pass (names `{{params}}`, inserts `human` checkpoints, tidies cues) → **`validateRecipe` gates the save** (the invariant machine-checks the learned artifact) → `storage.local['cobrowse_recipes']`, `draft:true` when the LLM failed (deterministic draft kept, hand-editable).
- `!recipe run <name>` replays local store entries through the same player — the learn → validate → replay loop closes without any library UI (that's R3).

## 5. Panel UX — `extension/sidepanel.js`

`!recipe` dispatch in `sendQuery` (bare → usage line): `run <path|name> [params later via card]`, `record [name]`, `stop`, `list`. `RECIPE_UPDATE` listener (mirrors the handoff listener): progress line (`.msg-recipe-line`, 🧾 + `recipeProgress` + ✕ stop); `waiting_human` → checkpoint card (title, instructions, "Done — verify" → `RECIPE_RESUME`, "Skip check" → `RECIPE_RESUME {force:true}`); `paused/blocked` → ▶ Resume; `done` → evidence system message persisted to the conversation. Params card clones the form-review-card pattern. Chat tab gets a marker; closing the run's tab stops the run.

## 6. Verification map (issue acceptance criteria)

| AC | Where |
|----|-------|
| 1. Unit — invariant, cue order, param substitution | `tests/recipes.test.ts` (+ `tests/bang-commands.test.ts`) |
| 2. Integration — happy path, cue-miss→heal→patch, human park→resume-by-postcondition, SW-restart pause/resume, boundary interplay | `tests/integration/recipe-flow.test.ts` (handoff-flow/`panelLoop` template) |
| 3. E2E — 3-page fixture + fake gateway, checkpoint + evidence | `e2e/23-recipes.spec.ts`, fixture `gateway.html`, mock MCP `read_file` serves the recipe; stretch: record-then-replay |
| 4. Evals — generation/heal prompts | `scripts/prompt-evals/cases.ts`: `generate-recipe`, `recipe-heal` + committed cache (`evals:live --only`) |
| 5. Docs | AGENTS.md subsystem bullet + schema-table row; `docs/reference/messages.md`; BACKLOG.md/#220 status |

Executor coverage: `recipe_step` added to `tests/schemas/actions.ts` `ACTION_TYPES` + carve-outs so `tests/actions-coverage.test.ts` keeps asserting both executor switches.

## 7. Risks / decisions pinned

- **Player liveness:** MV3 SW death mid-run is handled by persistence + orphan sweep, not kept alive artificially; no `alarms` permission.
- **Attach:** binary via bash-MCP `base64 <path>` (decode in worker); size cap ~1 MB; credential-ish paths refused by `safeWorkspacePath` confinement.
- **The filledPages bypass is narrow:** only declared recipe steps, only the post-fill action-button block; sensitive-submit probe and `checkBoundary` always apply. The user rule ("after a fill, the human clicks submit") is preserved *by construction* — a recipe can't even declare an undeclared submit click.
- **Recorder cue quality:** same-ladder guarantee; honest limits (OS file dialogs invisible → parameterized attach; cross-origin iframes and deep shadow DOM may need first-run cue fixes) documented in the eventual user guide (R3).
