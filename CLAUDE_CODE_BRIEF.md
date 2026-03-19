# Spike Trades — Claude Code Handoff Brief

## What This Project Is

Spike Trades is an autonomous daily AI stock analyst for the Canadian market (TSX + TSXV).
Every trading day at 10:45 AM AST, it pulls live market data, runs a multi-LLM analysis
council, selects the Top 20 short-term momentum picks ("Today's Spikes"), and presents
them in a premium web interface at spiketrades.ca. Password: `godmode`.

Owner: Steve (steve@boomerang.energy)

---

## CRITICAL: Session-Based Development Protocol

### Why Sessions Matter

This project is too large to build in a single context window. Attempting to do so
will degrade output quality as context fills up. Instead, the work is divided into
**7 focused sessions**, each with a single concern, a clear deliverable, and a
checkpoint transition before moving to the next.

### Rules

1. **One session = one concern.** Do not start the next session's work in the current one.
2. **Build locally first.** Do NOT touch the DigitalOcean server until Session 7.
3. **Test by execution.** Every class must be run against live APIs (or real SQLite),
   not just syntax-checked.
4. **Checkpoint before advancing.** Each session ends by writing a transition file
   (see `SESSION_TRANSITIONS.md`). Do not proceed to the next session until the
   checkpoint passes.
5. **Monitor context usage.** If you notice the session is getting long (many tool calls,
   large outputs), finish the current sub-step, write the checkpoint, and stop.
   The user will start a fresh session with the transition prompt.

---

## Session Map

| Session | Focus | Deliverable | Spec File |
|---------|-------|-------------|-----------|
| 1 | Data Layer + Pydantic Models | Working `LiveDataFetcher` + `MacroRegimeFilter` + all Pydantic models | `COUNCIL_BRAIN_SPEC.md` |
| 2 | LLM Stage Callers | All 4 stage callers (Sonnet, Gemini, Opus, Grok) working individually | `COUNCIL_BRAIN_SPEC.md` |
| 3 | Pipeline Assembly + Validation | Complete `canadian_llm_council_brain.py` with `run_council()` producing full output | `COUNCIL_BRAIN_SPEC.md` |
| 4 | Persistence + Risk Engine | `HistoricalPerformanceAnalyzer` + `CompoundingRoadmapEngine` + `RiskPortfolioEngine` integrated | `COUNCIL_BRAIN_SPEC.md` |
| 5 | Portfolio Interface | `canadian_portfolio_interface.py` with all 5 render formats | `PORTFOLIO_INTERFACE_SPEC.md` |
| 6 | Next.js Integration | Python brain wired into Next.js via FastAPI, frontend displays real data | This file |
| 7 | Production Deployment | Running on DigitalOcean droplet with cron, SSL, and monitoring | `DEPLOYMENT.md` |

---

## Session 1: Data Layer + Pydantic Models

**Goal**: Build the foundation that everything else depends on. No LLM calls yet.

**Read**: `COUNCIL_BRAIN_SPEC.md` — focus on LiveDataFetcher, MacroRegimeFilter,
and the Pydantic models sections.

**Setup**:
```bash
pip3 install pydantic aiohttp python-dotenv
cp .env.example .env   # Fill in FMP_API_KEY and FINNHUB_API_KEY (LLM keys not needed yet)
```

**Build order**:
1. All Pydantic v2 models (`StockDataPayload`, `ScoreBreakdown`, `StageOutput`,
   `FinalHotPick`, `ProbabilisticForecast`, `RoadmapEntry`, `DailyRoadmap`, `CouncilResult`).
   Test: instantiate each with sample data, verify validation works.
2. `LiveDataFetcher` — the async data client:
   - `fetch_tsx_universe()` → test: should return 200+ ticker strings
   - `fetch_quotes(["RY.TO", "CNQ.TO", "TD.TO"])` → test: verify prices, timestamps
   - `fetch_historical("RY.TO", 90)` → test: verify 90 bars returned, chronological order
   - `compute_technicals(bars)` → test: verify RSI/MACD/ADX/ATR values are reasonable
   - `fetch_news("CNQ.TO")` → test: verify news array with timestamps
   - `fetch_finnhub_sentiment("RY.TO")` → test: verify float returned
   - `fetch_macro_context()` → test: verify oil, gold, TSX, CAD/USD populated
   - Freshness rejection: feed it a stale quote, confirm it returns `None`
   - `build_payload("RY.TO", quote, bars)` → test: full StockDataPayload validates
3. `MacroRegimeFilter` — regime detection + score adjustment:
   - Feed it real macro data from step 2. Verify regime string is valid.
   - Test score adjustments for different sector/regime combos.

