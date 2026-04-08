"""
canadian_llm_council_brain.py
═══════════════════════════════════════════════════════════════════════════
Spike Trades — Canadian LLM Council Brain
The primary logic brain for an automated 4-stage LLM Council that screens,
analyzes, challenges, and ranks Canadian TSX/TSXV stocks for short-term
(3/5/8-day) momentum trades.

Pipeline:
  Stage 1 — Claude Sonnet 4.6    → screens universe to Top 100
  Stage 2 — Gemini 3.1 Pro       → narrows to Top 80
  Stage 3 — Claude Opus 4.6      → narrows to Top 40
  Stage 4 — SuperGrok Heavy (xAI)→ final Top 10 with probabilistic forecasts

Fully self-contained.  Import into FastAPI, Airflow, cron, or any Python app.

Public interface:
    brain = CanadianStockCouncilBrain(anthropic_api_key=..., ...)
    result = await brain.run_council()

Author : Spike Trades Engineering
License: Proprietary
═══════════════════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import asyncio
import aiohttp
import certifi
import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import ssl
import statistics
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta, date
from zoneinfo import ZoneInfo
from enum import Enum
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

import eodhd_news

import fmp_bulk_cache

# ═══════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════

logger = logging.getLogger("spike_trades.council")


def _read_council_config_min_adv(default: int = 5_000_000) -> int:
    """
    Read the configured minimum ADV threshold from the CouncilConfig Prisma table.

    Returns the configured value on success, or `default` on any error (missing
    table, empty row, DB connection failure, etc). Non-blocking — never raises.

    The value is set via the admin panel (/admin → Council tab → ADV Slider).
    See docs/superpowers/specs/2026-04-08-adv-slider-admin-control-design.md
    """
    try:
        database_url = os.getenv("DATABASE_URL", "")
        if not database_url:
            logger.warning(f"DATABASE_URL not set, using default MIN_ADV_DOLLARS=${default:,}")
            return default
        # Lazy import so this function is usable even when psycopg2 is not installed
        import psycopg2
        conn = psycopg2.connect(database_url)
        try:
            cur = conn.cursor()
            cur.execute('SELECT "minAdvDollars" FROM "CouncilConfig" WHERE id = %s', ('singleton',))
            row = cur.fetchone()
            if row and row[0]:
                value = int(row[0])
                logger.info(f"Council config: MIN_ADV_DOLLARS=${value:,} (from DB)")
                return value
            logger.info(f"Council config: singleton row missing, using default ${default:,}")
            return default
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"Failed to read CouncilConfig, using default ${default:,}: {type(e).__name__}: {e}")
        return default


# ═══════════════════════════════════════════════════════════════════════════
# PYDANTIC V2 MODELS
# ═══════════════════════════════════════════════════════════════════════════


class TechnicalIndicators(BaseModel):
    """Computed technical indicators for a stock."""
    rsi_14: float = Field(..., ge=0, le=100, description="14-period RSI")
    macd_line: float = Field(..., description="MACD line value")
    macd_signal: float = Field(..., description="MACD signal line")
    macd_histogram: float = Field(..., description="MACD histogram")
    adx_14: float = Field(..., ge=0, description="14-period ADX")
    atr_14: float = Field(..., ge=0, description="14-period ATR")
    bollinger_upper: float = Field(..., description="Upper Bollinger Band (20,2)")
    bollinger_lower: float = Field(..., description="Lower Bollinger Band (20,2)")
    bollinger_mid: float = Field(..., description="Middle Bollinger Band (20-SMA)")
    sma_20: float = Field(..., description="20-period SMA")
    sma_50: float = Field(..., description="50-period SMA")
    volume_sma_20: float = Field(..., ge=0, description="20-period volume SMA")
    relative_volume: float = Field(..., ge=0, description="Current vol / 20-day avg vol")


class MacroContext(BaseModel):
    """Canadian macro environment snapshot."""
    oil_wti: Optional[float] = Field(None, description="WTI crude price USD")
    oil_brent: Optional[float] = Field(None, description="Brent crude price USD")
    gold_price: Optional[float] = Field(None, description="Gold spot price USD")
    btc_price: Optional[float] = Field(None, description="Bitcoin price CAD")
    tsx_composite: Optional[float] = Field(None, description="S&P/TSX Composite level")
    tsx_change_pct: Optional[float] = Field(None, description="TSX daily change %")
    cad_usd: Optional[float] = Field(None, description="CAD/USD exchange rate")
    vix: Optional[float] = Field(None, description="VIX index level")
    us_10y_yield: Optional[float] = Field(None, description="US 10Y Treasury yield")
    regime: str = Field(default="NEUTRAL", description="Detected macro regime")
    as_of: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))



class EarningsEvent(BaseModel):
    """Upcoming earnings event for a ticker."""
    model_config = {"arbitrary_types_allowed": True}
    earnings_date: str = Field(..., description="YYYY-MM-DD date of earnings")
    eps_estimated: Optional[float] = None
    revenue_estimated: Optional[float] = None
    days_until: int = Field(..., ge=0, description="Trading days until earnings")


class InsiderActivity(BaseModel):
    """Aggregated insider trading signal."""
    net_buy_ratio: float = Field(..., ge=-1.0, le=1.0, description="-1=all sells, +1=all buys")
    total_transactions: int = Field(default=0, ge=0)
    net_shares: int = Field(default=0, description="Net shares bought or sold")
    recency_weighted_score: float = Field(default=0.0, ge=-1.0, le=1.0)
    last_filing_date: Optional[str] = None


class AnalystConsensus(BaseModel):
    """Wall Street analyst consensus data."""
    strong_buy: int = Field(default=0, ge=0)
    buy: int = Field(default=0, ge=0)
    hold: int = Field(default=0, ge=0)
    sell: int = Field(default=0, ge=0)
    strong_sell: int = Field(default=0, ge=0)
    sentiment_score: float = Field(default=0.0, ge=-1.0, le=1.0)
    target_upside_pct: Optional[float] = Field(None, description="% upside to consensus target")


class IVExpectedMove(BaseModel):
    """ATR-based implied volatility proxy for expected move sizing."""
    implied_volatility: float = Field(description="Annualized IV from ATR proxy")
    expected_move_1sd_pct: float = Field(description="1SD expected move % for 3-day horizon")
    expected_move_2sd_pct: float = Field(description="2SD expected move % for 3-day horizon")
    iv_available: bool = Field(default=True)


class StockDataPayload(BaseModel):
    """Complete data package for a single ticker, sent to LLM stages."""
    ticker: str = Field(..., description="TSX ticker e.g. RY.TO")
    company_name: str = Field(default="", description="Company name")
    sector: str = Field(default="Unknown", description="GICS sector")
    industry: str = Field(default="Unknown", description="Industry")
    price: float = Field(..., gt=0, description="Latest price CAD")
    change_pct: float = Field(..., description="Daily change %")
    volume: int = Field(..., ge=0, description="Latest volume")
    avg_volume_20d: float = Field(..., ge=0, description="20-day avg volume")
    market_cap: Optional[float] = Field(None, description="Market cap CAD")
    adv_dollars: float = Field(..., ge=0, description="Avg daily dollar volume CAD")
    historical_bars: list[dict[str, Any]] = Field(default_factory=list, description="OHLCV bars")
    technicals: Optional[TechnicalIndicators] = None
    news: list[Any] = Field(default_factory=list)
    news_sentiment: Optional[float] = Field(None, ge=-1, le=1)
    macro: Optional[MacroContext] = None
    earnings_event: Optional[EarningsEvent] = None
    insider_activity: Optional[InsiderActivity] = None
    analyst_consensus: Optional[AnalystConsensus] = None
    sector_relative_strength: Optional[float] = Field(None, description="Ticker change% minus sector avg")
    institutional_ownership_pct: Optional[float] = Field(None, ge=0.0, le=1.0, description="Fraction of shares held by institutions (from /v4/institutional-ownership)")
    iv_expected_move: Optional[IVExpectedMove] = Field(default=None)
    earnings_surprise_history: list[dict] = Field(default_factory=list, description="Recent earnings surprises (last 8 quarters)")
    earnings_transcript_summary: str | None = Field(default=None, description="Truncated most-recent earnings call transcript")
    as_of: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    data_quality: str = Field(default="OK", description="OK or STALE_DATA or MISSING_FIELD")

    @field_validator("ticker")
    @classmethod
    def ticker_must_be_canadian(cls, v: str) -> str:
        if not v.endswith(".TO") and not v.endswith(".V"):
            raise ValueError(f"Ticker {v} must end with .TO or .V for Canadian markets")
        return v.upper()


class ScoreBreakdown(BaseModel):
    """100-point rubric score breakdown."""
    technical_momentum: float = Field(..., ge=0, le=30)
    sentiment_catalysts: float = Field(..., ge=0, le=25)
    options_volatility: float = Field(..., ge=0, le=20)
    risk_reward: float = Field(..., ge=0, le=15)
    conviction: float = Field(..., ge=0, le=10)
    total: float = Field(..., ge=0, le=100)

    @model_validator(mode="after")
    def total_must_match(self) -> "ScoreBreakdown":
        expected = (self.technical_momentum + self.sentiment_catalysts +
                    self.options_volatility + self.risk_reward + self.conviction)
        if abs(self.total - expected) > 0.5:
            raise ValueError(
                f"Total {self.total} doesn't match sum of components {expected}"
            )
        return self


class ProbabilisticForecast(BaseModel):
    """Explicit probabilistic forecast for a time horizon."""
    horizon_days: int = Field(..., ge=1, le=30)
    direction_probability: float = Field(..., ge=0, le=1,
                                         description="Probability of predicted direction")
    predicted_direction: str = Field(..., description="UP or DOWN")
    most_likely_move_pct: float = Field(..., description="Most likely % move")
    price_range_low: float = Field(..., gt=0, description="68% confidence low price")
    price_range_high: float = Field(..., gt=0, description="68% confidence high price")
    clarity_decay_note: str = Field(default="", description="√time decay observation")


class StageOutput(BaseModel):
    """Output from a single LLM stage for one ticker."""
    ticker: str
    stage: int = Field(..., ge=1, le=4)
    model_name: str = Field(..., description="Model that produced this output")
    score: ScoreBreakdown
    reasoning: str = Field(default="", description="LLM reasoning summary")
    verification_notes: str = Field(default="", description="Chain-of-Verification output")
    kill_condition: Optional[str] = Field(None, description="Opus Stage 3 only")
    worst_case_scenario: Optional[str] = Field(None, description="Opus Stage 3 only")
    disagreement_reason: Optional[str] = Field(None, description="Gemini Stage 2 only")
    forecasts: list[ProbabilisticForecast] = Field(default_factory=list,
                                                    description="Grok Stage 4 only")
    as_of: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ConvictionTier(str, Enum):
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class FinalHotPick(BaseModel):
    """A single Top 10 hot pick with all council data."""
    rank: int = Field(..., ge=1, le=10)
    ticker: str
    company_name: str = ""
    sector: str = "Unknown"
    price: float = Field(..., gt=0)
    change_pct: float = 0.0
    consensus_score: float = Field(..., ge=0, le=100)
    conviction_tier: ConvictionTier
    institutional_conviction_score: Optional[int] = Field(None, ge=0, le=100, description="IIC 0-100, None if insufficient data")
    stages_appeared: int = Field(..., ge=1, le=4)
    stage_scores: dict[str, ScoreBreakdown] = Field(default_factory=dict)
    forecasts: list[ProbabilisticForecast] = Field(default_factory=list)
    key_catalyst: str = ""
    kill_condition: str = ""
    worst_case_scenario: str = ""
    reasoning_summary: str = ""
    technicals: Optional[TechnicalIndicators] = None
    historical_edge_multiplier: float = Field(default=1.0, ge=0)
    calibration: Optional[dict] = Field(default=None, description="Historical calibration data")
    earnings_flag: bool = Field(default=False, description="True if earnings within prediction window")
    insider_signal: Optional[float] = Field(None, ge=-1.0, le=1.0)
    analyst_upside_pct: Optional[float] = None
    sector_relative_strength: Optional[float] = None
    learning_adjustments: Optional[dict] = Field(default=None, description="Per-pick learning engine adjustments")
    as_of: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AllocationEntry(BaseModel):
    """Position sizing for a single pick."""
    ticker: str
    shares: int = Field(..., ge=0)
    entry_price: float = Field(..., gt=0)
    stop_loss: float = Field(..., gt=0)
    dollar_risk: float = Field(..., ge=0)
    position_pct: float = Field(..., ge=0, le=100)


class RoadmapEntry(BaseModel):
    """Single day in the compounding roadmap."""
    date: date
    day_number: int = Field(..., ge=1, le=10)
    action: str = Field(..., description="HOLD, ENTER, EXIT, PYRAMID, ROTATE")
    tickers_involved: list[str] = Field(default_factory=list)
    projected_portfolio_value: float = Field(..., ge=0)
    confidence_band_low: float = Field(..., ge=0)
    confidence_band_high: float = Field(..., ge=0)
    notes: str = ""


class DailyRoadmap(BaseModel):
    """10-trading-day rolling roadmap."""
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    starting_portfolio_value: float = Field(..., ge=0)
    entries: list[RoadmapEntry] = Field(..., min_length=1, max_length=10)
    methodology_note: str = Field(
        default="Based on 3/5/8-day probabilistic forecasts with expectancy-weighted "
                "compounding. Confidence bands widen with √time."
    )


class RiskSummary(BaseModel):
    """Portfolio-level risk metrics."""
    total_positions: int = Field(..., ge=0)
    total_heat_pct: float = Field(..., ge=0, le=100)
    max_single_position_pct: float = Field(..., ge=0, le=100)
    avg_risk_per_trade_pct: float = Field(..., ge=0)
    allocation_table: list[AllocationEntry] = Field(default_factory=list)


class CouncilResult(BaseModel):
    """Complete output from a council run."""
    run_id: str = Field(..., description="Unique run identifier")
    run_date: date
    run_timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    macro_context: MacroContext
    regime: str
    universe_size: int = Field(..., ge=0)
    tickers_screened: int = Field(..., ge=0)
    top_picks: list[FinalHotPick] = Field(..., max_length=10)
    risk_summary: Optional[RiskSummary] = None
    daily_roadmap: Optional[DailyRoadmap] = None
    stage_metadata: dict[str, Any] = Field(default_factory=dict)
    fact_check_flags: list[str] = Field(default_factory=list)
    total_runtime_seconds: float = Field(..., ge=0)


# ═══════════════════════════════════════════════════════════════════════════
# LIVE DATA FETCHER
# ═══════════════════════════════════════════════════════════════════════════

# Freshness thresholds
QUOTE_MAX_AGE_SECONDS = 300       # 5 minutes
NEWS_MAX_AGE_SECONDS = 3600       # 60 minutes
OHLCV_MAX_AGE_SECONDS = 86400    # 24 hours

FMP_BASE = "https://financialmodelingprep.com/stable"


class LiveDataFetcher:
    """Async data client for FMP with strict freshness validation."""

    def __init__(self, fmp_api_key: str):
        self.fmp_key = fmp_api_key
        self._session: Optional[aiohttp.ClientSession] = None
        self._profile_cache: dict[str, dict] = {}
        # Endpoint health tracking: {path: {"ok": N, "404": N, "429": N, "error": N}}
        self.endpoint_health: dict[str, dict[str, int]] = {}

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            ssl_ctx = ssl.create_default_context(cafile=certifi.where())
            conn = aiohttp.TCPConnector(ssl=ssl_ctx, limit=20)
            self._session = aiohttp.ClientSession(
                connector=conn,
                timeout=aiohttp.ClientTimeout(total=30),
            )
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    def _track_endpoint(self, path: str, status: str) -> None:
        """Track FMP endpoint health for admin dashboard."""
        base_path = path.split("?")[0]
        if base_path not in self.endpoint_health:
            self.endpoint_health[base_path] = {"ok": 0, "404": 0, "429": 0, "error": 0}
        self.endpoint_health[base_path][status] = self.endpoint_health[base_path].get(status, 0) + 1

    async def _fmp_get(self, path: str, params: dict | None = None) -> Any:
        """Make a GET request to FMP /stable/ API with retry on 429."""
        session = await self._get_session()
        params = params or {}
        params["apikey"] = self.fmp_key
        url = f"{FMP_BASE}{path}"
        for attempt in range(5):
            async with session.get(url, params=params) as resp:
                if resp.status == 429:
                    self._track_endpoint(path, "429")
                    wait = 5 * (2 ** attempt)  # 5s, 10s, 20s, 40s, 80s
                    logger.warning(f"FMP {path} rate limited, retrying in {wait}s (attempt {attempt + 1}/5)")
                    await asyncio.sleep(wait)
                    continue
                if resp.status == 404:
                    self._track_endpoint(path, "404")
                    # Log once per endpoint, not per ticker (reduce noise)
                    if self.endpoint_health.get(path.split("?")[0], {}).get("404", 0) == 1:
                        logger.warning(f"FMP {path} returned 404 — endpoint may be deprecated")
                    return None
                if resp.status != 200:
                    self._track_endpoint(path, "error")
                    text = await resp.text()
                    logger.error(f"FMP {path} returned {resp.status}: {text[:200]}")
                    return None
                self._track_endpoint(path, "ok")
                return await resp.json()
        self._track_endpoint(path, "429")
        logger.error(f"FMP {path} failed after 5 retries (429)")
        return None

    # ── TSX Universe ──────────────────────────────────────────────────

    async def fetch_tsx_universe(self) -> list[str]:
        """Fetch all TSX-listed tickers from FMP /stable/stock-list."""
        data = await self._fmp_get("/stock-list")
        if not data:
            logger.error("Failed to fetch stock list from FMP")
            return []
        tsx_tickers = [
            item["symbol"] for item in data
            if isinstance(item, dict)
            and item.get("symbol", "").endswith(".TO")
        ]
        logger.info(f"Fetched {len(tsx_tickers)} TSX tickers from FMP")
        return sorted(set(tsx_tickers))

    # ── Profiles (sector, industry, avgVolume) ────────────────────────

    async def fetch_profile(self, ticker: str) -> dict:
        """Fetch company profile. Cached per session."""
        if ticker in self._profile_cache:
            return self._profile_cache[ticker]
        data = await self._fmp_get("/profile", params={"symbol": ticker})
        if data and isinstance(data, list) and data:
            self._profile_cache[ticker] = data[0]
            return data[0]
        return {}

    async def fetch_profiles_batch(self, tickers: list[str]) -> dict[str, dict]:
        """Fetch profiles for multiple tickers. Optimized for FMP Ultimate (3000 calls/min)."""
        result = {}
        sem = asyncio.Semaphore(10)  # Was 3 — 3.3x more concurrent
        async def _fetch(t: str):
            async with sem:
                p = await self.fetch_profile(t)
                if p:
                    result[t] = p
                await asyncio.sleep(0.05)  # Was 0.3s — minimal politeness delay
        for i in range(0, len(tickers), 50):  # Was 20 — larger batches
            batch = tickers[i:i + 50]
            await asyncio.gather(*[_fetch(t) for t in batch])
            if i + 50 < len(tickers):
                logger.info(f"Profiles: {min(i + 50, len(tickers))}/{len(tickers)} fetched")
                await asyncio.sleep(0.5)  # Was 3s — much shorter pause
        return result

    async def fetch_profiles_bulk(self, tickers: list[str]) -> dict[str, dict]:
        """Try FMP bulk profile endpoint first, fall back to per-ticker fetch.

        The /stable/batch-profile endpoint (if available on Ultimate) returns
        profiles for all requested symbols in a single call.
        """
        # Try bulk endpoint first
        symbols = ",".join(tickers[:200])  # Cap at 200 per call
        bulk_data = await self._fmp_get("/batch-profile", params={"symbols": symbols})

        if bulk_data and isinstance(bulk_data, list) and len(bulk_data) > 5:
            # Bulk endpoint works — use it
            result = {}
            for p in bulk_data:
                if isinstance(p, dict) and p.get("symbol"):
                    self._profile_cache[p["symbol"]] = p
                    result[p["symbol"]] = p
            logger.info(f"Bulk profile fetch: got {len(result)}/{len(tickers)} profiles in 1 call")

            # Fetch remaining tickers not in bulk response (if any)
            missing = [t for t in tickers if t not in result]
            if missing:
                logger.info(f"Bulk profile: {len(missing)} tickers missing — falling back to per-ticker")
                extra = await self.fetch_profiles_batch(missing)
                result.update(extra)

            return result

        # Bulk endpoint not available — fall back to per-ticker
        logger.info("Bulk profile endpoint unavailable — using per-ticker fetch")
        return await self.fetch_profiles_batch(tickers)

    # ── Quotes ────────────────────────────────────────────────────────

    async def fetch_quotes(self, tickers: list[str]) -> dict[str, dict]:
        """Fetch real-time quotes for a list of tickers.
        Uses /stable/batch-quote for batches, returns {ticker: quote_dict}."""
        if not tickers:
            return {}
        now = datetime.now(timezone.utc)
        result = {}
        # batch-quote supports comma-separated symbols
        batch_size = 100  # Was 50 — FMP Ultimate supports larger batches
        for i in range(0, len(tickers), batch_size):
            batch = tickers[i:i + batch_size]
            symbols = ",".join(batch)
            data = await self._fmp_get("/batch-quote", params={"symbols": symbols})
            if not data:
                continue
            for q in data:
                if not isinstance(q, dict):
                    continue
                sym = q.get("symbol", "")
                q["as_of"] = now.isoformat()
                result[sym] = q
        logger.info(f"Fetched quotes for {len(result)}/{len(tickers)} tickers")
        return result

    def _check_quote_freshness(self, quote: dict) -> bool:
        """Return True if quote is fresh enough (< 5 min old).
        During non-market hours, we relax this check."""
        ts = quote.get("timestamp")
        if ts is None:
            # No timestamp — log warning but accept (some FMP symbols lack timestamps)
            logger.warning(f"Quote for {quote.get('symbol', '?')} has no timestamp — accepting but may be stale")
            return True
        try:
            if isinstance(ts, (int, float)):
                quote_time = datetime.fromtimestamp(ts, tz=timezone.utc)
            else:
                quote_time = datetime.fromisoformat(str(ts))
            age = (datetime.now(timezone.utc) - quote_time).total_seconds()
            # During market hours enforce strict freshness
            # During off-hours (evenings, weekends) accept up to 24h
            if age > OHLCV_MAX_AGE_SECONDS:
                return False
            return True
        except (ValueError, TypeError, OSError):
            return True

    # ── Historical Bars ───────────────────────────────────────────────

    async def fetch_historical(self, ticker: str, days: int = 90) -> list[dict]:
        """Fetch daily OHLCV bars for a ticker via /stable/historical-price-eod/full."""
        to_date = date.today().isoformat()
        from_date = (date.today() - timedelta(days=days + 10)).isoformat()
        data = await self._fmp_get(
            "/historical-price-eod/full",
            params={"symbol": ticker, "from": from_date, "to": to_date}
        )
        if not data:
            logger.warning(f"No historical data for {ticker}")
            return []
        # /stable/ returns a flat list of bars, newest first
        if isinstance(data, dict) and "historical" in data:
            bars = data["historical"]
        elif isinstance(data, list):
            bars = data
        else:
            return []
        bars = sorted(bars, key=lambda b: b.get("date", ""))
        return bars

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
        bars = await self._fmp_get(
            "/historical-chart/1min",
            params={"symbol": ticker, "from": date, "to": date}
        )

        if bars and isinstance(bars, list) and len(bars) > 0:
            logger.info(f"[LiveDataFetcher] {ticker}: got {len(bars)} 1-min bars")
            return bars

        # Fallback to 5-min
        bars_5m = await self._fmp_get(
            "/historical-chart/5min",
            params={"symbol": ticker, "from": date, "to": date}
        )

        if bars_5m and isinstance(bars_5m, list) and len(bars_5m) > 0:
            logger.info(f"[LiveDataFetcher] {ticker}: 1-min unavailable, got {len(bars_5m)} 5-min bars")
            return bars_5m

        logger.warning(f"[LiveDataFetcher] {ticker}: no intraday bars available")
        return []

    async def fetch_earnings_transcript(self, ticker: str, year: int, quarter: int) -> dict | None:
        """Fetch earnings call transcript. Returns None if unavailable.

        Most Canadian-only companies won't have transcripts on FMP.
        This is optional enrichment — never required for scoring.
        """
        data = await self._fmp_get(
            f"/earnings-transcript/{ticker}",
            params={"year": year, "quarter": quarter}
        )

        if data and isinstance(data, list) and len(data) > 0:
            transcript = data[0]
            # Truncate to first 2000 chars to avoid blowing up LLM context
            if "content" in transcript and len(transcript["content"]) > 2000:
                transcript["content"] = transcript["content"][:2000] + "... [truncated]"
            logger.info(f"[LiveDataFetcher] {ticker}: got transcript for Q{quarter} {year}")
            return transcript

        return None

    # ── Technical Indicators ──────────────────────────────────────────

    @staticmethod
    def compute_technicals(bars: list[dict]) -> Optional[TechnicalIndicators]:
        """Compute technical indicators from OHLCV bars."""
        if len(bars) < 50:
            logger.warning(f"Need ≥50 bars for technicals, got {len(bars)}")
            return None

        closes = [b["close"] for b in bars]
        highs = [b["high"] for b in bars]
        lows = [b["low"] for b in bars]
        volumes = [b.get("volume", 0) for b in bars]

        # RSI-14
        changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
        gains = [max(c, 0) for c in changes]
        losses = [abs(min(c, 0)) for c in changes]

        avg_gain = sum(gains[:14]) / 14
        avg_loss = sum(losses[:14]) / 14
        for i in range(14, len(gains)):
            avg_gain = (avg_gain * 13 + gains[i]) / 14
            avg_loss = (avg_loss * 13 + losses[i]) / 14
        rs = avg_gain / avg_loss if avg_loss > 0 else 100
        rsi = 100 - (100 / (1 + rs))

        # MACD (12, 26, 9)
        def ema(data: list[float], period: int) -> list[float]:
            k = 2 / (period + 1)
            result = [data[0]]
            for val in data[1:]:
                result.append(val * k + result[-1] * (1 - k))
            return result

        ema12 = ema(closes, 12)
        ema26 = ema(closes, 26)
        macd_line_vals = [a - b for a, b in zip(ema12, ema26)]
        signal_vals = ema(macd_line_vals, 9)
        macd_line = macd_line_vals[-1]
        macd_signal = signal_vals[-1]
        macd_histogram = macd_line - macd_signal

        # ADX-14
        def compute_adx(highs: list, lows: list, closes: list, period: int = 14) -> float:
            tr_list = []
            plus_dm_list = []
            minus_dm_list = []
            for i in range(1, len(highs)):
                tr = max(
                    highs[i] - lows[i],
                    abs(highs[i] - closes[i - 1]),
                    abs(lows[i] - closes[i - 1])
                )
                tr_list.append(tr)
                up = highs[i] - highs[i - 1]
                down = lows[i - 1] - lows[i]
                plus_dm_list.append(up if up > down and up > 0 else 0)
                minus_dm_list.append(down if down > up and down > 0 else 0)

            if len(tr_list) < period:
                return 0.0

            atr = sum(tr_list[:period]) / period
            plus_dm = sum(plus_dm_list[:period]) / period
            minus_dm = sum(minus_dm_list[:period]) / period

            dx_list = []
            for i in range(period, len(tr_list)):
                atr = (atr * (period - 1) + tr_list[i]) / period
                plus_dm = (plus_dm * (period - 1) + plus_dm_list[i]) / period
                minus_dm = (minus_dm * (period - 1) + minus_dm_list[i]) / period
                plus_di = 100 * plus_dm / atr if atr > 0 else 0
                minus_di = 100 * minus_dm / atr if atr > 0 else 0
                di_sum = plus_di + minus_di
                dx = 100 * abs(plus_di - minus_di) / di_sum if di_sum > 0 else 0
                dx_list.append(dx)

            if not dx_list:
                return 0.0
            adx = sum(dx_list[:period]) / min(period, len(dx_list))
            for i in range(period, len(dx_list)):
                adx = (adx * (period - 1) + dx_list[i]) / period
            return adx

        adx = compute_adx(highs, lows, closes)

        # ATR-14
        tr_vals = []
        for i in range(1, len(closes)):
            tr = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1])
            )
            tr_vals.append(tr)
        atr = sum(tr_vals[-14:]) / 14 if len(tr_vals) >= 14 else 0

        # Bollinger Bands (20, 2)
        sma_20 = sum(closes[-20:]) / 20
        std_20 = statistics.stdev(closes[-20:]) if len(closes) >= 20 else 0
        bb_upper = sma_20 + 2 * std_20
        bb_lower = sma_20 - 2 * std_20

        # SMAs
        sma_50 = sum(closes[-50:]) / 50

        # Volume
        vol_sma_20 = sum(volumes[-20:]) / 20 if len(volumes) >= 20 else 0
        rel_vol = volumes[-1] / vol_sma_20 if vol_sma_20 > 0 else 0

        return TechnicalIndicators(
            rsi_14=round(rsi, 2),
            macd_line=round(macd_line, 4),
            macd_signal=round(macd_signal, 4),
            macd_histogram=round(macd_histogram, 4),
            adx_14=round(adx, 2),
            atr_14=round(atr, 4),
            bollinger_upper=round(bb_upper, 4),
            bollinger_lower=round(bb_lower, 4),
            bollinger_mid=round(sma_20, 4),
            sma_20=round(sma_20, 4),
            sma_50=round(sma_50, 4),
            volume_sma_20=round(vol_sma_20, 0),
            relative_volume=round(rel_vol, 2),
        )

    # ── News ──────────────────────────────────────────────────────────

    # ── Macro Context ─────────────────────────────────────────────────

    async def fetch_macro_context(self) -> MacroContext:
        """Fetch current Canadian macro environment data from FMP /stable/."""
        # Symbols verified against FMP /stable/quote:
        # GCUSD=gold, CADUSD=CAD/USD, ^VIX=VIX, BZUSD=Brent, XIU.TO=TSX proxy
        # CLUSD (WTI) returns 402 on current plan — use USO ETF as proxy
        async def _quote(symbol: str) -> Optional[dict]:
            # Try /quote first, then /stable/quote as fallback for fresher data
            data = await self._fmp_get("/quote", params={"symbol": symbol})
            if data and isinstance(data, list) and data:
                return data[0]
            # Fallback to stable endpoint
            data = await self._fmp_get("/stable/quote", params={"symbol": symbol})
            if data and isinstance(data, list) and data:
                logger.info(f"Used /stable/quote fallback for {symbol}")
                return data[0]
            return None

        results = await asyncio.gather(
            _quote("USO"),      # WTI oil proxy
            _quote("GCUSD"),    # Gold
            _quote("CADUSD"),   # CAD/USD
            _quote("XIU.TO"),   # TSX proxy (iShares S&P/TSX 60)
            _quote("^VIX"),     # VIX
            _quote("BZUSD"),    # Brent crude
            _quote("BTCUSD"),   # Bitcoin
            return_exceptions=True,
        )

        def safe_price(r) -> Optional[float]:
            if isinstance(r, Exception) or r is None:
                return None
            return r.get("price")

        def safe_change(r) -> Optional[float]:
            if isinstance(r, Exception) or r is None:
                return None
            return r.get("changePercentage")

        # Convert gold from USD to CAD
        gold_usd = safe_price(results[1])
        cad_usd = safe_price(results[2])
        gold_cad = round(gold_usd / cad_usd, 2) if gold_usd and cad_usd else gold_usd

        # Convert BTC from USD to CAD
        btc_usd = safe_price(results[6])
        btc_cad = round(btc_usd / cad_usd, 2) if btc_usd and cad_usd else btc_usd

        return MacroContext(
            oil_wti=safe_price(results[0]),      # USO proxy
            gold_price=gold_cad,                 # Gold in CAD
            btc_price=btc_cad,                   # Bitcoin in CAD
            cad_usd=cad_usd,
            tsx_composite=safe_price(results[3]),  # XIU.TO proxy
            tsx_change_pct=safe_change(results[3]),
            vix=safe_price(results[4]),
            oil_brent=safe_price(results[5]),
            as_of=datetime.now(timezone.utc),
        )

    # ── IV Expected Move (ATR-based proxy) ─────────────────────────

    def compute_iv_expected_move(self, ticker: str, atr: float, price: float) -> Optional[IVExpectedMove]:
        """Compute ATR-based IV proxy for expected move sizing."""
        try:
            if not atr or not price or price <= 0:
                return None

            # Annualize ATR: daily ATR / price * sqrt(252)
            daily_vol = atr / price
            annualized_iv = daily_vol * (252 ** 0.5)

            # Expected move formula: S * (IV / sqrt(365)) * sqrt(D)
            # For 3 trading days ~ 5 calendar days
            em_1sd = price * (annualized_iv / (365 ** 0.5)) * (5 ** 0.5)
            em_1sd_pct = (em_1sd / price) * 100
            em_2sd_pct = em_1sd_pct * 2

            return IVExpectedMove(
                implied_volatility=round(annualized_iv, 4),
                expected_move_1sd_pct=round(em_1sd_pct, 2),
                expected_move_2sd_pct=round(em_2sd_pct, 2),
                iv_available=True
            )
        except Exception:
            return None

    # ── Payload Builder ───────────────────────────────────────────────

    async def build_payload(
        self,
        ticker: str,
        quote: dict,
        bars: list[dict],
        macro: Optional[MacroContext] = None,
        profile: Optional[dict] = None,
    ) -> Optional[StockDataPayload]:
        """Build a complete StockDataPayload for a ticker.
        Returns None if data is stale or insufficient."""
        # Freshness check
        if not self._check_quote_freshness(quote):
            logger.warning(f"Stale quote for {ticker} — rejecting")
            return None

        price = quote.get("price", 0)
        if price <= 0:
            logger.warning(f"Invalid price for {ticker}: {price}")
            return None

        volume = int(quote.get("volume", 0))
        # avgVolume lives in profile, not in quote
        profile = profile or await self.fetch_profile(ticker)
        avg_vol = float(profile.get("averageVolume", 0))
        adv_dollars = price * avg_vol

        technicals = self.compute_technicals(bars) if len(bars) >= 50 else None

        # Fetch news + sentiment from EODHD (tracked in endpoint_health for admin dashboard)
        news_data = await eodhd_news.fetch_news(ticker, limit=5, endpoint_health=self.endpoint_health)
        sentiment = eodhd_news.get_sentiment_score(news_data) if news_data else 0.0
        news_items = news_data

        try:
            payload = StockDataPayload(
                ticker=ticker,
                company_name=quote.get("name", "") or profile.get("companyName", ""),
                sector=profile.get("sector", "Unknown") or "Unknown",
                industry=profile.get("industry", "Unknown") or "Unknown",
                price=price,
                change_pct=float(quote.get("changePercentage", 0)),
                volume=volume,
                avg_volume_20d=avg_vol,
                market_cap=quote.get("marketCap") or profile.get("marketCap"),
                adv_dollars=adv_dollars,
                historical_bars=bars[-20:],  # Last 20 bars for LLM context
                technicals=technicals,
                news=news_items,
                news_sentiment=sentiment,
                macro=macro,
                iv_expected_move=(
                    self.compute_iv_expected_move(ticker, technicals.atr_14, price)
                    if technicals and technicals.atr_14 else None
                ),
                as_of=datetime.now(timezone.utc),
            )
            return payload
        except Exception as e:
            logger.error(f"Failed to build payload for {ticker}: {e}")
            return None


# ═══════════════════════════════════════════════════════════════════════════
# ENHANCED SIGNAL FETCHERS
# ═══════════════════════════════════════════════════════════════════════════


async def fetch_earnings_calendar(
    fetcher: "LiveDataFetcher", days_ahead: int = 10
) -> dict[str, EarningsEvent]:
    """Bulk fetch earnings calendar for next N days. Returns {ticker: EarningsEvent}."""
    from_date = date.today().isoformat()
    to_date = (date.today() + timedelta(days=days_ahead)).isoformat()
    data = await fetcher._fmp_get(
        "/earnings-calendar", params={"from": from_date, "to": to_date}
    )
    if not data:
        return {}
    result = {}
    today = date.today()
    for item in data:
        symbol = item.get("symbol", "")
        if not symbol.endswith(".TO") and not symbol.endswith(".V"):
            continue
        try:
            earn_date = date.fromisoformat(item["date"])
            days_until = max((earn_date - today).days, 0)
            result[symbol] = EarningsEvent(
                earnings_date=item["date"],
                eps_estimated=item.get("epsEstimated"),
                revenue_estimated=item.get("revenueEstimated"),
                days_until=days_until,
            )
        except (KeyError, ValueError):
            continue
    logger.info(f"Earnings calendar: {len(result)} TSX tickers with earnings in next {days_ahead} days")
    return result


async def fetch_insider_trades(
    fetcher: "LiveDataFetcher", ticker: str, days_back: int = 30
) -> Optional[InsiderActivity]:
    """Fetch recent insider trades for a ticker and compute aggregated signal.
    Note: FMP /insider-trading endpoint returns 404 as of Mar 2026.
    Skipping API call until FMP restores the endpoint.
    """
    # FMP /insider-trading removed from /stable/ API — skip to avoid 404 spam
    return None


async def fetch_analyst_consensus(
    fetcher: "LiveDataFetcher", ticker: str, current_price: float
) -> Optional[AnalystConsensus]:
    """Fetch analyst grades from FMP /grades.
    Uses raw actions since /grades-summary was removed from FMP stable API.
    Computes buy/hold/sell summary from the most recent grade per analyst firm (last 12 months).
    Note: /price-target-consensus returns empty [] for all .TO tickers, so only /grades is used.
    """
    grades_data = await fetcher._fmp_get("/grades", params={"symbol": ticker})
    # Compute grades summary from raw /grades data
    sb, b, h, s, ss = 0, 0, 0, 0, 0
    if grades_data and isinstance(grades_data, list):
        cutoff = (date.today() - timedelta(days=365)).isoformat()
        # Take most recent grade per analyst firm (deduplicate)
        seen_firms: set[str] = set()
        for entry in grades_data:
            entry_date = str(entry.get("date", ""))[:10]
            if entry_date < cutoff:
                break  # Results are sorted newest-first
            firm = entry.get("gradingCompany", "")
            if firm in seen_firms:
                continue
            seen_firms.add(firm)
            grade = str(entry.get("newGrade", "")).lower()
            if grade in ("strong buy", "strong-buy"):
                sb += 1
            elif grade in ("buy", "outperform", "overweight", "positive"):
                b += 1
            elif grade in ("hold", "neutral", "equal-weight", "market perform", "sector perform", "peer perform"):
                h += 1
            elif grade in ("sell", "underperform", "underweight", "negative"):
                s += 1
            elif grade in ("strong sell", "strong-sell"):
                ss += 1
    total_grades = sb + b + h + s + ss
    sentiment = ((sb * 2 + b * 1 + h * 0 + s * -1 + ss * -2) / max(total_grades, 1)) / 2.0
    if total_grades == 0:
        return None
    return AnalystConsensus(
        strong_buy=sb, buy=b, hold=h, sell=s, strong_sell=ss,
        sentiment_score=round(sentiment, 4),
        target_upside_pct=None,
    )


async def fetch_institutional_ownership(
    fetcher: "LiveDataFetcher", ticker: str
) -> Optional[float]:
    """
    Fetch institutional ownership percentage for a ticker from FMP.
    Returns the fraction of shares held by institutions (0.0-1.0), or None.
    Non-blocking: returns None on any error rather than raising.

    Uses the /api/v4/institutional-ownership/symbol-ownership endpoint, which is
    NOT available via fetcher._fmp_get() (that method is hardcoded to FMP_BASE
    which points at /stable/). This function makes a direct call using the
    fetcher's shared session and API key.
    """
    try:
        session = await fetcher._get_session()
        url = "https://financialmodelingprep.com/api/v4/institutional-ownership/symbol-ownership"
        params = {
            "symbol": ticker,
            "includeCurrentQuarter": "false",
            "apikey": fetcher.fmp_key,
        }
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            if not data or not isinstance(data, list) or len(data) == 0:
                return None
            latest = data[0]
            pct = latest.get("ownershipPercent")
            if pct is None:
                return None
            # FMP returns as a percentage (e.g. 45.7 for 45.7%); normalize to [0,1]
            return min(max(float(pct) / 100.0, 0.0), 1.0)
    except Exception:
        return None


async def fetch_enhanced_signals_batch(
    fetcher: "LiveDataFetcher",
    tickers: list[str],
    quotes: dict[str, dict],
) -> tuple[dict[str, InsiderActivity], dict[str, AnalystConsensus], dict[str, float]]:
    """Fetch analyst data for tickers, rate-limited. (Insider trades disabled — FMP endpoint removed.)"""
    insider_map: dict[str, InsiderActivity] = {}
    analyst_map: dict[str, AnalystConsensus] = {}
    institutional_map: dict[str, float] = {}
    sem = asyncio.Semaphore(2)  # 2 concurrent to avoid FMP 429s on /grades

    async def _fetch_one(ticker: str):
        async with sem:
            price = quotes.get(ticker, {}).get("price", 0)
            try:
                analyst = await fetch_analyst_consensus(fetcher, ticker, price)
                if analyst:
                    analyst_map[ticker] = analyst
            except Exception as e:
                logger.debug(f"Analyst fetch failed for {ticker}: {e}")
            try:
                institutional = await fetch_institutional_ownership(fetcher, ticker)
                if institutional is not None:
                    institutional_map[ticker] = institutional
            except Exception as e:
                logger.debug(f"Institutional ownership fetch failed for {ticker}: {e}")
            await asyncio.sleep(0.15)

    for i in range(0, len(tickers), 20):
        batch = tickers[i:i + 20]
        await asyncio.gather(*[_fetch_one(t) for t in batch])
        if i + 20 < len(tickers):
            await asyncio.sleep(3)
            logger.info(f"Enhanced signals: {min(i + 20, len(tickers))}/{len(tickers)} fetched")

    logger.info(f"Enhanced signals: {len(insider_map)} insider, {len(analyst_map)} analyst, {len(institutional_map)} institutional records")
    return insider_map, analyst_map, institutional_map


def compute_sector_relative_strength(
    payloads: list[StockDataPayload],
) -> dict[str, float]:
    """Compute per-ticker sector-relative strength from existing data. No API calls."""
    sector_changes: dict[str, list[float]] = {}
    for p in payloads:
        sector_changes.setdefault(p.sector, []).append(p.change_pct)
    sector_avg = {s: statistics.mean(changes) for s, changes in sector_changes.items() if changes}
    result = {}
    for p in payloads:
        avg = sector_avg.get(p.sector, 0.0)
        result[p.ticker] = round(p.change_pct - avg, 4)
    return result


# ═══════════════════════════════════════════════════════════════════════════
# MACRO REGIME FILTER
# ═══════════════════════════════════════════════════════════════════════════

# Regime definitions
REGIME_RISK_ON = "RISK_ON"
REGIME_RISK_OFF = "RISK_OFF"
REGIME_COMMODITY_BOOM = "COMMODITY_BOOM"
REGIME_COMMODITY_BUST = "COMMODITY_BUST"
REGIME_NEUTRAL = "NEUTRAL"

# Sector sensitivity to regimes
SECTOR_REGIME_ADJUSTMENTS: dict[str, dict[str, float]] = {
    "Energy": {
        REGIME_COMMODITY_BOOM: 1.15,
        REGIME_COMMODITY_BUST: 0.80,
        REGIME_RISK_ON: 1.05,
        REGIME_RISK_OFF: 0.90,
    },
    "Basic Materials": {
        REGIME_COMMODITY_BOOM: 1.12,
        REGIME_COMMODITY_BUST: 0.85,
        REGIME_RISK_ON: 1.05,
        REGIME_RISK_OFF: 0.90,
    },
    "Financial Services": {
        REGIME_RISK_ON: 1.10,
        REGIME_RISK_OFF: 0.85,
        REGIME_COMMODITY_BOOM: 1.0,
    },
    "Technology": {
        REGIME_RISK_ON: 1.10,
        REGIME_RISK_OFF: 0.88,
    },
    "Healthcare": {
        REGIME_RISK_OFF: 1.08,
        REGIME_RISK_ON: 0.95,
    },
    "Utilities": {
        REGIME_RISK_OFF: 1.10,
        REGIME_RISK_ON: 0.92,
    },
    "Consumer Defensive": {
        REGIME_RISK_OFF: 1.08,
        REGIME_RISK_ON: 0.95,
    },
    "Real Estate": {
        REGIME_RISK_ON: 1.05,
        REGIME_RISK_OFF: 0.90,
    },
}


class MacroRegimeFilter:
    """Detects Canadian macro regime from live data and adjusts scores by sector."""

    def detect_regime(self, macro: MacroContext) -> str:
        """Determine current macro regime from commodity/FX/index data."""
        signals: dict[str, int] = {
            REGIME_RISK_ON: 0,
            REGIME_RISK_OFF: 0,
            REGIME_COMMODITY_BOOM: 0,
            REGIME_COMMODITY_BUST: 0,
        }

        # Oil signal (USO ETF proxy — ~$120 in March 2026)
        # Thresholds calibrated for USO, not raw WTI
        if macro.oil_wti is not None:
            if macro.oil_wti > 130:
                signals[REGIME_COMMODITY_BOOM] += 2
            elif macro.oil_wti < 100:
                signals[REGIME_COMMODITY_BUST] += 2
            elif macro.oil_wti > 120:
                signals[REGIME_COMMODITY_BOOM] += 1
            elif macro.oil_wti < 110:
                signals[REGIME_COMMODITY_BUST] += 1

        # Gold signal (risk-off indicator)
        # Gold in CAD — ~$6400 CAD in March 2026
        if macro.gold_price is not None:
            if macro.gold_price > 6600:
                signals[REGIME_RISK_OFF] += 1
            elif macro.gold_price < 5500:
                signals[REGIME_RISK_ON] += 1

        # CAD strength (strong CAD = commodity tailwind)
        if macro.cad_usd is not None:
            if macro.cad_usd > 0.76:
                signals[REGIME_COMMODITY_BOOM] += 1
                signals[REGIME_RISK_ON] += 1
            elif macro.cad_usd < 0.70:
                signals[REGIME_COMMODITY_BUST] += 1
                signals[REGIME_RISK_OFF] += 1

        # TSX momentum
        if macro.tsx_change_pct is not None:
            if macro.tsx_change_pct > 0.5:
                signals[REGIME_RISK_ON] += 1
            elif macro.tsx_change_pct < -0.5:
                signals[REGIME_RISK_OFF] += 1

        # VIX
        if macro.vix is not None:
            if macro.vix > 25:
                signals[REGIME_RISK_OFF] += 2
            elif macro.vix < 15:
                signals[REGIME_RISK_ON] += 2
            elif macro.vix > 20:
                signals[REGIME_RISK_OFF] += 1

        # Find dominant signal
        max_signal = max(signals.values())
        if max_signal < 2:
            return REGIME_NEUTRAL

        # Pick the regime with highest signal count
        regime = max(signals, key=signals.get)
        return regime

    def adjust_score(self, score: float, sector: str, regime: str) -> float:
        """Apply regime-based adjustment to a ticker's score."""
        adjustments = SECTOR_REGIME_ADJUSTMENTS.get(sector, {})
        multiplier = adjustments.get(regime, 1.0)
        adjusted = score * multiplier
        return round(min(100.0, max(0.0, adjusted)), 2)

    def apply_regime(self, macro: MacroContext) -> MacroContext:
        """Detect regime and update the MacroContext object."""
        regime = self.detect_regime(macro)
        macro.regime = regime
        logger.info(f"Detected macro regime: {regime}")
        return macro


