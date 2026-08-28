// Zo API drift gate — runner half. CI-only plus manual `bun run check:drift`.
//
//   bun scripts/zo-drift/check.ts [--report-json] [--update-baseline]
//
// Fetches the two upstream reference snapshots (allowlisted https URLs only),
// diffs them against the pinned baselines, and reports. Default output is a
// human summary; `--report-json` prints only the machine-readable DriftReport
// to stdout (CI redirects it into a file). Run from the repo root — baseline
// paths below are root-relative literals. Exit codes:
//   0  no drift, or soft drift only (tickets get filed by CI, gate stays green)
//   1  hard drift — a load-bearing API dependency changed (release gate red)
//   2  infra failure — fetch/parse blew up before any comparison (gate red;
//      rerun; admin-bypass only if upstream is down for a prolonged period)
// After triaging a drift ticket: `bun run check:drift --update-baseline`,
// then commit the refreshed baselines referencing the issue.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  classifyOpenApiDrift,
  classifyToolDrift,
  diffOpenApi,
  diffTools,
  parseToolSnapshot,
  type DriftFinding,
  type DriftReport,
} from './lib.ts';

// Exact upstream sources — https only, no redirects, no other hosts (SSRF).
const SOURCES = {
  mcp: 'https://raw.githubusercontent.com/EthanThatOneKid/zocomputer-tools/main/openapi/mcp-tools.json',
  openapi: 'https://raw.githubusercontent.com/EthanThatOneKid/zocomputer-ts/main/openapi/openapi.json',
} as const;

async function fetchJson(url: string, attempts = 3): Promise<unknown> {
  if (!Object.values(SOURCES).includes(url as (typeof SOURCES)[keyof typeof SOURCES])) {
    throw new Error('URL not allowlisted for drift checks: ' + url);
  }
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
      return JSON.parse(await res.text());
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw new Error('fetch failed after ' + attempts + ' attempts: ' + (lastErr instanceof Error ? lastErr.message : lastErr));
}

function printSummary(report: DriftReport): void {
  console.log('## Zo API drift gate');
  if (report.error) {
    console.log('- ❌ **Infra failure** — ' + report.error);
    return;
  }
  if (report.findings.length === 0) {
    console.log('- ✅ Upstream references match the pinned baselines.');
    return;
  }
  const hard = report.findings.filter((f) => f.severity === 'hard').length;
  console.log('- 🔍 **' + report.findings.length + ' drift finding(s)** — ' + hard + ' hard, ' + (report.findings.length - hard) + ' soft.');
  console.log('');
  console.log('| Severity | Finding | Dedup key |');
  console.log('|---|---|---|');
  for (const f of report.findings) console.log('| ' + f.severity + ' | ' + f.title + ' | `' + f.key + '` |');
  console.log('');
  console.log('Triage the ticket(s), then re-pin: `bun run check:drift --update-baseline`.');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes('--update-baseline');
  const jsonOut = args.includes('--report-json');

  const report: DriftReport = {
    checkedAt: new Date().toISOString(),
    sources: { ...SOURCES },
    findings: [],
  };

  try {
    const [mcp, openapi] = await Promise.all([fetchJson(SOURCES.mcp), fetchJson(SOURCES.openapi)]);

    if (updateBaseline) {
      writeFileSync('scripts/zo-drift/baseline/mcp-tools.json', JSON.stringify(mcp, null, 2) + '\n');
      writeFileSync('scripts/zo-drift/baseline/openapi.json', JSON.stringify(openapi, null, 2) + '\n');
      console.log('baselines re-pinned: scripts/zo-drift/baseline/{mcp-tools.json,openapi.json}');
      console.log('next: commit them, referencing the drift ticket(s) they close');
      return 0;
    }

    const toolDiff = diffTools(
      parseToolSnapshot(JSON.parse(readFileSync('scripts/zo-drift/baseline/mcp-tools.json', 'utf8'))),
      parseToolSnapshot(mcp),
    );
    const apiDiff = diffOpenApi(JSON.parse(readFileSync('scripts/zo-drift/baseline/openapi.json', 'utf8')), openapi);
    const findings: DriftFinding[] = [...classifyToolDrift(toolDiff), ...classifyOpenApiDrift(apiDiff)];
    findings.sort((a, b) => (a.severity === b.severity ? (a.key < b.key ? -1 : 1) : a.severity === 'hard' ? -1 : 1));
    report.findings = findings;

    const hard = findings.filter((f) => f.severity === 'hard').length;
    if (jsonOut) {
      // stdout carries ONLY the report so `> drift-report.json` is valid JSON;
      // diagnostics go to stderr.
      console.error('drift check: ' + findings.length + ' finding(s), ' + hard + ' hard');
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.error('drift check: ' + findings.length + ' finding(s), ' + hard + ' hard');
      printSummary(report);
    }
    return hard > 0 ? 1 : 0;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    console.error('drift check infra failure: ' + report.error);
    if (jsonOut) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printSummary(report);
    }
    return 2;
  }
}

process.exit(await main());
