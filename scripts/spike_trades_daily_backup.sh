#!/bin/bash
# spike_trades_daily_backup.sh
# ============================================================================
# Daily integrity safeguard for Spike Trades production data.
# ============================================================================
#
# Runs from host-side cron (NOT inside any container) at 04:00 ADT every day.
# Performs three jobs:
#
#   1. SQLite council DB backup → /opt/spike-trades/backups/council/
#   2. Postgres pg_dump            → /opt/spike-trades/backups/postgres/
#   3. Integrity check (calls integrity_check.py inside council container)
#
# Backup retention: 30 days (older files auto-deleted).
# Integrity failures: written to log, exit code non-zero so any monitoring
# tool can pick it up.
#
# Manual usage (anytime):
#   /opt/spike-trades/scripts/spike_trades_daily_backup.sh
#
# Cron entry (added to root crontab on production server):
#   0 7 * * * /opt/spike-trades/scripts/spike_trades_daily_backup.sh \
#     >> /var/log/spike-trades-backup.log 2>&1
#   (07:00 UTC = 04:00 ADT in DST = 03:00 ADT in standard time, close enough)
# ============================================================================

set -euo pipefail

# Configuration
BACKUP_ROOT="/opt/spike-trades/backups"
SQLITE_BACKUP_DIR="$BACKUP_ROOT/council"
POSTGRES_BACKUP_DIR="$BACKUP_ROOT/postgres"
RETENTION_DAYS=30
TODAY=$(date -u +%Y%m%d)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EXIT_CODE=0

mkdir -p "$SQLITE_BACKUP_DIR" "$POSTGRES_BACKUP_DIR"

echo "===================================================================="
echo "[$TIMESTAMP] Spike Trades daily backup + integrity check"
echo "===================================================================="

# ----------------------------------------------------------------------------
# Job 1: SQLite council DB backup
# ----------------------------------------------------------------------------
echo
echo "[Job 1: SQLite council DB backup]"
SQLITE_BACKUP_FILE="$SQLITE_BACKUP_DIR/council_${TODAY}.db"

# Use SQLite's .backup command via docker exec (consistent online backup,
# safer than a raw file copy because it handles WAL/active connections)
if docker exec spike-trades-council python3 -c "
import sqlite3
src = sqlite3.connect('/app/data/spike_trades_council.db')
dst = sqlite3.connect('/tmp/council_backup.db')
src.backup(dst)
src.close()
dst.close()
"; then
    docker cp spike-trades-council:/tmp/council_backup.db "$SQLITE_BACKUP_FILE"
    docker exec spike-trades-council rm /tmp/council_backup.db
    SIZE=$(du -h "$SQLITE_BACKUP_FILE" | cut -f1)
    echo "  ✓ SQLite backup: $SQLITE_BACKUP_FILE ($SIZE)"
else
    echo "  ✗ SQLite backup FAILED"
    EXIT_CODE=1
fi

# ----------------------------------------------------------------------------
# Job 2: Postgres pg_dump
# ----------------------------------------------------------------------------
echo
echo "[Job 2: Postgres pg_dump]"
POSTGRES_BACKUP_FILE="$POSTGRES_BACKUP_DIR/postgres_${TODAY}.sql.gz"

if docker exec spike-trades-db pg_dump -U spiketrades -d spiketrades --format=plain --no-owner --no-acl 2>/dev/null | gzip > "$POSTGRES_BACKUP_FILE"; then
    SIZE=$(du -h "$POSTGRES_BACKUP_FILE" | cut -f1)
    if [ -s "$POSTGRES_BACKUP_FILE" ]; then
        echo "  ✓ Postgres backup: $POSTGRES_BACKUP_FILE ($SIZE)"
    else
        echo "  ✗ Postgres backup wrote empty file — FAILED"
        rm -f "$POSTGRES_BACKUP_FILE"
        EXIT_CODE=1
    fi
else
    echo "  ✗ Postgres backup FAILED"
    EXIT_CODE=1
fi

