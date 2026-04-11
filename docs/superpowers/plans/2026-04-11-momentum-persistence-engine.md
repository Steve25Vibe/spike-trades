# Momentum Persistence Engine (MPE) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a two-phase momentum engine that identifies proven winners from past picks, injects them into the council pipeline with verified return data, and re-ranks the final Top 10 by blending spike scores with a 4-signal momentum score.

**Architecture:** New Python class `MomentumPersistenceEngine` in a dedicated module handles candidate identification, signal computation, re-qualification gating, and post-council re-ranking. Integrates into `run_council()` at two points: pre-council (after universe fetch, before Stage 1) and post-council (after Stage 4, before record_picks). TypeScript changes are minimal — 2 new fields on the Spike Prisma model + field mapping in analyzer.ts.

**Tech Stack:** Python 3.11 (SQLite, asyncio), FMP API (historical bars), Prisma 6 (schema), Next.js 15 (TypeScript field mapping)

**Spec:** `docs/superpowers/specs/2026-04-11-momentum-persistence-engine-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `momentum_engine.py` | **NEW** — MomentumPersistenceEngine class: candidate identification, signal computation, re-qualification gate, scoring, re-ranking, audit logging | Create |
| `canadian_llm_council_brain.py` | Integration: call MPE pre-council and post-council in `run_council()` | Modify |
| `api_server.py` | Pass MPE data through `_map_to_prisma()` | Modify |
| `prisma/schema.prisma` | Add `momentumStatus` field to Spike model | Modify |
| `src/lib/scheduling/analyzer.ts` | Add `momentumStatus` to interface + `buildSpikeData()` | Modify |

---

## Task 1: Create `momentum_engine.py` — SQLite Table + Constants

**Files:**
- Create: `momentum_engine.py`

- [ ] **Step 1: Create the module with table init and constants**

Create `momentum_engine.py` in the project root (same directory as `canadian_llm_council_brain.py`):

```python
"""Momentum Persistence Engine (MPE) — v6.2

Identifies proven winners from pick_history, computes 4 live momentum
signals, and re-ranks the council's Top 10 by blending spike scores
with a momentum score. Two integration points:
  - Pre-council: inject momentum candidates into universe with data packets
  - Post-council: compute momentum scores and re-rank final Top 10
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
from typing import Optional

logger = logging.getLogger(__name__)

# ── Configuration Constants ──────────────────────────────────────────
# All tunable — adjust after 30 trading days of data without code changes.

# Eligibility
MPE_LOOKBACK_CALENDAR_DAYS = 14       # ~10 trading days
MPE_MIN_RETURN_3D = 3.0               # Minimum 3-day actual return (%)
MPE_MIN_RETURN_5D = 5.0               # Minimum 5-day actual return (%)

# Re-qualification gate thresholds
MPE_CORE_ROC_MIN = 0.0                # ROC-5 must be > 0%
MPE_CORE_ADX_MIN = 25.0               # ADX must be > 25
MPE_DEGRADATION_FACTOR = 0.6          # Score multiplier when 1 confirming signal fails

# Composite score blend weights
MORNING_SPIKE_WEIGHT = 0.65
MORNING_MOMENTUM_WEIGHT = 0.35
EVENING_SPIKE_WEIGHT = 0.55
EVENING_MOMENTUM_WEIGHT = 0.45

# Sector relative strength fallback threshold
MIN_SECTOR_PICKS_FOR_RS = 3           # Fall back to TSX if fewer sector picks


class MomentumPersistenceEngine:
    """Identifies proven winners and computes momentum scores for re-ranking."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_table()

    def _init_table(self):
        """Create momentum_candidates table if it doesn't exist."""
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS momentum_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scan_date TEXT NOT NULL,
                    scan_type TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    qualifying_pick_id INTEGER,
                    qualifying_return_3d REAL,
                    qualifying_return_5d REAL,
                    days_since_pick INTEGER,
                    roc_5d REAL,
                    adx REAL,
                    atr_current REAL,
                    atr_previous REAL,
                    atr_trend TEXT,
                    relative_strength REAL,
                    relative_strength_benchmark TEXT,
                    core_roc_pass INTEGER,
                    core_adx_pass INTEGER,
                    confirm_atr_pass INTEGER,
                    confirm_rs_pass INTEGER,
                    gate_result TEXT,
                    signal1_realized_return INTEGER,
                    signal2_roc INTEGER,
                    signal3_trend_strength INTEGER,
                    signal4_relative_strength INTEGER,
                    momentum_score_raw INTEGER,
                    degradation_factor REAL,
                    momentum_score_final INTEGER,
                    injected_into_universe INTEGER,
                    final_composite_score REAL,
                    final_rank INTEGER,
                    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(scan_date, scan_type, ticker)
                )
            """)
            conn.commit()
        finally:
            conn.close()
        logger.info("MPE: momentum_candidates table initialized")
```

- [ ] **Step 2: Commit**

```bash
git add momentum_engine.py
git commit -m "feat(mpe): create momentum_engine.py with table + constants

New module for Momentum Persistence Engine. Creates SQLite
momentum_candidates table for full audit trail. All configuration
constants defined at module level for easy tuning.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Task 2: Candidate Identification — Query pick_history for proven runners

**Files:**
- Modify: `momentum_engine.py`

- [ ] **Step 1: Add identify_candidates() method**

Add this method to the `MomentumPersistenceEngine` class after `_init_table()`:

```python
    def identify_candidates(self, scan_type: str) -> list[dict]:
        """Query pick_history for tickers with strong recent actual returns.

        Returns list of dicts with: ticker, pick_id, run_date, entry_price,
        return_3d, return_5d, rank, sector, days_since_pick.
        """
        conn = sqlite3.connect(self.db_path)
        try:
            cutoff = (date.today() - timedelta(days=MPE_LOOKBACK_CALENDAR_DAYS)).isoformat()
            rows = conn.execute("""
                SELECT ph.id, ph.ticker, ph.run_date, ph.entry_price,
                       ph.sector, ph.consensus_score,
                       a3.actual_move_pct as return_3d,
                       a5.actual_move_pct as return_5d
                FROM pick_history ph
                LEFT JOIN accuracy_records a3
                    ON ph.id = a3.pick_id AND a3.horizon_days = 3
                LEFT JOIN accuracy_records a5
                    ON ph.id = a5.pick_id AND a5.horizon_days = 5
                WHERE ph.run_date >= ?
                  AND ph.scan_type = ?
                  AND (
                      (a3.actual_move_pct IS NOT NULL AND a3.actual_move_pct > ?)
                      OR
                      (a5.actual_move_pct IS NOT NULL AND a5.actual_move_pct > ?)
                  )
                ORDER BY ph.run_date DESC
            """, (cutoff, scan_type, MPE_MIN_RETURN_3D, MPE_MIN_RETURN_5D)).fetchall()

            candidates = []
            seen_tickers = set()
            today = date.today()

            for row in rows:
                pick_id, ticker, run_date, entry_price, sector, consensus, ret_3d, ret_5d = row
                # Only keep the most recent qualifying pick per ticker
                if ticker in seen_tickers:
                    continue
                seen_tickers.add(ticker)

                pick_date = date.fromisoformat(run_date)
                days_since = (today - pick_date).days

                # Get rank from pick_history — look up appearances and rank trajectory
                ranks = conn.execute("""
                    SELECT ph2.run_date, 
                           (SELECT COUNT(*) + 1 FROM pick_history ph3
                            WHERE ph3.run_date = ph2.run_date
                              AND ph3.scan_type = ph2.scan_type
                              AND ph3.consensus_score > ph2.consensus_score) as approx_rank
                    FROM pick_history ph2
                    WHERE ph2.ticker = ? AND ph2.run_date >= ?
                      AND ph2.scan_type = ?
                    ORDER BY ph2.run_date
                """, (ticker, cutoff, scan_type)).fetchall()

                rank_trajectory = [r[1] for r in ranks]

                candidates.append({
                    "ticker": ticker,
                    "pick_id": pick_id,
                    "run_date": run_date,
                    "entry_price": entry_price,
                    "sector": sector or "Unknown",
                    "return_3d": ret_3d,
                    "return_5d": ret_5d,
                    "appearances": len(ranks),
                    "rank_trajectory": rank_trajectory,
                    "days_since_pick": days_since,
                })

            logger.info(f"MPE: Identified {len(candidates)} momentum candidates from pick_history")
            return candidates

        finally:
            conn.close()
```

- [ ] **Step 2: Commit**

```bash
git add momentum_engine.py
git commit -m "feat(mpe): add candidate identification from pick_history

Queries recent picks with strong actual returns (>3% 3d or >5% 5d).
Returns most recent qualifying pick per ticker with rank trajectory.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Task 3: Signal Computation — ROC, ADX, ATR trend, Relative Strength

**Files:**
- Modify: `momentum_engine.py`

- [ ] **Step 1: Add compute_signals() method**

Add after `identify_candidates()`:

```python
    def compute_signals(
        self,
        candidate: dict,
        historical_bars: list[dict],
        current_adx: float | None,
        current_atr: float | None,
        sector_avg_return_5d: float | None,
        tsx_change_5d: float | None,
    ) -> dict:
        """Compute 4 momentum signals for a candidate.

        Args:
            candidate: dict from identify_candidates()
            historical_bars: 10-day OHLCV bars from FMP (sorted by date asc)
            current_adx: ADX from council payload (technicals.adx_14)
            current_atr: ATR from council payload (technicals.atr_14)
            sector_avg_return_5d: average 5d return for same-sector picks
            tsx_change_5d: TSX composite 5-day change % (fallback)

        Returns:
            dict with: roc_5d, adx, atr_current, atr_previous, atr_trend,
            relative_strength, rs_benchmark, and all raw signal values.
        """
        signals = {
            "roc_5d": None,
            "adx": current_adx,
            "atr_current": current_atr,
            "atr_previous": None,
            "atr_trend": "flat",
            "relative_strength": None,
            "rs_benchmark": "TSX",
        }

        # ── ROC-5: Rate of Change over 5 trading days ──
        if len(historical_bars) >= 6:
            current_close = historical_bars[-1].get("close", 0)
            five_days_ago_close = historical_bars[-6].get("close", 0)
            if five_days_ago_close > 0:
                signals["roc_5d"] = ((current_close - five_days_ago_close) / five_days_ago_close) * 100

        # ── ATR Trend: compare current ATR to 5-day-ago ATR ──
        if current_atr is not None and len(historical_bars) >= 6:
            # Compute ATR from 5-day-ago bar using true range approximation
            bar_5d = historical_bars[-6]
            bar_5d_prev = historical_bars[-7] if len(historical_bars) >= 7 else bar_5d
            tr_5d = max(
                bar_5d.get("high", 0) - bar_5d.get("low", 0),
                abs(bar_5d.get("high", 0) - bar_5d_prev.get("close", 0)),
                abs(bar_5d.get("low", 0) - bar_5d_prev.get("close", 0)),
            )
            signals["atr_previous"] = tr_5d

            if tr_5d > 0:
                ratio = current_atr / tr_5d
                if ratio > 1.05:
                    signals["atr_trend"] = "expanding"
                elif ratio < 0.95:
                    signals["atr_trend"] = "contracting"
                else:
                    signals["atr_trend"] = "flat"

        # ── Relative Strength vs Sector (or TSX fallback) ──
        # Compute candidate's 5-day return from bars
        candidate_return_5d = signals["roc_5d"]  # ROC-5 IS the 5-day return

        if candidate_return_5d is not None:
            if sector_avg_return_5d is not None:
                signals["relative_strength"] = candidate_return_5d - sector_avg_return_5d
                signals["rs_benchmark"] = f"sector:{candidate.get('sector', 'Unknown')}"
            elif tsx_change_5d is not None:
                signals["relative_strength"] = candidate_return_5d - tsx_change_5d
                signals["rs_benchmark"] = "TSX"

        return signals

    def get_sector_avg_return(self, sector: str, scan_type: str) -> float | None:
        """Compute average 5-day return for recent picks in the same sector.
        Returns None if fewer than MIN_SECTOR_PICKS_FOR_RS picks exist."""
        conn = sqlite3.connect(self.db_path)
        try:
            cutoff = (date.today() - timedelta(days=MPE_LOOKBACK_CALENDAR_DAYS)).isoformat()
            row = conn.execute("""
                SELECT AVG(a5.actual_move_pct), COUNT(DISTINCT ph.id)
                FROM pick_history ph
                JOIN accuracy_records a5 ON ph.id = a5.pick_id AND a5.horizon_days = 5
                WHERE ph.sector = ? AND ph.run_date >= ? AND ph.scan_type = ?
                  AND a5.actual_move_pct IS NOT NULL
            """, (sector, cutoff, scan_type)).fetchone()

            if row and row[1] >= MIN_SECTOR_PICKS_FOR_RS:
                return round(row[0], 4)
            return None
        finally:
            conn.close()
```

- [ ] **Step 2: Commit**

```bash
git add momentum_engine.py
git commit -m "feat(mpe): add signal computation — ROC, ADX, ATR, relative strength

Computes 4 momentum signals from FMP historical bars + council
technicals. Relative strength uses sector average from pick_history
with TSX fallback when sector sample < 3 picks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Task 4: Re-qualification Gate + Momentum Scoring

**Files:**
- Modify: `momentum_engine.py`

- [ ] **Step 1: Add run_gate() and compute_momentum_score() methods**

Add after `get_sector_avg_return()`:

```python
    def run_gate(self, signals: dict) -> tuple[str, float]:
        """Run re-qualification gate on computed signals.

        Returns:
            (gate_result, degradation_factor)
            gate_result: 'QUALIFIED', 'DEGRADED', or 'DISQUALIFIED'
            degradation_factor: 1.0, 0.6, or 0.0
        """
        roc = signals.get("roc_5d")
        adx = signals.get("adx")

        # Core signals — must BOTH pass
        core_roc_pass = roc is not None and roc > MPE_CORE_ROC_MIN
        core_adx_pass = adx is not None and adx > MPE_CORE_ADX_MIN

        if not core_roc_pass or not core_adx_pass:
            return "DISQUALIFIED", 0.0

        # Confirming signals
        atr_trend = signals.get("atr_trend", "flat")
        rs = signals.get("relative_strength")

        confirm_atr_pass = atr_trend in ("expanding", "flat")
        confirm_rs_pass = rs is not None and rs > 0

        if not confirm_atr_pass and not confirm_rs_pass:
            return "DISQUALIFIED", 0.0

        if not confirm_atr_pass or not confirm_rs_pass:
            return "DEGRADED", MPE_DEGRADATION_FACTOR

        return "QUALIFIED", 1.0

    def compute_momentum_score(self, candidate: dict, signals: dict) -> dict:
        """Compute the 4-signal momentum score (0-100).

        Returns dict with signal1-4 individual scores, raw total, and
        final score after degradation.
        """
        gate_result, degradation = self.run_gate(signals)

        # Signal 1: Realized Return Score (0-25)
        best_return = max(
            candidate.get("return_3d") or 0,
            candidate.get("return_5d") or 0,
        )
        if best_return >= 15:
            s1 = 25
        elif best_return >= 10:
            s1 = 20
        elif best_return >= 5:
            s1 = 15
        elif best_return >= 3:
            s1 = 10
        elif best_return > 0:
            s1 = 5
        else:
            s1 = 0

        # Signal 2: ROC-5 Confirmation (0-25)
        roc = signals.get("roc_5d") or 0
        if roc > 10:
            s2 = 25
        elif roc > 5:
            s2 = 20
        elif roc > 2:
            s2 = 15
        elif roc > 0:
            s2 = 10
        else:
            s2 = 0

        # Signal 3: Trend Strength — ADX + ATR (0-25)
        adx = signals.get("adx") or 0
        atr_trend = signals.get("atr_trend", "flat")
        if adx > 30:
            if atr_trend == "expanding":
                s3 = 25
            elif atr_trend == "flat":
                s3 = 20
            else:
                s3 = 12
        elif adx > 25:
            if atr_trend == "expanding":
                s3 = 15
            else:
                s3 = 8
        else:
            s3 = 0

        # Signal 4: Relative Strength vs Sector (0-25)
        rs = signals.get("relative_strength") or 0
        if rs > 8:
            s4 = 25
        elif rs > 4:
            s4 = 20
        elif rs > 2:
            s4 = 15
        elif rs > 0:
            s4 = 10
        else:
            s4 = 0

        raw = s1 + s2 + s3 + s4
        final = int(raw * degradation)

        return {
            "signal1_realized_return": s1,
            "signal2_roc": s2,
            "signal3_trend_strength": s3,
            "signal4_relative_strength": s4,
            "momentum_score_raw": raw,
            "degradation_factor": degradation,
            "momentum_score_final": final,
            "gate_result": gate_result,
            "core_roc_pass": 1 if (signals.get("roc_5d") or 0) > MPE_CORE_ROC_MIN else 0,
            "core_adx_pass": 1 if (signals.get("adx") or 0) > MPE_CORE_ADX_MIN else 0,
            "confirm_atr_pass": 1 if signals.get("atr_trend") in ("expanding", "flat") else 0,
            "confirm_rs_pass": 1 if (signals.get("relative_strength") or 0) > 0 else 0,
        }
```

- [ ] **Step 2: Commit**

```bash
git add momentum_engine.py
git commit -m "feat(mpe): add re-qualification gate + momentum scoring

Core signals (ROC > 0%, ADX > 25) must both pass. Confirming signals
(ATR trend, relative strength) allow degradation. 4-signal score
0-100 with degradation applied for DEGRADED status.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Task 5: Momentum Data Packet + Re-ranking + Audit Logging

**Files:**
- Modify: `momentum_engine.py`

- [ ] **Step 1: Add build_data_packet(), rerank_top10(), and log_candidate() methods**

Add after `compute_momentum_score()`:

```python
    def build_data_packet(self, candidate: dict, signals: dict, score: dict, current_price: float) -> str:
        """Build the Momentum Data Packet string for LLM prompt injection.

        This text block is attached to the ticker's payload so all 4 LLM
        stages can reason about verified momentum performance.
        """
        entry_price = candidate.get("entry_price", 0)
        price_change_pct = ((current_price - entry_price) / entry_price * 100) if entry_price > 0 else 0

        roc_status = "strong" if (signals.get("roc_5d") or 0) > 5 else "positive" if (signals.get("roc_5d") or 0) > 0 else "negative"
        adx_status = "strong trend" if (signals.get("adx") or 0) > 30 else "moderate trend" if (signals.get("adx") or 0) > 25 else "weak"
        atr_status = signals.get("atr_trend", "flat")
        rs_val = signals.get("relative_strength") or 0
        rs_status = "outperforming" if rs_val > 0 else "underperforming"

        ranks_str = " → ".join(f"#{r}" for r in candidate.get("rank_trajectory", []))

        packet = (
            f"═══ MOMENTUM CANDIDATE ═══\n"
            f"This ticker was previously picked by this system and delivered verified returns.\n"
            f"• Last picked: {candidate['run_date']} (Rank #{candidate['rank_trajectory'][-1] if candidate['rank_trajectory'] else '?'})\n"
            f"• Actual 3-day return: {'+' if (candidate.get('return_3d') or 0) >= 0 else ''}{candidate.get('return_3d') or 'N/A'}%\n"
            f"• Actual 5-day return: {'+' if (candidate.get('return_5d') or 0) >= 0 else ''}{candidate.get('return_5d') or 'N/A'}%\n"
            f"• Appearances in last 10 trading days: {candidate.get('appearances', 1)}\n"
            f"• Rank trajectory: {ranks_str}\n"
            f"• Current price: ${current_price:.2f} ({'+' if price_change_pct >= 0 else ''}{price_change_pct:.1f}% since pick at ${entry_price:.2f})\n"
            f"• Live momentum signals:\n"
            f"  - ROC-5: {'+' if (signals.get('roc_5d') or 0) >= 0 else ''}{signals.get('roc_5d', 0):.1f}% ({roc_status})\n"
            f"  - ADX: {signals.get('adx', 0):.1f} ({adx_status})\n"
            f"  - ATR trend: {atr_status}\n"
            f"  - Relative strength vs {signals.get('rs_benchmark', 'TSX')}: {'+' if rs_val >= 0 else ''}{rs_val:.1f}% ({rs_status})\n"
            f"• Momentum status: {score['gate_result']} (score: {score['momentum_score_final']}/100)\n"
            f"═══════════════════════════"
        )
        return packet

    @staticmethod
    def rerank_top10(
        council_picks: list[dict],
        momentum_candidates: list[dict],
        scan_type: str,
    ) -> list[dict]:
        """Re-rank council Top 10 by blending spike score with momentum score.

        Args:
            council_picks: list of dicts with at least 'ticker', 'consensus_score'
            momentum_candidates: list of dicts from the full MPE pipeline with
                'ticker', 'momentum_score_final', 'gate_result'
            scan_type: 'MORNING' or 'EVENING'

        Returns:
            Re-ranked list of picks (Top 10) with 'final_composite_score' added.
        """
        if scan_type == "EVENING":
            spike_w = EVENING_SPIKE_WEIGHT
            momentum_w = EVENING_MOMENTUM_WEIGHT
        else:
            spike_w = MORNING_SPIKE_WEIGHT
            momentum_w = MORNING_MOMENTUM_WEIGHT

        # Build momentum lookup: ticker -> score
        momentum_lookup = {}
        for mc in momentum_candidates:
            if mc.get("gate_result") in ("QUALIFIED", "DEGRADED"):
                momentum_lookup[mc["ticker"]] = mc

        # Collect all candidates: council top 10 + qualified momentum outsiders
        all_candidates = []

        for pick in council_picks:
            ticker = pick["ticker"]
            spike_score = pick.get("consensus_score", 0)
            mc = momentum_lookup.get(ticker)
            momentum_score = mc["momentum_score_final"] if mc else 0
            momentum_status = mc["gate_result"] if mc else None

            composite = (spike_score * spike_w) + (momentum_score * momentum_w)

            all_candidates.append({
                **pick,
                "momentum_score": momentum_score,
                "momentum_status": momentum_status,
                "final_composite_score": round(composite, 2),
            })

        # Add qualified momentum candidates NOT in council top 10
        council_tickers = {p["ticker"] for p in council_picks}
        for mc in momentum_candidates:
            if mc["ticker"] not in council_tickers and mc.get("gate_result") in ("QUALIFIED", "DEGRADED"):
                # These are runners the council missed — they need a spike score.
                # Use their original consensus_score from pick_history as proxy.
                spike_score = mc.get("original_consensus", 50)
                momentum_score = mc["momentum_score_final"]
                composite = (spike_score * spike_w) + (momentum_score * momentum_w)

                all_candidates.append({
                    "ticker": mc["ticker"],
                    "consensus_score": spike_score,
                    "momentum_score": momentum_score,
                    "momentum_status": mc["gate_result"],
                    "final_composite_score": round(composite, 2),
                    "injected_by_mpe": True,
                })

        # Sort by composite score descending, take top 10
        all_candidates.sort(key=lambda x: -x["final_composite_score"])
        top_10 = all_candidates[:10]

        # Re-assign ranks
        for i, pick in enumerate(top_10, 1):
            pick["rank"] = i

        logger.info(
            f"MPE: Re-ranked Top 10. "
            f"Momentum-backed: {sum(1 for p in top_10 if p.get('momentum_status'))}, "
            f"Fresh: {sum(1 for p in top_10 if not p.get('momentum_status'))}"
        )

        return top_10

    def log_candidate(
        self,
        scan_date: str,
        scan_type: str,
        candidate: dict,
        signals: dict,
        score: dict,
        injected: bool,
        final_composite: float | None,
        final_rank: int | None,
    ):
        """Write audit row to momentum_candidates table."""
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute("""
                INSERT OR REPLACE INTO momentum_candidates (
                    scan_date, scan_type, ticker,
                    qualifying_pick_id, qualifying_return_3d, qualifying_return_5d,
                    days_since_pick,
                    roc_5d, adx, atr_current, atr_previous, atr_trend,
                    relative_strength, relative_strength_benchmark,
                    core_roc_pass, core_adx_pass, confirm_atr_pass, confirm_rs_pass,
                    gate_result,
                    signal1_realized_return, signal2_roc,
                    signal3_trend_strength, signal4_relative_strength,
                    momentum_score_raw, degradation_factor, momentum_score_final,
                    injected_into_universe, final_composite_score, final_rank
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                scan_date, scan_type, candidate["ticker"],
                candidate.get("pick_id"), candidate.get("return_3d"), candidate.get("return_5d"),
                candidate.get("days_since_pick"),
                signals.get("roc_5d"), signals.get("adx"),
                signals.get("atr_current"), signals.get("atr_previous"),
                signals.get("atr_trend"),
                signals.get("relative_strength"), signals.get("rs_benchmark"),
                score.get("core_roc_pass"), score.get("core_adx_pass"),
                score.get("confirm_atr_pass"), score.get("confirm_rs_pass"),
                score.get("gate_result"),
                score.get("signal1_realized_return"), score.get("signal2_roc"),
                score.get("signal3_trend_strength"), score.get("signal4_relative_strength"),
                score.get("momentum_score_raw"), score.get("degradation_factor"),
                score.get("momentum_score_final"),
                1 if injected else 0, final_composite, final_rank,
            ))
            conn.commit()
        except Exception as e:
            logger.warning(f"MPE: Failed to log candidate {candidate['ticker']}: {e}")
        finally:
            conn.close()
