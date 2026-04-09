"""EODHD enrichment module — complements eodhd_news.py with additional EODHD data sources.

Used by Sibling B's hybrid FMP+EODHD fetch layer.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

import aiohttp

logger = logging.getLogger(__name__)

EODHD_API_BASE = "https://eodhd.com/api"
EODHD_API_KEY = os.getenv("EODHD_API_KEY", "")


async def fetch_eodhd_fundamentals(
    session: aiohttp.ClientSession,
    ticker: str,
) -> Optional[dict]:
    """Fetch EODHD fundamentals for a ticker. Non-blocking — returns None on error.

    Used as a cross-check against FMP fundamentals. Field-level comparison
    happens in cross_compare.py.
    """
    try:
        # EODHD uses format TICKER.EXCHANGE, e.g. SHOP.TO or SHOP.US
        url = f"{EODHD_API_BASE}/fundamentals/{ticker}"
        params = {"api_token": EODHD_API_KEY, "fmt": "json"}
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            return await resp.json()
    except Exception:
        return None


async def fetch_eodhd_batch_enrichment(
    session: aiohttp.ClientSession,
    tickers: list[str],
) -> dict[str, dict]:
    """Batch enrichment across multiple tickers.

    Returns {ticker: {"fundamentals": ..., ...}} mapping.
    Non-blocking — missing tickers simply absent from the dict.
    """
    sem = asyncio.Semaphore(5)

    async def _fetch_one(ticker: str) -> tuple[str, dict]:
        async with sem:
            fundamentals = await fetch_eodhd_fundamentals(session, ticker)
            data = {}
            if fundamentals is not None:
                data["fundamentals"] = fundamentals
            return ticker, data

    results = await asyncio.gather(*[_fetch_one(t) for t in tickers])
    return {ticker: data for ticker, data in results if data}
