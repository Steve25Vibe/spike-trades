# Session 10 — v5.0 Post-Launch Repairs & Quality Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair contaminated production data and implement quality improvements across all three pipelines (Radar, Opening Bell, Today's Spikes) plus FMP infrastructure.

**Architecture:** Phase 1 repairs existing bad data in PostgreSQL and council SQLite. Phase 2 builds a shared FMP bulk cache that Phases 3-5 depend on. Phases 3-5 improve each pipeline independently.

**Tech Stack:** Python (council brain, scanners, api_server), TypeScript/Next.js (app), PostgreSQL, SQLite, FMP stable API (CSV bulk endpoints)

---

## Context

Session 9 was the first v5.0 production run (2026-04-06). All three pipelines ran successfully but exposed significant data quality, FMP API, and scoring issues. This session addresses all findings from the production audit.

## Server Details
- **Server:** `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
- **Deploy path:** `/opt/spike-trades`
- **FMP API Key:** Available in `.env` as `FMP_API_KEY`

## ⚠️⚠️⚠️ PHASE 1 IS DEPRECATED — DO NOT RUN ANY SQL IN THIS PHASE ⚠️⚠️⚠️

**Updated 2026-04-07 (Session 13 + post-mortem):** Every SQL block in Phase 1 below is destructive and unscoped against current production data. Running any of these statements today will delete legitimate user-facing data, including reports the user has received emails for and is actively reviewing.

**Confirmed casualties from Phase 1 execution on Apr 6:**
- Section 1.1 deleted the entire Apr 6 Opening Bell report and all 10 picks (the user has the email PDF; the data is gone from Postgres). Restoration in progress.
- Section 1.5 deleted the entire `accuracy_records` SQLite table (~510 rows of Today's Spikes training data). Restored Apr 7 from Prisma Spike.actual3Day/5Day/8Day fields via `scripts/recover_accuracy_records.py` (recovered 198/270 resolved samples).

**Sections 1.2, 1.3, 1.4 are similarly destructive and unscoped.** They use `CURRENT_DATE` or unbounded ticker lists with no WHERE-clause guards. Do not run them.

**If you need to clean future bad data:**
- Always scope DELETEs by explicit `id IN (...)` or `WHERE created_at BETWEEN ...`
- Run a `SELECT COUNT(*)` of the same WHERE clause first
- Wrap in `BEGIN; ... ROLLBACK;` first to dry-run
- Get explicit user approval before any production DELETE

This file is preserved as a post-mortem reference, not as runnable instructions.

---

## Phase 1: Data Repair (Do First — Users See Bad Data Now)

### 1.1 Delete Today's Opening Bell (Ghost Tickers)

> ⚠️ **DEPRECATED — DO NOT RUN (Session 13, 2026-04-07)**
> The SQL below uses `CURRENT_DATE` with no further scoping and has cascade-delete on
> the report → picks relationship. Running this on a date when a legitimate Opening
> Bell run has already completed (which it will every weekday at 10:35 AM AST) will
> destroy that day's report and all its picks. **This is exactly what happened to the
> Apr 6 Opening Bell report (#1 NGD.TO +3.3%, 10 picks total).**

All 10 picks are phantom tickers not purchasable on TSX. Delete the entire report.

```sql
-- ⚠️ DEPRECATED — DO NOT RUN. Caused Apr 6 OB data loss.
-- Delete picks first (FK constraint), then report
-- DELETE FROM "OpeningBellPick" WHERE "reportId" IN (
--   SELECT id FROM "OpeningBellReport" WHERE date = CURRENT_DATE
-- );
-- DELETE FROM "OpeningBellReport" WHERE date = CURRENT_DATE;
```

Verify: `SELECT COUNT(*) FROM "OpeningBellPick"` should return 0. `SELECT COUNT(*) FROM "OpeningBellReport"` should return 0.

### 1.2 Trim Today's Radar to Top 10

> ⚠️ **DEPRECATED — DO NOT RUN (Session 13, 2026-04-07)**
> Same `CURRENT_DATE` scoping bug as 1.1. Running this on any future date silently
> trims that day's legitimate Radar report. The v5 over-generation bug it was
> meant to address has been fixed at the generation layer.

15 picks exist, should be 10. Delete ranks 11-15 (by smartMoneyScore), update report.

```sql
-- ⚠️ DEPRECATED — DO NOT RUN. Unscoped CURRENT_DATE delete.
-- Delete the bottom 5 by score
-- DELETE FROM "RadarPick" WHERE id IN (
--   SELECT id FROM "RadarPick"
--   WHERE "reportId" IN (SELECT id FROM "RadarReport" WHERE date::date = CURRENT_DATE)
--   ORDER BY "smartMoneyScore" ASC
--   LIMIT 5
-- );
--
-- Re-rank remaining 10 by smartMoneyScore descending
-- WITH ranked AS (
--   SELECT id, ROW_NUMBER() OVER (ORDER BY "smartMoneyScore" DESC) as new_rank
--   FROM "RadarPick"
--   WHERE "reportId" IN (SELECT id FROM "RadarReport" WHERE date::date = CURRENT_DATE)
-- )
-- UPDATE "RadarPick" p SET rank = r.new_rank
-- FROM ranked r WHERE p.id = r.id;
--
-- Update report count
-- UPDATE "RadarReport" SET "tickersFlagged" = 10
-- WHERE date::date = CURRENT_DATE;
```

Verify: `SELECT rank, ticker, "smartMoneyScore" FROM "RadarPick" ORDER BY rank` — should show 10 rows, rank 1-10, scores descending.

Then regenerate the override file:
```bash
docker exec spike-trades-app sh -c 'cat > /tmp/radar_opening_bell_overrides.json << EOF
{"date":"2026-04-06","tickers":["SU.TO","OVV.TO","EMA.TO","IMO.TO","NPI.TO","FTS.TO","BEP-UN.TO","DOO.TO","GFL.TO","SCR.TO"],"smart_money_scores":{"SU.TO":72,"OVV.TO":65,"EMA.TO":62,"IMO.TO":58,"NPI.TO":58,"FTS.TO":55,"BEP-UN.TO":54,"DOO.TO":54,"GFL.TO":54,"SCR.TO":54}}
EOF'
```

### 1.3 Clean ETF + Ghost Picks from Spikes Archive

> ⚠️ **DEPRECATED — DO NOT RUN (Session 13, 2026-04-07)**
> This unscoped DELETE removes ETF picks across **all dates** in the Spike table.
> The ETF generation bug has been fixed at source by Phase 5.2 (ETF Filter for
> Spikes), so newer reports do not contain these tickers. Running this retroactively
> rewrites historical reports, breaking accuracy backfill (predictions vs actuals
> are anchored to specific tickers on specific dates) and producing the inconsistent
> short-count rows seen in Session 13's Daily Accuracy Trend (e.g., 2026-03-25
> showing 6 picks instead of 10).

14 ETFs + 1 ghost (BITF.TO) across 8 dates. Also 6 PortfolioEntry records reference ETF spikes.

Bad tickers: `HND.TO, HNU.TO, HOD.TO, HOU.TO, NRGU.TO, VDY.TO, VGRO.TO, VIU.TO, XEG.TO, XGD.TO, XIU.TO, ZEB.TO, ZSP.TO, BITF.TO`

```sql
-- ⚠️ DEPRECATED — DO NOT RUN. Unscoped historical rewrite.
-- Step 1: Delete portfolio entries referencing bad spikes
-- DELETE FROM "PortfolioEntry" WHERE "spikeId" IN (
--   SELECT id FROM "Spike" WHERE ticker IN (
--     'HND.TO','HNU.TO','HOD.TO','HOU.TO','NRGU.TO','VDY.TO','VGRO.TO',
--     'VIU.TO','XEG.TO','XGD.TO','XIU.TO','ZEB.TO','ZSP.TO','BITF.TO'
--   )
-- );
--
-- Step 2: Delete bad spike picks
-- DELETE FROM "Spike" WHERE ticker IN (
--   'HND.TO','HNU.TO','HOD.TO','HOU.TO','NRGU.TO','VDY.TO','VGRO.TO',
--   'VIU.TO','XEG.TO','XGD.TO','XIU.TO','ZEB.TO','ZSP.TO','BITF.TO'
-- );
--
-- Step 3: Re-rank all affected reports
-- For each report, re-rank remaining picks by spikeScore descending
```

After deleting, re-rank each affected date's picks sequentially by spikeScore.

### 1.4 Trim Mar 24 and Mar 25 from 20 to Top 10

> ⚠️ **DEPRECATED — DO NOT RUN (Session 13, 2026-04-07)**
> Combined with the 1.3 ETF cleanup, this is what produced the asymmetric historical
> short-counts (Mar 25 = 6 picks, Mar 30 = 7 picks, etc.) discovered in Session 13.
> The pre-v5 over-generation bug is fixed at source. Historical short-counts are
> now permanent and accepted (per user decision in Session 13). Do not retroactively
> trim more dates.

These two dates had 20 picks (pre-v5 bug). Keep top 10 by spikeScore, delete the rest.

```sql
-- ⚠️ DEPRECATED — DO NOT RUN. Historical rewrite, source bug already fixed.
-- For each date, delete picks ranked below top 10 by spikeScore
-- DELETE FROM "Spike" WHERE id IN (
--   SELECT id FROM (
--     SELECT id, ROW_NUMBER() OVER (PARTITION BY "reportId" ORDER BY "spikeScore" DESC) as rn
--     FROM "Spike"
--     WHERE "reportId" IN (
--       SELECT id FROM "DailyReport" WHERE date IN ('2026-03-24', '2026-03-25')
--     )
--   ) sub WHERE rn > 10
-- );
```

Also check Mar 19, 20, 23 which had 20 picks each — same treatment.

### 1.5 Purge Council SQLite Learning DB

> ⚠️ **DEPRECATED — DO NOT RUN (Session 13, 2026-04-07)**
> This entire script is destructive. The unconditional `DELETE FROM accuracy_records`
> at the bottom wiped 510+ rows of training data and broke every learning gate
> until restored. The ETF cleanup against `pick_history` and `stage_scores` also
> contaminated the historical training set in ways that took Session 13 to untangle.
> The ETF generation bug is fixed at source — there is no need to clean historically.

The council's internal SQLite has contaminated learning data from ETF/ghost picks.

```python
# ⚠️ DEPRECATED — DO NOT RUN. Wipes training data, breaks learning gates.
# import sqlite3
# conn = sqlite3.connect('/app/data/spike_trades_council.db')
# cur = conn.cursor()
#
# bad = ('HND.TO','HNU.TO','HOD.TO','HOU.TO','NRGU.TO','VDY.TO','VGRO.TO',
#        'VIU.TO','XEG.TO','XGD.TO','XIU.TO','ZEB.TO','ZSP.TO','BITF.TO')
#
# # Delete bad records
# cur.execute(f"DELETE FROM pick_history WHERE ticker IN ({','.join('?' * len(bad))})", bad)
# cur.execute(f"DELETE FROM stage_scores WHERE ticker IN ({','.join('?' * len(bad))})", bad)

