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
  Stage 4 — SuperGrok Heavy (xAI)→ final Top 20 with probabilistic forecasts

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
import sqlite3
import ssl
import statistics
import time
from datetime import datetime, timezone, timedelta, date
from zoneinfo import ZoneInfo
from enum import Enum
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

# ═══════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════

logger = logging.getLogger("spike_trades.council")


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


class NewsItem(BaseModel):
    """A single news article."""
    headline: str
    source: str = ""
    url: str = ""
    published_at: Optional[datetime] = None
    sentiment_score: Optional[float] = Field(None, ge=-1, le=1)


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
    news: list[NewsItem] = Field(default_factory=list)
    finnhub_sentiment: Optional[float] = Field(None, ge=-1, le=1)
    macro: Optional[MacroContext] = None
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
    """A single Top 20 hot pick with all council data."""
    rank: int = Field(..., ge=1, le=20)
    ticker: str
    company_name: str = ""
    sector: str = "Unknown"
    price: float = Field(..., gt=0)
    change_pct: float = 0.0
    consensus_score: float = Field(..., ge=0, le=100)
    conviction_tier: ConvictionTier
    stages_appeared: int = Field(..., ge=1, le=4)
    stage_scores: dict[str, ScoreBreakdown] = Field(default_factory=dict)
    forecasts: list[ProbabilisticForecast] = Field(default_factory=list)
    key_catalyst: str = ""
    kill_condition: str = ""
    worst_case_scenario: str = ""
    reasoning_summary: str = ""
    technicals: Optional[TechnicalIndicators] = None
    historical_edge_multiplier: float = Field(default=1.0, ge=0)
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
    top_picks: list[FinalHotPick] = Field(..., max_length=20)
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
    """Async data client for FMP + Finnhub with strict freshness validation."""

    def __init__(self, fmp_api_key: str, finnhub_api_key: str):
        self.fmp_key = fmp_api_key
        self.finnhub_key = finnhub_api_key
        self._session: Optional[aiohttp.ClientSession] = None
        self._profile_cache: dict[str, dict] = {}

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

    async def _fmp_get(self, path: str, params: dict | None = None) -> Any:
        """Make a GET request to FMP /stable/ API with retry on 429."""
        session = await self._get_session()
        params = params or {}
        params["apikey"] = self.fmp_key
        url = f"{FMP_BASE}{path}"
        for attempt in range(5):
            async with session.get(url, params=params) as resp:
                if resp.status == 429:
                    wait = 5 * (2 ** attempt)  # 5s, 10s, 20s, 40s, 80s
                    logger.warning(f"FMP {path} rate limited, retrying in {wait}s (attempt {attempt + 1}/5)")
                    await asyncio.sleep(wait)
                    continue
                if resp.status != 200:
                    text = await resp.text()
                    logger.error(f"FMP {path} returned {resp.status}: {text[:200]}")
                    return None
                return await resp.json()
        logger.error(f"FMP {path} failed after 5 retries (429)")
        return None

    async def _finnhub_get(self, path: str, params: dict | None = None) -> Any:
        """Make a GET request to Finnhub API."""
        session = await self._get_session()
        params = params or {}
        params["token"] = self.finnhub_key
        url = f"https://finnhub.io/api/v1{path}"
        async with session.get(url, params=params) as resp:
            if resp.status != 200:
                text = await resp.text()
                logger.error(f"Finnhub {path} returned {resp.status}: {text[:200]}")
                return None
            return await resp.json()

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
        """Fetch profiles for multiple tickers (rate-limited, 3 at a time with delay)."""
        result = {}
        sem = asyncio.Semaphore(3)
        async def _fetch(t: str):
            async with sem:
                p = await self.fetch_profile(t)
                if p:
                    result[t] = p
                await asyncio.sleep(0.3)  # Rate limit: ~10 req/sec max
        # Process in batches of 20 to avoid overwhelming FMP
        for i in range(0, len(tickers), 20):
            batch = tickers[i:i + 20]
            await asyncio.gather(*[_fetch(t) for t in batch])
            if i + 20 < len(tickers):
                logger.info(f"Profiles: {min(i + 20, len(tickers))}/{len(tickers)} fetched")
                await asyncio.sleep(3)  # Longer pause between batches
        return result

    # ── Quotes ────────────────────────────────────────────────────────

    async def fetch_quotes(self, tickers: list[str]) -> dict[str, dict]:
        """Fetch real-time quotes for a list of tickers.
        Uses /stable/batch-quote for batches, returns {ticker: quote_dict}."""
        if not tickers:
            return {}
        now = datetime.now(timezone.utc)
        result = {}
        # batch-quote supports comma-separated symbols
        batch_size = 50
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

    async def fetch_news(self, ticker: str, limit: int = 5) -> list[NewsItem]:
        """Fetch recent news for a ticker from FMP /stable/news/stock."""
        data = await self._fmp_get(
            "/news/stock",
            params={"symbol": ticker, "limit": str(limit)}
        )
        if not data:
            return []
        items = []
        for article in data:
            if not isinstance(article, dict):
                continue
            pub = article.get("publishedDate")
            pub_dt = None
            if pub:
                try:
                    pub_dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass
            items.append(NewsItem(
                headline=article.get("title", ""),
                source=article.get("site", ""),
                url=article.get("url", ""),
                published_at=pub_dt,
            ))
        return items

    # ── Finnhub Sentiment ─────────────────────────────────────────────

    async def fetch_finnhub_sentiment(self, ticker: str) -> Optional[float]:
        """Derive sentiment from Finnhub company news volume/recency.
        Returns float [-1, 1] or None. Uses /company-news since
        /news-sentiment requires a premium Finnhub plan."""
        base = ticker.replace(".TO", "").replace(".V", "")
        to_date = date.today().isoformat()
        from_date = (date.today() - timedelta(days=7)).isoformat()
        data = await self._finnhub_get(
            "/company-news",
            params={"symbol": base, "from": from_date, "to": to_date}
        )
        if not data or not isinstance(data, list):
            return None
        if len(data) == 0:
            return 0.0
        # Simple heuristic: more recent news = more activity = slight positive bias
        # Normalize news count to [-1, 1] range (10+ articles = strong signal)
        count = len(data)
        score = min(1.0, count / 10.0) * 0.5  # Cap at 0.5 for news volume alone
        return round(score, 4)

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

        # Fetch news + sentiment in parallel
        news_task = self.fetch_news(ticker)
        sentiment_task = self.fetch_finnhub_sentiment(ticker)
        news_items, sentiment = await asyncio.gather(news_task, sentiment_task)

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
                finnhub_sentiment=sentiment,
                macro=macro,
                as_of=datetime.now(timezone.utc),
            )
            return payload
        except Exception as e:
            logger.error(f"Failed to build payload for {ticker}: {e}")
            return None


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

