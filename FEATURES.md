# Spike Trades — Version History & Feature Changelog

---

## Ver 3.5 — API Cost Tracking + Model Upgrades (2026-04-01)
- **API Cost Tracking** — Per-stage token usage and cost breakdown on Admin panel. Shows input/output tokens and dollar cost for each LLM stage (Sonnet, Gemini, Opus, Grok).
- **Model Upgrades** — Sonnet 4 → 4.6 (same cost, better quality), Opus 4 → 4.6 (66% cost reduction: $15/$75 → $5/$25 per MTok).

---

## Ver 3.2 — Spike It Health Check (2026-04-01)
- **Spike It** — Live intraday health check button on portfolio tiles, powered by SuperGrok Heavy. Shows continuation probability, expected move, real-time chart, key levels, and risk warnings.

---

## Ver 3.1 — Reliability & Admin Intelligence (March 30, 2026)

### Vertex AI Migration
- Stage 2 (Gemini) migrated from public API to Vertex AI — eliminates recurring 503 errors
- Uses Google Cloud regional infrastructure (Montreal) with SLAs for reliable Stage 2 execution
- Service account authentication replaces API key

### Analytics Audit & Fix
- Fixed orphaned Python backfill — SQLite accuracy records now populated by 4:35 PM cron
- Analytics tab shows last_updated timestamps and sample counts on every metric
- Low sample (<10) and stale data (>24h) badges warn when numbers are not trustworthy
- Learning Engine calibration now receives correct accuracy data

### Live Run Status
- Real-time stage pipeline visualization on Admin Council tab
- Shows: Pre-filter, Sonnet, Gemini, Opus, Grok, Consensus with batch progress
- Completed stages show pick counts and duration, skipped stages show reason
- Works for both scheduled (10:45 AM) and manually triggered runs
- Polling interval reduced to 10 seconds during active runs

### Dividend Display
- Dividend badge on analysis page header for dividend-paying stocks (amount + ex-date)
- Ex-dividend warning banner when ex-date falls within the 3-8 day prediction window
- Display-only — does not affect council scoring or LLM prompts
- Graceful degradation if FMP dividend endpoint unavailable

---

## Ver 1.0 — Foundation Release (March 19, 2026)

### Core LLM Council Brain (Sessions 1-4)

**4-Stage LLM Council Pipeline:**
- Stage 1 (Claude Sonnet 4.6): Screens entire TSX universe to Top 100 using 100-point rubric
- Stage 2 (Gemini 3.1 Pro): Independent re-scorer, narrows to Top 80 with disagreement tracking
- Stage 3 (Claude Opus 4.6): Devil's advocate challenger — kill conditions, worst-case scenarios, narrows to Top 40
- Stage 4 (SuperGrok Heavy): Final authority — Top 20 with 3/5/8-day probabilistic forecasts, Opus fallback if Grok unavailable

**Data Layer:**
- LiveDataFetcher: Async FMP `/stable/` API client with freshness validation
- Batch quotes, historical OHLCV (90 days), company profiles, news articles
- Finnhub sentiment integration (news-count heuristic)
- SSL fix for Python 3.14 + macOS (certifi)

**Technical Indicators (computed locally, not LLM-derived):**
- RSI (14-period), MACD (line, signal, histogram), ADX (14-period), ATR (14-period)
- Bollinger Bands (20,2), SMA-20, SMA-50, Volume SMA-20, Relative Volume

**Macro Regime Detection:**
- Oil (USO proxy), Gold, TSX (XIU proxy), CAD/USD, VIX, US 10Y yield
- Regime classification: RISK_ON, RISK_OFF, COMMODITY_BOOM, COMMODITY_BUST, NEUTRAL
- Sector-based score adjustments per regime

**Persistence & Risk Engine:**
- HistoricalPerformanceAnalyzer: SQLite-backed pick tracking + accuracy analysis
- Noise filter: drops tickers below 53% accuracy (requires 5+ historical picks)
- Edge multipliers: >60% accuracy = 1.10 boost, >55% = 1.05, <53% = dropped
- RiskPortfolioEngine: ATR-based position sizing, conviction-based risk (1-2% per trade), 30% heat cap
- CompoundingRoadmapEngine: 10-trading-day rolling roadmap with confidence bands (sqrt-time widening)

**Consensus & Scoring:**
- Cross-stage consensus counting with weighted scoring (S1: 15%, S2: 20%, S3: 30%, S4: 35%)
- Conviction tiering: HIGH (score >= 80 + 3+ stages), MEDIUM (>= 65 or 2+ stages), LOW
- CouncilFactChecker: validates LLM outputs against raw data (price mismatches, score arithmetic, forecast validity)

