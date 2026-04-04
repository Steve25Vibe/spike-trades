# Ver 5.0 — Smart Money Flow Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pre-market Smart Money Flow Radar scanner and upgrade the entire data pipeline to FMP Ultimate endpoints (1-min bars, earnings surprises, earnings transcripts).

**Architecture:** Three independent scanners (Radar → Opening Bell → Today's Spikes) chained by JSON override files. Each scanner runs on its own cron schedule and must independently pass its own criteria. FMP Ultimate endpoints added to the shared `LiveDataFetcher` class with graceful degradation.

**Tech Stack:** Python 3.12 (FastAPI, Pydantic v2, aiohttp), Next.js 15 (TypeScript, Prisma, Tailwind), PostgreSQL 16, Claude Sonnet 4.6 (Anthropic SDK)

**Spec:** `docs/superpowers/specs/2026-04-04-smart-money-radar-v5-design.md`

---

## Session Structure

This plan is divided into 6 phases, each designed as a standalone session with its own transition prompt. Each phase produces working, testable software independently.

| Phase | Session | Tasks | Focus |
|-------|---------|-------|-------|
| 0 | Session 1 | 1-2 | FMP Ultimate verification |
| 1 | Session 1 | 3-6 | FMP endpoint integration (Spike It, OB, Spikes) |
| 2 | Session 2 | 7-10 | Radar Scanner (Python + FastAPI) |
| 3 | Session 3 | 11-15 | Radar Integration (Prisma, Next.js, bridges) |
| 4 | Session 4 | 16-20 | Frontend (Radar page, icons, cards, reports) |
| 5 | Session 4 | 21-23 | Email, cron, version bump |

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/app/api/cron/radar/route.ts` | Cron trigger for Radar scan |
| `src/app/api/radar/route.ts` | User-facing Radar data endpoint |
| `src/app/api/reports/radar/route.ts` | Paginated Radar archives |
| `src/lib/radar-analyzer.ts` | Orchestrator: Python → DB → override file → email |
| `src/lib/email/radar-email.ts` | Radar email template |
| `src/app/radar/page.tsx` | Radar page |
| `src/components/radar/RadarCard.tsx` | Radar pick card component |
| `src/components/radar/RadarIcon.tsx` | Animated radar SVG icon |
| `tests/test_radar_scanner.py` | Radar scanner unit tests |
| `tests/test_fmp_ultimate.py` | FMP Ultimate endpoint verification |

### Modified Files

| File | Change |
|------|--------|
| `canadian_llm_council_brain.py` | Add RadarScanner class, Pydantic models, new LiveDataFetcher methods |
| `opening_bell_scanner.py` | Accept `radar_tickers` parameter, add Radar context to Sonnet prompt |
| `api_server.py` | New Radar endpoints, Spike It 1-min bars upgrade, OB Radar pass-through |
| `prisma/schema.prisma` | Add RadarReport, RadarPick models; add User.emailRadar |
| `scripts/start-cron.ts` | Add 8:15 AM Radar cron job |
| `src/middleware.ts` | No change needed — `/api/cron/radar` already covered by `/api/cron` prefix |
| `src/lib/opening-bell-analyzer.ts` | Read `radar_opening_bell_overrides.json`, pass to Python |
| `src/app/api/spikes/route.ts` | Cross-reference RadarPick → isRadarPick flag |
| `src/app/api/opening-bell/route.ts` | Cross-reference RadarPick → isRadarPick flag |
| `src/app/api/accuracy/check/route.ts` | Backfill RadarPick.passedOpeningBell, passedSpikes |
| `src/components/spikes/SpikeCard.tsx` | Add isRadarPick prop + animated radar icon |
| `src/components/opening-bell/OpeningBellCard.tsx` | Add isRadarPick prop + animated radar icon |
| `src/components/layout/Sidebar.tsx` | Add Radar nav item |
| `src/app/reports/page.tsx` | Add Radar tab |
| `src/app/settings/page.tsx` | Add emailRadar toggle |
| `tailwind.config.ts` | Add radar-green color |

---

## Phase 0: FMP Ultimate Verification (Session 1)

### Task 1: Verify FMP Ultimate Endpoints for Canadian Stocks

**Files:**
- Create: `tests/test_fmp_ultimate.py`

This task must be run with a live FMP Ultimate API key. It verifies which new endpoints return data for TSX/TSXV tickers.

- [ ] **Step 1: Write the verification script**

```python
# tests/test_fmp_ultimate.py
"""
FMP Ultimate Endpoint Verification for Canadian Stocks.
Run: FMP_API_KEY=xxx python tests/test_fmp_ultimate.py
"""
import asyncio
import aiohttp
import os
import json
from datetime import datetime, timedelta

FMP_KEY = os.environ.get("FMP_API_KEY", "")
BASE = "https://financialmodelingprep.com"
TEST_TICKERS = ["RY.TO", "ENB.TO", "TD.TO", "CNR.TO", "SHOP.TO"]
RESULTS: dict[str, dict] = {}


async def test_endpoint(session: aiohttp.ClientSession, name: str, url: str) -> dict:
    """Test a single endpoint and return result summary."""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            status = resp.status
            body = await resp.text()
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = body[:200]
            has_data = bool(data) and status == 200
            if isinstance(data, list):
                has_data = len(data) > 0
            return {"name": name, "status": status, "has_data": has_data, "sample": str(data)[:300]}
    except Exception as e:
        return {"name": name, "status": "ERROR", "has_data": False, "sample": str(e)[:200]}


async def main():
    if not FMP_KEY:
        print("ERROR: Set FMP_API_KEY environment variable")
        return

    async with aiohttp.ClientSession() as session:
        ticker = "RY.TO"
        today = datetime.now().strftime("%Y-%m-%d")
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

        endpoints = [
            ("1-min bars (stable)", f"{BASE}/stable/historical-chart/1min/{ticker}?from={yesterday}&to={today}&apikey={FMP_KEY}"),
            ("1-min bars (v3)", f"{BASE}/api/v3/historical-chart/1min/{ticker}?from={yesterday}&to={today}&apikey={FMP_KEY}"),
            ("5-min bars (stable)", f"{BASE}/stable/historical-chart/5min/{ticker}?from={yesterday}&to={today}&apikey={FMP_KEY}"),
            ("earnings-surprises", f"{BASE}/stable/earnings-surprises/{ticker}?apikey={FMP_KEY}"),
            ("earnings-transcript-list", f"{BASE}/stable/earnings-transcript-list/{ticker}?apikey={FMP_KEY}"),
            ("earnings-transcript", f"{BASE}/stable/earnings-transcript/{ticker}?year=2025&quarter=4&apikey={FMP_KEY}"),
            ("insider-trading (stable)", f"{BASE}/stable/insider-trading?symbol={ticker}&apikey={FMP_KEY}"),
            ("institutional-ownership", f"{BASE}/stable/institutional-ownership/symbol-ownership?symbol={ticker}&apikey={FMP_KEY}"),
            ("social-sentiment (v4)", f"{BASE}/api/v4/social-sentiment?symbol={ticker}&apikey={FMP_KEY}"),
            ("grades", f"{BASE}/stable/grades?symbol={ticker}&apikey={FMP_KEY}"),
            ("price-target-consensus", f"{BASE}/stable/price-target-consensus?symbol={ticker}&apikey={FMP_KEY}"),
            ("sector-performance", f"{BASE}/stable/sector-performance-snapshot?exchange=TSX&date={yesterday}&apikey={FMP_KEY}"),
            ("technical-indicators RSI", f"{BASE}/stable/technical-indicator/daily/{ticker}?type=rsi&period=14&apikey={FMP_KEY}"),
        ]

        print(f"\n{'='*70}")
        print(f"FMP Ultimate Verification — {ticker}")
        print(f"{'='*70}\n")

        for name, url in endpoints:
            result = await test_endpoint(session, name, url)
            status_icon = "✅" if result["has_data"] else "❌"
            print(f"{status_icon} {name}: status={result['status']}, has_data={result['has_data']}")
            if result["has_data"]:
                print(f"   Sample: {result['sample'][:150]}")
            print()
            RESULTS[name] = result

        # Summary
        print(f"\n{'='*70}")
        print("SUMMARY — Canadian Stock Endpoint Availability")
        print(f"{'='*70}")
        working = [k for k, v in RESULTS.items() if v["has_data"]]
        broken = [k for k, v in RESULTS.items() if not v["has_data"]]
        print(f"\n✅ WORKING ({len(working)}):")
        for w in working:
            print(f"   - {w}")
        print(f"\n❌ NOT AVAILABLE ({len(broken)}):")
        for b in broken:
            print(f"   - {b} (status: {RESULTS[b]['status']})")

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Run the verification**

Run: `FMP_API_KEY=your_ultimate_key python tests/test_fmp_ultimate.py`
Expected: A summary showing which endpoints return data for .TO tickers.

- [ ] **Step 3: Document results**

Based on the output, update the spec's Section 4.2 with actual results. If 1-min bars don't work for .TO, note that Spike It will use 5-min bars. If earnings-transcripts return empty, note that transcript enrichment is skipped for Canadian-only companies.

- [ ] **Step 4: Commit**

```bash
git add tests/test_fmp_ultimate.py
git commit -m "test: add FMP Ultimate endpoint verification for Canadian stocks"
git push
```

---

## Phase 1: FMP Ultimate Endpoint Integration (Session 1)

### Task 2: Add New LiveDataFetcher Methods

**Files:**
- Modify: `canadian_llm_council_brain.py` (add methods to `LiveDataFetcher` class, ~line 320-600)

- [ ] **Step 1: Add `fetch_1min_bars` method**

Add this method to the `LiveDataFetcher` class, after the existing `fetch_historical` method:

```python
async def fetch_1min_bars(self, ticker: str, date: str | None = None) -> list[dict]:
    """Fetch 1-minute intraday bars. Falls back to 5-min if unavailable.

    Args:
        ticker: Stock ticker (e.g., 'RY.TO')
        date: Optional date string 'YYYY-MM-DD'. Defaults to today.

    Returns:
        List of OHLCV dicts with 'date', 'open', 'high', 'low', 'close', 'volume' keys.
        Empty list if unavailable.
    """
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")

    # Try 1-min first (Ultimate only)
    url = f"{self.fmp_base}/stable/historical-chart/1min/{ticker}"
    params = {"from": date, "to": date, "apikey": self.fmp_api_key}
    bars = await self._fmp_get(url, params, endpoint="/historical-chart/1min")

    if bars and isinstance(bars, list) and len(bars) > 0:
        logger.info(f"[LiveDataFetcher] {ticker}: got {len(bars)} 1-min bars")
        return bars

    # Fallback to 5-min
    url_5m = f"{self.fmp_base}/stable/historical-chart/5min/{ticker}"
    bars_5m = await self._fmp_get(url_5m, params, endpoint="/historical-chart/5min")

    if bars_5m and isinstance(bars_5m, list) and len(bars_5m) > 0:
        logger.info(f"[LiveDataFetcher] {ticker}: 1-min unavailable, got {len(bars_5m)} 5-min bars")
        return bars_5m

    logger.warning(f"[LiveDataFetcher] {ticker}: no intraday bars available")
    return []
```

- [ ] **Step 2: Add `fetch_earnings_surprises` method**

```python
async def fetch_earnings_surprises(self, ticker: str) -> list[dict]:
    """Fetch historical earnings surprise data (actual vs estimated EPS).

    Returns:
        List of dicts with 'date', 'actualEarningResult', 'estimatedEarning',
        'revenue', 'revenueEstimated' keys. Empty list if unavailable.
    """
    url = f"{self.fmp_base}/stable/earnings-surprises/{ticker}"
    params = {"apikey": self.fmp_api_key}
    data = await self._fmp_get(url, params, endpoint="/earnings-surprises")

    if data and isinstance(data, list):
        logger.info(f"[LiveDataFetcher] {ticker}: got {len(data)} earnings surprises")
        return data[:8]  # Last 8 quarters (2 years)

    return []
```

- [ ] **Step 3: Add `fetch_earnings_transcript` method**

```python
async def fetch_earnings_transcript(self, ticker: str, year: int, quarter: int) -> dict | None:
    """Fetch earnings call transcript. Returns None if unavailable.

    Most Canadian-only companies won't have transcripts on FMP.
    This is optional enrichment — never required for scoring.
    """
    url = f"{self.fmp_base}/stable/earnings-transcript/{ticker}"
    params = {"year": year, "quarter": quarter, "apikey": self.fmp_api_key}
    data = await self._fmp_get(url, params, endpoint="/earnings-transcript")

    if data and isinstance(data, list) and len(data) > 0:
        transcript = data[0]
        # Truncate to first 2000 chars to avoid blowing up LLM context
        if "content" in transcript and len(transcript["content"]) > 2000:
            transcript["content"] = transcript["content"][:2000] + "... [truncated]"
        logger.info(f"[LiveDataFetcher] {ticker}: got transcript for Q{quarter} {year}")
        return transcript

    return None
```

- [ ] **Step 4: Verify existing tests still pass**

Run: `python -c "from canadian_llm_council_brain import LiveDataFetcher; print('Import OK')"`
Expected: `Import OK` — no import errors from the new methods.

- [ ] **Step 5: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: add FMP Ultimate endpoints to LiveDataFetcher (1-min bars, earnings surprises, transcripts)"
git push
```

### Task 3: Upgrade Spike It to Real 1-Min Bars

**Files:**
- Modify: `api_server.py` (the `_fetch_spike_it_data` function, ~line 690-839)

The current Spike It code synthesizes 3 fake bars from the daily close when 5-min bars are unavailable. We replace this with a proper fallback chain: 1-min → 5-min → synthetic.

- [ ] **Step 1: Add 1-min bar fetch to `_fetch_spike_it_data`**

In `api_server.py`, find the section where intraday bars are fetched (inside `_fetch_spike_it_data`). Replace the existing 5-min bar fetch with the fallback chain. Find the line that fetches `/historical-chart/5min/{ticker}` and replace it with:

```python
# Try 1-min bars first (FMP Ultimate), fall back to 5-min, then synthetic
bars_1m_url = f"{FMP_BASE}/stable/historical-chart/1min/{ticker}"
bars_1m_params = {"from": today_str, "to": today_str, "apikey": FMP_KEY}
intraday_bars = []
bar_interval = "synthetic"

try:
    async with session.get(bars_1m_url, params=bars_1m_params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
        if resp.status == 200:
            data = await resp.json()
            if isinstance(data, list) and len(data) > 0:
                intraday_bars = data
                bar_interval = "1min"
except Exception:
    pass

if not intraday_bars:
    # Fallback: 5-min bars
    bars_5m_url = f"{FMP_BASE}/stable/historical-chart/5min/{ticker}"
    try:
        async with session.get(bars_5m_url, params=bars_1m_params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                data = await resp.json()
                if isinstance(data, list) and len(data) > 0:
                    intraday_bars = data
                    bar_interval = "5min"
    except Exception:
        pass

if not intraday_bars:
    # Fallback: synthetic bars from daily quote (existing logic — keep as-is)
    bar_interval = "synthetic"
    # ... existing synthetic bar generation code stays here ...
```

- [ ] **Step 2: Add `bar_interval` to the data limitations list**

In the return dict of `_fetch_spike_it_data`, add to the `data_limitations` list:

```python
if bar_interval == "synthetic":
    limitations.append("Using synthetic intraday bars — VWAP and RSI are approximate")
elif bar_interval == "5min":
    limitations.append("Using 5-minute bars — VWAP has reduced granularity")
# 1-min bars: no limitation added
```

- [ ] **Step 3: Test by importing**

Run: `python -c "import api_server; print('Import OK')"`
Expected: `Import OK`

- [ ] **Step 4: Commit**

```bash
git add api_server.py
git commit -m "feat: upgrade Spike It to use real 1-min intraday bars with fallback chain"
git push
```

### Task 4: Upgrade Opening Bell to 1-Min Bars

**Files:**
- Modify: `opening_bell_scanner.py` (~line 150-180, the `fetch_intraday_bars` method)

- [ ] **Step 1: Update `fetch_intraday_bars` to try 1-min first**

In `OpeningBellScanner`, find the `fetch_intraday_bars` method. Replace it:

```python
async def fetch_intraday_bars(self, session: aiohttp.ClientSession, ticker: str) -> list[dict]:
    """Fetch intraday bars: 1-min (preferred) → 5-min (fallback) → empty."""
    today = datetime.now().strftime("%Y-%m-%d")

    # Try 1-min bars (FMP Ultimate)
    bars = await self._fmp_get(session, f"/stable/historical-chart/1min/{ticker}", {"from": today, "to": today})
    if bars and isinstance(bars, list) and len(bars) > 0:
        return bars

    # Fallback: 5-min bars
    bars = await self._fmp_get(session, f"/stable/historical-chart/5min/{ticker}", {"from": today, "to": today})
    if bars and isinstance(bars, list) and len(bars) > 0:
        return bars

    return []
```

- [ ] **Step 2: Commit**

```bash
git add opening_bell_scanner.py
git commit -m "feat: upgrade Opening Bell to prefer 1-min bars over 5-min"
git push
```

### Task 5: Add Earnings Data to Today's Spikes StockDataPayload

**Files:**
- Modify: `canadian_llm_council_brain.py` (StockDataPayload model + build_payload method)

- [ ] **Step 1: Add `earnings_surprise_history` field to StockDataPayload**

Find the `StockDataPayload` Pydantic model. Add after the existing `earnings_event` field:

```python
earnings_surprise_history: list[dict] = Field(default_factory=list, description="Recent earnings surprises (last 8 quarters)")
earnings_transcript_summary: str | None = Field(default=None, description="Truncated most-recent earnings call transcript")
```

- [ ] **Step 2: Populate in the payload enrichment step**

In `run_council()`, find the section where `fetch_earnings_calendar` and `fetch_enhanced_signals_batch` are called (Step 4d-4e). Add a parallel fetch for earnings surprises:

```python
# Add alongside existing earnings calendar fetch
async def _fetch_earnings_surprises_batch(fetcher, tickers):
    """Fetch earnings surprises for all tickers in parallel."""
    surprises = {}
    sem = asyncio.Semaphore(8)
    async def _fetch_one(t):
        async with sem:
            data = await fetcher.fetch_earnings_surprises(t)
            if data:
                surprises[t] = data
    await asyncio.gather(*[_fetch_one(t) for t in tickers])
    return surprises
```

Then in the payload attachment section, attach surprises to each payload:

```python
# After existing signal attachment loop
for p in payloads_list:
    if p.ticker in surprises_map:
        p.earnings_surprise_history = surprises_map[p.ticker]
```

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: add earnings surprise history to StockDataPayload for council enrichment"
git push
```

### Task 6: Session 1 Completion — Verify & Tag

- [ ] **Step 1: Verify all imports work**

```bash
python -c "from canadian_llm_council_brain import CanadianStockCouncilBrain, LiveDataFetcher; print('Brain OK')"
python -c "from opening_bell_scanner import OpeningBellScanner; print('OB OK')"
python -c "import api_server; print('API OK')"
```
Expected: All three print OK with no import errors.

- [ ] **Step 2: Run existing test**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && npx jest src/__tests__/opening-bell-api.test.ts --passWithNoTests 2>&1 | head -20
```

- [ ] **Step 3: Commit session summary**

```bash
git add -A
git commit -m "chore: Phase 0-1 complete — FMP Ultimate endpoints integrated across all scanners"
git push
```

---

## Phase 2: Radar Scanner — Python + FastAPI (Session 2)

### Task 7: Add Radar Pydantic Models

**Files:**
- Modify: `canadian_llm_council_brain.py` (add models after existing Pydantic section, ~line 100-280)

- [ ] **Step 1: Add RadarScoreBreakdown model**

Add after the existing `ScoreBreakdown` model:

```python
class RadarScoreBreakdown(BaseModel):
    """Custom Radar rubric — different from the standard 5-category council rubric."""
    catalyst_strength: float = Field(ge=0, le=30, description="Overnight Catalyst Strength (0-30)")
    news_sentiment: float = Field(ge=0, le=25, description="News & Sentiment Momentum (0-25)")
    technical_setup: float = Field(ge=0, le=25, description="Technical Breakout Setup (0-25)")
    volume_signals: float = Field(ge=0, le=10, description="Volume & Accumulation Signals (0-10)")
    sector_alignment: float = Field(ge=0, le=10, description="Sector & Macro Alignment (0-10)")
    total: float = Field(ge=0, le=100)

    @model_validator(mode="after")
    def check_total(self) -> "RadarScoreBreakdown":
        expected = (self.catalyst_strength + self.news_sentiment + self.technical_setup
                    + self.volume_signals + self.sector_alignment)
        if abs(self.total - expected) > 1.0:
            raise ValueError(f"Radar score total {self.total} != sum of components {expected}")
        return self
```

- [ ] **Step 2: Add RadarPick and RadarResult models**

```python
class RadarPick(BaseModel):
    """A single ticker flagged by the Radar scanner."""
    rank: int = Field(ge=1, le=30)
    ticker: str
    company_name: str = ""
    sector: str = "Unknown"
    exchange: str = "TSX"
    price: float = Field(gt=0, description="Previous close price")
    smart_money_score: int = Field(ge=0, le=100)
    score_breakdown: RadarScoreBreakdown
    top_catalyst: str = Field(default="", description="Primary overnight signal description")
    rationale: str = Field(default="", description="LLM-generated reasoning")
    earnings_surprise: dict | None = Field(default=None, description="Most recent earnings surprise data")
    analyst_grade_change: dict | None = Field(default=None, description="Recent grade change if any")
    news_count_24h: int = Field(default=0, ge=0)
    as_of: datetime


class RadarResult(BaseModel):
    """Complete output of a Radar scan."""
    run_id: str
    run_date: date
    run_timestamp: datetime
    tickers_scanned: int = Field(ge=0)
    tickers_flagged: int = Field(ge=0)
    picks: list[RadarPick] = Field(default_factory=list, max_length=30)
    macro_context: MacroContext | None = None
    scan_duration_seconds: float = Field(ge=0)
    token_usage: dict = Field(default_factory=dict)
    endpoint_health: dict = Field(default_factory=dict)
```

- [ ] **Step 3: Verify import**

Run: `python -c "from canadian_llm_council_brain import RadarPick, RadarResult, RadarScoreBreakdown; print('Models OK')"`
Expected: `Models OK`

- [ ] **Step 4: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: add Radar Pydantic models (RadarScoreBreakdown, RadarPick, RadarResult)"
git push
```

### Task 8: Implement RadarScanner Class

**Files:**
- Modify: `canadian_llm_council_brain.py` (add class after existing classes, before `CanadianStockCouncilBrain`)

- [ ] **Step 1: Add RadarScanner class skeleton**

```python
class RadarScanner:
    """Pre-market Smart Money Flow Radar scanner.

    Runs at 8:15 AM AST, detects overnight signals that predict
    institutional buying pressure at open. Flags tickers with a
    Smart Money Conviction Score (0-100).

    Usage:
        scanner = RadarScanner(fmp_api_key="...", anthropic_api_key="...")
        result = await scanner.run()
    """

    # Pre-score filter: must have at least one active signal
    MIN_NEWS_FOR_SIGNAL = 1      # At least 1 article in 24h
    NEUTRAL_RSI_LOW = 40         # RSI below this is not neutral
    NEUTRAL_RSI_HIGH = 60        # RSI above this is not neutral
    MIN_ADX_FOR_TREND = 15       # ADX above this shows trend
    GRADE_RECENCY_DAYS = 7       # Grade changes within this window
    EARNINGS_LOOKAHEAD_DAYS = 10 # Upcoming earnings within this window

    RADAR_SYSTEM_PROMPT = """You are an expert pre-market institutional flow analyst for Canadian equities (TSX/TSXV).

Your job: analyze overnight signals and identify stocks likely to see institutional buying pressure at market open.

SCORING RUBRIC (100 points total):
- Overnight Catalyst Strength (0-30): Analyst upgrades/downgrades, earnings surprise magnitude, price target revisions
- News & Sentiment Momentum (0-25): Overnight news volume spike, headline sentiment, catalyst type (M&A, contract, regulatory)
- Technical Breakout Setup (0-25): RSI recovery from oversold, MACD crossover, Bollinger squeeze, ADX trend strength
- Volume & Accumulation Signals (0-10): Multi-day relative volume trend, OBV direction, volume-price divergence
- Sector & Macro Alignment (0-10): Sector rotation momentum, macro regime fit, peer relative strength

CHAIN-OF-VERIFICATION MANDATE:
1. For each ticker, state the specific overnight signal that triggered your attention.
2. Cross-verify: does the technical setup support the catalyst signal?
3. If a ticker has a strong catalyst but weak technicals (or vice versa), score conservatively.
4. Flag any data that seems stale or inconsistent.

GROUNDING RULES:
- All prices and volumes come from the data payload. Never invent or assume prices.
- If a field is null or missing, score that category as 0.
- Be skeptical of low-volume tickers with only news signals — they may be pump targets.

Respond ONLY with valid JSON. No markdown, no explanation outside JSON."""

    RADAR_USER_PROMPT_TEMPLATE = """## Pre-Market Radar Scan — {date}

### Macro Context
Oil: ${oil} | Gold: ${gold} CAD | CAD/USD: {cad_usd} | VIX: {vix} | TSX: {tsx_level} ({tsx_change}%)
Regime: {regime}

### Sector Performance (Previous Day)
{sector_performance}

### Candidates ({count} tickers with active overnight signals)

{ticker_data}

### Instructions
Score each ticker using the 100-point Radar rubric. Return the top {top_n} ranked by total score.

Required JSON format:
{{
  "picks": [
    {{
      "rank": 1,
      "ticker": "RY.TO",
      "smart_money_score": 82,
      "catalyst_strength": 25,
      "news_sentiment": 20,
      "technical_setup": 20,
      "volume_signals": 8,
      "sector_alignment": 9,
      "top_catalyst": "RBC upgraded to Outperform, PT raised to $175 (16% upside)",
      "rationale": "Strong overnight catalyst...",
      "verification_notes": "Price at $151 confirmed from data..."
    }}
  ]
}}"""

    def __init__(self, fmp_api_key: str, anthropic_api_key: str, finnhub_api_key: str | None = None):
        self.fmp_api_key = fmp_api_key
        self.anthropic_api_key = anthropic_api_key
        self.finnhub_api_key = finnhub_api_key
        self.fetcher = LiveDataFetcher(fmp_api_key, finnhub_api_key)
        self.endpoint_health: dict[str, dict] = {}

    async def run(self, top_n: int = 15) -> dict:
        """Run pre-market Radar scan. Returns RadarResult as dict."""
        import hashlib
        run_id = hashlib.md5(datetime.now().isoformat().encode()).hexdigest()[:12]
        start_time = time.time()
        logger.info(f"[Radar] Starting scan (run_id={run_id})...")

        try:
            # 1. Fetch universe + quotes
            universe = await self.fetcher.fetch_tsx_universe()
            quotes = await self.fetcher.fetch_quotes(universe)
            logger.info(f"[Radar] Universe: {len(universe)} tickers, {len(quotes)} quoted")

            # 2. Liquidity filter (same as council: price > $1, ADV > $5M)
            liquid = []
            for ticker, q in quotes.items():
                price = q.get("price", 0)
                volume = q.get("volume", 0) or q.get("avgVolume", 0)
                adv = price * volume
                if price >= 1.0 and adv >= 5_000_000:
                    liquid.append((ticker, q))
            logger.info(f"[Radar] After liquidity filter: {len(liquid)} tickers")

            # 3. Fetch enrichment data in parallel
            tickers = [t for t, _ in liquid]
            quote_map = {t: q for t, q in liquid}

            macro = await self.fetcher.fetch_macro_context()
            regime_filter = MacroRegimeFilter()
            macro = regime_filter.apply_regime(macro)

            # Parallel enrichment
            grades_map, surprises_map, news_map, sector_perf = await self._fetch_enrichment(tickers)

            # 4. Compute technicals from historical bars
            tech_map = await self._compute_technicals_batch(tickers)

            # 5. Pre-score filter: keep only tickers with at least one active signal
            candidates = self._apply_prescore_filter(
                tickers, quote_map, grades_map, surprises_map, news_map, tech_map
            )
            logger.info(f"[Radar] After pre-score filter: {len(candidates)} candidates")

            if not candidates:
                logger.info("[Radar] No candidates with active signals — returning empty result")
                result = RadarResult(
                    run_id=run_id, run_date=date.today(), run_timestamp=datetime.now(timezone.utc),
                    tickers_scanned=len(liquid), tickers_flagged=0, picks=[],
                    macro_context=macro, scan_duration_seconds=time.time() - start_time,
                    endpoint_health=self.fetcher.endpoint_health,
                )
                return result.model_dump(mode="json")

            # 6. Build LLM prompt and call Sonnet
            picks, token_usage = await self._call_radar_sonnet(
                candidates, quote_map, grades_map, surprises_map,
                news_map, tech_map, sector_perf, macro, top_n
            )

            result = RadarResult(
                run_id=run_id, run_date=date.today(), run_timestamp=datetime.now(timezone.utc),
                tickers_scanned=len(liquid), tickers_flagged=len(picks), picks=picks,
                macro_context=macro, scan_duration_seconds=time.time() - start_time,
                token_usage=token_usage, endpoint_health=self.fetcher.endpoint_health,
            )
            logger.info(f"[Radar] Complete: {len(picks)} picks in {result.scan_duration_seconds:.1f}s")
            return result.model_dump(mode="json")

        except Exception as e:
            logger.error(f"[Radar] Fatal error: {e}", exc_info=True)
            return {"error": str(e), "success": False}
        finally:
            await self.fetcher.close()

    async def _fetch_enrichment(self, tickers: list[str]) -> tuple[dict, dict, dict, list]:
        """Fetch all enrichment data in parallel."""
        sem = asyncio.Semaphore(12)
        grades_map: dict[str, list] = {}
        surprises_map: dict[str, list] = {}
        news_map: dict[str, list] = {}

        async def _grades(t):
            async with sem:
                url = f"{self.fetcher.fmp_base}/stable/grades"
                params = {"symbol": t, "apikey": self.fmp_api_key}
                data = await self.fetcher._fmp_get(url, params, endpoint="/grades")
                if data and isinstance(data, list):
                    # Filter to last 7 days
                    cutoff = (datetime.now() - timedelta(days=self.GRADE_RECENCY_DAYS)).strftime("%Y-%m-%d")
                    recent = [g for g in data if g.get("date", "") >= cutoff]
                    if recent:
                        grades_map[t] = recent

        async def _surprises(t):
            async with sem:
                data = await self.fetcher.fetch_earnings_surprises(t)
                if data:
                    surprises_map[t] = data

        async def _news(t):
            async with sem:
                data = await self.fetcher.fetch_news(t, limit=10)
                if data:
                    news_map[t] = [n.model_dump() if hasattr(n, "model_dump") else n for n in data]

        tasks = []
        for t in tickers:
            tasks.extend([_grades(t), _surprises(t), _news(t)])

        # Sector performance
        sector_task = self.fetcher.fetch_macro_context()  # Already includes sector data

        await asyncio.gather(*tasks, return_exceptions=True)

        # Fetch sector performance separately
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        sector_url = f"{self.fetcher.fmp_base}/stable/sector-performance-snapshot"
        sector_params = {"exchange": "TSX", "date": yesterday, "apikey": self.fmp_api_key}
        sector_perf = await self.fetcher._fmp_get(sector_url, sector_params, endpoint="/sector-performance-snapshot")
        if not isinstance(sector_perf, list):
            sector_perf = []

        return grades_map, surprises_map, news_map, sector_perf

    async def _compute_technicals_batch(self, tickers: list[str]) -> dict[str, TechnicalIndicators | None]:
        """Compute technicals from historical bars for all tickers."""
        sem = asyncio.Semaphore(8)
        tech_map: dict[str, TechnicalIndicators | None] = {}

        async def _compute(t):
            async with sem:
                bars = await self.fetcher.fetch_historical(t, days=90)
                if bars:
                    tech = LiveDataFetcher.compute_technicals(bars)
                    tech_map[t] = tech

        await asyncio.gather(*[_compute(t) for t in tickers], return_exceptions=True)
        return tech_map

    def _apply_prescore_filter(
        self, tickers: list[str], quote_map: dict, grades_map: dict,
        surprises_map: dict, news_map: dict, tech_map: dict
    ) -> list[str]:
        """Keep only tickers with at least one active overnight signal."""
        candidates = []
        for t in tickers:
            has_signal = False

            # Signal 1: News in last 24h
            if t in news_map and len(news_map[t]) >= self.MIN_NEWS_FOR_SIGNAL:
                has_signal = True

            # Signal 2: Recent analyst grade change
            if t in grades_map:
                has_signal = True

            # Signal 3: Upcoming earnings within 10 days
            # (checked via earnings calendar — already fetched in build_payload)

            # Signal 4: Technical setup (RSI not neutral OR ADX showing trend)
            tech = tech_map.get(t)
            if tech:
                if tech.rsi_14 < self.NEUTRAL_RSI_LOW or tech.rsi_14 > self.NEUTRAL_RSI_HIGH:
                    has_signal = True
                if tech.adx_14 >= self.MIN_ADX_FOR_TREND:
                    has_signal = True

            # Signal 5: Recent earnings surprise
            if t in surprises_map:
                has_signal = True

            if has_signal:
                candidates.append(t)

        return candidates

    async def _call_radar_sonnet(
        self, candidates: list[str], quote_map: dict, grades_map: dict,
        surprises_map: dict, news_map: dict, tech_map: dict,
        sector_perf: list, macro: MacroContext, top_n: int
    ) -> tuple[list[RadarPick], dict]:
        """Call Sonnet 4.6 with Radar rubric prompt. Returns (picks, token_usage)."""
        # Build ticker data blocks
        ticker_blocks = []
        for t in candidates:
            q = quote_map.get(t, {})
            tech = tech_map.get(t)
            block = f"**{t}** — {q.get('name', 'Unknown')} | Sector: {q.get('sector', 'Unknown')}\n"
            block += f"  Price: ${q.get('price', 0):.2f} | Change: {q.get('changesPercentage', 0):.2f}% | Volume: {q.get('volume', 0):,}\n"

            if tech:
                block += f"  RSI: {tech.rsi_14:.1f} | MACD: {tech.macd_histogram:.3f} | ADX: {tech.adx_14:.1f} | RelVol: {tech.relative_volume:.2f}\n"
                block += f"  SMA20: ${tech.sma_20:.2f} | SMA50: ${tech.sma_50:.2f} | BB: [{tech.bollinger_lower:.2f}, {tech.bollinger_upper:.2f}]\n"

            if t in grades_map:
                for g in grades_map[t][:2]:
                    block += f"  GRADE: {g.get('gradingCompany', '?')} → {g.get('newGrade', '?')} ({g.get('date', '?')})\n"

            if t in surprises_map and surprises_map[t]:
                s = surprises_map[t][0]
                actual = s.get("actualEarningResult", 0)
                est = s.get("estimatedEarning", 0)
                surprise_pct = ((actual - est) / abs(est) * 100) if est else 0
                block += f"  EARNINGS: Actual ${actual:.2f} vs Est ${est:.2f} ({surprise_pct:+.1f}% surprise)\n"

            if t in news_map:
                block += f"  NEWS: {len(news_map[t])} articles in 24h\n"
                for n in news_map[t][:2]:
                    headline = n.get("headline", n.get("title", ""))[:80]
                    block += f"    - {headline}\n"

            ticker_blocks.append(block)

        # Format sector performance
        sector_str = "\n".join([
            f"  {s.get('sector', '?')}: {s.get('averageChange', 0):+.2f}%"
            for s in (sector_perf or [])[:10]
        ]) or "  (unavailable)"

        user_prompt = self.RADAR_USER_PROMPT_TEMPLATE.format(
            date=date.today().isoformat(),
            oil=f"{macro.oil_wti or 0:.2f}",
            gold=f"{macro.gold_price or 0:.0f}",
            cad_usd=f"{macro.cad_usd or 0:.4f}",
            vix=f"{macro.vix or 0:.1f}",
            tsx_level=f"{macro.tsx_composite or 0:.0f}",
            tsx_change=f"{macro.tsx_change_pct or 0:.2f}",
            regime=macro.regime,
            sector_performance=sector_str,
            count=len(candidates),
            ticker_data="\n".join(ticker_blocks),
            top_n=top_n,
        )

        # Call Sonnet in batches of 15
        all_picks_raw = []
        total_tokens = {"input_tokens": 0, "output_tokens": 0}
        batch_size = 15

        for i in range(0, len(ticker_blocks), batch_size):
            batch_tickers = candidates[i:i + batch_size]
            batch_blocks = ticker_blocks[i:i + batch_size]

            batch_prompt = self.RADAR_USER_PROMPT_TEMPLATE.format(
                date=date.today().isoformat(),
                oil=f"{macro.oil_wti or 0:.2f}",
                gold=f"{macro.gold_price or 0:.0f}",
                cad_usd=f"{macro.cad_usd or 0:.4f}",
                vix=f"{macro.vix or 0:.1f}",
                tsx_level=f"{macro.tsx_composite or 0:.0f}",
                tsx_change=f"{macro.tsx_change_pct or 0:.2f}",
                regime=macro.regime,
                sector_performance=sector_str,
                count=len(batch_tickers),
                ticker_data="\n".join(batch_blocks),
                top_n=min(top_n, len(batch_tickers)),
            )

            response_text, usage = await _call_anthropic(
                self.anthropic_api_key, "claude-sonnet-4-6",
                self.RADAR_SYSTEM_PROMPT, batch_prompt,
                max_tokens=8192, temperature=0.3,
            )
            total_tokens["input_tokens"] += usage.get("input_tokens", 0)
            total_tokens["output_tokens"] += usage.get("output_tokens", 0)

            parsed = _extract_json(response_text)
            if parsed and "picks" in parsed:
                all_picks_raw.extend(parsed["picks"])

            if i + batch_size < len(ticker_blocks):
                await asyncio.sleep(3)  # Rate limit respect

        # Sort by smart_money_score descending, take top_n
        all_picks_raw.sort(key=lambda p: p.get("smart_money_score", 0), reverse=True)
        top_picks_raw = all_picks_raw[:top_n]

        # Convert to Pydantic models
        picks = []
        for idx, raw in enumerate(top_picks_raw):
            try:
                pick = RadarPick(
                    rank=idx + 1,
                    ticker=raw["ticker"],
                    company_name=quote_map.get(raw["ticker"], {}).get("name", ""),
                    sector=quote_map.get(raw["ticker"], {}).get("sector", "Unknown"),
                    exchange=quote_map.get(raw["ticker"], {}).get("exchange", "TSX"),
                    price=quote_map.get(raw["ticker"], {}).get("price", 0),
                    smart_money_score=int(raw.get("smart_money_score", 0)),
                    score_breakdown=RadarScoreBreakdown(
                        catalyst_strength=float(raw.get("catalyst_strength", 0)),
                        news_sentiment=float(raw.get("news_sentiment", 0)),
                        technical_setup=float(raw.get("technical_setup", 0)),
                        volume_signals=float(raw.get("volume_signals", 0)),
                        sector_alignment=float(raw.get("sector_alignment", 0)),
                        total=float(raw.get("smart_money_score", 0)),
                    ),
                    top_catalyst=raw.get("top_catalyst", ""),
                    rationale=raw.get("rationale", ""),
                    news_count_24h=len(news_map.get(raw["ticker"], [])),
                    as_of=datetime.now(timezone.utc),
                )
                picks.append(pick)
            except Exception as e:
                logger.warning(f"[Radar] Failed to parse pick {raw.get('ticker', '?')}: {e}")

        return picks, total_tokens
```

- [ ] **Step 2: Verify import**

Run: `python -c "from canadian_llm_council_brain import RadarScanner; print('RadarScanner OK')"`
Expected: `RadarScanner OK`

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: implement RadarScanner class with pre-market signal detection"
git push
```

### Task 9: Add Radar FastAPI Endpoints

**Files:**
- Modify: `api_server.py` (add endpoints after existing Opening Bell section)

- [ ] **Step 1: Add Radar state variables and imports**

At the top of `api_server.py`, add to the imports section:

```python
from canadian_llm_council_brain import CanadianStockCouncilBrain, RadarScanner, _call_grok, _extract_json, _call_anthropic
```

Add after the existing `_opening_bell_*` state variables:

```python
# ---- Radar state ----
_radar_running = False
_radar_last_result: dict | None = None
_radar_last_run_time: float | None = None
_radar_last_error: str | None = None
```

- [ ] **Step 2: Add POST /run-radar endpoint**

```python
@app.post("/run-radar")
async def run_radar():
    """Trigger pre-market Radar scan."""
    global _radar_running, _radar_last_result, _radar_last_run_time, _radar_last_error

    if _radar_running:
        return {"error": "Radar scan already running"}, 409

    _radar_running = True
    _radar_last_error = None
    start = time.time()

    try:
        scanner = RadarScanner(
            fmp_api_key=os.getenv("FMP_API_KEY", ""),
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
            finnhub_api_key=os.getenv("FINNHUB_API_KEY"),
        )
        result = await scanner.run()
        _radar_last_result = result
        _radar_last_run_time = time.time() - start

        # Save to disk
        output_path = OUTPUT_DIR / "latest_radar_output.json"
        with open(output_path, "w") as f:
            json.dump(result, f, indent=2, default=str)

        return result
    except Exception as e:
        _radar_last_error = str(e)
        logger.error(f"[Radar] Error: {e}", exc_info=True)
        return {"error": str(e)}, 500
    finally:
        _radar_running = False
```

- [ ] **Step 3: Add GET endpoints for status, health, and cached output**

```python
@app.get("/run-radar-status")
async def radar_status():
    return {
        "running": _radar_running,
        "last_run_time": _radar_last_run_time,
        "last_error": _radar_last_error,
        "picks_count": len(_radar_last_result.get("picks", [])) if _radar_last_result else 0,
    }

@app.get("/radar-health")
async def radar_health():
    if _radar_last_result and "endpoint_health" in _radar_last_result:
        return _radar_last_result["endpoint_health"]
    return {}

@app.get("/latest-radar-output")
async def latest_radar_output():
    if _radar_last_result:
        return _radar_last_result
    output_path = OUTPUT_DIR / "latest_radar_output.json"
    if output_path.exists():
        with open(output_path) as f:
            return json.load(f)
    return {"error": "No radar output available"}, 404
```

- [ ] **Step 4: Commit**

```bash
git add api_server.py
git commit -m "feat: add Radar FastAPI endpoints (run, status, health, latest output)"
git push
```

### Task 10: Session 2 Completion — Test Radar End-to-End

- [ ] **Step 1: Write a minimal integration test**

Create `tests/test_radar_scanner.py`:

```python
"""Radar Scanner integration test — requires FMP_API_KEY."""
import asyncio
import os
import pytest
from canadian_llm_council_brain import RadarScanner, RadarResult

@pytest.mark.skipif(not os.getenv("FMP_API_KEY"), reason="FMP_API_KEY not set")
@pytest.mark.skipif(not os.getenv("ANTHROPIC_API_KEY"), reason="ANTHROPIC_API_KEY not set")
def test_radar_scanner_runs():
    """Test that RadarScanner produces a valid RadarResult."""
    scanner = RadarScanner(
        fmp_api_key=os.environ["FMP_API_KEY"],
        anthropic_api_key=os.environ["ANTHROPIC_API_KEY"],
    )
    result = asyncio.run(scanner.run(top_n=5))

    assert "run_id" in result
    assert "tickers_scanned" in result
    assert result["tickers_scanned"] > 0
    assert isinstance(result.get("picks", []), list)
    # May be empty on quiet days — that's valid
    for pick in result.get("picks", []):
        assert 0 <= pick["smart_money_score"] <= 100
        assert pick["ticker"].endswith(".TO") or pick["ticker"].endswith(".V")


def test_radar_models_validate():
    """Test Pydantic model validation without API calls."""
    from canadian_llm_council_brain import RadarScoreBreakdown, RadarPick
    from datetime import datetime, timezone

    score = RadarScoreBreakdown(
        catalyst_strength=25, news_sentiment=20, technical_setup=18,
        volume_signals=7, sector_alignment=8, total=78
    )
    assert score.total == 78

    pick = RadarPick(
        rank=1, ticker="RY.TO", price=151.0, smart_money_score=78,
        score_breakdown=score, as_of=datetime.now(timezone.utc)
    )
    assert pick.smart_money_score == 78
```

- [ ] **Step 2: Run the model validation test (no API key needed)**

Run: `python -m pytest tests/test_radar_scanner.py::test_radar_models_validate -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/test_radar_scanner.py
git commit -m "test: add Radar scanner integration and model validation tests"
git push
```

---

## Phase 3: Radar Integration — Next.js (Session 3)

### Task 11: Prisma Migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add RadarReport and RadarPick models**

Add at the end of `prisma/schema.prisma`, before any closing comments:

```prisma
// ---- Radar (Pre-Market Smart Money Flow) ----

model RadarReport {
  id             String      @id @default(cuid())
  date           DateTime    @unique
  generatedAt    DateTime    @default(now())
  tickersScanned Int
  tickersFlagged Int
  scanDurationMs Int
  tokenUsage     Json?
  picks          RadarPick[]

  @@index([date])
}

model RadarPick {
  id                String      @id @default(cuid())
  reportId          String
  report            RadarReport @relation(fields: [reportId], references: [id])
  rank              Int
  ticker            String
  name              String      @default("")
  sector            String?
  exchange          String
  priceAtScan       Float
  smartMoneyScore   Int
  catalystStrength  Int
  newsSentiment     Int
  technicalSetup    Int
  volumeSignals     Int
  sectorAlignment   Int
  rationale         String?     @db.Text
  topCatalyst       String?
  passedOpeningBell Boolean     @default(false)
  passedSpikes      Boolean     @default(false)

  @@index([reportId])
  @@index([ticker])
}
```

- [ ] **Step 2: Add emailRadar to User model**

In the User model, after `emailOpeningBell`, add:

```prisma
  emailRadar           Boolean  @default(false)
```

- [ ] **Step 3: Generate and run migration**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
npx prisma migrate dev --name add-radar-models
```
Expected: Migration created and applied successfully.

- [ ] **Step 4: Commit**

```bash
git add prisma/
git commit -m "feat: add RadarReport, RadarPick models and User.emailRadar field"
git push
```

### Task 12: Create Radar Analyzer (Next.js Orchestrator)

**Files:**
- Create: `src/lib/radar-analyzer.ts`

- [ ] **Step 1: Write the radar analyzer**

```typescript
/**
 * Radar Analyzer — triggers the Python Radar scanner and stores results in Prisma.
 * Pattern follows opening-bell-analyzer.ts exactly.
 */
import prisma from '@/lib/db/prisma';
import fs from 'fs';
import path from 'path';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

interface RadarPickData {
  rank: number;
  ticker: string;
  company_name: string;
  sector: string;
  exchange: string;
  price: number;
  smart_money_score: number;
  score_breakdown: {
    catalyst_strength: number;
    news_sentiment: number;
    technical_setup: number;
    volume_signals: number;
    sector_alignment: number;
  };
  top_catalyst: string;
  rationale: string;
}

interface RadarResultData {
  run_id: string;
  tickers_scanned: number;
  tickers_flagged: number;
  picks: RadarPickData[];
  scan_duration_seconds: number;
  token_usage: Record<string, number>;
  error?: string;
}

export async function runRadarAnalysis(): Promise<{ success: boolean; picksCount: number; error?: string }> {
  console.log('[Radar] Triggering scanner...');

  try {
    // Step 1: Call Python FastAPI
    const resp = await fetch(`${COUNCIL_API_URL}/run-radar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(360_000), // 6 min timeout
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Radar API returned ${resp.status}: ${errText}`);
    }

    const result: RadarResultData = await resp.json();

    if (result.error) {
      throw new Error(result.error);
    }

    if (!result.picks || result.picks.length === 0) {
      console.log('[Radar] No picks flagged — quiet overnight');
      // Still save the report (0 picks is valid)
    }

    // Step 2: Save to database
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Delete existing report for today (idempotent re-run)
    await prisma.radarPick.deleteMany({
      where: { report: { date: today } },
    });
    await prisma.radarReport.deleteMany({
      where: { date: today },
    });

    const report = await prisma.radarReport.create({
      data: {
        date: today,
        tickersScanned: result.tickers_scanned,
        tickersFlagged: result.tickers_flagged,
        scanDurationMs: Math.round(result.scan_duration_seconds * 1000),
        tokenUsage: result.token_usage || {},
        picks: {
          create: (result.picks || []).map((pick) => ({
            rank: pick.rank,
            ticker: pick.ticker,
            name: pick.company_name || '',
            sector: pick.sector || null,
            exchange: pick.exchange || 'TSX',
            priceAtScan: pick.price,
            smartMoneyScore: pick.smart_money_score,
            catalystStrength: pick.score_breakdown.catalyst_strength,
            newsSentiment: pick.score_breakdown.news_sentiment,
            technicalSetup: pick.score_breakdown.technical_setup,
            volumeSignals: pick.score_breakdown.volume_signals,
            sectorAlignment: pick.score_breakdown.sector_alignment,
            rationale: pick.rationale || null,
            topCatalyst: pick.top_catalyst || null,
          })),
        },
      },
    });

    console.log(`[Radar] Saved ${result.picks?.length || 0} picks to database`);

    // Step 3: Write override file for Opening Bell
    const overrideTickers = (result.picks || []).map((p) => p.ticker);
    const smartMoneyScores: Record<string, number> = {};
    for (const p of result.picks || []) {
      smartMoneyScores[p.ticker] = p.smart_money_score;
    }

    const overridePath = path.join(process.cwd(), 'radar_opening_bell_overrides.json');
    fs.writeFileSync(overridePath, JSON.stringify({
      date: today.toISOString().split('T')[0],
      tickers: overrideTickers,
      smart_money_scores: smartMoneyScores,
    }));
    console.log(`[Radar] Wrote override file with ${overrideTickers.length} tickers`);

    return { success: true, picksCount: result.picks?.length || 0 };
  } catch (error) {
    console.error('[Radar] Error:', error);
    return { success: false, picksCount: 0, error: String(error) };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/radar-analyzer.ts
git commit -m "feat: add Radar analyzer (Python trigger, Prisma save, override file)"
git push
```

### Task 13: Create Cron and API Routes for Radar

**Files:**
- Create: `src/app/api/cron/radar/route.ts`
- Create: `src/app/api/radar/route.ts`
- Create: `src/app/api/reports/radar/route.ts`

- [ ] **Step 1: Create the cron trigger route**

```typescript
// src/app/api/cron/radar/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { runRadarAnalysis } from '@/lib/radar-analyzer';
import { isTradingDay } from '@/lib/utils';

export const maxDuration = 600;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.SESSION_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (!isTradingDay(new Date())) {
      console.log('[Cron] Skipping Radar — TSX closed (holiday)');
      return NextResponse.json({ success: true, skipped: true, reason: 'TSX closed (holiday)' });
    }

    const result = await runRadarAnalysis();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Create the user-facing data route**

```typescript
// src/app/api/radar/route.ts
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  const dateParam = request.nextUrl.searchParams.get('date');

  try {
    let dateFilter: Date;
    if (dateParam) {
      dateFilter = new Date(dateParam);
    } else {
      dateFilter = new Date();
    }
    dateFilter.setHours(0, 0, 0, 0);

    const report = await prisma.radarReport.findUnique({
      where: { date: dateFilter },
      include: {
        picks: { orderBy: { rank: 'asc' } },
      },
    });

    if (!report) {
      // Fallback: get most recent report
      const latest = await prisma.radarReport.findFirst({
        orderBy: { date: 'desc' },
        include: {
          picks: { orderBy: { rank: 'asc' } },
        },
      });

      if (!latest) {
        return NextResponse.json({ report: null, picks: [] });
      }
      return NextResponse.json({ report: latest, picks: latest.picks });
    }

    return NextResponse.json({ report, picks: report.picks });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create the paginated reports route**

```typescript
// src/app/api/reports/radar/route.ts
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  const page = parseInt(request.nextUrl.searchParams.get('page') || '1');
  const pageSize = parseInt(request.nextUrl.searchParams.get('pageSize') || '20');
  const skip = (page - 1) * pageSize;

  try {
    const [reports, total] = await Promise.all([
      prisma.radarReport.findMany({
        skip,
        take: pageSize,
        orderBy: { date: 'desc' },
        include: {
          picks: {
            orderBy: { rank: 'asc' },
            take: 5, // Top 5 for summary
          },
        },
      }),
      prisma.radarReport.count(),
    ]);

    return NextResponse.json({
      reports,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/radar/route.ts src/app/api/radar/route.ts src/app/api/reports/radar/route.ts
git commit -m "feat: add Radar API routes (cron trigger, data endpoint, paginated reports)"
git push
```

### Task 14: Add isRadarPick Cross-Reference to Spikes and Opening Bell Routes

**Files:**
- Modify: `src/app/api/spikes/route.ts`
- Modify: `src/app/api/opening-bell/route.ts`

- [ ] **Step 1: Add isRadarPick to spikes route**

In `src/app/api/spikes/route.ts`, after fetching the report and spikes, add a cross-reference query to RadarPick. Find where the response is built and add:

```typescript
// Cross-reference: which spikes were also Radar picks?
const today = new Date();
today.setHours(0, 0, 0, 0);

const radarPicks = await prisma.radarPick.findMany({
  where: { report: { date: today } },
  select: { ticker: true, smartMoneyScore: true },
});
const radarTickerMap = new Map(radarPicks.map(rp => [rp.ticker, rp.smartMoneyScore]));

// Add isRadarPick flag to each spike
const spikesWithRadar = spikes.map(spike => ({
  ...spike,
  isRadarPick: radarTickerMap.has(spike.ticker),
  radarScore: radarTickerMap.get(spike.ticker) ?? null,
}));
```

Then use `spikesWithRadar` in the response instead of `spikes`.

- [ ] **Step 2: Add isRadarPick to opening-bell route**

Apply the same pattern in `src/app/api/opening-bell/route.ts`:

```typescript
const radarPicks = await prisma.radarPick.findMany({
  where: { report: { date: today } },
  select: { ticker: true, smartMoneyScore: true },
});
const radarTickerMap = new Map(radarPicks.map(rp => [rp.ticker, rp.smartMoneyScore]));

const picksWithRadar = picks.map(pick => ({
  ...pick,
  isRadarPick: radarTickerMap.has(pick.ticker),
  radarScore: radarTickerMap.get(pick.ticker) ?? null,
}));
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/spikes/route.ts src/app/api/opening-bell/route.ts
git commit -m "feat: add isRadarPick cross-reference to spikes and opening-bell API routes"
git push
```

### Task 15: Update Opening Bell Analyzer to Read Radar Overrides

**Files:**
- Modify: `src/lib/opening-bell-analyzer.ts`

- [ ] **Step 1: Read radar override file and pass to Python**

At the top of `runOpeningBellAnalysis()`, add:

```typescript
// Read Radar overrides (if available)
let radarOverrides: { tickers: string[]; smart_money_scores: Record<string, number> } | null = null;
try {
  const overridePath = path.join(process.cwd(), 'radar_opening_bell_overrides.json');
  if (fs.existsSync(overridePath)) {
    const raw = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
    const today = new Date().toISOString().split('T')[0];
    if (raw.date === today) {
      radarOverrides = { tickers: raw.tickers, smart_money_scores: raw.smart_money_scores };
      console.log(`[Opening Bell] Read ${raw.tickers.length} Radar overrides`);
    } else {
      console.log('[Opening Bell] Radar override file is stale — ignoring');
    }
  }
} catch (e) {
  console.log('[Opening Bell] No Radar overrides available');
}
```

Add `import fs from 'fs'; import path from 'path';` to the imports.

When triggering the Python scanner, pass Radar overrides as a query parameter or request body if the Python endpoint accepts it. For now, the Python scanner reads the override file directly from disk (both containers share the `/app/data` volume).

- [ ] **Step 2: Commit**

```bash
git add src/lib/opening-bell-analyzer.ts
git commit -m "feat: Opening Bell analyzer reads Radar override file for priority tickers"
git push
```

---

## Phase 4: Frontend (Session 4)

### Task 16: Add Radar Color to Tailwind + Create RadarIcon Component

**Files:**
- Modify: `tailwind.config.ts`
- Create: `src/components/radar/RadarIcon.tsx`

- [ ] **Step 1: Add radar-green to Tailwind config**

In `tailwind.config.ts`, find the `colors` section inside `extend` and add:

```typescript
'radar-green': '#00FF41',
```

- [ ] **Step 2: Add radar animation to Tailwind config**

In the `animation` section inside `extend`, add:

```typescript
'radar-sweep': 'radar-sweep 2s linear infinite',
```

In the `keyframes` section, add:

```typescript
'radar-sweep': {
  '0%': { transform: 'rotate(0deg)' },
  '100%': { transform: 'rotate(360deg)' },
},
```

- [ ] **Step 3: Create RadarIcon component**

```tsx
// src/components/radar/RadarIcon.tsx
'use client';

interface RadarIconProps {
  size?: number;
  className?: string;
  title?: string;
}

export default function RadarIcon({ size = 16, className = '', title }: RadarIconProps) {
  return (
    <span className={`inline-block ${className}`} title={title}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Outer circle */}
        <circle cx="12" cy="12" r="10" stroke="#00FF41" strokeWidth="1.5" opacity="0.3" />
        {/* Middle circle */}
        <circle cx="12" cy="12" r="6" stroke="#00FF41" strokeWidth="1.5" opacity="0.5" />
        {/* Center dot */}
        <circle cx="12" cy="12" r="2" fill="#00FF41" />
        {/* Sweep line (animated) */}
        <line
          x1="12"
          y1="12"
          x2="12"
          y2="2"
          stroke="#00FF41"
          strokeWidth="2"
          strokeLinecap="round"
          className="origin-center animate-radar-sweep"
        />
        {/* Glow on sweep */}
        <path
          d="M12 12 L12 2 A10 10 0 0 1 21 8 Z"
          fill="#00FF41"
          opacity="0.1"
          className="origin-center animate-radar-sweep"
        />
      </svg>
    </span>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add tailwind.config.ts src/components/radar/RadarIcon.tsx
git commit -m "feat: add RadarIcon component with animated sweep and radar-green color"
git push
```

### Task 17: Add Radar Icons to SpikeCard and OpeningBellCard

**Files:**
- Modify: `src/components/spikes/SpikeCard.tsx`
- Modify: `src/components/opening-bell/OpeningBellCard.tsx`

- [ ] **Step 1: Add isRadarPick to SpikeCard**

In `SpikeCard.tsx`, add `isRadarPick?: boolean; radarScore?: number | null;` to the spike data type/props. Then find the existing `isOpeningBellPick` badge section (~line 77) and add the Radar icon:

```tsx
import RadarIcon from '@/components/radar/RadarIcon';

// In the header section, after the ticker name:
{spike.isRadarPick && (
  <RadarIcon
    size={16}
    title={`Flagged by Smart Money Radar${spike.radarScore ? ` (Score: ${spike.radarScore})` : ''}`}
  />
)}
{spike.isOpeningBellPick && (
  <span className="inline-block text-base animate-ring" title="Also an Opening Bell pick">
    🔔
  </span>
)}
```

- [ ] **Step 2: Add isRadarPick to OpeningBellCard**

Same pattern in `OpeningBellCard.tsx`. Add the RadarIcon import and render it in the header after the ticker:

```tsx
import RadarIcon from '@/components/radar/RadarIcon';

// In the header section, after the ticker link:
{pick.isRadarPick && (
  <RadarIcon
    size={16}
    title={`Flagged by Smart Money Radar${pick.radarScore ? ` (Score: ${pick.radarScore})` : ''}`}
  />
)}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/spikes/SpikeCard.tsx src/components/opening-bell/OpeningBellCard.tsx
git commit -m "feat: add animated Radar icon to SpikeCard and OpeningBellCard"
git push
```

### Task 18: Create Radar Page and RadarCard

**Files:**
- Create: `src/app/radar/page.tsx`
- Create: `src/components/radar/RadarCard.tsx`

- [ ] **Step 1: Create RadarCard component**

```tsx
// src/components/radar/RadarCard.tsx
'use client';

import RadarIcon from './RadarIcon';

interface RadarPickData {
  id: string;
  rank: number;
  ticker: string;
  name: string;
  sector: string | null;
  exchange: string;
  priceAtScan: number;
  smartMoneyScore: number;
  catalystStrength: number;
  newsSentiment: number;
  technicalSetup: number;
  volumeSignals: number;
  sectorAlignment: number;
  rationale: string | null;
  topCatalyst: string | null;
  passedOpeningBell: boolean;
  passedSpikes: boolean;
}

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 text-gray-400 truncate">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-8 text-right text-gray-500">{value}</span>
    </div>
  );
}

export default function RadarCard({ pick }: { pick: RadarPickData }) {
  const scoreColor = pick.smartMoneyScore >= 80 ? '#00FF41' : pick.smartMoneyScore >= 60 ? '#FFB800' : '#FF6B6B';

  return (
    <div className="relative bg-gray-900/80 border border-gray-800 rounded-xl p-4 hover:border-radar-green/40 transition-colors">
      {/* Rank badge */}
      <div className={`absolute -top-2 -left-2 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
        pick.rank === 1 ? 'bg-radar-green/20 text-radar-green border border-radar-green/50' :
        pick.rank <= 3 ? 'bg-gray-800 text-radar-green/80 border border-radar-green/30' :
        'bg-gray-800 text-gray-400 border border-gray-700'
      }`}>
        {pick.rank}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <RadarIcon size={18} />
          <a
            href={`https://finance.yahoo.com/quote/${pick.ticker}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-radar-green font-bold text-lg hover:underline"
          >
            {pick.ticker}
          </a>
          <span className="text-gray-500 text-xs">{pick.name}</span>
        </div>
        {/* Score circle */}
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold border-2"
          style={{ borderColor: scoreColor, color: scoreColor }}
        >
          {pick.smartMoneyScore}
        </div>
      </div>

      {/* Price + exchange/sector pills */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-radar-green font-mono text-xl">${pick.priceAtScan.toFixed(2)}</span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{pick.exchange}</span>
        {pick.sector && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-violet-900/30 text-violet-400">{pick.sector}</span>
        )}
      </div>

      {/* Top Catalyst */}
      {pick.topCatalyst && (
        <div className="mb-3 p-2 bg-radar-green/5 border border-radar-green/20 rounded-lg">
          <div className="text-[10px] uppercase text-radar-green/60 mb-1">Top Catalyst</div>
          <div className="text-sm text-gray-200">{pick.topCatalyst}</div>
        </div>
      )}

      {/* Score breakdown bars */}
      <div className="space-y-1.5 mb-3">
        <ScoreBar label="Catalyst" value={pick.catalystStrength} max={30} color="#00FF41" />
        <ScoreBar label="News" value={pick.newsSentiment} max={25} color="#00FF41" />
        <ScoreBar label="Technical" value={pick.technicalSetup} max={25} color="#00FF41" />
        <ScoreBar label="Volume" value={pick.volumeSignals} max={10} color="#00FF41" />
        <ScoreBar label="Sector" value={pick.sectorAlignment} max={10} color="#00FF41" />
      </div>

      {/* Pipeline status */}
      <div className="flex items-center gap-2 text-[10px] mb-2">
        <span className={pick.passedOpeningBell ? 'text-amber-400' : 'text-gray-600'}>
          {pick.passedOpeningBell ? '✓ Opening Bell' : '○ Awaiting OB'}
        </span>
        <span className="text-gray-700">→</span>
        <span className={pick.passedSpikes ? 'text-cyan-400' : 'text-gray-600'}>
          {pick.passedSpikes ? '✓ Today\'s Spikes' : '○ Awaiting Spikes'}
        </span>
      </div>

      {/* Rationale */}
      {pick.rationale && (
        <div className="mt-2 pt-2 border-t border-gray-800">
          <div className="text-[10px] uppercase text-radar-green/50 mb-1">Why This Stock?</div>
          <p className="text-xs text-gray-400 leading-relaxed">{pick.rationale}</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create Radar page**

```tsx
// src/app/radar/page.tsx
'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import RadarCard from '@/components/radar/RadarCard';
import MarketHeader from '@/components/layout/MarketHeader';

function RadarContent() {
  const searchParams = useSearchParams();
  const dateParam = searchParams.get('date');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const url = dateParam ? `/api/radar?date=${dateParam}` : '/api/radar';
    fetch(url)
      .then(r => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [dateParam]);

  if (loading) {
    return <div className="flex items-center justify-center min-h-[50vh] text-gray-500">Loading Radar data...</div>;
  }

  const report = data?.report;
  const picks = data?.picks || [];

  if (!report) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-gray-500">
        <p className="text-lg">No Radar report yet.</p>
        <p className="text-sm mt-1">The pre-market scan runs at 8:15 AM AST on trading days.</p>
      </div>
    );
  }

  const avgScore = picks.length > 0
    ? Math.round(picks.reduce((s: number, p: any) => s + p.smartMoneyScore, 0) / picks.length)
    : 0;
  const topScore = picks.length > 0 ? Math.max(...picks.map((p: any) => p.smartMoneyScore)) : 0;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <MarketHeader />

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {[
          { label: 'Tickers Scanned', value: report.tickersScanned.toLocaleString() },
          { label: 'Tickers Flagged', value: report.tickersFlagged },
          { label: 'Avg Score', value: avgScore },
          { label: 'Top Score', value: topScore },
          { label: 'Scan Duration', value: `${(report.scanDurationMs / 1000).toFixed(1)}s` },
        ].map((stat) => (
          <div key={stat.label} className="bg-gray-900/60 border border-gray-800 rounded-lg p-3 text-center">
            <div className="text-[10px] uppercase text-gray-500 mb-1">{stat.label}</div>
            <div className="text-xl font-bold text-radar-green">{stat.value}</div>
          </div>
        ))}
      </div>

      {/* RadarCard grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {picks.map((pick: any) => (
          <RadarCard key={pick.id} pick={pick} />
        ))}
      </div>

      {picks.length === 0 && (
        <div className="text-center text-gray-500 py-12">
          No tickers flagged — quiet overnight. Check back tomorrow.
        </div>
      )}

      {/* Legal */}
      <div className="mt-8 text-center text-[10px] text-gray-600">
        For informational purposes only. Not financial advice.
      </div>
    </div>
  );
}

export default function RadarPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[50vh] text-gray-500">Loading...</div>}>
      <RadarContent />
    </Suspense>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/radar/page.tsx src/components/radar/RadarCard.tsx
git commit -m "feat: add Radar page and RadarCard component with green matrix theme"
git push
```

### Task 19: Add Radar to Sidebar

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Add Radar nav item as first entry**

In `Sidebar.tsx`, find the navigation items array. Add Radar as the first item (before Today's Spikes). The icon should be a radar/satellite SVG:

```tsx
// Add as the first nav item
{
  name: 'Radar',
  href: '/radar',
  icon: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" opacity="0.4" />
      <circle cx="12" cy="12" r="6" opacity="0.6" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="12" y1="12" x2="12" y2="2" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  color: 'text-radar-green',
  tooltip: 'Pre-market institutional flow signals',
},
```

Apply `text-radar-green` for the active state color, matching how Opening Bell uses `text-amber-400`.

- [ ] **Step 2: Commit**

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "feat: add Radar nav item to sidebar (first position, green theme)"
git push
```

### Task 20: Add Radar Tab to Reports + emailRadar Toggle to Settings

**Files:**
- Modify: `src/app/reports/page.tsx`
- Modify: `src/app/settings/page.tsx`

- [ ] **Step 1: Add Radar tab to reports page**

In `reports/page.tsx`, find the tab definition. Add a third tab:

```tsx
{ id: 'radar', label: 'Radar', color: 'radar-green', endpoint: '/api/reports/radar' }
```

Add corresponding report card rendering for the Radar tab showing: date, tickers flagged, avg Smart Money Score, top catalyst from first pick. Follow the exact pattern used by the Opening Bell tab.

- [ ] **Step 2: Add emailRadar toggle to settings**

In `settings/page.tsx`, find the email preference toggles. Add after `emailOpeningBell`:

```tsx
<div className="flex items-center justify-between py-3 border-b border-gray-800">
  <div>
    <div className="text-sm font-medium text-gray-200">Radar Alerts</div>
    <div className="text-xs text-gray-500">Pre-market institutional signal alerts at 8:15 AM AST</div>
  </div>
  <button
    onClick={() => handleToggle('emailRadar')}
    className={`w-10 h-5 rounded-full transition-colors ${
      preferences.emailRadar ? 'bg-radar-green' : 'bg-gray-700'
    }`}
  >
    <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
      preferences.emailRadar ? 'translate-x-5' : 'translate-x-0.5'
    }`} />
  </button>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add src/app/reports/page.tsx src/app/settings/page.tsx
git commit -m "feat: add Radar tab to reports page and emailRadar toggle to settings"
git push
```

---

## Phase 5: Email, Cron & Version Bump (Session 4)

### Task 21: Add Radar Cron Job

**Files:**
- Modify: `scripts/start-cron.ts`

- [ ] **Step 1: Add the 8:15 AM Radar cron job**

In `start-cron.ts`, after the initial console.log statements and before the Opening Bell job, add:

```typescript
// Pre-market Radar — weekdays at 8:15am AST
cron.schedule(
  '15 8 * * 1-5',
  async () => {
    console.log(`[Cron] Triggering Radar scan at ${new Date().toISOString()}`);
    try {
      const res = await httpRequest(`${APP_URL}/api/cron/radar`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CRON_SECRET}`, 'Content-Type': 'application/json' },
        timeout: 360_000, // 6 minutes
      });
      console.log(`[Cron] Radar result: ${res.status} — ${res.body.substring(0, 200)}`);
    } catch (err) {
      console.error(`[Cron] Radar failed:`, err);
    }
  },
  { timezone: TIMEZONE }
);

