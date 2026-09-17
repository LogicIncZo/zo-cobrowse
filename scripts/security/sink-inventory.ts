#!/usr/bin/env bun
/**
 * Security sink inventory (#243 security review round). Deterministic scan of
 * the shipped extension surface — the message-passing roster, the HTML-injection
 * sinks, and the secret-flow call sites — so every audit rerun compares apples
 * to apples. NOT a linter: presence here is expected; UNEXPECTED growth is what
 * a re-run diffs against docs/qa/security-review.md.
 *
 *   bun scripts/security/sink-inventory.ts
 */

import { readFileSync, readdirSync } from "node:fs";

const files = readdirSync(new URL("../../extension/", import.meta.url)).filter((f) => f.endsWith(".js"));
const src = (f: string) => readFileSync(new URL(`../../extension/${f}`, import.meta.url), "utf-8");

type Hit = { file: string; line: number; text: string };
const scan = (re: RegExp, files: string[], flags = ""): Hit[] => {
  const hits: Hit[] = [];
  for (const f of files) {
    src(f).split("\n").forEach((line, i) => {
      if (new RegExp(re.source, re.flags || flags).test(line)) {
        hits.push({ file: f, line: i + 1, text: line.trim().slice(0, 140) });
      }
    });
  }
  return hits;
};

const js = files;

console.log("== message-passing roster ==");
for (const h of scan(/onMessage\.addListener/g, js)) console.log(`  ${h.file}:${h.line}  ${h.text}`);
const types = scan(/type === ['"]([A-Z_]+)['"]/g, js);
console.log(`  (background/content case types: ${types.length} comparisons across ${new Set(types.map((t) => t.file)).size} files)`);
for (const h of scan(/onConnect(Betweenets|External)?\.addListener|onConnect\b/g, js)) console.log(`  ${h.file}:${h.line}  ${h.text}`);
for (const h of scan(/addEventListener\((['"])message\1/g, js)) console.log(`  PAGE-MESSAGE LISTENER: ${h.file}:${h.line}  ${h.text}  ← must be empty`);
for (const h of scan(/externally_connectable|onMessageExternal|onConnectExternal/g, js.concat("manifest.json"))) console.log(`  EXTERNAL SURFACE: ${h.file}:${h.line}  ← must be empty`);

console.log("\n== HTML-injection sinks (innerHTML/insertAdjacentHTML/outerHTML/document.write/DOMParser/eval) ==");
for (const h of scan(/\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|document\.write|DOMParser|\beval\(/g, js)) {
  console.log(`  ${h.file}:${h.line}  ${h.text}`);
}

console.log("\n== secret-flow sites (token reads → destinations) ==");
for (const h of scan(/zoAccessToken/g, js)) console.log(`  ${h.file}:${h.line}  ${h.text}`);
for (const h of scan(/storage\.sync\.set/g, js)) console.log(`  SYNC-WRITE: ${h.file}:${h.line}  ${h.text}  ← token must never appear`);
for (const h of scan(/console\.(log|error|warn)/g, js)) console.log(`  LOG: ${h.file}:${h.line}  ${h.text.slice(0, 90)}`);

console.log("\n== network construction (URL built from interpolation?) ==");
for (const h of scan(/fetch\(/g, js)) console.log(`  ${h.file}:${h.line}  ${h.text.slice(0, 120)}`);
console.log("\nDone. Diff this output against docs/qa/security-review.md § 'Sink inventory'.");
