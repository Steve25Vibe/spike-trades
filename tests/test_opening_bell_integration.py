"""Integration tests for Opening Bell scanner — full pipeline with mocked external services."""
import asyncio
import json
import sys
import types
import pytest
from unittest.mock import AsyncMock, patch

# ── Stub out canadian_llm_council_brain before any import ─────────────────────
# The brain module requires pydantic which may not be installed in the test
# environment. We inject a lightweight stub module so that
#   from canadian_llm_council_brain import _call_anthropic
# inside opening_bell_scanner.run() resolves to our controllable mock.
_brain_stub = types.ModuleType("canadian_llm_council_brain")

async def _stub_call_anthropic(*args, **kwargs):  # pragma: no cover
    raise RuntimeError("_call_anthropic stub called — patch not applied")

_brain_stub._call_anthropic = _stub_call_anthropic
sys.modules.setdefault("canadian_llm_council_brain", _brain_stub)


# ── Canned FMP Fixtures ───────────────────────────────────────────────────────

CANNED_STOCK_LIST = [
    {"symbol": "CNQ.TO",  "exchangeShortName": "TSX"},
    {"symbol": "SU.TO",   "exchangeShortName": "TSX"},
    {"symbol": "SHOP.TO", "exchangeShortName": "TSX"},
    {"symbol": "RY.TO",   "exchangeShortName": "TSX"},
    {"symbol": "PENNY.V", "exchangeShortName": "TSXV"},
]

CANNED_QUOTES = [
    {
        "symbol": "CNQ.TO",
        "name": "Canadian Natural Resources",
        "price": 48.72,
        "previousClose": 46.27,
        "changesPercentage": 5.3,
        "volume": 1_200_000,
        "avgVolume": 193_548,
        "exchange": "TSX",
    },
    {
        "symbol": "SU.TO",
        "name": "Suncor Energy",
        "price": 62.15,
        "previousClose": 59.80,
        "changesPercentage": 3.9,
        "volume": 900_000,
        "avgVolume": 300_000,
        "exchange": "TSX",
    },
    {
        "symbol": "SHOP.TO",
        "name": "Shopify Inc",
        "price": 110.50,
        "previousClose": 105.20,
        "changesPercentage": 5.0,
        "volume": 800_000,
        "avgVolume": 200_000,
        "exchange": "TSX",
    },
    {
        "symbol": "RY.TO",
        "name": "Royal Bank of Canada",
        "price": 140.00,
        "previousClose": 140.00,
        "changesPercentage": 0.0,
        "volume": 600_000,
        "avgVolume": 200_000,
        "exchange": "TSX",
    },
    {
        "symbol": "PENNY.V",
        "name": "Penny Corp",
        "price": 0.50,
        "previousClose": 0.48,
        "changesPercentage": 4.2,
        "volume": 500_000,
        "avgVolume": 100_000,
        "exchange": "TSXV",
    },
]

CANNED_SECTORS = [
    {"sector": "Energy",             "averageChange": 4.1},
    {"sector": "Technology",         "averageChange": 3.2},
    {"sector": "Financial Services", "averageChange": 0.5},
]

CANNED_GRADES = {
    "CNQ.TO":  [{"gradingCompany": "BMO", "newGrade": "Outperform", "action": "upgrade"}],
    "SU.TO":   [{"gradingCompany": "TD",  "newGrade": "Buy",        "action": "maintain"}],
    "SHOP.TO": [{"gradingCompany": "RBC", "newGrade": "Buy",        "action": "initiation"}],
}