```

- [ ] **Step 2: Commit**

```bash
git add momentum_engine.py
git commit -m "feat(mpe): add data packet builder, re-ranker, and audit logging

build_data_packet() generates LLM-visible momentum context.
rerank_top10() blends spike + momentum scores (65/35 morning,
55/45 evening) and re-ranks. log_candidate() writes full audit
trail to SQLite.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Task 6: Integrate MPE into run_council() — Pre-Council Phase

**Files:**
- Modify: `canadian_llm_council_brain.py`

This is the pre-council injection. MPE identifies candidates, fetches historical bars, computes signals, runs the gate, and injects qualified candidates into the universe with Momentum Data Packets.

- [ ] **Step 1: Add MPE import and initialization**

At the top of `canadian_llm_council_brain.py`, after the existing imports (around line 50), add:

```python
from momentum_engine import MomentumPersistenceEngine
```

In the `CanadianStockCouncilBrain.__init__()` method, after the existing `self.historical_analyzer` initialization, add:

```python
        self.mpe = MomentumPersistenceEngine(db_path=DB_PATH)
```

- [ ] **Step 2: Add pre-council MPE step in run_council()**

In `run_council()`, find Step 4b (noise filter, around line 4872). Insert a new step **between** Step 4 (payloads built) and Step 4b (noise filter):

