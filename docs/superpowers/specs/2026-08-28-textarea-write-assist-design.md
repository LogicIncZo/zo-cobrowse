# Textarea write-assist — floating Zo icon that enhances textarea text

**Date**: 2026-08-28
**Status**: Approved design (0.2.1 round)
**Related**: `2026-08-20-form-fill-design.md` (review-before-write philosophy); `2026-08-15-cold-start-open-all-design.md` (testing-surface template)
**Branch (planned)**: `feature/textarea-fill`

## Problem

Filling a long-form textarea — a job-application "describe your project" box, a cover-letter field, a support-ticket body — means the user hand-writes everything, even when they already know the gist. The extension can see the page and call Zo, but every interaction today starts in the sidepanel chat and targets the whole page; there is no lightweight, *field-scoped* way to say "take this lead and write the full answer, right here."

## Concept

A Grammarly-style affordance: when a `<textarea>` on the page is focused, a small Zo icon appears at its bottom-right corner. Clicking it opens a popover anchored to the field. The textarea's current text is the **lead**; the user may add a one-line instruction ("about 200 words, professional tone") and hits **Enhance**. Zo expands/polishes the lead and the improved text **previews in the popover** with **Accept / Retry / ✕** — nothing is written to the page until Accept. Accepting fills the textarea in place (framework-safe), and the user continues editing or moves on.

This is the first **page-injected UI** in the repo: content.js today never creates DOM, so this feature sets the style-isolation precedent (a single open shadow root).

### Decisions

| Fork | Decision | Rationale |
|------|----------|-----------|
| Where it runs | **Content-script-owned widget**: content.js injects the icon + popover in one shadow root, calls the background, and fills back locally using the element reference it already holds | No sidepanel round-trip, no EXECUTE_ACTION plumbing, stays in the user's flow on the page. The fill-back never leaves the content script. |
| Zo call shape | **One-shot, threadless**: new `ENHANCE_TEXT` message → background `enhanceText()` does a runSkill-style direct POST to `config.zoApiUrl` with `{ input: prompt, model_name }` and **no `conversation_id` / `persona_id`** | Fresh thread per call → no ambient `zoConversationId` rotation side effect (the `askZo()` line-1578 hazard), no chat-history pollution. Matches the established internal one-shot precedent (`runSkill`, `generateMode`, `testConnection`). |
| Prompt authoring | **Internal fixed prompt** in a new pure lib `lib/write-assist.js`, NOT a user-facing Mode | A field-scoped writing helper is not a chat Mode; adding a builtin `writer` mode would clutter the mode picker, the Settings Prompts editor, and bang commands for a non-chat feature. |
| Preview before write | **Always preview** — Accept / Retry / ✕ in the popover; no direct fill | Mirrors the #26 review-before-write philosophy. The user is mid-composition on their own words; silently replacing them is the harmful direction. Preview is the safety net against Zo over-fabricating. |
| Fill-back mechanics | New `setEnhancedValue(el, text)` in content.js: **native value setter** (`HTMLTextAreaElement.prototype` descriptor) + `InputEvent('input', {inputType:'insertText'})` + `change` | Target sites (Greenhouse, Workday, Lever job boards) are React; the existing `setFieldValue`'s plain `el.value =` assignment is swallowed by React's value tracker. The existing `setFieldValue` and its three parallel copies stay untouched — unifying them is a follow-up, not this ticket's scope. |
| #26 gate interaction | **Bypassed by design** — `ENHANCE_TEXT` is a distinct message type, never routed through `EXECUTE_ACTIONS`/`runExecuteActions` | The gate guards model-initiated batch fills keyed on action type + page sensitivity. This is explicitly user-initiated, single-field, and already previewed — re-parking it behind the form review card would be redundant friction. |
| Icon visibility | Delegated `focusin`/`focusout` on `document`; icon shows for the focused eligible field, hidden on blur with a ~150ms grace so the icon itself is clickable; repositioned on scroll/resize while active | First focus tracking in the repo. Focus-based (not hover) avoids flicker; one icon instance moves between fields. |
| Target fields | `<textarea>` **and `contenteditable` rich editors** (round 2, same day): GitHub's new issue form description is a CodeMirror-6 `contenteditable` div — the v1 textarea-only scope showed no icon there (user-reported). CE editors read text via `innerText`, placeholder via `aria-placeholder`/`data-placeholder`, no `maxLength`; write-back goes through the editor's own input pipeline (select-all + `execCommand('insertText')`, one line at a time with `insertLineBreak`) so editor state stays in sync — a direct DOM write would be clobbered by the next editor update. Falls back to `textContent` + synthetic `input` when `execCommand` is absent | The single most likely real-world target (GitHub/GitLab editors) is contenteditable; the execCommand path is what editor frameworks observe. |
| Style isolation | Single host element with `attachShadow({mode:'open'})` on `document.documentElement`; `position:fixed` widget at very high z-index; `pointer-events` only on the widget itself | No precedent exists; open shadow root keeps page CSS out and ours in, and the host never blocks page interaction. |
| Icon asset | `icons/icon.svg` via `chrome.runtime.getURL` + new `web_accessible_resources` manifest entry | Keeps the brand asset single-sourced (no SVG inlining into content.js). `web_accessible_resources` is required for MV3 in-page `<img>` and is currently absent. |
| Enablement | `enableWriteAssist` boolean, default **true**, in `storage.sync`, read lazily by content.js on first focusin + `storage.onChanged` mirror; Options checkbox | Mirrors `enableScreenshots`. Content scripts have storage access; lazy read avoids startup cost. |
| Threading / follow-ups | **None in v1** — each Enhance is an independent one-shot | "Make it shorter" iteration needs a thread + a richer popover; deferred. |

