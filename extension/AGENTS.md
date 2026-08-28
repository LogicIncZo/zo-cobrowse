# Zo Co-browse Extension — Agent Notes

## Zo API Reference

### Base URL
`https://api.zo.computer`

### Authentication
Bearer token in `Authorization` header. Create tokens at Settings → Advanced → Access Tokens.
Key: `zo_sk_...`

### Endpoints

#### `POST /zo/ask`
Send a message to Zo. Zo has full access to files, tools, integrations.

**Request body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `input` | string | ✅ | Your message to Zo |
| `conversation_id` | string | ❌ | Continue an existing conversation thread |
| `model_name` | string | ❌ | Override model (see GET /models/available) |
| `persona_id` | string | ❌ | Override persona (see GET /personas/available) |
| `output_format` | object | ❌ | JSON Schema for structured output. When set, `output` in response is an object instead of string |
| `stream` | boolean | ❌ | Enable SSE streaming. Default false |

**Response:**
```json
{
  "output": "string | object",
  "conversation_id": "conv_..."
}
```

**Streaming** (when `stream: true`): SSE events with `Content-Type: text/event-stream`.
- `x-conversation-id` response header has the conversation ID.
- **Real event types** (captured live 2026-08-09; see `tests/test-prompts/qa-notes.md`). The earlier-documented `FrontendModelResponse`/`End`/`Error` events are **never emitted** by the live API — the extension keeps handlers for them only to support synthetic test fixtures.
  - `PartStartEvent` — starts a content part. `data: {event_kind:"part_start", index, part:{part_kind:"thinking|text|tool-call|tool-return", content:"<first piece>"|args}, previous_part_kind}`. The `part.content` is the first token of that part and must be routed by `part.part_kind` (otherwise the first word of every part is lost).
  - `PartDeltaEvent` — incremental content delta (the workhorse). `data: {event_kind:"part_delta", index, delta:{content_delta:"<text>", part_delta_kind:"thinking|text"}}`. Route on `delta.part_delta_kind`: `"thinking"` is the live reasoning channel (index 0), `"text"` is the answer channel (index 1).
  - `FunctionToolCallEvent` — a tool was invoked. `data: {event_kind:"function_tool_call", part:{tool_name, tool_call_id, args}}`. Surfaced as the "Explored" channel.
  - `FunctionToolResultEvent` — a tool returned. `data: {event_kind:"function_tool_result", result:{content:{stdout,stderr,returncode}|string, outcome:"success"|"error", tool_call_id, tool_name}}`.
  - `AgentRuntimeStreamChunk` — lifecycle metadata. `data: {type:"status"|"persisted", status, data:{message_id}}`. Not rendered (live reasoning + tool cards cover it).
  - `completed` — **terminal** signal. `data: {status:"succeeded"|"failed", error}`. (Not `End`, not `[DONE]`.) A `completed` payload reporting `status:"failed"` still carries the error and is surfaced as `STREAM_ERROR` (HTTP stays 200).
  - `failed` — **terminal** signal for server-side run failures (live-verified 2026-08-19). The API returns **HTTP 200** and terminates with `event: failed`, `data: {status:"failed", error:"Unknown model: …", error_type:"UserError", runner_id, failure_owner, failure_kind}`. Surfaced as `STREAM_ERROR` with the real error string — without a handler this lands as an empty response.
