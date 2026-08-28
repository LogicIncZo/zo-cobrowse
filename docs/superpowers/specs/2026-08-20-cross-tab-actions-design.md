# Cross-tab Actions — actions on referenced tabs + tab management (#10, actions half)

**Date**: 2026-08-20
**Status**: Approved design (0.2.0 planning round; the *context* half — T1…Tn references, `read_tab` — shipped 2026-08-14)
**Related**: `2026-08-14-tab-contexts-design.md` (refs, manifest, send-once state); `2026-08-20-0.2.0-competitive-analysis.md` §3.3 (multi-tab actions are table stakes at Atlas/Comet/Dia/Fellou); ticket `tickets/ticket-10-multi-tab.md`
**Branch (planned)**: `feature/cross-tab-actions`

## Problem

Zo can *see* other tabs (the `## Referenced Tabs` manifest, `read_tab` pulls) but cannot *touch* them: every action from `executeActions` runs against the sender tab, so "search on tab T2 and paste the result into the form on T1" degrades to narration. There are also no tab-management verbs — Zo cannot open, close, or focus tabs, even though the "open all" flow (#27) already proved the extension can. The 0.1.0 constraint "context-only by design" was deliberate; this lifts it with routing + safety rather than by removing guardrails.

## Concept

Every DOM action may carry an optional **`tab` field** holding a reference (`"T2"` — the same strip-order refs the manifest already assigns via `lib/tab-contexts.js#assignRefs`). The background resolves `ref → tabId` and routes `EXECUTE_ACTION` per action instead of per batch. Three **tab-management actions** (`open_tab`, `close_tab`, `switch_tab`) execute in the background with `chrome.tabs.*` — they never touch the DOM executor. Cross-tab actions on background tabs keep the established `{skipDebugger:true}` discipline (no "is being debugged" banner on unfocused tabs) and render with a tab chip in the timeline so the user always sees *which* page was touched.

### Decisions

| Fork | Decision | Rationale |
|------|----------|-----------|
| Ref vs tabId in the action | **Refs only** (`"T2"`); raw `tabId`s from Zo are ignored | Refs are what the prompt shows; they're stable within a turn and meaningless across sessions (tabIds aren't) — a model-echoed stale tabId would be an arbitrary-page action vector. |
| Where routing lives | `extension/lib/tab-contexts.js` gains `resolveActionTab(action, tabContexts)` → `tabId \| null`; `background.js#executeActions` loops actions, resolving each | Keeps the ref algebra next to `assignRefs`; the executor change is a one-line target swap per action. |
| New actions | `open_tab { url, background? }`, `close_tab { ref? }` (default: the action's target/current tab — **never the sender unless explicit**), `switch_tab { ref }` | Parity set used by Dia/Comet agent flows (open + organize). `close_tab` without `ref` closes the current action target; guarding the sender tab prevents "the chat killed the page it was reading" foot-guns. |
| Do actions focus the target tab? | **No** — cross-tab actions run in background; only `switch_tab` changes focus | Fellou/Comet run cross-tab work without stealing focus; our banner-free capture already established the background-tab pattern. User focus is sacred; `switch_tab` is the explicit opt-in. |
| `pendingActions` semantics | Parked entries gain `tabId` (+ ref for display); `restorePendingActionsFor` replays them to their recorded tabs; a dead tabId parks again with a "tab closed — reopen?" affordance instead of silently dropping | Chat-tabs made parked actions page-safe; this extends the same contract across tabs. |
| Timeline display | Cross-tab actions render with a small tab chip (ref + host) on the existing action cards — same card, one extra glyph row | No new card type; the chip answers "which page?" — the one question single-target cards never had to answer. |
| Context dedup | `tabsSent` send-once state unchanged; an action targeting a tab does **not** re-send its context (the manifest already told Zo what it needs, and `read_tab` exists for more) | Keeps #24's pull economy intact; acting ≠ re-reading. |
| Manifest wording | `ACTION_SCHEMA_COMPACT` += `actions may set "tab":"Tn" to target a referenced tab` + the three verbs | One line each; the manifest already defines Tn. |

## Data & contracts

- **Zod** (`tests/schemas/actions.ts`): `click/fill/fill_form/extract/scroll` gain `tab: z.string().optional()` (ref pattern `/^T\d+$/`); new `OpenTabAction { type:'open_tab', url: z.string().url(), background: z.boolean().optional() }`, `CloseTabAction { type:'close_tab', tab: z.string().optional() }`, `SwitchTabAction { type:'switch_tab', tab: z.string() }` join the union + `ACTION_TYPES`.
- **`lib/tab-contexts.js`**: `resolveActionTab(action, tabContexts)` — `action.tab` matches `tc.ref`, returns its `tabId` (entries already carry the source tabId from `GET_TAB_CONTEXTS`); null for absent/unknown refs. Unknown ref ⇒ the action fails loudly (`{ok:false, error:'unknown tab ref T9'}`) rather than falling back to the active tab — a silent fallback would act on the wrong page.
- **`background.js`**: `open_tab` → `chrome.tabs.create({url, active: !background})`; `close_tab` → `chrome.tabs.remove(resolved || current)` with the sender-tab guard; `switch_tab` → `chrome.tabs.update(tabId, {active:true})` + `chrome.windows.update` focus. `navigate` with `tab` routes `chrome.tabs.update(targetTabId, …)`.
- **Conversation**: `pendingActions` entries `{ action, tabId?, ref? }` — additive, older persisted entries (plain actions) replay against the active tab as today.

## UX

Chip strip and manifest unchanged (context half). New visible behavior: an action card may show `⟶ T2 · github.com`; `open_tab` cards show the opened URL with an active/background marker; `switch_tab` is reflected by the browser itself. If Zo acts on a tab the user closes mid-batch, the failure card names the tab and offers "rerun on…" (v1: rerun on active tab).

## Error handling

- Unknown ref → loud per-action failure (above), batch continues (matches per-action ✓/✗ semantics of `fill_form`; the loop's existing `break on !ok` is relaxed to break only on non-tab errors — a dead tab shouldn't kill remaining actions on live tabs).
- Target tab navigated away since manifest build: the action still routes by tabId (refs bind to *tabs*, not URLs); field/selector misses surface as normal not-found errors.
- `open_tab` with a bad URL: rejected by Zod at parse time (never executed).

## Testing

- Schema: `actions.ts` union + ref-pattern tests (rejects `tab: 42`, `tab: "tab-2"`).
- Unit: `tests/tab-contexts.test.ts` += `resolveActionTab` truth table (hit/miss/absent) against the tab-contexts Zod schema.
- Integration: `extension-flow.test.ts` — mock Zo returns `[click{T2}, fill{T1}, switch_tab{T2}]` against the fake-chrome tabs routing; assert per-tab `EXECUTE_ACTION` dispatch order, sender-tab guard, and parked-action replay to a recorded tabId.
- e2e: mock scenario `cross-tab` over the links fixture (two tabs referenced via chips); spec asserts a click lands on the background tab without it being focused.

## Non-goals

- Coordinating multi-tab *workflows* (Fanout/parallel agents — Fellou shadow windows); tab groups/windows management; actions in iframes; `close_window`.
- #20 tab compare (depends on this, separate ticket).
