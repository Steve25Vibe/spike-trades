# Machine B — v6.1.2 Ops Tasks (Complete Standalone Prompt)

Paste this ENTIRE document as the first message in a new Claude Code session on a machine with SSH access to the production server. No other context is needed.

---

```
You are completing the v6.1.2 release for Spike Trades — an autonomous AI stock analyst for TSX/TSXV deployed at spiketrades.ca. Machine A (a separate session) has already pushed all code changes to the `main` branch. Your job is the ops side: calibration backtest, vault repo setup, server deploy, schema migration, GitHub cleanup, tagging, and backup.

## Server & Repo Details

- **SSH:** `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
- **App path on server:** `/root/spiketrades.ca/claude-code`
- **GitHub repo:** `Steve25Vibe/spike-trades` (private)
- **GitHub username:** Steve25Vibe
- **Docker containers (6):** db, council, app, cron, nginx, certbot
- **Database:** PostgreSQL 16 (container: spike-trades-db-1, user: spiketrades, db: spiketrades)
- **Python council:** FastAPI at port 8100 inside container spike-trades-council-1
- **Calibration DB:** SQLite at /app/data/ inside council container
- **Current production HEAD before your work:** commit `872cdf4`
- **Schema deploys via:** `prisma db push` (NOT migrations — no _prisma_migrations table exists)

## Operating Rules — MUST FOLLOW

1. **Always commit and push immediately** after editing any file
2. **Never run `DELETE FROM <table>` without a WHERE clause** — refuse and propose a scoped variant
3. **AST timezone** for all user-facing text (UTC stays internal for logs/commits)
4. **No silent data policy changes** — don't change report retention, pick counts, or pruning without explicit user approval
5. Schema deploys via `prisma db push`, NOT migrations

## Task List (execute in this order)

### Task 1: Trigger Calibration Backtest (START IMMEDIATELY)

This is independent of Machine A's code. The calibration engine exists in the Python council brain and needs its first-ever full run to populate the `calibration_base_rates` SQLite table (currently only 11/83 tickers have data).

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30

# Trigger the backtest
docker exec spike-trades-council-1 curl -X POST http://localhost:8100/calibration-refresh

# Monitor progress (runs ~10-20 minutes, 250 tickers x 252 days)
docker logs -f spike-trades-council-1 2>&1 | grep -i "calib\|backtest\|ticker"
```

**What it does:** Fetches 1 year of historical OHLCV data for the top 250 liquid TSX tickers, computes technicals (RSI, MACD, ADX, volume buckets), classifies market regimes, and builds base rates for each bucket x regime x horizon (3/5/8 days).

**Verification:** When complete, the logs should show something like:
```
Backtest complete: 250 tickers processed, ~X data points, Y base rate buckets
```

**You can proceed with Tasks 2-3 while this runs.**

---

### Task 2: Create spiketrades-vault GitHub Repo + Deploy Key

Create a private GitHub repo for offsite backup, then set up SSH deploy key access from the production server.

**Step 2a: Create the repo (from your LOCAL machine):**
```bash
gh repo create spiketrades-vault --private --description "Spike Trades data vault — automated post-scan backups"
```

**Step 2b: Set up deploy key on the SERVER:**
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30

# Generate deploy key (no passphrase)
ssh-keygen -t ed25519 -f /root/.ssh/vault_deploy_key -N "" -C "spiketrades-vault-deploy"

# Display the public key — you'll need to add it to GitHub
cat /root/.ssh/vault_deploy_key.pub
```

**Step 2c: Add deploy key to GitHub (from LOCAL):**
```bash
# Copy the public key from Step 2b, then:
gh repo deploy-key add /path/to/copied/key.pub -R Steve25Vibe/spiketrades-vault -w --title "Production server deploy key"
```

Or add it manually at: https://github.com/Steve25Vibe/spiketrades-vault/settings/keys
- Paste the public key
- Check "Allow write access"

**Step 2d: Configure SSH and clone (on SERVER):**
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30

