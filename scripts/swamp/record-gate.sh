#!/usr/bin/env bash
# record-gate.sh — run a repo gate command and emit the Swamp factory evidence
# payload plus the exact `record_evidence` invocation for it.
#
# Usage:
#   bash scripts/swamp/record-gate.sh <workItem> <gate-name> <command...>
#   bash scripts/swamp/record-gate.sh 155 gate-qa bun run qa:gate
#
# The gate's own output goes to stderr; stdout carries two lines: the JSON
# payload and the copy-pastable swamp command. Exits with the gate command's
# exit code. Model name comes from $SWAMP_FACTORY (default zo-028).
#
# The factory gates on evidence fields (exitCode / conclusion) — never
# hand-type them. This script is the only sanctioned evidence source for the
# command gates (gate-qa / gate-drift / gate-lint). See docs/swamp-factory.md.

set -uo pipefail

if [ $# -lt 3 ]; then
  echo "usage: $0 <workItem> <gate-name> <command...>" >&2
  exit 2
fi

workItem=$1
gate=$2
shift 2

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=$PWD
cd "$repo_root"

output=$("$@" 2>&1)
exit_code=$?
printf '%s\n' "$output" >&2

status=succeeded
if [ "$exit_code" -ne 0 ]; then status=failed; fi
sha=$(git rev-parse --short=7 HEAD 2>/dev/null || echo unknown)

cmd="$*"
esc=${cmd//\\/\\\\}
esc=${esc//\"/\\\"}
payload=$(printf '{"command":"%s","exitCode":%d,"status":"%s","sha":"%s"}' \
  "$esc" "$exit_code" "$status" "$sha")

factory=${SWAMP_FACTORY:-zo-loop}
echo "EVIDENCE_PAYLOAD=$payload"
echo "swamp model method run $factory record_evidence --input workItem=$workItem --input name=$gate --input payload='$payload'"

exit "$exit_code"