## Data & contracts

- **Messages** (`tests/schemas/messages.ts`): add `"ENHANCE_TEXT"` to `MESSAGE_TYPES` (the bidirectional contract test fails otherwise) + `case 'ENHANCE_TEXT':` in background.js. Request payload: `{ text, instruction?, field: { label, placeholder, maxLength }, page: { url, title } }`. Response: `{ ok: true, text }` | `{ ok: false, error }`.
- **`lib/write-assist.js`** (pure, no chrome/DOM deps):
  - `isEnhanceableField(info)` → boolean — visible, not disabled/readonly.
  - `buildEnhancePrompt({ text, instruction, field, page })` → string. Rules baked in: keep the user's voice and first-person point of view; expand the lead into a complete answer; **do not invent specific facts not implied by the lead** (honest-copy); output ONLY plain text (no markdown, no preamble, no quotes); respect `maxLength` when present. Field context = label + placeholder; page context = URL + title only (token-cheap, no DOM text).
  - `parseEnhanceResponse(raw)` → `{ text }` — trims, strips wrapping code fences and quote pairs.
- **Zod** (`tests/schemas/write-assist.ts`): schemas for the prompt-builder input/output, the parsed response, and the eligibility verdict.
- **Manifest**: `web_accessible_resources: [{ resources: ["icons/icon.svg"], matches: ["<all_urls>"] }]`; extend `tests/schemas/manifest.ts`.
- **Config**: `enableWriteAssist` added to background inline `DEFAULTS` + init `storage.sync.get` + `onChanged` mirror; `lib/config.js` `DEFAULTS` + a `STORAGE` key for test parity.

## UX

Icon: 16–18px Zo mark, offset inward from the textarea's bottom-right corner so it never covers usable area; `tabindex=0`, Enter opens the popover (keyboard parity); tooltip "Enhance with Zo".

Popover (same shadow root): anchored **inside the field's own box** (bottom-aligned, near the icon) whenever the field is tall enough to contain it — it then never covers page content outside the field and never extends past the viewport, so opening it forces no scroll (owner request: "keep the popup inside the textarea so as to not make any extra scroll"). Fields taller than the viewport clamp the popover to the visible part; small fields fall back to below-the-field (flipping above, viewport-clamped). Re-anchored after every state render (compose → loading → result change the height) and on scroll/resize. States:
1. **Compose state** — truncated preview of the lead text, a one-line optional instruction input, **Enhance** button, ✕.
2. **Loading state** — spinner + "Zo is writing…", cancel (aborts the fetch via AbortController).
3. **Result state** — scrollable preview of the improved text, **Accept** / **Retry** / ✕.
4. **Error state** — inline message (no token → point to Options; API error → message; extension invalidated → friendly reload hint) + Retry / ✕.

Esc closes the popover; clicking outside closes it and aborts any in-flight call. Accept writes the text, fires framework-visible events, and closes.

## Error handling

- **No token**: background returns `{ok:false, error:'…token…'}`; popover error state links the user to Options.
- **API / network error**: surfaced verbatim-ish in the error state with Retry.
- **Extension context invalidated** (reload mid-session): `chrome.runtime.sendMessage` throws — caught around the call, error state suggests reloading the page.
- **Timeout**: 60s AbortController in the background; long generations show the loading state until then; the popover's cancel aborts earlier.
- **Result exceeds `maxLength`**: Zo is instructed to respect it; if the result still overflows, the popover shows the text and a short "longer than the field's limit" note — Accept still works (the page, not us, enforces the limit).
- **Textarea removed/hidden while open**: popover closes on the next reposition attempt when the anchor is no longer connected/visible.

## Testing

- **Unit**: `tests/write-assist.test.ts` against `tests/schemas/write-assist.ts` — prompt builder (field context present, maxLength rule, plain-text rule, honest-copy rule), response parser (fence/quote stripping), eligibility predicate. Factory-helper style per `tests/formfill.test.ts`.
- **Contract**: `tests/schemas/messages.ts` += `ENHANCE_TEXT` (forces the background `case`).
- **Manifest**: `tests/schemas/manifest.ts` asserts the `web_accessible_resources` entry.
- **Integration (content)**: `tests/integration/content-flow.test.ts` — happy-dom page with a textarea: focusin → icon present in the shadow host; stubbed `sendMessage` response → result preview; Accept → value written + recorded `input`/`change` events; toggle off → no icon.
- **Integration (full)**: `tests/integration/extension-flow.test.ts` — content `ENHANCE_TEXT` → background → ZoFetchMock records the `/zo/ask` body (assert **no** `conversation_id`) → response reaches content.
- **E2E**: new fixture `e2e/fixtures/site/writing.html` (job-application textarea with label + maxlength); new `pickScenario` branch in `e2e/mock-zo/server.mjs` keyed on the enhance prompt marker; `e2e/16-write-assist.spec.ts` drives real Chromium: focus → icon visible → click → enhance → accept → assert the textarea value.
- **Config**: `tests/settings-persistence.test.ts` + `tests/config-behavior.test.ts` cover the new toggle.

## Non-goals

- Follow-up iteration ("make it shorter") via a persistent thread; streaming tokens into the popover (one-shot for v1).
- Undo toast (the preview already gates the write); logging enhancements into sidepanel chat history.
- Iframe textareas (`all_frames:false` — content script runs in the main frame only).
- Unifying the three parallel `setFieldValue` copies (noted follow-up).
- ~~`contenteditable` rich-text editors~~ — **pulled into scope same-day (round 2)** after the user hit exactly this on GitHub's new issue form (CodeMirror `contenteditable`); see the decisions table.
