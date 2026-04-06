# Session 10 — v5.0 Post-Launch Repairs & Quality Improvements

**REQUIRED:** Use `/superpowers:executing-plans` to implement this session. Read the full plan at `docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md` and execute all 5 phases in order, marking each step complete as you go.

## DO NOT TOUCH — Already Completed in Sessions 8 & 9

These are DONE. Do not revisit, re-plan, re-investigate, or re-implement any of them:

| Commit | What was done | Files changed |
|--------|--------------|---------------|
| `c3eb05a` | Radar cron moved from 8:15 AM to 10:05 AM AST | `scripts/start-cron.ts`, `canadian_llm_council_brain.py`, UI pages, docs |
| `9aa8abd` | Empty state screens for Radar and Opening Bell | UI pages |
| `a776983` | Code simplification — shared utils, batch DB ops | Multiple |
| `1adfff1` | Radar cron timeout 360s → 600s | `scripts/start-cron.ts` |
| `1428254` | AI score clamping for Radar and Spikes | `canadian_llm_council_brain.py` |
| `a03b61a` | Opening Bell FMP field names (changesPercentage → changePercentage, .TO suffix, marketCap filter, profile enrichment) | `opening_bell_scanner.py` |
| `6c806e9` | Intraday chart path fix (/1min/{ticker} → /1min?symbol={ticker}), Opening Bell isActivelyTrading + isEtf filter | `api_server.py`, `canadian_llm_council_brain.py`, `opening_bell_scanner.py` |
| `fc80e9d` | Historical edge multiplier applied before ranking | `canadian_llm_council_brain.py` |
| SQL (no commit) | Today's Spikes ranks retroactively corrected — MX.TO now rank 1 at 84.69 | Direct DB update |

**Do NOT update any 8:15 AM references to 10:05 AM — this was done in Session 8.** Some documentation files still reference 8:15 AM but these are historical docs, not runtime code.

## Current State of the Database (as of end of Session 9)

Verify this before starting any work:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30
docker exec spike-trades-db psql -U spiketrades -d spiketrades -c '
  SELECT '\''Radar picks'\'' as what, COUNT(*) as count FROM "RadarPick"
  UNION ALL
  SELECT '\''OB picks'\'', COUNT(*) FROM "OpeningBellPick"
  UNION ALL
  SELECT '\''OB reports'\'', COUNT(*) FROM "OpeningBellReport";
'
```

Expected: Radar picks = 15 (needs trimming to 10), OB picks = 10 (all ghost tickers, needs deleting), OB reports = 1 (needs deleting).

```bash
docker exec spike-trades-db psql -U spiketrades -d spiketrades -c '
  SELECT r.date, COUNT(s.id) FROM "DailyReport" r JOIN "Spike" s ON s."reportId" = r.id GROUP BY r.date ORDER BY r.date DESC;
'
```

Expected: Mar 19-24 have 20 picks each (need trimming to 10). Apr dates have 10 each. 14 ETF tickers + 1 ghost (BITF.TO) contaminate the archive.

If the counts don't match, investigate before proceeding.

## Server Details
- **Server:** `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
- **Deploy path:** `/opt/spike-trades`
- **DB:** PostgreSQL in `spike-trades-db` container, user `spiketrades`, db `spiketrades`
- **Council:** Python FastAPI in `spike-trades-council` container, internal SQLite learning DB at `/app/data/spike_trades_council.db`
- **FMP API key:** In `.env` as `FMP_API_KEY` (value: `Z0n16cRRU0Mvk45AvHoiyOr0X6TSYvLY`, Ultimate plan)
- **Bulk FMP endpoints return CSV, not JSON** — rate limited to once per 60 seconds

## Your First Action

**Step 1:** SSH to the server and run the verification queries above to confirm the current database state matches expectations.

**Step 2:** Begin Phase 1 data repair — the SQL statements are in the plan file. Run them against the production database.

**Do not write any code or modify any source files until Phase 1 data repair is complete and verified.**

## The 26 Tasks (Grouped by Phase)