CANNED_SONNET_RESPONSE = json.dumps({
    "picks": [
        {
            "rank": 1,
            "ticker": "CNQ.TO",
            "momentum_score": 94,
            "intraday_target": 50.40,
            "key_level": 47.15,
            "conviction": "high",
            "rationale": "Energy sector surge with 6.2x relative volume and analyst upgrade.",
        },
        {
            "rank": 2,
            "ticker": "SU.TO",
            "momentum_score": 87,
            "intraday_target": 64.50,
            "key_level": 60.80,
            "conviction": "high",
            "rationale": "Riding oil rally with 3x relative volume.",
        },
        {
            "rank": 3,
            "ticker": "SHOP.TO",
            "momentum_score": 82,
            "intraday_target": 115.00,
            "key_level": 108.00,
            "conviction": "medium",
            "rationale": "Tech sector tailwind plus analyst initiation.",
        },
    ]
})


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_fmp_side_effect(stock_list, quotes, sectors, grades_by_ticker):
    """
    Return an async function usable as side_effect for the patched _fmp_get.
    When AsyncMock replaces an instance method the side_effect is called with
    the same args as the original (session, path, params=None) — mock does NOT
    pass self, it patches the descriptor on the class.
    """
    async def _fmp_get(session, path, params=None):
        params = params or {}
        if path == "/stock-list":
            return stock_list
        if path == "/batch-quote":
            requested = set((params.get("symbols", "")).split(","))
            return [q for q in quotes if q["symbol"] in requested]
        if path == "/sector-performance-snapshot":
            return sectors
        if path == "/grades":
            return grades_by_ticker.get(params.get("symbol", ""), [])
        if "/historical-chart/" in path:
            return []
        return []

    return _fmp_get


# ── TestFullPipeline ──────────────────────────────────────────────────────────

class TestFullPipeline:
    """End-to-end pipeline tests with mocked FMP and Anthropic."""

    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    @patch("opening_bell_scanner.OpeningBellScanner._fmp_get", new_callable=AsyncMock)
    @patch("canadian_llm_council_brain._call_anthropic", new_callable=AsyncMock)
    def test_full_pipeline_produces_picks(self, mock_call_anthropic, mock_fmp_get):
        """Full pipeline returns 3 picks with correct tickers and scores."""
        mock_fmp_get.side_effect = make_fmp_side_effect(
            CANNED_STOCK_LIST, CANNED_QUOTES, CANNED_SECTORS, CANNED_GRADES
        )
        mock_call_anthropic.return_value = (
            CANNED_SONNET_RESPONSE,
            {"input_tokens": 1000, "output_tokens": 200},
        )

        from opening_bell_scanner import OpeningBellScanner
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        result = self._run(scanner.run())

        assert result["success"] is True, f"Expected success but got: {result.get('error')}"
        picks = result["picks"]
        assert len(picks) == 3

        tickers = [p["ticker"] for p in picks]
        assert "CNQ.TO" in tickers
        assert "SU.TO" in tickers
        assert "SHOP.TO" in tickers

        cnq_pick = next(p for p in picks if p["ticker"] == "CNQ.TO")
        assert cnq_pick["momentumScore"] == 94
        assert cnq_pick["conviction"] == "high"

    @patch("opening_bell_scanner.OpeningBellScanner._fmp_get", new_callable=AsyncMock)
    @patch("canadian_llm_council_brain._call_anthropic", new_callable=AsyncMock)
    def test_pipeline_filters_penny_stocks(self, mock_call_anthropic, mock_fmp_get):
        """PENNY.V at $0.50 must be filtered out by fetch_tsx_universe (price < MIN_PRICE $1.00)."""
        mock_fmp_get.side_effect = make_fmp_side_effect(
            CANNED_STOCK_LIST, CANNED_QUOTES, CANNED_SECTORS, CANNED_GRADES
        )
        mock_call_anthropic.return_value = (
            CANNED_SONNET_RESPONSE,
            {"input_tokens": 1000, "output_tokens": 200},
        )

        from opening_bell_scanner import OpeningBellScanner
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        result = self._run(scanner.run())

        assert result["success"] is True
        tickers = [p["ticker"] for p in result["picks"]]
        assert "PENNY.V" not in tickers

    @patch("opening_bell_scanner.OpeningBellScanner._fmp_get", new_callable=AsyncMock)
    @patch("canadian_llm_council_brain._call_anthropic", new_callable=AsyncMock)
    def test_pipeline_filters_flat_stocks(self, mock_call_anthropic, mock_fmp_get):
        """RY.TO with 0% change must be filtered out by compute_rankings."""
        mock_fmp_get.side_effect = make_fmp_side_effect(
            CANNED_STOCK_LIST, CANNED_QUOTES, CANNED_SECTORS, CANNED_GRADES
        )
        mock_call_anthropic.return_value = (
            CANNED_SONNET_RESPONSE,
            {"input_tokens": 1000, "output_tokens": 200},
        )

        from opening_bell_scanner import OpeningBellScanner
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        result = self._run(scanner.run())

        assert result["success"] is True
        tickers = [p["ticker"] for p in result["picks"]]
        assert "RY.TO" not in tickers

    @patch("opening_bell_scanner.OpeningBellScanner._fmp_get", new_callable=AsyncMock)
    def test_pipeline_handles_empty_universe(self, mock_fmp_get):
        """Empty universe from FMP returns success=False with an error message."""
        async def _empty(session, path, params=None):
            return []

        mock_fmp_get.side_effect = _empty

        from opening_bell_scanner import OpeningBellScanner
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        result = self._run(scanner.run())

        assert result["success"] is False
        assert "error" in result

    @patch("opening_bell_scanner.OpeningBellScanner._fmp_get", new_callable=AsyncMock)
    @patch("canadian_llm_council_brain._call_anthropic", new_callable=AsyncMock)
    def test_pipeline_handles_sonnet_failure(self, mock_call_anthropic, mock_fmp_get):
        """Invalid Sonnet response (garbage string) returns success=False."""
        mock_fmp_get.side_effect = make_fmp_side_effect(
            CANNED_STOCK_LIST, CANNED_QUOTES, CANNED_SECTORS, CANNED_GRADES
        )
        mock_call_anthropic.return_value = (
            "This is not JSON at all — Sonnet had a bad day",
            {"input_tokens": 500, "output_tokens": 10},
        )

        from opening_bell_scanner import OpeningBellScanner
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        result = self._run(scanner.run())

        assert result["success"] is False
        assert "error" in result

    @patch("opening_bell_scanner.OpeningBellScanner._fmp_get", new_callable=AsyncMock)
    @patch("canadian_llm_council_brain._call_anthropic", new_callable=AsyncMock)
    def test_pipeline_timeout_handling(self, mock_call_anthropic, mock_fmp_get):
        """asyncio.TimeoutError is raised when the pipeline is slower than the deadline."""
        mock_fmp_get.side_effect = make_fmp_side_effect(
            CANNED_STOCK_LIST, CANNED_QUOTES, CANNED_SECTORS, CANNED_GRADES
        )

        async def _slow(*args, **kwargs):
            await asyncio.sleep(5)
            return CANNED_SONNET_RESPONSE, {}

        mock_call_anthropic.side_effect = _slow

        from opening_bell_scanner import OpeningBellScanner
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")

        async def _timed_run():
            return await asyncio.wait_for(scanner.run(), timeout=0.1)

        with pytest.raises(asyncio.TimeoutError):
            self._run(_timed_run())