```python
            # ── Step 4a: Momentum Persistence Engine — pre-council ──
            logger.info("Step 4a: MPE — identifying momentum candidates")
            _scan_type = trigger.upper() if trigger.upper() in ("MORNING", "EVENING") else "MORNING"
            mpe_candidates_raw = self.mpe.identify_candidates(scan_type=_scan_type)
            mpe_processed = []  # will hold full candidate data for post-council

            if mpe_candidates_raw:
                # Fetch historical bars for candidates (10-day window)
                mpe_tickers = [c["ticker"] for c in mpe_candidates_raw]
                mpe_bars = {}
                for ticker in mpe_tickers:
                    bars = await self.fetcher.fetch_historical(ticker, days=15)
                    if bars:
                        mpe_bars[ticker] = bars[-10:]  # last 10 bars

                # Get current quotes for live price
                mpe_quotes = await self.fetcher.fetch_quotes(mpe_tickers)

                # Compute TSX 5-day change for fallback
                tsx_change_5d = None
                if macro:
                    tsx_change_5d = getattr(macro, "tsx_change_5d", None)

                universe_tickers = set(p.ticker for p in payloads_list)

                for candidate in mpe_candidates_raw:
                    ticker = candidate["ticker"]
                    bars = mpe_bars.get(ticker, [])
                    quote = mpe_quotes.get(ticker, {})
                    current_price = quote.get("price", candidate.get("entry_price", 0))

                    # Get ADX and ATR from existing payload if available
                    existing_payload = next((p for p in payloads_list if p.ticker == ticker), None)
                    current_adx = existing_payload.technicals.adx_14 if existing_payload and existing_payload.technicals else None
                    current_atr = existing_payload.technicals.atr_14 if existing_payload and existing_payload.technicals else None

                    # Compute sector avg return for relative strength
                    sector_avg = self.mpe.get_sector_avg_return(candidate["sector"], _scan_type)

                    # Compute signals
                    signals = self.mpe.compute_signals(
                        candidate, bars, current_adx, current_atr, sector_avg, tsx_change_5d
                    )

                    # Run gate + score
                    score = self.mpe.compute_momentum_score(candidate, signals)

                    # Build data packet for qualified/degraded candidates
                    injected = False
                    if score["gate_result"] in ("QUALIFIED", "DEGRADED"):
                        packet = self.mpe.build_data_packet(candidate, signals, score, current_price)

                        if ticker in universe_tickers and existing_payload:
                            # Attach packet to existing payload
                            existing_payload.momentum_data_packet = packet
                        else:
                            # Inject into universe — candidate needs payload built
                            logger.info(f"MPE: Injecting {ticker} into universe (not in current screener)")
                            injected = True
                            # Build a fresh payload for this ticker
                            if bars:
                                profile = None  # will be fetched during regular payload build
                                new_payload = await self.fetcher.build_payload(
                                    ticker, quote, bars, macro=macro, profile=profile
                                )
                                if new_payload:
                                    new_payload.momentum_data_packet = packet
                                    payloads_list.append(new_payload)
                                    universe_tickers.add(ticker)

                    mpe_processed.append({
                        "ticker": ticker,
                        "candidate": candidate,
                        "signals": signals,
                        "score": score,
                        "injected": injected,
                        "current_price": current_price,
                        "original_consensus": candidate.get("return_3d", 50),
                        "momentum_score_final": score["momentum_score_final"],
                        "gate_result": score["gate_result"],
                    })

                logger.info(
                    f"MPE: {len(mpe_processed)} candidates processed. "
                    f"Qualified: {sum(1 for m in mpe_processed if m['score']['gate_result'] == 'QUALIFIED')}, "
                    f"Degraded: {sum(1 for m in mpe_processed if m['score']['gate_result'] == 'DEGRADED')}, "
                    f"Disqualified: {sum(1 for m in mpe_processed if m['score']['gate_result'] == 'DISQUALIFIED')}"
                )
```