# ═══════════════════════════════════════════════════════════════════════════
# LLM HELPERS + STAGE CALLERS (Session 2)
# ═══════════════════════════════════════════════════════════════════════════

# ── JSON Extraction ──────────────────────────────────────────────────

def _extract_json(text: str) -> Any:
    """Extract JSON from an LLM response that may contain markdown fences or preamble.
    Tries multiple strategies: direct parse, fence extraction, brace extraction."""
    if not text:
        return None
    text = text.strip()

    # Strategy 1: Direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy 2: Extract from markdown code fence ```json ... ```
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Strategy 3: Find outermost { ... } or [ ... ]
    for open_ch, close_ch in [('{', '}'), ('[', ']')]:
        start = text.find(open_ch)
        if start == -1:
            continue
        depth = 0
        for i in range(start, len(text)):
            if text[i] == open_ch:
                depth += 1
            elif text[i] == close_ch:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        break

    logger.error(f"Failed to extract JSON from LLM response (first 300 chars): {text[:300]}")
    return None


def _slim_payload(d: dict) -> dict:
    """Strip token-heavy fields from a payload dict before sending to LLMs.
    Removes: macro (already in prompt header), news URLs (waste tokens),
    trims news to 5 most recent.
    """
    d.pop("macro", None)
    if "news" in d:
        d["news"] = d["news"][:5]  # Only 5 most recent articles
    for item in d.get("news", []):
        if isinstance(item, dict):
            item.pop("content", None)
            item.pop("link", None)
    return d


_COMPACT = {"separators": (",", ":"), "default": str}


def _prepare_stage_payloads(
    payloads: list["StockDataPayload"],
    passed_tickers: set[str] | None = None,
) -> list[dict]:
    """Build slimmed payload dicts for an LLM stage, optionally filtering by ticker set."""
    result = []
    for p in payloads:
        if passed_tickers is not None and p.ticker not in passed_tickers:
            continue
        d = p.model_dump(mode="json")
        d["historical_bars"] = d["historical_bars"][-5:]
        _slim_payload(d)
        result.append(d)
    return result


