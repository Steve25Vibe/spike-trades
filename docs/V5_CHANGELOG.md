# Spike Trades v5.0 → v5.0a — Post-Launch Hardening
## Changelog: v5.0 → v5.0a

**Release Date:** 2026-04-07
**Commits:** 33 (c3eb05a..255fb79)
**Tag Line:** Quality, consistency, and recovery — making v5.0 production-grade

---

### Overview

Version 5.0a is a hardening release covering Sessions 10 through 13 plus post-Session-13 admin UI polish. Where v5.0 introduced the Smart Money Flow Radar feature, v5.0a makes the entire pipeline trustworthy: Opening Bell ghost-ticker bug fixes, ETF filtering for Spikes, full Finnhub removal in favor of EODHD as the unified news provider, Card-design consistency between Radar / Opening Bell / Today's Spikes, portfolio integration for Radar, recovery of all five post-deploy bugs found by user verification (Radar archives, Radar accuracy display location, EODHD Data Source Health, Admin Analytics tables, Learning gate reset), a one-time recovery of `accuracy_records` from Prisma Spike actuals after a destructive Session 10 cleanup wiped 510+ rows, the wiring fix for `emailRadar` (which had been a half-implemented preference toggle since v5.0 launch), and final admin UI refinements that split the LLM Stage Performance card into a Funnel + Stage 4 Accuracy pair and corrected the misleading "resolved picks" gate label.

---

### Sessions Covered

| Session | Theme | Commits |
|---|---|---|
| **Session 10** | Post-launch repair sweep | 13 commits |
| **Session 11** | EODHD migration + Finnhub removal | 5 commits |
| **Session 12** | Card consistency + Radar portfolio integration | 5 commits |
| **Session 13** | Five post-deploy bug repairs + accuracy_records recovery | 7 commits |
| **Post-13** | Admin UI polish + emailRadar fix + zero-picks robustness | 3 commits |

---

### Session 10 — Post-Launch Repair Sweep

