/**
 * i18n census gate (#315) — like the prompt-budget gate: a checked-in
 * baseline that only moves intentionally. Fails when the key count in
 * `_locales/en/messages.json` DROPS below the baseline (extraction only
 * grows the surface) or when the file drifts from the baseline without a
 * deliberate bump.
 *
 * The census also covers the aria-label surface (#392): `aria-label="…"`
 * attributes in the extension HTML plus `setAttribute('aria-label', …)`
 * calls in the page scripts, so accessible names grow deliberately too.
 * Captures are the raw source text (template/ternary expressions kept
 * verbatim), deduped + sorted — deterministic and diffable.
 *
 *   bun scripts/i18n-census.ts            # compare vs baseline
 *   bun scripts/i18n-census.ts --update   # re-pin (extraction PRs only)
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve } from "path";

const extDir = resolve(import.meta.dir, "../extension");
const messagesPath = resolve(extDir, "_locales/en/messages.json");
const baselinePath = resolve(import.meta.dir, "i18n-census.json");

const messages = JSON.parse(readFileSync(messagesPath, "utf8"));
const keys = Object.keys(messages).sort();

const ariaSources = [
  ...readdirSync(extDir).filter((f) => f.endsWith(".html")),
  "options.js",
  "sidepanel.js",
  "content.js",
];
const ariaLabels = [
  ...new Set(
    ariaSources.flatMap((f) => {
      const src = readFileSync(resolve(extDir, f), "utf8");
      return [
        ...[...src.matchAll(/\baria-label="([^"]*)"/g)].map((m) => m[1]),
        ...[...src.matchAll(/setAttribute\('aria-label', (.*)\);/g)].map((m) => m[1]),
      ];
    }),
  ),
].sort();

if (process.argv.includes("--update")) {
  writeFileSync(
    baselinePath,
    JSON.stringify({ keys, count: keys.length, ariaLabels, ariaLabelCount: ariaLabels.length }, null, 2) + "\n",
  );
  console.log(`i18n census re-pinned: ${keys.length} keys, ${ariaLabels.length} aria-labels`);
  process.exit(0);
}

let baseline: { keys: string[]; count: number; ariaLabels?: string[]; ariaLabelCount?: number };
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch {
  console.error("✗ i18n census baseline missing — run `bun scripts/i18n-census.ts --update` in the extraction PR");
  process.exit(1);
}

const missing = baseline.keys.filter((k) => !keys.includes(k));
const added = keys.filter((k) => !baseline.keys.includes(k));

if (missing.length) {
  console.error(`✗ i18n census: keys REMOVED vs baseline (extraction never removes): ${missing.join(", ")}`);
  process.exit(1);
}
if (added.length) {
  console.error(`✗ i18n census: ${added.length} new key(s) not in baseline — re-pin intentionally with \`bun scripts/i18n-census.ts --update\`: ${added.join(", ")}`);
  process.exit(1);
}

const missingLabels = (baseline.ariaLabels ?? []).filter((l) => !ariaLabels.includes(l));
const addedLabels = ariaLabels.filter((l) => !(baseline.ariaLabels ?? []).includes(l));

if (missingLabels.length) {
  console.error(`✗ i18n census: aria-labels REMOVED vs baseline (extraction never removes): ${missingLabels.join(" | ")}`);
  process.exit(1);
}
if (addedLabels.length) {
  console.error(`✗ i18n census: ${addedLabels.length} new aria-label(s) not in baseline — re-pin intentionally with \`bun scripts/i18n-census.ts --update\`: ${addedLabels.join(" | ")}`);
  process.exit(1);
}
console.log(`✓ i18n census: ${keys.length} keys + ${ariaLabels.length} aria-labels match baseline`);
