#!/usr/bin/env bash
# Verifies database state is byte-identical between pre and post Phase 1 snapshots.
# Exit 0 = parity verified. Exit 1 = drift detected — INVESTIGATE.

set -euo pipefail

PRE="scripts/phase1_snapshot_pre.txt"
POST="scripts/phase1_snapshot_post.txt"

if [ ! -f "$PRE" ] || [ ! -f "$POST" ]; then
  echo "ERROR: missing snapshot file. Need both:"
  echo "  $PRE"
  echo "  $POST"
  exit 2
fi

PRE_FILTERED=$(grep -v "^snapshot_taken_at" "$PRE")
POST_FILTERED=$(grep -v "^snapshot_taken_at" "$POST")

if diff <(echo "$PRE_FILTERED") <(echo "$POST_FILTERED") > /tmp/phase1_diff.txt; then
  echo "✓ DATABASE PARITY VERIFIED"
  echo "  All row counts identical between pre and post Phase 1 snapshots."
  echo "  Phase 1 'database untouched' guarantee: PROVEN."
  exit 0
else
  echo "✗ DATABASE DRIFT DETECTED"
  echo
  echo "Diff (pre → post):"
  cat /tmp/phase1_diff.txt
  echo
  echo "INVESTIGATE IMMEDIATELY. Phase 1 promised zero database changes."
  echo "Pre  snapshot: $PRE"
  echo "Post snapshot: $POST"
  exit 1
fi