- [ ] **Step 3: Add momentum_data_packet field to StockDataPayload**

Find the `StockDataPayload` class (around line 180). Add a new optional field at the end:

```python
    momentum_data_packet: str | None = None   # MPE: injected momentum context for LLM stages
```

- [ ] **Step 4: Include momentum_data_packet in LLM prompts**

Find where Stage 1 prompt is built (look for the prompt construction that includes payload data). The payload is serialized to JSON or text for the LLM. Add the momentum packet to the prompt construction.

Search for where `payload` fields are formatted into the LLM prompt string. Add after the existing payload data:

```python
            # If this ticker has a momentum data packet, append it
            if hasattr(payload, 'momentum_data_packet') and payload.momentum_data_packet:
                prompt_text += f"\n\n{payload.momentum_data_packet}\n"
```

This needs to be added to each stage's prompt builder (Stages 1-4). The exact location depends on how prompts are constructed — search for where `StockDataPayload` fields are serialized.

- [ ] **Step 5: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat(mpe): integrate pre-council phase into run_council()

Step 4a identifies momentum candidates, fetches FMP historical bars,
computes signals, runs re-qualification gate, and injects qualified
runners into the universe with Momentum Data Packets visible to
all 4 LLM stages.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Task 7: Integrate MPE into run_council() — Post-Council Re-Rank

