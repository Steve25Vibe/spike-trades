"""Radar Scanner integration test — requires FMP_API_KEY."""
import asyncio
import os
import pytest
from canadian_llm_council_brain import RadarScanner, RadarResult


@pytest.mark.skipif(not os.getenv("FMP_API_KEY"), reason="FMP_API_KEY not set")
@pytest.mark.skipif(not os.getenv("ANTHROPIC_API_KEY"), reason="ANTHROPIC_API_KEY not set")
def test_radar_scanner_runs():
    """Test that RadarScanner produces a valid RadarResult."""
    scanner = RadarScanner(
        fmp_api_key=os.environ["FMP_API_KEY"],
        anthropic_api_key=os.environ["ANTHROPIC_API_KEY"],
    )
    result = asyncio.run(scanner.run(top_n=5))

    assert "run_id" in result
    assert "tickers_scanned" in result
    assert result["tickers_scanned"] > 0
    assert isinstance(result.get("picks", []), list)
    # May be empty on quiet days — that's valid
    for pick in result.get("picks", []):
        assert 0 <= pick["smart_money_score"] <= 100
        assert pick["ticker"].endswith(".TO") or pick["ticker"].endswith(".V")


def test_radar_models_validate():
    """Test Pydantic model validation without API calls."""
    from canadian_llm_council_brain import RadarScoreBreakdown, RadarPick
    from datetime import datetime, timezone

    score = RadarScoreBreakdown(
        catalyst_strength=25, news_sentiment=20, technical_setup=18,
        volume_signals=7, sector_alignment=8, total=78
    )
    assert score.total == 78

    pick = RadarPick(
        rank=1, ticker="RY.TO", price=151.0, smart_money_score=78,
        score_breakdown=score, as_of=datetime.now(timezone.utc)
    )
    assert pick.smart_money_score == 78
