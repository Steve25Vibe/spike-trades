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

load_dotenv(override=True)

from canadian_llm_council_brain import CanadianStockCouncilBrain
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


# ── Helpers ──────────────────────────────────────────────────────────────


def _get_brain() -> CanadianStockCouncilBrain:
    """Instantiate the brain with env keys."""
    return CanadianStockCouncilBrain(
        anthropic_api_key=os.environ["ANTHROPIC_API_KEY"],
        google_api_key=os.environ["GOOGLE_API_KEY"],
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


@app.get("/stage-analytics")
async def stage_analytics():
    """Return per-stage LLM performance analytics."""
    try:
        brain = _get_brain()
        return brain.historical_analyzer.get_stage_analytics()
    except Exception as e:
        logger.error(f"Stage analytics failed: {e}", exc_info=True)
        raise HTTPException(500, f"Stage analytics failed: {e}")


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
async def run_council(request: RunCouncilRequest | None = None):
    """
    Trigger a full council pipeline run.
    Returns the raw CouncilResult JSON.
    """
    global _council_running, _last_run_time, _last_run_error

    if _council_running:
        raise HTTPException(409, "Council is already running")

    _council_running = True
    _last_run_error = None
    start = time.time()

    try:
        brain = _get_brain()
        tickers = request.tickers if request else None

        if tickers:
            result = await brain.run_council(starting_universe=tickers)
        else:
            result = await brain.run_council()

        # result is already a dict (run_council does model_dump internally)
        result_dict = result

        # Save to disk
        LATEST_OUTPUT_FILE.write_text(
            json.dumps(result_dict, indent=2, default=str)
        )

        _last_run_time = time.time() - start
        logger.info(f"Council completed in {_last_run_time:.1f}s")

        return result_dict

    except Exception as e:
        _last_run_error = str(e)
        logger.error(f"Council failed: {e}", exc_info=True)
        raise HTTPException(500, f"Council failed: {e}")

    finally:
        _council_running = False


@app.post("/run-council-mapped")
async def run_council_mapped(request: RunCouncilRequest | None = None):
    """
    Trigger council + return output mapped to Prisma schema.
    This is what analyzer.ts should call.
    """
    # Run the council first
    raw_result = await run_council(request)
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


# ── Main ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100)