**Files:**
- Modify: `canadian_llm_council_brain.py`

- [ ] **Step 1: Add post-council re-ranking after consensus is built**

Find where the final Top 10 is produced in `_build_consensus()` (around line 2561-2578, where `scored_tickers` is sorted and sliced to `top_10`). The re-ranking happens AFTER `_build_consensus` returns, in `run_council()`.

Find where `_build_consensus` is called in `run_council()` and the result is processed. After the consensus picks are built but BEFORE `record_picks` is called (line ~5611), add:

```python
            # ── Step 14b: MPE post-council re-rank ──
            if mpe_processed:
                logger.info("Step 14b: MPE — post-council re-ranking")
                scan_date = result_dict.get("run_date", date.today().isoformat())

                # Extract council picks as dicts for re-ranking
                council_pick_dicts = []
                for pick in result_dict.get("top_picks", []):
                    council_pick_dicts.append({
                        "ticker": pick.get("ticker"),
                        "consensus_score": pick.get("consensus_score", 0),
                        **pick,  # preserve all fields
                    })

                # Re-rank
                reranked = MomentumPersistenceEngine.rerank_top10(
                    council_pick_dicts, mpe_processed, _scan_type
                )

                # Update result_dict with re-ranked picks
                for i, pick in enumerate(reranked):
                    pick["rank"] = i + 1
                    pick["momentum_score"] = pick.get("momentum_score", 0)
                    pick["momentum_status"] = pick.get("momentum_status")

                result_dict["top_picks"] = reranked
                result_dict["mpe_applied"] = True
                result_dict["mpe_candidates_count"] = len(mpe_processed)

                # Log all candidates to audit table
                for mc in mpe_processed:
                    # Find this ticker's final rank (if it made Top 10)
                    final_pick = next((p for p in reranked if p["ticker"] == mc["ticker"]), None)
                    self.mpe.log_candidate(
                        scan_date=scan_date,
                        scan_type=_scan_type,
                        candidate=mc["candidate"],
                        signals=mc["signals"],
                        score=mc["score"],
                        injected=mc["injected"],
                        final_composite=final_pick["final_composite_score"] if final_pick else None,
                        final_rank=final_pick["rank"] if final_pick else None,
                    )

                logger.info(f"MPE: Post-council re-rank complete. {len(mpe_processed)} candidates logged to audit table.")
            else:
                result_dict["mpe_applied"] = False
                result_dict["mpe_candidates_count"] = 0
```