- Cobrowse mode wraps the `{reasoning,actions}` JSON envelope in a ```` ```json ```` code fence; `background.js` strips exactly one whole-fence block before parsing. The action object may arrive as key-first (`{"click":{...}}`), type-first (`{"type":"click",...}`), or the non-spec `{"action":"click",...}` variant — `normalizeActions` maps all three.

#### `GET /models/available`
List models you can use (includes BYOK configs). Requires auth.

**Response:**
```json
{
  "models": [{
    "model_name": "anthropic:claude-haiku-4-5-20251001",
    "label": "Haiku 4.5",
    "vendor": "Anthropic",
    "description": "string | null",
    "type": "fast | capable | null",
    "context_window": 200000,
    "is_byok": false
  }]
}
```

#### `GET /models/catalog`
Full public model catalog. No auth required. Cached 5 min.

**Response extras:** `default_chat_model_id`, `featured_model_ids`, `featured_models_are_free`, `featured_model_labels`, `promo_end_date`, `deprecation_map`

#### `GET /personas/available`
List configured personas. Requires auth.

**Response:**
```json
{
  "personas": [{
    "id": "a1b2c3d4",
    "name": "Technical Writer",
    "prompt": "System prompt text...",
    "model": "anthropic:claude-sonnet-4 | null",
    "image": "url | null"
  }]
}
```

Download the full spec: https://www.zo.computer/docs-assets/openapi.json

## Delta — Official API features we don't use

| Feature | Official API Support | Current State | Effort | Impact |
|---------|---------------------|---------------|--------|--------|
| `output_format` | First-class JSON Schema support | Prompt-based: we ask for JSON in the prompt text and parse from string. Fragile — model sometimes returns plain text instead | Low | **High** — eliminates parse failures, guarantees structured actions |
| `stream: true` | SSE streaming with typed events | Non-streaming only. Full response latency on every call | Medium | **High** — real-time token-by-token display in sidepanel, faster perceived response |
| `GET /models/catalog` (no-auth) | Public catalog endpoint | We only call `/models/available` (auth required). Options page cannot show models until token is saved | Low | Medium — options page could show model list without requiring token save first |
| `featured_models_are_free` | Free model flag in catalog | Not checked anywhere | Low | Low — could highlight free models in the selector |
| `deprecation_map` | Active → successor model mapping | Not used | Low | Low — could auto-migrate deprecated model selections |
| Persona `model` override | Persona can specify its own model | Not displayed or honored in the panel | Medium | Medium — could let persona override model automatically when selected |

### Priority implementation notes

#### 1. `output_format` (P0)

The API now supports `output_format` as a JSON Schema object. The background.js `askZo()` already sends the request; we just need to add `output_format` to the body. This eliminates all the JSON-parse-from-text fragility.

**Current (fragile):**
```js
// prompt instructs: "respond with valid JSON object { reasoning, actions }"
// Then we parse: JSON.parse(output)
```

**Target:**
```js
body: JSON.stringify({
  input: prompt,
  model_name: ...,
  conversation_id: ...,
  output_format: {
    type: "object",
    properties: {
      reasoning: { type: "string" },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["navigate","click","fill","extract","scroll","wait","done"] },
            selector: { type: "string" },
            url: { type: "string" },
            value: { type: "string" },
            attribute: { type: "string" },
            direction: { type: "string", enum: ["up","down"] },
            amount: { type: "number" },
            ms: { type: "number" },
            response: { type: "string" },
          },
          required: ["type"],
        }
      }
    },
    required: ["reasoning", "actions"]
  }
})
```

This makes the response `data.output` a typed object instead of a string — no more try/catch JSON.parse.

**⚠️ Caveat:** The `output_format` schema uses the `type: "array"` pattern which was previously reported as unsupported. Test this with the actual API before removing the text-fallback path.

#### 2. `stream: true` (P1)

SSE streaming would show Zo's response token-by-token in the side panel. Implementation involves:
- In background.js `askZo()`: add `stream: true` to the body, change from `fetch().json()` to `fetch().body.getReader()` for SSE
- Pipe SSE events back to sidepanel via `chrome.runtime.sendMessage` with a new message type (e.g., `ZO_STREAM_CHUNK` and `ZO_STREAM_END`)
- In sidepanel.js: accumulate chunks, update the thinking/assistant message incrementally
- The `x-conversation-id` header from the SSE response must be captured for thread continuity

**Consideration:** SSE streaming requires the background service worker to maintain an open connection and relay chunks to the panel. MV3 service workers have lifetime limits (30s for normal, 5min for extension API-connected). For long responses the stream may be cut off.

#### 3. `GET /models/catalog` for options page (P2)

The options page currently shows "fetching..." until a token is saved. Using the no-auth `/models/catalog` endpoint would let us populate the model selector immediately.

#### 4. Persona model override (P3)

When a persona has its own `model` field, selecting that persona should automatically switch the model selector. Currently we only read `p.name` and `p.id`.

## Design System: Zo-native chat surface (2026-08-09)

- **Conversation surface mirrors zo.computer:** Hanken Grotesk on a neutral oklch-derived palette. Brand amber is retained for header chrome only; messages use the `--zo-*` tokens so the chat reads like the native Zo UI.
- **Zo-neutral tokens** (`--zo-sidebar`/`-foreground`/`-primary`/`-accent`/`-muted-foreground`/`-border`/`-border-primary`): defined in every theme block (`:root`, `[data-theme="dark|light|sepia|forest|ocean"]`), each mapped to the shadcn role equivalents used by Zo's own UI.
- **Fonts:** Hanken Grotesk (UI + display, **bundled locally** at `extension/assets/fonts/` — MV3 CSP-safe, no external `font-src`), JetBrains Mono (code; `@import` is a non-blocking enhancement under MV3's default `style-src 'self'`, falls back to `ui-monospace`).
- **Chat container model:** `#messages` uses Zo's spacing (`gap: 24px` / `padding: 32px 20px`), `.msg` is capped at `max-width: 768px` (`max-w-3xl`) and centered — matching `#chat-scroll-content`.
- **Theme toggle:** `data-theme` attribute on `<html>` — empty = system, "light" = light, "dark" = dark
- **System theme:** `prefers-color-scheme` media query respected when `data-theme=""`
- **Theme persistence:** `chrome.storage.sync` key `cobrowse_theme`

## State machine

- `conversation` array in sidepanel.js — local chat history, persisted to `chrome.storage.local` under key `cobrowse_convos`
- `zoConversationId` in background.js — tracks Zo's conversation thread across the session
- `config` (background.js) — loaded from `chrome.storage.sync`, watched for changes
- `pendingActions` (sidepanel.js) — actions queued for auto-execution after Zo responds

## Message flow

Side Panel → `chrome.runtime.sendMessage` → Background SW → `fetch` to Zo API

