# Message Types

The extension communicates across three parties — **side panel**, **background
service worker**, and **content script** — over `chrome.runtime` messaging. The
authoritative list of panel→worker message types lives in the Zod schema
[`tests/schemas/messages.ts`](https://github.com/CCAgentOrg/zo-cobrowse/blob/main/tests/schemas/messages.ts); the message-contract test asserts background.js
has a handler for **every** type in that schema.

## Panel → Background

These are the `chrome.runtime.sendMessage({ type: ... })` requests the side
panel (and options page) send:

| Type | Purpose |
|------|---------|
| `GET_PAGE_CONTEXT` | Forward to `getActiveTabContext()` — request the current tab's context at the mode's tier |
| `ASK_ZO` | Send a query to Zo with page context + current mode (`modeId`, `customModes`); picked skills/files ride as `skills` / `workspaceFiles` |
| `TEST_CONNECTION` | Probe the Zo API + Zo.space endpoint |
| `GET_CONFIG` | Return sanitized config (token presence, URL, model) |
| `LIST_MODELS` | List available models |
| `GET_VISION_CATALOG` | No-auth model catalog for the vision gate (#25) |
| `GET_OPEN_TABS` | Open tabs in this window (tab-context chip strip source) |
| `GET_TAB_CONTEXTS` | Banner-free captures of referenced tabs (manifest + excerpt) |
| `LIST_PERSONAS` | List configured personas |
| `LIST_SKILLS` | Enumerate the user's Zo skills from `/home/workspace/Skills` over MCP (the `/` picker) |
| `LIST_WORKSPACE_DIR` | One validated `ls -1F` of a workspace path for the `%` picker (traversal rejected) |
| `EXECUTE_ACTIONS` | Run a batch of actions on the active tab |
| `NAVIGATE` | Navigate a tab to a URL |
| `GENERATE_MODE` | Ask Zo to design a custom mode (`✦` generator) |
| `SAVE_PAGE` | Save the current page to the Zo workspace as Markdown |
| `RUN_SKILL` | Run a Zo skill on the current page |
| `CREATE_AUTOMATION` | Create a scheduled Zo automation (`!auto`) |
| `LIST_AUTOMATIONS` | List scheduled automations (`!autos`) |
| `DUCKDB_QUERY` | Run a natural-language DuckDB query (`!query` / `!data`) |
| `NEW_CONVERSATION` | Reset `zoConversationId` to `null` |
| `RECREATE_CONTEXT_MENUS` | Rebuild right-click context menus |
| `HANDOFF_START` / `HANDOFF_PAUSE` / `HANDOFF_RESUME` / `HANDOFF_STOP` / `HANDOFF_STATUS` | Delegate-mode run loop (Lane E, `!handoff`) — start/pause/resume/abort/status |
| `RECIPE_START` | Load a recipe artifact (workspace path or local name), validate it, collect params, start the deterministic player (#220) |
| `RECIPE_RESUME` | Verify the pending human checkpoint's postcondition (`force: true` skips the check) and continue playback |
| `RECIPE_STOP` | Abort a live recipe run |
| `RECIPE_STATUS` | Fetch a recipe run by `runId` or `chatId` |
| `RECIPE_LIST` | The local learned-recipes library + any live run |

## Background → Panel (pushes)

State pushes are broadcast with `chrome.runtime.sendMessage` from the
background and land in the panel's `onMessage` listener. They live in
`BACKGROUND_PUSH_TYPES`, not `MESSAGE_TYPES` — there is deliberately no
request handler for them:

| Type | Purpose |
|------|---------|
| `HANDOFF_UPDATE` | Full handoff run object after every transition — progress line, resume controls |
| `RECIPE_UPDATE` | Full recipe run object after every player transition (#220) — progress line, checkpoint card, evidence summary |

## Background → Content

| Type | Direction | Purpose |
|------|-----------|---------|
| `CAPTURE_CONTEXT` | BG → Content | Get a page DOM snapshot (`captureContext()`) |
| `EXECUTE_ACTION` | BG → Content | Run a single (or batch of) browser action(s) in the DOM |

## Background → Panel (streaming)

Streaming responses flow back over a long-lived `chrome.runtime.Port`
(`streamPort`) rather than one-shot messages:

| Type | Purpose |
|------|---------|
| `STREAM_CHUNK` | Incremental text/reasoning delta (echoes `sessionId`) |
| `STREAM_DONE` | Final payload — canonical `responseText` + `reasoning` + executed actions |
| `STREAM_RECONNECT` | Emitted before a retry of a transient error |
| `STREAM_ERROR` | A permanent, non-retriable error |
| `STREAM_DIAGNOSTIC` | SSE shape-discovery record (`streamShape`) |

Every `STREAM_*` message echoes the query's `sessionId` so the panel only
applies messages that belong to the current query (see
[Streaming](../concepts/streaming)).

## Content Script setup

The content script is declared in `manifest.json` (all URLs, `run_at:
document_idle`, `all_frames: false`). Because injection happens at
`document_idle`, on freshly opened tabs the content script may not be loaded
yet when the side panel first queries — the extension falls back to
`chrome.scripting.executeScript` for both `CAPTURE_CONTEXT` and
`EXECUTE_ACTION`, so the user experience is seamless.

## Contract guarantee

Two contract tests guard these boundaries:

- `tests/message-contract.test.ts` asserts background.js has a `case` for
  **every** message type in the schema **and** that the schema isn't missing a
  handler background.js already implements.

**Add a new message type → add it to `tests/schemas/messages.ts`, or the
message-contract test fails.**
