# Model Picker — per-chat model selection in the sidepanel (#19)

**Date**: 2026-08-20
**Status**: Approved design (0.2.0 planning round)
**Related**: `docs/superpowers/specs/2026-08-20-0.2.0-competitive-analysis.md` (§ table stakes: every BYO-model competitor has one); extension/AGENTS.md API opportunities (catalog pre-token, featured-free, deprecation map)
**Branch (planned)**: `feature/model-picker`

## Problem

The sidepanel **already has** `#model-select` next to `#mode-select`, populated via `LIST_MODELS` (authed `/models/available`), and the chosen value already rides `ASK_ZO.modelName` (`config.selectedModel`) — the background honors `(modelName || config.zoModel)` at both call sites. But the selection is **global**: one model for every chat, shared with the options page's `zoModel` default, with no way to run a Visual-mode chat on a vision model and research chats on a cheap one. The list carries **no metadata** (no vision/free/deprecated hints — the no-auth `/models/catalog` data the vision gate already caches goes unused for display). And the options page fetches `/models/available` directly with a hardcoded `https://api.zo.computer` origin, so it shows nothing until a token is saved. #19 = upgrade this wiring: per-chat override, catalog-aware rows, and a token-free fallback.

## Concept

Keep the existing `<select id="model-select">`; enrich it. Rows are built by merging the authed available list (`LIST_MODELS`, what the API will accept — the spine) with the no-auth catalog (`GET_VISION_CATALOG`, already cached 5 min for the vision gate) in a new pure module `lib/models.js`. Selection becomes a **per-chat override** (`conv.modelName`) persisted on the conversation, falling back to the global `config.selectedModel`; `sendQuery` sends the effective value on the existing `ASK_ZO.modelName` field. Rows carry badges: 👁 vision (`supports_images`), ⭐ free-featured (`featured_models_are_free` + `featured_model_ids`), ⚠ deprecated with successor label from `deprecation_map`.

### Decisions

| Fork | Decision | Rationale |
|------|----------|-----------|
| Global setting vs per-chat override | **Per-chat override** (`conv.modelName`), header select shows the chat's effective model | Chats are isolated threads (chat-tabs design); a Visual-mode chat wants a different model than a research chat. Options page stays the *default* source. |
| Data source | **Merge `LIST_MODELS` (authed, source of truth for usability) + `GET_VISION_CATALOG` (no-auth metadata)** in a new pure module `lib/models.js` | Reuses two existing message handlers and the vision gate's cache; no new endpoints. Catalog alone can list models the tenant can't use; available alone lacks vision/free/deprecation metadata. |
| Where merge logic lives | **`extension/lib/models.js`** — `buildModelPicker(availableModels, catalog)` → entries; `modelBadge(entry)` → badge array | House pattern: pure ES module, no chrome/DOM deps, unit-tested against a Zod schema (`tests/schemas/models.ts`). |
| Deprecated models | **Shown with ⚠ + successor label; selecting one shows a one-click "switch to X" hint** (not auto-switched) | `deprecation_map` is advisory; silent switching would surprise mid-conversation. Auto-migrate is a P3 idea in extension/AGENTS.md, not this ticket. |
| Vision interaction | Reuse the existing `visionModelSuggestion` surface unchanged; the picker's 👁 badge is display-only | The suggestion flow (Visual mode + non-vision model) already works; duplicating it as enforcement adds coupling for no user value. |
| Options page | **Also populate its model list from `GET_VISION_CATALOG` when no token is saved yet** (authed refresh once saved) | Fixes the documented "fetching… until token saved" blocker; same merge helper, options stays a classic script so it goes through a message, not an import. |
| New message types | **None** | `LIST_MODELS` + `GET_VISION_CATALOG` already exist and are in `tests/schemas/messages.ts`; the contract test would otherwise demand new background handlers for no reason. |

## Data & contracts

- **Conversation object**: gains optional `modelName: string` (persisted in `cobrowse_convos`, capped store — one short string per chat, negligible vs the 50-message cap). `sendQuery` sends `modelName: conv.modelName || undefined` on `ASK_ZO`. Non-streaming `askZo` already takes `modelName` positionally.
- **`lib/models.js`** (pure):
  - `buildModelPicker(available, catalog)` → `{ defaultModel: string, models: Array<{ model_name, label, vision: 'yes'|'no'|'unknown', free: boolean, deprecated: false | { successor: string, successorLabel: string } }> }` — available list is the spine (order preserved); catalog entries join by `model_name`; a catalog-only free/featured model is *appended* (visible but marked, since `/models/available` is what the API will accept).
  - `modelBadge(entry)` → `['👁'] | ['⭐'] | ['⚠'] | []`-style array for render.
- **Zod** `tests/schemas/models.ts`: `PickerModelSchema`, `ModelPickerSchema`; unit tests validate `buildModelPicker`/`modelBadge` output shapes (join correctness, unknown-vision passthrough, deprecation join, catalog-only append).

## UX

Header layout unchanged (`#model-select` already sits before persona/mode). The first option stays "Default" (= options-page model); picking a model writes `conv.modelName` for the active chat and the select re-syncs on chat switch. Badge glyphs are inline in option text (selects can't carry rich DOM). Switching model mid-chat does **not** start a new Zo thread — same `conversation_id`; the model changes from the next turn on (documented in the tooltip).

## Error handling

- Catalog unavailable (offline / API change): fall back to bare `LIST_MODELS` names, no badges — picker must never block sending.
- `LIST_MODELS` failure (no token): catalog-only list, marked "(catalog)" — still selectable; the API may reject with `failed` SSE which already renders as an error card.
- Unknown model in a restored conversation (`modelName` no longer in either list): show it as the selected value with ⚠ so the user sees it and can change it.

## Testing

- Unit: `tests/models.test.ts` (merge/badge/deprecation joins) against `tests/schemas/models.ts`.
- Integration: extend `tests/integration/extension-flow.test.ts` (one sidepanel per process) — picker populates from mocked `LIST_MODELS` + `GET_VISION_CATALOG`, selection persists in the conversation, and the ASK_ZO fetch body carries `model_name`.
- e2e: assert the picker renders in the panel and a selection survives a panel reload against the mock server (`e2e/mock-zo/server.mjs` needs no new scenario — it ignores `model_name`).
- Contract: no message-schema changes; `tests/message-contract.test.ts` untouched.

## Non-goals

- Persona model override display (P3 idea in extension/AGENTS.md — personas may already override server-side; surfacing that interplay is later work).
- Model-specific pricing/latency hints; auto-migration of deprecated selections; per-Mode model defaults.