- [ ] **Step 2: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat(mpe): integrate post-council re-ranking into run_council()

After Stage 4 produces Top 10, MPE blends spike + momentum scores
(65/35 morning, 55/45 evening), re-ranks, and may substitute
runners for weak fresh picks. Full audit trail written to SQLite.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Task 8: Pass MPE Fields Through API + Prisma + TypeScript

**Files:**
- Modify: `api_server.py`
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/scheduling/analyzer.ts`

- [ ] **Step 1: Update _map_to_prisma() in api_server.py**

Find the `_map_to_prisma()` function in `api_server.py`. In the spike mapping section, add momentum fields:

```python
            # MPE fields
            "momentumScore": pick.get("momentum_score"),
            "momentumStatus": pick.get("momentum_status"),
```

- [ ] **Step 2: Add momentumStatus to Prisma Spike model**

In `prisma/schema.prisma`, find the Spike model. The `momentumScore` field already exists (line ~168). Add `momentumStatus` after it:

```prisma
  momentumScore   Float?
  momentumStatus  String?   // MPE: 'QUALIFIED', 'DEGRADED', or null (fresh pick)
```

- [ ] **Step 3: Regenerate Prisma client**

```bash
npx prisma generate
```

- [ ] **Step 4: Update CouncilMappedResponse interface in analyzer.ts**

In `src/lib/scheduling/analyzer.ts`, find the `CouncilMappedResponse` interface (line ~39 has `momentumScore`). Add after it:

```typescript
    momentumStatus: string | null;