**Deliverable**: A file with all models + `LiveDataFetcher` + `MacroRegimeFilter` that
can fetch data for any TSX ticker and produce validated `StockDataPayload` objects.

**Checkpoint**: Save a sample data dump:
```bash
python3 -c "
from canadian_llm_council_brain import LiveDataFetcher, MacroRegimeFilter
import asyncio, json
async def test():
    f = LiveDataFetcher('YOUR_FMP_KEY', 'YOUR_FINNHUB_KEY')
    quotes = await f.fetch_quotes(['RY.TO','CNQ.TO','SHOP.TO','TD.TO','ABX.TO'])
    macro = await f.fetch_macro_context()
    # ... build payloads ...
    await f.close()
    return {'quotes': quotes, 'macro': macro}
data = asyncio.run(test())
json.dump(data, open('session1_checkpoint.json','w'), default=str, indent=2)
print('Session 1 checkpoint saved')
"
```

**Transition**: Write `session1_checkpoint.json` + update `SESSION_TRANSITIONS.md`.

---

## Session 2: LLM Stage Callers

**Goal**: Build all 4 LLM callers. Test each independently with the data from Session 1.

**Prerequisite**: `session1_checkpoint.json` exists with real data payloads.

**Setup**: Ensure all LLM API keys are in `.env` (ANTHROPIC, GOOGLE, XAI).

**Build order**:
1. Shared helpers: `_call_anthropic()`, `_call_gemini()`, `_call_grok()`, `_extract_json()`.
   Test each against a simple prompt to verify API connectivity and response parsing.
2. Sonnet stage (Stage 1 — Screener):
   - Embed the Sonnet system prompt with grounding + CoV mandate + 100-pt rubric.
   - Send 5 ticker payloads from checkpoint file.
   - Parse response JSON. Fix any shape mismatches.
   - Verify: scores sum correctly, verification_notes present, no hallucinated data.
3. Gemini stage (Stage 2 — Independent Re-scorer):
   - Embed the Gemini system prompt.
   - Feed it Sonnet's output + raw data.
   - Parse response. Handle Gemini's different response format.
   - Verify: independent scores, disagreement_reason populated where applicable.
4. Opus stage (Stage 3 — Challenger):
   - Embed the Opus system prompt.
   - Feed it Sonnet + Gemini outputs + raw data.
   - Verify: kill_condition and worst_case_scenario populated per pick.
5. Grok stage (Stage 4 — Final Authority):
   - Embed the Grok system prompt.
   - Feed it all 3 prior stages + raw data.
   - Verify: probabilistic forecasts (direction_probability 0-1, 68% range, √time decay note).
   - Test Opus fallback: temporarily blank out XAI_API_KEY, confirm Opus handles Stage 4.

**Deliverable**: All 4 callers produce parseable, validated JSON from real LLM responses.

**Checkpoint**: Save each stage's raw output:
```bash
# Save to session2_checkpoint.json:
# { "sonnet_output": ..., "gemini_output": ..., "opus_output": ..., "grok_output": ... }
```

**Transition**: Update `SESSION_TRANSITIONS.md` with which callers work, any
API quirks discovered (e.g., "Gemini wraps JSON in markdown code blocks — need to strip").

---

## Session 3: Pipeline Assembly + Validation

**Goal**: Chain the 4 stages into `run_council()`. Add `CouncilFactChecker`.
Test end-to-end.

**Prerequisite**: Sessions 1 + 2 checkpoints exist.

**Build order**:
1. `CouncilFactChecker` class:
   - Feed it Grok's output + raw payloads from Session 1.
   - Verify it catches: price mismatches, out-of-range probabilities, hallucinated catalysts.
2. Consensus counting logic:
   - Track which tickers appear in how many of the 4 stages.
   - Apply conviction tiering: HIGH (≥80 score + ≥3 stages), MEDIUM (65-79 or 2 stages), LOW (rest).
3. Wire everything into `run_council()`:
   - Data fetch → liquidity filter → Sonnet → Gemini → Opus → Grok → fact-check → consensus → output.
4. Test with 5-ticker universe. Verify `CouncilResult` Pydantic model validates.
5. Test with 15-ticker universe. Verify timing and rate limits.
6. Test with full TSX auto-fetch. This is the production-scale test.

**Deliverable**: `run_council()` produces complete, validated `CouncilResult` JSON.

**Checkpoint**: Save full production output:
```bash
python3 canadian_llm_council_brain.py > session3_output.json
```

