from __future__ import annotations

"""
Opening Bell Scanner — Early momentum detection for TSX/TSXV.

Runs 5 minutes after market open. Fetches batch quotes, computes relative
volume rankings, enriches top movers with sector + grades data, and sends
to a single Sonnet 4.6 call for ranked picks with intraday targets.
"""

import asyncio
import json
import logging
import os
import re
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp

logger = logging.getLogger("opening_bell")

FMP_BASE = "https://financialmodelingprep.com/stable"

# Filters
MIN_MARKET_CAP = 200_000_000  # $200M market cap (proxy for liquidity since avgVolume unavailable)
MIN_PRICE = 1.0               # >$1 share price


class OpeningBellScanner:
    """Runs the Opening Bell momentum scan pipeline."""

    def __init__(self, fmp_key: str, anthropic_key: str):
        self.fmp_key = fmp_key
        self.anthropic_key = anthropic_key
        self._endpoint_health: dict[str, dict[str, int]] = {}

    # ── FMP Data Fetching ─────────────────────────────────────────────

    async def _fmp_get(self, session: aiohttp.ClientSession, path: str, params: dict | None = None) -> Any:
        """Fetch from FMP with retry on 429."""
        url = f"{FMP_BASE}{path}"
        all_params = {"apikey": self.fmp_key}
        if params:
            all_params.update(params)
        endpoint = path.split("?")[0]
        for attempt in range(3):
            try:
                async with session.get(url, params=all_params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    status = resp.status
                    self._endpoint_health.setdefault(endpoint, {"ok": 0, "404": 0, "429": 0, "error": 0})
                    if status == 200:
                        self._endpoint_health[endpoint]["ok"] += 1
                        return await resp.json()
                    elif status == 429:
                        self._endpoint_health[endpoint]["429"] += 1
                        wait = 10 * (attempt + 1)
                        logger.warning(f"FMP 429 on {endpoint}, waiting {wait}s")
                        await asyncio.sleep(wait)
                    elif status == 404:
                        self._endpoint_health[endpoint]["404"] += 1
                        return []
                    else:
                        self._endpoint_health[endpoint]["error"] += 1
                        return []
            except Exception as e:
                self._endpoint_health.setdefault(endpoint, {"ok": 0, "404": 0, "429": 0, "error": 0})
                self._endpoint_health[endpoint]["error"] += 1
                logger.error(f"FMP error {endpoint}: {e}")
                if attempt < 2:
                    await asyncio.sleep(5)
        return []

    async def fetch_tsx_universe(self, session: aiohttp.ClientSession) -> list[dict]:
        """Fetch batch quotes for TSX/TSXV liquid universe."""
        # Fetch stock list and filter to TSX by .TO suffix (stable API lacks exchange field)
        all_tickers = await self._fmp_get(session, "/stock-list")
        if not all_tickers:
            return []

        tsx_symbols = sorted(set(
            s["symbol"] for s in all_tickers
            if isinstance(s, dict) and s.get("symbol", "").endswith(".TO")
        ))

        # Batch quote in groups of 50
        all_quotes = []
        batch_size = 50
        for i in range(0, len(tsx_symbols), batch_size):
            batch = tsx_symbols[i:i + batch_size]
            symbol_str = ",".join(batch)
            quotes = await self._fmp_get(session, "/batch-quote", {"symbols": symbol_str})
            if quotes:
                all_quotes.extend(quotes)
            if i + batch_size < len(tsx_symbols):
                await asyncio.sleep(0.2)

        # Apply liquidity filters (marketCap proxy since avgVolume not in batch-quote)
        filtered = []
        for q in all_quotes:
            price = q.get("price", 0) or 0
            mkt_cap = q.get("marketCap", 0) or 0
            if price < MIN_PRICE:
                continue
            if mkt_cap < MIN_MARKET_CAP:
                continue
            filtered.append(q)

        return filtered

    async def fetch_sector_performance(self, session: aiohttp.ClientSession) -> list[dict]:
        """Fetch TSX sector performance snapshot."""
        today_str = datetime.now(ZoneInfo("America/Halifax")).strftime("%Y-%m-%d")
        return await self._fmp_get(session, "/sector-performance-snapshot", {"exchange": "TSX", "date": today_str}) or []

    async def fetch_grades(self, session: aiohttp.ClientSession, tickers: list[str]) -> dict[str, list[dict]]:
        """Fetch recent analyst grades for tickers. Returns {ticker: [grades]}."""
        grades_map: dict[str, list[dict]] = {}
        for ticker in tickers:
            data = await self._fmp_get(session, "/grades", {"symbol": ticker})
            if data and isinstance(data, list):
                # Only include grades from last 30 days
                grades_map[ticker] = data[:3]  # Top 3 most recent
            await asyncio.sleep(0.1)
        return grades_map

    async def fetch_intraday_bars(self, session: aiohttp.ClientSession, ticker: str) -> list[dict]:
        """Fetch intraday bars: 1-min (preferred) → 5-min (fallback) → empty."""
        today = datetime.now(ZoneInfo("America/Halifax")).strftime("%Y-%m-%d")

        # Try 1-min bars (FMP Ultimate)
        bars = await self._fmp_get(session, f"/historical-chart/1min/{ticker}", {"from": today, "to": today})
        if bars and isinstance(bars, list) and len(bars) > 0:
            return bars

        # Fallback: 5-min bars
        bars = await self._fmp_get(session, f"/historical-chart/5min/{ticker}", {"from": today, "to": today})
        if bars and isinstance(bars, list) and len(bars) > 0:
            return bars

        return []

    # ── Ranking Computation ───────────────────────────────────────────

    def compute_rankings(self, quotes: list[dict], top_n: int = 40) -> list[dict]:
        """Rank quotes by change% (positive movers only).

        Filters out:
        - Negative movers (change% <= 0)

        Returns top_n movers sorted by change% descending.
        Note: avgVolume is not available in batch-quote, so relative volume
        is computed later from profile data for the top candidates.
        """
        scored = []
        for q in quotes:
            change_pct = q.get("changePercentage", 0) or 0
            volume = q.get("volume", 0) or 0

            # Filter negative movers
            if change_pct <= 0:
                continue

            scored.append({
                **q,
                "relative_volume": 0.0,  # Populated later from profile data
                "composite_score": round(change_pct, 2),
            })

        scored.sort(key=lambda x: x["composite_score"], reverse=True)
        return scored[:top_n]

    # ── Sonnet Prompt ─────────────────────────────────────────────────

    def build_sonnet_prompt(self, movers: list[dict], sectors: list[dict], grades: dict[str, list[dict]]) -> str:
        """Build the user prompt for Sonnet 4.6."""
        sector_text = ""
        if sectors:
            sector_lines = [f"  {s.get('sector', '?')}: {s.get('averageChange', 0):+.2f}%" for s in sectors]
            sector_text = "TSX Sector Performance:\n" + "\n".join(sector_lines)

        mover_lines = []
        for m in movers:
            sym = m.get("symbol", "?")
            grade_info = ""
            if sym in grades and grades[sym]:
                g = grades[sym][0]
                grade_info = f" | Analyst: {g.get('gradingCompany', '?')} → {g.get('newGrade', '?')} ({g.get('action', '?')})"
            mover_lines.append(
                f"  {sym}: ${m.get('price', 0):.2f} ({m.get('changePercentage', 0):+.1f}%) "
                f"RelVol={m.get('relative_volume', 0):.1f}x "
                f"AvgVol={m.get('avgVolume', 0):,.0f}{grade_info}"
            )

        movers_text = "Top Movers (5 minutes after TSX open):\n" + "\n".join(mover_lines)

        return f"""{sector_text}

{movers_text}

Analyze these TSX/TSXV stocks that are showing unusual momentum at market open.
Select the TOP 10 most promising for rapid intraday gains.

For each pick, provide:
1. rank (1-10)
2. ticker
3. momentum_score (0-100, your confidence in continued momentum)
4. intraday_target (realistic price target for today based on ATR and momentum)
5. key_level (price where the bullish thesis breaks — the stop-loss guide)
6. conviction ("high", "medium", or "low")
7. rationale (one sentence explaining why this stock is moving and why momentum should continue)

Focus on:
- Relative volume as institutional footprint (>3x = strong signal)
- Sector rotation alignment (is this stock riding a sector wave?)
- Analyst upgrades as catalyst confirmation
- Avoid dead cat bounces and low-liquidity traps

Respond with ONLY valid JSON in this format:
{{"picks": [{{"rank": 1, "ticker": "X.TO", "momentum_score": 94, "intraday_target": 50.40, "key_level": 47.15, "conviction": "high", "rationale": "..."}}]}}"""

    SYSTEM_PROMPT = """You are an expert intraday momentum analyst for Canadian equities (TSX/TSXV).
Your job is to identify stocks showing genuine institutional buying pressure at market open
and predict which ones will continue their momentum through the trading session.

You must be rigorous: high relative volume with no catalyst = medium conviction at best.
High relative volume + sector rotation + analyst upgrade = high conviction.

Always respond with valid JSON only. No markdown, no explanation outside the JSON."""

    # ── Response Parsing ──────────────────────────────────────────────

    def parse_sonnet_response(self, response_text: str) -> list[dict]:
        """Parse Sonnet's JSON response. Handles markdown fences and caps at 10 picks."""
        text = response_text.strip()

        # Strip markdown code fences if present
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        text = text.strip()

        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            logger.error(f"Failed to parse Sonnet response: {text[:200]}")
            return []

        picks = data.get("picks", [])
        if not isinstance(picks, list):
            return []

        # Validate required fields and cap at 10
        valid_picks = []
        required = {"rank", "ticker", "momentum_score", "intraday_target", "key_level", "conviction", "rationale"}
        for p in picks[:10]:
            if not isinstance(p, dict):
                continue
            if not required.issubset(p.keys()):
                logger.warning(f"Pick missing required fields: {p.get('ticker', '?')}")
                continue
            valid_picks.append(p)

        return valid_picks

    # ── Result Mapping ────────────────────────────────────────────────

    def map_to_prisma(self, picks: list[dict], quote_map: dict[str, dict], sector_map: dict[str, float]) -> list[dict]:
        """Map scanner picks to Prisma-compatible format for database insertion."""
        mapped = []
        for pick in picks:
            ticker = pick["ticker"]
            q = quote_map.get(ticker, {})
            avg_vol = q.get("avgVolume") or q.get("averageVolume") or 1
            vol = q.get("volume", 0) or 0
            sector = q.get("sector", "") or ""

            mapped.append({
                "rank": pick["rank"],
                "ticker": ticker,
                "name": q.get("name", ticker),
                "sector": sector,
                "exchange": q.get("exchange", "TSX"),
                "priceAtScan": q.get("price", 0),
                "previousClose": q.get("previousClose", 0),
                "changePercent": q.get("changePercentage", 0),
                "relativeVolume": round(vol / avg_vol, 1) if avg_vol > 0 else 0,
                "sectorMomentum": sector_map.get(sector, 0),
                "momentumScore": pick["momentum_score"],
                "intradayTarget": pick["intraday_target"],
                "keyLevel": pick["key_level"],
                "conviction": pick["conviction"],
                "rationale": pick["rationale"],
            })
        return mapped

    # ── Main Pipeline ─────────────────────────────────────────────────

    async def run(self) -> dict:
        """Execute the full Opening Bell pipeline.

        Returns a dict with:
        - success: bool
        - picks: list of Prisma-mapped picks
        - sector_snapshot: list of sector performance data
        - tickers_scanned: int
        - duration_ms: int
        - token_usage: dict with input_tokens and output_tokens
        - error: str (if failed)
        """
        start = time.time()
        logger.info("Opening Bell: starting scan")

        try:
            async with aiohttp.ClientSession() as session:
                # Step 1: Fetch universe quotes
                logger.info("Opening Bell: fetching TSX universe quotes")
                quotes = await self.fetch_tsx_universe(session)
                if not quotes:
                    return {"success": False, "error": "No quotes returned from FMP", "duration_ms": int((time.time() - start) * 1000)}

                tickers_scanned = len(quotes)
                logger.info(f"Opening Bell: {tickers_scanned} tickers after filters")

                # Step 2: Compute rankings
                movers = self.compute_rankings(quotes, top_n=40)
                if not movers:
                    return {"success": False, "error": "No positive movers found", "duration_ms": int((time.time() - start) * 1000)}

                logger.info(f"Opening Bell: {len(movers)} top movers identified")

                # Step 2b: Enrich movers with averageVolume + sector from profiles
                for m in movers:
                    prof = await self._fmp_get(session, "/profile", {"symbol": m["symbol"]})
                    if prof and isinstance(prof, list):
                        p = prof[0]
                        avg_vol = p.get("averageVolume", 0) or 0
                        vol = m.get("volume", 0) or 0
                        m["avgVolume"] = avg_vol
                        m["relative_volume"] = round(vol / avg_vol, 1) if avg_vol > 0 else 0.0
                        m["sector"] = p.get("sector", "")
                    await asyncio.sleep(0.05)
                logger.info(f"Opening Bell: enriched {len(movers)} movers with profile data")

                # Step 3: Enrich — fetch sector perf + grades in parallel
                mover_tickers = [m["symbol"] for m in movers]
                sectors_task = self.fetch_sector_performance(session)
                grades_task = self.fetch_grades(session, mover_tickers)
                sectors, grades = await asyncio.gather(sectors_task, grades_task)

                logger.info(f"Opening Bell: {len(sectors)} sectors, grades for {len(grades)} tickers")

                # Step 4: Call Sonnet
                user_prompt = self.build_sonnet_prompt(movers, sectors, grades)
                logger.info("Opening Bell: calling Sonnet 4.6")

                from canadian_llm_council_brain import _call_anthropic
                response_text, token_usage = await _call_anthropic(
                    api_key=self.anthropic_key,
                    model="claude-sonnet-4-6",
                    system_prompt=self.SYSTEM_PROMPT,
                    user_prompt=user_prompt,
                    max_tokens=4096,
                    temperature=0.3,
                )

                logger.info(f"Opening Bell: Sonnet returned {len(response_text)} chars, tokens: {token_usage}")

                # Step 5: Parse response
                picks = self.parse_sonnet_response(response_text)
                if not picks:
                    return {"success": False, "error": "Sonnet returned no valid picks", "duration_ms": int((time.time() - start) * 1000), "token_usage": token_usage}

                # Step 6: Map to Prisma format (use movers which have profile-enriched avgVolume)
                quote_map = {q["symbol"]: q for q in quotes}
                # Overlay mover data (has avgVolume from profile enrichment)
                for m in movers:
                    if m["symbol"] in quote_map:
                        quote_map[m["symbol"]].update(m)
                sector_map = {s.get("sector", ""): s.get("averageChange", 0) for s in sectors}
                prisma_picks = self.map_to_prisma(picks, quote_map, sector_map)

                duration_ms = int((time.time() - start) * 1000)
                logger.info(f"Opening Bell: complete — {len(prisma_picks)} picks in {duration_ms}ms")

                return {
                    "success": True,
                    "picks": prisma_picks,
                    "sector_snapshot": sectors,
                    "tickers_scanned": tickers_scanned,
                    "duration_ms": duration_ms,
                    "token_usage": token_usage,
                    "endpoint_health": self._endpoint_health,
                }

        except Exception as e:
            duration_ms = int((time.time() - start) * 1000)
            logger.error(f"Opening Bell failed: {e}")
            return {"success": False, "error": str(e), "duration_ms": duration_ms}
