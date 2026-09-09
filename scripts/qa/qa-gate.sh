#!/usr/bin/env bash
# QA findings release gate (0.2.8 bash tooling).
#
#   bash scripts/qa/qa-gate.sh        (dir override: QA_FINDINGS_DIR=/path)
#
# Fails when the findings queue is non-empty or ill-formed: every finding must
# be fixed (file deleted in the fix PR) or filed on GitHub (file deleted,
# `filed #<n>` recorded in QA_REPORT.md) before a release ships. Wired as the
# CI `qa-gate` job on PRs into `main` (drift-job pattern); local: bun run
# qa:gate. Run from the repo root. Exit 0 = releasable, 1 = blocked.

set -euo pipefail

DIR="${QA_FINDINGS_DIR:-docs/qa/findings}"

# Validation leg — an unparseable queue cannot gate a release.
bun scripts/qa/validate-findings.ts "$DIR" > /dev/null

if [ ! -d "$DIR" ]; then
  echo "qa-gate passed — no findings dir"
  exit 0
fi

COUNT=$(find "$DIR" -maxdepth 1 -name '*.md' -type f | wc -l)
if [ "$COUNT" -gt 0 ]; then
  echo "::error::qa-gate: $COUNT unhandled finding(s) — fix each or file it on GitHub (milestone 0.2.8), then delete the file:" >&2
  find "$DIR" -maxdepth 1 -name '*.md' -type f | sed 's/^/  - /' >&2
  exit 1
fi

echo "qa-gate passed — findings queue empty"
