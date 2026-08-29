# Vision transport — pass screenshots to Zo's image models (v0.2.2)

**Date:** 2026-08-29
**Status:** Approved plan (brainstormed from "v2.2 image model support")
**Milestone:** v0.2.2, after the v0.2.1 slate (#19 → #10 → #29)
**Branches:** `feature/vision-probe` (Phase 0) → `feature/vision-transport` (Phase 1–2), PRs into `dev`

## Problem

Backlog #25 shipped the capture + gate half of vision support:

- Tier-3 modes capture the visible tab via `chrome.tabs.captureVisibleTab` (JPEG data URL)
  into `context.screenshotDataUrl` (`background.js` `getActiveTabContext`).
- `lib/vision.js` gates the capture on `/models/catalog` `supports_images` so non-vision
  models skip it.

But the **transport half is missing**. The data URL is only ever embedded as
`![page](data:image/jpeg;base64,…)` inside the prompt string (`lib/prompt.js` `## Screenshot`
section), and the pinned API baseline (2026-08-15) says `/zo/ask` accepts
`input: string` only — no image field, no upload endpoint. The screenshot almost
certainly never reaches a vision model. BACKLOG #25 says it outright: *"tier 3 is
dead until Zo adds image support to the API"* — the live probe was never run.

Two latent bugs compound this:

1. `vision.js#findModelEntry` matches `m.model_name`, but the `/models/catalog`
   baseline keys entries on `value` (`mcp`/openapi `PublicModelChoice`). The gate may
   be reading the catalog wrong in production.
2. `scripts/prompt-evals/cases.ts` sets `ctx.screenshot` (not `ctx.screenshotDataUrl`),
   so the `visual-describe` eval never exercises the screenshot section.

## Design

Evidence-first, two phases with a decision gate between them.

### Phase 0 — Discovery spike (`feature/vision-probe`)

1. `bun run check:drift`. If upstream `/zo/ask` changed since 2026-08-15, re-pin
   (`--update-baseline`) and read the new field shape — that decides the transport.
2. Fix `findModelEntry` to match `m.model_name ?? m.value` (+ `tests/vision.test.ts`
   fixture with a `value`-keyed catalog).
3. Fix the eval case field name; refresh the offline cache.
4. Live probe via `tests/test-prompts/` (ZO_API_KEY in `.env`):
   - **P1 control** — vision model + text-only description (sanity).
   - **P2** — markdown data-URL image inside `input` (current behavior): does the model
     describe the actual image?
   - **P3** — if drift revealed an image/attachments field, POST it directly.
   - **P4** — MCP handoff feasibility: `bash` tool writes a base64-decoded jpeg into
     `/home/workspace/probe.jpeg`, prompt asks Zo to open and describe it; verify
     payload-size tolerance (~1MB b64 in one tool call).
5. Findings go into this spec + BACKLOG #25. **Decision gate:** transport priority
   P3 (native field) > P2 (markdown embed) > P4 (MCP handoff, experimental).

### Phase 1 — Transport implementation (`feature/vision-transport`)

- **`extension/lib/vision-transport.js`** (pure ES module, schema-tested):
  `buildAskPayload({prompt, screenshotDataUrl, transport})` — places the image in the
  supported slot and strips the inline markdown data-URL from `input` (the
  `## Screenshot` body becomes `[screenshot attached via <transport>]`).
  `downscaleDecision(dataUrl)` helper: capture runs through an OffscreenCanvas
  downscale in background (target max dim 1568px, JPEG q0.75, skip if already small).
- **Config:** `screenshotMaxDim` / `screenshotQuality` in `config.js` DEFAULTS (no new UI).
- **Background wiring:** `askZoStream`/`_askZoStreamImpl` + non-streaming `askZo` use
  `buildAskPayload`; on image-rejection error (422/400) retry once with the image
  stripped + emit `STREAM_DIAGNOSTIC`; chat note "screenshot skipped (API rejected image)".
- **Privacy/hygiene:** never persist `screenshotDataUrl` into `cobrowse_convos`
  message records; existing `enableScreenshots` + tier-3 gating unchanged.
- **Prompt inspector:** `describePrompt` renders the screenshot section as
  attached-separately (no base64 blob) so preview matches send.

### Phase 2 — Tests + release prep

- `tests/vision-transport.test.ts` (payload shape, strip, downscale decision);
  integration case in `extension-flow.test.ts` asserting the recorded fetch body
  carries the image field; e2e mock server accepts + echoes the image transport;
  prompt schema update if `describePrompt` output changes.
- If transport = MCP fallback: `screenshotTransport: 'mcp'` config flagged
  experimental, documented in `extension/AGENTS.md`.
- CHANGELOG `[Unreleased]`, BACKLOG #25 status, AGENTS.md index rows,
  `bun run verify` + e2e green, PR → `dev`.

### Contingency

If all probes fail (Zo truly has no image path), Phase 0 still ships (the two bug
fixes + documented findings) and the plan parks at "tier 3 blocked upstream" with a
filed drift-ticket. No speculative transport code.

## Testing

Per repo convention: schema-first (Zod) for any new structured output; pure logic in
`extension/lib/` with direct unit tests; integration via the fake-chrome bus; e2e
against the mock Zo server. Phase 0's probe harness lives in `tests/test-prompts/`
alongside the existing capture/replay tooling.
