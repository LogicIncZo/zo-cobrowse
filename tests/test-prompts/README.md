# Test Prompts — zo-cobrowse stream response fixtures

This folder captures **real streaming responses** from the Zo `/zo/ask` API for every major co-browse use case, and replays them through the extension's real stream parsers to guard stream-response handling.

## Why this exists

`extension/background.js:949-952` explicitly notes: *"the repo has never captured a real [SSE] chunk."* Every assumption about Zo's stream format was inferred from `extension/AGENTS.md` docs and tested only with **synthetic** SSE strings in `tests/sse-parsing.test.ts`. This folder fills that gap with recorded-golden captures from the live API — and in doing so surfaced a **major protocol mismatch** (see `qa-notes.md`).

## What's here

```
tests/test-prompts/
├── README.md                  ← this file
├── qa-notes.md                ← CRITICAL: real Zo SSE protocol findings vs docs
├── prompts.json               ← catalog of 9 use cases (all 5 builtin modes + both cobrowse intents + both ask phrasings)
├── schema.ts                  ← Zod schemas for catalog entries, fixtures, replay results
├── capture.ts                 ← bun script: live POST /zo/ask stream:true → saves .sse + .json
├── replay.ts                  ← shared harness: .sse bytes → real extractStreamContent/finishStream → STREAM_*
├── stream-catalog.test.ts     ← catalog completeness vs BUILTIN_MODES
├── stream-replay.test.ts      ← replays every fixture; asserts STREAM_* contract
└── fixtures/
    ├── cobrowse-action.sse/.json          ← action envelope JSON (expectJson)
    ├── cobrowse-action-sequence.sse/.json ← multi-action (fill + click)
    ├── cobrowse-readonly.sse/.json        ← intent downgrade → plain markdown
    ├── ask.sse/.json                      ← tier 1, plain markdown
    ├── research.sse/.json                 ← tier 1, tool calls, plain markdown
    ├── summarize.sse/.json                ← tier 1, plain markdown
    ├── extract.sse/.json                  ← tier 2, plain markdown
    ├── visual.sse/.json                   ← tier 3, plain markdown
    └── synthetic/                         ← deterministic hand-written, no key needed
        ├── error-invalid-token.sse
        ├── error-4xx.sse
        └── error-5xx-retry.sse
```

## Re-capturing from the live API

```bash
bun --env-file=.env tests/test-prompts/capture.ts           # skip existing
bun --env-file=.env tests/test-prompts/capture.ts --force   # re-capture all
```

Requires `ZO_API_KEY` (or `ZO_ACCESS_TOKEN`) in `.env` (gitignored). The script:
- Imports the real `BUILTIN_MODES`, `ACTION_SCHEMA_COMPACT`, `shouldDowngradeToJsonDisabled` from `extension/lib/*` to build the exact prompt the extension sends.
- POSTs to `https://api.zo.computer/zo/ask` with `stream:true`, `Accept: text/event-stream`.
- **Scrubs** the `FrontendModelRequest` event (echoes the full prompt incl. private workspace content) and `id:` lines before saving.
- **Redacts** the `prompt` field in metadata to 200 chars.
- Prints a discovery table of event types / actions / reasoning / tools seen.

## Tests

```bash
bun test tests/test-prompts/
```

- `stream-catalog.test.ts` — `prompts.json` covers all 5 `BUILTIN_MODES` ids + both cobrowse intents; each entry's tier/expectJson matches its Mode.
- `stream-replay.test.ts` — for every committed `fixtures/*.sse`: validates the event sequence against the Zod schema, replays through the vm-extracted real parsers, and asserts the `STREAM_DONE`/`STREAM_ERROR` contract (no raw-JSON leak, type-first action normalization, reasoning surfaced, cumulative chunk consistency).

CI runs these without a key — the committed fixtures make them deterministic.

## The big finding

**Read [`qa-notes.md`](./qa-notes.md).** The live Zo API emits a completely different SSE protocol than `extension/AGENTS.md` documents. The documented events (`FrontendModelResponse`, `End`, `Error`) never appear; the real events are `PartDeltaEvent`, `PartStartEvent`, `AgentRuntimeStreamChunk`, `completed`, etc. This round documents the gap and freezes the real shapes as fixtures — extension code fixes are a follow-up.