```

- [ ] **Step 5: Update buildSpikeData() in analyzer.ts**

In `buildSpikeData()` (around line 266), add after the existing `momentumScore` mapping:

```typescript
      momentumStatus: spike.momentumStatus ?? null,
```

- [ ] **Step 6: Build verify**

```bash
npx next build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add api_server.py prisma/schema.prisma src/lib/scheduling/analyzer.ts
git commit -m "feat(mpe): pass momentum fields through API → Prisma → TypeScript

Add momentumStatus to Spike model (Prisma), _map_to_prisma (Python),
CouncilMappedResponse interface + buildSpikeData (TypeScript).
momentumScore already existed; momentumStatus is new.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Task 9: Version Bump to 6.2.5 + Deploy to Production

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Version bump**

In `package.json`, change:
```json
"version": "6.1.2"
```
to:
```json
"version": "6.2.5"
```

- [ ] **Step 2: Commit and tag**

```bash
git add package.json
git commit -m "chore: bump version to v6.2.5 — Momentum Persistence Engine

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git tag v6.2.5
git push origin main --tags
```

- [ ] **Step 3: Deploy to production**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && git pull origin main'
```

- [ ] **Step 4: Rebuild containers**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose build --no-cache app cron council 2>&1 | tail -5'
```

- [ ] **Step 5: Apply schema changes**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose run --rm app node node_modules/prisma/build/index.js db push --accept-data-loss 2>&1 | tail -5'
```

- [ ] **Step 6: Restart containers**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose up -d app cron council && sleep 10 && docker compose ps --format "{{.Name}}: {{.Status}}"'
```

