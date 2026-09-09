// QA findings validator (0.2.8 bash tooling).
//
//   bun scripts/qa/validate-findings.ts [dir] [--report-json]
//
// Parses every *.md in the findings dir (default docs/qa/findings),
// Zod-validates the frontmatter (tests/schemas/qa-findings.ts), and reports
// duplicate stable keys. Exit 0 = queue well-formed (files may exist — the
// emptiness check lives in qa-gate.sh); exit 1 = malformed file or duplicate
// key (an unparseable queue cannot gate a release). --report-json prints only
// the DirReport JSON to stdout (CI-friendly). Run from the repo root.

import { readdirSync, readFileSync } from "node:fs";
import {
  DirReportSchema,
  FindingFrontmatterSchema,
  ParsedFindingSchema,
  type DirReport,
  type ParseResult,
  type ParsedFinding,
} from "../../tests/schemas/qa-findings";

const KNOWN_KEYS = ["key", "title", "severity", "surface", "source", "found"] as const;

/** Parse one finding file's text: `---` fenced frontmatter + non-empty body. */
export function parseFindingFile(text: string): ParseResult {
  const fence = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fence) return { ok: false, error: "no --- frontmatter fence" };
  const [, rawBlock, body] = fence;
  const fields: Record<string, string> = {};
  for (const line of rawBlock.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!m) return { ok: false, error: `malformed frontmatter line: ${JSON.stringify(line)}` };
    if (!KNOWN_KEYS.includes(m[1] as (typeof KNOWN_KEYS)[number]))
      return { ok: false, error: `unknown frontmatter key: ${m[1]}` };
    fields[m[1]] = m[2].trim();
  }
  const front = FindingFrontmatterSchema.safeParse(fields);
  if (!front.success)
    return {
      ok: false,
      error: front.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  if (!body.trim()) return { ok: false, error: "empty body — findings must carry repro + evidence" };
  const finding: ParsedFinding = ParsedFindingSchema.parse({ ...front.data, body: body.trim() });
  return { ok: true, finding };
}

/** Validate every *.md in dir; report errors + duplicate stable keys. */
export function validateFindingsDir(dir: string): DirReport {
  const report: DirReport = { dir, fileCount: 0, findings: [], errors: [], duplicateKeys: [] };
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return report; // missing dir = empty queue
  }
  report.fileCount = entries.length;
  const seen = new Set<string>();
  for (const entry of entries) {
    // readdirSync yields bare names (no separators, no dot-dot segments);
    // refuse anything else before it can reach the filesystem read.
    if (entry.includes("/") || entry.includes("\\") || entry.split(".").includes("..")) {
      report.errors.push({ file: entry, error: "unsafe entry name — skipped" });
      continue;
    }
    let result: ParseResult;
    try {
      result = parseFindingFile(readFileSync(`${dir}/${entry}`, "utf8"));
    } catch (e) {
      result = { ok: false, error: `unreadable: ${e}` };
    }
    if (!result.ok) {
      report.errors.push({ file: entry, error: result.error });
      continue;
    }
    if (seen.has(result.finding.key)) report.duplicateKeys.push(result.finding.key);
    else seen.add(result.finding.key);
    report.findings.push(result.finding);
  }
  return DirReportSchema.parse(report);
}

function main() {
  const positional = process.argv.slice(2).filter((a) => a !== "--report-json");
  const dir = positional[0] ?? "docs/qa/findings";
  const json = process.argv.includes("--report-json");
  const report = validateFindingsDir(dir);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`qa findings: ${report.fileCount} file(s) in ${dir}`);
    for (const f of report.findings) console.log(`  ✓ ${f.key} [${f.severity}] ${f.title}`);
    for (const e of report.errors) console.log(`  ✗ ${e.file}: ${e.error}`);
    for (const k of report.duplicateKeys) console.log(`  ✗ duplicate key: ${k}`);
  }
  if (report.errors.length || report.duplicateKeys.length) process.exit(1);
}

if (import.meta.main) main();
