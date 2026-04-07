"""
fmp_bulk_cache.py
Shared FMP profile cache for all pipelines (Radar, Opening Bell, Spikes).

- Whitelist: CSV bulk download from /stable/profile-bulk (all .TO tickers)
- Profiles: JSON per-ticker from /stable/profile?symbol=X (proper types)
Both cached for 4 hours.
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import os
import time
from typing import Optional

import aiohttp
import certifi
import ssl

logger = logging.getLogger("fmp_bulk_cache")

FMP_BASE = "https://financialmodelingprep.com/stable"
CACHE_TTL_SECONDS = 4 * 60 * 60  # 4 hours
BULK_PARTS = [0, 1, 2, 3]  # .TO tickers span parts 0-3

# Module-level caches
_whitelist_cache: set[str] = set()
_all_tickers_cache: set[str] = set()
_whitelist_timestamp: float = 0.0

_profile_cache: dict[str, dict] = {}
_profile_timestamps: dict[str, float] = {}

_lock: Optional[asyncio.Lock] = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


async def _download_whitelist(api_key: str) -> tuple[set[str], set[str]]:
    """Download CSV bulk profiles, return (whitelist, all_tickers)."""
    ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    whitelist = set()
    all_tickers = set()

    async with aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(ssl=ssl_ctx)
    ) as session:
        for part in BULK_PARTS:
            try:
                url = f"{FMP_BASE}/profile-bulk"
                params = {"part": str(part), "apikey": api_key}
                async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                    if resp.status != 200:
                        logger.warning(f"profile-bulk part={part} returned {resp.status}")
                        continue
                    text = await resp.text()
                    try:
                        reader = csv.DictReader(io.StringIO(text))
                        for row in reader:
                            symbol = row.get("symbol", "")
                            if not symbol.endswith(".TO"):
                                continue
                            all_tickers.add(symbol)
                            is_active = str(row.get("isActivelyTrading", "")).lower() == "true"
                            is_etf = str(row.get("isEtf", "")).lower() == "true"
                            if is_active and not is_etf:
                                whitelist.add(symbol)
                    except Exception as e:
                        logger.error(f"CSV parse error for part={part}: {e}")
                logger.info(f"profile-bulk part={part}: {len(all_tickers)} .TO tickers so far")
            except Exception as e:
                logger.error(f"profile-bulk part={part} failed: {e}")
            if part < BULK_PARTS[-1]:
                await asyncio.sleep(2)

    return whitelist, all_tickers


async def _ensure_whitelist(api_key: str | None = None) -> None:
    """Refresh whitelist if stale or empty."""
    global _whitelist_cache, _all_tickers_cache, _whitelist_timestamp
    if _whitelist_cache and (time.time() - _whitelist_timestamp) < CACHE_TTL_SECONDS:
        return
    async with _get_lock():
        if _whitelist_cache and (time.time() - _whitelist_timestamp) < CACHE_TTL_SECONDS:
            return
        key = api_key or os.environ.get("FMP_API_KEY", "")
        if not key:
            logger.error("No FMP_API_KEY available for whitelist refresh")
            return
        whitelist, all_tickers = await _download_whitelist(key)
        _whitelist_cache = whitelist
        _all_tickers_cache = all_tickers
        _whitelist_timestamp = time.time()
        logger.info(f"Whitelist refreshed: {len(all_tickers)} total, {len(whitelist)} active non-ETF")


async def get_profile(ticker: str, api_key: str | None = None) -> dict:
    """Get profile for a single ticker via FMP JSON endpoint. Cached 4 hours."""
    now = time.time()
    ts = _profile_timestamps.get(ticker, 0)
    if ticker in _profile_cache and (now - ts) < CACHE_TTL_SECONDS:
        return _profile_cache[ticker]

    key = api_key or os.environ.get("FMP_API_KEY", "")
    if not key:
        return {}

    ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    try:
        async with aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(ssl=ssl_ctx)
        ) as session:
            url = f"{FMP_BASE}/profile"
            params = {"symbol": ticker, "apikey": key}
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    logger.warning(f"FMP profile for {ticker} returned {resp.status}")
                    return _profile_cache.get(ticker, {})
                data = await resp.json(content_type=None)
    except Exception as e:
        logger.warning(f"FMP profile fetch failed for {ticker}: {e}")
        return _profile_cache.get(ticker, {})

    if isinstance(data, list) and data:
        profile = data[0]
    elif isinstance(data, dict):
        profile = data
    else:
        return {}

    _profile_cache[ticker] = profile
    _profile_timestamps[ticker] = now
    return profile


async def get_profiles(tickers: list[str], api_key: str | None = None) -> dict[str, dict]:
    """Get profiles for multiple tickers with concurrency control."""
    sem = asyncio.Semaphore(10)
    result: dict[str, dict] = {}

    async def _fetch(t: str):
        async with sem:
            profile = await get_profile(t, api_key)
            if profile:
                result[t] = profile

    await asyncio.gather(*[_fetch(t) for t in tickers])
    return result


async def get_tsx_whitelist(api_key: str | None = None) -> set[str]:
    """Get set of .TO tickers where isActivelyTrading=true and isEtf=false."""
    await _ensure_whitelist(api_key)
    return _whitelist_cache.copy()


async def is_valid_tsx_ticker(ticker: str, api_key: str | None = None) -> bool:
    """Check if ticker is in the TSX whitelist."""
    await _ensure_whitelist(api_key)
    return ticker in _whitelist_cache


async def refresh_cache(api_key: str | None = None) -> int:
    """Refresh whitelist cache. Returns ticker count. Kept for backward compat."""
    global _whitelist_timestamp
    _whitelist_timestamp = 0  # Force refresh
    await _ensure_whitelist(api_key)
    return len(_whitelist_cache)


def get_cache_info() -> dict:
    """Return cache metadata for debugging."""
    age = time.time() - _whitelist_timestamp if _whitelist_timestamp else -1
    return {
        "whitelist_size": len(_whitelist_cache),
        "all_tickers": len(_all_tickers_cache),
        "profile_cache_size": len(_profile_cache),
        "cache_age_seconds": round(age, 1),
        "ttl_remaining_seconds": round(max(0, CACHE_TTL_SECONDS - age), 1) if _whitelist_timestamp else 0,
    }
