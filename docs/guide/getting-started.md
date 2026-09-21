# Getting Started

Zo Co-browse is a Chrome extension (Manifest V3) that wires your browser up to
[Zo Computer](https://zocomputer.com) as the AI backend. This guide walks you
from a fresh clone to your first co-browsing query — no backend or build step
required for normal use.

## What you're building

```
Browser Tab ──→ Content Script ──→ Side Panel ──→ Background SW
     ↑                                                    |
     │              ┌────────────────────────────┐        |
     └── Actions ───┤  WebSocket Relay (optional)│        |
                    └──────┬─────────────────────┘        |
                           ↓                              ↓
                   ┌──────────────┐            ┌──────────────────┐
                   │ Zo.space API │            │ Zo /zo/ask API   │
                   │ (data)       │            │ (AI + tools)     │
                   └──────────────┘            └──────────────────┘
```

The extension speaks to Zo over **two channels** (see
[Architecture](../concepts/architecture) for detail):

| Channel | Endpoint | What it does |
|---------|----------|-------------|
| **AI Brain** | `POST /zo/ask` | Page context + query → Zo reasons with all tools → returns structured actions |
| **Data/MCP** | `zo.space/api/cobrowse/*` | DuckDB queries, web research, Zo.space data |

## Prerequisites

- **Chrome** (latest; MV3 is fully supported on all current releases)
- A **Zo account** with an **Access Token** — create one at
  [Zo Settings → Advanced](https://cashlessconsumer.zo.computer/?t=settings&s=advanced)
  → **Access Tokens**
- The repository source (only if installing from source; see below)

## Option A — Install from source

1. **Open Chrome** → navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. **Load unpacked** → select the `extension/` directory of this repo
4. Pin the extension icon to the toolbar for easy access

## Configure

1. **Right-click the icon → Options** (or open the side panel and use its
   **Options** entry)
2. Enter your **Zo Username** — the slug in `https://<slug>.zo.space` — and
   your **Zo Access Token** (key format: `zo_sk_...`); both Zo-space and Zo-web
   hosts fill in from the username automatically (odd setup? Override them
   under **Advanced**)
3. Click **Test Connection** — you should see a green success state
4. (Optional) Choose a **model** (blank = Zo's default), and enable the
   **⚡ Jev** fast path if you have a TypeSafe AI key — it answers mechanical
   browsing decisions (click targets, done-checks) in a fraction of a second;
   page state goes to TypeSafe AI in addition to Zo while it's on
5. Click **Save Settings** — the sticky bar at the bottom is the one save; its
   • marker disappears when everything is persisted (the section tabs jump
   between the settings cards)

::: tip Unsaved changes
Fields save only when you press **Save Settings** (the model select and
Quick-Action rows save immediately). Until then, the Save button carries a •
marker and a toast reminds you.
:::

## Your first query

1. Navigate to any page you're interested in
2. Click the extension icon → the side panel opens
3. The panel shows a summary of the current page context
4. Type a command, for example:

   - **"Summarize this article in 3 bullet points"**
   - **"Find the submit button and fill this form with dummy data"**
   - **"Extract all table data from this page"**
   - **"Scroll down and click 'Load More'"**

5. Zo's response appears in the conversation; browser actions (click, fill,
   scroll…) run **automatically** in the page, and their progress shows in a
   per-action timeline.

::: tip Read-only vs actions
Co-browse mode auto-detects intent: ask a question ("What is this page?") and
Zo answers in plain prose; give an instruction ("Click Pricing") and Zo emits
browser actions. See [Modes](../guide/modes).
:::

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+Z` (⌘⇧Z) | Open the side panel |
| `Ctrl+Shift+S` (⌘⇧S) | Summarize the current page |
| `Ctrl+Shift+N` (⌘⇧N) | Start a new chat |
| `Ctrl+Shift+E` (⌘⇧E) | Extract structured data from this page |

## Optional — WebSocket backend relay

For **multi-participant co-browsing** (Ticket #15), there's an optional
WebSocket relay. It is **not** required for single-user co-browsing:

```bash
cd backend && bun run relay.ts
```

See [Backend Relay](../backend) for full details.

## Where to go next

- **[Using Co-browse](../guide/using-cobrowse)** — the chat surface, bang commands, context menu, and automation
- **[Modes](../guide/modes)** — the six built-in modes and how custom modes work
- **[Architecture](../concepts/architecture)** — how the pieces fit together
- **[Zo API](../reference/zo-api)** — the endpoints the extension talks to
