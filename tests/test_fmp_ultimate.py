"""
FMP Ultimate Endpoint Verification for Canadian Stocks.
Run: FMP_API_KEY=xxx python tests/test_fmp_ultimate.py
"""
import asyncio
import aiohttp
import os
import json
from datetime import datetime, timedelta

FMP_KEY = os.environ.get("FMP_API_KEY", "")
BASE = "https://financialmodelingprep.com"
TEST_TICKERS = ["RY.TO", "ENB.TO", "TD.TO", "CNR.TO", "SHOP.TO"]
RESULTS: dict[str, dict] = {}


async def test_endpoint(session: aiohttp.ClientSession, name: str, url: str) -> dict:
    """Test a single endpoint and return result summary."""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            status = resp.status
            body = await resp.text()
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = body[:200]
            has_data = bool(data) and status == 200
            if isinstance(data, list):
                has_data = len(data) > 0
            return {"name": name, "status": status, "has_data": has_data, "sample": str(data)[:300]}
    except Exception as e:
        return {"name": name, "status": "ERROR", "has_data": False, "sample": str(e)[:200]}


async def main():
    if not FMP_KEY:
        print("ERROR: Set FMP_API_KEY environment variable")
        return

    async with aiohttp.ClientSession() as session:
        ticker = "RY.TO"
        today = datetime.now().strftime("%Y-%m-%d")
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

        endpoints = [
            ("1-min bars (stable)", f"{BASE}/stable/historical-chart/1min/{ticker}?from={yesterday}&to={today}&apikey={FMP_KEY}"),
            ("1-min bars (v3)", f"{BASE}/api/v3/historical-chart/1min/{ticker}?from={yesterday}&to={today}&apikey={FMP_KEY}"),
            ("5-min bars (stable)", f"{BASE}/stable/historical-chart/5min/{ticker}?from={yesterday}&to={today}&apikey={FMP_KEY}"),
            ("earnings-surprises", f"{BASE}/stable/earnings-surprises/{ticker}?apikey={FMP_KEY}"),
            ("earnings-transcript-list", f"{BASE}/stable/earnings-transcript-list/{ticker}?apikey={FMP_KEY}"),
            ("earnings-transcript", f"{BASE}/stable/earnings-transcript/{ticker}?year=2025&quarter=4&apikey={FMP_KEY}"),
            ("insider-trading (stable)", f"{BASE}/stable/insider-trading?symbol={ticker}&apikey={FMP_KEY}"),
            ("institutional-ownership", f"{BASE}/stable/institutional-ownership/symbol-ownership?symbol={ticker}&apikey={FMP_KEY}"),
            ("social-sentiment (v4)", f"{BASE}/api/v4/social-sentiment?symbol={ticker}&apikey={FMP_KEY}"),
            ("grades", f"{BASE}/stable/grades?symbol={ticker}&apikey={FMP_KEY}"),
            ("price-target-consensus", f"{BASE}/stable/price-target-consensus?symbol={ticker}&apikey={FMP_KEY}"),
            ("sector-performance", f"{BASE}/stable/sector-performance-snapshot?exchange=TSX&date={yesterday}&apikey={FMP_KEY}"),
            ("technical-indicators RSI", f"{BASE}/stable/technical-indicator/daily/{ticker}?type=rsi&period=14&apikey={FMP_KEY}"),
            ("batch-profile (bulk)", f"{BASE}/stable/batch-profile?symbols=RY.TO,TD.TO,ENB.TO&apikey={FMP_KEY}"),
        ]

        print(f"\n{'='*70}")
        print(f"FMP Ultimate Verification — {ticker}")
        print(f"{'='*70}\n")

        for name, url in endpoints:
            result = await test_endpoint(session, name, url)
            status_icon = "\u2705" if result["has_data"] else "\u274c"
            print(f"{status_icon} {name}: status={result['status']}, has_data={result['has_data']}")
            if result["has_data"]:
                print(f"   Sample: {result['sample'][:150]}")
            print()
            RESULTS[name] = result

        # Summary
        print(f"\n{'='*70}")
        print("SUMMARY — Canadian Stock Endpoint Availability")
        print(f"{'='*70}")
        working = [k for k, v in RESULTS.items() if v["has_data"]]
        broken = [k for k, v in RESULTS.items() if not v["has_data"]]
        print(f"\n\u2705 WORKING ({len(working)}):")
        for w in working:
            print(f"   - {w}")
        print(f"\n\u274c NOT AVAILABLE ({len(broken)}):")
        for b in broken:
            print(f"   - {b} (status: {RESULTS[b]['status']})")

if __name__ == "__main__":
    asyncio.run(main())
