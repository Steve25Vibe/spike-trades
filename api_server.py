"""
api_server.py
FastAPI wrapper for the Canadian LLM Council Brain.

Endpoints:
  POST /run-council          → trigger full council pipeline
  POST /run-council-mapped   → trigger + return Prisma-compatible mapped output
  GET  /latest-output        → return last saved council JSON
  GET  /latest-output-mapped → return last output mapped to Prisma schema
  GET  /health               → status check
  POST /render-email         → render HTML email from latest output
  POST /spike-it             → live intraday health check (SuperGrok)

Run:
  uvicorn api_server:app --host 0.0.0.0 --port 8100 --reload
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
import aiohttp
import ssl
import certifi

load_dotenv(override=True)

# ── FMP config for Spike It ──────────────────────────────────────────
FMP_BASE = "https://financialmodelingprep.com/stable"
FMP_API_KEY = os.environ.get("FMP_API_KEY", "")

from canadian_llm_council_brain import CanadianStockCouncilBrain, _call_grok, _extract_json, _call_anthropic
from canadian_portfolio_interface import CanadianPortfolioInterface

# ── Logging ──────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("api_server")

# ── App ──────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Spike Trades Council API",
    description="FastAPI wrapper for the Canadian LLM Council Brain",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://spiketrades.ca"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── State ────────────────────────────────────────────────────────────────

OUTPUT_DIR = Path("/app/data") if Path("/app/data").exists() else Path(__file__).parent
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
LATEST_OUTPUT_FILE = OUTPUT_DIR / "latest_council_output.json"

# Track running state
_council_running = False
_last_run_time: Optional[float] = None
_last_run_error: Optional[str] = None
_run_progress: "ProgressTracker | None" = None
_last_completed_run: Optional[dict] = None


# ── ProgressTracker ──────────────────────────────────────────────────────


class ProgressTracker:
    """Tracks council run progress for the /run-status endpoint."""

    STAGE_ORDER = ["pre_filter", "stage1_sonnet", "stage2_gemini", "stage3_opus", "stage4_grok", "consensus"]

    def __init__(self, trigger: str = "manual"):
        self.data: dict = {
            "running": True,
            "trigger": trigger,
            "started_at": datetime.now(ZoneInfo("America/Halifax")).isoformat(),
            "current_stage": None,
            "stages": {s: {"status": "pending"} for s in self.STAGE_ORDER},
            "skipped_stages": [],
            "elapsed_s": 0,
        }
        self._start_time = time.time()
        self._stage_start: float | None = None

    def start_stage(self, stage: str, **kwargs):
        self.data["current_stage"] = stage
        self.data["stages"][stage] = {"status": "running", **kwargs}
        self._stage_start = time.time()
        self._update_elapsed()

    def update_batch(self, stage: str, batches_done: int):
        if stage in self.data["stages"]:
            self.data["stages"][stage]["batches_done"] = batches_done
        self._update_elapsed()

    def complete_stage(self, stage: str, **kwargs):
        duration = round(time.time() - self._stage_start) if self._stage_start else 0
        self.data["stages"][stage] = {"status": "complete", "duration_s": duration, **kwargs}
        self._stage_start = None
        self._update_elapsed()

    def skip_stage(self, stage: str, reason: str):
        duration = round(time.time() - self._stage_start) if self._stage_start else 0
        self.data["stages"][stage] = {"status": "skipped", "reason": reason, "duration_s": duration}
        self.data["skipped_stages"].append(stage)
        self._stage_start = None
        self._update_elapsed()

    def finish(self, picks: int):
        self.data["running"] = False
        self.data["current_stage"] = None
        self._update_elapsed()
        return {
            "trigger": self.data["trigger"],
            "completed_at": datetime.now(ZoneInfo("America/Halifax")).isoformat(),
            "total_duration_s": self.data["elapsed_s"],
            "picks": picks,
            "skipped_stages": self.data["skipped_stages"],
            "stages_summary": {k: v for k, v in self.data["stages"].items()},
        }

    def _update_elapsed(self):
        self.data["elapsed_s"] = round(time.time() - self._start_time)

    def to_dict(self) -> dict:
        self._update_elapsed()
        return dict(self.data)


# ── Helpers ──────────────────────────────────────────────────────────────


def _get_brain() -> CanadianStockCouncilBrain:
    """Instantiate the brain with env keys."""
    return CanadianStockCouncilBrain(
        anthropic_api_key=os.environ["ANTHROPIC_API_KEY"],
        xai_api_key=os.environ.get("XAI_API_KEY", ""),
        fmp_api_key=os.environ["FMP_API_KEY"],
        finnhub_api_key=os.environ.get("FINNHUB_API_KEY", ""),
    )


def _load_latest_output() -> dict | None:
    """Load latest council output from disk."""
    if LATEST_OUTPUT_FILE.exists():
        return json.loads(LATEST_OUTPUT_FILE.read_text())
    # Fall back to session4 output for testing
    fallback = OUTPUT_DIR / "session4_output.json"
    if fallback.exists():
        return json.loads(fallback.read_text())
    return None


def _map_to_prisma(council_output: dict) -> dict:
    """
    Map Python brain's CouncilResult JSON → Prisma-compatible shape for
    DailyReport + Spike[] + CouncilLog creation.

    The Next.js analyzer.ts calls this endpoint and uses the mapped output
    to create database records via Prisma.
    """
    macro = council_output.get("macro_context", {})
    picks = council_output.get("top_picks", [])
    risk = council_output.get("risk_summary", {})
    roadmap = council_output.get("daily_roadmap", {})
    run_date = council_output.get("run_date", datetime.now(ZoneInfo("America/Halifax")).strftime("%Y-%m-%d"))

    # Map regime: Python uses RISK_ON/RISK_OFF/COMMODITY_BOOM/COMMODITY_BUST/NEUTRAL
    # Prisma uses bull/bear/neutral/volatile
    regime_map = {
        "RISK_ON": "bull",
        "RISK_OFF": "bear",
        "COMMODITY_BOOM": "bull",
        "COMMODITY_BUST": "bear",
        "NEUTRAL": "neutral",
    }
    regime_str = regime_map.get(council_output.get("regime", "NEUTRAL"), "neutral")

    # Build allocation lookup from risk_summary
    allocation_by_ticker = {}
    for alloc in risk.get("allocation_table", []):
        allocation_by_ticker[alloc["ticker"]] = alloc

    # Map spikes
    mapped_spikes = []
    for pick in picks[:10]:
        ticker = pick["ticker"]
        technicals = pick.get("technicals", {})
        forecasts = pick.get("forecasts", [])
        alloc = allocation_by_ticker.get(ticker, {})

        # Extract predictions from forecasts array
        pred_3d = 0.0
        pred_5d = 0.0
        pred_8d = 0.0
        confidence = 50.0  # default

        for fc in forecasts:
            horizon = fc.get("horizon_days")
            move = fc.get("most_likely_move_pct", 0)
            prob = fc.get("direction_probability", 0.5)
            if horizon == 3:
                pred_3d = move
                confidence = prob * 100  # Use 3d probability as confidence
            elif horizon == 5:
                pred_5d = move
            elif horizon == 8:
                pred_8d = move

        # Determine exchange from ticker suffix
        exchange = "TSXV" if ".V" in ticker or "TSXV" in ticker else "TSX"

        # Build narrative from reasoning_summary + key_catalyst
        narrative_parts = []
        if pick.get("key_catalyst"):
            narrative_parts.append(pick["key_catalyst"])
        if pick.get("kill_condition"):
            narrative_parts.append(f"Kill condition: {pick['kill_condition']}")
        if pick.get("worst_case_scenario"):
            narrative_parts.append(f"Worst case: {pick['worst_case_scenario']}")
        if pick.get("earnings_flag"):
            narrative_parts.append("⚠ Earnings within prediction window")
        if pick.get("insider_signal") and pick["insider_signal"] > 0.3:
            narrative_parts.append("Insider buying detected")
        narrative = " | ".join(narrative_parts) if narrative_parts else ""

        # Map rubric scores — use the best available stage (prefer 4 > 3 > 2 > 1)
        # Not all stocks appear in every stage; fall back to earlier stages
        stage_scores = pick.get("stage_scores", {})
        best_stage = {}
        for stage_key in ["stage1", "stage2", "stage3", "stage4"]:
            s = stage_scores.get(stage_key, {})
            if s and s.get("total", 0) > 0:
                best_stage = s  # later stages overwrite earlier ones
        consensus = pick.get("consensus_score", 0)

        mapped_spikes.append({
            "rank": pick.get("rank", 0),
            "ticker": ticker,
            "name": pick.get("company_name", ticker),
            "sector": pick.get("sector", "Unknown"),
            "exchange": exchange,
            "price": pick.get("price", 0),
            "volume": int(technicals.get("volume_sma_20", 0) * technicals.get("relative_volume", 1)),
            "avgVolume": int(technicals.get("volume_sma_20", 0)),
            "marketCap": None,  # Not in brain output; frontend handles
            "spikeScore": consensus,
            # Map 5-category rubric from best available stage
            "momentumScore": best_stage.get("technical_momentum", 0),
            "volumeScore": technicals.get("relative_volume", 0) * 10,
            "technicalScore": best_stage.get("technical_momentum", 0),
            "macroScore": best_stage.get("options_volatility", 0),
            "sentimentScore": best_stage.get("sentiment_catalysts", 0),
            "shortInterest": None,
            "volatilityAdj": technicals.get("atr_14", 0) / max(pick.get("price", 1), 0.01) * 100,
            "sectorRotation": None,
            "patternMatch": best_stage.get("risk_reward", 0),
            "liquidityDepth": pick.get("sector_relative_strength"),
            "insiderSignal": pick.get("insider_signal"),
            "gapPotential": pick.get("analyst_upside_pct"),
            "convictionScore": best_stage.get("conviction", 0),
            "predicted3Day": pred_3d,
            "predicted5Day": pred_5d,
            "predicted8Day": pred_8d,
            "confidence": confidence,
            "narrative": narrative,
            "rsi": technicals.get("rsi_14"),
            "macd": technicals.get("macd_line"),
            "macdSignal": technicals.get("macd_signal"),
            "adx": technicals.get("adx_14"),
            "bollingerUpper": technicals.get("bollinger_upper"),
            "bollingerLower": technicals.get("bollinger_lower"),
            "ema3": None,  # Brain doesn't compute EMA3/8
            "ema8": None,
            "atr": technicals.get("atr_14"),
            # Extra fields for portfolio integration
            "stopLoss": alloc.get("stop_loss"),
            "shares": alloc.get("shares"),
            "positionPct": alloc.get("position_pct"),
            "dollarRisk": alloc.get("dollar_risk"),
            # Council-specific fields
            "convictionTier": pick.get("conviction_tier", "MEDIUM"),
            "stagesAppeared": pick.get("stages_appeared", 0),
            "killCondition": pick.get("kill_condition"),
            "worstCase": pick.get("worst_case_scenario"),
            "forecasts": forecasts,
            # Calibration data (from HistoricalCalibrationEngine)
            "historicalConfidence": round(cal.get("calibrated_confidence", 0) * 100, 1) if (cal := pick.get("calibration")) else None,
            "calibrationSamples": cal.get("sample_count") if (cal := pick.get("calibration")) else None,
            "overconfidenceFlag": cal.get("overconfidence_flag") if (cal := pick.get("calibration")) else None,
            # Learning engine adjustments
            "learningAdjustments": json.dumps(pick.get("learning_adjustments", {})) if pick.get("learning_adjustments") else None,
        })

    # Build council log
    stage_meta = council_output.get("stage_metadata", {})
    council_log = {
        "claudeAnalysis": {
            "sonnet": {"count": stage_meta.get("stage1_count", 0)},
            "gemini": {"count": stage_meta.get("stage2_count", 0)},
            "opus": {"count": stage_meta.get("stage3_count", 0)},
        },
        "grokAnalysis": {
            "count": stage_meta.get("stage4_count", 0),
        },
        "finalVerdict": {
            "topPicks": len(picks),
            "regime": council_output.get("regime"),
            "factCheckFlags": council_output.get("fact_check_flags", []),
        },
        "consensusScore": sum(p.get("consensus_score", 0) for p in picks) / max(len(picks), 1),
        "processingTime": int(council_output.get("total_runtime_seconds", 0) * 1000),
        "universeSize": council_output.get("universe_size", 0),
        "tickersScreened": council_output.get("tickers_screened", 0),
    }

    return {
        "dailyReport": {
            "date": run_date,
            "marketRegime": regime_str,
            "tsxLevel": macro.get("tsx_composite", 0),
            "tsxChange": macro.get("tsx_change_pct", 0),
            "oilPrice": macro.get("oil_wti", 0),
            "goldPrice": macro.get("gold_price", 0),
            "btcPrice": macro.get("btc_price", 0),
            "cadUsd": macro.get("cad_usd", 0),
            "councilLog": council_log,
        },
        "spikes": mapped_spikes,
        "councilLog": council_log,
        "riskSummary": risk,
        "dailyRoadmap": roadmap,
        # Pass through for email rendering
        "rawCouncilOutput": council_output,
    }


# ── Endpoints ────────────────────────────────────────────────────────────


class RunCouncilRequest(BaseModel):
    tickers: list[str] | None = None  # Optional custom ticker list


class SpikeItRequest(BaseModel):
    ticker: str
    entry_price: float
    user_id: str = ""       # empty = legacy/unauthenticated
    is_admin: bool = False


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "council_running": _council_running,
        "last_run_time": _last_run_time,
        "last_run_error": _last_run_error,
        "has_latest_output": LATEST_OUTPUT_FILE.exists(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/run-status")
async def run_status():
    """Return current council run progress or last completed run summary."""
    if _run_progress and _run_progress.data["running"]:
        result = _run_progress.to_dict()
    else:
        result = {
            "running": False,
            "trigger": None,
            "current_stage": None,
            "stages": {},
            "skipped_stages": [],
            "elapsed_s": 0,
        }
    result["last_completed_run"] = _last_completed_run
    return result


@app.get("/learning-state")
async def learning_state():
    """Return current learning mechanism states for admin panel."""
    try:
        from canadian_llm_council_brain import LearningEngine, DB_PATH
        le = LearningEngine(db_path=DB_PATH)
        states = le.get_mechanism_states()
        weights = le.compute_stage_weights()
        return {
            "success": True,
            "mechanisms": states,
            "current_stage_weights": weights,
        }
    except Exception as e:
        logger.error(f"Learning state failed: {e}", exc_info=True)
        return {"success": False, "error": str(e)}


@app.get("/fmp-health")
async def fmp_health():
    """Return FMP endpoint health from the most recent council run."""
    try:
        if not LATEST_OUTPUT_FILE.exists():
            return {"success": False, "error": "No council output available"}
        output = json.loads(LATEST_OUTPUT_FILE.read_text())
        if not output:
            return {"success": False, "error": "No council output available"}
        health = output.get("fmp_endpoint_health", {})
        run_date = output.get("run_date", "unknown")
        return {
            "success": True,
            "run_date": run_date,
            "endpoints": health,
        }
    except Exception as e:
        logger.error(f"FMP health check failed: {e}", exc_info=True)
        return {"success": False, "error": str(e)}


@app.get("/stage-analytics")
async def stage_analytics():
    """Return per-stage LLM performance analytics."""
    try:
        brain = _get_brain()
        return brain.historical_analyzer.get_stage_analytics()
    except Exception as e:
        logger.error(f"Stage analytics failed: {e}", exc_info=True)
        raise HTTPException(500, f"Stage analytics failed: {e}")


@app.post("/backfill-actuals")
async def backfill_actuals():
    """Backfill SQLite accuracy records for past picks, then rebuild calibration."""
    brain = _get_brain()
    try:
        updated = await brain.historical_analyzer.backfill_actuals(brain.fetcher)
        if updated:
            brain.calibration_engine.build_council_calibration()
        return {"success": True, "records_updated": updated}
    except Exception as e:
        logger.error(f"Backfill actuals failed: {e}", exc_info=True)
        raise HTTPException(500, f"Backfill actuals failed: {e}")
    finally:
        await brain.fetcher.close()


@app.post("/run-backtest")
async def run_backtest():
    """Trigger a 6-month historical backtest for calibration base rates.
    Takes ~10-20 minutes. Returns summary stats."""
    try:
        brain = _get_brain()
        result = await brain.calibration_engine.run_historical_backtest(brain.fetcher)
        return result
    except Exception as e:
        logger.error(f"Backtest failed: {e}", exc_info=True)
        raise HTTPException(500, f"Backtest failed: {e}")


@app.get("/calibration-status")
async def calibration_status():
    """Return calibration engine status."""
    try:
        brain = _get_brain()
        return brain.calibration_engine.get_calibration_status()
    except Exception as e:
        logger.error(f"Calibration status failed: {e}", exc_info=True)
        raise HTTPException(500, f"Calibration status failed: {e}")


@app.post("/run-council")
async def run_council(request: RunCouncilRequest | None = None, trigger: str = "manual"):
    """
    Trigger a full council pipeline run.
    Returns the raw CouncilResult JSON.
    """
    global _council_running, _last_run_time, _last_run_error, _run_progress, _last_completed_run

    if _council_running:
        raise HTTPException(409, "Council is already running")

    _council_running = True
    _last_run_error = None
    _run_progress = ProgressTracker(trigger=trigger)
    start = time.time()

    try:
        brain = _get_brain()
        tickers = request.tickers if request else None

        if tickers:
            result = await brain.run_council(starting_universe=tickers, tracker=_run_progress)
        else:
            result = await brain.run_council(tracker=_run_progress)

        # result is already a dict (run_council does model_dump internally)
        result_dict = result

        # Save to disk
        LATEST_OUTPUT_FILE.write_text(
            json.dumps(result_dict, indent=2, default=str)
        )

        _last_run_time = time.time() - start
        logger.info(f"Council completed in {_last_run_time:.1f}s")

        pick_count = len(result_dict.get("top_picks", []))
        _last_completed_run = _run_progress.finish(picks=pick_count)

        return result_dict

    except Exception as e:
        _last_run_error = str(e)
        logger.error(f"Council failed: {e}", exc_info=True)
        raise HTTPException(500, f"Council failed: {e}")

    finally:
        _council_running = False
        _run_progress = None


@app.post("/run-council-mapped")
async def run_council_mapped(request: RunCouncilRequest | None = None, trigger: str = "scheduled"):
    """
    Trigger council + return output mapped to Prisma schema.
    This is what analyzer.ts should call.
    """
    # Run the council first
    raw_result = await run_council(request, trigger=trigger)
    # Map to Prisma format
    return _map_to_prisma(raw_result)


@app.get("/latest-output")
async def latest_output():
    """Return the last saved council JSON."""
    data = _load_latest_output()
    if not data:
        raise HTTPException(404, "No council output found")
    return data


@app.get("/latest-output-mapped")
async def latest_output_mapped():
    """Return the last output mapped to Prisma-compatible format."""
    data = _load_latest_output()
    if not data:
        raise HTTPException(404, "No council output found")
    return _map_to_prisma(data)


@app.post("/render-email")
async def render_email():
    """
    Render HTML email from the latest council output.
    Returns raw HTML that can be sent via Resend.
    """
    data = _load_latest_output()
    if not data:
        raise HTTPException(404, "No council output found")

    renderer = CanadianPortfolioInterface()
    html = renderer.render(data, "html")
    return HTMLResponse(content=html)


@app.get("/render-email")
async def render_email_get():
    """GET version for browser preview."""
    data = _load_latest_output()
    if not data:
        raise HTTPException(404, "No council output found")

    renderer = CanadianPortfolioInterface()
    html = renderer.render(data, "html")
    return HTMLResponse(content=html)


# ── Spike It: Live Health Check ──────────────────────────────────────

_spike_it_data_cache: dict[str, dict] = {}      # {ticker: {"data": {...}, "timestamp": float}}
_spike_it_analysis_cache: dict[str, dict] = {}  # {"userId:ticker": {"result": {...}, "timestamp": float}}
SPIKE_IT_CACHE_TTL = 300  # 5 minutes

_spike_it_session: Optional[aiohttp.ClientSession] = None


async def _get_spike_session() -> aiohttp.ClientSession:
    """Get or create an aiohttp session for FMP calls."""
    global _spike_it_session
    if _spike_it_session is None or _spike_it_session.closed:
        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
        conn = aiohttp.TCPConnector(ssl=ssl_ctx, limit=10)
        _spike_it_session = aiohttp.ClientSession(
            connector=conn,
            timeout=aiohttp.ClientTimeout(total=15),
        )
    return _spike_it_session


async def _fmp_get_spike(path: str, params: dict | None = None) -> Any:
    """Make a GET request to FMP /stable/ API for Spike It."""
    session = await _get_spike_session()
    params = params or {}
    params["apikey"] = FMP_API_KEY
    url = f"{FMP_BASE}{path}"
    for attempt in range(3):
        try:
            async with session.get(url, params=params) as resp:
                if resp.status == 429:
                    wait = 5 * (2 ** attempt)
                    logger.warning(f"Spike It FMP {path} rate limited, retrying in {wait}s")
                    await asyncio.sleep(wait)
                    continue
                if resp.status != 200:
                    logger.error(f"Spike It FMP {path} returned {resp.status}")
                    return None
                return await resp.json()
        except Exception as e:
            logger.error(f"Spike It FMP {path} error: {e}")
            return None
    logger.error(f"Spike It FMP {path} exhausted retries after rate limiting")
    return None


def _calculate_vwap(bars: list[dict]) -> list[dict]:
    """Calculate VWAP from intraday OHLCV bars. Returns [{time, value}, ...]."""
    cumulative_tpv = 0.0
    cumulative_vol = 0.0
    vwap_points = []
    for bar in bars:
        typical = (bar["high"] + bar["low"] + bar["close"]) / 3
        vol = bar.get("volume", 0)
        if vol <= 0:
            vwap_points.append({"time": bar["time"], "value": round(vwap_points[-1]["value"], 4) if vwap_points else round(typical, 4)})
            continue
        cumulative_tpv += typical * vol
        cumulative_vol += vol
        vwap = cumulative_tpv / cumulative_vol
        vwap_points.append({"time": bar["time"], "value": round(vwap, 4)})
    return vwap_points


def _calculate_rsi(closes: list[float], period: int = 14) -> float | None:
    """Calculate RSI from a list of closing prices. Returns None if insufficient data."""
    if len(closes) < period + 1:
        return None
    gains = []
    losses = []
    for i in range(1, len(closes)):
        delta = closes[i] - closes[i - 1]
        gains.append(max(delta, 0))
        losses.append(max(-delta, 0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 1)


async def _fetch_spike_it_data(ticker: str) -> dict[str, Any] | None:
    """Fetch all FMP data needed for Spike It analysis. Returns assembled dict or None on critical failure."""
    quote_task = _fmp_get_spike("/batch-quote", {"symbols": ticker})
    bars_task = _fmp_get_spike(f"/historical-chart/5min/{ticker}")
    hist_task = _fmp_get_spike("/historical-price-eod/full", {"symbol": ticker, "limit": "15"})
    news_task = _fmp_get_spike("/news/stock", {"symbols": ticker, "limit": "5"})
    macro_task = _fmp_get_spike("/batch-quote", {"symbols": "USO,GLD,CADUSD=X,XIU.TO"})

    quote_data, bars_data, hist_data, news_data, macro_data = await asyncio.gather(
        quote_task, bars_task, hist_task, news_task, macro_task,
        return_exceptions=True,
    )

    if isinstance(quote_data, Exception) or not quote_data or len(quote_data) == 0:
        logger.error(f"Spike It: failed to fetch quote for {ticker}")
        return None
    quote = quote_data[0]

    # ── Process intraday bars (with daily fallback) ──
    today_bars = []
    intraday_available = False
    if not isinstance(bars_data, Exception) and bars_data and len(bars_data) >= 5:
        today_str = datetime.now(ZoneInfo("America/Halifax")).strftime("%Y-%m-%d")
        for bar in reversed(bars_data):
            bar_date = bar.get("date", "")[:10]
            if bar_date == today_str:
                try:
                    dt = datetime.fromisoformat(bar["date"])
                    ast_time = dt.astimezone(ZoneInfo("America/Halifax")).strftime("%H:%M")
                except Exception:
                    ast_time = bar["date"][11:16]
                today_bars.append({
                    "time": ast_time,
                    "open": bar["open"],
                    "high": bar["high"],
                    "low": bar["low"],
                    "close": bar["close"],
                    "volume": bar.get("volume", 0),
                })
        if len(today_bars) >= 3:
            intraday_available = True

    # Fallback: build synthetic bars from daily quote data
    if not intraday_available:
        logger.info(f"Spike It: no intraday bars for {ticker}, using daily quote fallback")
        o = quote.get("open", quote.get("price", 0))
        h = quote.get("dayHigh", quote.get("price", 0))
        l = quote.get("dayLow", quote.get("price", 0))
        c = quote.get("price", 0)
        v = quote.get("volume", 0)
        if not c:
            logger.error(f"Spike It: no price data available for {ticker}")
            return None
        # Simulate 3 bars: open, midday estimate, current
        mid_price = (o + c) / 2
        today_bars = [
            {"time": "10:30", "open": o, "high": max(o, mid_price), "low": min(o, mid_price), "close": mid_price, "volume": int(v * 0.4)},
            {"time": "13:00", "open": mid_price, "high": max(mid_price, h), "low": min(mid_price, l), "close": (mid_price + c) / 2, "volume": int(v * 0.3)},
            {"time": "now", "open": (mid_price + c) / 2, "high": h, "low": l, "close": c, "volume": int(v * 0.3)},
        ]

    vwap_points = _calculate_vwap(today_bars)
    current_vwap = vwap_points[-1]["value"] if vwap_points else None

    # Use FMP's daily VWAP if available and we're in fallback mode
    if not intraday_available and not isinstance(hist_data, Exception) and hist_data:
        fmp_vwap = hist_data[0].get("vwap")
        if fmp_vwap:
            current_vwap = fmp_vwap
            vwap_points = [{"time": b["time"], "value": fmp_vwap} for b in today_bars]

    # RSI: use historical daily closes if intraday unavailable
    if intraday_available:
        closes = [b["close"] for b in today_bars]
        rsi = _calculate_rsi(closes, 14)
    else:
        # Build closes from historical daily data for RSI
        daily_closes = []
        if not isinstance(hist_data, Exception) and hist_data:
            daily_closes = [d.get("close", 0) for d in reversed(hist_data) if d.get("close")]
        daily_closes.append(quote.get("price", 0))  # Add today
        rsi = _calculate_rsi(daily_closes, 14) if len(daily_closes) >= 15 else None

    avg_volume = None
    if not isinstance(hist_data, Exception) and hist_data and len(hist_data) > 0:
        volumes = [d.get("volume", 0) for d in hist_data[:10] if d.get("volume", 0) > 0]
        if volumes:
            avg_volume = sum(volumes) / len(volumes)
    today_volume = quote.get("volume", 0)
    rel_volume = round(today_volume / avg_volume, 2) if avg_volume and avg_volume > 0 else None

    current_price = quote.get("price", today_bars[-1]["close"])
    vwap_distance = round(current_price - current_vwap, 4) if current_vwap else None
    above_vwap = vwap_distance > 0 if vwap_distance is not None else None

    data_limitations = []
    if not intraday_available:
        data_limitations.append("Intraday bars unavailable — using daily quote data (VWAP is approximate)")
    if rsi is None:
        data_limitations.append("Insufficient data for 14-period RSI calculation")
    if rel_volume is None:
        data_limitations.append("Could not calculate relative volume (missing historical data)")
    if not isinstance(news_data, Exception) and not news_data:
        data_limitations.append("News data unavailable")
    if isinstance(news_data, Exception):
        news_data = []
        data_limitations.append("News data unavailable")

    macro = {}
    if not isinstance(macro_data, Exception) and macro_data:
        for item in macro_data:
            sym = item.get("symbol", "")
            if sym == "USO":
                macro["oil"] = {"price": item.get("price"), "changePct": item.get("changesPercentage")}
            elif sym == "GLD":
                macro["gold"] = {"price": item.get("price"), "changePct": item.get("changesPercentage")}
            elif "CAD" in sym:
                macro["cadUsd"] = item.get("price")
            elif sym == "XIU.TO":
                macro["tsx"] = {"price": item.get("price"), "changePct": item.get("changesPercentage")}
    else:
        data_limitations.append("Macro context unavailable")

    clean_news = []
    if not isinstance(news_data, Exception) and news_data:
        for n in news_data[:5]:
            clean_news.append({
                "title": n.get("title", ""),
                "publishedDate": n.get("publishedDate", ""),
                "sentiment": n.get("sentiment", ""),
                "text": (n.get("text", "") or "")[:200],
            })

    return {
        "ticker": ticker,
        "quote": quote,
        "today_bars": today_bars,
        "vwap_points": vwap_points,
        "current_vwap": current_vwap,
        "rsi": rsi,
        "rel_volume": rel_volume,
        "today_volume": today_volume,
        "avg_volume": avg_volume,
        "current_price": current_price,
        "vwap_distance": vwap_distance,
        "above_vwap": above_vwap,
        "news": clean_news,
        "macro": macro,
        "data_limitations": data_limitations,
    }


SPIKE_IT_SYSTEM_PROMPT = """You are SuperGrok Heavy, elite real-time TSX intraday analyst.