# Configure SSH to use the deploy key for vault operations
cat >> /root/.ssh/config << 'SSHEOF'

Host github-vault
  HostName github.com
  User git
  IdentityFile /root/.ssh/vault_deploy_key
  IdentitiesOnly yes
SSHEOF

# Clone vault repo
cd /opt/spike-trades
git clone git@github-vault:Steve25Vibe/spiketrades-vault.git

# Create directory structure
cd spiketrades-vault
mkdir -p vault full-backup scripts
cat > README.md << 'EOF'
# Spike Trades Data Vault

Automated post-scan backups for Spike Trades (spiketrades.ca).

## Structure
- `vault/` — Per-scan JSON snapshots (compressed), organized by date
- `full-backup/` — Weekly full PostgreSQL dumps + SQLite calibration DB
- `scripts/` — Restore utilities

## Restore
See main repo `scripts/restore.ts` for restore instructions.
EOF

git add .
git commit -m "init: vault repo structure"
git push
```

**Verification:** `ls /opt/spike-trades/spiketrades-vault/` should show vault/, full-backup/, scripts/, README.md.

---

### Task 3: Pull Machine A's Changes

Machine A pushed code changes to main covering: code amalgamation, weekend scan schedule, scan-type separation (schema + accuracy + admin + Python), and data vault integration.

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30
cd /root/spiketrades.ca/claude-code
git pull origin main
```

**Verify:** The pull should bring in multiple commits. Check with:
```bash
git log --oneline -10
```

You should see commits for schema changes, amalgamation refactor, weekend schedule, accuracy fixes, admin panel badges, Python scan_type, vault snapshot, and restore script.

---

### Task 4: Apply Schema Changes (prisma db push)

Machine A added `scanType` fields to CouncilLog, AccuracyRecord, and MarketRegime tables, and updated their unique constraints. These need to be applied to the production database.

```bash
# Run from inside the app container (which has Prisma)
docker exec -it spike-trades-app-1 npx prisma db push
```

**What this does:**
- Adds `scanType String @default("MORNING")` column to CouncilLog, AccuracyRecord, MarketRegime
- Updates unique constraints from `@@unique([date])` to `@@unique([date, scanType])` (and `@@unique([date, horizon, scanType])` for AccuracyRecord)
- Existing rows get default value "MORNING" — no data loss

**Expected output:** Should complete without errors. May show warnings about potential data loss — that's safe here because we're adding columns with defaults and widening constraints.

**Verification:**
```bash
docker exec spike-trades-db-1 psql -U spiketrades spiketrades -c "\d \"CouncilLog\"" | grep scanType
docker exec spike-trades-db-1 psql -U spiketrades spiketrades -c "\d \"AccuracyRecord\"" | grep scanType
docker exec spike-trades-db-1 psql -U spiketrades spiketrades -c "\d \"MarketRegime\"" | grep scanType
```

Each should show a `scanType` column with default 'MORNING'.

---

### Task 5: Rebuild Containers

```bash
cd /root/spiketrades.ca/claude-code
docker compose build --no-cache
docker compose up -d
```

**Wait 30 seconds, then verify:**
```bash
docker compose ps
```

**Expected:** All 6 containers (db, council, app, cron, nginx, certbot) show "Up" and "healthy".

**Additional checks:**
```bash
# App responds
curl -s https://spiketrades.ca/api/health | head -c 200

# Council API responds
docker exec spike-trades-council-1 curl -s http://localhost:8100/health | head -c 200
```

---

### Task 6: Update Backup Script for Weekly Vault Push

