# Session 10 — v5.0 Post-Launch Repairs & Quality Improvements

**REQUIRED:** Use `/superpowers:executing-plans` to implement this session. Read the full plan at `docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md` and execute all 5 phases in order, marking each step complete as you go.

## Background

Session 9 was the first v5.0 production run (2026-04-06). Monitoring and audit revealed 26 issues across data quality, FMP API compatibility, scoring logic, and UI consistency. Several hotfixes were deployed during Session 9:

**Session 9 hotfixes (already deployed, commit history):**
- `1adfff1` — Radar cron timeout 360s → 600s
- `1428254` — AI score clamping for Radar and Spikes (prevents rejected picks from out-of-bounds scores)
- `a03b61a` — Opening Bell FMP field name mismatches (changesPercentage → changePercentage, .TO suffix filtering, marketCap liquidity filter, profile enrichment)
- `6c806e9` — Intraday chart path fix (/1min/{ticker} → /1min?symbol={ticker}), Opening Bell isActivelyTrading + isEtf filter
- `fc80e9d` — Historical edge multiplier applied before ranking (fixes rank/score mismatch)
- Today's Spikes ranks retroactively corrected via SQL

**What remains — the full plan is at:** `docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md`

## Server Details
- **Server:** `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
- **Deploy path:** `/opt/spike-trades`
- **DB:** PostgreSQL in `spike-trades-db` container, user `spiketrades`, db `spiketrades`
- **Council:** Python FastAPI in `spike-trades-council` container, internal SQLite learning DB at `/app/data/spike_trades_council.db`

## What To Do

Read the full plan at `docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md` and execute all 5 phases in order:

### Phase 1: Data Repair (FIRST — users see bad data now)
1. Delete today's Opening Bell report + 10 ghost picks
2. Trim today's Radar from 15 to top 10, re-rank, update override file
3. Delete 14 ETF + 1 ghost ticker from Spikes archive (15 picks across 8 dates)
4. Delete 6 PortfolioEntry records referencing ETF spikes
5. Trim Mar 19-24 reports from 20 to top 10 picks each
6. Purge council SQLite learning DB — bad pick_history, stage_scores, reset calibration

### Phase 2: FMP Infrastructure
7. Bulk FMP profile cache module (`fmp_bulk_cache.py`) — CSV download, 4-hour TTL, whitelist
8. FMP field name normalization layer
9. Fix remaining endpoints: sector-performance-snapshot date param, earnings-surprises replacement, Finnhub → FMP news

### Phase 3: Opening Bell Data Quality (5-layer fix + UI)
10. Validate against profile-bulk whitelist
11. Volume gate (min 50K avgVolume)
12. Remove avgVolume=1 fallback
13. Multi-signal requirement (change% + volume/news/grades)
14. News catalyst requirement
15. Quality threshold 3-10 picks instead of fixed 10
16. Score badge UI — circle to rounded square matching Radar/Spikes

### Phase 4: Radar Quality (6 improvements + portfolio)
17. Prompt: catalystStrength must be 0 without dated event
18. Grade recency — last 2 trading days only
19. Catalyst majority — min 7/10 must have real catalyst
20. Sector cap — max 3 per sector
21. Volume anomaly — require RelVol > 1.5x for non-catalyst picks
22. Stabilize macro regime — cache once per day
23. Quality threshold 3-10 picks instead of fixed 15
24. Portfolio integration for Radar picks

### Phase 5: Today's Spikes Pre-Filter
25. ETF filter using bulk profile cache
26. Tighten candidate count to ~80-90

## Important Notes

- **Phase 1 is independent** — do it first, verify, then proceed
- **Phases 3-5 depend on Phase 2** — bulk cache must be built first
- **Always commit and push after each phase** — deploy to server and verify
- **The plan file has detailed SQL, code snippets, and verification steps** — follow them
- **FMP API key:** `Z0n16cRRU0Mvk45AvHoiyOr0X6TSYvLY` (Ultimate plan, available in .env)
- **Bulk endpoints return CSV, not JSON** — rate limited to once per 60 seconds
- **Council SQLite DB** is inside the council container at `/app/data/spike_trades_council.db`
- **Test Spike It** after deployment to verify intraday charts still work

## Verification Checklist (After All Phases)
- [ ] All DailyReport dates have exactly 10 picks (or fewer if pre-v5)
- [ ] No ETF tickers in any Spike, RadarPick, or OpeningBellPick table
- [ ] Radar has exactly 10 picks for today
- [ ] Opening Bell report for today is deleted
- [ ] Council learning DB has no ETF/ghost ticker records
- [ ] Radar Portfolio integration works
- [ ] Opening Bell score badge matches Radar/Spikes styling
- [ ] Trigger test Radar run — verify 3-10 picks, real catalysts, sector cap
- [ ] Trigger test Opening Bell — verify picks are real, tradeable TSX stocks
- [ ] Spike It test — verify 1-min intraday bars returned
