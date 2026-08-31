#!/usr/bin/env bun
/**
 * Cold-start micro-bench (Lane B 2b, 0.2.7): module-graph eval cost of the
 * service-worker entry point. Each sample is a fresh bun subprocess (the
 * module registry is per-process), so numbers include runtime bootstrap —
 * compare RELATIVE deltas only, never quote as absolute Chrome SW cost.
 *
 *   bun scripts/bench-cold-start.ts
 *
 * 2026-08-31 verdict: median ~17.6ms for the whole graph (background.js +
 * all lib/ modules, ~260KB) — single-digit-ms savings at best from lazy
 * dynamic imports, so item 2b closed as a documented no-op (see
 * docs/qa/perf-baseline.md).
 */
const samples: number[] = [];
for (let i = 0; i < 7; i++) {
  const proc = Bun.spawnSync([
    "bun", "-e",
    "await import('../extension/background.js').catch(()=>{}); console.log(performance.now().toFixed(1))",
  ], { cwd: import.meta.dir + "/.." });
  const v = parseFloat(proc.stdout.toString().trim());
  if (Number.isFinite(v)) samples.push(v);
}
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
console.log(JSON.stringify({
  samples,
  median: median.toFixed(1) + "ms",
  note: "median in-process eval of the background.js module graph (incl. runtime bootstrap); warm FS",
}));
