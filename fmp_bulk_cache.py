"""
fmp_bulk_cache.py
Shared FMP bulk profile cache for all pipelines (Radar, Opening Bell, Spikes).

Downloads /stable/profile-bulk CSV, parses .TO tickers, caches for 4 hours.
Provides get_profile(ticker) and get_tsx_whitelist() for all pipelines.
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

# Module-level cache
_cache: dict[str, dict] = {}
_cache_timestamp: float = 0.0
_tsx_whitelist: set[str] = set()
_cache_lock: Optional[asyncio.Lock] = None


def _get_lock() -> asyncio.Lock:
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _normalize_profile(row: dict) -> dict:
    """Add field name aliases for downstream compatibility."""
    # CSV fields → add aliases used by different parts of the codebase
    row["changesPercentage"] = row.get("changePercentage", 0)
    row["avgVolume"] = row.get("averageVolume", 0)
    row["name"] = row.get("companyName", "")
    # Convert string booleans from CSV
    for field in ("isEtf", "isActivelyTrading", "isAdr", "isFund"):
        val = row.get(field)
        if isinstance(val, str):
            row[field] = val.lower() == "true"
    # Convert numeric fields
    for field in ("price", "marketCap", "averageVolume", "volume",
                  "changePercentage", "change", "beta"):
        val = row.get(field)
        if isinstance(val, str):
            try:
                row[field] = float(val) if val else 0
            except (ValueError, TypeError):
                row[field] = 0
    # Re-alias after numeric conversion
    row["changesPercentage"] = row.get("changePercentage", 0)
    row["avgVolume"] = row.get("averageVolume", 0)
    return row


async def _download_part(session: aiohttp.ClientSession, api_key: str, part: int) -> list[dict]:
    """Download one part of the profile-bulk CSV, return .TO ticker rows."""
    url = f"{FMP_BASE}/profile-bulk"
    params = {"part": str(part), "apikey": api_key}
    rows = []
    try:
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=60)) as resp:
            if resp.status != 200:
                logger.warning(f"profile-bulk part={part} returned {resp.status}")
                return []
            text = await resp.text()
            reader = csv.DictReader(io.StringIO(text))
            for row in reader:
                symbol = row.get("symbol", "")
                if symbol.endswith(".TO"):
                    rows.append(_normalize_profile(dict(row)))
        logger.info(f"profile-bulk part={part}: {len(rows)} .TO tickers")
    except Exception as e:
        logger.error(f"profile-bulk part={part} failed: {e}")
    return rows


async def refresh_cache(api_key: str | None = None) -> int:
    """Download all bulk profile parts and rebuild cache. Returns ticker count."""
    global _cache, _cache_timestamp, _tsx_whitelist

    api_key = api_key or os.environ.get("FMP_API_KEY", "")
    if not api_key:
        logger.error("No FMP_API_KEY available for bulk cache refresh")
        return 0

    ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    async with aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(ssl=ssl_ctx)
    ) as session:
        # Download parts sequentially (rate limit: 1 call per 60s for bulk)
        all_rows: list[dict] = []
        for part in BULK_PARTS:
            rows = await _download_part(session, api_key, part)
            all_rows.extend(rows)
            if part < BULK_PARTS[-1]:
                await asyncio.sleep(2)  # Brief pause between parts

    # Build cache keyed by symbol
    new_cache = {}
    for row in all_rows:
        symbol = row["symbol"]
        if symbol not in new_cache:  # First occurrence wins (dedup across parts)
            new_cache[symbol] = row

    # Build TSX whitelist (actively traded, non-ETF)
    new_whitelist = set()
    for symbol, profile in new_cache.items():
        if profile.get("isActivelyTrading") and not profile.get("isEtf"):
            new_whitelist.add(symbol)

    _cache = new_cache
    _tsx_whitelist = new_whitelist
    _cache_timestamp = time.time()
    logger.info(f"Bulk cache refreshed: {len(_cache)} .TO profiles, {len(_tsx_whitelist)} in whitelist")
    return len(_cache)


async def _ensure_cache(api_key: str | None = None) -> None:
    """Refresh cache if stale or empty."""
    if _cache and (time.time() - _cache_timestamp) < CACHE_TTL_SECONDS:
        return
    async with _get_lock():
        # Double-check after acquiring lock
        if _cache and (time.time() - _cache_timestamp) < CACHE_TTL_SECONDS:
            return
        await refresh_cache(api_key)


async def get_profile(ticker: str, api_key: str | None = None) -> dict:
    """Get profile data for a single ticker from cache."""
    await _ensure_cache(api_key)
    return _cache.get(ticker, {})


async def get_profiles(tickers: list[str], api_key: str | None = None) -> dict[str, dict]:
    """Get profile data for multiple tickers from cache."""
    await _ensure_cache(api_key)
    return {t: _cache[t] for t in tickers if t in _cache}


async def get_tsx_whitelist(api_key: str | None = None) -> set[str]:
    """Get set of .TO tickers where isActivelyTrading=true and isEtf=false."""
    await _ensure_cache(api_key)
    return _tsx_whitelist.copy()


async def is_valid_tsx_ticker(ticker: str, api_key: str | None = None) -> bool:
    """Check if ticker is in the TSX whitelist."""
    await _ensure_cache(api_key)
    return ticker in _tsx_whitelist


def get_cache_info() -> dict:
    """Return cache metadata for debugging."""
    age = time.time() - _cache_timestamp if _cache_timestamp else -1
    return {
        "cached_tickers": len(_cache),
        "whitelist_size": len(_tsx_whitelist),
        "cache_age_seconds": round(age, 1),
        "ttl_remaining_seconds": round(max(0, CACHE_TTL_SECONDS - age), 1) if _cache_timestamp else 0,
    }
