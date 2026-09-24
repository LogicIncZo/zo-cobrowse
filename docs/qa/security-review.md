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

## 8. Prompt injection via captured page content — threat class (owner question, 2026-09-17)

> Graduated into [`docs/qa/threat-model.md`](threat-model.md) — the living
> per-surface containment map (0.3.5). This section is retained as the
> round-1 record.

The vector **exists by design**: the product feeds page content to Zo, and a hostile page controls that content — visible text, link/button labels, form placeholders and question text, even the `<title>`. The model cannot distinguish attacker-authored text from trusted UI, so an opened page can always *attempt* instruction injection. The security question is what a successful injection can then DO:

**Contained by code (injection-proof, not prompt-hoping):**
- The page has no channel into the extension itself (§2 — proven on the wire by `e2e/25`); injection only *persuades the model*, whose sole actuator is the action protocol.
- `normalizeActions` drops anything outside the known verbs; dangerous classes have hard code backstops that prompt text cannot talk out of — sensitive-form fills park for confirmation, submit-ish clicks never auto-execute on flagged pages, the post-fill no-click rule (`filledPages`) is enforced in `executeActions`, and handoff boundary mode parks click/fill.
- Every executed action is user-visible (action cards, a visibly navigating tab, visibly changing fields); `done()` renders to the user. The extension has no silent exfil channel (§4/§5 — token header-only, endpoints are user config, no page→extension messaging).
- The pull loop is context-only with a 3-cycle budget.

**Residual risks (accepted, documented):**
- **Social engineering via `done()`** — attacker text can persuade the model to relay phishing content as assistant prose in a trusted surface. No capability breach; the user reads attacker content from a trusted mouth. Same residual as every browser-agent product.
- **Thread poisoning** — hostile content persists in the per-chat Zo thread (`conversation_id`), shaping later turns on other pages. Bounded by the same visibility rules.
- **Zo-side tools** — the model's server-side toolchain (fetch, workspace writes) is technically persuadable by injected text; that surface belongs to Zo's agent, not this extension, and is outside extension code.

