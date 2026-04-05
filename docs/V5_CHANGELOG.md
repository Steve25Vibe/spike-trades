# Spike Trades v5.0 — Smart Money Flow Radar
## Changelog: v4.0 → v5.0

**Release Date:** 2026-04-04
**Commits:** 48 (6914b90..7058239)
**Tag Line:** Pre-market intelligence meets autonomous AI stock analysis

---

### Overview

Version 5.0 introduces the **Smart Money Flow Radar**, a pre-market scanner that runs at 8:15 AM AST on trading days to detect institutional-grade signals before the opening bell. The Radar scores every liquid TSX/TSXV ticker using a multi-signal conviction framework — combining technical momentum, catalyst events, and volume anomalies — then feeds its top picks forward into the Opening Bell and Today's Spikes pipelines via an override bridge. Alongside the headline feature, v5.0 upgrades the entire data pipeline to FMP Ultimate (1-minute intraday bars, bulk earnings calendar), migrates Spike It and Council Stage 4 to the SuperGrok Heavy Multi-Agent model, hardens security across all API routes, and delivers a full suite of UI additions including a dedicated Radar page, animated radar icons, email alerts, accuracy tracking, and admin integration.

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
- **Radar cron job** — Scheduled at 8:15 AM AST on weekdays via `scripts/start-cron.ts`. Runs before Opening Bell (9:15 AM) and Today's Spikes (10:35 AM) so its picks propagate through the full pipeline. *Commit a69eec6*
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

- **Three-stage pipeline** — v5.0 establishes a clear three-stage daily pipeline: Radar (8:15 AM AST) → Opening Bell (9:15 AM AST) → Today's Spikes (10:35 AM AST). Radar feeds priority tickers forward via an override file.
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

All 48 commits from v4.0 to v5.0, in chronological order:

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
| 36 | a69eec6 | feat: add Radar cron job at 8:15 AM AST weekdays |
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
