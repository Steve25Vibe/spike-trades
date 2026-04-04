# Ver 5.0 — Smart Money Flow Radar + FMP Ultimate Pipeline Overhaul

**Date:** 2026-04-04
**Status:** Design approved
**Author:** Claude Opus 4.6 + Steve
**Scope:** New Radar scanner, FMP Ultimate endpoint integration across all scanners, frontend additions

---

## 1. Executive Summary

Version 5.0 adds a pre-market **Smart Money Flow Radar** scanner and upgrades the entire data pipeline to leverage FMP Ultimate plan endpoints. The Radar runs at 8:15 AM AST, detects overnight signals that predict institutional buying pressure at open, and feeds flagged tickers downstream through Opening Bell and Today's Spikes. Additionally, all existing scanners gain 1-minute intraday bars, earnings transcripts, and earnings surprises data.

**Key deliverables:**
1. Radar scanner (8:15 AM AST, Sonnet 4.6, custom rubric)
2. FMP Ultimate endpoint integration (1-min bars, earnings surprises, earnings transcripts)
3. Spike It upgrade from synthetic to real intraday data
4. Opening Bell upgrade to 1-min bars
5. Frontend: /radar page, RadarCard, animated radar icon, Reports tab, email opt-in
6. Override bridge: Radar → Opening Bell → Today's Spikes

---

## 2. Architecture Overview

### 2.1 Scanner Pipeline (Chronological)

```
8:15 AM AST  — RADAR (NEW)
                ↓ radar_opening_bell_overrides.json
10:35 AM AST — OPENING BELL (modified: reads Radar flags, 1-min bars)
                ↓ opening_bell_council_overrides.json (existing mechanism)
10:45 AM AST — TODAY'S SPIKES (modified: reads Radar+OB overrides, earnings data)
                ↓ Final top 10 with isRadarPick + isOpeningBellPick flags
4:30 PM AST  — ACCURACY CHECK (modified: backfills Radar accuracy)
```

### 2.2 Override Bridge Pattern

Each scanner is independent. Data flows downstream via flat JSON files:

**Radar → Opening Bell** (`radar_opening_bell_overrides.json`):
```json
{
  "date": "2026-04-04",
  "tickers": ["RY.TO", "ENB.TO"],
  "smart_money_scores": {"RY.TO": 87, "ENB.TO": 72}
}
```

**Opening Bell → Council** (`opening_bell_council_overrides.json` — existing, unchanged):
```json
{
  "date": "2026-04-04",
  "tickers": ["RY.TO", "TD.TO", "ENB.TO"]
}
```

If any upstream scanner fails, downstream scanners run normally without override flags. Zero coupling.

### 2.3 Ticker Flow Rules

- **Radar flags** get priority inclusion in Opening Bell's top-40 sent to Sonnet, but must still pass Opening Bell criteria (momentum, relative volume, sector alignment).
- **Radar+OB tickers** bypass the council's technical pre-filter (guaranteed Stage 1 slot), following the same mechanism OB already uses. They must still earn their way through all 4 council stages on merit.
- **No score inflation.** Smart Money Conviction Score is passed as informational context to LLMs but does not override scoring.
- **Visual indicators are earned:** both animated radar + animated bell appear on a Spike card only when the ticker survived all three scanners independently.

---

## 3. Radar Scanner Design

### 3.1 Location

New `RadarScanner` class inside `canadian_llm_council_brain.py` (~400 lines). Follows the same standalone pattern as `OpeningBellScanner`.

### 3.2 Public Interface

```python
class RadarScanner:
    def __init__(self, fmp_api_key: str, anthropic_api_key: str, finnhub_api_key: str | None = None):
        ...

    async def run(self) -> dict:
        """Run pre-market Radar scan. Returns RadarResult as dict."""
        ...
```

### 3.3 Pipeline Flow