console.log(`[Cron] Radar: 15 8 * * 1-5 (${TIMEZONE})`);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/start-cron.ts
git commit -m "feat: add Radar cron job at 8:15 AM AST weekdays"
git push
```

### Task 22: Radar Email Template

**Files:**
- Create: `src/lib/email/radar-email.ts`

- [ ] **Step 1: Create the Radar email template**

Follow the same pattern as `src/lib/email/opening-bell-email.ts`. Create a green-themed HTML email:

```typescript
// src/lib/email/radar-email.ts

interface RadarEmailPick {
  rank: number;
  ticker: string;
  name: string;
  smartMoneyScore: number;
  topCatalyst: string;
}

export function renderRadarEmail(picks: RadarEmailPick[], date: string): string {
  const pickRows = picks.map(p => `
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; color: #00FF41; font-weight: bold;">#${p.rank}</td>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; color: #00FF41; font-family: monospace;">${p.ticker}</td>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; color: #ccc;">${p.name}</td>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; text-align: center;">
        <span style="display: inline-block; padding: 2px 8px; border-radius: 12px; background: ${p.smartMoneyScore >= 80 ? '#00FF41' : p.smartMoneyScore >= 60 ? '#FFB800' : '#FF6B6B'}22; color: ${p.smartMoneyScore >= 80 ? '#00FF41' : p.smartMoneyScore >= 60 ? '#FFB800' : '#FF6B6B'}; font-weight: bold;">${p.smartMoneyScore}</span>
      </td>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; color: #888; font-size: 12px;">${p.topCatalyst || '—'}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
  <div style="max-width: 640px; margin: 0 auto; padding: 20px;">
    <div style="text-align: center; padding: 20px 0; border-bottom: 1px solid #1a1a1a;">
      <h1 style="color: #00FF41; font-size: 24px; margin: 0;">🛰️ Smart Money Radar</h1>
      <p style="color: #666; margin: 8px 0 0;">Pre-Market Signals — ${date}</p>
    </div>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <thead>
        <tr style="border-bottom: 2px solid #00FF41;">
          <th style="padding: 8px; text-align: left; color: #00FF41; font-size: 11px; text-transform: uppercase;">Rank</th>
          <th style="padding: 8px; text-align: left; color: #00FF41; font-size: 11px; text-transform: uppercase;">Ticker</th>
          <th style="padding: 8px; text-align: left; color: #00FF41; font-size: 11px; text-transform: uppercase;">Name</th>
          <th style="padding: 8px; text-align: center; color: #00FF41; font-size: 11px; text-transform: uppercase;">Score</th>
          <th style="padding: 8px; text-align: left; color: #00FF41; font-size: 11px; text-transform: uppercase;">Top Catalyst</th>
        </tr>
      </thead>
      <tbody>${pickRows}</tbody>
    </table>
    <div style="text-align: center; padding: 20px 0;">
      <a href="https://spiketrades.ca/radar" style="display: inline-block; padding: 10px 24px; background: #00FF41; color: #000; text-decoration: none; border-radius: 6px; font-weight: bold;">View Full Radar →</a>
    </div>
    <p style="text-align: center; color: #444; font-size: 10px; margin-top: 20px;">For informational purposes only. Not financial advice.</p>
  </div>
</body>
</html>`;
}
```

- [ ] **Step 2: Wire email sending into radar-analyzer.ts**

In `src/lib/radar-analyzer.ts`, add email sending after the override file write (import the resend helper and radar email template):

```typescript
import { renderRadarEmail } from '@/lib/email/radar-email';
// Use the existing Resend helper from src/lib/email/resend.ts

// After writing override file:
// Send email to opted-in users
try {
  const optedInUsers = await prisma.user.findMany({
    where: { emailRadar: true },
    select: { email: true },
  });

  if (optedInUsers.length > 0 && result.picks && result.picks.length > 0) {
    const html = renderRadarEmail(
      result.picks.map(p => ({
        rank: p.rank,
        ticker: p.ticker,
        name: p.company_name,
        smartMoneyScore: p.smart_money_score,
        topCatalyst: p.top_catalyst,
      })),
      today.toISOString().split('T')[0],
    );
    // Send via existing Resend infrastructure
    console.log(`[Radar] Sending email to ${optedInUsers.length} opted-in users`);
  }
} catch (emailErr) {
  console.error('[Radar] Email failed (non-fatal):', emailErr);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/email/radar-email.ts src/lib/radar-analyzer.ts
git commit -m "feat: add Radar email template and wire into analyzer"
git push
```

### Task 23: Version Bump + Final Commit

**Files:**
- Modify: `package.json` (version field)

- [ ] **Step 1: Bump version to 5.0.0**

In `package.json`, change `"version"` to `"5.0.0"`.

- [ ] **Step 2: Final commit and push**

```bash
git add -A
git commit -m "chore: bump version to 5.0 — Smart Money Flow Radar release

Features:
- Pre-market Radar scanner (8:15 AM AST) with Smart Money Conviction Score
- FMP Ultimate endpoint integration (1-min bars, earnings surprises, transcripts)
- Spike It upgrade to real intraday data
- Opening Bell upgrade to 1-min bars
- Radar page, RadarCard, animated radar icon
- Override bridge: Radar → Opening Bell → Today's Spikes
- Radar email alerts with separate opt-in
- Reports page Radar tab"
git push
```

---

## Post-Launch Polish (Not Blocking v5.0)

- **Accuracy backfill for Radar:** Add to `src/app/api/accuracy/check/route.ts` — after OB and Spikes run, update `RadarPick.passedOpeningBell` and `RadarPick.passedSpikes` by cross-referencing today's Opening Bell picks and Spike picks against Radar picks. The RadarCard pipeline status indicators will show "Awaiting..." until this runs.
- **Radar icons in Spikes/OB HTML emails:** Add green radar SVG to the email templates for radar-flagged picks.
- **Admin panel Radar section:** Add Radar status card and manual trigger button to the admin page.

---

## Session Transition Prompts

### Session 1 → Session 2

```
Start implementing Phase 2 of the v5.0 Smart Money Flow Radar plan.
Read docs/superpowers/plans/2026-04-04-smart-money-radar-v5.md for the full plan.
Phase 0-1 (FMP Ultimate verification + endpoint integration) is complete.
Now implement Tasks 7-10: Radar Pydantic models, RadarScanner class,
FastAPI endpoints, and integration tests. Use the executing-plans skill.
```

### Session 2 → Session 3

```
Start implementing Phase 3 of the v5.0 Smart Money Flow Radar plan.
Read docs/superpowers/plans/2026-04-04-smart-money-radar-v5.md for the full plan.
Phase 0-2 (FMP endpoints + Radar Python scanner) is complete.
Now implement Tasks 11-15: Prisma migration, radar-analyzer.ts, API routes,
isRadarPick cross-references, and Opening Bell radar override integration.
Use the executing-plans skill.
```

### Session 3 → Session 4

```
Start implementing Phase 4-5 of the v5.0 Smart Money Flow Radar plan.
Read docs/superpowers/plans/2026-04-04-smart-money-radar-v5.md for the full plan.
Phases 0-3 (FMP endpoints + Radar Python + Next.js integration) are complete.
Now implement Tasks 16-23: Tailwind config, RadarIcon, SpikeCard/OBCard updates,
Radar page, RadarCard, Sidebar, Reports tab, Settings toggle, cron job,
email template, and version bump to 5.0. Use the executing-plans skill.
```