**Transition**: Update `SESSION_TRANSITIONS.md` with total runtime, ticker counts per
stage, any consensus patterns, and the full output file path.

---

## Session 4: Persistence + Risk Engine

**Goal**: Add SQLite-backed tracking, risk sizing, and the compounding roadmap.

**Prerequisite**: Session 3 checkpoint — working `run_council()` output.

**Build order**:
1. `HistoricalPerformanceAnalyzer`:
   - Initialize SQLite DB, create tables.
   - `record_picks()` — save Session 3's Top 20 into history.
   - `backfill_actuals()` — simulate with fake actuals, verify update works.
   - `get_ticker_accuracy()` — verify edge multiplier calculation.
   - `noise_filter()` — add a ticker with <53% accuracy, verify it gets dropped.
2. `RiskPortfolioEngine`:
   - Feed it Session 3's Top 20 + ATR/price maps.
   - Verify: allocation table has shares, stop_loss, dollar_risk for each pick.
   - Verify: total heat cap (30%) is enforced — later picks get reduced or skipped.
3. `CompoundingRoadmapEngine`:
   - Initialize SQLite tables for portfolio state.
   - `generate_roadmap()` — feed it Session 3's Top 20 + price map.
   - Verify: 10 entries, dates skip weekends, projected values grow with confidence bands.
   - Verify: methodology note present.
4. Integrate all three into `run_council()`:
   - Noise filter runs before LLM stages.
   - Risk engine runs after Grok's verdict.
   - Roadmap runs last.
   - Historical picks recorded at end of run.
5. Re-run `run_council()` end-to-end. Verify the full output now includes
   `allocation_table`, `daily_roadmap`, and `risk_summary` sections.

**Deliverable**: Complete `canadian_llm_council_brain.py` with all classes working,
producing full output with persistence, risk sizing, and roadmap.

**Checkpoint**: Save final output + verify SQLite DB has records:
```bash
python3 canadian_llm_council_brain.py > session4_output.json
sqlite3 spike_trades_council.db "SELECT COUNT(*) FROM pick_history;"
```

**Transition**: Update `SESSION_TRANSITIONS.md`. The council brain is DONE at this point.

---

## Session 5: Portfolio Interface

**Goal**: Build the presentation layer for the perpetual portfolio.

**Read**: `PORTFOLIO_INTERFACE_SPEC.md` for the full specification.

**Prerequisite**: `session4_output.json` — real council output to render.

**Setup**: `pip3 install streamlit pandas plotly jinja2`

**Build order**:
1. `CanadianPortfolioInterface` class with `render()` method.
2. Console/markdown renderer — test with `render(data, "console")`.
3. HTML email renderer — test by saving to `.html` file and opening in browser.
4. Streamlit dashboard — test with `streamlit run canadian_portfolio_interface.py`.
5. Slack formatter — test output in terminal, verify mrkdwn syntax.

**Deliverable**: `canadian_portfolio_interface.py` rendering all 5 formats from real data.

**Checkpoint**: Save HTML output + screenshot Streamlit dashboard.

**Transition**: Update `SESSION_TRANSITIONS.md`.

---

## Session 6: Next.js Integration

**Goal**: Wire the Python brain into the existing web application.

**Prerequisite**: Sessions 4 + 5 complete.

**Build order**:
1. Create a FastAPI wrapper (`api_server.py`) that exposes:
   - `POST /run-council` → triggers `run_council()`
   - `GET /latest-output` → returns last saved council JSON
   - `GET /health` → status check
2. Update `src/lib/scheduling/analyzer.ts` to call FastAPI instead of old TS council.
3. Map brain's JSON output to Prisma schema (DailyReport + Spike records).
4. Wire HTML email renderer into `src/lib/email/resend.ts`.
5. Test locally: `npm run dev` + `uvicorn api_server:app` running side by side.
6. Verify dashboard displays council-generated picks with real data.

**Deliverable**: Full local stack working — brain + API + Next.js + email.

**Checkpoint**: Screenshot of working dashboard with real council data.

---

## Session 7: Production Deployment

**Goal**: Deploy to DigitalOcean. This is the ONLY session that touches the server.

**Prerequisite**: Session 6 complete — everything works locally.

