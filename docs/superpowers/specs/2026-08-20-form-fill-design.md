# Form-fill — batch `fill_form` + confirm-before-fill (#26, layers 2–3)

**Date**: 2026-08-20
**Status**: Approved design (0.2.0 planning round; layer 1 — the `get_form` pull — already shipped with #24)
**Related**: `2026-08-20-0.2.0-competitive-analysis.md` §3.1 (industry confirm-first norm; nobody ships a pre-fill review UI); original proposal row #26 in `BACKLOG.md`
**Branch (planned)**: `feature/form-fill`

## Problem

Filling a real form today means one `fill` action per field, each targeting a bare CSS selector from the tier-2 capture — which is budget-sliced to 30 fields, so on long forms Zo is targeting elements it never saw, and a single wrong selector fails the whole batch mid-way. There is no notion of a *sensitive* form: nothing stops the action stream from clicking **Submit** on a login or checkout page, and nothing shows the user what is about to be typed before it is.

## Concept

Three pieces on top of the shipped `get_form` pull:

1. **Batch action** — `fill_form { values: [{ target, value }] }`: one action, N fields, resolved by human-facing cues (label text, `aria-labelledby`/`aria-label`, placeholder, `name`) instead of raw CSS selectors, applied as a unit, rendered as **one** action-timeline card with per-field ✓/✗.
2. **Sensitivity gate** — before a `fill_form` executes, the background re-captures the live form (the #24 `get_form` pull shape: type/name/placeholder per field) and runs it through a new pure heuristic `lib/formfill.js#isSensitiveForm(fields, url)`. Sensitive → the fill **parks**: the sidepanel shows an **editable review table** (field, proposed value — secret-looking values masked), user confirms or cancels; confirming executes the (possibly edited) map.
3. **Submit gating by instruction** — the action schema tells Zo: on payment/login/account pages it may `fill_form` but must **never** click the submit/pay button; it emits `done` explaining what it filled and that the user should review + submit. Password/CVV values are never proposed — those fields are listed in the review card as "left for you" (the user's password manager owns secrets; Chrome exposes no `chrome.autofill` API and we won't build a vault).

### Decisions

| Fork | Decision | Rationale |
|------|----------|-----------|
| Action shape | `fill_form { values: [{ target: string, value: string, selector?: string }] }` — `target` is a human cue, `selector` an optional disambiguator | Matches how Zo actually reads the page (labels/placeholders from `get_form`); bare selectors stay as fallback. One action per form keeps the timeline readable and the batch atomic. |
| Field resolution | `resolveFieldTarget(el-candidates, target)` in `content.js`: exact label-text match → `aria-labelledby`/`aria-label` → placeholder → `name`/`id` → CSS selector passthrough | The BACKLOG #26 proposal's rule; robust against framework-generated selectors that differ per load. |
| Where sensitivity is decided | **Background, two-phase**: on `EXECUTE_ACTIONS` containing `fill_form`, capture the live form (`CAPTURE_CONTEXT` tier-2 `{pull:'form'}` on the target tab) → `isSensitiveForm(fields, url)` → if sensitive, respond `{ needsConfirm, fields, url }` **without executing**; sidepanel renders the review card; a second `EXECUTE_ACTIONS { confirmed: true }` runs | Client-side truth (never trust the model's self-assessment); reuses #24 capture; the extra capture cost only occurs on fill turns. The sidepanel can't do this itself — it has no DOM access. |
| Sensitive heuristic | `lib/formfill.js#isSensitiveForm(fields, url)` → `{ sensitive: boolean, reasons: string[] }`: any field `type ∈ {password}` or name/id/label matching `/card|ccv|cvc|cvv|expir|ssn|pin/i`, or URL matching `/login|signin|signup|register|checkout|payment|billing|account|password/i` | Covers payment + identity + auth surfaces; conservative by design (false-positive ⇒ review card, harmless; false-negative ⇒ auto-fill of a sensitive form, harmful). Unit-testable pure function. |
| Secrets | Zo is instructed to **omit** password/CVV values; the review card lists those fields as "left for you" with a password-manager hint | Industry-converged (Copilot payment takeover; 1Password/Bitwarden mediated fill); owner decision 2026-08-15 keeps identities out of scope. |
| Submit gating | **Prompt-side rule** in `ACTION_SCHEMA_COMPACT` + cobrowse instructions ("never click submit/pay on payment, login, or account pages — fill, then `done`") + **hard backstop**: background refuses `click` whose resolved target is a `input[type=submit/password form] submit` on a URL `isSensitiveForm` flags | Belt and suspenders: prompts can be ignored by the model; the backstop is one cheap check reusing the same capture. The backstop logs "blocked submit (sensitive page)" in the timeline card so the behavior is visible, not silent. |
| Executor paths | `fill_form` handled in `content.js#executeAction` (primary) and `background.js#executeDomAction` (executeScript fallback); the **debugger-eval fast path is skipped** for `fill_form` (falls through to content script) | The eval path builds serialized JS strings; duplicating label-resolution logic there buys ~ms on an action that's already gated behind capture + possibly confirm. |
| Review card scope | Only `fill_form` actions park; other actions in the same batch (scroll, wait, navigate) execute immediately, the fill parks | Matches `pendingActions` precedent (parked ≠ cancelled); keeps a mixed batch from blocking on unrelated steps. |

## Data & contracts

- **Zod** (`tests/schemas/actions.ts`): `FillFormAction { type:'fill_form', values: z.array(z.object({ target: z.string().min(1), value: z.string(), selector: z.string().optional() })).min(1) }` — joins the discriminated union + `ACTION_TYPES`; the contract tests then force executor coverage.
- **Messages** (`tests/schemas/messages.ts`): no new types — `EXECUTE_ACTIONS` gains payload fields `{ confirmed?: boolean }` and a new response variant `{ needsConfirm, fields, url, values }` (envelope is passthrough; document in the schema comments).
- **`lib/formfill.js`** (pure): `isSensitiveForm(fields, url)`, `redactValue(value)` (`'••••' + last 2 chars for ≥4-char values, else full mask`), `reviewRows(action, fields)` — joins proposed values to captured field metadata for the card.
- **Prompt**: `ACTION_SCHEMA_COMPACT` += `fill_form{values:[{target,value}]}` + the no-submit/no-secrets rule; `BUILTIN_MODES.cobrowse.instructions` += prefer `fill_form` for 2+ fields.

## UX

Review card (sidepanel, in the live bubble where actions render): title "Review before filling — <page host>", one row per field (label / captured type / editable value input; password-typed fields show "left for you 🔑"), reasons chip row ("payment fields", "login page"), buttons **Fill N fields** / **Cancel**. Confirm sends the edited map via `EXECUTE_ACTIONS {confirmed:true}`; the result renders as the standard single `fill_form` timeline card with per-field ✓/✗ and any blocked-submit note. Cancel parks nothing — the action is dropped and an assistant note explains what was skipped.

## Error handling

- Pre-flight capture fails (content script not loaded): fall back to executing without confirm, but log "unverified form — no review" in the card (a page we can't read is also a page whose fields we can't resolve; expect per-field ✗ with errors rather than silent wrong fills).
- Field not resolved: per-field ✗ + reason ("no field matched target 'Email'"); the card reports partial success, remaining fields listed.
- `confirmed:true` on a form that changed since pre-flight (hash mismatch): re-run `isSensitiveForm`; if it flipped sensitive, re-park (rare race, cheap check).

## Testing

- Unit: `tests/formfill.test.ts` (heuristic truth table, redaction, reviewRows join) against a `tests/schemas/formfill.ts` Zod schema.
- Schema: `actions.ts` extension (union + `ACTION_TYPES`) — existing action-coverage tests force both executors to handle `fill_form`.
- Integration: `tests/integration/extension-flow.test.ts` — mock Zo returns `fill_form` on a form fixture; assert the confirm response shape, the confirmed execute path, per-field results, and the submit-backstop block.
- e2e: new mock scenario `fill-form` (keyed off `## User Request` in `e2e/mock-zo/server.mjs`) + a checkout-form fixture page; spec asserts review card → edit → confirm → fields filled in the page DOM.
- Prompt: `tests/prompt.test.ts` asserts the new schema line + rule text when `expectJson`.

## Non-goals

- Saved identities/profiles, card storage, password generation (owner decision; revisit only as password-manager *integration* — mediated fill via 1Password/Bitwarden — in a later round).
- Cross-form-site data transfer (Magical's site-A→site-B flows); multi-step wizard memory (each turn re-captures).
- AP2/agent-payment mandates (analysis §5 — v0.3+ at the earliest).
