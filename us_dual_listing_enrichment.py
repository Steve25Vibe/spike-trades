"""US Dual-Listing Enrichment — Tier 1 (options IV), Tier 2 (13F), Tier 3 (analyst + news).

For Canadian TSX tickers that are also listed on NYSE/NASDAQ/NYSE American,
these functions fetch US-market data that's richer than the Canadian equivalents.

Used by Sibling B. Lookup happens via dual_listing_map.json.

Note on `fetcher._get_session()`: the underscore prefix is a Python convention
for "not part of the public API" but `LiveDataFetcher` has no public session
accessor — the private method is the only way to obtain the shared session
without duplicating connection setup. This is intentional in the existing
codebase (fetch_insider_trades, fetch_analyst_consensus, fetch_institutional_ownership
all use the same pattern) and should not be "fixed" by adding a wrapper.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import aiohttp

logger = logging.getLogger(__name__)


# Load dual-listing map once at module import
_MAP_PATH = Path(__file__).parent / "dual_listing_map.json"
try:
    with open(_MAP_PATH) as f:
        _DUAL_MAP_DATA = json.load(f)
        _DUAL_LISTING_MAP = _DUAL_MAP_DATA.get("mappings", {})
except Exception as e:
    logger.warning(f"Failed to load dual_listing_map.json: {e}")
    _DUAL_LISTING_MAP = {}


def get_us_ticker(tsx_ticker: str) -> Optional[str]:
    """Return the US ticker for a dual-listed TSX ticker, or None if not dual-listed.

    Example: get_us_ticker("SHOP.TO") -> "SHOP"
             get_us_ticker("LUN.TO") -> None  (not dual-listed)
    """
    return _DUAL_LISTING_MAP.get(tsx_ticker)


async def fetch_us_options_iv(
    fetcher,  # LiveDataFetcher
    us_ticker: str,
) -> Optional[dict]:
    """Tier 1: Fetch US options IV for a dual-listed ticker from FMP.

    Returns a dict matching IVExpectedMove shape, or None on error.
    Non-blocking.
    """
    try:
        session = await fetcher._get_session()
        # TODO during implementation: verify exact FMP endpoint for options IV
        # Likely: /api/v3/historical-price-full/options/{us_ticker} or similar
        url = f"https://financialmodelingprep.com/api/v3/historical-price-full/options/{us_ticker}"
        params = {"apikey": fetcher.fmp_key}
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            # Parse into IVExpectedMove-compatible shape
            # Details TBD during implementation — verify response format first
            return data
    except Exception:
        return None


async def fetch_us_13f_institutional(
    fetcher,  # LiveDataFetcher
    us_ticker: str,
) -> Optional[float]:
    """Tier 2: US 13F institutional ownership for a dual-listed ticker.

    DISABLED 2026-04-09 — same root cause as Sibling A's
    fetch_institutional_ownership: FMP deprecated /api/v4/institutional-ownership
    on 2025-08-31. Returns None unconditionally pending /stable/ replacement
    investigation or EODHD source switch (v6.1 follow-up).
    """
    return None


async def fetch_us_analyst_consensus(
    fetcher,  # LiveDataFetcher
    us_ticker: str,
) -> Optional[dict]:
    """Tier 3a: Fetch US analyst consensus for a dual-listed ticker.

    Returns a dict with analyst grades, or None. Non-blocking.
    """
    try:
        session = await fetcher._get_session()
        url = "https://financialmodelingprep.com/stable/grades"
        params = {"symbol": us_ticker, "apikey": fetcher.fmp_key}
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            return await resp.json()
    except Exception:
        return None


async def fetch_us_news_sentiment(
    us_ticker: str,
    endpoint_health: Optional[dict] = None,
) -> Optional[dict]:
    """Tier 3b: Fetch US news sentiment for a dual-listed ticker via EODHD.

    Uses the existing eodhd_news module with the US symbol (e.g., SHOP.US).
    Returns the news+sentiment dict, or None.
    """
    try:
        import eodhd_news
        us_symbol = f"{us_ticker}.US"
        return await eodhd_news.fetch_news(us_symbol, limit=5, endpoint_health=endpoint_health)
    except Exception:
        return None