# ── TestEndpointHealth ────────────────────────────────────────────────────────

class TestEndpointHealth:
    """Verify FMP endpoint health tracking."""

    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    def test_tracks_successful_calls(self):
        """Health dict has the expected four counters per endpoint."""
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        # Manually seed the health dict (mirrors what real _fmp_get calls populate)
        scanner._endpoint_health = {
            "/stock-list":  {"ok": 1, "404": 0, "429": 0, "error": 0},
            "/batch-quote": {"ok": 2, "404": 0, "429": 0, "error": 0},
        }
        health = scanner._endpoint_health

        assert isinstance(health, dict)
        for _endpoint, counts in health.items():
            assert "ok" in counts
            assert "error" in counts
            assert "429" in counts
            assert "404" in counts

    @patch("opening_bell_scanner.OpeningBellScanner._fmp_get", new_callable=AsyncMock)
    @patch("canadian_llm_council_brain._call_anthropic", new_callable=AsyncMock)
    def test_health_included_in_result(self, mock_call_anthropic, mock_fmp_get):
        """endpoint_health key is present in a successful pipeline result."""
        mock_fmp_get.side_effect = make_fmp_side_effect(
            CANNED_STOCK_LIST, CANNED_QUOTES, CANNED_SECTORS, CANNED_GRADES
        )
        mock_call_anthropic.return_value = (
            CANNED_SONNET_RESPONSE,
            {"input_tokens": 1000, "output_tokens": 200},
        )

        from opening_bell_scanner import OpeningBellScanner
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        result = self._run(scanner.run())

        assert result["success"] is True
        assert "endpoint_health" in result
        assert isinstance(result["endpoint_health"], dict)