# # Reset calibration tables (will rebuild from clean data on next run)
# cur.execute("DELETE FROM calibration_base_rates")
# cur.execute("DELETE FROM calibration_council")
#
# # ⚠️ DEPRECATED — DO NOT RUN (Session 13, 2026-04-07)
# # The line below was unconditional and destroyed the entire accuracy_records
# # table (>510 rows). This wiped all Today's Spikes learning training data,
# # which caused every learning gate (conviction, stage weights, prompt context,
# # factor feedback, pre-filter) to revert to hardcoded defaults and broke the
# # Admin Analytics 3/5/8-day hit rate tables. Session 13 recovered the data
# # from the Prisma Spike table's actual3Day/5Day/8Day columns. Never run a bare
# # DELETE on accuracy_records again — if you need to prune, use a WHERE clause
# # keyed on pick_id or run_date.
# #
# # cur.execute("DELETE FROM accuracy_records")  # ← DO NOT UNCOMMENT
#
# conn.commit()
# conn.close()
```

Verify: `SELECT COUNT(*) FROM pick_history WHERE ticker IN (...)` should return 0.

### 1.6 Verification
After all repairs:
- Check every DailyReport date has exactly 10 picks
- Check no ETF tickers remain in any table
- Check Radar has exactly 10 picks
- Check Opening Bell has 0 picks/reports for today
- Check no orphaned PortfolioEntry records exist

---

## Phase 2: FMP Infrastructure (Foundation for Everything Else)

### 2.1 Bulk FMP Profile Cache
Create a shared module that downloads `/stable/profile-bulk?part=0` (CSV) and caches it. All pipelines use this instead of per-ticker `/profile` calls.

**File:** `fmp_bulk_cache.py` (new shared module)

- Download CSV on first call, cache for 4 hours (profiles don't change intraday)
- Parse into dict keyed by symbol
- Expose `get_profile(ticker)` and `get_tsx_whitelist()` methods
- `get_tsx_whitelist()` returns set of .TO tickers where `isActivelyTrading=true` and `isEtf=false`
- Rate limit: endpoint allows one call per 60 seconds

Update all three pipelines to use this cache instead of individual `/profile` calls.

### 2.2 FMP Field Name Normalization
Create a mapping layer that translates stable API field names to consistent internal names.

Key mappings:
- `changePercentage` → `changesPercentage` (or vice versa — pick one and use everywhere)
- `averageVolume` → `avgVolume`
- `companyName` → `name`

Apply in the bulk cache module so downstream code gets consistent field names.

### 2.3 Intraday Chart Path Fix
Already deployed in Session 9 (commit `6c806e9`). Verify it's working:
- `/historical-chart/1min?symbol=X` instead of `/historical-chart/1min/X`
- `/historical-chart/5min?symbol=X` instead of `/historical-chart/5min/X`

### 2.4 Fix Remaining FMP Endpoints
- `/sector-performance-snapshot` — add explicit `date` parameter in all call sites
- `/earnings-surprises` — gone from stable API, check if `/earning-surprise-bulk` works as replacement
- Finnhub news 429s — replace with FMP `/news/stock` (supports `tickers` param for bulk)

---

## Phase 3: Opening Bell Data Quality (5-Layer Fix)

All changes in `opening_bell_scanner.py`.

### 3.1 Layer 1: Validate Against Profile-Bulk Whitelist
In `fetch_tsx_universe()`, after getting stock-list and batch-quote, filter to only tickers that exist in the bulk profile cache whitelist (`isActivelyTrading=true`, `isEtf=false`).

### 3.2 Layer 2: Volume Gate at Ranking
In `compute_rankings()`, require `avgVolume >= 50000` (from bulk cache profile data). Reject tickers below this threshold.

### 3.3 Layer 3: Remove avgVolume=1 Fallback
In `map_to_prisma()`, if `avgVolume` is missing or 0 after enrichment, reject the ticker entirely. Do not compute relative volume with a fallback of 1.

### 3.4 Layer 4: Multi-Signal Requirement
In ranking or post-enrichment, require `changePercentage > 0` PLUS at least one of:
- `relative_volume > 1.5`
- Recent analyst grade (from grades endpoint)
- Recent news article (from FMP `/news/stock`)

### 3.5 Layer 5: News Catalyst Requirement
Fetch news for top 40 movers using FMP `/news/stock?tickers=X,Y,...`. Reject any ticker with zero news articles in the last 48 hours unless it has an analyst grade action.

### 3.6 Quality Threshold Instead of Fixed 10
Return between 3-10 picks based on quality. Set a minimum momentum score threshold (e.g., 50). Return all picks above the threshold, up to 10 max. If fewer than 3 qualify, return empty result rather than padding with weak picks.

### 3.7 Score Badge UI Fix
In `src/components/opening-bell/OpeningBellCard.tsx`:
- Change `rounded-full border-2` to `rounded-xl border`
- Change background opacity from 10% to 15%
- Change border opacity from 40% to 30%
- Move "Score" label outside/below the box
- Match exact styling from RadarCard.tsx / SpikeCard.tsx

---

## Phase 4: Radar Quality (6 Improvements)

All changes in `canadian_llm_council_brain.py` (RadarScanner class).

### 4.1 Prompt: Separate Catalyst from Technicals
Update `RADAR_SYSTEM_PROMPT` to explicitly state: "catalystStrength MUST be 0 if there is no specific, dated event (analyst upgrade/downgrade, earnings surprise, M&A announcement, regulatory decision). Sector trends, macro regime, and commodity prices are NOT catalysts — score those in sectorAlignment only."

### 4.2 Grade Recency
In `_apply_prescore_filter()` and the prompt, only count analyst grades from the last 2 trading days as overnight catalysts. Older grades can be mentioned as context but should not drive catalystStrength scoring.

### 4.3 Catalyst Majority Requirement
After AI scoring, count how many picks have `catalystStrength > 0`. If fewer than 7 have real catalysts, sort catalyst picks first, then technical-only picks. Alternatively: set a minimum of 7 catalyst-driven picks and fill remaining slots (up to 3) with best technical setups.

### 4.4 Sector Concentration Cap
After scoring and ranking, enforce maximum 3 picks per sector. If a sector has 4+, keep top 3 by smartMoneyScore, replace the rest with next-best picks from underrepresented sectors.

### 4.5 Volume Anomaly Signal
For picks without a hard catalyst (catalystStrength = 0), require relative_volume > 1.5x. This is the "smart money flow" signal — unusual volume without news means institutional positioning.

### 4.6 Stabilize Macro Regime
Cache the macro regime determination once per day (first call). Subsequent Radar runs in the same day reuse the cached regime. Store in a simple file or in-memory variable with date check.

### 4.7 Quality Threshold Instead of Fixed Count
Change `top_n` default from 15 to 10 max. Apply a minimum smartMoneyScore threshold (e.g., 45). Return 3-10 picks based on how many meet the bar.

### 4.8 Portfolio Integration
Add "Add to Portfolio" functionality for Radar picks, matching the existing pattern used by Opening Bell and Today's Spikes. Investigate the existing implementation in:
- `src/components/spikes/SpikeCard.tsx` (reference implementation)
- `src/app/api/portfolio/` routes
- `src/components/portfolio/` components

---

## Phase 5: Today's Spikes Pre-Filter

### 5.1 Tighten Candidate Count
In the council pipeline, reduce the number of tickers entering Stage 1 from ~118 to ~80-90. Options:
- Increase the ADV threshold from $5M to $8M
- Strengthen the noise filter threshold
- Add the bulk profile whitelist filter (ETF/inactive removal)
- The ETF/ghost cleanup alone removes ~14 tickers that were contaminating the pipeline

### 5.2 ETF Filter for Spikes
Add `isEtf=false` check using the bulk profile cache. This prevents ETFs from entering the pipeline at all, addressing the 13 ETFs found in archive data.

---

## Phase 6: Post-Deployment Bug Fixes (Session 10 Debugging)

Systematic debugging after Phases 1-5 deployment revealed critical bugs that must be fixed before the next trading day.

### 6.1 Restructure fmp_bulk_cache.py — CSV for whitelist only, JSON for profiles

**Problem:** The bulk cache replaced working per-ticker JSON `/stable/profile` calls with CSV bulk downloads. The JSON per-ticker endpoint works perfectly and returns clean JSON. CSV is only needed for the 2052-ticker whitelist (no JSON batch endpoint works for .TO).

**Changes to `fmp_bulk_cache.py`:**
- `get_tsx_whitelist()` — keep CSV bulk download (parts 0-3), only purpose is ETF/ghost filtering
- `get_profile(ticker)` — change to call `/stable/profile?symbol={ticker}` JSON endpoint, cache per session
- `get_profiles(tickers)` — call per-ticker JSON with concurrency semaphore (like existing `fetch_profiles_batch`)
- Remove `_normalize_profile()` CSV string conversion — JSON returns proper types natively
- Fix asyncio.Lock creation — create lazily inside first async call, not in sync `_get_lock()`
- Add try/except around CSV parsing for whitelist download

**Callers remain unchanged** — `get_profile()`, `get_profiles()`, `get_tsx_whitelist()` keep same signatures.

### 6.2 Fix `changesPercentage` typo in Radar prompt

**Problem:** `canadian_llm_council_brain.py:4672` uses `q.get('changesPercentage', 0)` but FMP `/batch-quote` returns `changePercentage` (no 's'). Verified via live API. Every ticker shows `Change: 0.00%` in the Sonnet prompt — Sonnet cannot assess price momentum.

**Fix:** Change `changesPercentage` → `changePercentage` on line 4672. One character.

### 6.3 Add symbol filter to `fetch_news()` to reject wrong-ticker articles

**Problem:** FMP `/stable/news/stock` has a server-side bug — it ignores the `symbol` parameter and returns AAPL articles for every request (confirmed for MSFT, RY.TO, ZZZZZZ — all return AAPL). This is an FMP bug, not our code. But our `fetch_news()` method in `canadian_llm_council_brain.py` accepts all articles without filtering, so every .TO ticker gets AAPL news in its data.

**Impact on Radar:** Every ticker gets "NEWS: 10 articles in 24h" with AAPL headlines → inflates news_sentiment, breaks catalyst detection (4.3/4.5).

**Impact on Opening Bell:** `fetch_news_bulk()` already filters by symbol (line 145: `if sym in batch`), so it correctly gets empty results — safe failure but news provides zero value.

**Impact on Spikes:** Same as Radar — AAPL articles stored as if they belong to .TO tickers.

**Fix in `fetch_news()` (council brain):** After receiving articles, filter to only those where `article.symbol == ticker` (strip .TO suffix for comparison). This makes Radar and Spikes behave like Opening Bell — empty news until FMP fixes the endpoint.

**Separate action:** File FMP support ticket about `/stable/news/stock` ignoring symbol parameter.

### 6.4 Add empty-movers guard in Opening Bell pipeline

**Problem:** `opening_bell_scanner.py` — after the 3-layer quality filter (line 371) and multi-signal filter (line 403), `movers` can be empty. No guard exists before the Sonnet call at line 406. Wastes API tokens on an empty prompt.

**Fix:** Add early return after multi-signal filter:
```python
if not movers:
    return {"success": False, "error": "No movers pass quality filters", "duration_ms": ...}
