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

## Phase 1: Data Repair (Do First — Users See Bad Data Now)

### 1.1 Delete Today's Opening Bell (Ghost Tickers)
All 10 picks are phantom tickers not purchasable on TSX. Delete the entire report.

```sql
-- Delete picks first (FK constraint), then report
DELETE FROM "OpeningBellPick" WHERE "reportId" IN (
  SELECT id FROM "OpeningBellReport" WHERE date = CURRENT_DATE
);
DELETE FROM "OpeningBellReport" WHERE date = CURRENT_DATE;
```

Verify: `SELECT COUNT(*) FROM "OpeningBellPick"` should return 0. `SELECT COUNT(*) FROM "OpeningBellReport"` should return 0.

### 1.2 Trim Today's Radar to Top 10
15 picks exist, should be 10. Delete ranks 11-15 (by smartMoneyScore), update report.

```sql
-- Delete the bottom 5 by score
DELETE FROM "RadarPick" WHERE id IN (
  SELECT id FROM "RadarPick"
  WHERE "reportId" IN (SELECT id FROM "RadarReport" WHERE date::date = CURRENT_DATE)
  ORDER BY "smartMoneyScore" ASC
  LIMIT 5
);

-- Re-rank remaining 10 by smartMoneyScore descending
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "smartMoneyScore" DESC) as new_rank
  FROM "RadarPick"
  WHERE "reportId" IN (SELECT id FROM "RadarReport" WHERE date::date = CURRENT_DATE)
)
UPDATE "RadarPick" p SET rank = r.new_rank
FROM ranked r WHERE p.id = r.id;

-- Update report count
UPDATE "RadarReport" SET "tickersFlagged" = 10
WHERE date::date = CURRENT_DATE;
```

Verify: `SELECT rank, ticker, "smartMoneyScore" FROM "RadarPick" ORDER BY rank` — should show 10 rows, rank 1-10, scores descending.

Then regenerate the override file:
```bash
docker exec spike-trades-app sh -c 'cat > /tmp/radar_opening_bell_overrides.json << EOF
{"date":"2026-04-06","tickers":["SU.TO","OVV.TO","EMA.TO","IMO.TO","NPI.TO","FTS.TO","BEP-UN.TO","DOO.TO","GFL.TO","SCR.TO"],"smart_money_scores":{"SU.TO":72,"OVV.TO":65,"EMA.TO":62,"IMO.TO":58,"NPI.TO":58,"FTS.TO":55,"BEP-UN.TO":54,"DOO.TO":54,"GFL.TO":54,"SCR.TO":54}}
EOF'
```

### 1.3 Clean ETF + Ghost Picks from Spikes Archive
14 ETFs + 1 ghost (BITF.TO) across 8 dates. Also 6 PortfolioEntry records reference ETF spikes.

Bad tickers: `HND.TO, HNU.TO, HOD.TO, HOU.TO, NRGU.TO, VDY.TO, VGRO.TO, VIU.TO, XEG.TO, XGD.TO, XIU.TO, ZEB.TO, ZSP.TO, BITF.TO`

```sql
-- Step 1: Delete portfolio entries referencing bad spikes
DELETE FROM "PortfolioEntry" WHERE "spikeId" IN (
  SELECT id FROM "Spike" WHERE ticker IN (
    'HND.TO','HNU.TO','HOD.TO','HOU.TO','NRGU.TO','VDY.TO','VGRO.TO',
    'VIU.TO','XEG.TO','XGD.TO','XIU.TO','ZEB.TO','ZSP.TO','BITF.TO'
  )
);

-- Step 2: Delete bad spike picks
DELETE FROM "Spike" WHERE ticker IN (
  'HND.TO','HNU.TO','HOD.TO','HOU.TO','NRGU.TO','VDY.TO','VGRO.TO',
  'VIU.TO','XEG.TO','XGD.TO','XIU.TO','ZEB.TO','ZSP.TO','BITF.TO'
);

-- Step 3: Re-rank all affected reports
-- For each report, re-rank remaining picks by spikeScore descending
```

After deleting, re-rank each affected date's picks sequentially by spikeScore.

### 1.4 Trim Mar 24 and Mar 25 from 20 to Top 10
These two dates had 20 picks (pre-v5 bug). Keep top 10 by spikeScore, delete the rest.

```sql
-- For each date, delete picks ranked below top 10 by spikeScore
DELETE FROM "Spike" WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY "reportId" ORDER BY "spikeScore" DESC) as rn
    FROM "Spike"
    WHERE "reportId" IN (
      SELECT id FROM "DailyReport" WHERE date IN ('2026-03-24', '2026-03-25')
    )
  ) sub WHERE rn > 10
);
```

Also check Mar 19, 20, 23 which had 20 picks each — same treatment.

### 1.5 Purge Council SQLite Learning DB
The council's internal SQLite has contaminated learning data from ETF/ghost picks.

```python
import sqlite3
conn = sqlite3.connect('/app/data/spike_trades_council.db')
cur = conn.cursor()

bad = ('HND.TO','HNU.TO','HOD.TO','HOU.TO','NRGU.TO','VDY.TO','VGRO.TO',
       'VIU.TO','XEG.TO','XGD.TO','XIU.TO','ZEB.TO','ZSP.TO','BITF.TO')

# Delete bad records
cur.execute(f"DELETE FROM pick_history WHERE ticker IN ({','.join('?' * len(bad))})", bad)
cur.execute(f"DELETE FROM stage_scores WHERE ticker IN ({','.join('?' * len(bad))})", bad)

# Reset calibration tables (will rebuild from clean data on next run)
cur.execute("DELETE FROM calibration_base_rates")
cur.execute("DELETE FROM calibration_council")
cur.execute("DELETE FROM accuracy_records")

conn.commit()
conn.close()
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

## Deployment Order

1. **Phase 1 (Data Repair)** — run SQL + Python cleanup scripts on server
2. **Phase 2 (FMP Infrastructure)** — bulk cache module, field normalization
3. **Phase 3 (Opening Bell)** — 5-layer quality fix + UI
4. **Phase 4 (Radar)** — 6 quality improvements + portfolio integration
5. **Phase 5 (Spikes)** — pre-filter tightening + ETF filter

Phases 3-5 depend on Phase 2 (bulk cache). Phase 1 is independent and should be done first.

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

### Final Verification
- [ ] All DailyReport dates have ≤10 picks
- [ ] No ETF tickers in any Spike, RadarPick, or OpeningBellPick table
- [ ] Radar Portfolio integration works
- [ ] Opening Bell score badge matches Radar/Spikes styling
- [ ] Trigger test Radar — verify 3-10 picks, real catalysts, sector cap
- [ ] Trigger test Opening Bell — verify real tradeable TSX stocks
- [ ] Spike It test — verify 1-min intraday bars