### Phase 1: Data Repair (FIRST — users see bad data now)
1. Delete today's Opening Bell report + 10 ghost picks
2. Trim today's Radar from 15 to top 10, re-rank, regenerate override file
3. Delete 14 ETF + 1 ghost ticker from Spikes archive (15 picks across 8 dates), delete 6 PortfolioEntry records
4. Trim Mar 19-25 reports from 20 to top 10 picks each
5. Purge council SQLite learning DB — 15 bad pick_history, 41 bad stage_scores, reset calibration
6. Verify all repairs

### Phase 2: FMP Infrastructure (Foundation — Phases 3-5 depend on this)
7. Create `fmp_bulk_cache.py` — download `/stable/profile-bulk?part=0` CSV, parse, 4-hour TTL cache, expose `get_profile(ticker)` and `get_tsx_whitelist()` (set of .TO tickers where isActivelyTrading=true and isEtf=false)
8. Add field name normalization to bulk cache output (changePercentage→changesPercentage, averageVolume→avgVolume, companyName→name)
9. Fix `/sector-performance-snapshot` — add explicit `date` param in all call sites
10. Check `/earning-surprise-bulk` as replacement for gone `/earnings-surprises` endpoint
11. Replace Finnhub news calls with FMP `/news/stock` (supports `tickers` param for bulk)
12. Integrate bulk cache into council brain, Opening Bell scanner, and api_server — replace per-ticker `/profile` calls
13. Deploy and verify

### Phase 3: Opening Bell Data Quality (5-layer fix + UI)
14. Validate against profile-bulk whitelist in `fetch_tsx_universe()`
15. Volume gate — min 50K avgVolume in `compute_rankings()`
16. Remove avgVolume=1 fallback in `map_to_prisma()` — reject ticker if no avgVolume
17. Multi-signal requirement — change% plus at least one supporting signal (relVol>1.5x, news, or grades)
18. News catalyst requirement — FMP `/news/stock` check, reject tickers with zero news unless analyst grade
19. Quality threshold 3-10 picks instead of fixed 10
20. Score badge UI fix in `src/components/opening-bell/OpeningBellCard.tsx` — change `rounded-full border-2` to `rounded-xl border`, adjust opacities to 15%/30%, move "Score" label below box (match RadarCard/SpikeCard exactly)
21. Deploy and verify — trigger Opening Bell manually, confirm real tradeable TSX picks

### Phase 4: Radar Quality (6 improvements + portfolio)
22. Prompt: update `RADAR_SYSTEM_PROMPT` — catalystStrength MUST be 0 without specific dated event (sector trends, macro, commodity prices are NOT catalysts)
23. Grade recency — only count analyst grades from last 2 trading days as overnight catalysts
24. Catalyst majority — after scoring, require min 7 picks with catalystStrength > 0; fill remaining 3 slots max with best technical setups
25. Sector concentration cap — max 3 picks per sector, replace extras with next-best from other sectors
26. Volume anomaly — require relative_volume > 1.5x for picks with catalystStrength = 0
27. Stabilize macro regime — cache determination once per day, reuse on re-runs
28. Quality threshold 3-10 picks — change `top_n` default from 15 to 10 max, apply minimum smartMoneyScore threshold
29. Portfolio integration — add "Add to Portfolio" for Radar picks (reference SpikeCard.tsx implementation)
30. Deploy and verify — trigger Radar manually, confirm catalyst-driven picks, sector diversity, max 10

### Phase 5: Today's Spikes Pre-Filter
31. Add ETF filter using bulk profile cache whitelist
32. Tighten pre-filter — reduce candidates from ~118 to ~80-90 (increase ADV threshold or strengthen noise filter)
33. Deploy and verify — confirm no ETFs, stages complete within wall-clock timeout

## Important Notes