def _validate_stage_results(
    raw_text: str,
    stage_label: str,
    stage_tokens: dict,
    extra_validate: callable = None,
) -> tuple[list[dict], dict]:
    """Parse LLM response, validate ScoreBreakdown, sort by total score.
    extra_validate is called on each result dict for stage-specific validation."""
    parsed = _extract_json(raw_text)
    if not parsed or "results" not in parsed:
        logger.error(f"{stage_label}: Failed to parse response")
        return [], stage_tokens

    SCORE_BOUNDS = {"technical_momentum": 30, "sentiment_catalysts": 25,
                    "options_volatility": 20, "risk_reward": 15, "conviction": 10}
    validated = []
    for r in parsed["results"]:
        try:
            # Clamp component scores to rubric maximums before validation
            raw_score = r.get("score", {})
            for k, mx in SCORE_BOUNDS.items():
                if k in raw_score:
                    raw_score[k] = min(float(raw_score[k]), mx)
            raw_score["total"] = sum(raw_score.get(k, 0) for k in SCORE_BOUNDS)
            score = ScoreBreakdown(**raw_score)
            r["score"] = score.model_dump()
            if extra_validate:
                extra_validate(r)
            validated.append(r)
        except Exception as e:
            logger.warning(f"{stage_label}: Invalid score for {r.get('ticker','?')}: {e}")

    return sorted(validated, key=lambda x: x["score"]["total"], reverse=True), stage_tokens


# ── LLM API Callers ──────────────────────────────────────────────────

async def _call_anthropic(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 8192,
    temperature: float = 0.3,
) -> tuple[str, dict]:
    """Call Anthropic Claude API using streaming with retry on rate limits.
    Returns (text, {"input_tokens": N, "output_tokens": N})."""
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    for attempt in range(4):
        try:
            chunks = []
            with client.messages.stream(
                model=model,
                max_tokens=max_tokens,
                temperature=temperature,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            ) as stream:
                for text in stream.text_stream:
                    chunks.append(text)
                # Capture usage from the final message before stream context exits
                final_message = stream.get_final_message()
                usage = {
                    "input_tokens": getattr(final_message.usage, "input_tokens", 0),
                    "output_tokens": getattr(final_message.usage, "output_tokens", 0),
                }
            return "".join(chunks), usage
        except anthropic.RateLimitError as e:
            wait = 60 * (attempt + 1)
            logger.warning(f"Anthropic {model} rate limited, waiting {wait}s (attempt {attempt + 1}/4)")
            await asyncio.sleep(wait)
        except Exception as e:
            logger.error(f"Anthropic {model} call failed: {e}")
            raise
    raise RuntimeError(f"Anthropic {model} rate limited after 4 retries")


_TRANSIENT_STATUS_CODES = {429, 500, 502, 503}


def _is_transient(exc: Exception) -> bool:
    """Check if an exception represents a transient/retryable API error."""
    exc_str = str(exc).lower()
    for code in _TRANSIENT_STATUS_CODES:
        if str(code) in exc_str:
            return True
    if any(kw in exc_str for kw in ("rate limit", "overloaded", "service unavailable", "internal server error", "bad gateway")):
        return True
    return False


async def _call_gemini(
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 8192,
    temperature: float = 0.3,
) -> tuple[str, dict]:
    """Call Google Gemini via Vertex AI with retry on transient failures.
    Returns (text, {"input_tokens": N, "output_tokens": N})."""
    from google import genai
    from google.genai import types

    gcp_project = os.getenv("GCP_PROJECT_ID", "gen-lang-client-0879620722")
    gcp_location = os.getenv("GCP_LOCATION", "global")
    client = genai.Client(vertexai=True, project=gcp_project, location=gcp_location)

    max_retries = 4
    for attempt in range(max_retries):
        try:
            resp = client.models.generate_content(
                model=model,
                contents=user_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    max_output_tokens=max_tokens,
                    temperature=temperature,
                    response_mime_type="application/json",
                    thinking_config=types.ThinkingConfig(
                        thinking_level=types.ThinkingLevel.LOW,
                    ),
                ),
            )
            usage = {"input_tokens": 0, "output_tokens": 0}
            if hasattr(resp, "usage_metadata") and resp.usage_metadata:
                usage["input_tokens"] = getattr(resp.usage_metadata, "prompt_token_count", 0) or 0
                usage["output_tokens"] = getattr(resp.usage_metadata, "candidates_token_count", 0) or 0
            return resp.text, usage
        except Exception as e:
            if _is_transient(e) and attempt < max_retries - 1:
                wait = min(30 * (2 ** attempt), 300)
                logger.warning(f"Gemini {model} transient error, retrying in {wait}s (attempt {attempt + 1}/{max_retries}): {e}")
                await asyncio.sleep(wait)
            else:
                logger.error(f"Gemini {model} call failed: {e}")
                raise


async def _call_grok(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 8192,
    temperature: float = 0.3,
) -> tuple[str, dict]:
    """Call xAI Grok API (OpenAI-compatible) with retry on transient failures.
    Returns (text, {"input_tokens": N, "output_tokens": N})."""
    from openai import OpenAI
    client = OpenAI(api_key=api_key, base_url="https://api.x.ai/v1")
    max_retries = 4
    for attempt in range(max_retries):
        try:
            resp = client.chat.completions.create(
                model=model,
                max_tokens=max_tokens,
                temperature=temperature,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )
            usage = {"input_tokens": 0, "output_tokens": 0}
            if resp.usage:
                usage["input_tokens"] = getattr(resp.usage, "prompt_tokens", 0) or 0
                usage["output_tokens"] = getattr(resp.usage, "completion_tokens", 0) or 0
            return resp.choices[0].message.content, usage
        except Exception as e:
            if _is_transient(e) and attempt < max_retries - 1:
                wait = min(30 * (2 ** attempt), 300)
                logger.warning(f"Grok {model} transient error, retrying in {wait}s (attempt {attempt + 1}/{max_retries}): {e}")
                await asyncio.sleep(wait)
            else:
                logger.error(f"Grok {model} call failed: {e}")
                raise


async def _call_grok_multi_agent(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 16384,
    temperature: float = 0.3,
    reasoning_effort: str = "high",
) -> tuple[str, dict]:
    """Call xAI Grok Multi-Agent via Responses API (/v1/responses).
    The multi-agent model does NOT work with the OpenAI Chat Completions API."""
    url = "https://api.x.ai/v1/responses"
    payload = {
        "model": model,
        "reasoning": {"effort": reasoning_effort},
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
        "max_output_tokens": max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    max_retries = 4
    for attempt in range(max_retries):
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload, headers=headers,
                                        timeout=aiohttp.ClientTimeout(total=300)) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        raise Exception(f"Grok multi-agent {resp.status}: {body[:300]}")
                    data = await resp.json()
                    text = ""
                    usage = {"input_tokens": 0, "output_tokens": 0}
                    if "output" in data:
                        for item in data["output"]:
                            if item.get("type") == "message":
                                for content in item.get("content", []):
                                    if content.get("type") == "output_text":
                                        text += content.get("text", "")
                    if "usage" in data:
                        usage["input_tokens"] = data["usage"].get("input_tokens", 0)
                        usage["output_tokens"] = data["usage"].get("output_tokens", 0)
                    return text, usage
        except Exception as e:
            if _is_transient(e) and attempt < max_retries - 1:
                wait = min(30 * (2 ** attempt), 300)
                logger.warning(f"Grok multi-agent transient error, retrying in {wait}s (attempt {attempt + 1}/{max_retries}): {e}")
                await asyncio.sleep(wait)
            else:
                logger.error(f"Grok multi-agent call failed: {e}")
                raise


# ── Grounding + Chain-of-Verification Mandate ────────────────────────

GROUNDING_MANDATE = """
GROUNDING RULES (MANDATORY):
- You MUST base ALL analysis exclusively on the provided data payload.
- Do NOT hallucinate, fabricate, or infer data not present in the payload.
- Every numerical claim (price, volume, RSI, etc.) MUST be verifiable against the payload.
- If data is missing or insufficient for a category, score it conservatively and note "INSUFFICIENT_DATA".

CHAIN-OF-VERIFICATION (CoV) MANDATE:
After producing your analysis, you MUST perform a self-verification step:
1. Re-check each score component against the raw data provided.
2. Confirm all prices, volumes, and technical values match the payload.
3. Flag any discrepancies in your verification_notes field.
4. If you catch an error, correct it before finalizing.
"""

DIRECTIONAL_MANDATE = """
DIRECTIONAL MANDATE (CRITICAL):
You are scoring stocks for SHORT-TERM UPSIDE potential — likelihood of PRICE INCREASE over 3-8 trading days.
- High scores = strong likelihood of price INCREASE. Bullish setups only.
- Low scores = weak upside, likely decline, or excessive risk of pullback.
- A stock with strong BEARISH momentum (falling price, bearish MACD crossover, breaking support) should score LOW.
- Overbought stocks (RSI > 75) should score LOW unless there is a specific catalyst for continued upside.
- Mean-reversion candidates from oversold levels with bullish signals should score HIGH.
Do NOT confuse "interesting technically" with "good to buy". We want BUYERS' opportunities.
"""

RUBRIC_TEXT = """
100-POINT SCORING RUBRIC (apply to EACH ticker — score for UPSIDE potential):
- Technical Momentum & Confluence (0-30 pts): Score HIGH for BULLISH signals (RSI rising from oversold, bullish MACD crossover, price above rising SMA, breakout above resistance). Score LOW for bearish signals (overbought RSI>75, bearish crossover, price below falling SMA, breakdown below support). Strong upward trend with volume confirmation = highest scores.
- Sentiment & Catalysts (0-25 pts): Recent positive news sentiment, upcoming bullish catalysts, positive earnings surprise, analyst upgrades. Negative sentiment or bearish catalysts = low scores. Insider buying clusters are strongly bullish. Analyst consensus alignment increases conviction. If earnings_event is present (earnings within prediction window), score conservatively — this is a binary risk event. Sector-relative strength (sector_relative_strength field, positive = outperforming peers) distinguishes true momentum from sector tailwinds.
- Options IV / Volatility Edge (0-20 pts): ATR relative to price showing expanding upside moves, volatility regime supporting upside. Use ATR as proxy if options data is thin.
- Risk/Reward Clarity + Edge Decay (0-15 pts): Asymmetric UPSIDE potential vs downside risk. Clear support level for stop loss, wide upside target. High risk:reward ratio favoring the long side.
- Overall Short-Term UPSIDE Conviction (0-10 pts): How confident are you this stock RISES in 3-8 days? Factor in all evidence. Zero if you expect decline.

Total MUST equal the sum of all 5 components. Scores MUST be honest — do not inflate.
"""


# ── Stage 1: Sonnet Screener ─────────────────────────────────────────

SONNET_SYSTEM_PROMPT = f"""You are an elite Canadian equity screener for short-term momentum trades (3-8 day horizon).
You are Stage 1 of a 4-stage LLM Council analyzing TSX/TSXV stocks.

YOUR TASK: Score each ticker on a 100-point rubric and select the Top 100 highest-scoring tickers.

{GROUNDING_MANDATE}

{DIRECTIONAL_MANDATE}

{RUBRIC_TEXT}

OUTPUT FORMAT (strict JSON, no markdown, no commentary outside JSON):
{{
  "stage": 1,
  "model": "claude-sonnet-4.6",
  "tickers_received": <int>,
  "tickers_passed": <int>,
  "results": [
    {{
      "ticker": "RY.TO",
      "score": {{
        "technical_momentum": <0-30>,
        "sentiment_catalysts": <0-25>,
        "options_volatility": <0-20>,
        "risk_reward": <0-15>,
        "conviction": <0-10>,
        "total": <0-100>
      }},
      "reasoning": "<2-3 sentence summary>",
      "verification_notes": "<CoV self-check results>"
    }}
  ]
}}

Sort results by total score descending. Return the top 100 (or all if fewer than 100).
"""


async def run_stage1_sonnet(
    api_key: str,
    payloads: list[StockDataPayload],
    macro: MacroContext,
    learning_engine: Optional["LearningEngine"] = None,
) -> list[dict]:
    """Stage 1: Sonnet screens universe to Top 100."""
    logger.info(f"Stage 1 (Sonnet): Processing {len(payloads)} tickers")
    start = time.time()
    stage_tokens = {"model": "claude-sonnet-4-6", "input_tokens": 0, "output_tokens": 0}

    payload_dicts = _prepare_stage_payloads(payloads)

    user_prompt = (
        f"MACRO CONTEXT:\n{json.dumps(macro.model_dump(mode='json'), **_COMPACT)}\n\n"
        f"TICKERS TO SCREEN ({len(payload_dicts)} total):\n"
        f"{json.dumps(payload_dicts, **_COMPACT)}"
    )

    # LE BYPASS (2026-04-08): build_prompt_context has the same JOIN defect
    # as compute_stage_weights — returns stage-identical "your accuracy is X%"
    # text derived from pick-level accuracy instead of per-stage accuracy.
    # Bypassed. See docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md
    prompt_context = ""
    system_prompt = SONNET_SYSTEM_PROMPT + prompt_context

    raw, _usage = await _call_anthropic(
        api_key=api_key,
        model="claude-sonnet-4-6",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        max_tokens=16384,
    )
    stage_tokens["input_tokens"] += _usage.get("input_tokens", 0)
    stage_tokens["output_tokens"] += _usage.get("output_tokens", 0)

    validated, stage_tokens = _validate_stage_results(raw, "Stage 1 Sonnet", stage_tokens)
    elapsed = time.time() - start
    logger.info(f"Stage 1 (Sonnet): {len(validated)} tickers passed in {elapsed:.1f}s")
    return validated, stage_tokens


# ── Stage 2: Gemini Re-scorer ────────────────────────────────────────

GEMINI_SYSTEM_PROMPT = f"""You are an independent Canadian equity re-scorer for short-term momentum trades (3-8 day horizon).
You are Stage 2 of a 4-stage LLM Council. You receive Stage 1's scores AND the raw data.

YOUR TASK: Independently re-score each ticker. Where you disagree with Stage 1, explain why.

CRITICAL: You are an INDEPENDENT analyst. Do NOT simply copy Stage 1's scores. Re-derive each score from the raw data.
If you agree with Stage 1, that's fine — but your reasoning must show independent analysis.

{GROUNDING_MANDATE}

{DIRECTIONAL_MANDATE}

{RUBRIC_TEXT}

OUTPUT FORMAT (strict JSON):
{{
  "stage": 2,
  "model": "gemini-3.1-pro",
  "tickers_received": <int>,
  "tickers_passed": <int>,
  "results": [
    {{
      "ticker": "RY.TO",
      "score": {{
        "technical_momentum": <0-30>,
        "sentiment_catalysts": <0-25>,
        "options_volatility": <0-20>,
        "risk_reward": <0-15>,
        "conviction": <0-10>,
        "total": <0-100>
      }},
      "reasoning": "<2-3 sentence summary>",
      "verification_notes": "<CoV self-check>",
      "disagreement_reason": "<where/why you differ from Stage 1, or null if you agree>"
    }}
  ]
}}

Sort by total score descending. Return the top 80 (or all if fewer than 80).
"""


async def run_stage2_gemini(
    payloads: list[StockDataPayload],
    macro: MacroContext,
    stage1_results: list[dict],
    learning_engine: Optional["LearningEngine"] = None,
) -> list[dict]:
    """Stage 2: Gemini independently re-scores, narrows to Top 80."""
    logger.info(f"Stage 2 (Gemini): Processing {len(stage1_results)} tickers from Stage 1")
    start = time.time()
    stage_tokens = {"model": os.getenv("GEMINI_MODEL", "gemini-3.1-pro-preview"), "input_tokens": 0, "output_tokens": 0}

    passed_tickers = {r["ticker"] for r in stage1_results}
    payload_dicts = _prepare_stage_payloads(payloads, passed_tickers)

    # LE BYPASS (2026-04-08): see Stage 1 call site for rationale.
    prompt_context = ""
    system_prompt = GEMINI_SYSTEM_PROMPT + prompt_context

    user_prompt = (
        f"MACRO CONTEXT:\n{json.dumps(macro.model_dump(mode='json'), **_COMPACT)}\n\n"
        f"STAGE 1 (SONNET) RESULTS:\n{json.dumps(stage1_results, **_COMPACT)}\n\n"
        f"RAW DATA ({len(payload_dicts)} tickers):\n"
        f"{json.dumps(payload_dicts, **_COMPACT)}"
    )

    raw, _usage = await _call_gemini(
        model=os.getenv("GEMINI_MODEL", "gemini-3.1-pro-preview"),
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        max_tokens=32768,
    )
    stage_tokens["input_tokens"] += _usage.get("input_tokens", 0)
    stage_tokens["output_tokens"] += _usage.get("output_tokens", 0)

    validated, stage_tokens = _validate_stage_results(raw, "Stage 2 Gemini", stage_tokens)
    elapsed = time.time() - start
    logger.info(f"Stage 2 (Gemini): {len(validated)} tickers passed in {elapsed:.1f}s")
    return validated, stage_tokens


# ── Stage 3: Opus Challenger ─────────────────────────────────────────

OPUS_SYSTEM_PROMPT = f"""You are a senior risk analyst and devil's advocate for short-term Canadian equity trades.
You are Stage 3 of a 4-stage LLM Council. You receive Stages 1+2 scores AND raw data.

YOUR TASK: Challenge every pick. For each ticker:
1. Re-score independently using the rubric.
2. Identify the KILL CONDITION — the specific event/level that would invalidate the trade thesis.
3. Define the WORST CASE SCENARIO — what happens if everything goes wrong in the next 8 days.
4. Be skeptical. If a pick doesn't survive your scrutiny, score it low.

{GROUNDING_MANDATE}

{DIRECTIONAL_MANDATE}

{RUBRIC_TEXT}

OUTPUT FORMAT (strict JSON):
{{
  "stage": 3,
  "model": "claude-opus-4.6",
  "tickers_received": <int>,
  "tickers_passed": <int>,
  "results": [
    {{
      "ticker": "RY.TO",
      "score": {{
        "technical_momentum": <0-30>,
        "sentiment_catalysts": <0-25>,
        "options_volatility": <0-20>,
        "risk_reward": <0-15>,
        "conviction": <0-10>,
        "total": <0-100>
      }},
      "reasoning": "<2-3 sentence risk-focused analysis>",
      "verification_notes": "<CoV self-check>",
      "kill_condition": "<specific price level, event, or condition that kills this trade>",
      "worst_case_scenario": "<what happens if everything goes wrong in 8 days>"
    }}
  ]
}}

Sort by total score descending. Return the top 40 (or all if fewer than 40).
Be HARSH. This stage exists to eliminate weak picks.
"""


async def run_stage3_opus(
    api_key: str,
    payloads: list[StockDataPayload],
    macro: MacroContext,
    stage1_results: list[dict],
    stage2_results: list[dict],
    learning_engine: Optional["LearningEngine"] = None,
) -> list[dict]:
    """Stage 3: Opus challenges picks, narrows to Top 40."""
    logger.info(f"Stage 3 (Opus): Processing {len(stage2_results)} tickers from Stage 2")
    start = time.time()
    stage_tokens = {"model": "claude-opus-4-6", "input_tokens": 0, "output_tokens": 0}

    passed_tickers = {r["ticker"] for r in stage2_results}
    payload_dicts = _prepare_stage_payloads(payloads, passed_tickers)

    # LE BYPASS (2026-04-08): see Stage 1 call site for rationale.
    prompt_context = ""
    system_prompt = OPUS_SYSTEM_PROMPT + prompt_context

    user_prompt = (
        f"MACRO CONTEXT:\n{json.dumps(macro.model_dump(mode='json'), **_COMPACT)}\n\n"
        f"STAGE 1 (SONNET) RESULTS:\n{json.dumps(stage1_results, **_COMPACT)}\n\n"
        f"STAGE 2 (GEMINI) RESULTS:\n{json.dumps(stage2_results, **_COMPACT)}\n\n"
        f"RAW DATA ({len(payload_dicts)} tickers):\n"
        f"{json.dumps(payload_dicts, **_COMPACT)}"
    )

    raw, _usage = await _call_anthropic(
        api_key=api_key,
        model="claude-opus-4-6",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        max_tokens=16384,
    )
    stage_tokens["input_tokens"] += _usage.get("input_tokens", 0)
    stage_tokens["output_tokens"] += _usage.get("output_tokens", 0)

    def _opus_extra(r):
        if not r.get("kill_condition"):
            r["kill_condition"] = "Not specified"
        if not r.get("worst_case_scenario"):
            r["worst_case_scenario"] = "Not specified"

    validated, stage_tokens = _validate_stage_results(raw, "Stage 3 Opus", stage_tokens, _opus_extra)
    elapsed = time.time() - start
    logger.info(f"Stage 3 (Opus): {len(validated)} tickers passed in {elapsed:.1f}s")
    return validated, stage_tokens


# ── Stage 4: Grok Final Authority ────────────────────────────────────

GROK_SYSTEM_PROMPT = f"""You are the final quantitative synthesizer for a Canadian equity momentum council.
You are Stage 4 (Final Authority) of a 4-stage LLM Council. You receive all 3 prior stages AND raw data.

YOUR TASK: Produce the FINAL Top 10 picks with explicit probabilistic forecasts.
Select ONLY the 10 highest-conviction picks — reject borderline or uncertain setups.
For EACH of the Top 10, provide forecasts at 3 horizons: 3-day, 5-day, 8-day.

Each forecast MUST include:
- direction_probability: float 0-1 (probability the predicted direction is correct)
- predicted_direction: "UP" or "DOWN"
- most_likely_move_pct: the single most probable % move
- price_range_low: lower bound of 68% confidence interval (1 standard deviation)
- price_range_high: upper bound of 68% confidence interval
- clarity_decay_note: observation about forecast reliability using √time decay principle
  (e.g., "3-day forecast: ~1.73x base uncertainty; 8-day: ~2.83x base uncertainty")

{GROUNDING_MANDATE}

{DIRECTIONAL_MANDATE}

{RUBRIC_TEXT}

IMPORTANT: Use the current price from the data payload as your base for calculating price ranges.
Apply √time scaling: if 1-day uncertainty is σ, then N-day uncertainty ≈ σ × √N.

OUTPUT FORMAT (strict JSON):
{{
  "stage": 4,
  "model": "grok-3",
  "tickers_received": <int>,
  "tickers_passed": <int>,
  "results": [
    {{
      "ticker": "RY.TO",
      "score": {{
        "technical_momentum": <0-30>,
        "sentiment_catalysts": <0-25>,
        "options_volatility": <0-20>,
        "risk_reward": <0-15>,
        "conviction": <0-10>,
        "total": <0-100>
      }},
      "reasoning": "<2-3 sentence final synthesis>",
      "verification_notes": "<CoV self-check>",
      "forecasts": [
        {{
          "horizon_days": 3,
          "direction_probability": <0-1>,
          "predicted_direction": "UP",
          "most_likely_move_pct": <float>,
          "price_range_low": <float>,
          "price_range_high": <float>,
          "clarity_decay_note": "<√time observation>"
        }},
        {{
          "horizon_days": 5,
          "direction_probability": <0-1>,
          "predicted_direction": "UP",
          "most_likely_move_pct": <float>,
          "price_range_low": <float>,
          "price_range_high": <float>,
          "clarity_decay_note": "<√time observation>"
        }},
        {{
          "horizon_days": 8,
          "direction_probability": <0-1>,
          "predicted_direction": "UP",
          "most_likely_move_pct": <float>,
          "price_range_low": <float>,
          "price_range_high": <float>,
          "clarity_decay_note": "<√time observation>"
        }}
      ]
    }}
  ]
}}

Sort by total score descending. Return EXACTLY the top 10 (or all if fewer).
Only include picks where you have genuine directional conviction — drop uncertain setups.
This is the FINAL verdict — be decisive and quantitative.
"""


async def run_stage4_grok(
    xai_api_key: str,
    anthropic_api_key: str,
    payloads: list[StockDataPayload],
    macro: MacroContext,
    stage1_results: list[dict],
    stage2_results: list[dict],
    stage3_results: list[dict],
    learning_engine: Optional["LearningEngine"] = None,
) -> list[dict]:
    """Stage 4: SuperGrok Heavy Multi-Agent (or Opus fallback) produces final Top 10 with probabilistic forecasts."""
    logger.info(f"Stage 4 (SuperGrok Heavy): Processing {len(stage3_results)} tickers from Stage 3")
    start = time.time()
    stage_tokens = {"model": "grok-4.20-multi-agent-0309", "input_tokens": 0, "output_tokens": 0}

    passed_tickers = {r["ticker"] for r in stage3_results}
    payload_dicts = _prepare_stage_payloads(payloads, passed_tickers)

    # LE BYPASS (2026-04-08): see Stage 1 call site for rationale.
    prompt_context = ""
    system_prompt = GROK_SYSTEM_PROMPT + prompt_context

    user_prompt = (
        f"MACRO CONTEXT:\n{json.dumps(macro.model_dump(mode='json'), **_COMPACT)}\n\n"
        f"STAGE 1 (SONNET) SCORES:\n{json.dumps(stage1_results[:40], **_COMPACT)}\n\n"
        f"STAGE 2 (GEMINI) SCORES:\n{json.dumps(stage2_results[:40], **_COMPACT)}\n\n"
        f"STAGE 3 (OPUS) SCORES + RISK ANALYSIS:\n{json.dumps(stage3_results, **_COMPACT)}\n\n"
        f"RAW DATA ({len(payload_dicts)} tickers):\n"
        f"{json.dumps(payload_dicts, **_COMPACT)}"
    )

    # Try SuperGrok Heavy Multi-Agent first, fall back to Opus if xAI key is missing or call fails
    use_grok = bool(xai_api_key)
    if use_grok:
        try:
            raw, _usage = await _call_grok_multi_agent(
                api_key=xai_api_key,
                model="grok-4.20-multi-agent-0309",
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                max_tokens=16384,
                reasoning_effort="high",
            )
            stage_tokens["input_tokens"] += _usage.get("input_tokens", 0)
            stage_tokens["output_tokens"] += _usage.get("output_tokens", 0)
        except Exception as e:
            logger.warning(f"SuperGrok Heavy failed, falling back to Opus for Stage 4: {e}")
            use_grok = False

    if not use_grok:
        logger.info("Stage 4: Using Opus as fallback for SuperGrok Heavy")
        raw, _usage = await _call_anthropic(
            api_key=anthropic_api_key,
            model="claude-opus-4-6",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=16384,
        )
        stage_tokens["model"] = "claude-opus-4-6"
        stage_tokens["input_tokens"] += _usage.get("input_tokens", 0)
        stage_tokens["output_tokens"] += _usage.get("output_tokens", 0)

    def _grok_extra(r):
        valid_forecasts = []
        for f in r.get("forecasts", []):
            try:
                pf = ProbabilisticForecast(**f)
                valid_forecasts.append(pf.model_dump())
            except Exception as fe:
                logger.warning(f"Stage 4: Invalid forecast for {r.get('ticker','?')}: {fe}")
        r["forecasts"] = valid_forecasts

    validated, stage_tokens = _validate_stage_results(raw, "Stage 4", stage_tokens, _grok_extra)
    elapsed = time.time() - start
    model_used = "grok-4.20-multi-agent" if use_grok else "claude-opus-4.6 (fallback)"
    logger.info(f"Stage 4 ({model_used}): {len(validated)} tickers passed in {elapsed:.1f}s")
    return validated, stage_tokens