**Steps**:
1. Push to GitHub.
2. SSH: `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
3. Clone to `/opt/spike-trades`.
4. Run `bash scripts/deploy.sh`.
5. Verify: site loads at spiketrades.ca, password 'godmode' works.
6. Verify: cron fires at 10:45 AM AST (may need to wait for next trading day).
7. Verify: Streamlit dashboard accessible.
8. Verify: portfolio alerts check every 15 min during market hours.
9. Verify: accuracy back-fill at 4:30 PM AST.

**Deliverable**: Production system running autonomously.

---

## Deployment Target (Session 7 only)

- **Server**: 147.182.150.30
- **SSH Key**: ~/.ssh/digitalocean_saa
- **SSH Command**: `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
- **Domain**: spiketrades.ca (SSL certs + Nginx may exist from previous project)
- **Deploy Path**: /opt/spike-trades
- **Details**: See `DEPLOYMENT.md`

---

## What's Already Built

### KEEP — Production-ready frontend + infrastructure:

These files are tested and working. Do not rewrite them unless a specific
integration change is needed.

```
src/app/                   — Next.js 15 App Router pages (login, dashboard, portfolio, accuracy, archives)
src/app/api/               — API routes (auth, spikes, portfolio, accuracy, reports, cron, alerts)
src/app/dashboard/analysis/[id]/ — Deep-dive analyst view per spike
src/components/            — React components (SpikeCard, Sidebar, MarketHeader, ParticleBackground)
src/lib/api/fmp.ts         — FMP API client (quotes, historical, profiles, commodities, news)
src/lib/api/fallback.ts    — Polygon + Finnhub failover clients
src/lib/auth.ts            — Password auth (bcrypt + iron-session)
src/lib/db/prisma.ts       — Prisma client singleton
src/lib/email/resend.ts    — Email system (daily summary, sell reminders with .ics, deviation alerts)
src/lib/scoring/technicals.ts — Technical indicator calculations (RSI, MACD, ADX, ATR, Bollinger, etc.)
src/lib/scoring/spike-score.ts — 12-factor scoring engine (preliminary scores, NOT final predictions)
src/lib/utils/             — Formatting, Kelly fraction, helpers
src/styles/globals.css     — Full dark-theme cyberpunk stylesheet
src/types/index.ts         — TypeScript type definitions
prisma/schema.prisma       — PostgreSQL schema (DailyReport, Spike, PortfolioEntry, AccuracyRecord, etc.)
docker-compose.yml         — Docker orchestration (app, db, cron, nginx, certbot)
Dockerfile                 — Next.js production build
docker/nginx.conf          — Nginx reverse proxy + SSL + rate limiting
scripts/deploy.sh          — DigitalOcean deployment script (configured for 147.182.150.30)
scripts/start-cron.ts      — Cron scheduler (10:45 AM AST analysis, 4:30 PM accuracy check, 15-min alerts)
.env.example               — All required environment variables documented
demo-*.html                — 5 standalone HTML demos showing the UI
```

### REPLACE — Build fresh from spec:

```
canadian_llm_council_brain.py  — DISCARD. Build from COUNCIL_BRAIN_SPEC.md (Sessions 1-4).
src/lib/council/claude-council.ts — Old TS council. Replace in Session 6.
src/lib/scheduling/analyzer.ts — Update to call Python brain in Session 6.
```

### BUILD NEW:

```
canadian_portfolio_interface.py — Build from PORTFOLIO_INTERFACE_SPEC.md (Session 5).
api_server.py                   — FastAPI wrapper for the brain (Session 6).
```

---

## Environment Variables Needed

```
FMP_API_KEY          — Financial Modeling Prep Professional (primary data source)
ANTHROPIC_API_KEY    — Claude Sonnet 4.6 + Opus 4.6
GOOGLE_API_KEY       — Gemini 3.1 Pro
XAI_API_KEY          — SuperGrok Heavy (xAI)
FINNHUB_API_KEY      — News + sentiment
RESEND_API_KEY       — Transactional email
DATABASE_URL         — PostgreSQL connection string
SESSION_SECRET       — For cookie encryption
```

Only FMP + FINNHUB keys are needed for Session 1.
All LLM keys needed from Session 2 onward.
All keys needed from Session 6 onward.

---

## What Success Looks Like

### Session 1 — Data flows:
`LiveDataFetcher` returns validated `StockDataPayload` for any TSX ticker.

### Session 2 — LLMs respond:
All 4 stage callers produce parseable JSON from real LLM responses.

### Session 3 — Pipeline works:
`run_council()` produces complete `CouncilResult` with Top 20 picks + forecasts.

### Session 4 — Brain complete:
Full output includes allocation table, roadmap, risk summary, historical tracking.

### Session 5 — Portfolio renders:
All 5 formats (console, markdown, HTML, Streamlit, Slack) display real council data.

### Session 6 — App integrated:
Next.js dashboard shows council-generated picks with live data.

### Session 7 — Production live:
spiketrades.ca running autonomously with daily cron at 10:45 AM AST.
