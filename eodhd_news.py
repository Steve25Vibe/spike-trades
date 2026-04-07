"""EODHD News API module — shared news source for all Spike Trades pipelines."""

from __future__ import annotations

import asyncio
import logging
import os

import aiohttp

logger = logging.getLogger(__name__)

EODHD_BASE = "https://eodhd.com/api/news"
EODHD_HEALTH_KEY = "eodhd/news"


def _track(endpoint_health: dict | None, status: str) -> None:
    """Increment the eodhd/news counter in a fetcher-style endpoint_health dict.
    No-op when endpoint_health is None. Matches the shape produced by
    LiveDataFetcher._track_endpoint and OpeningBellScanner so the admin
    Data Source Health dashboard displays EODHD alongside FMP without any
    frontend changes."""
    if endpoint_health is None:
        return
    if EODHD_HEALTH_KEY not in endpoint_health:
        endpoint_health[EODHD_HEALTH_KEY] = {"ok": 0, "404": 0, "429": 0, "error": 0}
    bucket = endpoint_health[EODHD_HEALTH_KEY]
    bucket[status] = bucket.get(status, 0) + 1


async def fetch_news(
    ticker: str,
    limit: int = 10,
    api_key: str | None = None,
    endpoint_health: dict | None = None,
) -> list[dict]:
    """Fetch recent news for a ticker from EODHD.

    Returns list of article dicts with: title, date, tags, sentiment, symbols.
    Strips content and link fields (not needed downstream).
    Validates that the requested ticker appears in the article's symbols array.

    When `endpoint_health` is provided, bumps ok/404/429/error counters under
    the 'eodhd/news' key so calls show up in the admin Data Source Health.
    """
    key = api_key or os.environ.get("EODHD_API_KEY", "")
    if not key:
        logger.warning("EODHD_API_KEY not set, skipping news fetch")
        return []

    url = f"{EODHD_BASE}?s={ticker}&limit={limit}&api_token={key}&fmt=json"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    _track(endpoint_health, "ok")
                elif resp.status == 404:
                    _track(endpoint_health, "404")
                    logger.warning(f"EODHD news for {ticker} returned 404")
                    return []
                elif resp.status == 429:
                    _track(endpoint_health, "429")
                    logger.warning(f"EODHD news for {ticker} returned 429")
                    return []
                else:
                    _track(endpoint_health, "error")
                    logger.warning(f"EODHD news for {ticker} returned {resp.status}")
                    return []
                data = await resp.json(content_type=None)
    except Exception as e:
        _track(endpoint_health, "error")
        logger.warning(f"EODHD news fetch failed for {ticker}: {e}")
        return []

    if not isinstance(data, list):
        return []

    results = []
    for article in data:
        symbols = article.get("symbols", [])
        if ticker not in symbols:
            continue
        article.pop("content", None)
        article.pop("link", None)
        results.append(article)

    return results


async def fetch_news_batch(
    tickers: list[str],
    limit: int = 5,
    api_key: str | None = None,
    endpoint_health: dict | None = None,
) -> dict[str, list[dict]]:
    """Fetch news for multiple tickers with concurrency control.

    When `endpoint_health` is provided, propagates it to each per-ticker
    fetch so counter increments aggregate across the batch.
    """
    sem = asyncio.Semaphore(10)
    result: dict[str, list[dict]] = {}

    async def _fetch(t: str):
        async with sem:
            articles = await fetch_news(
                t, limit=limit, api_key=api_key, endpoint_health=endpoint_health
            )
            if articles:
                result[t] = articles
            await asyncio.sleep(0.1)

    await asyncio.gather(*[_fetch(t) for t in tickers])
    return result


def get_sentiment_score(articles: list[dict]) -> float:
    """Return average sentiment polarity across articles."""
    if not articles:
        return 0.0
    polarities = []
    for a in articles:
        sentiment = a.get("sentiment")
        if isinstance(sentiment, dict):
            pol = sentiment.get("polarity")
            if pol is not None:
                polarities.append(float(pol))
    if not polarities:
        return 0.0
    return round(sum(polarities) / len(polarities), 4)
