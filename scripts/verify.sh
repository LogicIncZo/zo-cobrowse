#!/usr/bin/env bash
# Zo Co-browse — loop-engineering verification gate.
# Runs the full pre-commit check in one command:
#   1. unit/integration test suite   (bun test)
#   2. release readiness checks      (bun run lint -> scripts/check-release.sh)
#   3. per-entry transpile check     (bun build of every extension entry point)
#   4. prompt-budget gate            (#238 — committed ceilings, +2% tolerance)
# Exits non-zero on the first failing stage so it can gate commits/CI.
#
# Used by: bun run verify  (and the committed pre-commit hook in scripts/hooks/)

set -uo pipefail

BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

fail=0

step() {
  echo ""
  echo -e "${BOLD}$1${NC}"
}

run_stage() {
  local name="$1"; shift
  if "$@" > /tmp/zo-verify-$name.log 2>&1; then
    echo -e "  ${GREEN}✓${NC} ${name}"
  else
    echo -e "  ${RED}✗${NC} ${name} — output below:"
    echo ""
    sed 's/^/    /' /tmp/zo-verify-$name.log | tail -40
    fail=1
  fi
}

# Guard: bun must be present (tests + bundling both need it).
if ! command -v bun >/dev/null 2>&1; then
  echo -e "${RED}✗ bun not found — run 'npm i -g bun' or use a bun-enabled shell${NC}"
  exit 1
fi

step "1/4  Test suite (bun test tests/)"
run_stage "tests" bun test tests/

step "2/4  Release readiness checks (bun run lint)"
run_stage "lint" bun run lint

step "3/4  Transpile check (bun build of every extension entry point)"
transpile_fail=0
for f in extension/*.js; do
  [ -e "$f" ] || continue
  if bun build "$f" --outdir /tmp/zo-verify-build > /tmp/zo-verify-build.log 2>&1; then
    echo -e "  ${GREEN}✓${NC} $f"
  else
    echo -e "  ${RED}✗${NC} $f"
    sed 's/^/    /' /tmp/zo-verify-build.log | tail -20
    transpile_fail=1
  fi
done
[ "$transpile_fail" -eq 0 ] || fail=1

step "4/4  Prompt-budget gate (#238 — per-mode × shape ceilings)"
run_stage "budget" bun scripts/prompt-budget/prompt-budget.ts

echo ""
if [ "$fail" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}✓ Verification passed${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}✗ Verification failed${NC}"
  exit 1
fi
