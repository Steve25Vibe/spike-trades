#!/usr/bin/env bash
# Phase 1 per-commit verification gate.
# Usage: ./scripts/phase1_verify.sh <commit_number>
# Where commit_number is 1..10.

set -euo pipefail

COMMIT="${1:?Usage: $0 <commit_number>}"
FAILED=0

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[34m%s\033[0m\n" "$*"; }

check() {
  local name="$1"; shift
  blue "→ $name"
  if "$@"; then
    green "  ✓ pass"
  else
    red "  ✗ FAIL"
    FAILED=$((FAILED+1))
  fi
}

# Always-on checks
# NOTE: The original plan also ran `npm run lint`, `npm test`, and `pytest tests/`
# here. Those are removed because this repo has no working ESLint config, no JS
# test runner, and no local Python dependency env — `test_fmp_ultimate.py` is a
# standalone async script pytest mis-collects, the 4 Radar/OB test files Commit 1
# deletes error on collection, and the production .py files import packages that
# only exist inside the Docker container. `npm run build` runs Next.js's TS
# checker across all 47 routes, which is the meaningful local gate for Commits
# 1–9. Commit 10's Python surgery is verified via `py_compile` (case block
# below) and deeper runtime verification happens at Task 11 against the deployed
# container. See docs/superpowers/plans/2026-04-07-phase-1-delta-notes.md.
check "build"  npm run build

# Commit-specific stringency
case "$COMMIT" in
  1)
    check "tests removed" \
      bash -c '! ls src/__tests__/opening-bell-api.test.ts tests/test_opening_bell_*.py tests/test_radar_scanner.py 2>/dev/null'
    ;;
  2)
    check "cron entries removed" \
      bash -c '! grep -qi "radar\|opening.\?bell\|openingbell" scripts/start-cron.ts'
    ;;
  3)
    check "sidebar nav clean" \
      bash -c '! grep -qi "/radar\|/opening-bell" src/components/layout/Sidebar.tsx'
    check "/radar page deleted" bash -c '! test -f src/app/radar/page.tsx'
    check "/opening-bell page deleted" bash -c '! test -f src/app/opening-bell/page.tsx'
    check "reports tabs gone" \
      bash -c '! grep -qi "radar\|opening.\?bell\|openingbell" src/app/reports/page.tsx'
    ;;
  4)
    check "settings + prefs route clean" \
      bash -c '! grep -qi "radar\|opening.\?bell\|openingbell" src/app/settings/page.tsx src/app/api/user/preferences/route.ts'
    ;;
  5)
    check "admin page + admin council route clean" \
      bash -c '! grep -qi "radar\|opening.\?bell\|openingbell" src/app/admin/page.tsx src/app/api/admin/council/route.ts'
    ;;
  6)
    check "SpikeCard imports clean" \
      bash -c '! grep -qE "RadarIcon|isRadarPick|isOpeningBellPick" src/components/spikes/SpikeCard.tsx'
    check "Spike type clean" \
      bash -c '! grep -qE "isRadarPick|isOpeningBellPick|radarScore" src/types/index.ts'
    check "SpikeCard touched only narrowly" \
      bash -c 'D=$(git diff HEAD~1 -- src/components/spikes/SpikeCard.tsx | grep -c "^[-+]"); test "$D" -le 20'
    ;;
  7)
    check "shared backend routes clean" \
      bash -c '! grep -qi "radar\|opening.\?bell\|openingbell" src/app/api/spikes/route.ts src/app/api/portfolio/route.ts src/app/api/accuracy/check/route.ts src/lib/scheduling/analyzer.ts src/lib/email/resend.ts'
    ;;
  8)
    check "leaf components deleted" \
      bash -c '! test -f src/components/radar/RadarCard.tsx && ! test -f src/components/radar/RadarIcon.tsx && ! test -f src/components/radar/RadarLockInModal.tsx && ! test -f src/components/opening-bell/OpeningBellCard.tsx'
    check "leaf libs deleted" \
      bash -c '! test -f src/lib/radar-analyzer.ts && ! test -f src/lib/opening-bell-analyzer.ts && ! test -f src/lib/email/radar-email.ts && ! test -f src/lib/email/opening-bell-email.ts'
    check "API routes deleted" \
      bash -c '! test -f src/app/api/radar/route.ts && ! test -f src/app/api/opening-bell/route.ts && ! test -f src/app/api/cron/radar/route.ts && ! test -f src/app/api/cron/opening-bell/route.ts && ! test -d src/app/api/reports/radar && ! test -d src/app/api/reports/opening-bell'
    ;;
  9)
    check "tailwind tokens removed" \
      bash -c '! grep -qE "radar-green|radar-sweep" tailwind.config.ts'
    check "no remaining radar-green refs anywhere" \
      bash -c '! grep -rqE "radar-green|radar-sweep|animate-radar-sweep" src/'
    ;;
  10)
    # Syntax-only compile (py_compile) instead of full import. Imports require
    # the Docker container's Python env which isn't available locally. Deeper
    # runtime verification happens at Task 11 against the deployed container.
    check "python: api_server syntax"            python3 -m py_compile api_server.py
    check "python: council brain syntax"         python3 -m py_compile canadian_llm_council_brain.py
    check "python: portfolio interface syntax"   python3 -m py_compile canadian_portfolio_interface.py
    check "python: eodhd_news syntax"            python3 -m py_compile eodhd_news.py
    check "python: fmp_bulk_cache syntax"        python3 -m py_compile fmp_bulk_cache.py
    check "opening_bell_scanner.py deleted"      bash -c '! test -f opening_bell_scanner.py'
    check "no Radar/OB refs in production .py files" \
      bash -c '! grep -liE "radar|opening.?bell|openingbell" api_server.py canadian_llm_council_brain.py canadian_portfolio_interface.py eodhd_news.py fmp_bulk_cache.py 2>/dev/null'
    ;;
esac

echo
if [ "$FAILED" -gt 0 ]; then
  red "════════════════════════════════════════"
  red "VERIFICATION GATE FAILED — $FAILED check(s) failed"
  red "DO NOT PROCEED. Revert this commit and diagnose."
  red "════════════════════════════════════════"
  exit 1
else
  green "════════════════════════════════════════"
  green "Commit $COMMIT verification gate: ALL CHECKS PASS"
  green "Safe to proceed to next commit."
  green "════════════════════════════════════════"
fi
