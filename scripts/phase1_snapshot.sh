#!/usr/bin/env bash
# Phase 1 database state snapshot. Run pre and post the removal phase.
# Usage: ./scripts/phase1_snapshot.sh [pre|post|t24h]
# Output: scripts/phase1_snapshot_<label>.txt

set -euo pipefail

LABEL="${1:-snap}"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
OUT="scripts/phase1_snapshot_${LABEL}.txt"

SSH_TARGET="root@147.182.150.30"
SSH_KEY="$HOME/.ssh/digitalocean_saa"

read -r -d '' SQL <<'EOF' || true
SELECT 'snapshot_taken_at'             AS metric, NOW()::text AS value
UNION ALL SELECT 'RadarReport_count',           COUNT(*)::text FROM "RadarReport"
UNION ALL SELECT 'RadarPick_count',             COUNT(*)::text FROM "RadarPick"
UNION ALL SELECT 'OpeningBellReport_count',     COUNT(*)::text FROM "OpeningBellReport"
UNION ALL SELECT 'OpeningBellPick_count',       COUNT(*)::text FROM "OpeningBellPick"
UNION ALL SELECT 'PortfolioEntry_total',        COUNT(*)::text FROM "PortfolioEntry"
UNION ALL SELECT 'PortfolioEntry_with_obPick',  COUNT(*)::text FROM "PortfolioEntry" WHERE "openingBellPickId" IS NOT NULL
UNION ALL SELECT 'PortfolioEntry_with_radarPick', COUNT(*)::text FROM "PortfolioEntry" WHERE "radarPickId" IS NOT NULL
UNION ALL SELECT 'User_total',                  COUNT(*)::text FROM "User"
UNION ALL SELECT 'User_emailRadar_true',        COUNT(*)::text FROM "User" WHERE "emailRadar" = true
UNION ALL SELECT 'User_emailOpeningBell_true',  COUNT(*)::text FROM "User" WHERE "emailOpeningBell" = true
UNION ALL SELECT 'Spike_total',                 COUNT(*)::text FROM "Spike"
UNION ALL SELECT 'DailyReport_total',           COUNT(*)::text FROM "DailyReport"
UNION ALL SELECT 'CouncilLog_total',            COUNT(*)::text FROM "CouncilLog"
ORDER BY metric;
EOF

echo "[snapshot:$LABEL] $TS — capturing database state via $SSH_TARGET"

# SQL is piped over stdin so "CamelCaseTable" identifiers survive the remote shell intact.
# (Original plan used `-c "$SQL"` which collapsed the inner quotes and broke identifier casing.)
ssh -i "$SSH_KEY" "$SSH_TARGET" 'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -At -F"|"' <<<"$SQL" \
  | tee "$OUT"

echo "[snapshot:$LABEL] saved to $OUT"
