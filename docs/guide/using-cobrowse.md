# Using Co-browse

The side panel is the main chat surface, modeled after Zo's own conversation
UI: composer-shell user bubbles with mention pills, bare assistant prose,
inline thinking, tool-trace action cards, and a per-turn footer with
Copy / mode / model / time / feedback controls.

## The chat surface

- **Composer** — type a query; the Send button stays disabled until you type
  something.
- **Starter chips** — a fresh chat shows four clickable starting points
  (summarize, `!context` peek, extract links, research) that prefill the
  composer; the card retires itself on the first message.
- **Assistant messages** — rendered as escaped Markdown (nothing is injected
  as raw HTML); fenced code blocks get a **Copy** button.
- **Thinking** — when Zo returns a `reasoning` field alongside actions, it
  renders as muted inline prose for short reasoning, or collapses into a
  "💭 Thought" trace for longer reasoning.
- **Action cards** — browser actions surface as a grouped, sticky timeline
  with per-action status (pending → running → done).
- **Per-turn footer** — Copy, mode, model, timestamp (relative), feedback, and
  a **context-tier chip** (🔗 URL only / 📝 Text / 🧩 Elements / 📷 Screenshot)
  showing exactly how much page context that turn sent — hover for the
  policy's reason.
- **📷 Image toggle** — the chip at the end of the tab strip (next to the
  composer) arms **one** turn with a page screenshot: no `!context` prefix, no
  mode hunting. Arming flips the MODE dropdown to Visual (unchecking before
  you send restores it); the next send attaches the screenshot — and a 📷
  Screenshot pill on your message — then the toggle switches itself off.
  The capture is honest: if the selected model can't take images, Zo's footer
  📷 chip stays off.
- **⬇ Latest pill** — appears when the chat log is scrolled away from the
  bottom; click to snap back.
- **Cancel** — press `Esc` while Zo is responding to interrupt the stream.

## Bang commands

Type `!` in the composer to trigger quick commands. `!help` lists them inline:

| Command | Description |
|---------|-------------|
| `!summarize` | Condense the page into a concise summary |
| `!extract [what]` | Extract structured data (tables, lists, contacts, prices) |
| `!research [topic]` | Deep research on the page topic |
| `!qa <question>` / `!ask` | Answer a specific question about the page |
| `!fill [details]` | Ask Zo to fill editable fields on the page |
| `!skills` | List available Zo skills |
| `!skill <name>` | Run a Zo skill on the current page |
| `!autos` | List your scheduled Zo automations |
| `!save [path]` | Save this page to your Zo workspace as Markdown |
| `!query <question>` / `!data` | Natural-language DuckDB query against your datasets |
| `!auto <instruction>` | Create a scheduled Zo automation from the current page |
| `!help` | Show this list |

Mode commands (`!summarize`, `!extract`, `!research`, `!qa`) set the active
[Mode](../guide/modes) for a single turn. Others (`!skill`, `!query`, `!auto`)
open Zo's tooling directly.

## Reference pickers: `/` skills, `%` files, `@` tabs

The composer has three trigger characters that attach references to your next
message:

| Trigger | Picks from | Rides along as |
|---------|-----------|----------------|
| `/` | Your Zo **skills** (`/home/workspace/Skills`) | A `## Skills to Run` section — Zo reads each skill's `SKILL.md` server-side and runs it as part of the turn |
| `%` | Your Zo **workspace files** (browsable tree) | A `## Referenced Files` manifest — paths only; Zo reads content with its own file tools when needed |
| `@` | Open **tabs** in this window | A `## Referenced Tabs` manifest + short excerpts (full content via `read_tab`) |

- Type the trigger at the start of a token (after a space), then filter by
  typing: `/web` filters skills, `%readme` filters the current folder.
- Arrow keys move, `Enter`/`Tab` selects, `Esc` closes. In the `%` picker,
  folder rows navigate (and `⬆ ..` climbs); file rows attach.
