"""Tests for Opening Bell scanner pipeline."""
import pytest
import asyncio
import json
from unittest.mock import AsyncMock, patch, MagicMock

# We'll import from the module once created
# from opening_bell_scanner import OpeningBellScanner


class TestComputeRankings:
    """Test the ranking computation from raw quote data."""

    def test_ranks_by_composite_score(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        quotes = [
            {"symbol": "A.TO", "price": 10.0, "previousClose": 9.5, "volume": 500000, "avgVolume": 100000, "changesPercentage": 5.26},
            {"symbol": "B.TO", "price": 20.0, "previousClose": 19.8, "volume": 300000, "avgVolume": 200000, "changesPercentage": 1.01},
            {"symbol": "C.TO", "price": 5.0, "previousClose": 4.6, "volume": 800000, "avgVolume": 100000, "changesPercentage": 8.70},
        ]
        ranked = scanner.compute_rankings(quotes)
        # C.TO has highest combo: +8.7% change + 8x relative volume
        assert ranked[0]["symbol"] == "C.TO"
        # A.TO next: +5.26% change + 5x relative volume
        assert ranked[1]["symbol"] == "A.TO"

    def test_filters_low_volume(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        quotes = [
            {"symbol": "A.TO", "price": 10.0, "previousClose": 9.5, "volume": 500000, "avgVolume": 100000, "changesPercentage": 5.26},
            {"symbol": "DEAD.TO", "price": 10.0, "previousClose": 10.0, "volume": 50, "avgVolume": 100000, "changesPercentage": 0.0},
        ]
        ranked = scanner.compute_rankings(quotes)
        # DEAD.TO should be filtered out — relative volume < 0.5
        symbols = [r["symbol"] for r in ranked]
        assert "DEAD.TO" not in symbols

    def test_filters_negative_movers(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        quotes = [
            {"symbol": "UP.TO", "price": 10.5, "previousClose": 10.0, "volume": 500000, "avgVolume": 100000, "changesPercentage": 5.0},
            {"symbol": "DOWN.TO", "price": 9.0, "previousClose": 10.0, "volume": 500000, "avgVolume": 100000, "changesPercentage": -10.0},
        ]
        ranked = scanner.compute_rankings(quotes)
        symbols = [r["symbol"] for r in ranked]
        assert "DOWN.TO" not in symbols

    def test_limits_to_top_n(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        quotes = [
            {"symbol": f"S{i}.TO", "price": 10.0 + i, "previousClose": 10.0, "volume": 500000 + i * 100000, "avgVolume": 100000, "changesPercentage": float(i)}
            for i in range(1, 50)
        ]
        ranked = scanner.compute_rankings(quotes, top_n=30)
        assert len(ranked) <= 30


class TestParseSONNETResponse:
    """Test parsing Sonnet's JSON response into structured picks."""

    def test_parses_valid_response(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        response_text = json.dumps({
            "picks": [
                {
                    "rank": 1,
                    "ticker": "CNQ.TO",
                    "momentum_score": 94,
                    "intraday_target": 50.40,
                    "key_level": 47.15,
                    "conviction": "high",
                    "rationale": "Energy sector surge with 6.2x volume"
                },
                {
                    "rank": 2,
                    "ticker": "SU.TO",
                    "momentum_score": 89,
                    "intraday_target": 64.50,
                    "key_level": 60.80,
                    "conviction": "high",
                    "rationale": "Riding oil rally"
                }
            ]
        })
        picks = scanner.parse_sonnet_response(response_text)
        assert len(picks) == 2
        assert picks[0]["ticker"] == "CNQ.TO"
        assert picks[0]["momentum_score"] == 94
        assert picks[0]["conviction"] == "high"

    def test_handles_malformed_json(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        # Sonnet sometimes wraps in markdown code fences
        response_text = '```json\n{"picks": [{"rank": 1, "ticker": "A.TO", "momentum_score": 80, "intraday_target": 10.5, "key_level": 9.0, "conviction": "medium", "rationale": "test"}]}\n```'
        picks = scanner.parse_sonnet_response(response_text)
        assert len(picks) == 1
        assert picks[0]["ticker"] == "A.TO"

    def test_returns_empty_on_garbage(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        picks = scanner.parse_sonnet_response("This is not JSON at all")
        assert picks == []

    def test_caps_at_10_picks(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        response_text = json.dumps({
            "picks": [
                {"rank": i, "ticker": f"S{i}.TO", "momentum_score": 90 - i, "intraday_target": 10.0 + i, "key_level": 9.0, "conviction": "high", "rationale": "test"}
                for i in range(1, 16)
            ]
        })
        picks = scanner.parse_sonnet_response(response_text)
        assert len(picks) == 10


class TestBuildSonnetPrompt:
    """Test the prompt construction for Sonnet."""

    def test_includes_sector_data(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        movers = [{"symbol": "A.TO", "price": 10.0, "changesPercentage": 5.0, "relative_volume": 3.0}]
        sectors = [{"sector": "Energy", "averageChange": 2.8}]
        grades = {"A.TO": [{"gradingCompany": "BMO", "newGrade": "Buy", "action": "upgrade"}]}
        prompt = scanner.build_sonnet_prompt(movers, sectors, grades)
        assert "Energy" in prompt
        assert "2.8" in prompt
        assert "A.TO" in prompt
        assert "BMO" in prompt

    def test_includes_all_movers(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        movers = [
            {"symbol": f"S{i}.TO", "price": 10.0 + i, "changesPercentage": float(i), "relative_volume": float(i)}
            for i in range(1, 31)
        ]
        prompt = scanner.build_sonnet_prompt(movers, [], {})
        assert "S30.TO" in prompt
        assert "S1.TO" in prompt


class TestResultMapping:
    """Test mapping scanner results to Prisma-compatible format."""

    def test_maps_to_prisma_format(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        picks = [
            {
                "rank": 1,
                "ticker": "CNQ.TO",
                "momentum_score": 94,
                "intraday_target": 50.40,
                "key_level": 47.15,
                "conviction": "high",
                "rationale": "Energy surge"
            }
        ]
        quote_map = {
            "CNQ.TO": {
                "symbol": "CNQ.TO",
                "name": "Canadian Natural Resources",
                "price": 48.72,
                "previousClose": 46.27,
                "changesPercentage": 5.3,
                "volume": 1200000,
                "avgVolume": 193548,
                "exchange": "TSX",
            }
        }
        sector_map = {"Energy": 2.8}
        mapped = scanner.map_to_prisma(picks, quote_map, sector_map)
        assert len(mapped) == 1
        m = mapped[0]
        assert m["ticker"] == "CNQ.TO"
        assert m["name"] == "Canadian Natural Resources"
        assert m["priceAtScan"] == 48.72
        assert m["previousClose"] == 46.27
        assert m["changePercent"] == 5.3
        assert abs(m["relativeVolume"] - 6.2) < 0.1
        assert m["momentumScore"] == 94
        assert m["intradayTarget"] == 50.40
        assert m["keyLevel"] == 47.15
        assert m["conviction"] == "high"
        assert m["exchange"] == "TSX"