**Portfolio Interface (5 render formats):**
- Console: terminal-friendly aligned columns
- Markdown: GFM tables for docs/logging
- HTML Email: self-contained dark-theme with inline CSS, cyberpunk aesthetic
- Streamlit Dashboard: interactive Plotly charts, expandable pick details
- Slack: mrkdwn syntax with emojis

### Next.js Integration (Session 6)

**FastAPI Wrapper (api_server.py):**
- POST /run-council: trigger full pipeline
- POST /run-council-mapped: trigger + return Prisma-compatible output
- GET /latest-output, /latest-output-mapped: cached results
- GET /render-email: HTML email rendering
- GET /health: status check
- CORS for localhost:3000 and spiketrades.ca

**Analyzer Rewrite (analyzer.ts):**
- Replaced entire TypeScript council with single HTTP call to Python brain
- Prisma mapping: DailyReport + Spike records from council JSON
- Rich email: Python-rendered HTML with fallback to simple summary
- 1-hour AbortSignal timeout for long pipeline runs

**Docker Infrastructure:**
- Dockerfile.council: Python council brain container
- Dockerfile.cron: Separate Node.js cron container
- docker-compose.yml: 6-service orchestration (db, council, app, cron, nginx, certbot)

### Production Deployment (Session 7)

- DigitalOcean droplet at 147.182.150.30
- SSL via Let's Encrypt + Nginx reverse proxy
- PostgreSQL 16 with 7 Prisma tables
- 3 cron schedules: 10:45 AM AST analysis, 4:30 PM accuracy check, 15-min portfolio alerts
- GitHub repo: Steve25Vibe/spike-trades (private)

### First Live Run (Session 8)

- Full 297-ticker production run: 20 picks in 42.7 minutes
- Bug fixes: Gemini batch size 30 -> 15, max_tokens 16K -> 32K
- council_data Docker volume for persistent SQLite + cached output
- ?cached=true parameter for Prisma saves without re-running LLMs

---

## Ver 1.1 — Directional Scoring Overhaul (March 19, 2026)

**Session 8b:**

- DIRECTIONAL_MANDATE added to all 4 LLM stage prompts: score for upside, not just activity
- Updated RUBRIC_TEXT: bullish signals score high, bearish/overbought score low
- Consensus score multiplied by directional signal from Stage 4 forecasts
- Bearish filter: ALL DOWN-predicted stocks removed from Top 20
- Gold price converted from USD to CAD (live conversion using CAD/USD rate)
- Gold regime thresholds updated from USD to CAD values
- USO Oil / TSX (XIU) proxy labels corrected for honest display
- Market status indicator: dynamic green/red dot based on TSX hours (9am-4pm ET)

---

## Ver 1.5 — Dashboard Enhancements (March 21, 2026)

**Session 9:**

- TSX (XIU) price formatting: dollar amount with decimal
- Bitcoin (BTC) price in CAD added to market header
- BULL/BEAR regime badge with pulsing glow animation (green/red)
- Yahoo Finance links on all ticker names (spike cards + analysis pages)
- Market indicator arrows: green/red pulsing arrows on USO Oil, Gold, BTC, CAD/USD
- "STOCKS ANALYZED" stat added to dashboard summary bar
- Archive page: removed dead entries, added View and XLSX download buttons
- Trading days fix: 3/5/8-day accuracy horizons now use trading days (skip weekends/holidays)
- Timezone fix: all date calculations use America/Halifax (AST)
- March 19th data restoration from XLSX spreadsheet (20 spikes)
- Customizable portfolio sizing: Auto-Size, Fixed Dollar, Manual Shares modes
- Confirmation modal on every Lock In with full trade summary
- Fetch timeout audit: fixed all undici/fetch timeout vulnerabilities
- Server IP change: updated to 147.182.150.30

---

## Ver 2.0 — Portfolio Management Overhaul (March 21, 2026)

**Session 10:**

- Tooltips across entire site (sidebar, dashboard, spike cards, analysis, reports, portfolio, accuracy, login)
- CSV Import/Export: Wealthsimple-compatible format, matched to Spike picks only
- Portfolio close fix: API falls back to entry price when FMP quote unavailable
- Version number display on login page and all footers
- Kelly criterion fix: removed double-cap that produced tiny positions
- LockInModal: Fixed mode editable dollar input, Manual mode per-spike prompts
- BulkLockInModal: multi-spike lock-in with Auto/Fixed/Manual per-mode UX
- Configurable Kelly controls: Max Risk slider (0.5-10%), Win Rate slider (40-85%)
- Bulk close for portfolio positions: selection mode, Select All, two-step confirmation

**Multi-Portfolio Backend:**
- Portfolio Prisma model (name, per-portfolio sizing settings)
- PortfolioEntry gains portfolioId foreign key
- CRUD API: GET/POST/DELETE /api/portfolios, PUT /api/portfolios/[id]
- Migration endpoint: POST /api/portfolios/migrate
- All position/accuracy/CSV APIs updated with portfolioId filtering