You will receive a JSON payload containing live FMP data for a single TSX stock that the user holds in an active position. Your job is to perform a quick health check: should they hold for more upside today, or has momentum faded?

You MUST respond with valid JSON matching this exact schema — no markdown, no commentary outside the JSON:

{
  "continuation_probability": <int 0-100>,
  "light": "<green|yellow|red>",
  "summary": "<one sentence, max 80 chars>",
  "expected_move": {
    "direction": "<up|down|flat>",
    "dollar_amount": <float>,
    "target_price": <float>
  },
  "support_price": <float>,
  "support_label": "<string, e.g. 'VWAP' or 'High-volume node'>",
  "stop_loss_price": <float>,
  "stop_loss_label": "<string>",
  "rsi_assessment": "<string, e.g. 'Healthy' or 'Overbought'>",
  "risk_warning": "<1-2 sentences, main risk for rest of day>",
  "data_limitations": ["<any honest caveats about data quality>"]
}

Traffic light rules:
- GREEN (60-100%): Price above VWAP, RSI < 75, volume confirming, no bearish divergence
- YELLOW (40-59%): Mixed signals — near VWAP, fading volume, or RSI approaching overbought
- RED (0-39%): Below VWAP, bearish divergence, volume dying, or adverse catalyst

Ground every number in the FMP data provided. Do not hallucinate price levels or invent catalysts. If data is insufficient for a field, say so in data_limitations."""


def _build_spike_it_user_prompt(data: dict, entry_price: float) -> str:
    """Build the user prompt for Grok from assembled FMP data."""
    quote = data["quote"]
    current_price = data["current_price"]
    change_pct = quote.get("changesPercentage", 0)
    prev_close = quote.get("previousClose", 0)
    pnl = current_price - entry_price
    pnl_pct = (pnl / entry_price * 100) if entry_price > 0 else 0

    compact_bars = json.dumps(
        [{"t": b["time"], "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"], "v": b["volume"]}
         for b in data["today_bars"]],
        separators=(",", ":"),
    )

    macro_lines = []
    macro = data.get("macro", {})
    if "oil" in macro:
        macro_lines.append(f"- Oil (USO): ${macro['oil']['price']} ({macro['oil']['changePct']}%)")
    if "gold" in macro:
        macro_lines.append(f"- Gold (GLD): ${macro['gold']['price']} ({macro['gold']['changePct']}%)")
    if "cadUsd" in macro:
        macro_lines.append(f"- CAD/USD: {macro['cadUsd']}")
    if "tsx" in macro:
        macro_lines.append(f"- TSX (XIU.TO): ${macro['tsx']['price']} ({macro['tsx']['changePct']}%)")
    macro_block = "\n".join(macro_lines) if macro_lines else "Unavailable"

    news_block = json.dumps(data.get("news", []), separators=(",", ":"), default=str)

    return f"""Ticker: {data['ticker']}
