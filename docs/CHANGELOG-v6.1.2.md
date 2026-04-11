# Changelog — v6.1.2

**Release Date:** 2026-04-11
**Deployed:** Production (147.182.150.30)
**Tag:** `v6.1.2`
**Commits:** 15 (436df0e → 33e2c59)
**Files Changed:** 21 (+1,672 / -1,741 lines)

---

## Summary

v6.1.2 is a major internal release focused on three pillars: code amalgamation (eliminating ~600 lines of duplication in the scan pipeline), dual-scan data integrity (separating MORNING and EVENING data across all systems), and offsite disaster recovery (vault snapshots pushed to GitHub after every scan). It also includes a post-deployment audit that caught and resolved 8 additional issues.

---

## Features

### Code Amalgamation (`19f152e`)
- **Extracted 5 shared helpers** from 3 duplicated scan functions in `analyzer.ts`:
  - `callCouncilBrain()` — unified council HTTP call (cached or live)
  - `writeScanArchive()` — write immutable archive row (Morning or Evening)
  - `buildSpikeData()` — map 50+ fields from council output to Prisma Spike model, including all Hit Rate 2.0 fields
  - `saveScanReport()` — upsert DailyReport + Spikes + CouncilLog with composite keys
  - `sendScanEmail()` — dispatch email with degraded-run gate (morning) or preview (evening)
- **Rewrote `runEveningScan()` and `runMorningScan()`** as thin wrappers calling the shared helpers
- **Deleted `runDailyAnalysis()`** — 376 lines of legacy code, fully replaced by `runMorningScan()`
- **Net reduction:** 463 lines (37%), from 1,261 to 798 lines

### Weekend Evening Scan (`891af8b`)
- Evening cron changed from Mon-Fri (`0 20 * * 1-5`) to Sun-Thu (`0 20 * * 0-4`)
- Sunday's 8 PM scan produces Monday's Tomorrow's Spikes using Friday EOD data + weekend news
- New `isEveningScanDay()` guard replaces `isTradingDay()` in evening route — correctly allows Sunday scans
- Friday and Saturday evenings correctly skipped

### Scan-Type Separation (schema, accuracy, admin, analytics, Python)

**Schema** (`436df0e`):
- Added `scanType String @default("MORNING")` to `CouncilLog`, `AccuracyRecord`, `MarketRegime`
- Widened unique constraints to include scanType: `@@unique([date, scanType])`, `@@unique([date, horizon, scanType])`
- Added `@@index([scanType])` to `CouncilLog` and `MarketRegime` for query performance (`68ea29a`)

**Accuracy System** (`9a74d92`):
- `/api/accuracy` accepts `scanType` query parameter (default MORNING)
- `/api/accuracy/check` runs backfill loop separately for MORNING and EVENING scan types
- `AccuracyRecord` upserts use new composite key `date_horizon_scanType`
- Spike detail route (`/api/spikes/[id]`) uses composite key for CouncilLog lookup

**Admin Panel** (`04677f6`, `9deea71`, `68ea29a`):
- Recent Reports table shows colored badges: cyan "Today's" (MORNING) / amber "Tomorrow's" (EVENING)
- Analytics tab has Morning/Evening toggle — all metrics filtered by scan type
- XLSX export includes active scanType in download URL
- API responses include `scanType` field

**Accuracy Page** (`a420b06`):
- Morning/Evening tab toggle above accuracy scorecards
- Data re-fetches on tab change
- Each scan type's accuracy tracked independently

**Python SQLite** (`8a8e84b`, `d17197a`, `68ea29a`, `33e2c59`):
- `scan_type` column added to `pick_history` and `accuracy_records` tables (safe ALTER TABLE migration + updated CREATE TABLE DDL)
- `record_picks()` stores scan_type from trigger parameter
- Evening scans store `run_date` as the TARGET trading day (tomorrow), matching Postgres `DailyReport.date`
- `get_ticker_accuracy()` accepts optional `scan_type` filter
- `get_historical_edge_multiplier()` passes `scan_type` through
- `get_stage_analytics()` — all 15+ SQLite queries filter by `scan_type` when provided
- `backfill_actuals()` scoped by `scan_type` when called from `run_council()`
- `noise_filter()` uses scan-type-specific accuracy data (prevents cross-contamination between morning and evening noise filtering)
- Trigger parameter flows from `api_server.py` → `run_council()` → `record_picks()`

### Data Vault (`0062ba7`, `0933298`)
- **`writeVaultSnapshot()`** — post-scan helper that writes compressed JSON snapshots to `/opt/spike-trades/spiketrades-vault/` and pushes to GitHub
  - Contains: archive row, DailyReport, all Spike rows, CouncilLog, accuracy delta, portfolio delta
  - Compressed with gzip (~50-100KB per snapshot)
  - Fire-and-forget: vault failures never affect scan success
  - Gracefully skips in dev (no vault directory)
