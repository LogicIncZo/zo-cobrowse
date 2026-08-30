#!/usr/bin/env bash
# Release quality checks for Zo Co-browse
# Used by: bun run check-icons, bun run check-prereqs

BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

fail=0

check_file() {
  if [ -f "$1" ]; then
    echo -e "  ${GREEN}✓${NC} $1"
  else
    echo -e "  ${RED}✗${NC} $1"
    fail=1
  fi
}

echo ""
echo -e "${BOLD}Icon files${NC}"
for s in 16 48 128; do
  check_file "extension/icons/icon${s}.png"
done
check_file "extension/icons/icon.svg"

echo ""
echo -e "${BOLD}Source files${NC}"
for f in extension/manifest.json extension/background.js extension/sidepanel.html extension/sidepanel.js extension/content.js extension/styles.css extension/options.html extension/options.js; do
  check_file "$f"
done

echo ""
echo -e "${BOLD}TODO/FIXME sweep${NC}"
found=$(grep -rn 'TODO\|FIXME\|HACK' extension/ --include='*.js' --include='*.html' --include='*.css' --include='*.json' 2>/dev/null | grep -v '/icons/' | grep -v '/lib/' || true)
if [ -n "$found" ]; then
  echo -e "  ${YELLOW}⚠ Found:${NC}"
  echo "$found" | sed 's/^/    /'
else
  echo -e "  ${GREEN}✓ None found${NC}"
fi

echo ""
echo -e "${BOLD}console.log in prod${NC}"
produced=$(grep -rn 'console\.log' extension/ --include='*.js' 2>/dev/null | grep -v '/icons/' | grep -v '/lib/' || true)
if [ -n "$produced" ]; then
  echo -e "  ${RED}✗ Found $(echo "$produced" | wc -l) occurrences${NC}"
  echo "$produced" | sed 's/^/    /'
  fail=1
else
  echo -e "  ${GREEN}✓ None found${NC}"
fi

echo ""
echo -e "${BOLD}Line endings${NC}"
crlf=$(file extension/*.js extension/*.html extension/*.css extension/*.json 2>/dev/null | grep -i "CRLF" || true)
if [ -n "$crlf" ]; then
  echo -e "  ${YELLOW}⚠ CRLF found:${NC}"
  echo "$crlf" | sed 's/^/    /'
else
  echo -e "  ${GREEN}✓ All LF${NC}"
fi

echo ""
echo -e "${BOLD}Version sync (package.json ↔ manifest)${NC}"
# Policy (0.2.7 spec, item 5): package.json version mirrors extension/manifest.json
# and both bump together at release prep. This gate makes drift impossible to merge.
pkg_ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -1)
man_ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/manifest.json 2>/dev/null | head -1)
if [ -z "$pkg_ver" ] || [ -z "$man_ver" ]; then
  echo -e "  ${RED}✗ Could not read version fields${NC}"
  fail=1
elif [ "$pkg_ver" != "$man_ver" ]; then
  echo -e "  ${RED}✗ package.json ($pkg_ver) != extension/manifest.json ($man_ver) — bump them together at release prep${NC}"
  fail=1
else
  echo -e "  ${GREEN}✓ $pkg_ver${NC}"
fi

echo ""
if [ "$fail" -eq 1 ]; then
  echo -e "${RED}❌ Some checks failed${NC}"
else
  echo -e "${GREEN}✓ All checks passed${NC}"
fi
exit $fail