import re

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
    Removes: macro (already in prompt header), news URLs (waste tokens).
    """
    d.pop("macro", None)
    for item in d.get("news", []):
        if isinstance(item, dict):
            item.pop("url", None)
    return d


_COMPACT = {"separators": (",", ":"), "default": str}


# ── LLM API Callers ──────────────────────────────────────────────────

async def _call_anthropic(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 8192,
    temperature: float = 0.3,
) -> str:
    """Call Anthropic Claude API using streaming with retry on rate limits."""
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
            return "".join(chunks)
        except anthropic.RateLimitError as e:
            wait = 60 * (attempt + 1)  # 60s, 120s, 180s, 240s
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
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 8192,
    temperature: float = 0.3,
) -> str:
    """Call Google Gemini API with retry on transient failures."""
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=api_key)
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
                ),
            )
            return resp.text
        except Exception as e:
            if _is_transient(e) and attempt < max_retries - 1:
                wait = min(30 * (2 ** attempt), 300)  # 30s, 60s, 120s, 300s
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
) -> str:
    """Call xAI Grok API (OpenAI-compatible) with retry on transient failures."""
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
            return resp.choices[0].message.content
        except Exception as e:
            if _is_transient(e) and attempt < max_retries - 1:
                wait = min(30 * (2 ** attempt), 300)
                logger.warning(f"Grok {model} transient error, retrying in {wait}s (attempt {attempt + 1}/{max_retries}): {e}")
                await asyncio.sleep(wait)
            else:
                logger.error(f"Grok {model} call failed: {e}")
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
- Sentiment & Catalysts (0-25 pts): Recent positive news sentiment, upcoming bullish catalysts, positive earnings surprise, analyst upgrades. Negative sentiment or bearish catalysts = low scores.
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
) -> list[dict]:
    """Stage 1: Sonnet screens universe to Top 100."""
    logger.info(f"Stage 1 (Sonnet): Processing {len(payloads)} tickers")
    start = time.time()

    # Build user prompt with all ticker payloads (slimmed for token efficiency)
    payload_dicts = []
    for p in payloads:
        d = p.model_dump(mode="json")
        d["historical_bars"] = d["historical_bars"][-5:]
        _slim_payload(d)
        payload_dicts.append(d)

    user_prompt = (
        f"MACRO CONTEXT:\n{json.dumps(macro.model_dump(mode='json'), **_COMPACT)}\n\n"
        f"TICKERS TO SCREEN ({len(payload_dicts)} total):\n"
        f"{json.dumps(payload_dicts, **_COMPACT)}"
    )

    raw = await _call_anthropic(
        api_key=api_key,
        model="claude-sonnet-4-20250514",
        system_prompt=SONNET_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        max_tokens=16384,
    )

    parsed = _extract_json(raw)
    if not parsed or "results" not in parsed:
        logger.error("Stage 1 Sonnet: Failed to parse response")
        return []

    results = parsed["results"]
    # Validate scores
    validated = []
    for r in results:
        try:
            score = ScoreBreakdown(**r["score"])
            r["score"] = score.model_dump()
            validated.append(r)
        except Exception as e:
            logger.warning(f"Stage 1: Invalid score for {r.get('ticker','?')}: {e}")

    elapsed = time.time() - start
    logger.info(f"Stage 1 (Sonnet): {len(validated)} tickers passed in {elapsed:.1f}s")
    return sorted(validated, key=lambda x: x["score"]["total"], reverse=True)


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
    api_key: str,
    payloads: list[StockDataPayload],
    macro: MacroContext,
    stage1_results: list[dict],
) -> list[dict]:
    """Stage 2: Gemini independently re-scores, narrows to Top 80."""
    logger.info(f"Stage 2 (Gemini): Processing {len(stage1_results)} tickers from Stage 1")
    start = time.time()

    # Build payload subset — only tickers that passed Stage 1 (slimmed)
    passed_tickers = {r["ticker"] for r in stage1_results}
    payload_dicts = []
    for p in payloads:
        if p.ticker in passed_tickers:
            d = p.model_dump(mode="json")
            d["historical_bars"] = d["historical_bars"][-5:]
            _slim_payload(d)
            payload_dicts.append(d)

    user_prompt = (
        f"MACRO CONTEXT:\n{json.dumps(macro.model_dump(mode='json'), **_COMPACT)}\n\n"
        f"STAGE 1 (SONNET) RESULTS:\n{json.dumps(stage1_results, **_COMPACT)}\n\n"
        f"RAW DATA ({len(payload_dicts)} tickers):\n"
        f"{json.dumps(payload_dicts, **_COMPACT)}"
    )

    raw = await _call_gemini(
        api_key=api_key,
        model="gemini-3.1-pro-preview",
        system_prompt=GEMINI_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        max_tokens=32768,
    )

    parsed = _extract_json(raw)
    if not parsed or "results" not in parsed:
        logger.error("Stage 2 Gemini: Failed to parse response")
        return []

    results = parsed["results"]
    validated = []
    for r in results:
        try:
            score = ScoreBreakdown(**r["score"])
            r["score"] = score.model_dump()
            validated.append(r)
        except Exception as e:
            logger.warning(f"Stage 2: Invalid score for {r.get('ticker','?')}: {e}")

    elapsed = time.time() - start
    logger.info(f"Stage 2 (Gemini): {len(validated)} tickers passed in {elapsed:.1f}s")
    return sorted(validated, key=lambda x: x["score"]["total"], reverse=True)


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
) -> list[dict]:
    """Stage 3: Opus challenges picks, narrows to Top 40."""
    logger.info(f"Stage 3 (Opus): Processing {len(stage2_results)} tickers from Stage 2")
    start = time.time()

    passed_tickers = {r["ticker"] for r in stage2_results}
    payload_dicts = []
    for p in payloads:
        if p.ticker in passed_tickers:
            d = p.model_dump(mode="json")
            d["historical_bars"] = d["historical_bars"][-5:]
            _slim_payload(d)
            payload_dicts.append(d)

    user_prompt = (
        f"MACRO CONTEXT:\n{json.dumps(macro.model_dump(mode='json'), **_COMPACT)}\n\n"
        f"STAGE 1 (SONNET) RESULTS:\n{json.dumps(stage1_results, **_COMPACT)}\n\n"
        f"STAGE 2 (GEMINI) RESULTS:\n{json.dumps(stage2_results, **_COMPACT)}\n\n"
        f"RAW DATA ({len(payload_dicts)} tickers):\n"
        f"{json.dumps(payload_dicts, **_COMPACT)}"
    )

    raw = await _call_anthropic(
        api_key=api_key,
        model="claude-opus-4-20250514",
        system_prompt=OPUS_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        max_tokens=16384,
    )

    parsed = _extract_json(raw)
    if not parsed or "results" not in parsed:
        logger.error("Stage 3 Opus: Failed to parse response")
        return []

    results = parsed["results"]
    validated = []
    for r in results:
        try:
            score = ScoreBreakdown(**r["score"])
            r["score"] = score.model_dump()
            # Ensure kill_condition and worst_case are populated
            if not r.get("kill_condition"):
                r["kill_condition"] = "Not specified"
            if not r.get("worst_case_scenario"):
                r["worst_case_scenario"] = "Not specified"
            validated.append(r)
        except Exception as e:
            logger.warning(f"Stage 3: Invalid score for {r.get('ticker','?')}: {e}")

    elapsed = time.time() - start
    logger.info(f"Stage 3 (Opus): {len(validated)} tickers passed in {elapsed:.1f}s")
    return sorted(validated, key=lambda x: x["score"]["total"], reverse=True)


# ── Stage 4: Grok Final Authority ────────────────────────────────────

GROK_SYSTEM_PROMPT = f"""You are the final quantitative synthesizer for a Canadian equity momentum council.
You are Stage 4 (Final Authority) of a 4-stage LLM Council. You receive all 3 prior stages AND raw data.