Edit the existing daily backup script to add Sunday-only vault pushes.

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30
```

Find and read the backup script:
```bash
cat /opt/spike-trades/scripts/spike_trades_daily_backup.sh
```

Add the following block **before the final `exit 0`** or at the end of the script:

```bash
# ---- Weekly full backup to vault repo (Sundays only) ----
if [ "$(date +%u)" = "7" ]; then
  VAULT_DIR="/opt/spike-trades/spiketrades-vault"
  WEEK_DATE=$(date +%F)

  echo "[Backup] Sunday — pushing weekly full backup to vault repo..."

  # Copy today's backup files to vault
  PG_FILE="${BACKUP_DIR}/postgres/postgres_$(date +%Y%m%d).sql.gz"
  COUNCIL_FILE="${BACKUP_DIR}/council/council_$(date +%Y%m%d).db"

  if [ -f "$PG_FILE" ]; then
    cp "$PG_FILE" "$VAULT_DIR/full-backup/weekly-${WEEK_DATE}-postgres.sql.gz"
  fi

  if [ -f "$COUNCIL_FILE" ]; then
    cp "$COUNCIL_FILE" "$VAULT_DIR/full-backup/weekly-${WEEK_DATE}-council.db"
  fi

  # Git commit and push
  cd "$VAULT_DIR"
  git add full-backup/
  git commit -m "weekly: full backup ${WEEK_DATE}" 2>/dev/null && git push 2>/dev/null
  if [ $? -eq 0 ]; then
    echo "[Backup] Weekly vault push complete"
  else
    echo "[Backup] Weekly vault push failed (local copies preserved)"
  fi
fi
```

**IMPORTANT:** Make sure `BACKUP_DIR` matches the variable name used elsewhere in the script. Read the existing script first to confirm.

---

### Task 7: Version Bump + Git Tag

```bash
cd /root/spiketrades.ca/claude-code

# Verify current version
grep '"version"' package.json
# Should show "6.0.0"

# Update version
sed -i 's/"version": "6.0.0"/"version": "6.1.2"/' package.json

# Verify change
grep '"version"' package.json
# Should show "6.1.2"

# Commit and push
git add package.json
git commit -m "$(cat <<'COMMITEOF'
chore: bump version to 6.1.2

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
COMMITEOF
)"
git push origin main

# Create and push tag
git tag v6.1.2
git push origin v6.1.2
```

**Verification:**
```bash
git tag -l
# Should include v6.1.2
```

---

### Task 8: Delete Pre-v6 Git Tags

Remove old tags that no longer represent meaningful releases:

```bash
cd /root/spiketrades.ca/claude-code

# Delete from remote
git push origin --delete v2.0-pre-responsive v2.5-session15 v3.5 v4.0 v5.0 v5.0a

# Delete locally
git tag -d v2.0-pre-responsive v2.5-session15 v3.5 v4.0 v5.0 v5.0a
```

**Verification:**
```bash
git tag -l
# Should show only v6.1.2
```

---

### Task 9: GitHub Cleanup — Delete Merged Branches

These 10 branches have been merged to main and should be deleted:

```bash
# Delete merged remote branches
git push origin --delete \
  docs/session-handoff-2026-04-08 \
  feat/v6.1-hit-rate-2.0-pr1 \
  feat/v6.1-hit-rate-2.0-pr2 \
  feat/v6.1-hit-rate-2.0-pr3 \
  feat/v6.1-hit-rate-2.0-pr4 \
  feat/v6.1.0-phase2-min-viewer \
  feature/opening-bell \
  fix/le-admin-tab-stub \
  fix/learning-engine-bypass \
  hotfix/eodhd-institutional-swap
```

Then review remaining unmerged branches and close any stale PRs/issues:

```bash
# List remaining branches
git branch -r | grep -v "main\|HEAD"

# List open issues (if any)
gh issue list --state open

# List open PRs (if any)
gh pr list --state open
```

For any stale issues or PRs, close them:
```bash
# gh issue close <number> -c "Resolved in v6.1.2"
# gh pr close <number> -c "Superseded by v6.1.2 work"
```

---

### Task 10: Local Backup

Create a complete backup on the LOCAL machine (your computer, not the server):

```bash
mkdir -p ~/spiketrades-backup/2026-04-10
cd ~/spiketrades-backup/2026-04-10

