# Sibling B — Parallel Council Refactor + Hybrid FMP/EODHD + Dual-Listing Enrichment

**Date:** 2026-04-08
**Status:** Draft, to be reviewed after spec write
**Topic:** Major refactor of the council brain to run Stages 1 + 2 in parallel, merge FMP + EODHD data sources at the fetch layer, reduce cardinality (80→60, 40→30), add ghost stock detection, and add dual-listing enrichment (Tiers 1 + 2 + 3).
**Sibling:** **System B (other Claude Code session, same account)**
**Estimated cost:** ~5-8 hours of execution time (subagent-driven development)
**Risk:** HIGH — refactors the heart of the pick-generation pipeline. Mitigations: subagent review rigor, pre-deploy build checks, post-run backtesting. **No shadow mode** (per user decision Q1 = A).

---

## Origin

This project emerged from multiple observations in today's session:

1. **Today's council run hit the Stage 1 wall-clock timeout** (420s), processing only 75 of ~120 tickers before aborting. 45 tickers (37% of the universe) were never scored by Sonnet. The pipeline still produced 10 picks but from a reduced pool.
2. **The current council brain runs Stages 1 and 2 sequentially** even though Gemini is explicitly told to score independently from Stage 1's output. Sequential execution wastes wall-clock time.
3. **The hybrid data audit** found 50.5% dual-listing coverage across past picks (measured, not estimated). Dual-listed stocks have access to dramatically richer US-market data (options IV, 13F institutional, analyst coverage, news volume) that's currently unused.
4. **Ghost stock detection** could emerge naturally from cross-validating FMP and EODHD at the fetch layer.
5. **Empirical rescue-rate analysis** showed Stage 3 (Opus) rescues ~5% of final picks and Stage 4 (Grok) only effectively produces ~8 picks regardless of input size — meaning cardinality cuts (80→60 for Opus input, 40→30 for Grok input) are low-risk.

The full brainstorm context is captured in the memory note `project_sibling_b_parallel_council_refactor.md` and the session transcript from 2026-04-08.

---

## Goal

Rebuild Steps 3-7 of `run_council_analysis()` in `canadian_llm_council_brain.py` to:

1. **Fetch data from BOTH FMP and EODHD** at the fetch layer, merge into a unified `MergedPayload`
2. **Cross-validate and flag** ghost/delisted stocks, stale quotes, field-level discrepancies
3. **Enrich dual-listed tickers** with US options IV (Tier 1), US 13F institutional (Tier 2), US analyst + news (Tier 3)
4. **Run Stages 1 (Sonnet) and 2 (Gemini) in parallel** via `asyncio.gather()`, both scoring the full universe independently
5. **Merge consensus** from both stages via weighted average, narrowing to Top 60 for Stage 3 Opus
6. **Opus produces Top 30** (down from Top 40) for Stage 4 Grok
7. **Grok produces final Top 10** (unchanged)

**Preserve** all existing downstream logic: multiplier cap (from Sibling A), IIC compute (from Sibling A), FinalHotPick construction, conviction tiering, Prisma persistence, SpikeCard rendering.

---

## Non-goals

- No changes to the existing LE bypass (hardcoded stage weights stay at `{0.15, 0.20, 0.30, 0.35}`)
- No changes to Sibling A's IIC computation or display
- No changes to the Prisma Spike model except possibly adding new fields for dual-listing data (optional — can defer)
- No changes to the Smart bar, History bar, or Council bar UI
- No changes to SpikeCard.tsx
- No shadow mode deployment (user decision)

---

## Architecture overview

### High-level data flow (new)

```
Step 1: Fetch TSX universe (FMP /stock-list) — unchanged
Step 2: Quotes + liquidity filter — unchanged (uses CouncilConfig.minAdvDollars from ADV Slider)
Step 3: FETCH LAYER REFACTOR (this spec)
  ├─ FMP enrichment batch (existing LiveDataFetcher.fetch_enhanced_signals_batch)
  ├─ EODHD enrichment batch (new, mirrors FMP structure)
  ├─ US dual-listing enrichment (new, for ~50% of tickers)
  ├─ Cross-compare step (new, produces DataQualityFlag per ticker)
  └─ MergedPayload assembly (new)
Step 4: STAGES 1 & 2 IN PARALLEL
  ├─ asyncio.gather(
  │    run_stage1_sonnet(payloads, rubric, full universe),
  │    run_stage2_gemini(payloads, rubric, full universe)
  │  )
  └─ Consensus merge → narrow to Top 60 by weighted stage1+stage2 score
Step 5: STAGE 3 OPUS on 60 → Top 30
Step 6: STAGE 4 GROK on 30 → final picks
Step 7: ConvictionEngine.build_consensus_top10 → Top 10 with IIC + multiplier cap
Step 8+: Unchanged (persistence, calibration, api_server)
```

