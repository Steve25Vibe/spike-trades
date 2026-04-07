"""EODHD News API module — shared news source for all Spike Trades pipelines."""

import asyncio
import logging
import os

import aiohttp

logger = logging.getLogger(__name__)

EODHD_BASE = "https://eodhd.com/api/news"


async def fetch_news(
    ticker: str, limit: int = 10, api_key: str | None = None
) -> list[dict]:
    """Fetch recent news for a ticker from EODHD.

    Returns list of article dicts with: title, date, tags, sentiment, symbols.
    Strips content and link fields (not needed downstream).
    Validates that the requested ticker appears in the article's symbols array.
    """
    key = api_key or os.environ.get("EODHD_API_KEY", "")
    if not key:
        logger.warning("EODHD_API_KEY not set, skipping news fetch")
        return []

    url = f"{EODHD_BASE}?s={ticker}&limit={limit}&api_token={key}&fmt=json"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    logger.warning(f"EODHD news for {ticker} returned {resp.status}")
                    return []
                data = await resp.json(content_type=None)
    except Exception as e:
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
    tickers: list[str], limit: int = 5, api_key: str | None = None
) -> dict[str, list[dict]]:
    """Fetch news for multiple tickers with concurrency control."""
    sem = asyncio.Semaphore(10)
    result: dict[str, list[dict]] = {}

    async def _fetch(t: str):
        async with sem:
            articles = await fetch_news(t, limit=limit, api_key=api_key)
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
