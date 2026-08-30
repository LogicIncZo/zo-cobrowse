# Performance Baseline — 0.2.6 (#67)

**Date:** 2026-08-30 · **Method:** measure first, optimize only with before/after numbers.
**Instrument:** the #67 debug mode (Settings → Features → Debug & Diagnostics) records
metadata-only timings (message hops, capture durations, stream durations) in a ring buffer,
exportable via "Copy diagnostics".

## In-process compute costs (bun 1.3.x, this machine, 2000-op mean)

Prompt/policy compute is **microseconds — none of it is worth optimizing**:

| Operation | Mean |
|---|---|
| `buildPrompt` (cobrowse, tier 2, ~10k-char page) | 0.033 ms |
| `buildPrompt` (ask, tier 0 read) | 0.006 ms |
| `describePrompt` (same ctx) | 0.028 ms |
| `decideTurn` (action first turn) | 0.0006 ms |
| `computePageHash` (tier 2) | 0.0008 ms |
| `parseZoOutput` (action envelope) | 0.002 ms |

A 2000-op run totals <100 ms — per-turn prompt assembly is noise against a multi-second
LLM stream. **Conclusion: prompt-side "optimizations" are off the table**; token cost
(bloat) is the real lever — see #71.

## Where the real time goes (to be measured on-device, recipe below)

The dominant costs are environmental, not compute:

1. **MV3 service-worker cold start** — first-use latency after ~30s idle (the #73 cache fix
   removed the *functional* cost; the latency remains). Measure: debug mode ON → note the
   `capture` entry's `durMs` on the first turn after an idle gap vs. a warm turn.
2. **Message hops** (panel ↔ background ↔ content) — each `msg` entry in the export is one hop;
   a full turn emits ~6–10. Cross-referencing `capture` durations isolates the capture IPC share.
3. **Stream latency** — `stream:done` `durMs` is dominated by Zo's inference time (network);
   per-chunk render cost is the panel-side share (candidate for the 0.2.7 ratchet if exports
   show long gaps between chunk arrival and paint).

## On-device measurement recipe (real Chrome, owner-run)

1. Settings → Features → Debug & Diagnostics → enable.
2. Use the extension normally for a session (a few turns, some idle gaps).
3. Copy diagnostics → paste into the bug report / perf ticket.
4. Compare: first-turn vs warm-turn `capture` (cold-start + IPC), `stream:done` distributions,
   hop counts per turn.

## Discipline

Any optimization PR must quote before/after numbers from this instrument (or `bun /tmp`-style
micro-benches for pure functions, committed into the PR description). No intuition-driven
"optimizations" — per the 0.2.6 slate's evidence rule.