# ═══════════════════════════════════════════════════════════════════════════
# COUNCIL FACT CHECKER (Session 3)
# ═══════════════════════════════════════════════════════════════════════════


class CouncilFactChecker:
    """Validates LLM stage outputs against raw data payloads.
    Catches: price mismatches, out-of-range probabilities, hallucinated catalysts,
    score arithmetic errors, and missing required fields."""

    # Tolerance for price checks (LLMs may round)
    PRICE_TOLERANCE_PCT = 5.0  # 5% tolerance
    SCORE_TOLERANCE = 1.0  # Allow rounding differences

    def __init__(self):
        self.flags: list[str] = []

    def check(
        self,
        stage4_results: list[dict],
        payloads: dict[str, StockDataPayload],
    ) -> list[str]:
        """Run all fact checks on Stage 4 final output against raw payloads.
        Returns list of flag strings (empty = all clean)."""
        self.flags = []

        for r in stage4_results:
            ticker = r.get("ticker", "UNKNOWN")
            payload = payloads.get(ticker)

            # Check 1: Ticker exists in our payload data
            if payload is None:
                self.flags.append(f"HALLUCINATED_TICKER: {ticker} not in raw data")
                continue

            # Check 2: Price range sanity
            self._check_price_match(ticker, r, payload)

            # Check 3: Score arithmetic
            self._check_score_arithmetic(ticker, r)

            # Check 4: Forecast validity
            self._check_forecasts(ticker, r, payload)

            # Check 5: Required fields populated
            self._check_required_fields(ticker, r)

        if self.flags:
            logger.warning(f"FactChecker found {len(self.flags)} flags: {self.flags}")
        else:
            logger.info("FactChecker: All checks passed")

        return self.flags

    def _check_price_match(self, ticker: str, result: dict, payload: StockDataPayload):
        """Verify LLM-referenced prices are close to actual data."""
        # Check forecasts reference realistic price ranges
        for f in result.get("forecasts", []):
            low = f.get("price_range_low", 0)
            high = f.get("price_range_high", 0)
            if low <= 0 or high <= 0:
                self.flags.append(f"INVALID_PRICE_RANGE: {ticker} forecast has non-positive prices")
                continue
            if high < low:
                self.flags.append(f"INVERTED_RANGE: {ticker} high ({high}) < low ({low})")
            # Check that forecast range is somewhat near actual price
            actual = payload.price
            # Allow 50% deviation for volatile stocks
            if low > actual * 1.5 or high < actual * 0.5:
                self.flags.append(
                    f"PRICE_MISMATCH: {ticker} forecast range [{low}-{high}] "
                    f"far from actual price {actual}"
                )

    def _check_score_arithmetic(self, ticker: str, result: dict):
        """Verify score components sum to total."""
        score = result.get("score", {})
        if not score:
            self.flags.append(f"MISSING_SCORE: {ticker} has no score object")
            return
        components = (
            score.get("technical_momentum", 0) +
            score.get("sentiment_catalysts", 0) +
            score.get("options_volatility", 0) +
            score.get("risk_reward", 0) +
            score.get("conviction", 0)
        )
        total = score.get("total", 0)
        if abs(components - total) > self.SCORE_TOLERANCE:
            self.flags.append(
                f"SCORE_MISMATCH: {ticker} components sum to {components} but total is {total}"
            )

    def _check_forecasts(self, ticker: str, result: dict, payload: StockDataPayload):
        """Validate probabilistic forecasts."""
        forecasts = result.get("forecasts", [])
        if not forecasts:
            self.flags.append(f"MISSING_FORECASTS: {ticker} has no forecasts")
            return

        horizons_seen = set()
        for f in forecasts:
            h = f.get("horizon_days", 0)
            horizons_seen.add(h)

            # Direction probability must be 0-1
            dp = f.get("direction_probability", -1)
            if dp < 0 or dp > 1:
                self.flags.append(
                    f"INVALID_PROBABILITY: {ticker} {h}d direction_probability={dp}"
                )

            # Predicted direction must be UP or DOWN
            direction = f.get("predicted_direction", "")
            if direction not in ("UP", "DOWN"):
                self.flags.append(
                    f"INVALID_DIRECTION: {ticker} {h}d predicted_direction='{direction}'"
                )

            # Confidence interval should widen with time (√time decay)
            # This is a soft check — just flag if 8d range is narrower than 3d range

        # Should have 3, 5, 8 day horizons
        expected = {3, 5, 8}
        missing = expected - horizons_seen
        if missing:
            self.flags.append(f"MISSING_HORIZONS: {ticker} missing {missing}")

    def _check_required_fields(self, ticker: str, result: dict):
        """Ensure all required fields are populated."""
        if not result.get("reasoning"):
            self.flags.append(f"MISSING_REASONING: {ticker}")
        if not result.get("verification_notes"):
            self.flags.append(f"MISSING_VERIFICATION: {ticker}")


# ═══════════════════════════════════════════════════════════════════════════
# INSTITUTIONAL CONVICTION SCORE (IIC)
# ═══════════════════════════════════════════════════════════════════════════
# Unified 0-100 smart-money conviction signal surfaced on SpikeCard as a
# third graduated bar between Council and History.
#
# Weights: insider 35 / institutional 30 / analyst 20 / srs 15 = 100.
# Returns None ("No Scoring — Insufficient Data") when ALL 4 inputs are missing.
#
# Spec: docs/superpowers/specs/2026-04-08-conviction-score-cleanup-design.md

def _score_insider(ia: Optional["InsiderActivity"]) -> float:
    """Insider buying gets 0-35 points. Strongest single smart-money signal."""
    if ia is None or ia.recency_weighted_score is None:
        return 0.0
    r = ia.recency_weighted_score
    # r is clamped to [-1.0, 1.0] by the InsiderActivity Pydantic schema.
    if r >= 0.70:   return 35.0
    if r >= 0.45:   return 30.0
    if r >= 0.20:   return 25.0
    if r >= 0.00:   return 18.0
    if r >= -0.20:  return 10.0
    if r >= -0.50:  return 5.0
    return 0.0


def _score_institutional(ownership_pct: Optional[float]) -> float:
    """Institutional ownership 0-30 points. Captures 13F/13G filings."""
    if ownership_pct is None:
        return 0.0
    if ownership_pct >= 0.70:  return 30.0
    if ownership_pct >= 0.50:  return 26.0
    if ownership_pct >= 0.30:  return 22.0
    if ownership_pct >= 0.15:  return 16.0
    if ownership_pct >= 0.05:  return 10.0
    if ownership_pct > 0.0:    return 5.0
    return 0.0


def _score_analyst(ac: Optional["AnalystConsensus"]) -> float:
    """Analyst consensus 0-20 points."""
    if ac is None or ac.sentiment_score is None:
        return 0.0
    s = ac.sentiment_score  # clamped to [-1.0, 1.0]
    if s >= 0.70:   return 20.0
    if s >= 0.40:   return 17.0
    if s >= 0.20:   return 13.0
    if s >= 0.00:   return 9.0
    if s >= -0.30:  return 5.0
    return 0.0


def _score_srs(srs: Optional[float]) -> float:
    """Sector relative strength 0-15 points."""
    if srs is None:
        return 0.0
    # srs is ticker-change% minus sector-average-change%, effectively [-3, +3]
    if srs >= 2.0:   return 15.0
    if srs >= 1.0:   return 12.0
    if srs >= 0.5:   return 9.0
    if srs >= 0.0:   return 6.0
    if srs >= -0.5:  return 3.0
    return 0.0


def compute_iic(
    insider_activity: Optional["InsiderActivity"],
    institutional_ownership_pct: Optional[float],
    analyst_consensus: Optional["AnalystConsensus"],
    sector_relative_strength: Optional[float],
) -> Optional[int]:
    """
    Institutional Conviction Score (0-100) from smart-money signals.
    Returns None if ALL four input signals are missing or neutral
    (triggers "No Scoring — Insufficient Data" in the UI).
    """
    has_insider = (
        insider_activity is not None
        and insider_activity.recency_weighted_score is not None
        and insider_activity.recency_weighted_score != 0
    )
    has_institutional = (
        institutional_ownership_pct is not None
        and institutional_ownership_pct > 0
    )
    has_analyst = (
        analyst_consensus is not None
        and analyst_consensus.sentiment_score is not None
    )
    has_srs = sector_relative_strength is not None

    if not (has_insider or has_institutional or has_analyst or has_srs):
        return None

    total = (
        _score_insider(insider_activity)
        + _score_institutional(institutional_ownership_pct)
        + _score_analyst(analyst_consensus)
        + _score_srs(sector_relative_strength)
    )
    return int(round(min(max(total, 0), 100)))


# ═══════════════════════════════════════════════════════════════════════════
# CONSENSUS + CONVICTION TIERING (Session 3)
# ═══════════════════════════════════════════════════════════════════════════


def _build_consensus(
    stage1_results: list[dict],
    stage2_results: list[dict],
    stage3_results: list[dict],
    stage4_results: list[dict],
    payloads: dict[str, StockDataPayload],
    regime: str,
    regime_filter: MacroRegimeFilter,
    earnings_map: dict[str, EarningsEvent] | None = None,
    learning_engine: Optional["LearningEngine"] = None,
    historical_analyzer: Optional["HistoricalPerformanceAnalyzer"] = None,
) -> list[FinalHotPick]:
    """Build consensus Top 10 from all 4 stage results.

    Conviction tiering:
      HIGH   — consensus_score ≥ 80 AND appeared in ≥ 3 stages
      MEDIUM — consensus_score 65-79 OR appeared in exactly 2 stages
      LOW    — everything else
    """
    # Track which tickers appear in which stages
    stage_map: dict[str, dict[str, Any]] = {}

    def _record(stage_results: list[dict], stage_num: int):
        for r in stage_results:
            ticker = r["ticker"]
            if ticker not in stage_map:
                stage_map[ticker] = {
                    "stages": set(),
                    "scores": {},
                    "reasoning": [],
                    "kill_condition": "",
                    "worst_case_scenario": "",
                    "forecasts": [],
                    "verification_notes": [],
                }
            stage_map[ticker]["stages"].add(stage_num)
            stage_map[ticker]["scores"][f"stage{stage_num}"] = r["score"]
            if r.get("reasoning"):
                stage_map[ticker]["reasoning"].append(r["reasoning"])
            if r.get("kill_condition"):
                stage_map[ticker]["kill_condition"] = r["kill_condition"]
            if r.get("worst_case_scenario"):
                stage_map[ticker]["worst_case_scenario"] = r["worst_case_scenario"]
            if r.get("forecasts"):
                stage_map[ticker]["forecasts"] = r["forecasts"]
            if r.get("verification_notes"):
                stage_map[ticker]["verification_notes"].append(r["verification_notes"])

    _record(stage1_results, 1)
    _record(stage2_results, 2)
    _record(stage3_results, 3)
    _record(stage4_results, 4)

    # Compute consensus score: weighted average across stages that scored the ticker
    # Stage 4 (final) gets highest weight, Stage 1 gets lowest
    # LE BYPASS (2026-04-08): compute_stage_weights() has a confirmed JOIN defect
    # that always returns uniform {0.25 × 4}, underweighting Stage 4 by 10pp from
    # the intended {0.15, 0.20, 0.30, 0.35}. Bypassed pending full audit.
    # See docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md
    STAGE_WEIGHTS = {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}

    scored_tickers = []
    for ticker, data in stage_map.items():
        stages = data["stages"]
        weighted_sum = 0.0
        weight_sum = 0.0
        for stage_num in stages:
            score_key = f"stage{stage_num}"
            if score_key in data["scores"]:
                total = data["scores"][score_key].get("total", 0)
                w = STAGE_WEIGHTS[stage_num]
                weighted_sum += total * w
                weight_sum += w

        consensus_score = weighted_sum / weight_sum if weight_sum > 0 else 0

        # Track learning adjustments for per-pick transparency
        adjustments: dict[str, Any] = {"stage_weights": dict(STAGE_WEIGHTS), "le_stage_weights_bypassed": True}

        # Apply macro regime / sector adjustment
        payload = payloads.get(ticker)
        sector_adj = 1.0
        if learning_engine and payload:
            sector_adj = learning_engine.compute_sector_multiplier(payload.sector)
            consensus_score *= sector_adj
        elif payload and regime_filter:
            consensus_score = regime_filter.adjust_score(
                consensus_score, payload.sector, regime
            )
        adjustments["sector_multiplier"] = sector_adj

        # Apply directional adjustment from Stage 4 forecasts
        # Boost UP-predicted stocks, penalize DOWN-predicted stocks
        forecasts = data.get("forecasts", [])
        if forecasts:
            f3 = next((f for f in forecasts if f.get("horizon_days") == 3), None)
            if f3:
                direction = f3.get("predicted_direction", "UP")
                prob = f3.get("direction_probability", 0.5)
                move = abs(f3.get("most_likely_move_pct", 0))
                if direction == "UP":
                    directional_multiplier = 1.0 + (prob - 0.5) * move / 10
                else:
                    directional_multiplier = 1.0 - (prob - 0.5) * move / 5
                consensus_score *= max(directional_multiplier, 0.1)

        # ── Enhanced signal adjustments ──
        _earnings_map = earnings_map or {}

        # (A) Earnings proximity penalty
        earnings_mult = 1.0
        if ticker in _earnings_map:
            earn = _earnings_map[ticker]
            if earn.days_until <= 2:
                earnings_mult = 0.70
            elif earn.days_until <= 5:
                earnings_mult = 0.85
            elif earn.days_until <= 8:
                earnings_mult = 0.92
            consensus_score *= earnings_mult
        adjustments["earnings_penalty"] = earnings_mult

        # (B) Insider trading boost/penalty
        insider_adj = 1.0
        if payload and payload.insider_activity:
            ins = payload.insider_activity
            insider_adj = 1.0 + ins.recency_weighted_score * 0.08
            consensus_score *= insider_adj
        adjustments["insider_adj"] = insider_adj

        # (C) Analyst consensus adjustment
        analyst_adj = 1.0
        if payload and payload.analyst_consensus:
            ac = payload.analyst_consensus
            analyst_adj = 1.0 + ac.sentiment_score * 0.05
            if ac.target_upside_pct and ac.target_upside_pct > 15:
                analyst_adj += 0.03
            if ac.sentiment_score < -0.3 and consensus_score > 70:
                analyst_adj *= 0.95
            consensus_score *= analyst_adj
        adjustments["analyst_adj"] = analyst_adj

        # (D) Sector-relative strength adjustment
        srs_adj = 1.0
        if payload and payload.sector_relative_strength is not None:
            srs = payload.sector_relative_strength
            capped = max(-3.0, min(3.0, srs))
            srs_adj = 1.0 + capped * 0.017
            consensus_score *= srs_adj
        adjustments["srs_adj"] = srs_adj

        # (E) Stage disagreement learning adjustment
        disagreement_adj = 1.0
        if learning_engine:
            pick_stage_scores = {}
            for stage_num in stages:
                score_key = f"stage{stage_num}"
                if score_key in data["scores"]:
                    pick_stage_scores[stage_num] = data["scores"][score_key].get("total", 0)
            disagreement_adj = learning_engine.compute_disagreement_adjustment(pick_stage_scores)
            consensus_score *= disagreement_adj
        adjustments["disagreement_adj"] = disagreement_adj

        # (F) IV Expected Move reality check
        iv_check = 1.0
        if payload and payload.iv_expected_move and payload.iv_expected_move.iv_available:
            iv_data = payload.iv_expected_move
            forecasts_for_iv = data.get("forecasts", [])
            f3_iv = next((f for f in forecasts_for_iv if f.get("horizon_days") == 3), None)
            if f3_iv:
                predicted_move = abs(f3_iv.get("most_likely_move_pct", 0))
                if predicted_move > iv_data.expected_move_2sd_pct:
                    iv_check = 0.90
                elif predicted_move <= iv_data.expected_move_1sd_pct:
                    iv_check = 1.03
                consensus_score *= iv_check
        adjustments["iv_check"] = iv_check

        # (G) Historical edge multiplier — apply before ranking so sort reflects final score
        edge_mult = 1.0
        if historical_analyzer:
            edge_mult = historical_analyzer.get_historical_edge_multiplier(ticker)
            if edge_mult != 1.0:
                consensus_score *= edge_mult
        adjustments["edge_multiplier"] = edge_mult

        # ── Combined multiplier cap ──
        # Prevents the [0,100] clamp at FinalHotPick construction from
        # silently swallowing mathematically impossible scores.
        # directional_multiplier is excluded — it is an LLM forecast signal,
        # not a smart-money multiplier.
        CAP_MIN, CAP_MAX = 0.5, 1.5
        combined_adj = (
            sector_adj * earnings_mult * insider_adj * analyst_adj
            * srs_adj * disagreement_adj * iv_check * edge_mult
        )
        if combined_adj == 0.0:
            # A multiplier zeroed the score (typically edge_mult for
            # noise-filtered tickers — see HistoricalPerformanceAnalyzer
            # .get_historical_edge_multiplier). consensus_score is already 0;
            # the cap has nothing to rescale. Skip the division.
            adjustments["was_capped"] = True
        elif combined_adj > CAP_MAX:
            consensus_score *= CAP_MAX / combined_adj
            adjustments["was_capped"] = True
        elif combined_adj < CAP_MIN:
            consensus_score *= CAP_MIN / combined_adj
            adjustments["was_capped"] = True
        else:
            adjustments["was_capped"] = False
        adjustments["combined_adj_multiplier"] = round(combined_adj, 4)

        # ── Institutional Conviction Score (IIC) ──
        # Pure derived view of smart-money signals. Does NOT replace the
        # existing consensus_score math — surfaces it as an orthogonal bar.
        iic_score = compute_iic(
            insider_activity=payload.insider_activity if payload else None,
            institutional_ownership_pct=payload.institutional_ownership_pct if payload else None,
            analyst_consensus=payload.analyst_consensus if payload else None,
            sector_relative_strength=payload.sector_relative_strength if payload else None,
        )
        data["institutional_conviction_score"] = iic_score

        data["learning_adjustments"] = adjustments
        scored_tickers.append((ticker, consensus_score, len(stages), data))

    # Filter out strong bearish predictions (>65% probability of DOWN)
    def _is_bearish(entry: tuple) -> bool:
        data = entry[3]
        forecasts = data.get("forecasts", [])
        f3 = next((f for f in forecasts if f.get("horizon_days") == 3), None)
        if f3 and f3.get("predicted_direction") == "DOWN":
            logger.info(f"Filtering {entry[0]}: predicted DOWN ({f3.get('direction_probability', 0):.0%})")
            return True
        return False

    scored_tickers = [t for t in scored_tickers if not _is_bearish(t)]

    # Sort by consensus score descending, take top 10
    scored_tickers.sort(key=lambda x: (-x[1], -x[2]))
    top_10 = scored_tickers[:10]

    # Compute conviction thresholds once (not per-pick)
    high_t, med_t = learning_engine.compute_conviction_thresholds() if learning_engine else (80.0, 65.0)

    # Build FinalHotPick objects
    picks: list[FinalHotPick] = []
    for rank, (ticker, consensus_score, n_stages, data) in enumerate(top_10, 1):
        payload = payloads.get(ticker)

        # Determine conviction tier (adaptive thresholds)
        data["learning_adjustments"]["conviction_thresholds"] = (high_t, med_t)
        if consensus_score >= high_t and n_stages >= 3:
            tier = ConvictionTier.HIGH
        elif consensus_score >= med_t or n_stages >= 2:
            tier = ConvictionTier.MEDIUM
        else:
            tier = ConvictionTier.LOW

        # Parse stage scores into ScoreBreakdown objects (clamp to bounds)
        stage_scores = {}
        _bounds = {"technical_momentum": 30, "sentiment_catalysts": 25,
                   "options_volatility": 20, "risk_reward": 15, "conviction": 10}
        for stage_key, score_dict in data["scores"].items():
            try:
                for k, mx in _bounds.items():
                    if k in score_dict:
                        score_dict[k] = min(float(score_dict[k]), mx)
                score_dict["total"] = sum(score_dict.get(k, 0) for k in _bounds)
                stage_scores[stage_key] = ScoreBreakdown(**score_dict)
            except Exception:
                pass

        # Parse forecasts
        forecasts = []
        for f in data.get("forecasts", []):
            try:
                if isinstance(f, dict):
                    forecasts.append(ProbabilisticForecast(**f))
                elif isinstance(f, ProbabilisticForecast):
                    forecasts.append(f)
            except Exception:
                pass

        # Extract key catalyst from reasoning
        reasoning_summary = " | ".join(data.get("reasoning", [])[-2:])
        key_catalyst = ""
        if data.get("reasoning"):
            # Use the most recent reasoning as key catalyst summary
            key_catalyst = data["reasoning"][-1][:200] if data["reasoning"][-1] else ""

        pick = FinalHotPick(
            rank=rank,
            ticker=ticker,
            company_name=payload.company_name if payload else "",
            sector=payload.sector if payload else "Unknown",
            price=payload.price if payload else 0.01,
            change_pct=payload.change_pct if payload else 0.0,
            consensus_score=round(min(max(consensus_score, 0), 100), 2),
            conviction_tier=tier,
            stages_appeared=n_stages,
            stage_scores=stage_scores,
            forecasts=forecasts,
            key_catalyst=key_catalyst,
            kill_condition=data.get("kill_condition", ""),
            worst_case_scenario=data.get("worst_case_scenario", ""),
            reasoning_summary=reasoning_summary,
            technicals=payload.technicals if payload else None,
            earnings_flag=(ticker in (earnings_map or {})),
            insider_signal=(
                payload.insider_activity.recency_weighted_score
                if payload and payload.insider_activity else None
            ),
            analyst_upside_pct=(
                payload.analyst_consensus.target_upside_pct
                if payload and payload.analyst_consensus else None
            ),
            sector_relative_strength=(
                payload.sector_relative_strength if payload else None
            ),
            institutional_conviction_score=data.get("institutional_conviction_score"),
            learning_adjustments=data.get("learning_adjustments"),
        )
        picks.append(pick)

    logger.info(
        f"Consensus: {len(picks)} picks — "
        f"HIGH: {sum(1 for p in picks if p.conviction_tier == ConvictionTier.HIGH)}, "
        f"MEDIUM: {sum(1 for p in picks if p.conviction_tier == ConvictionTier.MEDIUM)}, "
        f"LOW: {sum(1 for p in picks if p.conviction_tier == ConvictionTier.LOW)}"
    )
    return picks


# ═══════════════════════════════════════════════════════════════════════════
# HISTORICAL PERFORMANCE ANALYZER (Session 4)
# ═══════════════════════════════════════════════════════════════════════════

_data_dir = Path("/app/data") if Path("/app/data").exists() else Path(".")
_data_dir.mkdir(parents=True, exist_ok=True)
DB_PATH = str(_data_dir / "spike_trades_council.db")


