"""FMP vs EODHD cross-comparison module.

Produces DataQualityFlags for each ticker by comparing overlapping fields
between FMP and EODHD responses. Flags ghost stocks, stale quotes, and
field-level discrepancies for later audit.

Used by Sibling B's fetch layer before MergedPayload assembly.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional, Any

logger = logging.getLogger(__name__)


@dataclass
class DataQualityFlags:
    """Per-ticker data quality flags from cross-source comparison."""
    ticker: str
    ghost_stock: bool = False
    ghost_source: Optional[str] = None  # "fmp" or "eodhd" — which source was empty
    price_disagreement_pct: Optional[float] = None  # None if both agree or only one has data
    stale_timestamp_source: Optional[str] = None  # "fmp" or "eodhd" if one is >1h stale
    field_disagreements: list[str] = field(default_factory=list)

    def has_any_flag(self) -> bool:
        return (
            self.ghost_stock
            or (self.price_disagreement_pct is not None and self.price_disagreement_pct > 2.0)
            or self.stale_timestamp_source is not None
            or bool(self.field_disagreements)
        )


def cross_compare(
    ticker: str,
    fmp_data: Optional[dict],
    eodhd_data: Optional[dict],
) -> DataQualityFlags:
    """Compare FMP and EODHD data for a single ticker, returning flags.

    Both inputs may be None (missing from source). Field-level comparison
    happens only where both sources have the data.
    """
    flags = DataQualityFlags(ticker=ticker)

    # Ghost stock detection
    fmp_has_data = fmp_data is not None and bool(fmp_data)
    eodhd_has_data = eodhd_data is not None and bool(eodhd_data)

    if not fmp_has_data and not eodhd_has_data:
        flags.ghost_stock = True
        flags.ghost_source = "both"
        return flags
    if not fmp_has_data:
        flags.ghost_stock = True
        flags.ghost_source = "fmp"
        return flags
    if not eodhd_has_data:
        flags.ghost_stock = True
        flags.ghost_source = "eodhd"
        return flags

    # Both have data — compare price if both provide it
    fmp_price = fmp_data.get("price") if isinstance(fmp_data, dict) else None
    eodhd_price = eodhd_data.get("close") if isinstance(eodhd_data, dict) else None
    if fmp_price is not None and eodhd_price is not None:
        try:
            fmp_p = float(fmp_price)
            eodhd_p = float(eodhd_price)
            if fmp_p > 0:
                delta_pct = abs(fmp_p - eodhd_p) / fmp_p * 100.0
                flags.price_disagreement_pct = round(delta_pct, 2)
                if delta_pct > 2.0:
                    flags.field_disagreements.append(
                        f"price: FMP=${fmp_p:.2f} vs EODHD=${eodhd_p:.2f} ({delta_pct:.1f}% delta)"
                    )
        except (TypeError, ValueError):
            pass

    return flags


def cross_compare_batch(
    tickers: list[str],
    fmp_map: dict[str, dict],
    eodhd_map: dict[str, dict],
) -> dict[str, DataQualityFlags]:
    """Batch cross-compare across multiple tickers.

    Returns {ticker: DataQualityFlags}.
    Logs a summary of flag counts.
    """
    result = {}
    ghost_count = 0
    price_disagreement_count = 0
    for ticker in tickers:
        flags = cross_compare(ticker, fmp_map.get(ticker), eodhd_map.get(ticker))
        result[ticker] = flags
        if flags.ghost_stock:
            ghost_count += 1
        if flags.price_disagreement_pct is not None and flags.price_disagreement_pct > 2.0:
            price_disagreement_count += 1

    logger.info(
        f"Cross-compare: {len(tickers)} tickers analyzed, "
        f"{ghost_count} ghost flags, {price_disagreement_count} price disagreements (>2%)"
    )
    return result