Current Price: ${current_price} ({change_pct:+.2f}% today)
Previous Close: ${prev_close}
Today's Volume: {data['today_volume']:,} (Relative: {data['rel_volume']}x 10-day avg)

Intraday 5-min bars (OHLCV): {compact_bars}

Calculated Metrics:
- VWAP: ${data['current_vwap']}
- 14-period RSI (5-min): {data['rsi'] if data['rsi'] is not None else 'N/A'}
- Price vs VWAP: {'above' if data['above_vwap'] else 'below'} by ${abs(data['vwap_distance']) if data['vwap_distance'] else 'N/A'}

Recent News: {news_block}

Macro Context:
{macro_block}

Position context: User entered at ${entry_price:.2f}, currently {'up' if pnl >= 0 else 'down'} ${abs(pnl):.2f} ({pnl_pct:+.1f}%)."""


@app.post("/spike-it")
async def spike_it(request: SpikeItRequest):
    """Live intraday health check for a single ticker — per-user isolated."""
    ticker = request.ticker.upper().strip()
    entry_price = request.entry_price
    user_id = request.user_id or "anon"
    is_admin = request.is_admin

    now = time.time()

    # ── Analysis cache (per-user) — admin always gets fresh ──
    analysis_key = f"{user_id}:{ticker}"
    if not is_admin and analysis_key in _spike_it_analysis_cache:
        cached = _spike_it_analysis_cache[analysis_key]
        if now - cached["timestamp"] < SPIKE_IT_CACHE_TTL:
            result = cached["result"].copy()
            result["cached"] = True
            result["cache_age_seconds"] = int(now - cached["timestamp"])
            return JSONResponse(content=result)

    # ── Data cache (global per-ticker) — FMP market data ──
    if ticker in _spike_it_data_cache:
        data_cached = _spike_it_data_cache[ticker]
        if now - data_cached["timestamp"] < SPIKE_IT_CACHE_TTL:
            data = data_cached["data"]
        else:
            data = await _fetch_spike_it_data(ticker)
            if data is not None:
                _spike_it_data_cache[ticker] = {"data": data, "timestamp": now}
    else:
        data = await _fetch_spike_it_data(ticker)
        if data is not None:
            _spike_it_data_cache[ticker] = {"data": data, "timestamp": now}

    if data is None:
        raise HTTPException(502, f"Failed to fetch market data for {ticker}")

    # ── LLM analysis (per-user entry price) ──
    user_prompt = _build_spike_it_user_prompt(data, entry_price)
    xai_key = os.environ.get("XAI_API_KEY", "")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")

    grok_raw = None
    used_model = "grok-4-0709"

    if xai_key:
        try:
            grok_raw, _ = await _call_grok(
                api_key=xai_key,
                model="grok-4-0709",
                system_prompt=SPIKE_IT_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                max_tokens=2048,
                temperature=0.3,
            )
        except Exception as e:
            logger.warning(f"Spike It: Grok failed for {ticker}, falling back to Opus: {e}")

    if not grok_raw and anthropic_key:
        try:
            used_model = "claude-opus-4-6"
            grok_raw, _ = await _call_anthropic(
                api_key=anthropic_key,
                model="claude-opus-4-6",
                system_prompt=SPIKE_IT_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                max_tokens=2048,
                temperature=0.3,
            )
        except Exception as e:
            logger.error(f"Spike It: Opus fallback also failed for {ticker}: {e}")
            raise HTTPException(502, f"LLM analysis failed for {ticker}")

    if not grok_raw:
        raise HTTPException(502, f"No LLM API keys available for Spike It")

    parsed = _extract_json(grok_raw)
    if parsed is None:
        logger.error(f"Spike It: failed to parse Grok JSON for {ticker}")
        raise HTTPException(502, f"Failed to parse analysis for {ticker}")

    ast_now = datetime.now(ZoneInfo("America/Halifax"))
    chart_bars = [{"time": b["time"], "close": b["close"]} for b in data["today_bars"]]

    result = {
        "ticker": ticker,
        "timestamp": ast_now.isoformat(),
        "cached": False,
        "model": used_model,
        "signal": {
            "continuation_probability": parsed.get("continuation_probability", 50),
            "light": parsed.get("light", "yellow"),
            "summary": parsed.get("summary", "Analysis complete"),
        },
        "expected_move": parsed.get("expected_move", {"direction": "flat", "dollar_amount": 0, "target_price": data["current_price"]}),
        "levels": {
            "support": {"price": parsed.get("support_price", data.get("current_vwap", 0)), "label": parsed.get("support_label", "VWAP")},
            "stop_loss": {"price": parsed.get("stop_loss_price", 0), "label": parsed.get("stop_loss_label", "")},
            "rsi": {"value": data.get("rsi", 0), "label": parsed.get("rsi_assessment", "N/A")},
        },
        "risk_warning": parsed.get("risk_warning", "No specific risks identified."),
        "relative_volume": data.get("rel_volume"),
        "chart": {
            "bars": chart_bars,
            "vwap": data.get("vwap_points", []),
        },
        "data_limitations": list(set(data.get("data_limitations", []) + parsed.get("data_limitations", []))),
    }

    # Always write to analysis cache (even admin — prevents rapid double-click)
    _spike_it_analysis_cache[analysis_key] = {"result": result, "timestamp": now}

    return JSONResponse(content=result)


@app.on_event("shutdown")
async def _close_spike_session():
    global _spike_it_session
    if _spike_it_session and not _spike_it_session.closed:
        await _spike_it_session.close()


# ── Main ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100)