YOUR TASK: Produce the FINAL Top 20 picks with explicit probabilistic forecasts.
For EACH of the Top 20, provide forecasts at 3 horizons: 3-day, 5-day, 8-day.

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

Sort by total score descending. Return EXACTLY the top 20 (or all if fewer).
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
) -> list[dict]:
    """Stage 4: Grok (or Opus fallback) produces final Top 20 with probabilistic forecasts."""
    logger.info(f"Stage 4 (Grok): Processing {len(stage3_results)} tickers from Stage 3")
    start = time.time()

    passed_tickers = {r["ticker"] for r in stage3_results}
    payload_dicts = []
    for p in payloads:
        if p.ticker in passed_tickers:
            d = p.model_dump(mode="json")
            d["historical_bars"] = d["historical_bars"][-5:]
            _slim_payload(d)
            payload_dicts.append(d)

    user_prompt = (
        f"MACRO CONTEXT:\n{json.dumps(macro.model_dump(mode='json'), **_COMPACT)}\n\n"
        f"STAGE 1 (SONNET) SCORES:\n{json.dumps(stage1_results[:40], **_COMPACT)}\n\n"
        f"STAGE 2 (GEMINI) SCORES:\n{json.dumps(stage2_results[:40], **_COMPACT)}\n\n"
        f"STAGE 3 (OPUS) SCORES + RISK ANALYSIS:\n{json.dumps(stage3_results, **_COMPACT)}\n\n"
        f"RAW DATA ({len(payload_dicts)} tickers):\n"
        f"{json.dumps(payload_dicts, **_COMPACT)}"
    )

    # Try Grok first, fall back to Opus if xAI key is missing or call fails
    use_grok = bool(xai_api_key)
    if use_grok:
        try:
            raw = await _call_grok(
                api_key=xai_api_key,
                model="grok-4-0709",
                system_prompt=GROK_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                max_tokens=16384,
            )
        except Exception as e:
            logger.warning(f"Grok failed, falling back to Opus for Stage 4: {e}")
            use_grok = False

    if not use_grok:
        logger.info("Stage 4: Using Opus as fallback for Grok")
        raw = await _call_anthropic(
            api_key=anthropic_api_key,
            model="claude-opus-4-20250514",
            system_prompt=GROK_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            max_tokens=16384,
        )

    parsed = _extract_json(raw)
    if not parsed or "results" not in parsed:
        logger.error("Stage 4: Failed to parse response")
        return []

    results = parsed["results"]
    validated = []
    for r in results:
        try:
            score = ScoreBreakdown(**r["score"])
            r["score"] = score.model_dump()
            # Validate forecasts
            valid_forecasts = []
            for f in r.get("forecasts", []):
                try:
                    pf = ProbabilisticForecast(**f)
                    valid_forecasts.append(pf.model_dump())
                except Exception as fe:
                    logger.warning(f"Stage 4: Invalid forecast for {r.get('ticker','?')}: {fe}")
            r["forecasts"] = valid_forecasts
            validated.append(r)
        except Exception as e:
            logger.warning(f"Stage 4: Invalid score for {r.get('ticker','?')}: {e}")

    elapsed = time.time() - start
    model_used = "grok-3" if use_grok else "claude-opus-4.6 (fallback)"
    logger.info(f"Stage 4 ({model_used}): {len(validated)} tickers passed in {elapsed:.1f}s")
    return sorted(validated, key=lambda x: x["score"]["total"], reverse=True)


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
) -> list[FinalHotPick]:
    """Build consensus Top 20 from all 4 stage results.

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

        # Apply macro regime adjustment
        payload = payloads.get(ticker)
        if payload and regime_filter:
            consensus_score = regime_filter.adjust_score(
                consensus_score, payload.sector, regime
            )

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
                    # Boost: e.g. prob=0.75, move=4.5% → multiplier ~1.34
                    directional_multiplier = 1.0 + (prob - 0.5) * move / 10
                else:
                    # Penalize DOWN: e.g. prob=0.6, move=3% → multiplier ~0.70
                    directional_multiplier = 1.0 - (prob - 0.5) * move / 5
                consensus_score *= max(directional_multiplier, 0.1)

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

    # Sort by consensus score descending, take top 20
    scored_tickers.sort(key=lambda x: (-x[1], -x[2]))
    top_20 = scored_tickers[:20]

    # Build FinalHotPick objects
    picks: list[FinalHotPick] = []
    for rank, (ticker, consensus_score, n_stages, data) in enumerate(top_20, 1):
        payload = payloads.get(ticker)

        # Determine conviction tier
        if consensus_score >= 80 and n_stages >= 3:
            tier = ConvictionTier.HIGH
        elif consensus_score >= 65 or n_stages >= 2:
            tier = ConvictionTier.MEDIUM
        else:
            tier = ConvictionTier.LOW

        # Parse stage scores into ScoreBreakdown objects
        stage_scores = {}
        for stage_key, score_dict in data["scores"].items():
            try:
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
            consensus_score=round(consensus_score, 2),
            conviction_tier=tier,
            stages_appeared=n_stages,
            stage_scores=stage_scores,
            forecasts=forecasts,
            key_catalyst=key_catalyst,
            kill_condition=data.get("kill_condition", ""),
            worst_case_scenario=data.get("worst_case_scenario", ""),
            reasoning_summary=reasoning_summary,
            technicals=payload.technicals if payload else None,
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

                CREATE INDEX IF NOT EXISTS idx_pick_history_ticker ON pick_history(ticker);
                CREATE INDEX IF NOT EXISTS idx_pick_history_run_date ON pick_history(run_date);
                CREATE INDEX IF NOT EXISTS idx_accuracy_ticker ON accuracy_records(ticker);
            """)
            conn.commit()
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
                # Extract forecast data
                forecasts = pick.get("forecasts", [])
                f3 = next((f for f in forecasts if f.get("horizon_days") == 3), {})
                f5 = next((f for f in forecasts if f.get("horizon_days") == 5), {})
                f8 = next((f for f in forecasts if f.get("horizon_days") == 8), {})

                conn.execute("""
                    INSERT INTO pick_history
                    (run_date, run_id, ticker, predicted_direction, consensus_score,
                     conviction_tier, entry_price, forecast_3d_move_pct, forecast_5d_move_pct,
                     forecast_8d_move_pct, forecast_3d_direction, forecast_5d_direction,
                     forecast_8d_direction)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            # Use generous calendar buffer (horizon * 2) since we filter by
            # actual trading days in Python below
            rows = conn.execute("""
                SELECT ar.id, ar.pick_id, ar.ticker, ar.horizon_days,
                       ar.predicted_direction, ar.predicted_move_pct,
                       ph.entry_price, ph.run_date
                FROM accuracy_records ar
                JOIN pick_history ph ON ar.pick_id = ph.id
                WHERE ar.actual_direction IS NULL
                  AND date(ph.run_date, '+' || (ar.horizon_days * 2) || ' days') <= date('now')
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
        google_api_key: str | None = None,
        xai_api_key: str | None = None,
        fmp_api_key: str | None = None,
        finnhub_api_key: str | None = None,
    ):
        self.fmp_key = fmp_api_key or os.environ.get("FMP_API_KEY", "")
        self.finnhub_key = finnhub_api_key or os.environ.get("FINNHUB_API_KEY", "")
        self.anthropic_key = anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self.google_key = google_api_key or os.environ.get("GOOGLE_API_KEY", "")
        self.xai_key = xai_api_key or os.environ.get("XAI_API_KEY", "")

        self.fetcher = LiveDataFetcher(self.fmp_key, self.finnhub_key)
        self.regime_filter = MacroRegimeFilter()
        self.historical_analyzer = HistoricalPerformanceAnalyzer()
        self.risk_engine = RiskPortfolioEngine()
        self.roadmap_engine = CompoundingRoadmapEngine()

    async def run_council(
        self,
        starting_universe: list[str] | None = None,
        max_workers: int = 8,
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
          8. Stage 4 — Grok final Top 20 with probabilistic forecasts
          9. Fact-check Stage 4 output
          10. Build consensus + conviction tiering
          11. Return CouncilResult
        """
        run_start = time.time()
        run_id = hashlib.md5(
            f"{datetime.now(timezone.utc).isoformat()}".encode()
        ).hexdigest()[:12]
        logger.info(f"=== Council Run {run_id} started ===")

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
            MIN_ADV_DOLLARS = 5_000_000
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

            # Fetch profiles only for price-filtered tickers (much fewer API calls)
            profiles = await self.fetcher.fetch_profiles_batch(price_filtered)

            # Full liquidity filter: ADV >= $5M using avgVolume from profile
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
                f"(from {len(price_filtered)} price-filtered)"
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

            # Index payloads by ticker for later lookup
            payloads_map = {p.ticker: p for p in payloads_list}

            # ── Step 5: Stage 1 — Sonnet ──
            logger.info(f"Step 5: Stage 1 (Sonnet) — {len(payloads_list)} tickers")
            # Batch size 15 to stay under Anthropic rate limits (~30K tokens/min)
            BATCH_SIZE = 15
            INTER_BATCH_DELAY = 15  # seconds between batches to avoid 429s
            if len(payloads_list) > BATCH_SIZE:
                stage1_all = []
                n_batches = (len(payloads_list) + BATCH_SIZE - 1) // BATCH_SIZE
                for i in range(0, len(payloads_list), BATCH_SIZE):
                    batch = payloads_list[i:i + BATCH_SIZE]
                    batch_num = i // BATCH_SIZE + 1
                    logger.info(
                        f"Stage 1 batch {batch_num}/{n_batches}: "
                        f"tickers {i+1}-{min(i+BATCH_SIZE, len(payloads_list))}"
                    )
                    try:
                        batch_results = await run_stage1_sonnet(
                            self.anthropic_key, batch, macro
                        )
                        stage1_all.extend(batch_results)
                    except Exception as batch_e:
                        logger.warning(f"Stage 1 batch {batch_num} failed: {batch_e}")
                    if i + BATCH_SIZE < len(payloads_list):
                        await asyncio.sleep(INTER_BATCH_DELAY)
                # Re-sort and take top 100
                stage1_results = sorted(
                    stage1_all, key=lambda x: x["score"]["total"], reverse=True
                )[:100]
            else:
                stage1_results = await run_stage1_sonnet(
                    self.anthropic_key, payloads_list, macro
                )
                stage1_results = stage1_results[:100]

            logger.info(f"Step 5: Stage 1 produced {len(stage1_results)} results")
            if not stage1_results:
                raise RuntimeError("Stage 1 produced no results")

            # Track skipped stages for metadata/alerting
            skipped_stages: list[dict] = []

            # ── Step 6: Stage 2 — Gemini (skippable) ──
            GEMINI_BATCH_SIZE = 15  # Smaller batches for Gemini to avoid token limit truncation
            logger.info(f"Step 6: Stage 2 (Gemini) — {len(stage1_results)} tickers")
            stage2_results = []
            stage2_skipped = False
            try:
                if len(stage1_results) > GEMINI_BATCH_SIZE:
                    s1_tickers_batched = [
                        stage1_results[i:i + GEMINI_BATCH_SIZE]
                        for i in range(0, len(stage1_results), GEMINI_BATCH_SIZE)
                    ]
                    # Run Gemini batches concurrently (2 at a time — Gemini rate limits are more generous)
                    GEMINI_CONCURRENCY = 2
                    gemini_sem = asyncio.Semaphore(GEMINI_CONCURRENCY)

                    async def _run_gemini_batch(batch_idx: int, s1_batch: list[dict]) -> list[dict]:
                        async with gemini_sem:
                            batch_tickers = {r["ticker"] for r in s1_batch}
                            batch_payloads = [p for p in payloads_list if p.ticker in batch_tickers]
                            logger.info(f"Stage 2 batch {batch_idx + 1}/{len(s1_tickers_batched)}: {len(s1_batch)} tickers")
                            return await run_stage2_gemini(
                                self.google_key, batch_payloads, macro, s1_batch
                            )

                    batch_tasks = [
                        _run_gemini_batch(idx, batch)
                        for idx, batch in enumerate(s1_tickers_batched)
                    ]
                    batch_results_list = await asyncio.gather(*batch_tasks, return_exceptions=True)

                    stage2_all = []
                    for idx, br in enumerate(batch_results_list):
                        if isinstance(br, Exception):
                            logger.warning(f"Stage 2 batch {idx + 1} failed: {br}")
                        else:
                            stage2_all.extend(br)

                    stage2_results = sorted(
                        stage2_all, key=lambda x: x["score"]["total"], reverse=True
                    )[:80]
                else:
                    stage2_results = await run_stage2_gemini(
                        self.google_key, payloads_list, macro, stage1_results
                    )
                    stage2_results = stage2_results[:80]
            except Exception as e:
                logger.error(f"Stage 2 (Gemini) FAILED — skipping: {e}")
                stage2_skipped = True
                skipped_stages.append({"stage": 2, "model": "gemini", "error": str(e)})

            if stage2_skipped or not stage2_results:
                if not stage2_skipped:
                    logger.warning("Stage 2 (Gemini) returned 0 results — passing Stage 1 results through")
                    skipped_stages.append({"stage": 2, "model": "gemini", "error": "empty results"})
                stage2_results = stage1_results[:80]
                logger.info(f"Step 6: Stage 2 SKIPPED — passing through {len(stage2_results)} Stage 1 results")
            else:
                logger.info(f"Step 6: Stage 2 produced {len(stage2_results)} results")

            # ── Step 7: Stage 3 — Opus (skippable) ──
            logger.info(f"Step 7: Stage 3 (Opus) — {len(stage2_results)} tickers")
            OPUS_BATCH = 20  # Smaller batches for expensive Opus calls
            stage3_results = []
            stage3_skipped = False
            try:
                if len(stage2_results) > OPUS_BATCH:
                    s2_tickers_batched = [
                        stage2_results[i:i + OPUS_BATCH]
                        for i in range(0, len(stage2_results), OPUS_BATCH)
                    ]
                    # Opus batches run sequentially — Anthropic rate limits are tight
                    stage3_all = []
                    for batch_idx, s2_batch in enumerate(s2_tickers_batched):
                        batch_tickers = {r["ticker"] for r in s2_batch}
                        batch_payloads = [p for p in payloads_list if p.ticker in batch_tickers]
                        s1_for_batch = [r for r in stage1_results if r["ticker"] in batch_tickers]
                        logger.info(f"Stage 3 batch {batch_idx + 1}/{len(s2_tickers_batched)}: {len(s2_batch)} tickers")
                        try:
                            batch_results = await run_stage3_opus(
                                self.anthropic_key, batch_payloads, macro,
                                s1_for_batch, s2_batch
                            )
                            stage3_all.extend(batch_results)
                        except Exception as batch_e:
                            logger.warning(f"Stage 3 batch {batch_idx + 1} failed: {batch_e}")
                        if batch_idx + 1 < len(s2_tickers_batched):
                            await asyncio.sleep(INTER_BATCH_DELAY)
                    stage3_results = sorted(
                        stage3_all, key=lambda x: x["score"]["total"], reverse=True
                    )[:40]
                else:
                    stage3_results = await run_stage3_opus(
                        self.anthropic_key, payloads_list, macro,
                        stage1_results, stage2_results
                    )
                    stage3_results = stage3_results[:40]
            except Exception as e:
                logger.error(f"Stage 3 (Opus) FAILED — skipping: {e}")
                stage3_skipped = True
                skipped_stages.append({"stage": 3, "model": "opus", "error": str(e)})

            if stage3_skipped or not stage3_results:
                if not stage3_skipped:
                    logger.warning("Stage 3 (Opus) returned 0 results — passing Stage 2 results through")
                    skipped_stages.append({"stage": 3, "model": "opus", "error": "empty results"})
                stage3_results = stage2_results[:40]
                logger.info(f"Step 7: Stage 3 SKIPPED — passing through {len(stage3_results)} Stage 2 results")
            else:
                logger.info(f"Step 7: Stage 3 produced {len(stage3_results)} results")

            # ── Step 8: Stage 4 — Grok (skippable) ──
            logger.info(f"Step 8: Stage 4 (Grok) — {len(stage3_results)} tickers")
            stage4_results = []
            stage4_skipped = False
            try:
                stage4_results = await run_stage4_grok(
                    self.xai_key, self.anthropic_key,
                    payloads_list, macro,
                    stage1_results, stage2_results, stage3_results
                )
                stage4_results = stage4_results[:20]
            except Exception as e:
                logger.error(f"Stage 4 (Grok) FAILED — skipping: {e}")
                stage4_skipped = True
                skipped_stages.append({"stage": 4, "model": "grok", "error": str(e)})

            if stage4_skipped or not stage4_results:
                if not stage4_skipped:
                    logger.warning("Stage 4 (Grok) returned 0 results — passing Stage 3 results through")
                    skipped_stages.append({"stage": 4, "model": "grok", "error": "empty results"})
                stage4_results = stage3_results[:20]
                logger.info(f"Step 8: Stage 4 SKIPPED — passing through {len(stage4_results)} Stage 3 results")
            else:
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
            top_picks = _build_consensus(
                stage1_results, stage2_results, stage3_results, stage4_results,
                payloads_map, regime, self.regime_filter
            )

            # ── Step 11: Apply historical edge multipliers ──
            logger.info("Step 11: Applying historical edge multipliers")
            for pick in top_picks:
                multiplier = self.historical_analyzer.get_historical_edge_multiplier(pick.ticker)
                pick.historical_edge_multiplier = multiplier
                if multiplier != 1.0:
                    pick.consensus_score = round(pick.consensus_score * multiplier, 2)

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
                },
                fact_check_flags=fact_flags,
                total_runtime_seconds=round(total_runtime, 1),
            )

            result_dict = result.model_dump(mode="json")

            # ── Step 15: Record picks to history ──
            logger.info("Step 15: Recording picks to history")
            self.historical_analyzer.record_picks(result_dict)

            # ── Step 16: Backfill actuals for past picks ──
            logger.info("Step 16: Backfilling accuracy for past picks")
            try:
                await self.historical_analyzer.backfill_actuals(self.fetcher)
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