**Capture hardening (fixed in this round's follow-up):** tier-2 capture used to include the first 100 chars of every form field's current value (`content.js#captureContext`). No shipped prompt path rendered that value (`compactForm` and the get_form/heal renderers are structure-only, and the healer stripped values defensively), so the leak was latent — but the value sat in the captured context object (memory + persisted conversations) waiting for a future renderer, and it raised injection stakes by putting possibly-sensitive page data in the model's context. **Fix:** capture now applies the shared sensitive-field rule at the source — `type=password` fields and name/placeholder/question matches on `REC_SENSITIVE_FIELD_RE` emit `value: ''` + `sensitive: true`; structure still rides (it gates the sensitive-form confirm). Non-sensitive values (e.g. a search box) keep riding as useful context.

## Findings ledger

| # | Severity | Item | Disposition |
|---|----------|------|-------------|
| 1 | Low | Reader-view `href` not scheme-checked (page-derived URL) | **Fixed in-round** (scheme allowlist) |
| 2 | Low | `options.js#escapeHtml` missing `'` | **Fixed in-round** (defense-in-depth) |
| 3 | Design | CDP `userGesture: true` + fail-open `unverifiedForm` gate | **Accepted** — the shipped #26 contract; generalization chartered as #47 |
| 4 | Blocker-if-enabled | `relay.ts` has no auth | **Recorded** — dormant; blocks any #15 enablement |
| 5 | Medium (latent) | Capture carried field values up to 100 chars — incl. sensitive fields — into the context object | **Fixed** — capture-time redaction (§8); prompt paths were already value-free |

`bun run verify` + e2e green (incl. the new adversarial spec); prompt evals untouched — no prompt changes in this round.

---

# Round 2 — 2026-09-25 (post-0.3.0 surface, 0.3.5 lane)

**Scope:** everything shipped after the round-1 audit — Recipes workspace write-back (0.3.1), compose + recorder (0.3.2), the 0.3.3 UX bash, Jev + settings rationalization (0.3.4). Spec: `docs/superpowers/specs/2026-09-25-0.3.5-security-lane-design.md` · Ticket: [#383](https://github.com/LogicIncZo/zo-cobrowse/issues/383).
**Method:** sink-inventory re-run + categorized diff; surface diffs (roster, listeners, manifest, relay, sensitive-key routing); three deep-dives where the new surface concentrated risk (Jev egress, workspace write-back, recorder/compose privacy); adversarial-e2e gap assessment.

**Summary verdict: the trust boundary holds on the grown surface.** No P1/P2 beyond one recorder privacy gap (fixed in-round); every new transport and persisted payload audited; the threat class graduated into the living `threat-model.md`.

## Surface diffs (vs the round-1 record)

- **Message roster** — contract test green (`tests/message-contract.test.ts`); roster shape unchanged: background `onMessage` + 2 stream ports, panel listener + stream port, content port (`cobrowse-wa-stream`) + content router (3 types). New handlers (recipes/compose/Jev/settings) all live inside the background router — no new listener sites, no new content-INITIATED types beyond `RECIPE_OBS`/`RECIPE_RECORD_PEEK` (extension-internal).
- **Listeners / page surface** — still zero `window` message listeners, no `externally_connectable`; recorder arming rides `chrome.runtime` only (`RECIPE_RECORD_STATE`/`RECIPE_RECORD_PEEK`). **No new page-observable surface → `e2e/25` needs no extension** and continues to cover the boundary.
- **`manifest.json`** — `git diff v0.3.0.0..dev` = version bumps only. Permission surface identical (`<all_urls>` still load-bearing for tier-3 capture).
- **`backend/relay.ts`** — still zero references from `extension/` (sole grep hit is the word "relay" in a `vision.js` comment). Dormant no-auth blocker unchanged (§7).
- **Sensitive-key routing** — `jevApiKey`/`jevApiUrl` correctly pinned to `storage.local` (`SENSITIVE_KEYS`, background.js:374; mirrored in `lib/config.js`).
- **Sink inventory** — the script previously scanned only top-level `extension/*.js`; it now scans `extension/lib/` too (#387 — the Jev transport lives there), so **the round-1 "134" figure and today's run are not directly comparable; the categorical diff below is the accounting**. Current run: 118 pattern sites + lib/ coverage. New-site categories, all audited: Jev transports, recipe save/heal/import/export MCP writes, compose obs/park sinks, 0.3.3 options/panel UI rows (escape-first `markdownToHtml`/`safeText`/`escapeHtml` discipline intact).

## Deep-dive 1 — Jev egress: ✅ clean (2 nits fixed in-round)

- Both transports (`lib/jev.js#jevDecideImpl`, `background.js#jevTest`) send `jevApiKey` **only** in the `Authorization` header; body is `{model, state, questions}`; no `credentials: include`; the sole debugLog push is metadata-only (`{reason}`), and `cleanExtra` drops objects.
- State is **fixed-shape per hook**: pick/resolve = `{url, title, candidates}` where candidates carry tier-2 clickable labels only (≤60 chars; `contenteditable` is not in the clickable selector list); done gate = `{url, title, pageText(≤800)}`. Choice `criteria` are label maps by construction (`jev.js` builders). `cap.formFields` never enters Jev state.
- `jevApiUrl` override: accepted-design user-config surface, **same posture as `zoApiUrl`** (round-1 §5) and stricter — `storage.local`, not exposed in the options UI. No page-derived data influences endpoint or headers.
- Failure/low-confidence falls back to the pre-existing Zo continuation using the turn's already-captured `pageContext` — Jev adds no capture.
- **Fixed in-round (#387):** `redactStateForJev`'s key regex was narrower than the formfill `SENSITIVE_FIELD_RE` set (latent — no live builder emits field-shaped objects); widened + pinned by test. Boundary comment added: `questions` bypass the strip (labels-only by construction).

## Deep-dive 2 — Workspace write-back: ✅ confinement/backstops clean (2 P3s fixed in-round)

- **Path confinement:** all 7 recipe MCP call sites (save write+probe, heal write-back write+probe, export ×2 files, import read) go through `safeWorkspacePath`; recipe NAMES reach paths only via `slugifyTitle` (`[^a-z0-9]+` → `-`) — traversal cannot survive; heal write-back refuses non-workspace origins. (Residual: lexical confinement can't see workspace-side symlinks — Zo-server concern, out of extension reach.)
- **Overwrite discipline:** probe-then-confirm held (`exists && !confirm` → no write); content drift bumps patch; `patchHealedCues` refuses structurally diverged origins; the run's substituted copy never traveled in the write-back payload.
- **No-model-authored values:** compose Zo fills → defaultless params; human fills → the only defaults; both adopt paths gate on `literalFillValueCount` + `withoutParamDefaults` + full re-validation; cleanup prompts receive defaults-stripped drafts.
- **Fixed in-round (#386):** (a) `recipeHeal` cached the run's **substituted** recipe (real param values as literal fill values) into `storage.local` under the recipe id — values on disk, replay without a params card, phantom library row; now the healed cues patch the library's **unsubstituted** entry (matched by id) and legacy id-keyed phantoms are pruned. (b) `buildRecipeSkillExport` rendered recorded `navigate`/`waitFor` URLs **verbatim including query strings** — a tokens-in-query class escaping the module's own "no captured values leave" rule; the export table masks everything after `?` (workspace JSON keeps the full URL by design: confirm-gated, validated).
- Accepted nits: `literalFillValueCount` covers only `fill.value` (a cleanup reply may persist a literal `attach.path` — workspace-scoped, same class as navigate-url authoring); `readWorkspaceFile` uncapped for imports (parse still guarded).

## Deep-dive 3 — Recorder/compose privacy: 🔴 1 P2 fixed in-round (findings #6–#7)

- **P2 (fixed, #385):** the recorder's sensitive-field surface was **narrower than the capture rule round 1 fixed** — it read only name/id/placeholder/aria-label, missing `label[for]` question text, `aria-labelledby`, `title`, `autocomplete` — and the regex missed common markups (`cc_exp`, `exp_year`, `csc`, "security code", routing, IBAN). A field visibly labeled "Credit card number" with framework-neutral machine attributes **emitted its typed value** into `RECIPE_OBS`, which becomes a param default persisted to `storage.local` and auto-replays. Fix: ONE shared `fieldSurface()` helper (capture + recorder), regex widened, pinned by tests. (Compensating layers that already held: `type=password` always suppressed; positively-identified sensitive fields collapse the whole page into a `human` checkpoint; sensitive-URL pages collapse regardless.)
- **Contenteditable fields are fail-closed** — not a text input, so the recorder emits no record at all (functional recording gap, documented; no value path).
- **Compose value-stripping holds end-to-end:** Zo sink records carry no `value` field (compose refuses fills in code, so none can exist); human values ride only non-sensitive fills; sensitive-span collapse runs before producer dispatch for both producers; boundary parks are value-free by construction; adopted drafts cannot carry model-authored defaults.
- **`storage.session` audit:** run recipes (substituted — needed for SW-restart playback), human params, evidence, and generated fill values are session-scoped and extension-private; `parkLog` carried the refused fill's **proposed value** — now stripped (#387, defense-in-depth: it never reached prompts or artifacts).
- Recorder arming is extension-internal (isolated-world closure + runtime messages); `e.isTrusted` unchecked — accepted (page-derived-data class, no capability, cannot flip arming).

## Findings ledger (round 2)

| # | Severity | Item | Disposition |
|---|----------|------|-------------|
| 6 | **P2** | Recorder sensitive-surface narrower than capture rule — sensitive typed values could become persisted param defaults (#385) | **Fixed** — shared `fieldSurface()` + regex widening + tests |
| 7 | P3 | Heal cache stored the substituted recipe (literal values) under the recipe id — values on disk + phantom row (#386) | **Fixed** — cues patch the unsubstituted library entry; phantoms pruned |
| 8 | P3 | SKILL.md export rendered recorded URL query strings verbatim (#386) | **Fixed** — export table masks post-`?` |
| 9 | P3 (latent) | `redactStateForJev` key strip narrower than formfill set (#387) | **Fixed** — widened + test |
| 10 | nit | `parkLog` retained refused fill values (session-only) (#387) | **Fixed** — value stripped |
| 11 | nit | `__proto__`/`constructor`/`prototype` accepted as library keys (#387) | **Fixed** — `safeLibKey` at import/record/rename |
| 12 | nit | `generateRecipePrompt` reply schema invited model-authored defaults (#387) | **Fixed** — default field removed from example |
| 13 | Design | `jevApiUrl` unvalidated user-config endpoint | **Accepted** — `zoApiUrl` posture (§5), storage.local-only |
| 14 | Design | Recorder ignores `e.isTrusted`; contenteditable fills not recorded | **Accepted/documented** — page-derived-data class; no capability |
| 15 | nit | `attach.path` outside `literalFillValueCount`; `readWorkspaceFile` uncapped | **Accepted** — workspace-scoped, parse-guarded |

No prompt-Mode content changed → evals cache untouched by the round (the `generateRecipePrompt` string is not an eval case). Adversarial e2e: no extension needed (no new page-observable surface).