**Session 11 — Multi-Portfolio Frontend:**

- usePortfolios.ts: shared React hook for portfolio state management
- PortfolioSelector.tsx: reusable dropdown with position counts
- PortfolioSettings.tsx: rewritten to save mode/sizes/Kelly params to DB
- LockInModal + BulkLockInModal: portfolio picker, DB-sourced sizing config
- Dashboard: portfolio selector dropdown, "New Portfolio" creation modal
- Portfolio page: selector, delete (3-step flow), filtered positions
- Accuracy page: portfolio filter dropdown
- Analysis detail page: portfolio-aware lock-in

**Session 11 (continued) — Portfolio Refinements:**

- Hard-delete model: deleted portfolios and all positions permanently removed
- 3-step delete flow: select -> close active positions (amber warning) -> confirm delete (red)
- Same stock in multiple portfolios: duplicate check scoped by portfolioId
- Auto-select first portfolio on load when stored selection invalid
- Partial sell / close: sharesToSell parameter, reduces shares keeping position active
- Sell modal: position details, quantity input, Sell All button, estimated P&L
- Dashboard cleanup: removed redundant portfolio buttons (modal handles create/select)

---

## Ver 2.1 — Council Resilience & Admin Controls (March 23, 2026)

**Session 13 (Part 1):**

- Retry with exponential backoff for Gemini API (4 retries, 30s/60s/120s/300s)
- Retry with exponential backoff for Grok API (same pattern)
- _is_transient() helper: detects retryable errors (429, 500, 502, 503)
- Graceful stage skipping: Stages 2/3/4 pass through previous results on persistent failure
- Per-batch resilience: individual batch failures don't kill entire stage
- skipped_stages tracking in stage_metadata with warning logs
- Concurrent Gemini batches: 2 at a time via asyncio.Semaphore (~3-4 min savings)
- Removed SKIP_GEMINI production hack (replaced by proper retry/skip logic)

**Admin Manual Scan Trigger:**
- New "Council" tab in Admin Panel (4th tab alongside Users, Invitations, Activity)
- Status cards: current state (Idle/Running with pulsing indicator), last run duration, Python server health
- "Run Council Scan" button with confirmation modal explaining 4-stage pipeline
- Background execution with 30-second polling and elapsed time counter
- Last trigger result card (success/error with spike count and timestamp)
- Recent Reports table: last 5 DailyReports with date, regime, spike count
- POST /api/admin/council: triggers background council run (prevents concurrent runs)
- GET /api/admin/council: returns council health, run state, recent reports

---

## Ver 2.5 — Accuracy Enhancement Signals (March 23, 2026)

**Session 13 (Part 2):**

**New Accuracy Signals (from FMP data):**
- Earnings Calendar Awareness: fetches upcoming 10 days of earnings, penalizes tickers with earnings within prediction window (30% for 0-2 days, 15% for 3-5 days, 8% for 6-8 days)
- Insider Trading Signal: 30-day insider buy/sell activity with recency-weighted scoring, up to +/-8% consensus adjustment
- Analyst Consensus Cross-Reference: Wall Street ratings (strongBuy through strongSell) + price target upside, up to +/-5% adjustment with divergence warning
- Sector-Relative Strength: ticker performance vs sector average (zero API calls), up to +/-5% adjustment

**Runtime Optimizations:**
- Technical pre-filter before Stage 1: cuts ~350 tickers to ~150 using RSI, MACD, ADX, relative volume thresholds with catalyst override (saves ~12-15 min)
- Historical bars trimmed from 10 to 5 per ticker in LLM payloads
- News trimmed from 10 to 5 articles, URLs stripped from serialized payloads
- Macro context removed from individual payloads (already in prompt header)
- Compact JSON serialization for all LLM prompts (20-30% token reduction)

**LLM Prompt Updates:**
- RUBRIC_TEXT updated to reference insider buying, analyst consensus, earnings risk, and sector-relative strength
- All 4 stage prompts now receive enriched StockDataPayload with new signal fields

**Estimated Runtime: ~20-22 minutes** (down from ~35-40 minutes)

---

## Infrastructure & Deployment Details

| Component | Technology |
|-----------|-----------|
| Frontend | Next.js 15.5, React, Tailwind CSS |
| Backend | FastAPI (Python), Prisma ORM |
| Database | PostgreSQL 16 (Docker) |
| LLM APIs | Anthropic (Sonnet/Opus), Google (Gemini 3.1 Pro), xAI (Grok 4) |
| Data APIs | FMP (Financial Modeling Prep), Finnhub |
| Hosting | DigitalOcean droplet (147.182.150.30) |
| SSL | Let's Encrypt via Certbot + Nginx |
| Containers | Docker Compose (6 services) |
| Domain | spiketrades.ca |

---

*Document generated March 23, 2026*
*Last version: 2.5*
