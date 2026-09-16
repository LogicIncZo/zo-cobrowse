# Security review — 0.3.0 (#243)

**Round:** 2026-09-16, on the frozen 0.3.0 surface (post Lane P, dev `67a2ae0`). Spec: `docs/superpowers/specs/2026-09-15-0.3.0-slate-design.md` · Ticket: [#243](https://github.com/LogicIncZo/zo-cobrowse/issues/243).
**Method:** structured sweeps over the shipped `extension/` surface (every finding below cites file:line from the sweep), the scripted sink inventory (`bun scripts/security/sink-inventory.ts` — commit-diffable against this doc), and an adversarial negative e2e (`e2e/25-security-negative.spec.ts` + `e2e/fixtures/site/hostile.html`).

**Summary verdict: the trust boundary holds.** Web pages have no path into the extension (no `externally_connectable`, no `onMessageExternal`/`onConnectExternal`, zero `window message` listeners), secrets never leave the Authorization header, and every dynamic HTML sink is escape-first. Two low nits were fixed in-round; no P1–P3 findings were filed (the findings queue is empty — `qa-gate` clean).

## 1. Permission surface — ✅ clean, accepted-design notes

- `manifest.json`: permissions `debugger, contextMenus, sidePanel, storage, activeTab, tabs, scripting, tts, notifications`; `host_permissions <all_urls>` (+ redundant scoped hosts). `<all_urls>` is load-bearing for `captureVisibleTab` (triaged 2026-08-29 — scoped wildcards silently break tier-3 capture). `externally_connectable`: **absent** → pages have no `chrome.runtime` surface. `web_accessible_resources`: `icons/icon.svg` only. CSP: `script-src 'self'; object-src 'self'` (no `unsafe-eval`, blocks `javascript:` on extension pages).
- `chrome.debugger` (CDP fast-path): attach/detach per-tab (`background.js:666–689`), ONE eval site `evalInPage` (`:691–709`) with `userGesture: true`. Callers: capture paths (`:832–846`), action execution (`:3322` via `makeActionExpr :711–763`), submit probe (`:3208`).
  - *Accepted-design note (for #47's permission model):* the CDP path itself has no confirmation gate — the guards are product-level (sensitive-form confirm `:3168–3176`, submit backstop `:3261–3276`, post-fill no-click `:3284–3304`, handoff boundary parks `:3309–3315`). The sensitive-form gate **fails open** when the page is unreadable (`unverifiedForm`, `:3161–3166`). Recorded deliberately: this is the shipped #26 contract, and #47 generalizes it.
- `captureVisibleTab` single site (`:956`) gated by tier≥3 + `enableScreenshots` kill-switch + vision-model check. `executeScript` used for capture/probe/action fallbacks; `senderTabId()` (`:292–295`) blocks extension/about/devtools senders.

## 2. Message-passing surface — ✅ clean (boundary holds)

- One router per side: `background.js:367–635` (roster of 40 types: ASK_ZO, EXECUTE_ACTIONS, GET_PAGE_CONTEXT, handoff/recipe/automation/picker calls — full list from the sink inventory), `content.js:1207–1236` (RECIPE_RECORD_STATE / CAPTURE_CONTEXT / EXECUTE_ACTION).
- **No sender validation inside the boundary — and none is required**: with no `externally_connectable`/`onMessageExternal`, senders are exactly this extension's own pages and content scripts. A hostile page cannot emit `CAPTURE_CONTEXT`/`EXECUTE_ACTION` at all — proven on the wire by `e2e/25` (fixture throws every page-context vector; zero /zo/ask, zero /mcp, canaries untouched).
- **Zero `window message` listeners** anywhere in `extension/` — the page-postMessage vector does not exist.
- Streaming ports (`cobrowse-stream`, `cobrowse-wa-stream`): same trusted sender set; unknown port names are ignored (`:1034`).
- `GET_CONFIG` is sanitized — `hasToken` boolean only (`:649`); the token never rides the message bus.

## 3. Injection / XSS — ✅ clean (2 nits fixed in-round)

- `background.js` / `content.js`: **zero** innerHTML/insertAdjacentHTML/document.write/DOMParser sinks (inventory-verified).
- `sidepanel.js`: all assistant/reasoning/trace HTML flows through `markdownToHtml`, which **escapes the entire input before any tag synthesis** (`:2583`), allowlists link schemes (`https?/mailto///#` — `javascript:`/`data:` degrade to text, `:2626–2633`), and adds `rel="noopener noreferrer"`. Streaming spans are `textContent` (`:1113–1132`); DuckDB tables escape every cell (`:1905–1911`); action cards escape model/page-derived detail (`:2219–2223`); model/persona names use `createElement`+`textContent`.
- `content.js`: write path is native value setters + `execCommand('insertText')` (plain text, not parsed) + `textContent` everywhere; the write-assist popover has no HTML sink.
- **Fixed in-round:** (a) reader-view `document.write` source link is now scheme-allowlisted before it becomes an `href` (page-derived URL; `javascript:` degrades to plain text) — `sidepanel.js#openReaderViewPdf`; (b) `options.js#escapeHtml` now escapes `'` (was double-quote-attribute-safe only by context).

## 4. Storage & secrets — ✅ clean

- Token lives in `storage.local` only (`SENSITIVE_KEYS` = token + space endpoint, `lib/config.js:59`; `saveConfig :88–94` routes them away from `storage.sync`). No `storage.sync.set` path touches them (options.js duplicates the discipline at `:397–401`).
- Every token use (~40 sites) is an `Authorization: Bearer …` request header — never a URL, query string, request body, prompt, export, or log. `lib/debug-log.js` enforces metadata-only logging by contract (`:7–9`, `cleanExtra :29–39`).
- Exports (`lib/export.js`) serialize conversation/page text only — no config fields.
- Sensitive-value redaction is layered: recorder never emits sensitive values (`content.js:583–584`), recipe cleanup strips param defaults before any model call (`lib/recipes.js:511–514`), the healer strips live form values defensively (`background.js:2873–2880`), and the review card shows only `redactValue` masks (`lib/formfill.js:31–35`).

## 5. Network transport — ✅ clean

- All `fetch` sites enumerated (sink inventory § network): destinations are the user-configured `zoApiUrl` / `apiOrigin()` derivation (`new URL(...).origin`, `background.js:1946–1952`) / `zoSpaceEndpoint` — **never page-derived data in a URL**; page content rides only inside JSON POST bodies. Token header-only everywhere; `/models/catalog` is deliberately unauthenticated (`:1969–1971`); the space-endpoint HEAD probe attaches no token. SSRF surface = the user's own configured endpoints (by design).

## 6. Page-origin data flow — ✅ clean (privacy floor documented)

- Default capture is tier-0 (URL/title only) via the context policy (`lib/context-policy.js#decideTurn`); DOM/text/elements/screenshot are tier-gated and user-shaped (`!context`, 📷 toggle, tier forcing). Screenshots additionally require the `enableScreenshots` kill-switch and the vision-model check. What leaves the browser is exactly the assembled prompt (`buildPrompt` → `input`), assembled from the user's query + the tier-gated capture — auditable in the prompt inspector preview, which cannot diverge from the send (same `describePrompt` pass).

## 7. `backend/relay.ts` — ⚠️ DORMANT, auth blocker recorded

- **Not part of the shipped bundle**: zero references from `extension/` (no `WebSocket` anywhere); it is dev/demo infrastructure for #15 (shared sessions).
- **Audit verdict: it implements no auth whatsoever** — unauthenticated room join (`?room=`, `relay.ts:45–50`), unauthenticated REST (`:66–90`), and full-room broadcast of every message type including `page_context` (`:117–155`). Anyone who can reach the port can read any room's shared page context.
- **Recorded as a BLOCKER for any future #15 enablement**: session tokens + room membership checks must land before the relay ever ships or is documented as usable. It cannot ship silently — the release gate runs this doc's reruns.

## Sink inventory (rerunnable)

`bun scripts/security/sink-inventory.ts` prints the message roster, every HTML sink, every token-flow site, sync-writes, logs, and fetch constructions. Baseline at this round: **134 sites, 0 external surfaces, 0 page-message listeners.** Diff a rerun against this doc when touching `extension/`.

## Findings ledger

| # | Severity | Item | Disposition |
|---|----------|------|-------------|
| 1 | Low | Reader-view `href` not scheme-checked (page-derived URL) | **Fixed in-round** (scheme allowlist) |
| 2 | Low | `options.js#escapeHtml` missing `'` | **Fixed in-round** (defense-in-depth) |
| 3 | Design | CDP `userGesture: true` + fail-open `unverifiedForm` gate | **Accepted** — the shipped #26 contract; generalization chartered as #47 |
| 4 | Blocker-if-enabled | `relay.ts` has no auth | **Recorded** — dormant; blocks any #15 enablement |

`bun run verify` + e2e green (incl. the new adversarial spec); prompt evals untouched — no prompt changes in this round.