1. Fetch TSX universe via `LiveDataFetcher.fetch_tsx_universe()` (reuse existing)
2. Fetch previous-close quotes via `LiveDataFetcher.fetch_quotes()` (reuse existing)
3. Apply liquidity filter: price > $1.00, ADV > $5M (same thresholds as council)
4. For qualifying tickers (~200-350), fetch enrichment data in parallel:
   - `/stable/grades` — filter to grades filed in last 24 hours (after-hours upgrades/downgrades)
   - `/stable/earnings-surprises/{symbol}` — most recent surprise (beat/miss magnitude)
   - `/stable/earnings-calendar` — upcoming earnings within 10 days
   - `/stable/price-target-consensus` — target vs current price (upside %)
   - `/stable/news/stock` — articles from last 12-24 hours (volume + headline sentiment)
   - `/stable/historical-price-eod` — 90-day bars for technicals (reuse existing)
   - `/stable/sector-performance-snapshot` — sector rotation context
   - Finnhub `/company-news` — overnight news volume (existing)
   - Macro quotes — oil, gold, CAD/USD, VIX, TSX (reuse existing)
5. Compute technical indicators from previous-close bars (reuse existing `compute_technicals()`)
6. Build RadarSignal payloads with all enrichment data
7. Quick pre-score filter: drop tickers that have ALL of the following: zero news articles in 24 hours, no analyst grade change in 7 days, no earnings event within 10 days, RSI between 40-60 (neutral), ADX < 15 (no trend). A ticker needs at least one active signal to pass. This reduces the set to ~30-80 candidates.
8. Send candidates to Sonnet 4.6 with custom Radar rubric prompt
9. Parse response → RadarPick[] with Smart Money Conviction Score
10. Return RadarResult as dict (Pydantic model_dump)

### 3.4 Custom Radar Rubric (100 points)

| Category | Points | Signals Evaluated |
|---|---|---|
| **Overnight Catalyst Strength** | 30 | Analyst upgrades/downgrades filed after-hours, earnings surprise magnitude (beat/miss vs consensus), price target revisions (direction + magnitude) |
| **News & Sentiment Momentum** | 25 | Overnight news volume spike vs 30-day average, headline sentiment polarity, catalyst type classification (M&A, contract, regulatory, product) |
| **Technical Breakout Setup** | 25 | RSI recovering from oversold (30-45), MACD bullish crossover, price at/above SMA-20 with ADX > 20, Bollinger Band squeeze, 52-week range position |
| **Volume & Accumulation Signals** | 10 | Previous-day relative volume trend (5-day), on-balance volume direction, volume-price divergence |
| **Sector & Macro Alignment** | 10 | Sector rotation momentum, macro regime alignment, peer comparison (lagging sector = catch-up play) |

### 3.5 LLM Configuration

- **Model:** claude-sonnet-4-6
- **Max tokens:** 8192
- **Temperature:** 0.3
- **System prompt:** Radar-specific with Chain-of-Verification mandate and grounding instructions
- **Batch size:** 15 tickers per call (same as Opening Bell)

### 3.6 Output: Smart Money Conviction Score

Composite score (0-100) derived from all 5 rubric categories. Renamed from "Institutional Conviction Score" to reflect signal-based detection rather than literal institutional data.

- Stored in RadarPick and passed downstream in override JSON
- Available for mouse-over tooltip on frontend cards
- Never displayed in main tables (per original requirement)

---

## 4. FMP Ultimate Endpoint Integration

### 4.1 New Endpoints to Add to LiveDataFetcher

```python
async def fetch_1min_bars(self, ticker: str, date: str | None = None) -> list[dict]:
    """Fetch 1-minute intraday bars. Falls back to 5-min if unavailable for ticker."""
    # /stable/historical-chart/1min/{symbol}

async def fetch_earnings_surprises(self, ticker: str) -> list[dict]:
    """Fetch historical earnings surprise data (actual vs estimated EPS)."""
    # /stable/earnings-surprises/{symbol}

async def fetch_earnings_transcript(self, ticker: str, year: int, quarter: int) -> dict | None:
    """Fetch earnings call transcript. Returns None if unavailable (common for CA-only companies)."""
    # /stable/earnings-transcript/{symbol}?year={y}&quarter={q}
```

