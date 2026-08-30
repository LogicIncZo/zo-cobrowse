// Keep docs/changelog.md's [Unreleased] section in lockstep with the root
// CHANGELOG.md (the docs-site mirror). Born from the #96 hygiene round: the
// mirror had silently gone empty while root accumulated the 0.2.6 slate.
//
//   bun scripts/sync-changelog.ts           → rewrite docs/changelog.md
//   bun scripts/sync-changelog.ts --check   → exit 1 on drift (lint gate)
import { readFileSync, writeFileSync } from "fs";

const root = readFileSync("CHANGELOG.md", "utf-8");
const m = root.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[)/);
const section = m ? m[1].trim() : "";

const docPath = "docs/changelog.md";
const doc = readFileSync(docPath, "utf-8");
const docRe = /(## \[Unreleased\]\n)([\s\S]*?)(?=\n## \[)/;
const expected = doc.replace(docRe, (_s, head: string) => `${head}\n${section}\n`);

if (process.argv.includes("--check")) {
  if (doc !== expected) {
    console.error("✗ docs/changelog.md [Unreleased] is stale vs root CHANGELOG.md — run: bun scripts/sync-changelog.ts");
    process.exit(1);
  }
  console.log("✓ docs changelog mirror in sync");
} else {
  writeFileSync(docPath, expected);
  console.log("✓ docs/changelog.md [Unreleased] synced from root CHANGELOG.md");
}