class HistoricalPerformanceAnalyzer:
    """Tracks past picks and realized returns using SQLite.
    Provides Historical Edge Multiplier and noise filtering (<53% accuracy dropped)."""

    NOISE_THRESHOLD = 0.53  # Minimum directional accuracy to keep a ticker
    MIN_PICKS_FOR_FILTER = 5  # Need at least N historical picks to apply noise filter

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        """Create tables if they don't exist."""
        conn = sqlite3.connect(self.db_path)
        try:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS pick_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_date TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    predicted_direction TEXT NOT NULL DEFAULT 'UP',
                    consensus_score REAL NOT NULL,
                    conviction_tier TEXT NOT NULL,
                    entry_price REAL NOT NULL,
                    forecast_3d_move_pct REAL,
                    forecast_5d_move_pct REAL,
                    forecast_8d_move_pct REAL,
                    forecast_3d_direction TEXT,
                    forecast_5d_direction TEXT,
                    forecast_8d_direction TEXT,
                    sector TEXT,
                    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS accuracy_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pick_id INTEGER NOT NULL REFERENCES pick_history(id),
                    ticker TEXT NOT NULL,
                    horizon_days INTEGER NOT NULL,
                    predicted_direction TEXT NOT NULL,
                    actual_direction TEXT,
                    predicted_move_pct REAL,
                    actual_move_pct REAL,
                    accurate INTEGER DEFAULT NULL,
                    actual_price REAL,
                    checked_at TEXT,
                    UNIQUE(pick_id, horizon_days)
                );

                CREATE TABLE IF NOT EXISTS stage_scores (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pick_id INTEGER NOT NULL,
                    run_date TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    stage INTEGER NOT NULL,
                    model TEXT NOT NULL,
                    total_score REAL NOT NULL,
                    technical_momentum REAL,
                    sentiment_catalysts REAL,
                    options_volatility REAL,
                    risk_reward REAL,
                    conviction REAL,
                    predicted_direction TEXT,
                    predicted_move_pct REAL,
                    UNIQUE(pick_id, stage)
                );

                CREATE INDEX IF NOT EXISTS idx_pick_history_ticker ON pick_history(ticker);
                CREATE INDEX IF NOT EXISTS idx_pick_history_run_date ON pick_history(run_date);
                CREATE INDEX IF NOT EXISTS idx_accuracy_ticker ON accuracy_records(ticker);
                CREATE INDEX IF NOT EXISTS idx_stage_scores_ticker ON stage_scores(ticker);
                CREATE INDEX IF NOT EXISTS idx_stage_scores_run_date ON stage_scores(run_date);
            """)
            conn.commit()
            # Migration: add sector column to existing databases
            try:
                conn.execute("ALTER TABLE pick_history ADD COLUMN sector TEXT")
                conn.commit()
            except Exception:
                pass  # Column already exists
            # Migration: add source column to pick_history and accuracy_records
            try:
                conn.execute("ALTER TABLE pick_history ADD COLUMN source TEXT DEFAULT 'council'")
                conn.commit()
            except Exception:
                pass  # Column already exists
            try:
                conn.execute("ALTER TABLE accuracy_records ADD COLUMN source TEXT DEFAULT 'council'")
                conn.commit()
            except Exception:
                pass  # Column already exists
        finally:
            conn.close()
        logger.info(f"HistoricalPerformanceAnalyzer: DB initialized at {self.db_path}")

    def record_picks(self, council_result: dict) -> int:
        """Save council run picks to history. Returns number of picks recorded."""
        run_date = council_result.get("run_date", date.today().isoformat())
        run_id = council_result.get("run_id", "unknown")
        picks = council_result.get("top_picks", [])

        conn = sqlite3.connect(self.db_path)
        recorded = 0
        try:
            for pick in picks:
                ticker = pick["ticker"]
                source = "council"
                # Extract forecast data
                forecasts = pick.get("forecasts", [])
                f3 = next((f for f in forecasts if f.get("horizon_days") == 3), {})
                f5 = next((f for f in forecasts if f.get("horizon_days") == 5), {})
                f8 = next((f for f in forecasts if f.get("horizon_days") == 8), {})

                sector = pick.get("sector", pick.get("payload", {}).get("sector", "Unknown"))
                conn.execute("""
                    INSERT INTO pick_history
                    (run_date, run_id, ticker, predicted_direction, consensus_score,
                     conviction_tier, entry_price, forecast_3d_move_pct, forecast_5d_move_pct,
                     forecast_8d_move_pct, forecast_3d_direction, forecast_5d_direction,
                     forecast_8d_direction, sector, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    str(run_date), run_id, ticker,
                    f3.get("predicted_direction", "UP"),
                    pick.get("consensus_score", 0),
                    pick.get("conviction_tier", "LOW"),
                    pick.get("price", 0),
                    f3.get("most_likely_move_pct"),
                    f5.get("most_likely_move_pct"),
                    f8.get("most_likely_move_pct"),
                    f3.get("predicted_direction"),
                    f5.get("predicted_direction"),
                    f8.get("predicted_direction"),
                    sector,
                    source,
                ))
                recorded += 1

                # Create placeholder accuracy records for each horizon
                pick_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                for horizon, fcast in [(3, f3), (5, f5), (8, f8)]:
                    if fcast:
                        conn.execute("""
                            INSERT OR IGNORE INTO accuracy_records
                            (pick_id, ticker, horizon_days, predicted_direction, predicted_move_pct)
                            VALUES (?, ?, ?, ?, ?)
                        """, (
                            pick_id, ticker, horizon,
                            fcast.get("predicted_direction", "UP"),
                            fcast.get("most_likely_move_pct"),
                        ))

                # Save per-stage scores
                stage_models = {1: "sonnet", 2: "gemini", 3: "opus", 4: "grok"}
                stage_scores_dict = pick.get("stage_scores", {})
                for stage_key, score_data in stage_scores_dict.items():
                    stage_num = int(stage_key.replace("stage", ""))
                    if isinstance(score_data, dict):
                        # Get direction from Stage 4 forecasts
                        pred_dir = None
                        pred_move = None
                        if stage_num == 4 and f3:
                            pred_dir = f3.get("predicted_direction")
                            pred_move = f3.get("most_likely_move_pct")
                        conn.execute("""
                            INSERT OR IGNORE INTO stage_scores
                            (pick_id, run_date, ticker, stage, model, total_score,
                             technical_momentum, sentiment_catalysts, options_volatility,
                             risk_reward, conviction, predicted_direction, predicted_move_pct)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (
                            pick_id, str(run_date), ticker, stage_num,
                            stage_models.get(stage_num, f"stage{stage_num}"),
                            score_data.get("total", 0),
                            score_data.get("technical_momentum"),
                            score_data.get("sentiment_catalysts"),
                            score_data.get("options_volatility"),
                            score_data.get("risk_reward"),
                            score_data.get("conviction"),
                            pred_dir, pred_move,
                        ))

            conn.commit()
        finally:
            conn.close()

        logger.info(f"HistoricalPerformanceAnalyzer: Recorded {recorded} picks for run {run_id}")
        return recorded

    async def backfill_actuals(self, fetcher: "LiveDataFetcher") -> int:
        """Look up actual prices for past picks where accuracy is not yet filled.
        Returns number of records updated."""
        conn = sqlite3.connect(self.db_path)
        updated = 0
        try:
            # Find accuracy records missing actual data
            # Loose calendar filter: at least horizon_days have passed.
            # Exact trading-day check happens in Python below.
            rows = conn.execute("""
                SELECT ar.id, ar.pick_id, ar.ticker, ar.horizon_days,
                       ar.predicted_direction, ar.predicted_move_pct,
                       ph.entry_price, ph.run_date
                FROM accuracy_records ar
                JOIN pick_history ph ON ar.pick_id = ph.id
                WHERE ar.actual_direction IS NULL
                  AND date(ph.run_date, '+' || ar.horizon_days || ' days') <= date('now')
            """).fetchall()

            # Filter to only rows where enough trading days have passed
            def _trading_days_since(run_date_str: str) -> int:
                rd = date.fromisoformat(run_date_str)
                today = datetime.now(ZoneInfo("America/Halifax")).date()
                count = 0
                current = rd
                while current < today:
                    current += timedelta(days=1)
                    if current.weekday() < 5:  # Mon-Fri
                        count += 1
                return count

            rows = [r for r in rows if _trading_days_since(r[7]) >= r[3]]

            if not rows:
                logger.info("HistoricalPerformanceAnalyzer: No records to backfill")
                return 0

            # Group by ticker to batch quote fetches
            tickers = list(set(r[2] for r in rows))
            quotes = await fetcher.fetch_quotes(tickers)

            for row in rows:
                ar_id, pick_id, ticker, horizon, pred_dir, pred_move, entry_price, run_date = row
                quote = quotes.get(ticker)
                if not quote:
                    continue

                actual_price = quote.get("price", 0)
                if actual_price <= 0 or entry_price <= 0:
                    continue

                actual_move_pct = ((actual_price - entry_price) / entry_price) * 100
                actual_direction = "UP" if actual_move_pct >= 0 else "DOWN"
                accurate = 1 if actual_direction == pred_dir else 0

                conn.execute("""
                    UPDATE accuracy_records
                    SET actual_direction = ?, actual_move_pct = ?, actual_price = ?,
                        accurate = ?, checked_at = datetime('now')
                    WHERE id = ?
                """, (actual_direction, round(actual_move_pct, 4), actual_price, accurate, ar_id))
                updated += 1

            conn.commit()
        finally:
            conn.close()

        logger.info(f"HistoricalPerformanceAnalyzer: Backfilled {updated} accuracy records")
        return updated

    def get_ticker_accuracy(self, ticker: str) -> tuple[float, int]:
        """Return (accuracy_rate, num_picks) for a ticker.
        accuracy_rate is 0.0-1.0, num_picks is how many resolved records exist."""
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute("""
                SELECT COUNT(*) as total,
                       SUM(CASE WHEN accurate = 1 THEN 1 ELSE 0 END) as correct
                FROM accuracy_records
                WHERE ticker = ? AND accurate IS NOT NULL
            """, (ticker,)).fetchone()
            total = row[0] or 0
            correct = row[1] or 0
            if total == 0:
                return 0.5, 0  # Default: assume neutral
            return correct / total, total
        finally:
            conn.close()

    def get_historical_edge_multiplier(self, ticker: str) -> float:
        """Compute Historical Edge Multiplier based on past accuracy.
        >60% → 1.10, >55% → 1.05, >53% → 1.0, <53% → 0.0 (noise-filtered).
        Returns 1.0 if insufficient history."""
        accuracy, n_picks = self.get_ticker_accuracy(ticker)
        if n_picks < self.MIN_PICKS_FOR_FILTER:
            return 1.0  # Not enough data to adjust
        if accuracy < self.NOISE_THRESHOLD:
            return 0.0  # Noise — drop this ticker
        if accuracy >= 0.60:
            return 1.10
        if accuracy >= 0.55:
            return 1.05
        return 1.0

    def noise_filter(self, tickers: list[str]) -> list[str]:
        """Remove tickers with <53% historical accuracy (if enough history exists).
        Returns filtered list of tickers."""
        filtered = []
        dropped = []
        for ticker in tickers:
            multiplier = self.get_historical_edge_multiplier(ticker)
            if multiplier > 0:
                filtered.append(ticker)
            else:
                dropped.append(ticker)

        if dropped:
            logger.info(
                f"HistoricalPerformanceAnalyzer: Noise filter dropped {len(dropped)} tickers: "
                f"{dropped}"
            )
        else:
            logger.info("HistoricalPerformanceAnalyzer: Noise filter — no tickers dropped")
        return filtered

    def get_all_ticker_stats(self) -> dict[str, dict]:
        """Return accuracy stats for all tickers with history."""
        conn = sqlite3.connect(self.db_path)
        try:
            rows = conn.execute("""
                SELECT ticker,
                       COUNT(*) as total,
                       SUM(CASE WHEN accurate = 1 THEN 1 ELSE 0 END) as correct
                FROM accuracy_records
                WHERE accurate IS NOT NULL
                GROUP BY ticker
            """).fetchall()
            return {
                row[0]: {
                    "total_picks": row[1],
                    "correct": row[2],
                    "accuracy": round(row[2] / row[1], 4) if row[1] > 0 else 0,
                }
                for row in rows
            }
        finally:
            conn.close()

    def get_stage_analytics(self) -> dict:
        """Compute per-stage LLM performance analytics.
        Joins stage_scores with accuracy_records to provide hit rates, bias,
        score distributions, and daily breakdowns."""
        conn = sqlite3.connect(self.db_path)
        try:
            # ── Per-stage summary ──
            stages = []
            for stage_num, model_name in [(1, "sonnet"), (2, "gemini"), (3, "opus"), (4, "grok")]:
                row = conn.execute("""
                    SELECT COUNT(*) as total_scored,
                           AVG(total_score) as avg_score,
                           MIN(total_score) as min_score,
                           MAX(total_score) as max_score
                    FROM stage_scores WHERE stage = ?
                """, (stage_num,)).fetchone()

                # How many of this stage's picks made the final Top 10
                top20_row = conn.execute("""
                    SELECT COUNT(DISTINCT ss.ticker)
                    FROM stage_scores ss
                    INNER JOIN pick_history ph ON ss.pick_id = ph.id
                    WHERE ss.stage = ?
                """, (stage_num,)).fetchone()

                stage_info = {
                    "stage": stage_num,
                    "model": model_name,
                    "total_picks_scored": row[0] or 0,
                    "avg_score": round(row[1], 1) if row[1] else None,
                    "min_score": round(row[2], 1) if row[2] else None,
                    "max_score": round(row[3], 1) if row[3] else None,
                    "picks_in_top20": top20_row[0] or 0,
                }

                # Stage 4 direction accuracy (only stage with predictions)
                if stage_num == 4:
                    acc_row = conn.execute("""
                        SELECT COUNT(*) as total,
                               SUM(CASE WHEN ar.accurate = 1 THEN 1 ELSE 0 END) as correct,
                               AVG(ar.predicted_move_pct) as avg_pred,
                               AVG(ar.actual_move_pct) as avg_actual
                        FROM stage_scores ss
                        INNER JOIN accuracy_records ar ON ss.pick_id = ar.pick_id
                        WHERE ss.stage = 4
                          AND ar.accurate IS NOT NULL
                          AND ar.horizon_days = 3
                    """).fetchone()
                    total_checked = acc_row[0] or 0
                    correct = acc_row[1] or 0
                    stage_info["hit_rate_3d"] = round(correct / total_checked, 4) if total_checked > 0 else None
                    stage_info["avg_predicted_move"] = round(acc_row[2], 2) if acc_row[2] else None
                    stage_info["avg_actual_move"] = round(acc_row[3], 2) if acc_row[3] else None
                    stage_info["bias"] = round((acc_row[2] or 0) - (acc_row[3] or 0), 2) if acc_row[2] and acc_row[3] else None
                    stage_info["total_checked"] = total_checked

                    # 5d and 8d hit rates
                    for horizon in [5, 8]:
                        h_row = conn.execute("""
                            SELECT COUNT(*) as total,
                                   SUM(CASE WHEN ar.accurate = 1 THEN 1 ELSE 0 END) as correct
                            FROM stage_scores ss
                            INNER JOIN accuracy_records ar ON ss.pick_id = ar.pick_id
                            WHERE ss.stage = 4 AND ar.accurate IS NOT NULL
                              AND ar.horizon_days = ?
                        """, (horizon,)).fetchone()
                        h_total = h_row[0] or 0
                        h_correct = h_row[1] or 0
                        stage_info[f"hit_rate_{horizon}d"] = round(h_correct / h_total, 4) if h_total > 0 else None

                # Per-stage sample counts for trust signals
                for horizon, key in [(3, "sample_count_3d"), (5, "sample_count_5d"), (8, "sample_count_8d")]:
                    sc_row = conn.execute("""
                        SELECT COUNT(DISTINCT ar.pick_id)
                        FROM stage_scores ss
                        INNER JOIN accuracy_records ar ON ss.pick_id = ar.pick_id
                        WHERE ss.stage = ?
                          AND ar.horizon_days = ?
                          AND ar.actual_move_pct IS NOT NULL
                    """, (stage_num, horizon)).fetchone()
                    stage_info[key] = sc_row[0] or 0

                stages.append(stage_info)

            # ── Score vs Outcome buckets ──
            score_buckets = []
            for low, high, label in [(80, 101, "80+"), (70, 80, "70-80"), (60, 70, "60-70"), (0, 60, "<60")]:
                bucket_row = conn.execute("""
                    SELECT COUNT(*) as total,
                           AVG(ar.actual_move_pct) as avg_actual,
                           SUM(CASE WHEN ar.accurate = 1 THEN 1 ELSE 0 END) as correct
                    FROM pick_history ph
                    INNER JOIN accuracy_records ar ON ph.id = ar.pick_id
                    WHERE ph.consensus_score >= ? AND ph.consensus_score < ?
                      AND ar.accurate IS NOT NULL AND ar.horizon_days = 3
                """, (low, high)).fetchone()
                b_total = bucket_row[0] or 0
                b_correct = bucket_row[2] or 0
                score_buckets.append({
                    "bucket": label,
                    "picks": b_total,
                    "avg_actual_return": round(bucket_row[1], 2) if bucket_row[1] else None,
                    "hit_rate": round(b_correct / b_total, 4) if b_total > 0 else None,
                })

            # ── Daily breakdown ──
            daily_rows = conn.execute("""
                SELECT ph.run_date,
                       COUNT(DISTINCT ph.id) as picks,
                       SUM(CASE WHEN ar.horizon_days = 3 AND ar.accurate IS NOT NULL THEN 1 ELSE 0 END) as checked_3d,
                       SUM(CASE WHEN ar.horizon_days = 3 AND ar.accurate = 1 THEN 1 ELSE 0 END) as correct_3d,
                       SUM(CASE WHEN ar.horizon_days = 5 AND ar.accurate IS NOT NULL THEN 1 ELSE 0 END) as checked_5d,
                       SUM(CASE WHEN ar.horizon_days = 5 AND ar.accurate = 1 THEN 1 ELSE 0 END) as correct_5d,
                       SUM(CASE WHEN ar.horizon_days = 8 AND ar.accurate IS NOT NULL THEN 1 ELSE 0 END) as checked_8d,
                       SUM(CASE WHEN ar.horizon_days = 8 AND ar.accurate = 1 THEN 1 ELSE 0 END) as correct_8d
                FROM pick_history ph
                LEFT JOIN accuracy_records ar ON ph.id = ar.pick_id
                GROUP BY ph.run_date
                ORDER BY ph.run_date DESC
                LIMIT 30
            """).fetchall()
            daily = []
            for r in daily_rows:
                daily.append({
                    "date": r[0],
                    "picks": r[1],
                    "checked_3d": r[2], "correct_3d": r[3],
                    "hit_rate_3d": round(r[3] / r[2], 4) if r[2] and r[2] > 0 else None,
                    "checked_5d": r[4], "correct_5d": r[5],
                    "hit_rate_5d": round(r[5] / r[4], 4) if r[4] and r[4] > 0 else None,
                    "checked_8d": r[6], "correct_8d": r[7],
                    "hit_rate_8d": round(r[7] / r[6], 4) if r[6] and r[6] > 0 else None,
                })

            # ── Pick detail (for export) ──
            pick_detail = conn.execute("""
                SELECT ph.run_date, ph.ticker, ph.consensus_score, ph.conviction_tier,
                       ph.entry_price, ph.predicted_direction,
                       ph.forecast_3d_move_pct, ph.forecast_5d_move_pct, ph.forecast_8d_move_pct,
                       s1.total_score as s1_score, s2.total_score as s2_score,
                       s3.total_score as s3_score, s4.total_score as s4_score,
                       a3.actual_move_pct as actual_3d, a3.accurate as accurate_3d,
                       a5.actual_move_pct as actual_5d, a5.accurate as accurate_5d,
                       a8.actual_move_pct as actual_8d, a8.accurate as accurate_8d
                FROM pick_history ph
                LEFT JOIN stage_scores s1 ON ph.id = s1.pick_id AND s1.stage = 1
                LEFT JOIN stage_scores s2 ON ph.id = s2.pick_id AND s2.stage = 2
                LEFT JOIN stage_scores s3 ON ph.id = s3.pick_id AND s3.stage = 3
                LEFT JOIN stage_scores s4 ON ph.id = s4.pick_id AND s4.stage = 4
                LEFT JOIN accuracy_records a3 ON ph.id = a3.pick_id AND a3.horizon_days = 3
                LEFT JOIN accuracy_records a5 ON ph.id = a5.pick_id AND a5.horizon_days = 5
                LEFT JOIN accuracy_records a8 ON ph.id = a8.pick_id AND a8.horizon_days = 8
                ORDER BY ph.run_date DESC, ph.consensus_score DESC
            """).fetchall()
            picks = []
            for r in pick_detail:
                picks.append({
                    "date": r[0], "ticker": r[1], "consensus_score": r[2],
                    "conviction": r[3], "entry_price": r[4], "direction": r[5],
                    "pred_3d": r[6], "pred_5d": r[7], "pred_8d": r[8],
                    "s1_score": r[9], "s2_score": r[10], "s3_score": r[11], "s4_score": r[12],
                    "actual_3d": r[13], "accurate_3d": r[14],
                    "actual_5d": r[15], "accurate_5d": r[16],
                    "actual_8d": r[17], "accurate_8d": r[18],
                })

            # ── Overall summary ──
            overall = conn.execute("""
                SELECT COUNT(DISTINCT ph.id) as total_picks,
                       SUM(CASE WHEN ar.horizon_days = 3 AND ar.accurate = 1 THEN 1 ELSE 0 END) as correct_3d,
                       SUM(CASE WHEN ar.horizon_days = 3 AND ar.accurate IS NOT NULL THEN 1 ELSE 0 END) as checked_3d,
                       SUM(CASE WHEN ar.horizon_days = 5 AND ar.accurate = 1 THEN 1 ELSE 0 END) as correct_5d,
                       SUM(CASE WHEN ar.horizon_days = 5 AND ar.accurate IS NOT NULL THEN 1 ELSE 0 END) as checked_5d,
                       SUM(CASE WHEN ar.horizon_days = 8 AND ar.accurate = 1 THEN 1 ELSE 0 END) as correct_8d,
                       SUM(CASE WHEN ar.horizon_days = 8 AND ar.accurate IS NOT NULL THEN 1 ELSE 0 END) as checked_8d
                FROM pick_history ph
                LEFT JOIN accuracy_records ar ON ph.id = ar.pick_id
            """).fetchone()

            # Count distinct picks that have non-null accuracy data per horizon
            picks_with_3d = conn.execute("""
                SELECT COUNT(DISTINCT pick_id) FROM accuracy_records
                WHERE horizon_days = 3 AND actual_move_pct IS NOT NULL
            """).fetchone()[0] or 0
            picks_with_5d = conn.execute("""
                SELECT COUNT(DISTINCT pick_id) FROM accuracy_records
                WHERE horizon_days = 5 AND actual_move_pct IS NOT NULL
            """).fetchone()[0] or 0
            picks_with_8d = conn.execute("""
                SELECT COUNT(DISTINCT pick_id) FROM accuracy_records
                WHERE horizon_days = 8 AND actual_move_pct IS NOT NULL
            """).fetchone()[0] or 0

            summary = {
                "total_picks": overall[0] or 0,
                "hit_rate_3d": round(overall[1] / overall[2], 4) if overall[2] and overall[2] > 0 else None,
                "hit_rate_5d": round(overall[3] / overall[4], 4) if overall[4] and overall[4] > 0 else None,
                "hit_rate_8d": round(overall[5] / overall[6], 4) if overall[6] and overall[6] > 0 else None,
                "checked_3d": overall[2] or 0,
                "checked_5d": overall[4] or 0,
                "checked_8d": overall[6] or 0,
                "last_updated": datetime.now(ZoneInfo("America/Halifax")).isoformat(),
                "total_picks_with_3d": picks_with_3d,
                "total_picks_with_5d": picks_with_5d,
                "total_picks_with_8d": picks_with_8d,
            }

            return {
                "summary": summary,
                "stages": stages,
                "score_buckets": score_buckets,
                "daily": daily,
                "pick_detail": picks,
            }

        finally:
            conn.close()


# ═══════════════════════════════════════════════════════════════════════════
# HISTORICAL CALIBRATION ENGINE (Session 13)
# ═══════════════════════════════════════════════════════════════════════════


class HistoricalCalibrationEngine:
    """Builds base rates from 6 months of TSX history and calibrates
    council confidence against observed outcomes.

    Two data sources:
    1. Generic TSX base rates — 6-month backtest of technical profiles vs 3/5/8 day outcomes
    2. Council-specific calibration — Spike's own pick history (grows daily)

    The blend shifts from generic→specific as council data accumulates.
    """

    MIN_COUNCIL_SAMPLES = 5  # Need at least N council picks before using council calibration
    BACKTEST_TICKERS_LIMIT = 100  # Top N liquid tickers for backtest
    BACKTEST_DAYS = 126  # ~6 months of trading days

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_tables()

    def _init_tables(self):
        conn = sqlite3.connect(self.db_path)
        try:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS calibration_base_rates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rsi_bucket TEXT NOT NULL,
                    macd_direction TEXT NOT NULL,
                    adx_bucket TEXT NOT NULL,
                    rel_volume_bucket TEXT NOT NULL,
                    horizon_days INTEGER NOT NULL,
                    sample_count INTEGER NOT NULL,
                    up_probability REAL NOT NULL,
                    avg_move_pct REAL NOT NULL,
                    median_move_pct REAL,
                    stddev_move_pct REAL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(rsi_bucket, macd_direction, adx_bucket, rel_volume_bucket, horizon_days)
                );

                CREATE TABLE IF NOT EXISTS calibration_council (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    confidence_bucket TEXT NOT NULL,
                    horizon_days INTEGER NOT NULL,
                    sample_count INTEGER NOT NULL,
                    actual_hit_rate REAL NOT NULL,
                    avg_predicted_move REAL,
                    avg_actual_move REAL,
                    bias REAL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(confidence_bucket, horizon_days)
                );
            """)
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _bucket_rsi(rsi: float) -> str:
        if rsi < 20: return "0-20"
        if rsi < 30: return "20-30"
        if rsi < 40: return "30-40"
        if rsi < 50: return "40-50"
        if rsi < 60: return "50-60"
        if rsi < 70: return "60-70"
        if rsi < 80: return "70-80"
        return "80+"

    @staticmethod
    def _bucket_adx(adx: float) -> str:
        if adx < 15: return "0-15"
        if adx < 25: return "15-25"
        return "25+"

    @staticmethod
    def _bucket_volume(rel_vol: float) -> str:
        if rel_vol < 0.5: return "low"
        if rel_vol < 1.5: return "normal"
        return "high"

    @staticmethod
    def _bucket_confidence(confidence: float) -> str:
        if confidence < 50: return "<50"
        bucket_low = int(confidence // 5) * 5
        return f"{bucket_low}-{bucket_low + 5}"

    async def run_historical_backtest(self, fetcher: "LiveDataFetcher") -> dict:
        """Run 6-month backtest on liquid TSX tickers. Offline job (~10-20 min).
        Returns summary stats."""
        logger.info("Calibration: Starting 6-month historical backtest")
        start_time = time.time()

        # Get liquid TSX tickers
        universe = await fetcher.fetch_tsx_universe()
        quotes = await fetcher.fetch_quotes(universe[:500])
        # Sort by dollar volume, take top N
        liquid = sorted(
            [(t, q) for t, q in quotes.items() if (q.get("price") or 0) > 2 and (q.get("volume") or 0) > 0],
            key=lambda x: (x[1].get("price") or 0) * (x[1].get("volume") or 0),
            reverse=True,
        )[:self.BACKTEST_TICKERS_LIMIT]

        logger.info(f"Calibration: Backtesting {len(liquid)} liquid tickers")

        # Collect all data points
        data_points = []  # (rsi_bucket, macd_dir, adx_bucket, vol_bucket, horizon, actual_move_pct, went_up)
        tickers_processed = 0

        for ticker, _ in liquid:
            try:
                bars = await fetcher.fetch_historical(ticker, self.BACKTEST_DAYS + 60)
                if not bars or len(bars) < 80:
                    continue

                closes = [b["close"] for b in bars]

                # For each day (with enough lookback for technicals + enough lookahead)
                for day_idx in range(50, len(bars) - 8):
                    sub_bars = bars[:day_idx + 1]
                    techs = LiveDataFetcher.compute_technicals(sub_bars)
                    if not techs:
                        continue

                    current_close = closes[day_idx]
                    if current_close <= 0:
                        continue

                    # Compute relative volume
                    vol_sma_20 = sum((b.get("volume") or 0) for b in sub_bars[-20:]) / 20 if len(sub_bars) >= 20 else 1
                    current_vol = bars[day_idx].get("volume") or 0
                    rel_vol = current_vol / vol_sma_20 if vol_sma_20 > 0 else 1.0

                    rsi_b = self._bucket_rsi(techs.rsi_14)
                    macd_dir = "positive" if techs.macd_line > 0 else "negative"
                    adx_b = self._bucket_adx(techs.adx_14)
                    vol_b = self._bucket_volume(rel_vol)

                    # Look ahead 3, 5, 8 trading days
                    for horizon in [3, 5, 8]:
                        future_idx = day_idx
                        trading_days_ahead = 0
                        while trading_days_ahead < horizon and future_idx + 1 < len(bars):
                            future_idx += 1
                            # Bars are already trading days only (no weekends in OHLCV data)
                            trading_days_ahead += 1

                        if trading_days_ahead < horizon:
                            continue

                        future_close = closes[future_idx]
                        move_pct = ((future_close - current_close) / current_close) * 100
                        went_up = 1 if future_close > current_close else 0

                        data_points.append((rsi_b, macd_dir, adx_b, vol_b, horizon, move_pct, went_up))

                tickers_processed += 1
                if tickers_processed % 10 == 0:
                    logger.info(f"Calibration: {tickers_processed}/{len(liquid)} tickers processed, {len(data_points)} data points")

                # Rate limit
                if tickers_processed % 5 == 0:
                    await asyncio.sleep(1)

            except Exception as e:
                logger.warning(f"Calibration: Failed to process {ticker}: {e}")

        logger.info(f"Calibration: Collected {len(data_points)} data points from {tickers_processed} tickers")

        if not data_points:
            return {"error": "No data points collected", "tickers_processed": 0}

        # Aggregate into base rates
        buckets: dict[tuple, list[tuple[float, int]]] = defaultdict(list)
        for rsi_b, macd_dir, adx_b, vol_b, horizon, move_pct, went_up in data_points:
            key = (rsi_b, macd_dir, adx_b, vol_b, horizon)
            buckets[key].append((move_pct, went_up))

        conn = sqlite3.connect(self.db_path)
        now = datetime.now(timezone.utc).isoformat()
        inserted = 0
        try:
            for (rsi_b, macd_dir, adx_b, vol_b, horizon), samples in buckets.items():
                if len(samples) < 3:
                    continue
                moves = [s[0] for s in samples]
                ups = [s[1] for s in samples]
                sorted_moves = sorted(moves)
                median = sorted_moves[len(sorted_moves) // 2]
                stddev = statistics.stdev(moves) if len(moves) >= 2 else 0

                conn.execute("""
                    INSERT OR REPLACE INTO calibration_base_rates
                    (rsi_bucket, macd_direction, adx_bucket, rel_volume_bucket, horizon_days,
                     sample_count, up_probability, avg_move_pct, median_move_pct, stddev_move_pct, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    rsi_b, macd_dir, adx_b, vol_b, horizon,
                    len(samples), sum(ups) / len(ups), sum(moves) / len(moves),
                    median, round(stddev, 4), now,
                ))
                inserted += 1

            conn.commit()
        finally:
            conn.close()

        elapsed = time.time() - start_time
        result = {
            "tickers_processed": tickers_processed,
            "data_points": len(data_points),
            "base_rate_buckets": inserted,
            "elapsed_seconds": round(elapsed, 1),
        }
        logger.info(f"Calibration: Backtest complete — {result}")
        return result

    def build_council_calibration(self):
        """Build calibration curve from Spike's own pick history.
        Fast — just SQLite queries. Call after each backfill_actuals()."""
        conn = sqlite3.connect(self.db_path)
        now = datetime.now(timezone.utc).isoformat()
        try:
            for horizon in [3, 5, 8]:
                rows = conn.execute("""
                    SELECT ph.consensus_score, ar.accurate
                    FROM pick_history ph
                    INNER JOIN accuracy_records ar ON ph.id = ar.pick_id
                    WHERE ar.accurate IS NOT NULL AND ar.horizon_days = ?
                """, (horizon,)).fetchall()

                if not rows:
                    continue

                buckets: dict[str, list[int]] = defaultdict(list)
                for score, accurate in rows:
                    bucket = self._bucket_confidence(score)
                    buckets[bucket].append(accurate)

                for bucket, accurates in buckets.items():
                    if len(accurates) < 2:
                        continue
                    conn.execute("""
                        INSERT OR REPLACE INTO calibration_council
                        (confidence_bucket, horizon_days, sample_count, actual_hit_rate,
                         avg_predicted_move, avg_actual_move, bias, updated_at)
                        VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
                    """, (
                        bucket, horizon, len(accurates),
                        sum(accurates) / len(accurates), now,
                    ))

            conn.commit()
            logger.info("Calibration: Council calibration curve updated")
        finally:
            conn.close()

    def apply_calibration(self, picks: list, payloads_map: dict) -> list:
        """Apply calibration data to each pick. Annotates with historical base rate
        and calibrated confidence. Non-destructive — adds fields, doesn't change scores."""
        conn = sqlite3.connect(self.db_path)
        try:
            # Check if we have any base rates
            base_count = conn.execute("SELECT COUNT(*) FROM calibration_base_rates").fetchone()[0]
            if base_count == 0:
                logger.info("Calibration: No base rates available yet — skipping")
                return picks

            council_count = conn.execute("SELECT COUNT(*) FROM calibration_council").fetchone()[0]

            for pick in picks:
                ticker = pick.ticker if hasattr(pick, 'ticker') else pick.get('ticker')
                payload = payloads_map.get(ticker)
                if not payload:
                    continue

                techs = payload.technicals if hasattr(payload, 'technicals') else None
                if not techs:
                    continue

                rsi = techs.rsi_14 if hasattr(techs, 'rsi_14') else techs.get('rsi_14', 50)
                macd = techs.macd_line if hasattr(techs, 'macd_line') else techs.get('macd_line', 0)
                adx = techs.adx_14 if hasattr(techs, 'adx_14') else techs.get('adx_14', 15)
                rel_vol = techs.relative_volume if hasattr(techs, 'relative_volume') else techs.get('relative_volume', 1.0)

                rsi_b = self._bucket_rsi(rsi)
                macd_dir = "positive" if macd > 0 else "negative"
                adx_b = self._bucket_adx(adx)
                vol_b = self._bucket_volume(rel_vol or 1.0)

                # Look up 3-day base rate (primary horizon)
                row = conn.execute("""
                    SELECT up_probability, sample_count, avg_move_pct
                    FROM calibration_base_rates
                    WHERE rsi_bucket = ? AND macd_direction = ? AND adx_bucket = ?
                      AND rel_volume_bucket = ? AND horizon_days = 3
                """, (rsi_b, macd_dir, adx_b, vol_b)).fetchone()

                if not row:
                    continue

                historical_base_rate = row[0]
                sample_count = row[1]
                avg_hist_move = row[2]

                # Council confidence (as 0-1)
                confidence = pick.consensus_score if hasattr(pick, 'consensus_score') else pick.get('consensus_score', 50)
                council_conf = confidence / 100.0

                # Look up council calibration if available
                council_hit_rate = None
                council_sample_count = 0
                if council_count > 0:
                    conf_bucket = self._bucket_confidence(confidence)
                    c_row = conn.execute("""
                        SELECT actual_hit_rate, sample_count
                        FROM calibration_council
                        WHERE confidence_bucket = ? AND horizon_days = 3
                    """, (conf_bucket,)).fetchone()
                    if c_row and c_row[1] >= self.MIN_COUNCIL_SAMPLES:
                        council_hit_rate = c_row[0]
                        council_sample_count = c_row[1]

                # Blend: weight by sample count
                if council_hit_rate is not None:
                    # Weighted blend — council-specific data gets more weight as it grows
                    total_samples = sample_count + council_sample_count * 10  # Council samples weighted 10x
                    calibrated = (
                        (historical_base_rate * sample_count + council_hit_rate * council_sample_count * 10)
                        / total_samples
                    )
                else:
                    calibrated = historical_base_rate

                overconfidence_flag = council_conf > calibrated + 0.10

                calibration_data = {
                    "historical_base_rate": round(historical_base_rate, 4),
                    "council_hit_rate": round(council_hit_rate, 4) if council_hit_rate is not None else None,
                    "calibrated_confidence": round(calibrated, 4),
                    "sample_count": sample_count,
                    "council_sample_count": council_sample_count,
                    "overconfidence_flag": overconfidence_flag,
                    "avg_historical_move": round(avg_hist_move, 2),
                }

                # Attach to pick
                if hasattr(pick, '__dict__'):
                    pick.calibration = calibration_data
                elif isinstance(pick, dict):
                    pick["calibration"] = calibration_data

            return picks
        finally:
            conn.close()

    def get_calibration_status(self) -> dict:
        """Return calibration engine status for admin display."""
        conn = sqlite3.connect(self.db_path)
        try:
            base_count = conn.execute("SELECT COUNT(*) FROM calibration_base_rates").fetchone()[0]
            base_samples = conn.execute("SELECT SUM(sample_count) FROM calibration_base_rates").fetchone()[0] or 0
            base_updated = conn.execute("SELECT MAX(updated_at) FROM calibration_base_rates").fetchone()[0]

            council_count = conn.execute("SELECT COUNT(*) FROM calibration_council").fetchone()[0]
            council_samples = conn.execute("SELECT SUM(sample_count) FROM calibration_council").fetchone()[0] or 0

            return {
                "base_rate_buckets": base_count,
                "base_rate_total_samples": base_samples,
                "base_rate_last_updated": base_updated,
                "council_calibration_buckets": council_count,
                "council_calibration_samples": council_samples,
            }
        finally:
            conn.close()


# ═══════════════════════════════════════════════════════════════════════════
# LEARNING ENGINE (Session 16)
# ═══════════════════════════════════════════════════════════════════════════


class LearningEngine:
    """
    Orchestrates all learning mechanisms. Each mechanism has:
    - An activation gate (minimum data required)
    - A compute method (returns adjustment values)
    - A state property (for admin panel visibility)
    """

    # Activation gates
    GATE_STAGE_WEIGHTS = 30          # resolved picks per stage, 20-day window
    GATE_PROMPT_CONTEXT = 10         # resolved picks, 15-day window
    GATE_SECTOR_SCORING = 0          # Bayesian — no hard gate
    GATE_CONVICTION_THRESHOLDS = 50  # total resolved picks
    GATE_DISAGREEMENT = 20           # disagreements with >15pt gap
    GATE_FACTOR_FEEDBACK = 100       # total resolved picks
    GATE_PREFILTER = 660             # total resolved picks across all horizons
    GATE_IV_EXPECTED_MOVE = 0        # always active when IV data available

    STAGE_WEIGHT_WINDOW_DAYS = 20    # rolling window for stage weights
    PROMPT_CONTEXT_WINDOW_DAYS = 15  # rolling window for prompt context
    BAYESIAN_PRIOR_STRENGTH = 15     # shrinkage denominator for sector scoring
    DISAGREEMENT_THRESHOLD = 15      # minimum score gap to count as disagreement

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._state_cache: dict = {}

    def get_mechanism_states(self) -> list[dict]:
        """Return activation status of all 8 mechanisms for admin panel."""
        conn = sqlite3.connect(self.db_path)
        states = []

        try:
            # 1. Dynamic stage weights
            stage1_count = 0
            for stage in [1, 2, 3, 4]:
                count = conn.execute(
                    "SELECT COUNT(*) FROM accuracy_records ar "
                    "JOIN pick_history ph ON ar.pick_id = ph.id "
                    "JOIN stage_scores ss ON ss.pick_id = ph.id AND ss.stage = ? "
                    "WHERE ar.accurate IS NOT NULL "
                    "AND ph.run_date >= date('now', ?)",
                    (stage, f'-{self.STAGE_WEIGHT_WINDOW_DAYS} days')
                ).fetchone()[0]
                if stage == 1:
                    stage1_count = count
            states.append({
                'name': 'Dynamic Stage Weights',
                'active': stage1_count >= self.GATE_STAGE_WEIGHTS,
                'progress': min(stage1_count, self.GATE_STAGE_WEIGHTS),
                'gate': self.GATE_STAGE_WEIGHTS,
            })

            # 2. Prompt accuracy context
            prompt_count = conn.execute(
                "SELECT COUNT(*) FROM accuracy_records "
                "WHERE accurate IS NOT NULL AND checked_at >= date('now', ?)",
                (f'-{self.PROMPT_CONTEXT_WINDOW_DAYS} days',)
            ).fetchone()[0]
            states.append({
                'name': 'Prompt Accuracy Context',
                'active': prompt_count >= self.GATE_PROMPT_CONTEXT,
                'progress': min(prompt_count, self.GATE_PROMPT_CONTEXT),
                'gate': self.GATE_PROMPT_CONTEXT,
            })

            # 3. Sector scoring (always active — Bayesian)
            states.append({
                'name': 'Sector-Aware Scoring',
                'active': True,
                'progress': 'Bayesian (always active)',
                'gate': 0,
            })

            # 4. Conviction thresholds
            total_resolved = conn.execute(
                "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
            ).fetchone()[0]
            states.append({
                'name': 'Adaptive Conviction Thresholds',
                'active': total_resolved >= self.GATE_CONVICTION_THRESHOLDS,
                'progress': min(total_resolved, self.GATE_CONVICTION_THRESHOLDS),
                'gate': self.GATE_CONVICTION_THRESHOLDS,
            })

            # 5. Stage disagreement learning
            disagreements = conn.execute(
                "SELECT COUNT(*) FROM stage_scores s1 "
                "JOIN stage_scores s2 ON s1.pick_id = s2.pick_id AND s1.stage < s2.stage "
                "WHERE ABS(s1.total_score - s2.total_score) > ?",
                (self.DISAGREEMENT_THRESHOLD,)
            ).fetchone()[0]
            states.append({
                'name': 'Stage Disagreement Learning',
                'active': disagreements >= self.GATE_DISAGREEMENT,
                'progress': min(disagreements, self.GATE_DISAGREEMENT),
                'gate': self.GATE_DISAGREEMENT,
            })

            # 6. Factor-level feedback
            states.append({
                'name': 'Factor-Level Feedback',
                'active': total_resolved >= self.GATE_FACTOR_FEEDBACK,
                'progress': min(total_resolved, self.GATE_FACTOR_FEEDBACK),
                'gate': self.GATE_FACTOR_FEEDBACK,
            })

            # 7. Adaptive pre-filter
            total_all_horizons = conn.execute(
                "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
            ).fetchone()[0]
            states.append({
                'name': 'Adaptive Pre-Filter',
                'active': total_all_horizons >= self.GATE_PREFILTER,
                'progress': min(total_all_horizons, self.GATE_PREFILTER),
                'gate': self.GATE_PREFILTER,
            })

            # 8. IV Expected Move
            states.append({
                'name': 'IV Expected Move',
                'active': True,
                'progress': 'Always active (when IV data available)',
                'gate': 0,
            })
        finally:
            conn.close()

        return states

    def compute_stage_weights(self) -> dict[int, float]:
        """
        Compute stage weights based on recent directional accuracy.
        Returns {1: w1, 2: w2, 3: w3, 4: w4} normalized to sum to 1.0.
        Falls back to hardcoded {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35} if gate not met.
        """
        DEFAULT = {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
        conn = sqlite3.connect(self.db_path)

        try:
            hit_rates = {}
            for stage in [1, 2, 3, 4]:
                rows = conn.execute(
                    "SELECT ar.accurate FROM accuracy_records ar "
                    "JOIN pick_history ph ON ar.pick_id = ph.id "
                    "JOIN stage_scores ss ON ss.pick_id = ph.id AND ss.stage = ? "
                    "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
                    "AND ph.run_date >= date('now', ?)",
                    (stage, f'-{self.STAGE_WEIGHT_WINDOW_DAYS} days')
                ).fetchall()
                if len(rows) < self.GATE_STAGE_WEIGHTS:
                    return DEFAULT
                hit_rates[stage] = sum(r[0] for r in rows) / len(rows)
        finally:
            conn.close()

        # Convert hit rates to weights: higher accuracy = higher weight
        total = sum(hit_rates.values())
        if total == 0:
            return DEFAULT
        weights = {s: r / total for s, r in hit_rates.items()}

        # Floor at 0.05 to prevent any stage from being completely ignored
        for s in weights:
            weights[s] = max(weights[s], 0.05)
        # Re-normalize
        total = sum(weights.values())
        weights = {s: w / total for s, w in weights.items()}

        return weights

    def build_prompt_context(self, stage: int) -> str:
        """
        Build accuracy feedback paragraph for injection into LLM stage prompts.
        Returns empty string if gate not met.
        """
        conn = sqlite3.connect(self.db_path)

        try:
            rows = conn.execute(
                "SELECT ar.accurate, ar.predicted_move_pct, ar.actual_move_pct "
                "FROM accuracy_records ar "
                "JOIN pick_history ph ON ar.pick_id = ph.id "
                "JOIN stage_scores ss ON ss.pick_id = ph.id AND ss.stage = ? "
                "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
                "AND ph.run_date >= date('now', ?)",
                (stage, f'-{self.PROMPT_CONTEXT_WINDOW_DAYS} days')
            ).fetchall()

            if len(rows) < self.GATE_PROMPT_CONTEXT:
                return ""

            total = len(rows)
            correct = sum(1 for r in rows if r[0] == 1)
            hit_rate = correct / total
            avg_predicted = sum(r[1] or 0 for r in rows) / total
            avg_actual = sum(r[2] or 0 for r in rows) / total
            bias = avg_predicted - avg_actual
        finally:
            conn.close()

        direction = "overestimating" if bias > 0.5 else "underestimating" if bias < -0.5 else "roughly calibrated on"

        return (
            f"\n\nRECENT PERFORMANCE FEEDBACK (last {self.PROMPT_CONTEXT_WINDOW_DAYS} days):\n"
            f"Your UP picks had {hit_rate:.0%} directional accuracy ({correct}/{total} correct at 3-day horizon).\n"
            f"Average predicted move: {avg_predicted:+.2f}%. Average actual move: {avg_actual:+.2f}%.\n"
            f"You are {direction} move magnitudes (bias: {bias:+.2f}%).\n"
            f"Adjust your confidence and predicted moves accordingly. Be more selective — only pick stocks "
            f"where you have genuine conviction they will move UP.\n"
        )

    def compute_sector_multiplier(self, sector: str) -> float:
        """
        Bayesian shrinkage sector multiplier.
        Blends sector-specific hit rate with global hit rate.
        Returns multiplier centered on 1.0 (0.85 - 1.15 range).
        """
        conn = sqlite3.connect(self.db_path)

        try:
            # Global hit rate
            global_row = conn.execute(
                "SELECT COUNT(*), SUM(accurate) FROM accuracy_records "
                "WHERE accurate IS NOT NULL AND horizon_days = 3"
            ).fetchone()
            if not global_row[0] or global_row[0] == 0:
                return 1.0
            global_rate = global_row[1] / global_row[0]

            # Sector hit rate
            sector_row = conn.execute(
                "SELECT COUNT(*), SUM(ar.accurate) FROM accuracy_records ar "
                "JOIN pick_history ph ON ar.pick_id = ph.id "
                "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
                "AND ph.sector = ?",
                (sector,)
            ).fetchone()
            sector_count = sector_row[0] or 0
            sector_correct = sector_row[1] or 0
        finally:
            conn.close()

        if sector_count == 0:
            return 1.0

        sector_rate = sector_correct / sector_count

        # Bayesian shrinkage: blend toward global mean
        weight = sector_count / (sector_count + self.BAYESIAN_PRIOR_STRENGTH)
        blended_rate = weight * sector_rate + (1 - weight) * global_rate

        # Convert to multiplier: 50% hit rate = 1.0, each 10% above/below = +/-0.15
        multiplier = 1.0 + (blended_rate - 0.5) * 1.5
        return max(0.85, min(1.15, multiplier))

    def compute_conviction_thresholds(self) -> tuple[float, float]:
        """
        Compute data-driven HIGH/MEDIUM thresholds based on score-vs-accuracy curve.
        Returns (high_threshold, medium_threshold).
        Falls back to (80, 65) if gate not met.
        """
        DEFAULT = (80.0, 65.0)
        conn = sqlite3.connect(self.db_path)

        try:
            total = conn.execute(
                "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL AND horizon_days = 3"
            ).fetchone()[0]

            if total < self.GATE_CONVICTION_THRESHOLDS:
                return DEFAULT

            # Get score buckets with hit rates (5-point buckets)
            rows = conn.execute(
                "SELECT CAST(ph.consensus_score / 5 AS INTEGER) * 5 as bucket, "
                "COUNT(*) as n, SUM(ar.accurate) as correct "
                "FROM accuracy_records ar "
                "JOIN pick_history ph ON ar.pick_id = ph.id "
                "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
                "GROUP BY bucket ORDER BY bucket DESC"
            ).fetchall()
        finally:
            conn.close()

        if not rows:
            return DEFAULT

        # Find highest score bucket where hit rate > 55% with >= 5 samples
        high_threshold = 80.0
        medium_threshold = 65.0

        for bucket, n, correct in rows:
            if n >= 5:
                rate = correct / n
                if rate >= 0.55 and bucket < high_threshold:
                    high_threshold = float(bucket)
                if rate >= 0.50 and bucket < medium_threshold:
                    medium_threshold = float(bucket)

        # Ensure HIGH > MEDIUM
        if high_threshold <= medium_threshold:
            medium_threshold = high_threshold - 10

        return (max(high_threshold, 60.0), max(medium_threshold, 50.0))

    def compute_disagreement_adjustment(self, stage_scores: dict[int, float]) -> float:
        """
        When stages disagree by >15 points, adjust consensus based on which stage
        is historically more accurate in disagreements.
        Returns adjustment multiplier (0.9 - 1.1).
        """
        conn = sqlite3.connect(self.db_path)

        try:
            # Check gate
            total_disagreements = conn.execute(
                "SELECT COUNT(*) FROM stage_scores s1 "
                "JOIN stage_scores s2 ON s1.pick_id = s2.pick_id AND s1.stage < s2.stage "
                "WHERE ABS(s1.total_score - s2.total_score) > ?",
                (self.DISAGREEMENT_THRESHOLD,)
            ).fetchone()[0]

            if total_disagreements < self.GATE_DISAGREEMENT:
                return 1.0

            # Find which pairs disagree in current pick
            disagreeing_pairs = []
            stages = sorted(stage_scores.keys())
            for i, s1 in enumerate(stages):
                for s2 in stages[i+1:]:
                    if abs(stage_scores[s1] - stage_scores[s2]) > self.DISAGREEMENT_THRESHOLD:
                        disagreeing_pairs.append((s1, s2))

            if not disagreeing_pairs:
                return 1.0

            # For each disagreeing pair, check who's historically right
            adjustments = []
            for s1, s2 in disagreeing_pairs:
                higher_stage = s1 if stage_scores[s1] > stage_scores[s2] else s2
                lower_stage = s2 if higher_stage == s1 else s1

                higher_wins = conn.execute(
                    "SELECT COUNT(*) FROM stage_scores ss1 "
                    "JOIN stage_scores ss2 ON ss1.pick_id = ss2.pick_id "
                    "JOIN accuracy_records ar ON ar.pick_id = ss1.pick_id "
                    "WHERE ss1.stage = ? AND ss2.stage = ? "
                    "AND ABS(ss1.total_score - ss2.total_score) > ? "
                    "AND ss1.total_score > ss2.total_score "
                    "AND ar.accurate = 1 AND ar.horizon_days = 3",
                    (higher_stage, lower_stage, self.DISAGREEMENT_THRESHOLD)
                ).fetchone()[0]

                total_cases = conn.execute(
                    "SELECT COUNT(*) FROM stage_scores ss1 "
                    "JOIN stage_scores ss2 ON ss1.pick_id = ss2.pick_id "
                    "JOIN accuracy_records ar ON ar.pick_id = ss1.pick_id "
                    "WHERE ss1.stage = ? AND ss2.stage = ? "
                    "AND ABS(ss1.total_score - ss2.total_score) > ? "
                    "AND ss1.total_score > ss2.total_score "
                    "AND ar.accurate IS NOT NULL AND ar.horizon_days = 3",
                    (higher_stage, lower_stage, self.DISAGREEMENT_THRESHOLD)
                ).fetchone()[0]

                if total_cases >= 5:
                    bullish_accuracy = higher_wins / total_cases
                    adj = 1.0 + (bullish_accuracy - 0.5) * 0.2  # +-10% max
                    adjustments.append(adj)
        finally:
            conn.close()

        if not adjustments:
            return 1.0

        return sum(adjustments) / len(adjustments)

    def compute_factor_weights(self) -> dict[str, float] | None:
        """
        Compute correlation-based weights for the 5 scoring sub-factors.
        Uses Spearman rank correlation between each factor and actual 3-day returns.
        Returns {factor_name: weight} normalized to sum to 1.0, or None if gate not met.
        """
        conn = sqlite3.connect(self.db_path)

        try:
            total = conn.execute(
                "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL AND horizon_days = 3"
            ).fetchone()[0]

            if total < self.GATE_FACTOR_FEEDBACK:
                return None

            # Get factor scores + actual returns
            rows = conn.execute(
                "SELECT ss.technical_momentum, ss.sentiment_catalysts, "
                "ss.options_volatility, ss.risk_reward, ss.conviction, "
                "ar.actual_move_pct "
                "FROM stage_scores ss "
                "JOIN accuracy_records ar ON ar.pick_id = ss.pick_id "
                "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
                "AND ss.stage = 4 "
                "AND ss.technical_momentum IS NOT NULL "
                "AND ar.actual_move_pct IS NOT NULL"
            ).fetchall()
        finally:
            conn.close()

        if len(rows) < self.GATE_FACTOR_FEEDBACK:
            return None

        from scipy.stats import spearmanr

        factors = ['technical_momentum', 'sentiment_catalysts', 'options_volatility',
                   'risk_reward', 'conviction']
        actual_returns = [r[5] for r in rows]

        correlations = {}
        for i, factor in enumerate(factors):
            factor_values = [r[i] for r in rows]
            corr, pvalue = spearmanr(factor_values, actual_returns)
            # Only count positive correlations (factor predicts UP correctly)
            correlations[factor] = max(corr, 0.05)  # Floor at 0.05

        # Normalize to weights summing to 1.0
        total_corr = sum(correlations.values())
        weights = {f: c / total_corr for f, c in correlations.items()}

        return weights

    def compute_prefilter_adjustments(self) -> dict | None:
        """
        Analyze which RSI/ADX/volume ranges historically produce winning picks.
        Returns adjusted ideal ranges or None if gate not met.
        """
        conn = sqlite3.connect(self.db_path)

        try:
            total = conn.execute(
                "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
            ).fetchone()[0]

            if total < self.GATE_PREFILTER:
                return None

            # Analyze winning picks' technical characteristics
            rows = conn.execute(
                "SELECT rsi_bucket, adx_bucket, rel_volume_bucket, up_probability, sample_count "
                "FROM calibration_base_rates WHERE horizon_days = 3 AND sample_count >= 10"
            ).fetchall()
        finally:
            conn.close()

        if not rows:
            return None

        # Find RSI range with best up_probability
        best_rsi_buckets = sorted(
            [(r[0], r[3], r[4]) for r in rows],
            key=lambda x: x[1], reverse=True
        )[:3]

        # Find ADX range with best up_probability
        adx_map: dict[str, dict] = {}
        for r in rows:
            adx_b = r[1]
            if adx_b not in adx_map:
                adx_map[adx_b] = {'total_prob': 0, 'total_samples': 0}
            adx_map[adx_b]['total_prob'] += r[3] * r[4]
            adx_map[adx_b]['total_samples'] += r[4]

        best_adx = {k: v['total_prob'] / v['total_samples']
                    for k, v in adx_map.items() if v['total_samples'] >= 20}

        return {
            'best_rsi_buckets': best_rsi_buckets,
            'best_adx_ranges': best_adx,
        }


# ═══════════════════════════════════════════════════════════════════════════
# RISK PORTFOLIO ENGINE (Session 4)
# ═══════════════════════════════════════════════════════════════════════════


class RiskPortfolioEngine:
    """Dynamic volatility-adjusted position sizing with ATR-based stops.
    Enforces 1-2% risk per name and 30% total heat cap."""

    DEFAULT_PORTFOLIO_VALUE = 100_000.0  # $100K default portfolio
    MAX_RISK_PER_TRADE_PCT = 2.0        # 2% max risk per position
    MIN_RISK_PER_TRADE_PCT = 1.0        # 1% min risk per position
    TOTAL_HEAT_CAP_PCT = 30.0           # 30% max total exposure at risk
    ATR_STOP_MULTIPLIER = 2.0           # Stop loss = entry - 2x ATR

    def __init__(self, portfolio_value: float = DEFAULT_PORTFOLIO_VALUE):
        self.portfolio_value = portfolio_value

    def compute_allocations(
        self,
        picks: list[FinalHotPick],
        payloads: dict[str, "StockDataPayload"],
    ) -> RiskSummary:
        """Compute position sizing for each pick.
        Higher conviction = larger allocation (up to 2% risk).
        Lower conviction = smaller allocation (1% risk).
        Enforces 30% total heat cap."""

        allocations: list[AllocationEntry] = []
        total_heat_dollars = 0.0
        heat_cap_dollars = self.portfolio_value * (self.TOTAL_HEAT_CAP_PCT / 100)

        for pick in picks:
            payload = payloads.get(pick.ticker)
            if not payload:
                continue

            entry_price = pick.price
            if entry_price <= 0:
                continue

            # Determine ATR for stop loss
            atr = payload.technicals.atr_14 if payload.technicals else entry_price * 0.02
            if atr <= 0:
                atr = entry_price * 0.02  # 2% fallback

            # Stop loss: 2x ATR below entry
            stop_loss = round(entry_price - (self.ATR_STOP_MULTIPLIER * atr), 2)
            if stop_loss <= 0:
                stop_loss = round(entry_price * 0.90, 2)  # 10% max stop

            dollar_risk_per_share = entry_price - stop_loss
            if dollar_risk_per_share <= 0:
                continue

            # Risk budget based on conviction tier
            if pick.conviction_tier == ConvictionTier.HIGH:
                risk_pct = self.MAX_RISK_PER_TRADE_PCT
            elif pick.conviction_tier == ConvictionTier.MEDIUM:
                risk_pct = (self.MAX_RISK_PER_TRADE_PCT + self.MIN_RISK_PER_TRADE_PCT) / 2
            else:
                risk_pct = self.MIN_RISK_PER_TRADE_PCT

            risk_budget = self.portfolio_value * (risk_pct / 100)

            # Check total heat cap
            if total_heat_dollars + risk_budget > heat_cap_dollars:
                # Reduce this position to fit remaining cap
                remaining = heat_cap_dollars - total_heat_dollars
                if remaining <= 0:
                    logger.info(
                        f"RiskPortfolioEngine: Heat cap reached at {pick.ticker} "
                        f"(rank #{pick.rank}) — skipping remaining picks"
                    )
                    break
                risk_budget = remaining

            # Position size
            shares = max(1, int(risk_budget / dollar_risk_per_share))
            actual_dollar_risk = shares * dollar_risk_per_share
            position_value = shares * entry_price
            position_pct = (position_value / self.portfolio_value) * 100

            total_heat_dollars += actual_dollar_risk

            allocations.append(AllocationEntry(
                ticker=pick.ticker,
                shares=shares,
                entry_price=entry_price,
                stop_loss=stop_loss,
                dollar_risk=round(actual_dollar_risk, 2),
                position_pct=round(position_pct, 2),
            ))

        total_heat_pct = (total_heat_dollars / self.portfolio_value) * 100 if self.portfolio_value > 0 else 0
        max_pos_pct = max((a.position_pct for a in allocations), default=0)
        avg_risk = (
            sum(a.dollar_risk for a in allocations) / len(allocations) / self.portfolio_value * 100
            if allocations else 0
        )

        summary = RiskSummary(
            total_positions=len(allocations),
            total_heat_pct=round(total_heat_pct, 2),
            max_single_position_pct=round(max_pos_pct, 2),
            avg_risk_per_trade_pct=round(avg_risk, 4),
            allocation_table=allocations,
        )

        logger.info(
            f"RiskPortfolioEngine: {summary.total_positions} positions, "
            f"{summary.total_heat_pct}% heat, max position {summary.max_single_position_pct}%"
        )
        return summary


# ═══════════════════════════════════════════════════════════════════════════
# COMPOUNDING ROADMAP ENGINE (Session 4)
# ═══════════════════════════════════════════════════════════════════════════


class CompoundingRoadmapEngine:
    """Generates a 10-trading-day rolling roadmap from 3/5/8-day forecasts.
    Maintains persistent portfolio state via SQLite."""

    def __init__(self, db_path: str = DB_PATH, portfolio_value: float = 100_000.0):
        self.db_path = db_path
        self.portfolio_value = portfolio_value
        self._init_db()

    def _init_db(self):
        """Create portfolio state table if needed."""
        conn = sqlite3.connect(self.db_path)
        try:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS portfolio_state (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    as_of_date TEXT NOT NULL,
                    portfolio_value REAL NOT NULL,
                    positions_json TEXT NOT NULL DEFAULT '[]',
                    notes TEXT DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS roadmap_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_date TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    roadmap_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE INDEX IF NOT EXISTS idx_portfolio_state_date
                    ON portfolio_state(as_of_date);
            """)
            conn.commit()
        finally:
            conn.close()

    def _get_latest_portfolio_value(self) -> float:
        """Get the most recent portfolio value, or default."""
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute("""
                SELECT portfolio_value FROM portfolio_state
                ORDER BY as_of_date DESC, id DESC LIMIT 1
            """).fetchone()
            return row[0] if row else self.portfolio_value
        finally:
            conn.close()

    def _save_portfolio_state(self, value: float, positions: list[dict], notes: str = ""):
        """Persist current portfolio state."""
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute("""
                INSERT INTO portfolio_state (as_of_date, portfolio_value, positions_json, notes)
                VALUES (?, ?, ?, ?)
            """, (
                date.today().isoformat(),
                value,
                json.dumps(positions, default=str),
                notes,
            ))
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _next_trading_days(start: date, count: int) -> list[date]:
        """Generate next N trading days (skip weekends)."""
        days = []
        current = start
        while len(days) < count:
            current += timedelta(days=1)
            # Skip weekends (5=Saturday, 6=Sunday)
            if current.weekday() < 5:
                days.append(current)
        return days

    def generate_roadmap(
        self,
        picks: list[FinalHotPick],
        allocations: Optional[RiskSummary] = None,
        run_id: str = "",
    ) -> DailyRoadmap:
        """Generate a 10-trading-day rolling roadmap from forecasts.

        Uses 3/5/8-day forecasts as foundation:
        - Days 1-3: based on 3-day forecast (highest confidence)
        - Days 4-5: based on 5-day forecast (medium confidence)
        - Days 6-8: based on 8-day forecast (lower confidence)
        - Days 9-10: extrapolated with widened confidence bands

        Projects conservative compounded growth with √time confidence bands.
        """
        starting_value = self._get_latest_portfolio_value()
        trading_days = self._next_trading_days(date.today(), 10)

        # Aggregate forecast data from picks
        # Weighted by consensus score: higher-scored picks influence roadmap more
        total_weight = sum(p.consensus_score for p in picks) or 1.0
        weighted_3d_move = 0.0
        weighted_5d_move = 0.0
        weighted_8d_move = 0.0
        weighted_3d_prob = 0.0
        weighted_5d_prob = 0.0
        weighted_8d_prob = 0.0

        for pick in picks:
            w = pick.consensus_score / total_weight
            for f in pick.forecasts:
                if isinstance(f, dict):
                    h, move, prob = f.get("horizon_days"), f.get("most_likely_move_pct", 0), f.get("direction_probability", 0.5)
                    direction = f.get("predicted_direction", "UP")
                else:
                    h, move, prob = f.horizon_days, f.most_likely_move_pct, f.direction_probability
                    direction = f.predicted_direction
                # Adjust move sign for DOWN predictions
                signed_move = move if direction == "UP" else -move
                if h == 3:
                    weighted_3d_move += signed_move * w
                    weighted_3d_prob += prob * w
                elif h == 5:
                    weighted_5d_move += signed_move * w
                    weighted_5d_prob += prob * w
                elif h == 8:
                    weighted_8d_move += signed_move * w
                    weighted_8d_prob += prob * w

        # Daily expected move (conservative: use expectancy = prob * move)
        daily_3d = (weighted_3d_move * weighted_3d_prob) / 3 if weighted_3d_prob > 0 else 0
        daily_5d = (weighted_5d_move * weighted_5d_prob) / 5 if weighted_5d_prob > 0 else 0
        daily_8d = (weighted_8d_move * weighted_8d_prob) / 8 if weighted_8d_prob > 0 else 0

        # Base daily volatility estimate (using typical ATR/price ratio)
        avg_atr_pct = 0.0
        atr_count = 0
        for pick in picks:
            if pick.technicals and pick.technicals.atr_14 > 0 and pick.price > 0:
                avg_atr_pct += (pick.technicals.atr_14 / pick.price) * 100
                atr_count += 1
        daily_vol = (avg_atr_pct / atr_count) if atr_count > 0 else 1.5  # Default 1.5%

        entries: list[RoadmapEntry] = []
        current_value = starting_value

        for i, day in enumerate(trading_days):
            day_num = i + 1

            # Select daily expected return based on forecast horizon
            if day_num <= 3:
                daily_return = daily_3d
                action = "HOLD" if day_num > 1 else "ENTER"
                horizon_label = "3d forecast"
            elif day_num <= 5:
                daily_return = daily_5d
                action = "HOLD"
                horizon_label = "5d forecast"
            elif day_num <= 8:
                daily_return = daily_8d
                action = "HOLD" if day_num < 8 else "ROTATE"
                horizon_label = "8d forecast"
            else:
                daily_return = daily_8d * 0.5  # Reduced confidence extrapolation
                action = "ROTATE" if day_num == 10 else "HOLD"
                horizon_label = "extrapolated"

            # Compound the portfolio
            current_value *= (1 + daily_return / 100)

            # Confidence bands: widen with √time
            # Band = portfolio_value ± (daily_vol * √day_num * portfolio_allocation_pct)
            # Use allocation pct from risk engine if available
            alloc_pct = 30.0  # Default to heat cap
            if allocations:
                alloc_pct = allocations.total_heat_pct or 30.0

            band_width = (daily_vol / 100) * math.sqrt(day_num) * (alloc_pct / 100)
            confidence_low = current_value * (1 - band_width)
            confidence_high = current_value * (1 + band_width)

            # Determine tickers involved
            if day_num == 1:
                tickers_involved = [p.ticker for p in picks[:10]]  # Top 10 entries
                notes = f"Enter top positions based on {horizon_label}"
            elif action == "ROTATE":
                tickers_involved = [p.ticker for p in picks[-5:]]
                notes = f"Review positions for rotation ({horizon_label})"
            else:
                tickers_involved = []
                notes = f"Hold positions, monitoring {horizon_label}"

            entries.append(RoadmapEntry(
                date=day,
                day_number=day_num,
                action=action,
                tickers_involved=tickers_involved,
                projected_portfolio_value=round(current_value, 2),
                confidence_band_low=round(confidence_low, 2),
                confidence_band_high=round(confidence_high, 2),
                notes=notes,
            ))

        roadmap = DailyRoadmap(
            starting_portfolio_value=round(starting_value, 2),
            entries=entries,
        )

        # Persist state
        positions = [
            {"ticker": p.ticker, "shares": 0, "entry_price": p.price}
            for p in picks[:10]
        ]
        self._save_portfolio_state(
            starting_value,
            positions,
            f"Roadmap generated for run {run_id}"
        )

        # Save roadmap to history
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute("""
                INSERT INTO roadmap_history (run_date, run_id, roadmap_json)
                VALUES (?, ?, ?)
            """, (
                date.today().isoformat(),
                run_id,
                json.dumps(roadmap.model_dump(mode="json"), default=str),
            ))
            conn.commit()
        finally:
            conn.close()

        logger.info(
            f"CompoundingRoadmapEngine: Generated 10-day roadmap "
            f"starting at ${starting_value:,.2f}, "
            f"projected to ${current_value:,.2f}"
        )
        return roadmap


# ═══════════════════════════════════════════════════════════════════════════
# PUBLIC INTERFACE (Session 3: full pipeline, Session 4 adds persistence)
# ═══════════════════════════════════════════════════════════════════════════

class CanadianStockCouncilBrain:
    """Main entry point for the LLM Council."""

    def __init__(
        self,
        anthropic_api_key: str | None = None,
        xai_api_key: str | None = None,
        fmp_api_key: str | None = None,
    ):
        self.fmp_key = fmp_api_key or os.environ.get("FMP_API_KEY", "")
        self.anthropic_key = anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self.xai_key = xai_api_key or os.environ.get("XAI_API_KEY", "")

        self.fetcher = LiveDataFetcher(self.fmp_key)
        self.regime_filter = MacroRegimeFilter()
        self.historical_analyzer = HistoricalPerformanceAnalyzer()
        self.calibration_engine = HistoricalCalibrationEngine()
        self.learning_engine = LearningEngine(db_path=DB_PATH)
        self.risk_engine = RiskPortfolioEngine()
        self.roadmap_engine = CompoundingRoadmapEngine()

    async def run_council(
        self,
        starting_universe: list[str] | None = None,
        max_workers: int = 8,
        tracker=None,
    ) -> dict:
        """Run the full 4-stage council pipeline.

        Flow:
          1. Fetch macro context + detect regime
          2. Fetch universe (or use provided list)
          3. Fetch quotes → liquidity filter ($5M ADV, >$1 price)
          4. Build payloads (parallel: historical + news + sentiment)
          5. Stage 1 — Sonnet screens to Top 100
          6. Stage 2 — Gemini re-scores to Top 80
          7. Stage 3 — Opus challenges to Top 40
          8. Stage 4 — Grok final Top 10 with probabilistic forecasts
          9. Fact-check Stage 4 output
          10. Build consensus + conviction tiering
          11. Return CouncilResult
        """
        run_start = time.time()
        run_id = hashlib.md5(
            f"{datetime.now(timezone.utc).isoformat()}".encode()
        ).hexdigest()[:12]
        logger.info(f"=== Council Run {run_id} started ===")

        # Log learning mechanism states
        try:
            states = self.learning_engine.get_mechanism_states()
            active = [s['name'] for s in states if s['active']]
            waiting = [s['name'] for s in states if not s['active']]
            logger.info(f"Learning mechanisms active: {active}")
            logger.info(f"Learning mechanisms waiting: {waiting}")
        except Exception as e:
            logger.warning(f"Could not read learning states: {e}")

        try:
            # ── Step 1: Macro context ──
            logger.info("Step 1: Fetching macro context")
            macro = await self.fetcher.fetch_macro_context()
            macro = self.regime_filter.apply_regime(macro)
            regime = macro.regime
            logger.info(f"Macro regime: {regime}")

            # ── Step 2: Universe ──
            if starting_universe:
                universe = starting_universe
                logger.info(f"Step 2: Using provided universe of {len(universe)} tickers")
            else:
                logger.info("Step 2: Fetching TSX universe")
                universe = await self.fetcher.fetch_tsx_universe()
                logger.info(f"Step 2: Fetched {len(universe)} TSX tickers")

            if not universe:
                raise RuntimeError("Empty universe — no tickers to analyze")

            # ── Step 3: Quotes + Liquidity filter ──
            logger.info(f"Step 3: Fetching quotes for {len(universe)} tickers")
            quotes = await self.fetcher.fetch_quotes(universe)
            logger.info(f"Step 3: Got {len(quotes)} quotes")

            # Pre-filter: price > $1 and volume > 0 (cheap filter, no API calls)
            # Read minimum ADV threshold from CouncilConfig (set via admin panel Council tab)
            MIN_ADV_DOLLARS = _read_council_config_min_adv(default=5_000_000)
            MIN_PRICE = 1.0
            price_filtered = []
            for ticker, q in quotes.items():
                price = q.get("price")
                if price is None or price <= MIN_PRICE:
                    continue
                vol = q.get("volume", 0) or 0
                # Quick volume heuristic: if today's dollar volume > $1M, worth checking
                if price * vol > 1_000_000:
                    price_filtered.append(ticker)

            logger.info(
                f"Step 3: {len(price_filtered)} tickers pass price+volume pre-filter "
                f"(from {len(quotes)} quoted)"
            )

            # Fetch profiles from bulk cache (much fewer API calls than per-ticker)
            profiles = await fmp_bulk_cache.get_profiles(price_filtered, self.fmp_key)

            # ETF + ghost ticker filter using bulk cache whitelist
            tsx_whitelist = await fmp_bulk_cache.get_tsx_whitelist(self.fmp_key)
            whitelisted = [t for t in price_filtered if t in tsx_whitelist]
            etf_removed = len(price_filtered) - len(whitelisted)
            if etf_removed > 0:
                logger.info(f"Step 3: Removed {etf_removed} ETFs/ghost tickers via bulk cache whitelist")
            price_filtered = whitelisted

            # Full liquidity filter: ADV >= MIN_ADV_DOLLARS (configured via admin panel, default $5M)
            liquid_tickers = []
            for ticker in price_filtered:
                q = quotes.get(ticker)
                if not q:
                    continue
                price = q.get("price")
                if price is None:
                    continue
                profile = profiles.get(ticker, {})
                avg_vol = float(profile.get("averageVolume", 0) or 0)
                # Fallback: use today's volume if no profile
                if avg_vol == 0:
                    avg_vol = float(q.get("volume", 0) or 0)
                adv = price * avg_vol
                if adv >= MIN_ADV_DOLLARS:
                    liquid_tickers.append(ticker)

            logger.info(
                f"Step 3: {len(liquid_tickers)} tickers pass liquidity filter "
                f"(from {len(price_filtered)} price-filtered, ADV >= ${MIN_ADV_DOLLARS/1e6:.0f}M)"
            )

            if not liquid_tickers:
                raise RuntimeError("No tickers pass liquidity filter")

            # ── Step 4: Build payloads ──
            logger.info(f"Step 4: Building payloads for {len(liquid_tickers)} tickers")
            sem = asyncio.Semaphore(max_workers)
            payloads_list: list[StockDataPayload] = []

            async def _build_one(ticker: str):
                async with sem:
                    q = quotes.get(ticker)
                    if not q:
                        return
                    bars = await self.fetcher.fetch_historical(ticker, 90)
                    profile = profiles.get(ticker)
                    payload = await self.fetcher.build_payload(
                        ticker, q, bars, macro=macro, profile=profile
                    )
                    if payload:
                        payloads_list.append(payload)

            await asyncio.gather(*[_build_one(t) for t in liquid_tickers])
            logger.info(f"Step 4: Built {len(payloads_list)} valid payloads")

            if not payloads_list:
                raise RuntimeError("No valid payloads built")

            # ── Step 4b: Noise filter (historical accuracy) ──
            logger.info("Step 4b: Applying historical noise filter")
            clean_tickers = self.historical_analyzer.noise_filter(
                [p.ticker for p in payloads_list]
            )
            if len(clean_tickers) < len(payloads_list):
                payloads_list = [p for p in payloads_list if p.ticker in set(clean_tickers)]
                logger.info(f"Step 4b: {len(payloads_list)} tickers after noise filter")

            # ── Step 4c: Technical pre-filter (reduce universe before LLM stages) ──
            if tracker:
                tracker.start_stage("pre_filter", tickers_in=len(payloads_list))
            MAX_STAGE1_TICKERS = 150
            if len(payloads_list) > MAX_STAGE1_TICKERS:
                logger.info(f"Step 4c: Technical pre-filter — scoring {len(payloads_list)} tickers")
                scored_payloads: list[tuple[float, StockDataPayload]] = []
                catalyst_overrides: list[StockDataPayload] = []

                for p in payloads_list:
                    t = p.technicals
                    if t is None:
                        # No technicals = can't score, low priority
                        scored_payloads.append((0.0, p))
                        continue

                    # Catalyst override: >5 news articles bypass the filter
                    if len(p.news) > 5:
                        catalyst_overrides.append(p)
                        continue

                    # Hard disqualify obvious non-candidates
                    disqualified = False
                    if t.rsi_14 > 80:
                        disqualified = True  # Severely overbought
                    elif t.rsi_14 < 20 and t.macd_histogram < 0:
                        disqualified = True  # Dead stock, no reversal signal
                    elif t.adx_14 < 10:
                        disqualified = True  # Zero trend strength
                    elif (p.price < t.sma_50 and t.macd_histogram < 0
                          and t.relative_volume < 0.5):
                        disqualified = True  # Bearish with no interest
                    elif t.relative_volume < 0.3:
                        disqualified = True  # Basically no trading activity

                    if disqualified:
                        continue

                    # Composite momentum score (0-100 scale)
                    score = 0.0
                    # RSI momentum zone: 40-65 is ideal (max 25 pts)
                    if 40 <= t.rsi_14 <= 65:
                        score += 25.0
                    elif 30 <= t.rsi_14 < 40 or 65 < t.rsi_14 <= 70:
                        score += 15.0
                    elif 25 <= t.rsi_14 < 30 or 70 < t.rsi_14 <= 75:
                        score += 5.0

                    # MACD direction (max 25 pts)
                    if t.macd_histogram > 0:
                        score += 15.0
                        if t.macd_line > t.macd_signal:
                            score += 10.0  # Bullish crossover
                    elif t.macd_histogram > -0.1:
                        score += 5.0  # About to cross

                    # ADX trend strength (max 20 pts)
                    if t.adx_14 >= 25:
                        score += 20.0  # Strong trend
                    elif t.adx_14 >= 20:
                        score += 12.0
                    elif t.adx_14 >= 15:
                        score += 5.0

                    # Price above SMA-20 (max 15 pts)
                    if p.price > t.sma_20:
                        score += 10.0
                        if p.price > t.sma_50:
                            score += 5.0  # Above both SMAs

                    # Relative volume surge (max 15 pts)
                    if t.relative_volume >= 2.0:
                        score += 15.0
                    elif t.relative_volume >= 1.5:
                        score += 10.0
                    elif t.relative_volume >= 1.0:
                        score += 5.0

                    scored_payloads.append((score, p))

                # Sort by score descending, take top N
                scored_payloads.sort(key=lambda x: x[0], reverse=True)
                slots_remaining = MAX_STAGE1_TICKERS - len(catalyst_overrides)
                top_payloads = [p for _, p in scored_payloads[:max(slots_remaining, 0)]]
                payloads_list = catalyst_overrides + top_payloads

                logger.info(
                    f"Step 4c: Pre-filter kept {len(payloads_list)} tickers "
                    f"({len(catalyst_overrides)} catalyst overrides, "
                    f"{len(top_payloads)} by technical score)"
                )
            else:
                logger.info(f"Step 4c: Pre-filter not needed ({len(payloads_list)} <= {MAX_STAGE1_TICKERS})")

            if tracker:
                tracker.complete_stage("pre_filter", tickers_out=len(payloads_list))

            # ── Steps 4d + 4e: Fetch earnings + enhanced signals in parallel ──
            logger.info(f"Steps 4d+4e: Fetching earnings calendar + analyst data for {len(payloads_list)} tickers (parallel)")

            async def _fetch_earnings():
                try:
                    return await fetch_earnings_calendar(self.fetcher, days_ahead=10)
                except Exception as e:
                    logger.warning(f"Earnings calendar fetch failed (non-fatal): {e}")
                    return {}

            async def _fetch_enhanced():
                try:
                    return await fetch_enhanced_signals_batch(
                        self.fetcher, [p.ticker for p in payloads_list], quotes
                    )
                except Exception as e:
                    logger.warning(f"Enhanced signals fetch failed (non-fatal): {e}")
                    return {}, {}, {}

            # Note: /earnings-surprises/{ticker} returns 404 for all .TO tickers.
            # Bulk /earnings-calendar (via _fetch_earnings) is the working replacement.

            earnings_map, (insider_map, analyst_map, institutional_map) = await asyncio.gather(
                _fetch_earnings(), _fetch_enhanced()
            )

            # ── Step 4f: Compute sector-relative strength + attach all signals ──
            rel_strength_map = compute_sector_relative_strength(payloads_list)
            for p in payloads_list:
                if p.ticker in earnings_map:
                    p.earnings_event = earnings_map[p.ticker]
                if p.ticker in insider_map:
                    p.insider_activity = insider_map[p.ticker]
                if p.ticker in analyst_map:
                    p.analyst_consensus = analyst_map[p.ticker]
                if p.ticker in institutional_map:
                    p.institutional_ownership_pct = institutional_map[p.ticker]
                p.sector_relative_strength = rel_strength_map.get(p.ticker)
            logger.info(
                f"Step 4f: Signals attached — "
                f"{len(earnings_map)} earnings, {len(insider_map)} insider, "
                f"{len(analyst_map)} analyst, {len(institutional_map)} institutional, "
                f"{len(rel_strength_map)} sector-rel"
            )

            # Index payloads by ticker for later lookup
            payloads_map = {p.ticker: p for p in payloads_list}

            # ── Step 5: Stage 1 — Sonnet ──
            stage1_tokens = {"model": "skipped", "input_tokens": 0, "output_tokens": 0}
            stage2_tokens = {"model": "skipped", "input_tokens": 0, "output_tokens": 0}
            stage3_tokens = {"model": "skipped", "input_tokens": 0, "output_tokens": 0}
            stage4_tokens = {"model": "skipped", "input_tokens": 0, "output_tokens": 0}
            STAGE_WALL_CLOCK_TIMEOUT = 420  # 7 minutes max per stage
            logger.info(f"Step 5: Stage 1 (Sonnet) — {len(payloads_list)} tickers")
            # Batch size 15 to stay under Anthropic rate limits (~30K tokens/min)
            BATCH_SIZE = 15
            INTER_BATCH_DELAY = 3  # seconds between batches (reduced from 8s; Anthropic rate limits are per-minute)
            stage1_start = asyncio.get_event_loop().time()
            _stage1_batch_count = (len(payloads_list) + BATCH_SIZE - 1) // BATCH_SIZE
            if tracker:
                tracker.start_stage("stage1_sonnet", batches_total=_stage1_batch_count)
            if len(payloads_list) > BATCH_SIZE:
                stage1_all = []
                n_batches = (len(payloads_list) + BATCH_SIZE - 1) // BATCH_SIZE
                for i in range(0, len(payloads_list), BATCH_SIZE):
                    elapsed_stage = asyncio.get_event_loop().time() - stage1_start
                    if elapsed_stage > STAGE_WALL_CLOCK_TIMEOUT:
                        logger.warning(f"Stage 1 wall-clock timeout ({STAGE_WALL_CLOCK_TIMEOUT}s) — aborting remaining batches ({len(stage1_all)} results so far)")
                        break
                    batch = payloads_list[i:i + BATCH_SIZE]
                    batch_num = i // BATCH_SIZE + 1
                    logger.info(
                        f"Stage 1 batch {batch_num}/{n_batches}: "
                        f"tickers {i+1}-{min(i+BATCH_SIZE, len(payloads_list))}"
                    )
                    try:
                        batch_results, batch_tokens = await run_stage1_sonnet(
                            self.anthropic_key, batch, macro,
                            learning_engine=self.learning_engine,
                        )
                        stage1_tokens["model"] = batch_tokens["model"]
                        stage1_tokens["input_tokens"] += batch_tokens["input_tokens"]
                        stage1_tokens["output_tokens"] += batch_tokens["output_tokens"]
                        stage1_all.extend(batch_results)
                        if tracker:
                            tracker.update_batch("stage1_sonnet", batch_num)
                    except Exception as batch_e:
                        logger.warning(f"Stage 1 batch {batch_num} failed: {batch_e}")
                    if i + BATCH_SIZE < len(payloads_list):
                        await asyncio.sleep(INTER_BATCH_DELAY)
                # Re-sort and take top 100
                stage1_results = sorted(
                    stage1_all, key=lambda x: x["score"]["total"], reverse=True
                )[:100]
            else:
                stage1_results, stage1_tokens = await run_stage1_sonnet(
                    self.anthropic_key, payloads_list, macro,
                    learning_engine=self.learning_engine,
                )
                stage1_results = stage1_results[:100]

            if tracker:
                tracker.complete_stage("stage1_sonnet", picks=len(stage1_results))
            logger.info(f"Step 5: Stage 1 produced {len(stage1_results)} results")
            if not stage1_results:
                raise RuntimeError("Stage 1 produced no results")

            # Track skipped stages for metadata/alerting
            skipped_stages: list[dict] = []

            # ── Step 6: Stage 2 — Gemini (skippable) ──
            GEMINI_BATCH_SIZE = 15  # Smaller batches for Gemini to avoid token limit truncation
            logger.info(f"Step 6: Stage 2 (Gemini) — {len(stage1_results)} tickers")
            _gemini_batch_count = (len(stage1_results) + GEMINI_BATCH_SIZE - 1) // GEMINI_BATCH_SIZE
            if tracker:
                tracker.start_stage("stage2_gemini", batches_total=_gemini_batch_count)
            stage2_results = []
            stage2_skipped = False
            try:
                async def _run_stage2_all() -> list[dict]:
                    """Run all Stage 2 batches, wrapped by wall-clock timeout."""
                    nonlocal stage2_tokens
                    if len(stage1_results) > GEMINI_BATCH_SIZE:
                        s1_tickers_batched = [
                            stage1_results[i:i + GEMINI_BATCH_SIZE]
                            for i in range(0, len(stage1_results), GEMINI_BATCH_SIZE)
                        ]
                        GEMINI_CONCURRENCY = 2
                        gemini_sem = asyncio.Semaphore(GEMINI_CONCURRENCY)

                        async def _run_gemini_batch(batch_idx: int, s1_batch: list[dict]) -> tuple[list[dict], dict]:
                            async with gemini_sem:
                                batch_tickers = {r["ticker"] for r in s1_batch}
                                batch_payloads = [p for p in payloads_list if p.ticker in batch_tickers]
                                logger.info(f"Stage 2 batch {batch_idx + 1}/{len(s1_tickers_batched)}: {len(s1_batch)} tickers")
                                result, batch_tokens = await run_stage2_gemini(
                                    batch_payloads, macro, s1_batch,
                                    learning_engine=self.learning_engine,
                                )
                                if tracker:
                                    tracker.update_batch("stage2_gemini", batch_idx + 1)
                                return result, batch_tokens

                        batch_tasks = [
                            _run_gemini_batch(idx, batch)
                            for idx, batch in enumerate(s1_tickers_batched)
                        ]
                        batch_results_list = await asyncio.gather(*batch_tasks, return_exceptions=True)

                        all_results = []
                        for idx, br in enumerate(batch_results_list):
                            if isinstance(br, Exception):
                                logger.warning(f"Stage 2 batch {idx + 1} failed: {br}")
                            else:
                                results, batch_tok = br
                                all_results.extend(results)
                                stage2_tokens["model"] = batch_tok["model"]
                                stage2_tokens["input_tokens"] += batch_tok["input_tokens"]
                                stage2_tokens["output_tokens"] += batch_tok["output_tokens"]
                        return sorted(all_results, key=lambda x: x["score"]["total"], reverse=True)[:80]
                    else:
                        r, stage2_tokens = await run_stage2_gemini(payloads_list, macro, stage1_results,
                                                     learning_engine=self.learning_engine)
                        return r[:80]

                stage2_results = await asyncio.wait_for(
                    _run_stage2_all(), timeout=STAGE_WALL_CLOCK_TIMEOUT
                )
            except asyncio.TimeoutError:
                logger.error(f"Stage 2 (Gemini) wall-clock timeout ({STAGE_WALL_CLOCK_TIMEOUT}s) — skipping entire stage")
                stage2_skipped = True
                skipped_stages.append({"stage": 2, "model": "gemini", "error": f"wall-clock timeout ({STAGE_WALL_CLOCK_TIMEOUT}s)"})
                if tracker:
                    tracker.skip_stage("stage2_gemini", reason=f"wall-clock timeout ({STAGE_WALL_CLOCK_TIMEOUT}s)")
            except Exception as e:
                logger.error(f"Stage 2 (Gemini) FAILED — skipping: {e}")
                stage2_skipped = True
                skipped_stages.append({"stage": 2, "model": "gemini", "error": str(e)})
                if tracker:
                    tracker.skip_stage("stage2_gemini", reason=str(e))

            if stage2_skipped or not stage2_results:
                if not stage2_skipped:
                    logger.warning("Stage 2 (Gemini) returned 0 results — passing Stage 1 results through")
                    skipped_stages.append({"stage": 2, "model": "gemini", "error": "empty results"})
                    if tracker:
                        tracker.skip_stage("stage2_gemini", reason="empty results")
                stage2_results = stage1_results[:80]
                logger.info(f"Step 6: Stage 2 SKIPPED — passing through {len(stage2_results)} Stage 1 results")
            else:
                if tracker:
                    tracker.complete_stage("stage2_gemini", picks=len(stage2_results))
                logger.info(f"Step 6: Stage 2 produced {len(stage2_results)} results")

            # ── Step 7: Stage 3 — Opus (skippable) ──
            logger.info(f"Step 7: Stage 3 (Opus) — {len(stage2_results)} tickers")
            OPUS_BATCH = 20  # Smaller batches for expensive Opus calls
            _opus_batch_count = (len(stage2_results) + OPUS_BATCH - 1) // OPUS_BATCH
            if tracker:
                tracker.start_stage("stage3_opus", batches_total=_opus_batch_count)
            stage3_results = []
            stage3_skipped = False
            try:
                stage3_start = asyncio.get_event_loop().time()
                if len(stage2_results) > OPUS_BATCH:
                    s2_tickers_batched = [
                        stage2_results[i:i + OPUS_BATCH]
                        for i in range(0, len(stage2_results), OPUS_BATCH)
                    ]
                    # Opus batches run sequentially — Anthropic rate limits are tight
                    stage3_all = []
                    for batch_idx, s2_batch in enumerate(s2_tickers_batched):
                        elapsed_stage = asyncio.get_event_loop().time() - stage3_start
                        if elapsed_stage > STAGE_WALL_CLOCK_TIMEOUT:
                            logger.warning(f"Stage 3 wall-clock timeout ({STAGE_WALL_CLOCK_TIMEOUT}s) — aborting remaining batches ({len(stage3_all)} results so far)")
                            break
                        batch_tickers = {r["ticker"] for r in s2_batch}
                        batch_payloads = [p for p in payloads_list if p.ticker in batch_tickers]
                        s1_for_batch = [r for r in stage1_results if r["ticker"] in batch_tickers]
                        logger.info(f"Stage 3 batch {batch_idx + 1}/{len(s2_tickers_batched)}: {len(s2_batch)} tickers")
                        try:
                            batch_results, batch_tokens = await run_stage3_opus(
                                self.anthropic_key, batch_payloads, macro,
                                s1_for_batch, s2_batch,
                                learning_engine=self.learning_engine,
                            )
                            stage3_tokens["model"] = batch_tokens["model"]
                            stage3_tokens["input_tokens"] += batch_tokens["input_tokens"]
                            stage3_tokens["output_tokens"] += batch_tokens["output_tokens"]
                            stage3_all.extend(batch_results)
                            if tracker:
                                tracker.update_batch("stage3_opus", batch_idx + 1)
                        except Exception as batch_e:
                            logger.warning(f"Stage 3 batch {batch_idx + 1} failed: {batch_e}")
                        if batch_idx + 1 < len(s2_tickers_batched):
                            await asyncio.sleep(INTER_BATCH_DELAY)
                    stage3_results = sorted(
                        stage3_all, key=lambda x: x["score"]["total"], reverse=True
                    )[:40]
                else:
                    stage3_results, stage3_tokens = await run_stage3_opus(
                        self.anthropic_key, payloads_list, macro,
                        stage1_results, stage2_results,
                        learning_engine=self.learning_engine,
                    )
                    stage3_results = stage3_results[:40]
            except Exception as e:
                logger.error(f"Stage 3 (Opus) FAILED — skipping: {e}")
                stage3_skipped = True
                skipped_stages.append({"stage": 3, "model": "opus", "error": str(e)})
                if tracker:
                    tracker.skip_stage("stage3_opus", reason=str(e))

            if stage3_skipped or not stage3_results:
                if not stage3_skipped:
                    logger.warning("Stage 3 (Opus) returned 0 results — passing Stage 2 results through")
                    skipped_stages.append({"stage": 3, "model": "opus", "error": "empty results"})
                    if tracker:
                        tracker.skip_stage("stage3_opus", reason="empty results")
                stage3_results = stage2_results[:40]
                logger.info(f"Step 7: Stage 3 SKIPPED — passing through {len(stage3_results)} Stage 2 results")
            else:
                if tracker:
                    tracker.complete_stage("stage3_opus", picks=len(stage3_results))
                logger.info(f"Step 7: Stage 3 produced {len(stage3_results)} results")

            # ── Step 8: Stage 4 — Grok (skippable) ──
            logger.info(f"Step 8: Stage 4 (Grok) — {len(stage3_results)} tickers")
            if tracker:
                tracker.start_stage("stage4_grok")
            stage4_results = []
            stage4_skipped = False
            try:
                stage4_raw, stage4_tokens = await asyncio.wait_for(
                    run_stage4_grok(
                        self.xai_key, self.anthropic_key,
                        payloads_list, macro,
                        stage1_results, stage2_results, stage3_results,
                        learning_engine=self.learning_engine,
                    ),
                    timeout=STAGE_WALL_CLOCK_TIMEOUT,
                )
                stage4_results = stage4_raw[:20]
            except asyncio.TimeoutError:
                logger.error(f"Stage 4 (Grok) wall-clock timeout ({STAGE_WALL_CLOCK_TIMEOUT}s) — skipping")
                stage4_skipped = True
                skipped_stages.append({"stage": 4, "model": "grok", "error": f"wall-clock timeout ({STAGE_WALL_CLOCK_TIMEOUT}s)"})
                if tracker:
                    tracker.skip_stage("stage4_grok", reason=f"wall-clock timeout ({STAGE_WALL_CLOCK_TIMEOUT}s)")
            except Exception as e:
                logger.error(f"Stage 4 (Grok) FAILED — skipping: {e}")
                stage4_skipped = True
                skipped_stages.append({"stage": 4, "model": "grok", "error": str(e)})
                if tracker:
                    tracker.skip_stage("stage4_grok", reason=str(e))

            if stage4_skipped or not stage4_results:
                if not stage4_skipped:
                    logger.warning("Stage 4 (Grok) returned 0 results — passing Stage 3 results through")
                    skipped_stages.append({"stage": 4, "model": "grok", "error": "empty results"})
                    if tracker:
                        tracker.skip_stage("stage4_grok", reason="empty results")
                stage4_results = stage3_results[:20]
                logger.info(f"Step 8: Stage 4 SKIPPED — passing through {len(stage4_results)} Stage 3 results")
            else:
                if tracker:
                    tracker.complete_stage("stage4_grok", picks=len(stage4_results))
                logger.info(f"Step 8: Stage 4 produced {len(stage4_results)} results")

            # Log alert summary for any skipped stages
            if skipped_stages:
                skip_summary = ", ".join(f"Stage {s['stage']} ({s['model']})" for s in skipped_stages)
                logger.warning(
                    f"⚠️ COUNCIL RUN {run_id}: {len(skipped_stages)} stage(s) skipped: {skip_summary}. "
                    f"Results may have reduced quality. Review logs for details."
                )

            if not stage4_results:
                raise RuntimeError("Pipeline produced no results after all stages (including fallbacks)")

            # ── Step 9: Fact-check ──
            logger.info("Step 9: Running fact checker")
            fact_checker = CouncilFactChecker()
            fact_flags = fact_checker.check(stage4_results, payloads_map)

            # ── Step 10: Consensus + conviction ──
            logger.info("Step 10: Building consensus")
            if tracker:
                tracker.start_stage("consensus")
            top_picks = _build_consensus(
                stage1_results, stage2_results, stage3_results, stage4_results,
                payloads_map, regime, self.regime_filter,
                earnings_map=earnings_map,
                learning_engine=self.learning_engine,
                historical_analyzer=self.historical_analyzer,
            )
            if tracker:
                tracker.complete_stage("consensus", picks=len(top_picks))

            # ── Step 10b: Apply historical calibration ──
            logger.info("Step 10b: Applying historical calibration")
            try:
                self.calibration_engine.apply_calibration(top_picks, payloads_map)
            except Exception as e:
                logger.warning(f"Calibration failed (non-fatal): {e}")

            # ── Step 11: Historical edge multipliers (now applied in _build_consensus before ranking) ──
            logger.info("Step 11: Applying historical edge multipliers")
            for pick in top_picks:
                multiplier = self.historical_analyzer.get_historical_edge_multiplier(pick.ticker)
                pick.historical_edge_multiplier = multiplier

            # ── Step 12: Risk portfolio sizing ──
            logger.info("Step 12: Computing risk allocations")
            risk_summary = self.risk_engine.compute_allocations(top_picks, payloads_map)

            # ── Step 13: Compounding roadmap ──
            logger.info("Step 13: Generating compounding roadmap")
            daily_roadmap = self.roadmap_engine.generate_roadmap(
                top_picks, allocations=risk_summary, run_id=run_id
            )

            # ── Step 14: Assemble result ──
            total_runtime = time.time() - run_start
            logger.info(
                f"=== Council Run {run_id} complete: "
                f"{len(top_picks)} picks in {total_runtime:.1f}s ==="
            )

            result = CouncilResult(
                run_id=run_id,
                run_date=datetime.now(ZoneInfo("America/Halifax")).date(),
                macro_context=macro,
                regime=regime,
                universe_size=len(universe),
                tickers_screened=len(payloads_list),
                top_picks=top_picks,
                risk_summary=risk_summary,
                daily_roadmap=daily_roadmap,
                stage_metadata={
                    "stage1_count": len(stage1_results),
                    "stage2_count": len(stage2_results),
                    "stage3_count": len(stage3_results),
                    "stage4_count": len(stage4_results),
                    "batching_used": len(payloads_list) > 50,
                    "total_runtime_seconds": round(total_runtime, 1),
                    "skipped_stages": skipped_stages,
                    "token_usage": {
                        "stage1": stage1_tokens,
                        "stage2": stage2_tokens,
                        "stage3": stage3_tokens,
                        "stage4": stage4_tokens,
                    },
                },
                fact_check_flags=fact_flags,
                total_runtime_seconds=round(total_runtime, 1),
            )

            result_dict = result.model_dump(mode="json")

            # Include FMP endpoint health in output
            result_dict["fmp_endpoint_health"] = dict(self.fetcher.endpoint_health)

            # Include learning state in output
            try:
                result_dict["learning_state"] = self.learning_engine.get_mechanism_states()
                # LE BYPASS (2026-04-08): second compute_stage_weights call site.
                # Same hardcoded literal as _build_consensus so the dashboard's
                # stage_weights_used value matches what scoring actually used.
                result_dict["stage_weights_used"] = {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
                # Mechanism #6: Factor-level feedback weights (logged for transparency)
                factor_weights = self.learning_engine.compute_factor_weights()
                if factor_weights:
                    result_dict["factor_weights"] = factor_weights
                    logger.info(f"Factor weights (mechanism #6): {factor_weights}")
                # Mechanism #7: Adaptive pre-filter adjustments (logged for transparency)
                prefilter_adj = self.learning_engine.compute_prefilter_adjustments()
                if prefilter_adj:
                    result_dict["prefilter_adjustments"] = prefilter_adj
                    logger.info(f"Pre-filter adjustments (mechanism #7): {prefilter_adj}")
            except Exception as e:
                logger.warning(f"Could not include learning state in output: {e}")

            # ── Step 15: Record picks to history ──
            logger.info("Step 15: Recording picks to history")
            self.historical_analyzer.record_picks(result_dict)

            # ── Step 16: Backfill actuals for past picks ──
            logger.info("Step 16: Backfilling accuracy for past picks")
            try:
                await self.historical_analyzer.backfill_actuals(self.fetcher)
                # Update council calibration curve after new accuracy data
                self.calibration_engine.build_council_calibration()
            except Exception as e:
                logger.warning(f"Backfill failed (non-fatal): {e}")

            return result_dict

        finally:
            await self.fetcher.close()


# ═══════════════════════════════════════════════════════════════════════════
# CLI ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv(override=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    async def main():
        brain = CanadianStockCouncilBrain()
        # Check for command-line universe override
        import sys
        universe = None
        if len(sys.argv) > 1:
            universe = sys.argv[1:]
            logger.info(f"CLI override: testing with {universe}")
        result = await brain.run_council(starting_universe=universe)
        print(json.dumps(result, indent=2, default=str))
        return result

    asyncio.run(main())

# Cron (10:45 AM AST weekdays):
#   45 10 * * 1-5 cd /opt/spike-trades && python3 canadian_llm_council_brain.py