Background SW → `chrome.tabs.sendMessage` → Content Script → DOM actions
Background SW → `chrome.scripting.executeScript` → (fallback if content script not loaded)

## Key message types

| Type | Direction | Purpose |
|------|-----------|---------|
| `CAPTURE_CONTEXT` | BG→Content | Get page DOM snapshot |
| `EXECUTE_ACTION` | BG→Content | Run a single browser action |
| `ENHANCE_TEXT` | Content→BG | Write-assist one-shot (the only Content→BG type): enhance a textarea lead — `enhanceText()` builds the prompt via `lib/write-assist.js` and calls `/zo/ask` **threadless** (no `conversation_id`); returns `{ok, text}` for the in-page popover's preview + Accept fill-back |
| `GET_PAGE_CONTEXT` | Panel→BG | Forward to `getActiveTabContext()` |
| `ASK_ZO` | Panel→BG | Forward to `askZo()` with page context + query |
| `NEW_CONVERSATION` | Panel→BG | Reset `zoConversationId` to null |
| `EXECUTE_ACTIONS` | Panel→BG | Run a batch of actions |
| `GET_CONFIG` | Panel→BG | Return sanitized config (token presence, URL, model) |
| `TEST_CONNECTION` | Panel→BG | Probe Zo API + Zo.space endpoint |

## Known gotchas

- **Host permissions** must include `http://*/*` and `https://*/*` for `scripting.executeScript` to work on arbitrary pages. If the manifest lacks these, context capture fails silently.
- **`output_format`** in `/zo/ask` doesn't support `array` property types — we prompt for JSON and parse from text. This means the model sometimes returns plain text instead of structured JSON, and the sidepanel handles both.
- **Content script injection** happens at `document_idle`. On freshly opened tabs, the content script may not be loaded yet when the side panel first queries — the fallback path handles this.
- **Storage**: `chrome.storage.sync` for config (survives profile sync); `chrome.storage.local` for history (too large for sync, capped at 50 entries).

## Mode system (replaces presets + personaMode + intent routing)

A **Mode** is the single source of truth for how Zo behaves on a request. It bundles the system prompt, instructions, how much page context to send (a **context tier**), the text budget, and whether the response should be JSON actions or plain markdown.

- **Built-in Modes** (`cobrowse`, `ask`, `research`, `summarize`, `extract`, `visual`) are defined in `extension/lib/modes.js` as `BUILTIN_MODES` (pure ES module, unit-tested via `tests/modes.test.ts`). Each Mode has: `id`, `name`, `icon`, `systemPrompt`, `instructions`, `contextTier` (0–3), `textBudget`, `expectJson`, `builtin`.
- **Custom Modes** stored in `chrome.storage.local` under `cobrowse_modes`; active Mode id persisted in `chrome.storage.sync` under `zoActiveMode`.
- **Context tiers**: 0 = URL/title/viewport only · 1 = +visibleText (sliced to `textBudget`) · 2 = +compact clickable + form-field list **with selectors** · 3 = +screenshot. Tier is fixed per-Mode and passed to `getActiveTabContext(tabId, tier, modeId)`, which gates capture cost accordingly.
- **Compact action schema** (`ACTION_SCHEMA_COMPACT` in modes.js): one line, shipped only when `expectJson` is true — replaces the old ~130-token commented JSON block.
- **Intent-aware downgrade (action modes):** `extension/lib/intent.js` `detectIntent()` classifies a free-text query as `'action'` or `'read'`. `buildPrompt` calls `shouldDowngradeToJsonDisabled(mode, userQuery)`; when an action (JSON) mode like `cobrowse` receives a read-only intent ("Summarize", "What is this page?", "Explain the pricing"), it swaps both the action schema and the action instruction for plain-markdown equivalents for that turn — so read-only questions answer as prose instead of `{actions:[...]}`. Genuine action queries ("Click Pricing", "Fill the form") keep the JSON envelope. Plain-markdown modes are unaffected. Pure module, unit-tested via `tests/intent.test.ts`.
- **Prompt assembly** is a single helper `buildPrompt(mode, pageContext, userQuery)` in background.js — no more duplicated template in two places.
- The `✦` button (`#create-mode-btn`) sends `GENERATE_MODE` → `generateMode()` in background.js, which calls Zo and backfills the result via `presetToMode()`.
- Bang commands (`!summarize`, `!extract`, `!research`, `!qa`/`!ask`) resolve to a `mode` field (not `preset`) that overrides the active Mode for a single turn.
- **Migration**: legacy `cobrowse_presets` → `cobrowse_modes` (via `presetToMode`), legacy `zoActivePreset` → `zoActiveMode` (with `scrape`→`extract`, `qa`→`ask` id remapping), legacy `personaMode`/`zoLitePersonaId`/`zoFullPersonaId` keys left in place but unread after migration.
- **Deleted** (replaced by Modes): `classifyIntent`, `LITE_KEYWORDS`/`FULL_KEYWORDS`, `resolvePersona`, `personaMode` badge + `cyclePersonaMode`, the `isLite ? 2000 : 4000` truncation branch, the `presetSystemPrompt`/`presetInstructions`/`intent` fields on `ASK_ZO`.