All new methods include:
- Retry logic (5 attempts, exponential backoff on 429)
- Endpoint health tracking
- Freshness validation
- Graceful degradation (return None/empty, don't crash)

### 4.2 Pre-Implementation Verification

Before coding, verify with a live FMP Ultimate API key:
1. Do 1-min bars return data for .TO tickers?
2. Do earnings-surprises return data for Canadian-only companies?
3. Do earnings-transcripts return data for major TSX names (RY.TO, ENB.TO)?
4. Does social-sentiment (/api/v4/) track Canadian tickers?

If any endpoint returns empty for Canadian stocks, the code gracefully degrades to existing data sources. This is a Phase 0 verification step.

### 4.3 Impact by Scanner

**Spike It (highest impact):**
- Replace synthetic 3-bar intraday data with real 1-min bars
- Compute accurate VWAP from real price×volume data
- Compute intraday RSI from real 1-min closes
- Real volume profile for institutional accumulation detection
- No changes to Grok/Opus LLM prompt structure or response schema
- Fallback chain: 1-min bars → 5-min bars → synthetic (existing)

**Opening Bell:**
- Replace 5-min bars with 1-min bars (65 data points from 9:30-10:35 AM)
- Better momentum slope calculation
- Better institutional accumulation pattern detection
- Fallback: 5-min bars → daily quote (existing)

**Today's Spikes:**
- Add earnings transcript context to Stage 1-4 LLM prompts (when available)
- Add earnings surprise history to StockDataPayload
- Add 1-min intraday context alongside daily bars
- Existing pipeline flow and stage structure unchanged

### 4.4 Rate Limit Impact

FMP Ultimate: 3,000 calls/min (up from 750 on current plan).

Radar at 8:15 AM adds ~400-600 API calls (universe + quotes + enrichment for ~300 tickers). With 3,000 calls/min this completes in under 1 minute of data fetching, leaving ample headroom for the LLM call.

No batching changes needed for existing scanners. The 4x rate increase naturally reduces retry frequency and overall pipeline latency.

---

## 5. Database Schema Changes

### 5.1 New Models

```prisma
model RadarReport {
  id             String       @id @default(cuid())
  date           DateTime     @unique
  generatedAt    DateTime     @default(now())
  tickersScanned Int
  tickersFlagged Int
  scanDurationMs Int
  tokenUsage     Json?
  picks          RadarPick[]
}

model RadarPick {
  id               String      @id @default(cuid())
  reportId         String
  report           RadarReport @relation(fields: [reportId], references: [id])
  rank             Int
  ticker           String
  name             String      @default("")
  sector           String?
  exchange         String
  priceAtScan      Float
  smartMoneyScore  Int
  catalystStrength Int
  newsSentiment    Int
  technicalSetup   Int
  volumeSignals    Int
  sectorAlignment  Int
  rationale        String?     @db.Text
  topCatalyst      String?
  passedOpeningBell   Boolean    @default(false)
  passedSpikes        Boolean    @default(false)
  // Accuracy tracking — backfilled at 4:30 PM
  actualOpenPrice     Float?
  actualOpenChangePct Float?
  actualDayHigh       Float?
  actualDayClose      Float?
  openMoveCorrect     Boolean?
}
```

### 5.2 Modified Models

```prisma
model User {
  // ... existing fields unchanged ...
  emailRadar       Boolean @default(false)  // NEW
}
```

### 5.3 No Changes To

- Spike, DailyReport, OpeningBellReport, OpeningBellPick
- Portfolio, PortfolioEntry
- AccuracyRecord, MarketRegime, CouncilLog, ApiLog
- Invitation, UserSession

---

## 6. API & Cron Changes

### 6.1 New Cron Job

```typescript
// scripts/start-cron.ts
cron.schedule('15 8 * * 1-5', () => {
  // POST /api/cron/radar with Bearer token
  // Timeout: 360000 ms (6 minutes)
}, { timezone: 'America/Halifax' });
```

### 6.2 New Next.js API Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/cron/radar` | POST | Bearer | Trigger Radar scan |
| `/api/radar` | GET | Session | Fetch today's Radar data for frontend |
| `/api/reports/radar` | GET | Session | Paginated Radar archives |

### 6.3 New FastAPI Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/run-radar` | POST | Trigger RadarScanner.run() |
| `/run-radar-status` | GET | Running flag + last result |
| `/radar-health` | GET | FMP endpoint health |
| `/latest-radar-output` | GET | Cached last Radar JSON |

### 6.4 Modified Files

| File | Change |
|---|---|
| `opening_bell_scanner.py` | `run()` accepts optional `radar_tickers` parameter; Sonnet prompt gains Radar context |
| `api_server.py` | Spike It: try 1-min bars first; new Radar endpoints; OB endpoint passes Radar flags |
| `src/lib/opening-bell-analyzer.ts` | Read `radar_opening_bell_overrides.json`; pass to Python |
| `src/middleware.ts` | Add `/api/cron/radar` to SYSTEM_PATHS |
| `src/app/api/spikes/route.ts` | Cross-reference RadarPick table → set `isRadarPick` flag |
| `src/app/api/opening-bell/route.ts` | Cross-reference RadarPick table → set `isRadarPick` flag |
| `src/app/api/accuracy/check/route.ts` | Backfill RadarPick.passedOpeningBell and passedSpikes |
| `scripts/start-cron.ts` | Add 8:15 AM Radar job |

### 6.5 New Files

| File | Purpose |
|---|---|
| `src/app/api/cron/radar/route.ts` | Cron trigger route |
| `src/app/api/radar/route.ts` | User-facing Radar data route |
| `src/app/api/reports/radar/route.ts` | Radar archives route |
| `src/lib/radar-analyzer.ts` | Orchestrator: calls Python → saves to DB → writes override → sends email |

---

## 7. Frontend Changes

### 7.1 New Pages & Components

**`/src/app/radar/page.tsx`** — Radar page
- Green color scheme (#00FF41, "matrix green")
- MarketHeader (shared existing component)
- Stats grid: Tickers Scanned, Tickers Flagged, Avg Score, Top Score, Scan Duration
- RadarCard grid (1 col mobile, 2 cols XL)
- No Lock In functionality (Radar picks flow through OB/Spikes before becoming tradeable)

**`/src/components/radar/RadarCard.tsx`** — Radar pick card
- Rank badge (green gradient tint)
- Ticker + Smart Money Score circle (green color coding: >= 80 bright, 60-79 medium, < 60 dim)
- Top Catalyst highlighted (primary overnight signal)
- Sub-score breakdown: 5 horizontal bars for each rubric category
- Rationale text (LLM-generated)
- Pipeline status indicators (updated on page refresh, not real-time WebSocket): "Awaiting Opening Bell..." (before 10:35 AM) → "Passed Opening Bell ✓" (when RadarPick.passedOpeningBell is true) → "Passed Today's Spikes ✓" (when RadarPick.passedSpikes is true). Status pulled from database via GET /api/radar on each page load.

### 7.2 Modified Components

**`Sidebar.tsx`:**
- New nav item "Radar" at position 1 (before Today's Spikes)
- Icon: radar/satellite dish SVG, green color
- Sidebar order: Radar → Today's Spikes → Opening Bell → Portfolio → Accuracy → Archives → Settings

**`SpikeCard.tsx`:**
- New `isRadarPick` boolean prop
- When `isRadarPick === true && isOpeningBellPick === false`: animated green radar SVG icon after ticker
- When `isRadarPick === true && isOpeningBellPick === true`: both animated radar SVG + animated bell emoji, side by side
- Tooltip on radar icon: "Flagged by Smart Money Radar (Score: {smartMoneyScore})"
- Existing bell icon behavior unchanged

**`OpeningBellCard.tsx`:**
- Same `isRadarPick` treatment as SpikeCard
- Green radar icon after ticker when flagged

**`reports/page.tsx`:**
- New third tab: "Radar" (green theme)
- Tab order: Today's Spikes | Opening Bell | Radar
- Endpoint: `GET /api/reports/radar?page=1&pageSize=20`
- Report cards show: date, tickers flagged, avg Smart Money Score, top catalyst summary

**`settings/page.tsx`:**
- New toggle: "Radar Alerts" → emailRadar preference
- Description: "Receive pre-market institutional signal alerts at 8:15 AM AST"

### 7.3 Animated Radar Icon

SVG-based animated green radar screen. CSS animation (not emoji). Specifications:
- 16x16px inline SVG
- Concentric circles with rotating sweep line
- Color: #00FF41 (matrix green)
- Animation: continuous rotation (2s cycle), matching existing `animate-ring` cadence
- Defined as a reusable component: `RadarIcon.tsx`

### 7.4 Color Scheme

| Scanner | Primary Color | Hex | Usage |
|---|---|---|---|
| Radar | Matrix Green | #00FF41 | Cards, icons, nav, borders, text highlights |
| Opening Bell | Amber | #FFB800 | Existing, unchanged |
| Today's Spikes | Cyan | #00F0FF | Existing, unchanged |

---

## 8. Email System

### 8.1 New Radar Email

- Trigger: 8:15 AM AST, after Radar scan completes
- Recipients: Users with `emailRadar: true`
- Template: Green-themed HTML email
- Content: Top flagged tickers, Smart Money Score, top catalyst per ticker, link to /radar page
- Rendered by Python `CanadianPortfolioInterface` (new Radar format)

### 8.2 Modified Emails

- Daily Spikes email: Radar-flagged picks get green radar icon in HTML template
- Opening Bell email: Radar-flagged picks get green radar icon in HTML template
- No changes to sell reminders, deviation alerts, or portfolio alerts

---

## 9. Learning Engine Integration

### 9.1 Source Tagging

Add a `source` column to `pick_history` and `accuracy_records` SQLite tables:
- `"council"` — standard council pick, no upstream signal
- `"council_via_ob"` — council pick that was also an Opening Bell pick
- `"council_via_radar"` — council pick that was flagged by Radar (but not OB)
- `"council_via_radar_ob"` — council pick that passed all three scanners

`record_picks()` accepts optional `ob_tickers` and `radar_tickers` lists to determine source per pick. Source is determined by cross-referencing the override files at record time.

### 9.2 Radar Accuracy Tracking

RadarPick gets actual outcome fields backfilled at 4:30 PM AST:
- `actualOpenPrice` — opening price (validates the "gap up at open" thesis)
- `actualOpenChangePct` — % change from previous close to open
- `actualDayHigh` — highest price during the day
- `actualDayClose` — closing price
- `openMoveCorrect` — boolean: did ticker gap up? (Radar always predicts bullish)

Pipeline status flags (`passedOpeningBell`, `passedSpikes`) also updated at 4:30 PM by cross-referencing today's OB picks and Spikes.

### 9.3 Admin Panel

- Fetch and display Radar FMP endpoint health in Data Source Health table
- Radar status card: running status, picks count, last run time, last error
- Manual "Trigger Radar" button (same pattern as existing OB trigger)

### 9.4 Accuracy Page

- Radar scorecard section: Open Direction Hit Rate, Correct/Total, Avg Open Move, Made Final Spikes ratio

### 9.5 Archives

- Radar tab in Reports page (green theme, matching Spikes/OB pattern)
- Report cards show: date, tickers flagged/scanned, scan duration, top tickers
- "View" link navigates to /radar?date=YYYY-MM-DD

### 9.6 Future Learning (Post v5.0)

Once 50+ Radar-sourced council picks have accuracy data, the learning engine can compute Radar-specific weights. The `source` column enables queries like "what is the 3-day hit rate for council_via_radar picks?" to inform future adaptive mechanisms.

---

## 10. What Does NOT Change

Explicitly listing unchanged systems to prevent scope creep:

- `CanadianStockCouncilBrain.run_council()` — identical flow, no modifications
- `CanadianStockCouncilBrain.__init__()` — identical signature
- All 4 LLM stage functions (Sonnet/Gemini/Opus/Grok) — no prompt changes
- `MacroRegimeFilter` — no changes
- `CouncilFactChecker` — no changes
- `HistoricalCalibrationEngine` — no changes
- `LearningEngine` — no changes
- `RiskPortfolioEngine` — no changes
- `CompoundingRoadmapEngine` — no changes
- HistoricalPerformanceAnalyzer — `record_picks` gains optional `ob_tickers`/`radar_tickers` params; new `source` column on SQLite tables; all existing behavior unchanged when params not passed
- Pre-filter logic — only reads one additional override file
- All existing Pydantic models — no field changes (StockDataPayload gains optional `earnings_surprise_history` and `earnings_transcript_summary` fields with defaults)
- Consensus scoring, conviction tiering, earnings penalty, disagreement adjustment — all unchanged
- Docker architecture — no new services, no new ports
- Authentication — no changes (Bearer token for cron, session for users)
- Portfolio system — no changes (Radar picks are not directly lockable)

---

## 11. Implementation Phasing

Recommended phase order for the implementation plan:

**Phase 0: FMP Ultimate Verification**
- Obtain FMP Ultimate API key
- Verify 1-min bars for .TO tickers
- Verify earnings-surprises for Canadian companies
- Verify earnings-transcripts for major TSX names
- Document which endpoints work and which need graceful degradation

**Phase 1: FMP Ultimate Endpoint Integration**
- Add new `LiveDataFetcher` methods (1-min bars, earnings surprises, transcripts)
- Upgrade Spike It to use real 1-min bars (highest standalone impact)
- Upgrade Opening Bell to use 1-min bars
- Add earnings data to Today's Spikes StockDataPayload

**Phase 2: Radar Scanner (Python)**
- RadarScanner class + Pydantic models
- Radar Sonnet prompt with custom rubric
- FastAPI endpoints
- Unit tests

**Phase 3: Radar Integration (Next.js)**
- Prisma migration (RadarReport, RadarPick, User.emailRadar)
- radar-analyzer.ts + cron route
- Override bridge: radar_opening_bell_overrides.json
- Opening Bell scanner: accept Radar flags
- API routes: /api/radar, /api/reports/radar
- isRadarPick cross-reference on spikes and opening-bell routes

**Phase 4: Frontend**
- /radar page + RadarCard component
- RadarIcon animated SVG component
- SpikeCard + OpeningBellCard: add radar icon rendering
- Sidebar nav item
- Reports page: Radar tab
- Settings page: emailRadar toggle

**Phase 5: Email + Polish**
- Radar email template
- Radar icons in Spikes and OB emails
- Accuracy backfill for Radar picks
- Cron scheduler: add 8:15 AM job
- Version bump to 5.0

---

## 12. Risk Mitigation

| Risk | Mitigation |
|---|---|
| FMP 1-min bars unavailable for .TO tickers | Graceful fallback: 1-min → 5-min → synthetic. Spike It still improves with 5-min. |
| Earnings transcripts sparse for Canadian companies | Treat as optional enrichment. Transcript data enhances but is not required for scoring. |
| Radar runs but finds zero signals on quiet days | Normal behavior. Return empty RadarResult. Opening Bell and Spikes run unaffected. |
| Radar override file race condition | File is small, written atomically, and date-stamped. Downstream scanner ignores stale dates. |
| FMP rate limits during Radar scan | 3,000 calls/min on Ultimate. Radar needs ~500 calls. Ample headroom. |
| Radar adds false confidence to weak tickers | Radar flags are informational context only. No score inflation. Every ticker must independently pass OB and council criteria. |