- Selected entries arm **chips** above the composer (⚡ skills, 📄 files) —
  click a chip's ✕ to remove it. Chips are **send-once**: they ride the next
  message only, then clear (a skill is an invocation, not a sticky setting).
- The live [prompt inspector](#context-capture) preview shows the exact
  sections that will be sent before you hit Send.

Skills and files are enumerated over Zo's **MCP server** (`/mcp`) with your
saved access token — no extra setup. The skills list is cached ~5 minutes per
panel session; directory listings ~1 minute. Paths in the `%` picker are
confined to `/home/workspace` — traversal outside it is rejected before any
request is made.

## Right-click context menu

Enabled menus are configured in Options. Right-click a page, a selection, a
link, or an editable field to run quick actions without opening the panel:

- **Page** actions — summarize, extract, and more
- **Selection** actions — ask Zo about the selected text
- **Link** actions — ask Zo about a link
- **Editable** — "Fill this field"

Each menu entry can be toggled on/off in Options → Enabled menus.

## Theming

The panel supports the Zo-native **themes**: system, light, dark, sepia,
forest, and ocean. Use the theme toggle to cycle, or let it follow
`prefers-color-scheme`. Your theme is persisted across sessions.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+Z` (⌘⇧Z) | Open the side panel |
| `Ctrl+Shift+S` (⌘⇧S) | Summarize the current page |
| `Ctrl+Shift+N` (⌘⇧N) | Start a new chat |
| `Ctrl+Shift+E` (⌘⇧E) | Extract structured data from this page |

## Omnibox

Type `zo` in the address bar and hit space to run commands from the omnibox
(e.g. `zo summarize this page`).

## Context capture

When you ask a question, the extension captures **page context** from the
active tab at a **tier** determined by the active mode:

| Tier | What's sent |
|------|-------------|
| 0 — Pointer | URL, title, viewport only |
| 1 — Text | + visible text (sliced to the mode's text budget) |
| 2 — Elements | + compact clickable + form-field list **with selectors** |
| 3 — Screenshot | + a page screenshot |

Co-browse (the default) runs at tier 2, so Zo gets clickable elements and form
fields with selectors to act on. The Visual mode runs at tier 3. See
[Modes](../guide/modes) for the full mapping.

**Want pixels on a specific turn?** Arm the 📷 Image toggle by the composer
(it flips the Mode to Visual and forces tier 3 for that one send) or type
`!context <question>` in Visual mode.

**Follow-ups are cheap by design.** Within a conversation, full context is
attached at most once per stable page — same-page follow-ups send the URL/title
pointer only and rely on Zo's conversation threading. Every assistant footer's
context-tier chip shows what the turn actually sent (hover for the reason), and
the [prompt inspector](#context-capture) previews the
exact prompt before you send. If a stream died before Zo's thread was
established, the next action turn re-attaches full context automatically — a
fresh thread holds nothing.

Referenced tabs follow the same send-once rule: a tab's 500-char excerpt is
billed once; unchanged pages ride as a pointer line ("already provided above")
on later turns.

## Conversation history

- Several chats stay open at once as **chat tabs** above the composer (≤8, LRU
  evicted; a pulsing dot marks a backgrounded chat that's still streaming).
  Each chat has its own Zo thread and its own context-dedup state.
- **History** (☰) lists past conversations grouped by date with a one-line
  **preview snippet** of each chat's opening ask, live search with match
  highlighting, ✎ inline rename, and ✕ delete (with confirmation).
- Chat history is stored locally in `chrome.storage.local`
  (`cobrowse_convos`, capped at 50 messages per chat) for continuity.
- Zo's `conversation_id` is tracked **per chat** and sent on every `/zo/ask`
  call so the thread continues on Zo's side too.
- **New Chat** (✚) starts a fresh chat: new Zo thread, fresh context state —
  previous chats stay in History.

## Error handling

When a stream is interrupted, Zo Co-browse shows a **"Response interrupted"**
card with a **Retry** button — the extension retries only transient errors and
never silently drops the answer. See [Streaming](../concepts/streaming) for the
full resilience design.