# ----------------------------------------------------------------------------
# Job 3: Retention cleanup (older than RETENTION_DAYS)
# ----------------------------------------------------------------------------
echo
echo "[Job 3: Retention cleanup (>$RETENTION_DAYS days)]"
DELETED_SQLITE=$(find "$SQLITE_BACKUP_DIR" -name "council_*.db" -mtime +$RETENTION_DAYS -print -delete | wc -l)
DELETED_POSTGRES=$(find "$POSTGRES_BACKUP_DIR" -name "postgres_*.sql.gz" -mtime +$RETENTION_DAYS -print -delete | wc -l)
echo "  deleted: $DELETED_SQLITE old SQLite backups, $DELETED_POSTGRES old Postgres backups"

# Show current backup inventory
echo
echo "[Current backup inventory]"
echo "  SQLite backups:"
ls -lh "$SQLITE_BACKUP_DIR" 2>/dev/null | tail -n +2 | awk '{print "    "$9" "$5}' | tail -10
echo "  Postgres backups:"
ls -lh "$POSTGRES_BACKUP_DIR" 2>/dev/null | tail -n +2 | awk '{print "    "$9" "$5}' | tail -10

# ----------------------------------------------------------------------------
# Job 4: Integrity check (calls integrity_check.py inside council container)
# ----------------------------------------------------------------------------
echo
echo "[Job 4: Integrity check]"
if docker exec spike-trades-council python3 /app/scripts/integrity_check.py; then
    echo "  ✓ Integrity check PASSED"
else
    echo "  ✗ Integrity check FAILED — see output above"
    EXIT_CODE=2
fi

# ----------------------------------------------------------------------------
# Job 5: Sunday weekly push to vault repo (offsite backup)
# Copies this week's pg_dump + SQLite to spiketrades-vault and pushes to GitHub.
# Only runs on Sundays (day 7). Requires vault repo cloned at VAULT_DIR.
# ----------------------------------------------------------------------------
VAULT_DIR="/opt/spike-trades/spiketrades-vault"
DAY_OF_WEEK=$(date +%u)  # 1=Mon, 7=Sun

if [ "$DAY_OF_WEEK" = "7" ] && [ -d "$VAULT_DIR/.git" ]; then
    echo
    echo "[Job 5: Sunday weekly vault push]"
    VAULT_FULL="$VAULT_DIR/full-backup"
    mkdir -p "$VAULT_FULL"

    # Copy latest backups to vault
    if [ -f "$POSTGRES_BACKUP_FILE" ]; then
        cp "$POSTGRES_BACKUP_FILE" "$VAULT_FULL/weekly-${TODAY}-postgres.sql.gz"
        echo "  ✓ Postgres backup copied to vault"
    fi
    if [ -f "$SQLITE_BACKUP_FILE" ]; then
        cp "$SQLITE_BACKUP_FILE" "$VAULT_FULL/weekly-${TODAY}-council.db"
        echo "  ✓ SQLite backup copied to vault"
    fi

    # Push to GitHub
    cd "$VAULT_DIR"
    git add -A
    if git diff --cached --quiet; then
        echo "  — No changes to push"
    else
        if git commit -m "weekly: full backup ${TODAY}" && git push origin main; then
            echo "  ✓ Weekly backup pushed to vault repo"
        else
            echo "  ✗ Vault push FAILED (local copies preserved)"
        fi
    fi
elif [ "$DAY_OF_WEEK" = "7" ]; then
    echo
    echo "[Job 5: Sunday weekly vault push — SKIPPED (vault repo not found at $VAULT_DIR)]"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo
echo "===================================================================="
if [ $EXIT_CODE -eq 0 ]; then
    echo "[$TIMESTAMP] DAILY BACKUP COMPLETE — all jobs OK"
elif [ $EXIT_CODE -eq 1 ]; then
    echo "[$TIMESTAMP] DAILY BACKUP COMPLETED WITH BACKUP FAILURE — exit $EXIT_CODE"
else
    echo "[$TIMESTAMP] DAILY BACKUP COMPLETED WITH INTEGRITY FAILURE — exit $EXIT_CODE"
fi
echo "===================================================================="

exit $EXIT_CODE