Expected: All 6 containers up and healthy.

- [ ] **Step 7: Verify MPE table exists**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'docker exec spike-trades-council python3 -c "
import sqlite3
conn = sqlite3.connect(\"/app/data/spike_trades_council.db\")
tables = conn.execute(\"SELECT name FROM sqlite_master WHERE type='\''table'\'' AND name='\''momentum_candidates'\''\").fetchall()
print(\"momentum_candidates table:\", \"EXISTS\" if tables else \"MISSING\")
conn.close()
"'
```

- [ ] **Step 8: Refresh backup**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'bash -s' << 'REMOTE'
BACKUP_DIR="/root/spiketrades-backup/2026-04-11"
mkdir -p "$BACKUP_DIR"
cd /opt/spike-trades
git bundle create "$BACKUP_DIR/spiketrades-repo.bundle" --all
docker exec spike-trades-db pg_dump -U spiketrades spiketrades > "$BACKUP_DIR/spiketrades-db.sql"
rm -rf "$BACKUP_DIR/council-data/"
docker cp spike-trades-council:/app/data/ "$BACKUP_DIR/council-data/"
ls -lh "$BACKUP_DIR/"
REMOTE
```

---

## Verification Checklist

After deployment, verify before the next scan:

| Check | Command/Method | Expected |
|-------|---------------|----------|
| Build passes | `npx next build` | Zero errors |
| momentum_candidates table exists | Query SQLite | Table present |
| momentumStatus field on Spike | `prisma/schema.prisma` | Field exists |
| MPE constants configurable | Read `momentum_engine.py` header | All constants at module level |
| No import errors | Container logs on startup | No Python import failures |
| Version | `grep version package.json` | 6.2.5 |
| Tag | `git tag -l` | v6.2.5 |

**First live test:** The next council scan (morning at 11:15 AM or evening at 8:00 PM AST) will run MPE automatically. Check council container logs for `MPE:` prefixed log lines showing candidate identification, signal computation, gate results, and re-ranking.
