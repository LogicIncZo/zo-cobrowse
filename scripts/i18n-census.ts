/**
 * i18n census gate (#315) — like the prompt-budget gate: a checked-in
 * baseline that only moves intentionally. Fails when the key count in
 * `_locales/en/messages.json` DROPS below the baseline (extraction only
 * grows the surface) or when the file drifts from the baseline without a
 * deliberate bump.
 *
 *   bun scripts/i18n-census.ts            # compare vs baseline
 *   bun scripts/i18n-census.ts --update   # re-pin (extraction PRs only)
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const messagesPath = resolve(import.meta.dir, "../extension/_locales/en/messages.json");
const baselinePath = resolve(import.meta.dir, "i18n-census.json");

const messages = JSON.parse(readFileSync(messagesPath, "utf8"));
const keys = Object.keys(messages).sort();

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, JSON.stringify({ keys, count: keys.length }, null, 2) + "\n");
  console.log(`i18n census re-pinned: ${keys.length} keys`);
  process.exit(0);
}

let baseline: { keys: string[]; count: number };
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
console.log(`✓ i18n census: ${keys.length} keys match baseline`);