#### Critical Pipeline Fixes
- **Radar cron timeout extended from 6 → 10 minutes** — The 6-minute timeout was killing scans before LLM batches finished. Increased to 10 minutes plus a 1-minute buffer. (`scripts/start-cron.ts`) *Commit 1adfff1*
- **AI score clamping + Radar prompt hardening** — Stage 1-3 scores could exceed rubric bounds (0-100) when the LLM hallucinated values. Now clamped server-side. Radar prompt also tightened to enforce score ranges. (`canadian_llm_council_brain.py`) *Commit 1428254*
- **Opening Bell FMP stable API field name mismatches** — Several Opening Bell scanner fields were reading from camelCase keys when the FMP stable API returns snake_case. Fixed all field accessors. (`opening_bell_scanner.py`) *Commit a03b61a*
- **Intraday chart paths + Opening Bell ghost ticker filter** — Two fixes bundled. Spike It chart endpoint was returning 404 for some tickers due to URL path bug. Opening Bell was occasionally producing "ghost" picks (tickers that don't exist on TSX), now filtered out at the scanner level. (`api_server.py`, `opening_bell_scanner.py`) *Commit 6c806e9*
- **Historical edge multiplier applied pre-ranking** — The multiplier (which adjusts for past calibration accuracy) was being applied AFTER the Top 10 cutoff, so it never affected ranking. Now applied before ranking, as designed. (`canadian_llm_council_brain.py`) *Commit fc80e9d*

#### FMP Pipeline Infrastructure
- **FMP bulk profile cache** — Replaced 350+ per-ticker `/profile` calls with a single bulk download cached for 4 hours. Reduces a typical Council scan's API calls by ~80%. (`fmp_bulk_cache.py`, `canadian_llm_council_brain.py`) *Commit eb94c6a*

#### Opening Bell Quality Improvements
- **Opening Bell 5-layer data quality fix + UI consistency** — Bundled improvements: stricter pre-filter, sector momentum context, enriched LLM prompt with Radar overrides, news catalyst filter, and UI polish to match the Radar/Spikes card style. (`opening_bell_scanner.py`, `src/components/opening-bell/OpeningBellCard.tsx`) *Commit 7e74667*

#### Radar Quality Improvements
- **Radar quality improvements + portfolio integration** — Tightened Radar pre-filter to require both technical AND catalyst signals (was either-or), added missing portfolio lock-in entry points, and improved the Radar narrative formatting. (`canadian_llm_council_brain.py`, `src/components/radar/`) *Commit 7bf39d2*

#### Today's Spikes Pre-Filter
- **ETF filter for Spikes** — Today's Spikes was occasionally surfacing leveraged/inverse ETFs (HND, HNU, HOD, HOU, NRGU, VDY, VGRO, etc.) which are not legitimate spike candidates. Added an explicit blocklist at the pre-filter layer. (`canadian_llm_council_brain.py`) *Commit 087c090*
- **Spikes ADV threshold reverted to $5M** — A previous experiment raised the average daily volume threshold to filter out illiquid names; turned out to be too aggressive and was excluding legitimate mid-caps. Reverted to $5M. (`canadian_llm_council_brain.py`) *Commit c6852be*

#### Process & Documentation
- **Session 10 plan document** — Comprehensive multi-phase repair plan covering data hygiene, FMP infrastructure, Radar fixes, and Spikes filter improvements. Used as the implementation roadmap for the entire session. (`docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md`) *Commit 46f720f*
- **Executing-plans directive added** — Plan document updated with explicit handoff instructions to the executing-plans skill so subagents could resume mid-implementation. *Commit 9238164*
- **Regression checks + systematic debugging gate** — Added a Phase 0 to the plan that requires regression checks before any data changes, plus an explicit gate requiring systematic debugging skill use for any failure. *Commit 7332b0c*

---

### Session 11 — EODHD Migration + Full Finnhub Removal

#### EODHD News Integration
- **Unified `eodhd_news.py` shared module** — Single async module providing `fetch_news`, `fetch_news_batch`, and `get_sentiment_score` for all three pipelines (Radar, Opening Bell, Today's Spikes). Replaces a fragmented set of FMP and Finnhub calls. (`eodhd_news.py`) *Commit 513cd41*
- **Radar news rewired FMP → EODHD** — Radar scanner now pulls news from EODHD with article tags surfaced in the LLM prompt for richer catalyst detection. (`canadian_llm_council_brain.py`) *Commit 513cd41*
- **Opening Bell news rewired FMP → EODHD** — Opening Bell scanner uses EODHD via `fetch_news_batch` with concurrency control. (`opening_bell_scanner.py`) *Commit 513cd41*
- **Today's Spikes news + sentiment rewired FMP+Finnhub → EODHD** — Council brain's `StockDataPayload` now uses `news_sentiment` (from EODHD) instead of the old `finnhub_sentiment` field. (`canadian_llm_council_brain.py`) *Commit 513cd41*
- **Spike It news rewired FMP → EODHD** — Manual ticker analysis endpoint also uses EODHD. (`api_server.py`) *Commit 513cd41*
- **Opening Bell Layer 5 news catalyst filter** — Added a fifth quality layer to the Opening Bell scanner that requires recent positive-sentiment news for high-conviction picks. (`opening_bell_scanner.py`) *Commit 513cd41*

#### Finnhub Removal
- **All Finnhub Python code removed** — No more Finnhub API calls anywhere in the Python pipeline. Empty `finnhub_sentiment` field migrated to `news_sentiment`. (`canadian_llm_council_brain.py`, `opening_bell_scanner.py`, `api_server.py`) *Commit 513cd41*
- **FMP `fetch_news()`, `fetch_earnings_surprises()`, `/price-target-consensus` removed** — Three FMP endpoints that were returning empty `[]` for all .TO tickers (wasting API calls) are removed entirely. (`canadian_llm_council_brain.py`) *Commit 513cd41*
- **Finnhub frontend code removed** — Cleaned up `src/lib/fallback.ts` and other client-side references. *Commit 31bdec8*
- **Dead `NewsItem` class + inline imports cleanup** — Removed leftover dead code from the Finnhub-era news handling. Inline imports moved top-level. (`canadian_llm_council_brain.py`, `opening_bell_scanner.py`) *Commit 2883145*
- **`changesPercentage` → `changePercentage` typo fixed** — Both Radar prompt and Spike It had a typo that produced empty change percentage in the LLM context. (`canadian_llm_council_brain.py`, `api_server.py`) *Commit 2883145*

#### Configuration & Schema
- **`EODHD_API_KEY` added to docker-compose** — Environment variable wired through to all containers. `FINNHUB_API_KEY` removed. (`docker-compose.yml`, `.env.example`) *Commit 4ff2303*
- **`fmp_bulk_cache.py` restructured** — CSV-only for the whitelist, JSON-per-ticker for profiles. Reduces memory pressure. (`fmp_bulk_cache.py`) *Commit 513cd41*
- **`RadarLockInModal.tsx` created** — Dedicated lock-in modal for Radar picks (no fake 3/5/8-day targets — just smart money score and 5% stop loss, since Radar is a pre-scan signal not a directional prediction). (`src/components/radar/RadarLockInModal.tsx`) *Commit 513cd41*
- **Empty-movers guard in Opening Bell** — Added defensive check for empty mover lists from FMP. (`opening_bell_scanner.py`) *Commit 513cd41*

---

### Session 12 — Card Consistency + Radar Portfolio Integration

#### OpeningBellCard Layout Refactor
- **Aligned to SpikeCard reference design** — Square `rank-badge` class with rank-1/2/3 styling, amber top glow bar for top 3, single `flex items-start gap-4` header row, price inside info block under company name, hover-visible checkbox, narrative in styled box with amber info SVG icon. Removed redundant bell icon (already on Opening Bell page). (`src/components/opening-bell/OpeningBellCard.tsx`) *Commit 2f916d5*
- **`RadarIcon` shown only when `isRadarPick === true`** — Animated radar icon now only appears when the pick was reaffirmed by the upstream Radar scan, not on every Opening Bell card. *Commit 2f916d5*

#### RadarCard Layout Refactor
- **Aligned to SpikeCard reference design** — Same structural alignment as Opening Bell. Removed redundant pipeline status section ("✓ Opening Bell → ○ Awaiting Spikes") since Radar is the first pipeline stage and has nothing upstream to reference. Removed redundant `RadarIcon` next to ticker (already on the Radar page). Added `selected`, `onSelect`, `selectionMode` props for bulk operations. (`src/components/radar/RadarCard.tsx`) *Commit 5c371ba*

#### Radar Page Portfolio Integration
- **Selection mode + bulk lock-in + portfolio settings** — Radar page now has the full portfolio menu system matching Today's Spikes and Opening Bell: select picks, bulk lock-in modal, portfolio settings cog, confirmation toast. Replaced custom `glass-card` header with shared `MarketHeader` component (TSX/Oil/Gold/BTC/CAD indicators, same length as other pages). Removed `<div className="max-w-7xl mx-auto">` wrapper that was creating a gap between sidebar and content. (`src/app/radar/page.tsx`) *Commit 2d14240*
- **`setChosenPortfolioId` type fix** — Cancel handler had a `useState<string>` vs `string | undefined` mismatch. (`src/app/radar/page.tsx`) *Commit 89742d7*
- **Radar page layout aligned to Today's Spikes and Opening Bell** — Final structural pass to ensure all three pipeline pages have the same overall layout shape. (`src/app/radar/page.tsx`) *Commit eb61f50*

---

### Session 13 — Five Post-Deploy Bug Repairs + accuracy_records Recovery

#### Bug 1: Radar Archives Fix
- **Restored Radar tab listing in Archives** — `reports/page.tsx:86` was reading `json.reports` from a `/api/reports/radar` response that returns `json.data`. The Radar tab had been permanently empty since Session 11's deploy. Unified the success branch to use `json.data` for all three tabs (Spikes, Opening Bell, Radar). (`src/app/reports/page.tsx`) *Commit 2573c19*
- **XLSX download button added to Radar archive cards** — Radar cards previously only had a "View" button. Added an "XLSX" button matching the Spikes/Opening Bell pattern. (`src/app/reports/page.tsx`) *Commit 2573c19*
- **New Radar XLSX download API route** — `src/app/api/reports/radar/[id]/xlsx/route.ts` mirrors the Opening Bell xlsx route, generates a single-sheet workbook with rank, ticker, signal breakdown (Smart Money / Catalyst / News / Technical / Volume / Sector Alignment), catalyst + rationale text, pipeline pass-through flags, and actual open-day metrics. (`src/app/api/reports/radar/[id]/xlsx/route.ts`) *Commit 969b34b*

#### Bug 2: Move Radar Accuracy from Public to Admin
- **Radar Accuracy moved from public Accuracy Engine to Admin Council tab** — Radar is a pre-scan ranking tool, not a predictive forecast; measuring it as a win/loss binary is a category error. Display moved to Admin Council tab where it belongs. DB columns (`actualOpenPrice`, `actualOpenChangePct`, `openMoveCorrect`, `passedOpeningBell`, `passedSpikes` on `RadarPick`) remain populated by the 4:30 PM backfill cron. (`src/app/admin/page.tsx`, `src/app/api/admin/council/route.ts`) *Commit 5191379*
- **Removed Radar block from public Accuracy Engine API + page** — Cleaned up the orphaned Radar query, response payload, state, and render block from `/api/accuracy/route.ts` and `/app/accuracy/page.tsx`. (`src/app/api/accuracy/route.ts`, `src/app/accuracy/page.tsx`) *Commit 751f0ce*

#### Bug 3: EODHD Data Source Health Tracking
- **EODHD news API calls now tracked in `endpoint_health`** — Added optional `endpoint_health` parameter to `eodhd_news.fetch_news` and `fetch_news_batch`. When provided, calls bump `ok/404/429/error` counters under key `eodhd/news` — same shape as the FMP fetcher's `_track_endpoint`, so the admin Data Source Health dashboard displays EODHD rows alongside FMP rows without any frontend changes. Wired through at three call sites: `LiveDataFetcher.build_payload` (council brain line 896), `RadarScanner._news` inner closure (council brain line 4436), and `OpeningBellScanner.fetch_news_bulk` (line 134). Also added `from __future__ import annotations` so PEP 604 union syntax works on Python 3.9+ in addition to 3.10+ in production containers. (`eodhd_news.py`, `canadian_llm_council_brain.py`, `opening_bell_scanner.py`) *Commit 7664bdf*

#### Bug 4 + 5: Auto-Resolved by Recovery Script
- **`scripts/recover_accuracy_records.py` — One-time recovery script** — Rebuilds `accuracy_records` from Prisma `Spike.actual3Day/5Day/8Day` columns after Session 10's destructive `DELETE FROM accuracy_records` wiped 510+ rows of training data. Zero FMP calls. Uses `INSERT OR IGNORE` so it's safe to re-run. Skips orphan `pick_history` rows that have no Prisma match (Option C from Session 13 brainstorming). Prints before/after counts and a live gate-simulation at the end. Restored the table from 0 → 270 rows with 198 resolved samples, flipping Learning gates 1, 2, 4, 5, 6 back to ACTIVE. (`scripts/recover_accuracy_records.py`) *Commit 25c44c6*
- **Session 10 destructive DELETE deprecated** — Added a prominent `⚠️ DEPRECATED — DO NOT RUN` warning above the unconditional `DELETE FROM accuracy_records` line in the Session 10 plan. Preserved the audit trail while making it impossible to run unintentionally. (`docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md`) *Commit 25c44c6*

#### Admin UI Refinement (also Session 13)
- **LLM Stage Performance split into two cards** — "Stage Funnel & Calibration" (all 4 stages — Picks Scored, Avg Score, Score Range, In Top 10) and "Stage 4 Directional Accuracy" (Grok-only — 3d/5d/8d Hit Rate, Avg Predicted Move, Bias). Replaces the prior single table where stages 1-3 had three blank "—" hit-rate columns that looked like missing data. Stages 1-3 produce quality scores but no directional forecasts, so they cannot have a hit rate by design — making this clear in the UI removes confusion. (`src/app/admin/page.tsx`) *Commit 76a7f2c*
- **Learning gate label "resolved picks" → "resolved samples"** — The displayed count was `COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL` — the number of (pick × horizon) measurement records, not distinct picks. Each pick can produce up to 3 records (3d, 5d, 8d). At time of fix, 84 distinct picks had produced 198 resolved measurements. Only the label was wrong; gate thresholds (50, 100, 660) are correctly calibrated against the records count. (`src/app/admin/page.tsx`) *Commit 76a7f2c*

---

### Post-Session-13 — Final Polish

#### emailRadar Wiring Fix
- **`emailRadar` half-wired since v5.0 launch** — The `emailRadar` user preference toggle had been silently broken since the Radar feature shipped: GET `/api/user/preferences` did not include `emailRadar` in the select clause, PUT did not destructure or persist it, and the schema default was `false`. Result: every user had `emailRadar = false` and **zero Radar emails had ever been delivered in production**. The toggle on the settings page would visibly flip ON when clicked but reset to OFF as soon as the user navigated away. Three coordinated fixes: (1) GET endpoint now selects `emailRadar`, (2) PUT endpoint destructures and persists it, (3) schema default flipped from `false` to `true` so new users are auto-enrolled (matching the auto-enroll pattern used by every other email preference). (`src/app/api/user/preferences/route.ts`, `prisma/schema.prisma`) *Commit 3de45a9*
- **All 5 existing users backfilled to `emailRadar = true`** — One-time SQL `UPDATE "User" SET "emailRadar" = true WHERE "emailRadar" = false` on production Postgres. Verified post-update: 5/5 users opted in. *Operational, not a commit*
- **Schema applied via `npx prisma db push`** — Same pattern used elsewhere in the project for non-migration schema syncs. *Operational, not a commit*

#### Session 10 Plan File Hardened
- **All five destructive blocks in Phase 1 deprecated** — The original `accuracy_records` warning (Session 13) was extended to cover every destructive SQL block in Phase 1 of the Session 10 plan: section 1.1 (Opening Bell `DELETE WHERE date = CURRENT_DATE` — confirmed cause of Apr 6 OB data loss), section 1.2 (Radar trim by `CURRENT_DATE`), section 1.3 (Spike + PortfolioEntry ETF cleanup), section 1.4 (Spike Mar 24/25 trim), section 1.5 (SQLite `pick_history` / `stage_scores` / calibration / accuracy_records purge). Every line of executable SQL/Python in those sections is now commented out at the line level so copy-paste-and-run cannot accidentally trigger the destruction. Section banners explain the original bug, the fix at source, and what the post-mortem investigation found. A top-of-Phase-1 banner explicitly states the entire phase is deprecated and lists the confirmed casualties. (`docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md`) *Commit af1c90a*

#### Opening Bell Robustness
- **Tolerate zero-picks pre-market (mirror Radar pattern)** — `runOpeningBellAnalysis()` would throw if the Python scanner returned zero picks, killing the entire run before the Prisma write. The Radar analyzer (the working reference) tolerates zero picks and saves a valid 0-pick report. Aligned OB with the Radar pattern: still throws if scanner explicitly reported `success=false`, but tolerates empty picks and continues to upsert the report row with metadata. Guarded `prisma.openingBellPick.createMany` to skip on zero-picks days (avoids any Prisma version edge cases with empty payloads). Skip the OB email send when picks is empty (sending an empty Opening Bell email would confuse subscribers). The `OpeningBellReport` row still gets upserted with metadata (date, tickersScanned, scanDurationMs, sectorSnapshot) even on quiet days. Discovered during pre-cron systematic verification on 2026-04-07 using diff-against-working-Radar — yesterday's Apr 6 OB run produced 10 picks so this would not have changed history, but it eliminates a real fragility for future runs. (`src/lib/opening-bell-analyzer.ts`) *Commit 255fb79*

---

### Operational / Recovery Actions (not commits)

These actions were performed against production data during Session 13 + Post-13 work. They are recorded here as part of the v5.0a state even though they have no commit hash because they were SQL or one-time scripts run via `docker exec`.

- **`accuracy_records` rebuilt from Prisma Spike actuals** (Session 13, Task 16) — 0 → 270 rows, 198 resolved. All 5 gates that should be active flipped to ACTIVE.
- **Today's manual scan contamination cleanup** (Session 13 follow-up) — After triggering manual Council/Radar/OB scans during Task 17 verification, the user pointed out the off-hours data would contaminate learning. Scoped DELETE removed pick_ids 219-228 (10 picks, 36 stage_scores, 21 accuracy_records placeholders) — all unresolved, no gate impact.
- **Orphan dev/test data purge** (Session 13 follow-up) — 83 orphan `pick_history` rows from pre-release dev/test runs (different tickers than the corresponding Prisma Spike rows for the same dates) deleted, scoped to only rows with no Prisma counterpart. Affected dates: 2026-03-19 (18 rows, all orphan), 2026-03-20 (38 of 57), 2026-03-23 (9 of 19), 2026-03-24 (8 of 18), 2026-04-02 (10 of 19). Zero `accuracy_records` lost. Zero gate impact.
- **All 5 production users backfilled to `emailRadar = true`** (Post-13) — One-time SQL UPDATE.
- **Cron container fully verified pre-OB-fire** (Post-13) — 20 individual checks across cron schedule, network reachability, auth, timezone handling, route handler, Python endpoints, schema match, unique indexes. All passing.

---

### Summary Table

| Category | Count | Notes |
|---|---|---|
| New features | 6 | Radar XLSX route, Radar Accuracy admin card, EODHD news module, accuracy_records recovery script, Stage Performance split, emailRadar wiring |
| Bug fixes | 18+ | Across Sessions 10-13 |
| Refactors | 6 | Card alignment work in Session 12 + LLM Stage Performance split + accuracy display move |
| Deprecations | 1 | Session 10 Phase 1 (all destructive SQL blocks) |
| Operational fixes | 5 | Data recovery, cleanup, backfills (no commits) |
| Total commits | 33 | v5.0 (c3eb05a) → v5.0a (255fb79) |

### Tag Update

**v5.0a** (local annotated tag) re-pointed from commit `76a7f2c` (Session 13 + admin polish) to **commit `<TBD — this changelog commit>`** (includes all post-Session-13 fixes and the v5.0a changelog itself).

Original v5.0a was a snapshot of the state when the user first requested a backup tag during Session 13. v5.0a is now a snapshot of the post-emailRadar-fix, post-deprecation, post-zero-picks-fix state — the actual production-deployed v5.0a.

---



### Overview

Version 5.0 introduces the **Smart Money Flow Radar**, a pre-market scanner that runs at 10:05 AM AST on trading days to detect institutional-grade signals before the opening bell. The Radar scores every liquid TSX/TSXV ticker using a multi-signal conviction framework — combining technical momentum, catalyst events, and volume anomalies — then feeds its top picks forward into the Opening Bell and Today's Spikes pipelines via an override bridge. Alongside the headline feature, v5.0 upgrades the entire data pipeline to FMP Ultimate (1-minute intraday bars, bulk earnings calendar), migrates Spike It and Council Stage 4 to the SuperGrok Heavy Multi-Agent model, hardens security across all API routes, and delivers a full suite of UI additions including a dedicated Radar page, animated radar icons, email alerts, accuracy tracking, and admin integration.

---

### New Features

#### Smart Money Flow Radar — Core Engine
- **Radar Pydantic models** — `RadarScoreBreakdown`, `RadarPick`, and `RadarResult` data models for the scanner's output, including conviction scores, signal breakdowns, and ranked pick lists. (`canadian_llm_council_brain.py`) *Commit 1837a79*
- **RadarScanner class** — Full pre-market signal detection engine that scans all liquid TSX/TSXV tickers, applies a multi-signal scoring framework (technical indicators, catalyst events, volume anomalies), filters by liquidity and catalyst presence, batches candidates through the LLM council, and produces ranked picks with conviction scores. 376 lines of new scanning logic. (`canadian_llm_council_brain.py`) *Commit 94c77b4*
- **Radar FastAPI endpoints** — Four new Python API endpoints: `/run-radar` (trigger scan), `/run-radar-status` (poll progress), `/radar-health` (data source status), and `/latest-radar-output` (fetch results). (`api_server.py`) *Commit 1814f75*
- **Radar scanner tests** — Integration and model validation tests for the Radar scanner. (`tests/test_radar_scanner.py`) *Commit f550bb8*

#### Smart Money Flow Radar — Next.js Integration
- **Radar analyzer** — TypeScript bridge that triggers the Python Radar scanner, polls for completion, saves results to Prisma (RadarReport + RadarPick records), and writes an override file for downstream pipelines. (`src/lib/radar-analyzer.ts`) *Commit 73a84cf*
- **Radar API routes** — Three new Next.js API routes: `/api/cron/radar` (cron trigger), `/api/radar` (data endpoint for the Radar page), and `/api/reports/radar` (paginated historical reports). (`src/app/api/cron/radar/route.ts`, `src/app/api/radar/route.ts`, `src/app/api/reports/radar/route.ts`) *Commit 03b96e0*
- **Radar cron job** — Scheduled at 10:05 AM AST on weekdays via `scripts/start-cron.ts`. Runs before Opening Bell (9:15 AM) and Today's Spikes (10:35 AM) so its picks propagate through the full pipeline. *Commit a69eec6*
- **`?force=true` param for Radar cron** — Allows triggering Radar on weekends and holidays for testing without waiting for a trading day. (`src/app/api/cron/radar/route.ts`) *Commit f8051fb*
- **Prisma schema: RadarReport and RadarPick models** — New database tables for storing Radar scan results, including report-level metadata and per-pick details (ticker, score breakdown, direction, catalyst summary). Added `User.emailRadar` field for email opt-in. (`prisma/schema.prisma`) *Commit 2936e9c*
- **Radar accuracy tracking fields** — Added `actualOpenPrice`, `actualOpenChangePct`, `actualDayHigh`, `actualClose`, `openMoveCorrect`, and `pipelineFlags` to `RadarPick` for measuring prediction accuracy after market close. (`prisma/schema.prisma`) *Commit 6d1c126*

#### Pipeline Override Bridge (Radar → Opening Bell → Spikes)
- **Opening Bell reads Radar override file** — The Opening Bell analyzer now reads a JSON override file written by Radar, giving priority to Radar-flagged tickers so they flow through the full pipeline. (`src/lib/opening-bell-analyzer.ts`) *Commit b1649fb*
- **isRadarPick cross-reference** — The `/api/spikes` and `/api/opening-bell` endpoints now check each ticker against today's Radar picks and attach an `isRadarPick` flag, enabling UI badges downstream. (`src/app/api/spikes/route.ts`, `src/app/api/opening-bell/route.ts`) *Commit 272c28d*

#### FMP Ultimate Data Endpoints
- **FMP Ultimate endpoint verification** — Test script verifying which FMP Ultimate-only endpoints work for Canadian `.TO` tickers. Found that 1-min bars, earnings surprises, and transcripts return 404; only grades and sector-performance work. Informed the graceful degradation strategy. (`tests/test_fmp_ultimate.py`) *Commit 780d8de*
- **Three new LiveDataFetcher methods** — `fetch_1min_bars` (1-min to 5-min fallback chain), `fetch_earnings_surprises` (last 8 quarters of EPS data), and `fetch_earnings_transcript` (truncated call transcripts). All use graceful degradation when endpoints return 404 for Canadian tickers. (`canadian_llm_council_brain.py`) *Commit e1f966d*
- **Spike It 1-min intraday bars** — Replaced the single 5-min fetch with a 1-min → 5-min → synthetic fallback chain. Tracks `bar_interval` so data limitation messages are accurate. (`api_server.py`) *Commit 5b0d1dc*
- **Opening Bell 1-min bar preference** — Opening Bell scanner now prefers 1-min bars over 5-min, with fallback. (`opening_bell_scanner.py`) *Commit 226e89b*
- **Earnings surprise history in StockDataPayload** — Added `earnings_surprise_history` and `earnings_transcript_summary` fields to the data payload passed to the LLM council, enriching its analysis context. Fetches in parallel with existing data. (`canadian_llm_council_brain.py`) *Commit 2a519cd*
- **Bulk profile fetch** — New `fetch_profiles_bulk()` that tries the FMP `/batch-profile` endpoint first, falling back to per-ticker `fetch_profiles_batch()`. Reduces profile fetch time from ~35s to ~5s. (`canadian_llm_council_brain.py`) *Commit b58c6f0*
- **Bulk earnings calendar** — Replaced dead per-ticker `/earnings-surprises/{ticker}` endpoint (404 for all .TO tickers, wasting 352 API calls) with a single bulk `/earnings-calendar` call, plus Finnhub `/calendar/earnings` as backup. (`canadian_llm_council_brain.py`) *Commit 8d14cb0*

#### SuperGrok Heavy Multi-Agent Integration
- **Spike It + Council Stage 4 model upgrade** — Replaced `grok-4-0709` with `grok-4.20-multi-agent-0309` using the xAI Responses API (`/v1/responses` endpoint). New `_call_grok_multi_agent()` method. Opus fallback removed from Spike It (SuperGrok Heavy only), retained for Council Stage 4 reliability. Admin LLM pricing updated to $2/$6 per 1M tokens. (`api_server.py`, `canadian_llm_council_brain.py`) *Commit b468e9b*

#### Learning Engine & Accuracy Tracking
- **Source tagging** — Learning engine now tags every pick with its source: `council` (direct council pick), `council_via_ob` (via Opening Bell), or `council_via_radar` (via Radar). Enables per-pipeline accuracy analysis. (`canadian_llm_council_brain.py`) *Commit 8d2ed52*
- **Radar accuracy backfill** — The accuracy check endpoint now backfills Radar picks with actual open price, day high, and close price data, and updates `pipelineFlags` (e.g., `radar_only`, `radar_and_ob`, `full_pipeline`). (`src/app/api/accuracy/check/route.ts`) *Commit a652990*
- **Radar accuracy scorecard** — New scorecard on the accuracy page showing Radar open-direction hit rate (did the stock move in the predicted direction at open?). New API route provides the data. (`src/app/accuracy/page.tsx`, `src/app/api/accuracy/route.ts`) *Commit 027411a*

#### Admin Panel Integration
- **Radar health, status, and manual trigger** — Admin panel now shows Radar scanner health, last run status, and a manual trigger button alongside existing Opening Bell and Today's Spikes controls. (`src/app/admin/page.tsx`, `src/app/api/admin/council/route.ts`) *Commit 25ffb3a*

#### Archives Integration
- **Radar tab in archives** — The reports/archives page now has a Radar tab with full report card rendering, showing historical Radar scans with pick details, scores, and conviction breakdowns. (`src/app/reports/page.tsx`) *Commit 02c7b3f*

#### Email Alerts
- **Radar email template** — New email template for Radar alerts, wired into the radar-analyzer to send after each scan completes. (`src/lib/email/radar-email.ts`, `src/lib/radar-analyzer.ts`) *Commit a01e619*
- **Green RADAR badges in existing emails** — Opening Bell, Daily Spikes, and Council emails now show a green "RADAR" badge next to tickers that were flagged by the pre-market scanner. The Opening Bell email queries the RadarPick table; the Council email reads from in-memory radar picks. (`src/lib/email/opening-bell-email.ts`, `src/lib/email/resend.ts`, `src/lib/scheduling/analyzer.ts`, `api_server.py`, `canadian_portfolio_interface.py`) *Commit b7273c5*
- **emailRadar toggle on settings page** — Users can opt in or out of Radar email alerts independently of other email notifications. (`src/app/settings/page.tsx`) *Commit 646095c*

---

### Bug Fixes

#### TSX Holiday Calendar (3 bugs)
- **Victoria Day calculation** — Used May 25 as the anchor instead of May 24, producing the wrong date when May 25 falls on a Monday (e.g., 2026 returned May 25 instead of May 18). Fixed anchor to May 24. (`src/lib/utils/index.ts`) *Commit 5e5201a*
- **Civic Holiday missing** — TSX closes on the 1st Monday in August; this holiday was entirely absent from the calendar. Added it. (`src/lib/utils/index.ts`) *Commit 5e5201a*
- **Christmas/Boxing Day weekend observation** — No logic existed for when Dec 25/26 fall on weekends. Added substitute weekday observation rules matching TSX policy. (`src/lib/utils/index.ts`) *Commit 5e5201a*

#### Adaptive Pre-Filter
- **Premature activation** — Mechanism #7 (the Adaptive Pre-Filter) activated with only ~326 resolved records (~2 weeks of data), far too little for reliable RSI/ADX/volume range adjustments. Raised the gate from 300 to 660 resolved picks, ensuring ~1 month of data before the filter begins adjusting. (`canadian_llm_council_brain.py`) *Commit e053292*

#### Radar Scanner Fixes
- **Radar analyzer polling pattern** — The Python `/run-radar` endpoint returns immediately (background task), but the analyzer was treating it as synchronous. Fixed to use the trigger+poll+fetch pattern (matching Opening Bell's approach). (`src/lib/radar-analyzer.ts`) *Commit 7f4ad0d*
- **None price/volume in liquidity filter** — FMP quotes can return `null` for price/volume fields. The filter used `.get(key, 0)` which doesn't handle explicit `None` values. Switched to `or 0` pattern. (`canadian_llm_council_brain.py`) *Commit bac9802*
- **Pre-score filter too permissive** — All 352 liquid tickers passed because technical signals alone (RSI/ADX) match nearly everything. Now requires at least one catalyst signal (news, analyst grades, or earnings surprise), caps candidates at 60 sorted by signal count to keep LLM batches under the 600s timeout. Later loosened slightly to allow strong technical setups (RSI < 30 or > 70 AND ADX > 25) through without a catalyst. (`canadian_llm_council_brain.py`) *Commits d5ccc07, 8d14cb0*
- **Read-only container filesystem** — Radar override file was written to `/app` directory, which is read-only in the Docker multi-stage build. Both writer (radar-analyzer) and reader (opening-bell-analyzer) run in the same container, so moved to `/tmp`. (`src/lib/radar-analyzer.ts`, `src/lib/opening-bell-analyzer.ts`) *Commit 73c0354*

#### Spike It Hardening
- **1-min bar fallback** — Added explicit logging for stale bars, timeout handling, and exception-specific error messages for the intraday bar fallback chain. (`api_server.py`) *Commit 2799aa6*

#### Dead API Endpoint Cleanup
- **Per-ticker earnings-surprises removed from Council** — Removed `_fetch_earnings_surprises_batch()` which made 352 individual `/earnings-surprises/{ticker}` calls, all returning 404 for .TO tickers. The working bulk `/earnings-calendar` was already in use. (`canadian_llm_council_brain.py`) *Commit 1cb4a40*

#### Resend SDK Build Crash
- **Lazy-init Resend client** — The Resend SDK was instantiated at module scope, crashing `next build` when `RESEND_API_KEY` is absent during static page collection. Switched to lazy initialization via `getResend()`. (`src/lib/email/resend.ts`) *Commit d562111*

#### Prisma Model Name
- **Correct model name for radar market header** — Used wrong Prisma model name; fixed to `dailyReport`. (`src/app/api/radar/route.ts`) *Commit f1ce369*

#### Radar Page Market Indicators
- **Removed stale market indicators** — Radar runs pre-market when the market is closed, so regime badge and price indicators were stale/misleading. Replaced MarketHeader with a simple title + date header with RadarIcon. (`src/app/radar/page.tsx`, `src/app/api/radar/route.ts`) *Commit e29f890*

#### Time Display Corrections
- **Opening Bell time** — Fixed from "9:45 AM ET" to "10:35 AM AST" in admin panel and spec docs. *Commit b468e9b*

#### Accuracy Backfill Logic
- **Falsy price check** — Accuracy backfill used `!closingPrice` which treats `0` as falsy. Fixed to `closingPrice === undefined`. (`src/app/api/accuracy/check/route.ts`) *Commit 7058239*

#### Timezone Consistency
- **Radar and Opening Bell analyzers** — Both now consistently use `America/Halifax` timezone instead of mixed timezone references. (`src/lib/radar-analyzer.ts`, `src/lib/opening-bell-analyzer.ts`) *Commit 7058239*

---

### Security Improvements

- **Unprotected admin analytics endpoint** — Added `requireAdmin()` guard to `/api/admin/analytics`, which was previously accessible without authentication. (`src/app/api/admin/analytics/route.ts`) *Commit 7058239*
- **Unprotected Radar endpoints** — Added `isAuthenticated()` checks to `/api/reports/radar` and `/api/radar`, which were previously open. (`src/app/api/radar/route.ts`, `src/app/api/reports/radar/route.ts`) *Commit 7058239*
- **Pagination size cap** — Capped `pageSize` to 100 on all paginated report endpoints to prevent abuse via excessively large page requests. (`src/app/api/reports/route.ts`, `src/app/api/reports/radar/route.ts`, `src/app/api/reports/opening-bell/route.ts`) *Commit 7058239*
- **Error message sanitization** — Replaced `String(error)` with `error.message` across 11 API routes, preventing accidental leakage of stack traces or internal details in error responses. *Commit 7058239*

---

### Performance Optimizations

- **Batch sizes and parallelism for FMP Ultimate** — Profile fetch semaphore increased from 3 to 10, batch size from 20 to 50, inter-batch delay reduced from 8s to 3s. Quote batch size increased from 50 to 100. Takes advantage of the FMP Ultimate tier's 3,000 calls/min rate limit. Profile fetch time reduced from ~35s to ~5s. (`canadian_llm_council_brain.py`) *Commit 611c79c*
- **Radar candidate cap at 60** — Ensures LLM scoring batches (15 per batch = 4 batches) complete well within the 600s timeout, preventing wasted API calls on marginal candidates. (`canadian_llm_council_brain.py`) *Commit d5ccc07*
- **Bulk profile fetch in Radar scanner** — Added `fetch_profiles_bulk()` to the Radar scanner to resolve sector data, fixing "Unknown" sectors while reducing API call count. (`canadian_llm_council_brain.py`) *Commit 7058239*

---

### UI/UX Changes

#### New Radar Page
- **Radar page** — Dedicated page at `/radar` with a green matrix theme, showing today's Radar picks as ranked cards with conviction scores. (`src/app/radar/page.tsx`) *Commit 70d0601*
- **RadarCard component** — Card component displaying rank badge, ticker, animated RadarIcon, exchange/sector pills, conviction score with color coding, direction indicator, and catalyst summary. Redesigned to match SpikeCard layout for visual consistency. (`src/components/radar/RadarCard.tsx`) *Commits 70d0601, 7447147*
- **RadarIcon component** — Animated SVG radar sweep icon with custom `radar-green` color (#00ff41). Used across the Radar page, card headers, and sidebar. (`src/components/radar/RadarIcon.tsx`, `tailwind.config.ts`) *Commit 7e81479*
- **Radar page layout** — Wrapped in ResponsiveLayout with sidebar. Simple title + date header (no market indicators, since Radar runs pre-market). (`src/app/radar/page.tsx`) *Commits f737f98, e29f890*

#### Sidebar Navigation
- **Radar nav item** — Added to sidebar in first position with green theme and animated RadarIcon. (`src/components/layout/Sidebar.tsx`) *Commit 5f8122e*
- **Chronological pipeline order** — Sidebar nav reordered to match pipeline execution sequence: Radar → Opening Bell → Today's Spikes. (`src/components/layout/Sidebar.tsx`) *Commit 8ce2c64*

#### Card Header Badges
- **Animated Radar icon on SpikeCard and OpeningBellCard** — Cards for tickers flagged by Radar show an animated radar sweep icon. (`src/components/spikes/SpikeCard.tsx`, `src/components/opening-bell/OpeningBellCard.tsx`, `src/types/index.ts`) *Commit 49bd322*
- **Chronological badge order** — All three card types now follow: Ticker → Exchange → Sector → Radar → Bell. RadarIcon increased to 24px, bell emoji increased to text-xl with ring animation. Opening Bell cards always show bell badge. (`src/components/spikes/SpikeCard.tsx`, `src/components/radar/RadarCard.tsx`, `src/components/opening-bell/OpeningBellCard.tsx`) *Commit b5acfc3*

#### Version and Footer
- **Version bump to 5.0** — Updated version display from 4.0 to 5.0 across all 10 pages. Radar page footer standardized to use `legal-footer` class with full disclaimer. *Commit 1333914*

#### Admin Panel Redesign
- **Pipeline-ordered layout** — Admin Council tab sections reordered to match actual pipeline flow: Server Status → Radar → Opening Bell → Today's Spikes → Cost Breakdown → Errors → Recent Reports → Data Source Health (broken into per-scanner sections). (`src/app/admin/page.tsx`) *Commit b9c596d*
- **Consolidated status cards** — Single Python Server status card at top, Last Run date column added to Radar and Opening Bell cards (4-col grid), Today's Spikes header shows date + picks + duration. (`src/app/admin/page.tsx`) *Commit 1cb4a40*
- **Inline Run buttons** — Moved Run Council Scan button into Today's Spikes card header, matching the inline pattern used by Radar and Opening Bell. Removed redundant standalone Manual Scan section. (`src/app/admin/page.tsx`) *Commit 432449f*
- **Persisted health data** — Radar and Opening Bell health endpoints now fall back to persisted output files on disk, surviving container restarts. Normalized radar-health response format to match opening-bell-health. (`api_server.py`, `src/app/api/admin/council/route.ts`) *Commit 432449f*

---

### Data Pipeline Changes

- **Three-stage pipeline** — v5.0 establishes a clear three-stage daily pipeline: Radar (10:05 AM AST) → Opening Bell (9:15 AM AST) → Today's Spikes (10:35 AM AST). Radar feeds priority tickers forward via an override file.
- **1-min intraday bars** — All three scanners now prefer 1-min bars over 5-min, with automatic fallback chains. Provides more granular intraday data for analysis.
- **Bulk earnings calendar** — Single bulk API call replaces 352 individual per-ticker calls that were all returning 404. Finnhub backup ensures coverage.
- **Source-tagged learning records** — Every pick flowing through the learning engine is tagged with its pipeline origin, enabling per-stage accuracy measurement.
- **Radar accuracy lifecycle** — Radar picks are created at scan time, then backfilled with actual market data (open price, day high, close) by the accuracy check endpoint, with `pipelineFlags` tracking how far each pick traveled through the pipeline.
- **SuperGrok Heavy for Spike It** — Spike It and Council Stage 4 now use the `grok-4.20-multi-agent-0309` model via the xAI Responses API, replacing the previous `grok-4-0709`.

---

### Infrastructure & DevOps

- **Cache file cleanup** — Removed accidentally committed `.claude/` cache files (brainstorm server logs, PID files, HTML content files — 1,734 lines deleted) and updated `.gitignore` to prevent recurrence. *Commit a5d9f9f*
- **tsconfig test exclusion** — Excluded `tests/` directory from tsconfig to resolve 15 missing `@types/jest` type errors that were breaking IDE analysis. (`tsconfig.json`) *Commit d562111*
- **Lazy Resend initialization** — Resend email client moved from module-scope instantiation to lazy `getResend()` function, preventing build crashes when `RESEND_API_KEY` is absent during static page collection. (`src/lib/email/resend.ts`) *Commit d562111*
- **Read-only container compatibility** — Override file path changed from `/app` to `/tmp` for compatibility with Docker multi-stage build containers where the app directory is read-only. *Commit 73c0354*
- **Polling loop resilience** — Both radar-analyzer and opening-bell-analyzer polling loops wrapped in try-catch to prevent crashes on transient network errors. (`src/lib/radar-analyzer.ts`, `src/lib/opening-bell-analyzer.ts`) *Commit 7058239*
- **Version bump** — `package.json` version updated to 5.0. *Commit efe5a21*

---

### Documentation

- **v5.0 Design Spec** — Complete design specification covering Radar scanner architecture, FMP endpoint integration (1-min bars, earnings transcripts, earnings surprises), database schema, API/cron changes, and frontend additions. 478 lines. (`docs/superpowers/plans/2026-04-04-smart-money-radar-v5-design.md`) *Commit 3a1526b*
- **v5.0 Implementation Plan** — 23 tasks across 6 phases with 4 session transitions. Covers FMP verification, endpoint integration, Radar scanner (Python + FastAPI), Radar integration (Prisma/Next.js), frontend (page, icons, cards, reports), and email/cron/versioning. 2,287 lines. (`docs/superpowers/plans/2026-04-04-smart-money-radar-v5.md`) *Commit d988f10*
- **Plan amendments** — Three subsequent amendments added batch optimization tasks (6a-6c), bulk migration, Spike It hardening, and learning engine/accuracy/admin/archives integration tasks (15a-15f). *Commits c489bf7, d28a6ee*

---

### Commit Index

All 58 commits from v4.0 to v5.0, in chronological order:

| # | Hash | Summary |
|---|------|---------|
| 1 | a5d9f9f | chore: remove accidentally committed cache files, update gitignore |
| 2 | 5e5201a | fix: TSX holiday calendar — Victoria Day, Civic Holiday, Christmas/Boxing Day |
| 3 | e053292 | fix: raise Adaptive Pre-Filter gate from 300 to 660 resolved picks |
| 4 | 3a1526b | docs: add v5.0 Smart Money Flow Radar design spec |
| 5 | d988f10 | docs: add v5.0 Smart Money Flow Radar implementation plan |
| 6 | c489bf7 | docs: amend v5.0 plan — add batch optimization, bulk migration, Spike It hardening |
| 7 | d28a6ee | docs: add learning engine, accuracy, admin, archives integration to v5.0 |
| 8 | 780d8de | test: add FMP Ultimate endpoint verification for Canadian stocks |
| 9 | e1f966d | feat: add FMP Ultimate endpoints to LiveDataFetcher |
| 10 | 5b0d1dc | feat: upgrade Spike It to use real 1-min intraday bars with fallback chain |
| 11 | 226e89b | feat: upgrade Opening Bell to prefer 1-min bars over 5-min |
| 12 | 2a519cd | feat: add earnings surprise history to StockDataPayload |
| 13 | 2799aa6 | fix: harden Spike It 1-min bar fallback with freshness validation |
| 14 | 611c79c | perf: optimize batch sizes and parallelism for FMP Ultimate 3000 calls/min |
| 15 | b58c6f0 | feat: add bulk profile fetch with fallback to per-ticker |
| 16 | 1837a79 | feat: add Radar Pydantic models |
| 17 | 94c77b4 | feat: implement RadarScanner class with pre-market signal detection |
| 18 | 1814f75 | feat: add Radar FastAPI endpoints |
| 19 | f550bb8 | test: add Radar scanner integration and model validation tests |
| 20 | 2936e9c | feat: add RadarReport, RadarPick models and User.emailRadar field |
| 21 | 73a84cf | feat: add Radar analyzer (Python trigger, Prisma save, override file) |
| 22 | 03b96e0 | feat: add Radar API routes (cron trigger, data endpoint, paginated reports) |
| 23 | 272c28d | feat: add isRadarPick cross-reference to spikes and opening-bell routes |
| 24 | b1649fb | feat: Opening Bell analyzer reads Radar override file for priority tickers |
| 25 | 6d1c126 | feat: add accuracy tracking fields to RadarPick |
| 26 | 8d2ed52 | feat: add source tagging to learning engine |
| 27 | a652990 | feat: add Radar accuracy backfill and pipeline flag updates |
| 28 | 25ffb3a | feat: add Radar health, status, and manual trigger to admin panel |
| 29 | 027411a | feat: add Radar accuracy scorecard to accuracy page |
| 30 | 02c7b3f | feat: add Radar tab to archives |
| 31 | 7e81479 | feat: add RadarIcon component with animated sweep |
| 32 | 49bd322 | feat: add animated Radar icon to SpikeCard and OpeningBellCard |
| 33 | 70d0601 | feat: add Radar page and RadarCard component |
| 34 | 5f8122e | feat: add Radar nav item to sidebar |
| 35 | 646095c | feat: add emailRadar toggle to settings page |
| 36 | a69eec6 | feat: add Radar cron job at 10:05 AM AST weekdays |
| 37 | a01e619 | feat: add Radar email template and wire into analyzer |
| 38 | efe5a21 | chore: bump version to 5.0 |
| 39 | b468e9b | fix: switch Spike It + Council Stage 4 to SuperGrok Heavy Multi-Agent |
| 40 | f8051fb | feat: add ?force=true param to Radar cron |
| 41 | 7f4ad0d | fix: radar-analyzer uses trigger+poll+fetch pattern |
| 42 | bac9802 | fix: handle None price/volume in Radar liquidity filter |
| 43 | d5ccc07 | fix: tighten Radar pre-score filter — require catalyst signal, cap at 60 |
| 44 | 73c0354 | fix: write radar override file to /tmp (read-only container) |
| 45 | b7273c5 | feat: add green RADAR badges to Spikes and Opening Bell email templates |
| 46 | 8d14cb0 | fix: replace dead per-ticker earnings-surprises with bulk earnings-calendar |
| 47 | b9c596d | refactor: reorder admin Council tab to match pipeline sequence |
| 48 | 432449f | fix: persist radar/OB health to disk, integrate Run button into Today's Spikes |
| 49 | 1cb4a40 | fix: remove dead per-ticker earnings-surprises from Council, add last run dates |
| 50 | 8ce2c64 | fix: reorder sidebar nav to chronological pipeline sequence |
| 51 | f737f98 | fix: add sidebar and market header to Radar page |
| 52 | f1ce369 | fix: use correct Prisma model name (dailyReport) for radar market header |
| 53 | e29f890 | fix: remove market indicators from Radar page |
| 54 | 1333914 | fix: update all pages to Ver 5.0 and standardize legal footer |
| 55 | 7447147 | fix: redesign RadarCard to match SpikeCard layout |
| 56 | b5acfc3 | fix: reorder card header badges to chronological pipeline sequence |
| 57 | d562111 | fix: lazy-init Resend client and exclude tests from tsconfig |
| 58 | 7058239 | fix: systematic audit — security, runtime, and data pipeline fixes |