# 1. Git bundle (full repo with all branches, tags, history)
cd /path/to/local/spiketrades/repo  # wherever you have the repo cloned
git pull origin main
git bundle create ~/spiketrades-backup/2026-04-10/spiketrades-repo.bundle --all

# 2. PostgreSQL dump (via SSH)
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "docker exec spike-trades-db-1 pg_dump -U spiketrades spiketrades" \
  > ~/spiketrades-backup/2026-04-10/spiketrades-db.sql

# 3. Council data (SQLite + any other state)
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "docker exec spike-trades-council-1 cat /app/data/spike_trades_council.db" \
  > ~/spiketrades-backup/2026-04-10/council.db

# Verify all files exist and have content
ls -la ~/spiketrades-backup/2026-04-10/
```

**Expected:** 3 files, all non-empty:
- `spiketrades-repo.bundle` (~10-50MB)
- `spiketrades-db.sql` (~1-5MB)
- `council.db` (~1-10MB)

---

### Task 11: Verify Calibration Backtest Completed

By now, Task 1 should have finished (~10-20 min). Verify:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30

# Check council logs for completion
docker logs spike-trades-council-1 2>&1 | grep -i "backtest complete\|base_rate_buckets\|tickers_processed" | tail -5

# Verify base rates table has data
docker exec spike-trades-council-1 python3 -c "
import sqlite3
conn = sqlite3.connect('/app/data/spike_trades_council.db')
count = conn.execute('SELECT COUNT(*) FROM calibration_base_rates').fetchone()[0]
print(f'calibration_base_rates rows: {count}')
conn.close()
"
```

**Expected:** Row count should be several hundred to several thousand (depending on how many bucket combinations have sufficient samples).

---

### Task 12: Final Verification Checklist

Run through this checklist and report results:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30

echo "=== 1. Container Health ==="
docker compose -f /root/spiketrades.ca/claude-code/docker-compose.yml ps

echo "=== 2. App responds ==="
curl -s -o /dev/null -w "%{http_code}" https://spiketrades.ca/dashboard

echo "=== 3. Schema changes applied ==="
docker exec spike-trades-db-1 psql -U spiketrades spiketrades -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'CouncilLog' AND column_name = 'scanType';"

echo "=== 4. Git tag ==="
cd /root/spiketrades.ca/claude-code && git tag -l

echo "=== 5. Vault repo ==="
ls /opt/spike-trades/spiketrades-vault/

echo "=== 6. Calibration data ==="
docker exec spike-trades-council-1 python3 -c "
import sqlite3
conn = sqlite3.connect('/app/data/spike_trades_council.db')
count = conn.execute('SELECT COUNT(*) FROM calibration_base_rates').fetchone()[0]
print(f'Base rate rows: {count}')
conn.close()
"

echo "=== 7. Backup script updated ==="
grep -c "Weekly full backup to vault" /opt/spike-trades/scripts/spike_trades_daily_backup.sh
```

**All checks should pass.** Report any failures.

## Summary of What You're Delivering

| # | Task | Independence | ~Time |
|---|------|-------------|-------|
| 1 | Calibration backtest | Start immediately | 10-20 min (background) |
| 2 | Vault repo + deploy key | Start immediately | 5-10 min |
| 3 | Pull Machine A changes | After Machine A pushes | 1 min |
| 4 | Schema migration (prisma db push) | After pull | 2 min |
| 5 | Rebuild containers | After schema | 5-10 min |
| 6 | Backup script update | After rebuild | 5 min |
| 7 | Version bump + tag | After rebuild | 2 min |
| 8 | Delete old tags | After tag | 1 min |
| 9 | GitHub cleanup (branches, issues, PRs) | After tag | 5 min |
| 10 | Local backup | After tag | 5-10 min |
| 11 | Verify calibration | After Task 1 completes | 2 min |
| 12 | Final verification | Last | 5 min |

**Total estimated time: 45-60 minutes** (Tasks 1 and 2 run in parallel while waiting for Machine A).
```
