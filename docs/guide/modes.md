# Modes

A **Mode** is the single source of truth for how Zo behaves on a request. It
bundles the system prompt, the instructions, how much page context to send (a
**context tier**), the text budget, and whether the response should be JSON
actions or plain Markdown.

Modes replaced the older preset + persona-routing system. They live as a pure
ES module (`extension/lib/modes.js`) so they are unit-tested directly.

## The built-in modes

| Mode | Icon | Purpose | Context tier | Responds with |
|------|------|---------|--------------|---------------|
| **Co-browse** | 🤖 | Act on the page to fulfill a request | 2 — Elements | JSON actions |
| **Ask** | 💬 | Answer a question about the page (absorbed Summarize & Research — just phrase the query) | 1 — Text | Plain Markdown |
| **Extract** | 📥 | Extract structured data as tables / JSON | 2 — Elements | Plain Markdown |
| **Visual** | 🖼️ | Describe or analyze what's visible (screenshot) | 3 — Screenshot | Plain Markdown |
| **Lean** | 🪶 | URL-only: Zo never sees the page — it fetches the URL itself with its web tools, never acts, and can write notes on request | 0 — Pointer | Plain Markdown |

> **Rationalized 2026-08:** Summarize and Research were dropped as separate
> modes — they were tier-1 readers differing only in query phrasing, and every
> canned entry (`!summarize`, `!research`, shortcuts, starter chips) already
> carries that phrasing. Chats that had them active land on **Ask** after the
> update; `!summarize` / `!research` keep working and now run in Ask.

**Context tiers** (see [Using Co-browse → Context capture](../guide/using-cobrowse#context-capture)):

- **0 — Pointer:** URL, title, viewport only
- **1 — Text:** + visible text, sliced to the mode's `textBudget`
- **2 — Elements:** + compact clickable + form-field list **with selectors**
- **3 — Screenshot:** + a page screenshot

## Reader vs action modes

Only **Co-browse** uses the JSON action protocol (`{"actions":[...]}`) so the
extension can drive the browser. All other built-in modes **stream plain
Markdown** — this fixed the "raw JSON in chat" bug that happened when
read-only answers got wrapped in the action envelope.

### Intent-aware downgrade

Co-browse auto-detects the *intent* of your free-text query
(`extension/lib/intent.js`):

- **Read-only intent** — *"Summarize"*, *"What is this page?"*, *"Explain the
  pricing"* → the mode **downgrades to plain Markdown for that turn**, so you
  get prose instead of `{actions:[...]}`.
- **Action intent** — *"Click Pricing"*, *"Fill the form"* → keeps the JSON
  action envelope so the browser does it.

Detection is deliberate: a leading read-only verb (`summarize`, `explain`,
`what`, `why`…) wins immediately; otherwise an action verb anywhere wins;
otherwise a `?` or a read token (`summary`, `overview`, `insights`…) tips it to
read; ambiguous queries default to **action** (it's the co-browsing mode, after
all). Bang commands (!summarize, !ask) never reach this path — they set the
mode directly.

## Custom modes

Two ways to get a custom mode:

1. **The ✦ generator** — the `✦` button in the panel sends `GENERATE_MODE` to
   the background worker, which asks Zo to design a mode and backfills the
   result via `presetToMode()`.
2. **Legacy presets** — older `cobrowse_presets` are migrated forward
   automatically (`presetToMode`).

Custom modes are stored in `chrome.storage.local` under `cobrowse_modes`, and
the active mode id persists in `chrome.storage.sync` under `zoActiveMode`.
Custom modes merge over the built-ins by id — a custom mode with the id
`extract` replaces the built-in one.

## Mode internals

Each mode carries:

| Field | Meaning |
|-------|---------|
| `id` | Unique id (e.g. `cobrowse`) |
| `name`, `icon` | Display name + emoji icon |
| `systemPrompt` | System prompt sent to Zo |
| `instructions` | Task instructions sent to Zo |
| `contextTier` | How much page context to capture (0–3) |
| `textBudget` | Max characters of visible text to send |
| `expectJson` | Whether to request the JSON action envelope |
| `builtin` | Whether it's one of the five bundled modes |

When `expectJson` is true (Co-browse only), the prompt ships a **compact action
schema** instead of the old ~130-token commented JSON block:

```
Respond with JSON {"actions":[...]}. Actions: click{selector} |
fill{selector,value} | extract{selector,attribute} | navigate{url} |
scroll{direction,amount?} | wait{ms} | done{response}.
```

## Action-shape normalization

Models sometimes emit actions in a non-canonical shape. `normalizeActions()`
(in `modes.js`) converts them all to the canonical **type-first** form the
extension executes:

- **Type-first (canonical):** `{ type: 'extract', selector: 'body', attribute: 'textContent' }`
- **Key-first (Zo variant):** `{ extract: { selector: 'body', attribute: 'textContent' } }`
- **`action` variant:** `{ action: 'click', ... }`

Non-conforming entries are dropped rather than risk raw JSON leaking into the
chat. See [Action Protocol](../reference/actions) for the full reference.