- **Always commit and push after each phase** — deploy to server with `docker compose up -d --build council` (or `cron` / `app` as needed)
- **The plan file has detailed SQL and code snippets** — `docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md`
- **Council SQLite DB** is inside the council container at `/app/data/spike_trades_council.db` — use `docker exec spike-trades-council python3 -c "..."` to run cleanup
- **Bad ETF tickers list:** `HND.TO, HNU.TO, HOD.TO, HOU.TO, NRGU.TO, VDY.TO, VGRO.TO, VIU.TO, XEG.TO, XGD.TO, XIU.TO, ZEB.TO, ZSP.TO, BITF.TO`
- **After rebuilding council container**, the override file in the app container survives (app container not rebuilt)
- **Test Spike It** after any council rebuild to verify intraday charts still work: `curl -s -X POST 'http://localhost:8100/spike-it' -H 'Content-Type: application/json' -d '{"ticker":"SU.TO","entry_price":92.00}'`

## Session 9 Hotfix Regression Check (REQUIRED after each phase)

Session 9 deployed hotfixes that this session's code changes could accidentally break. After EACH phase that modifies source files (Phases 2-5), run these checks BEFORE deploying:

```bash
# 1. Score clamping still works (commit 1428254)
# Verify RadarScoreBreakdown bounds exist and clamping logic is intact
grep -n "RADAR_BOUNDS\|SCORE_BOUNDS\|clamp" canadian_llm_council_brain.py | head -10

# 2. Intraday chart path uses query param, not path param (commit 6c806e9)
# Must show ?symbol= not /{ticker}
grep -n "historical-chart" api_server.py canadian_llm_council_brain.py opening_bell_scanner.py | grep -v "docs\|#\|plans"

# 3. Edge multiplier applied before ranking (commit fc80e9d)
# _build_consensus must have historical_analyzer param, NOT a separate Step 11 that mutates scores
grep -n "edge_multi\|historical_analyzer" canadian_llm_council_brain.py | head -10

# 4. Cron timeout is 600s for Radar (commit 1adfff1)
grep -n "timeout.*600\|timeout.*Radar" scripts/start-cron.ts

# 5. Opening Bell uses changePercentage (not changesPercentage) and .TO suffix filter (commit a03b61a)
grep -n "changesPercentage\|exchangeShortName" opening_bell_scanner.py
# Should return ZERO results — both were replaced
```

If ANY of these checks fail, STOP. The phase introduced a regression. Fix it before deploying.

## Pre-Deployment Gate: Systematic Debugging (REQUIRED)

**Before requesting deployment approval for ANY phase**, use `/superpowers:systematic-debugging` to verify:

1. **No regressions from Session 9 hotfixes** — run the regression checks above
2. **Python syntax valid** — `python3 -c "import ast; ast.parse(open('canadian_llm_council_brain.py').read())"`
3. **Python syntax valid** — `python3 -c "import ast; ast.parse(open('opening_bell_scanner.py').read())"`
4. **Python syntax valid** — `python3 -c "import ast; ast.parse(open('api_server.py').read())"`
5. **TypeScript builds** — `npx next build` (or at minimum `npx tsc --noEmit`)
6. **No unintended file changes** — `git diff --stat` should only show files relevant to the current phase
7. **Grep for debug artifacts** — no `console.log("DEBUG`, `print("TODO`, or `breakpoint()` left in code

Only after ALL checks pass, commit and request deployment. If any check fails, diagnose root cause using systematic debugging before proceeding.

## Final Verification Checklist (After All 5 Phases Complete)
- [ ] All DailyReport dates have ≤10 picks
- [ ] No ETF tickers in any Spike, RadarPick, or OpeningBellPick table
- [ ] Radar has exactly 10 picks for today, scores descending
- [ ] Opening Bell report for today is deleted
- [ ] Council learning DB has no ETF/ghost ticker records
- [ ] Radar Portfolio integration works
- [ ] Opening Bell score badge matches Radar/Spikes styling
- [ ] Trigger test Radar — verify 3-10 picks, real catalysts, max 3 per sector
- [ ] Trigger test Opening Bell — verify real tradeable TSX stocks, no ghosts
- [ ] Spike It test — verify 1-min intraday bars returned
- [ ] All Session 9 regression checks pass
- [ ] No debug artifacts in any source file