```

### 6.5 Fix Radar Lock In modal — remove fake 3/5/8-day targets

**Problem:** Radar picks are pre-market overnight signals. They do not predict 3/5/8-day price targets. But `src/app/radar/page.tsx` reuses the Spikes `LockInModal` which requires `predicted3Day/5Day/8Day` percentage fields. The code passes `priceAtScan * 1.03` (a dollar value ~$94) as a percentage, so the modal computes `$92 * (1 + 94.76/100) = $179.18` as the "3-Day Target" — completely wrong.

**Fix:** Create a `RadarLockInModal` component (or modify LockInModal to support a `mode` prop):
- Shows ticker, price, smartMoneyScore, top catalyst
- Position sizing (auto/fixed/manual) — same as existing
- Stop-loss only (no 3/5/8 day targets) — default 5% below entry
- Does NOT display "3-Day Target", "5-Day Target", "8-Day Target" rows
- Sends `radarPickId` to portfolio API (not `spikeId`)

**Also fix `src/app/api/portfolio/route.ts`:** Radar lock-in section should not set `target3Day` at all (leave null).

### 6.6 Verify all fixes with regression checks

After all fixes:
1. Run Session 9 regression checks (clamping, chart paths, edge multiplier, timeout, field names)
2. Python syntax validation for all 3 Python files
3. TypeScript `tsc --noEmit`
4. No debug artifacts
5. `git diff --stat` shows only relevant files

---

## Deployment Order

1. **Phase 1 (Data Repair)** — run SQL + Python cleanup scripts on server ✅ DONE
2. **Phase 2 (FMP Infrastructure)** — bulk cache module, field normalization ✅ DONE
3. **Phase 3 (Opening Bell)** — 5-layer quality fix + UI ✅ DONE
4. **Phase 4 (Radar)** — 6 quality improvements + portfolio integration ✅ DONE
5. **Phase 5 (Spikes)** — pre-filter tightening + ETF filter ✅ DONE
6. **Phase 6 (Bug Fixes)** — restructure bulk cache, fix Radar prompt, news filter, empty guard, Lock In modal

Phases 3-5 depend on Phase 2 (bulk cache). Phase 1 is independent and should be done first.
Phase 6 fixes bugs found during post-deployment debugging of Phases 2-5.

## Task Tracking

### Phase 1: Data Repair
- [ ] 1.1 Delete today's Opening Bell report + ghost picks
- [ ] 1.2 Trim today's Radar to top 10, re-rank, update override file
- [ ] 1.3 Delete 14 ETF + 1 ghost from Spikes archive, delete 6 PortfolioEntry records
- [ ] 1.4 Trim Mar 19-25 reports from 20 to top 10
- [ ] 1.5 Purge council SQLite learning DB
- [ ] 1.6 Verify all repairs — counts, no orphans, no ETFs
- [ ] 1.7 Commit: "fix: data repair — remove ghost tickers, ETFs, and excess picks from all archives"

### Phase 2: FMP Infrastructure
- [ ] 2.1 Create `fmp_bulk_cache.py` — CSV download, parse, TTL, whitelist methods
- [ ] 2.2 Add field name normalization to bulk cache output
- [ ] 2.3 Verify intraday chart fix still working (Session 9 deploy)
- [ ] 2.4 Fix `/sector-performance-snapshot` date param in all call sites
- [ ] 2.5 Replace `/earnings-surprises` with bulk alternative or remove
- [ ] 2.6 Replace Finnhub news calls with FMP `/news/stock`
- [ ] 2.7 Integrate bulk cache into council brain, Opening Bell scanner, and api_server
- [ ] 2.8 Deploy and verify — all pipelines use bulk cache, no per-ticker profile calls
- [ ] 2.9 Commit: "feat: FMP bulk profile cache and field normalization"

### Phase 3: Opening Bell Data Quality
- [ ] 3.1 Validate against profile-bulk whitelist in fetch_tsx_universe
- [ ] 3.2 Volume gate — min 50K avgVolume in compute_rankings
- [ ] 3.3 Remove avgVolume=1 fallback in map_to_prisma
- [ ] 3.4 Multi-signal requirement — change% + supporting signal
- [ ] 3.5 News catalyst requirement — FMP /news/stock check
- [ ] 3.6 Quality threshold 3-10 picks instead of fixed 10
- [ ] 3.7 Score badge UI — circle to rounded square
- [ ] 3.8 Deploy and verify — trigger Opening Bell, confirm real tradeable picks
- [ ] 3.9 Commit: "feat: Opening Bell 5-layer data quality fix + UI consistency"

### Phase 4: Radar Quality
- [ ] 4.1 Prompt: catalystStrength must be 0 without dated event
- [ ] 4.2 Grade recency — last 2 trading days only
- [ ] 4.3 Catalyst majority — min 7/10 with real catalyst
- [ ] 4.4 Sector concentration cap — max 3 per sector
- [ ] 4.5 Volume anomaly — RelVol > 1.5x for non-catalyst picks
- [ ] 4.6 Stabilize macro regime — cache once per day
- [ ] 4.7 Quality threshold 3-10 picks instead of fixed 15
- [ ] 4.8 Portfolio integration for Radar picks
- [ ] 4.9 Deploy and verify — trigger Radar, confirm catalyst-driven picks, sector diversity
- [ ] 4.10 Commit: "feat: Radar quality improvements — catalyst requirements, sector cap, portfolio"

### Phase 5: Today's Spikes
- [ ] 5.1 Add ETF filter using bulk profile cache
- [ ] 5.2 Tighten pre-filter to ~80-90 candidates
- [ ] 5.3 Deploy and verify — confirm no ETFs in pipeline, stages complete within timeout
- [ ] 5.4 Commit: "feat: Spikes ETF filter and pre-filter tightening"

### Phase 6: Bug Fixes
- [ ] 6.1 Restructure `fmp_bulk_cache.py` — CSV for whitelist only, JSON `/stable/profile` for per-ticker lookups
- [ ] 6.2 Fix `changesPercentage` → `changePercentage` in Radar prompt (line 4672)
- [ ] 6.3 Add symbol filter to `fetch_news()` — reject articles where symbol != requested ticker
- [ ] 6.4 Add empty-movers guard in Opening Bell after multi-signal filter
- [ ] 6.5 Create `RadarLockInModal` — no 3/5/8 day targets, stop-loss only, sends `radarPickId`
- [ ] 6.6 Fix Radar portfolio API — don't set `target3Day`, leave null
- [ ] 6.7 Run regression checks + TypeScript build + deploy
- [ ] 6.8 Commit: "fix: bulk cache JSON profiles, Radar prompt field name, news symbol filter, Lock In modal"

### Final Verification
- [ ] All DailyReport dates have ≤10 picks
- [ ] No ETF tickers in any Spike, RadarPick, or OpeningBellPick table
- [ ] Radar Portfolio integration works — Lock In shows score + stop-loss only, no fake targets
- [ ] Opening Bell score badge matches Radar/Spikes styling
- [ ] Trigger test Radar — verify 3-10 picks, real catalysts, sector cap
- [ ] Trigger test Opening Bell — verify real tradeable TSX stocks
- [ ] Spike It test — verify 1-min intraday bars
- [ ] Verify `fetch_news()` returns empty for .TO tickers (FMP bug defensive filter working)
- [ ] Verify Radar prompt shows correct change% (not 0.00% for every ticker)