- **`scripts/restore.ts`** — CLI disaster recovery tool
  - Accepts individual `.json.gz` files or directories
  - Upserts DailyReport + Spikes + CouncilLog using composite keys
  - Processes directories in sorted order for batch recovery
- **Sunday weekly backup** — Job 5 added to `spike_trades_daily_backup.sh`
  - Copies pg_dump + SQLite to vault repo on Sundays
  - Pushes to GitHub for offsite full backup
  - Gracefully skips if vault repo not cloned

---

## Bug Fixes

| Commit | Fix |
|--------|-----|
| `68ea29a` | Python `daily_rows` query: missing `st_params` binding caused crash when analytics filtered by scan type |
| `68ea29a` | XLSX export link: hardcoded without `scanType`, always exported MORNING data |
| `68ea29a` | Portfolio CSV import: spike lookup had no `scanType` filter, could link positions to EVENING picks after 8 PM |
| `68ea29a` | `backfill_actuals()`: backfilled all scan types on every run instead of scoping to the current scan |
| `68ea29a` | `noise_filter()`: used aggregate accuracy across all scan types, dropping tickers that perform differently morning vs evening |
| `33e2c59` | Evening `run_date` in SQLite: stored the date the scan ran instead of the target trading day, causing analytics to show evening picks under the wrong date and backfill timers to start one day early |

---

## Code Cleanup

| Commit | Change |
|--------|--------|
| `68ea29a` | Deleted `src/lib/council/claude-council.ts` — 619 lines of pre-Python legacy dead code. Contained `councilLog.create()` without `scanType` that would crash on the new composite key if ever called. Never imported anywhere. |
| `d17197a` | Python CREATE TABLE DDL: added `scan_type` column to `pick_history` and `accuracy_records` definitions (was only in ALTER TABLE migration path). Updated `accuracy_records` UNIQUE constraint to include `scan_type`. |

---

## Ops (Machine B)

| Action | Status |
|--------|--------|
| Git pull to production server | Done |
| `prisma db push` (schema changes + indexes) | Done |
| Docker rebuild (app, cron, council containers) | Done |
| All 6 containers healthy | Verified |
| Version bump to 6.1.2 in `package.json` | Done |
| Git tag `v6.1.2` | Created and pushed |
| Delete pre-v6 tags (v2.0-pre-responsive, v2.5-session15, v3.5, v4.0, v5.0, v5.0a) | Done — only `v6.1.2` remains |
| Delete stale GitHub branches (12 merged + unmerged) | Done — only `main` remains |
| Close stale GitHub issues/PRs | None were open |
| Create `spiketrades-vault` private repo | Done (https://github.com/Steve25Vibe/spiketrades-vault) |
| Generate deploy key on server | Done |
| Clone vault repo to `/opt/spike-trades/spiketrades-vault/` | Done, push verified |
| Server backup (git bundle + pg_dump + council data) | Done, refreshed 3 times during session |

---

## Historical Data Corrections (Production SQLite)

| Date | Fix |
|------|-----|
| 2026-04-09 | 10 evening picks re-tagged: `scan_type` MORNING → EVENING, `run_date` 2026-04-09 → 2026-04-10 (target trading day) |
| 2026-03-20 | 9 duplicate picks from early dev test runs deleted (kept the 10-pick production run) |

---

## Files Changed

| File | Change |
|------|--------|
| `src/lib/scheduling/analyzer.ts` | Major refactor: 5 helpers + 2 wrappers + vault integration |
| `src/lib/scheduling/vault.ts` | **NEW** — writeVaultSnapshot() |
| `scripts/restore.ts` | **NEW** — disaster recovery CLI |
| `canadian_llm_council_brain.py` | scan_type across record_picks, backfill, noise_filter, stage_analytics; evening run_date fix |
| `api_server.py` | Pass trigger to run_council(); scan_type param on /stage-analytics |
| `prisma/schema.prisma` | scanType on 3 models, indexes on 2 |
| `scripts/start-cron.ts` | Evening cron Sun-Thu |
| `scripts/spike_trades_daily_backup.sh` | Sunday vault push (Job 5) |
| `src/app/api/cron/scan-evening/route.ts` | isEveningScanDay guard, v6.1.2 health response |
| `src/app/api/accuracy/route.ts` | scanType filter |
| `src/app/api/accuracy/check/route.ts` | Dual scanType backfill loop |
| `src/app/api/admin/council/route.ts` | scanType in recent reports + council log |
| `src/app/api/admin/analytics/route.ts` | scanType passthrough to Python |
| `src/app/api/spikes/[id]/route.ts` | Composite key for CouncilLog lookup |
| `src/app/api/portfolio/csv/route.ts` | MORNING scanType filter on spike lookup |
| `src/app/accuracy/page.tsx` | Morning/Evening tabs |
| `src/app/admin/page.tsx` | scanType badges, analytics toggle, XLSX export fix |
| `src/lib/utils/index.ts` | isEveningScanDay() |
| `package.json` | Version 6.0.0 → 6.1.2 |
| `src/lib/council/claude-council.ts` | **DELETED** — 619 lines dead code |