### Component breakdown

**Component 1: EODHD enrichment batch function** (new)
- Location: new file `eodhd_enrichment.py` or inline in `canadian_llm_council_brain.py`
- Mirrors the structure of `fetch_enhanced_signals_batch` but calls EODHD endpoints
- Fetches: news + sentiment (already exists via `eodhd_news.py` — reuse), any other EODHD-exclusive fields the audit identifies

**Component 2: Dual-listing detection** (new)
- Location: new file `dual_listing_map.json` + helper `canadian_llm_council_brain.py::detect_dual_listing(ticker: str) -> Optional[str]`
- Static map of known TSX→US ticker pairs (seeded with the 33 dual-listed tickers from today's audit: AEM.TO→AEM, BN.TO→BN, SHOP.TO→SHOP, etc.)
- Helper function returns the US ticker or None
- Optionally extends with a runtime FMP `/profile` check for names not in the static map

**Component 3: US options IV fetcher — Tier 1** (new)
- Location: new function `fetch_us_options_iv(fetcher, us_ticker) -> Optional[IVExpectedMove]`
- Uses FMP's options endpoint (e.g., `/api/v4/historical-price-full-options/{ticker}` or similar — implementation should verify exact endpoint)
- Returns an `IVExpectedMove` instance populated from real US options, or None
- Called ONLY for dual-listed tickers; non-dual-listed tickers keep using the ATR proxy

**Component 4: US 13F institutional fetcher — Tier 2** (new)
- Location: new function `fetch_us_13f_institutional(fetcher, us_ticker) -> Optional[float]`
- Uses FMP's 13F endpoint (e.g., `/api/v4/institutional-ownership/symbol-ownership` with the US ticker)
- Returns the institutional ownership percentage (0.0-1.0) from US filings
- **This enriches Sibling A's IIC score** — for dual-listed stocks, the `institutional_ownership_pct` field gets populated from US 13F data instead of the Canadian-only version

**Component 5: US analyst + news enrichment — Tier 3** (new)
- Location: new functions `fetch_us_analyst_consensus(fetcher, us_ticker)` and `fetch_us_news_sentiment(us_ticker)` (the latter likely reuses `eodhd_news.py` with the US symbol)
- Returns additional analyst data and US-market news sentiment
- Optionally blended with Canadian data or stored as supplementary fields

**Component 6: Fetch-layer cross-compare step** (new)
- Location: new function `cross_compare_fmp_eodhd(fmp_data, eodhd_data, ticker) -> DataQualityFlags`
- Compares field-by-field for overlapping data (quotes, volume, fundamentals)
- Returns a `DataQualityFlags` object with:
  - `ghost_stock: bool` — ticker exists in one source but not the other
  - `price_disagreement_pct: Optional[float]` — if both have prices, the delta
  - `stale_timestamp_source: Optional[str]` — which source had a stale timestamp (> 1h old)
  - Flags logged to a `DataQualityLog` (could be a simple append to `LiveDataFetcher.endpoint_health` dict or a new dedicated log)

**Component 7: MergedPayload type** (new)
- Location: new section in `canadian_llm_council_brain.py` or new file
- Pydantic model that supersedes `StockDataPayload` for the new fetch flow
- Fields: all existing StockDataPayload fields + `data_quality_flags: DataQualityFlags` + `dual_listing_us_ticker: Optional[str]` + `us_options_iv: Optional[IVExpectedMove]`
- Per the field-source mapping: news/sentiment comes from EODHD, insider/institutional/analyst/quotes come from FMP (with cross-validation where both exist)
- **Both LLMs (Sonnet and Gemini) see the same MergedPayload** per the D2 design decision

**Component 8: Parallel stage execution** (refactor of existing)
- Location: `run_council_analysis()` in `canadian_llm_council_brain.py`, current sequential Stage 1 → Stage 2 logic
- Replace with `asyncio.gather(run_stage1_sonnet(...), run_stage2_gemini(...))`
- Both stages receive the same full universe of MergedPayloads (~120 tickers)
- Gemini's prompt is updated: no longer receives Stage 1's output (because it runs in parallel). Instead, scores independently from raw MergedPayload data.
- The "disagreement_reason" field in Gemini's output is removed (it's no longer meaningful without seeing Stage 1's scores)

**Component 9: Consensus merge + narrowing to Top 60** (new)
- Location: `run_council_analysis()` after the parallel gather
- For each ticker, combine `stage1_score` and `stage2_score` using weighted average (per LE bypass: stage weights 0.15 and 0.20 → normalized 0.43/0.57 between just these two stages)
- Narrow to **Top 60** by combined score
- Pass to Stage 3 Opus

**Component 10: Cardinality cuts**
- Stage 2 output → Top 60 (was 80)
- Opus output → Top 30 (was 40)
- Trivial constant changes: find the narrowing logic in `run_council_analysis`, change the two numbers

**Component 11: Stage 1 wall-clock cap decision**
- Current: 420 seconds
- Options: raise to 600s, or remove entirely since parallelism makes timeout less critical
- Recommendation: **raise to 600s** (safety net for future extreme latency spikes, but generous enough to handle today's ~13-minute scenario)

---

## Field-source mapping (per audit)

| Field | Primary source | Cross-check | Notes |
|---|---|---|---|
| Quote (price, change, volume) | FMP | EODHD cross-check | Flag ghost if only one has data |
| Historical bars | FMP | EODHD cross-check | Flag stale if > 1 day old |
| Insider trading | FMP | none (EODHD has limited coverage) | — |
| Institutional ownership | FMP (Canadian) OR US 13F (dual-listed) | none | Dual-listed prefers US 13F |
| Earnings calendar | FMP | EODHD cross-check | — |
| Analyst consensus | FMP | none for Canadian; add US analyst for dual-listed | — |
| News + sentiment | **EODHD** (canonical) | FMP /news as backup | Already integrated via `eodhd_news.py` |
| Fundamentals | FMP | EODHD cross-check | — |
| Options IV | ATR proxy (non-dual-listed) OR US options IV (dual-listed) | — | Tier 1 enrichment |

---

## Dependencies and coordination constraints

**CRITICAL:** This project touches `canadian_llm_council_brain.py` extensively. The ADV Slider project (System A) also touches this file briefly. To prevent merge conflicts:

1. **System B must NOT touch `canadian_llm_council_brain.py` until the ADV Slider PR is merged to main.** Check by running `git fetch origin main && git log --oneline origin/main | grep -i "adv.slider"`.
2. **While waiting**, System B should work on NEW FILES ONLY:
   - Create `dual_listing_map.json` seeded from the 33-ticker audit list
   - Create `eodhd_enrichment.py` (new module with the EODHD enrichment batch function)
   - Create `us_dual_listing_enrichment.py` (new module with the 3 tier fetchers)
   - Create `cross_compare.py` (new module with the cross-compare step)
   - Define the `MergedPayload` Pydantic model in a new file or as a new section comment-blocked for later insertion
3. **Once ADV Slider is merged**, System B pulls main, rebases its feature branch, and begins integrating the new modules into `canadian_llm_council_brain.py`.

**Session A's ADV Slider estimated time:** ~1.5 hours from start. So System B has roughly 1.5 hours of new-file work before the brain file unlocks.

---

## File manifest

### New files
| Path | Responsibility | LoC |
|---|---|---|
| `dual_listing_map.json` | Static TSX→US ticker map for 33+ known dual-listed names | ~40 |
| `eodhd_enrichment.py` | EODHD batch enrichment module (parallels FMP's fetch_enhanced_signals_batch) | ~120 |
| `us_dual_listing_enrichment.py` | Tier 1-3 US enrichment fetchers (options IV, 13F, analyst, news) | ~200 |
| `cross_compare.py` | Fetch-layer cross-validation module producing DataQualityFlags | ~80 |
| `merged_payload.py` (OR inline section) | MergedPayload Pydantic model + supporting types | ~50 |

### Modified files
| Path | Change | LoC |
|---|---|---|
| `canadian_llm_council_brain.py` | Integrate new modules into `run_council_analysis()`: replace sequential Stage 1+2 with parallel gather, add cross-compare call after fetches, add dual-listing enrichment loop, swap `StockDataPayload` for `MergedPayload`, update Gemini prompt to remove stage1 dependency, raise Stage 1 cap to 600s, apply cardinality cuts 80→60 and 40→30 | ~200 |

### Not touched
- `src/components/spikes/SpikeCard.tsx` (Sibling A + B-i already ship UI changes)
- `src/types/index.ts`
- `api_server.py` (no new fields exposed to frontend in this phase — dual-listing data is used internally by scoring, not directly displayed)
- Prisma schema (no new columns in this phase — defer per Sibling A's pattern)

---

## Deploy sequence (matches Sibling A pattern)

1. Branch `feat/sibling-b-parallel-council` off `origin/main` (AFTER ADV Slider merged)
2. Create new modules (can start before ADV Slider merges)
3. Integrate into brain file (AFTER ADV Slider merges)
4. `npm run build` + `python3 -m py_compile canadian_llm_council_brain.py` verify clean
5. Commit, push, PR
6. **Final whole-branch integration review** by opus reviewer before merge (critical for high-risk refactor)
7. User explicit approval gate before merge (two-keys-to-fire for this size refactor)
8. Merge to main
9. Production: `git pull`, `docker compose build app && docker compose build council`, `docker compose up -d` (both app and council need rebuild)
10. No `prisma db push` needed (no schema changes this phase)
11. T+0 verification via council container logs and a manual test run

---

## Verification plan

### T+0 (after deploy, before next council run)
1. Council container starts cleanly (check `docker compose logs council --since 1m | grep -iE "error|exception"`)
2. `/fmp-health` endpoint returns OK
3. `/eodhd-health` endpoint (new if added) returns OK
4. Brain file Python syntax check passes: `docker compose exec -T council python3 -c "import canadian_llm_council_brain; print('ok')"`

### T+1 (tomorrow's 10:45 AST council run)
1. Log shows parallel gather: `Stage 1 (Sonnet) + Stage 2 (Gemini) launched in parallel`
2. Log shows both stages completing independently with distinct timings
3. Log shows cross-compare step running: `Cross-compare: N tickers, M ghost flags, P price disagreements`
4. Log shows dual-listing enrichment: `Dual-listing: N tickers enriched with US data`
5. Stage 2 output = exactly 60 tickers (not 80)
6. Opus output = exactly 30 tickers (not 40)
7. Grok produces final 10 picks
8. No Stage 1 timeout (or if it occurs, Gemini's independent coverage rescues the universe)
9. Total run time: should be faster than historical 21-24 min (target: ~15-18 min)
10. All 10 final picks persisted to Prisma correctly
11. Sibling A's IIC scores populated correctly (dual-listed picks should have HIGHER IIC scores on average due to US 13F data)

### T+24 backtest report (System A writes after the run)
- Query pick_history + stage_scores + Spike tables
- Compare: consensus score distribution, conviction tier distribution, pick count per sector, Stage 1 timeout flag (should be absent or only triggered gracefully)
- Flag any anomalies
- Write to `docs/superpowers/reports/2026-04-09-sibling-b-backtest-report.md`

---

## Rollback

If Sibling B introduces a regression detected after deploy:
1. `git revert <merge commit>` on main
2. Redeploy previous image: `git pull`, `docker compose build app council`, `docker compose up -d`
3. No database state to roll back (no schema changes)
4. The next council run will use the old sequential pipeline

If ONLY a specific module has a bug, targeted revert of that module is possible by leaving the imports but bypassing the failing function.

---

## Open questions (to be resolved during implementation)

1. **Exact FMP options IV endpoint for US tickers** — verify at implementation time
2. **Exact FMP 13F endpoint parameter for US ticker lookup** — likely the same `/api/v4/institutional-ownership/symbol-ownership` endpoint used in Sibling A, just with a US symbol
3. **Whether the council container has direct Postgres access** (for reading CouncilConfig.minAdvDollars from the ADV Slider) — if not, need a different coordination mechanism
4. **Gemini prompt rewrite** — the current prompt expects Stage 1 output; needs to be rewritten to score independently. Implementer should adapt the existing prompt by removing the "Stage 1 provided these scores" context block.
5. **Consensus merge weight between Stage 1 and Stage 2** — with LE bypass weights `{0.15, 0.20, 0.30, 0.35}`, just these two stages normalize to `0.15/(0.15+0.20) = 0.43` and `0.20/(0.15+0.20) = 0.57`. Confirm this is the right normalization or if equal weights are preferred for the narrowing step specifically.

---

## Handoff to System B (the other Claude Code session)

A companion document at `docs/superpowers/plans/2026-04-08-sibling-b-parallel-council-refactor.md` contains the implementation plan broken down into tasks. A further companion document at `docs/superpowers/plans/2026-04-08-sibling-b-system-b-handoff-prompt.md` contains the precise prompt to paste into the other Claude Code session to start execution autonomously.
