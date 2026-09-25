# Threat model — Zo Co-browse extension

> Living document. Updated every release alongside `QA_REPORT.md`; every new
> security-relevant surface lands here when it ships. Established in the 0.3.5
> security lane ([#383](https://github.com/LogicIncZo/zo-cobrowse/issues/383));
> graduates the threat-class section of the round-1 review
> (`security-review.md` §8, 2026-09-17). Round-2 audit: `security-review.md`
> § "Round 2".

## The vector class

The product feeds page content to Zo by design — visible text, element labels,
form question text, even the `<title>`. A hostile page controls all of it, and
the model cannot distinguish attacker-authored text from trusted UI, so any
opened page can always *attempt* prompt injection. **The security question is
not "can injected text reach the model" (it can) but "what can a successful
injection then DO."**

Containment is CODE, not prompt compliance: nothing in the threat model below
relies on the model obeying instructions.

## What an injection cannot do (structural facts)

- **Reach the extension.** Pages have no `chrome.runtime` surface: no
  `externally_connectable`, no `onMessageExternal`/`onConnectExternal`, zero
  `window` message listeners anywhere in `extension/`. Proven on the wire by
  the adversarial e2e (`e2e/25-security-negative.spec.ts` + `hostile.html`):
  every page-context vector thrown, zero outbound calls, canaries untouched.
  Re-verified in round 2 (2026-09-25).
- **Exfiltrate silently.** Every fetch destination is user-configured
  (`zoApiUrl` / derived space endpoint / opt-in Jev endpoint); the Zo token and
  the Jev key ride only in `Authorization` headers; `lib/debug-log.js` enforces
  metadata-only logging. Page content leaves only inside JSON POST bodies to
  those endpoints — i.e. only when the user sends a turn.
- **Escape the action protocol.** `normalizeActions` drops anything outside the
  known verbs; every executed action renders as a user-visible action card.

## Per-surface containment map

### Capture (`content.js#captureContext`, background `getActiveTabContext`)

- **Threat:** hostile page text/labels/questions ride into prompts; sensitive
  field values could leak into context.
- **Containment:** tier gating (0 = URL only, default reads are tier-0;
  DOM is opt-in per turn via the context policy); capture-time sensitive-field
  redaction — `type=password` and sensitive-surface matches emit `value: ''` +
  `sensitive: true` (#243 fix); as of 0.3.5 the sensitivity surface is ONE
  shared helper, `fieldSurface()` (machine attrs + label[for] +
  aria-label/-labelledby + title + autocomplete + nearestQuestion), used by
  capture AND the recorder (#385).
- **Residual:** non-sensitive field values (≤100 chars) and page text ride
  context on opted-in turns — that is the product. `contenteditable` typed
  text is page text to `innerText` and rides where page text rides (parity,
  not a gap).

### Action executor (`background.js#executeActions`, content `executeDomAction`)

- **Threat:** injection persuades the model to emit destructive actions
  (submits, payment clicks, sensitive fills).
- **Containment (hard code, prompt cannot talk these out):** sensitive-form
  fills park for confirmation (`isSensitiveForm` → `{needsConfirm}`); the
  submit backstop + `filledPages` no-click-after-fill rule; the no-auto-submit
  invariant re-checked at recipe replay time; handoff/compose boundary parks
  click/fill per mode (`readonly`/`no-submit`/`compose`); Jev pick resolution
  runs the resolved concrete click through the same rails — resolution never
  bypasses a gate.
- **Residual:** `done()` prose can relay phishing (below).

### Recipes + compose (`lib/recipes.js`, recorder in `content.js`)

- **Threat:** recorded/composed artifacts persisting captured values; hostile
  page influencing what a recipe replays.
- **Containment:** sensitive fields never emit values into `RECIPE_OBS`
  (shared `fieldSurface` rule); sensitive pages collapse into `human`
  checkpoints in both draft producers; human fills are the ONLY source of
  param defaults — Zo fills are defaultless; cleanup/heal prompts receive
  value-stripped drafts and the adopt gates
  (`literalFillValueCount`/`withoutParamDefaults`) keep model-authored values
  from persisting; the healer caches healed cues into the UNSUBSTITUTED
  library entry, never the run's substituted copy (#386); the submitish
  invariant is a schema error AND a replay-time check; the sensitive-page
  submit probe is always on (recipe clicks cannot bypass it).
- **Residual:** recorded human param defaults live in `storage.local`
  (`cobrowse_recipes`) by design — documented, reviewable in the library;
  recorded `navigate.url` keeps its query string in workspace JSON
  (confirm-gated write; the SKILL.md export masks it, #386); the recorder does
  not check `e.isTrusted` — a page can fabricate observations of its own DOM
  while recording is armed (page-derived data class; confers no capability).

### Jev fast path (`lib/jev.js`, background hooks) — opt-in second processor

- **Threat:** page state reaching a second endpoint (TypeSafe AI); the key
  leaking.
- **Containment:** opt-in (`jevEnabled` default off, key required); state is
  fixed-shape per hook — url/title, candidate LABELS only, text excerpt — and
  passes `redactStateForJev` (formfill-set key strip, #387); `jevApiKey` is
  `Authorization`-header-only at both transports; low confidence/error falls
  back to the normal Zo path with no additional capture.
- **Residual:** configuring Jev sends redacted state to a second processor —
  stated in the options card and `PRIVACY.md`; `jevApiUrl` is user-config
  SSRF surface, same accepted posture as `zoApiUrl` (§5 of round 1);
  contenteditable text rides the done-gate text excerpt as page text.

### Write-assist (`content.js` widget, `lib/write-assist.js`)

- **Threat:** page-injected UI being abused by the page.
- **Containment:** user-initiated (focus + click); the popover is shadow DOM;
  field writes go through one pipeline with preview + explicit Accept; the
  enhance thread is short-lived; port names unknown to the background are
  ignored.
- **Residual:** the page sees what is accepted into its own field — inherent.

### Settings & storage (`lib/config.js`, options)

- **Threat:** secrets on the wrong storage path or riding exports/logs.
- **Containment:** `SENSITIVE_KEYS` (token, space endpoint, Jev key + URL)
  pinned to `storage.local`, never `storage.sync`; `GET_CONFIG` exposes
  `hasToken` booleans only; exports serialize conversation text only;
  derived hosts (`deriveZoHosts`) write only endpoint strings.
- **Residual:** `backend/relay.ts` (dormant, unreferenced) implements no auth
  — recorded BLOCKER on any #15 shared-sessions enablement (round-1 §7).

## Residual accepted risks (the injection end-game)

1. **Social engineering via `done()`** — attacker text can persuade the model
   to relay phishing as assistant prose in a trusted surface. No capability
   breach; same residual as every browser-agent product.
2. **Thread poisoning** — hostile content persists in the per-chat Zo thread
   and can shape later turns on other pages. Bounded by the visibility rules
   above (whatever it persuades still goes through the same rails).
3. **Zo-side tools** — the model's server-side toolchain (fetch, workspace
   writes) is technically persuadable by injected text. That surface is Zo's
   agent, outside this extension; our workspace writes are additionally
   confined by `safeWorkspacePath` + validate gates.
4. **Cross-tab context is context-only** — referenced tabs ride as
   manifests/excerpts; no cross-tab DOM actions until #10, by design.

## Future control layer

#47 (autonomy dial + per-site/per-action permissions, milestone 0.9.0) makes
the existing hard floors user-visible and additively stricter. The floors
themselves — sensitive-form confirm, submit backstops, no-secrets — are NOT
user-configurable today and stay that way.

## Update rule

Any PR that ships a new security-relevant surface (new message types, new
transports, new persisted payloads, new page-injected UI) updates the
relevant map here in the same PR. The release docs-catch-up train re-reads
this file against the release notes. Disposition scale for findings:
in-round fix / `X.Y.N` stabilization point / accepted-documented (with
rationale) — the ledger lives in `security-review.md`.
