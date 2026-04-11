# Momentum Persistence Engine (MPE) — Design Spec

**Date:** 2026-04-11
**Version:** v6.2
**Status:** Approved — ready for implementation plan

---

## Problem

The current scoring system is forward-looking only. It asks "is this a good setup?" but never asks "did our last pick on this stock actually work?" Proven winners like CLS.TO (picked at $399, ran to $486 = +21.7%) get demoted on subsequent scans because their technicals show "overbought" — even though the stock keeps running. Meanwhile, the bottom 6-8 picks in each Top 10 are effectively noise (avg +0.81% 3-day return for one-time picks vs +1.48% for repeat picks).

The system lacks momentum persistence: the ability to recognize that a stock it previously picked is delivering verified returns and should be elevated, not rotated out in favor of unproven fresh setups.

## Solution

A two-phase engine that:
1. **Pre-council:** Identifies proven runners from pick_history, computes 4 live momentum signals, injects them into the Stage 1 universe with a Momentum Data Packet so all LLM stages can reason about verified performance
2. **Post-council:** Computes a Momentum Score (0-100) from the 4 signals, blends it with the council's spike score, and re-ranks the final Top 10

No reserved slots. Pure meritocracy. A fresh pick with an exceptional spike score can still beat a momentum runner — but a proven winner with strong live signals will almost always outrank a mediocre fresh setup.

---

## Phase A: Pre-Council Injection

### Momentum Candidate Identification

**When:** Start of `run_council()`, before Stage 1 screening.
**Source:** `pick_history` + `accuracy_records` in SQLite.

**Eligibility criteria:**

| Criterion | Threshold |
|-----------|-----------|
| Picked within last 10 trading days | `run_date >= today - 14 calendar days` |
| Actual 3-day return > +3% | `actual_move_pct > 3.0 WHERE horizon_days = 3` |
| OR actual 5-day return > +5% | Same logic, 5-day horizon |
| Not already failed re-qualification on this scan | Gate check runs after identification |

**Expected candidate count:** 2-5 tickers per scan. Zero on broad market selloff days.

### Live Data Fetch

For each momentum candidate, fetch 10-day historical bars from FMP via existing `LiveDataFetcher.fetch_historical()`. Compute:
- **ROC-5:** 5-day rate of change from historical closes
- **ADX:** Already available in council payload per ticker
- **ATR + ATR trend:** Current ATR from council payload, previous ATR from 5-day-ago bar. Expanding if current > previous, contracting if less, flat if within 5%.
- **Relative strength vs sector:** Candidate's 5-day return minus average 5-day return of same-sector picks from pick_history. Falls back to relative strength vs TSX (from macro context) when fewer than 3 same-sector picks exist in the 10-day window.

### Re-qualification Gate

Every scan, candidates must pass re-qualification on live signals. No time-based decay.

**Core signals (must BOTH pass — failure = immediate disqualification):**

| Signal | Pass | Fail |
|--------|------|------|
| ROC-5 | > 0% | Momentum broken |
| ADX | > 25 | No trend exists |

**Confirming signals (1 failure = degraded, both fail = disqualified):**

| Signal | Pass | Fail |
|--------|------|------|
| ATR trend | Expanding or flat | Contracting |
| Relative strength vs sector | > 0% | Underperforming peers |

**Gate results:**
- Both core pass + both confirming pass = **QUALIFIED** (100% momentum score)
- Both core pass + 1 confirming fails = **DEGRADED** (60% momentum score)
- Either core fails OR both confirming fail = **DISQUALIFIED** (0% — compete on spike score only)

### Momentum Data Packet

Attached to qualifying candidates' payloads for all LLM stages:

```
═══ MOMENTUM CANDIDATE ═══
This ticker was previously picked by this system and delivered verified returns.
• Last picked: {date} (Rank #{rank})
• Actual 3-day return: +{return}%
• Actual 5-day return: +{return}%
• Appearances in last 10 trading days: {count}
• Rank trajectory: {ranks}
• Current price: ${price} (+{pct}% since first pick at ${entry})
• Live momentum signals:
  - ROC-5: +{roc}% ({status})
  - ADX: {adx} ({status})
  - ATR trend: {trend} ({status})
  - Relative strength vs {benchmark}: +{rs}% ({status})
• Momentum status: {QUALIFIED|DEGRADED}
═══════════════════════════
```

### Universe Injection

If a qualifying candidate is NOT already in the Stage 1 universe (e.g., volume cooled off and the normal screener didn't pick it up), it gets injected with its full payload + Momentum Data Packet. If it IS already in the universe, the packet is attached to the existing payload.

---

## Phase B: Post-Council Re-Rank

### Momentum Score (0-100)

Computed for every ticker in the Top 10 + any qualified momentum candidates NOT in the Top 10.

**Signal 1: Realized Return Score (0-25)**

| Actual Return (best recent) | Score |
|-----------------------------|-------|
| +15% or more | 25 |
| +10% to +15% | 20 |
| +5% to +10% | 15 |
| +3% to +5% | 10 |
| 0% to +3% | 5 |
| Negative or no history | 0 |

**Signal 2: ROC-5 Confirmation (0-25)**

| ROC-5 | Score |
|-------|-------|
| > +10% | 25 |
| +5% to +10% | 20 |
| +2% to +5% | 15 |
| 0% to +2% | 10 |
| Negative | 0 |

**Signal 3: Trend Strength — ADX + ATR (0-25)**

| ADX | ATR Trend | Score |
|-----|-----------|-------|
| > 30 | Expanding | 25 |
| > 30 | Flat | 20 |
| > 30 | Contracting | 12 |
| 25-30 | Expanding | 15 |
| 25-30 | Any other | 8 |
| < 25 | Any | 0 |

**Signal 4: Relative Strength vs Sector (0-25)**

| Outperformance vs sector (5d) | Score |
|-------------------------------|-------|
| > +8% | 25 |
| +4% to +8% | 20 |
| +2% to +4% | 15 |
| 0% to +2% | 10 |
| Underperforming | 0 |

Falls back to relative strength vs TSX when sector sample < 3 picks in 10-day window.

### Composite Score Blending

```
Morning:  Final = (Spike Score x 0.65) + (Momentum Score x 0.35)
Evening:  Final = (Spike Score x 0.55) + (Momentum Score x 0.45)
```

Evening gets heavier momentum weight because all 4 signals are computed from complete EOD bars (more reliable than morning's partial-day data).

Weights stored as configurable constants:
```python
MORNING_SPIKE_WEIGHT = 0.65
MORNING_MOMENTUM_WEIGHT = 0.35
EVENING_SPIKE_WEIGHT = 0.55
EVENING_MOMENTUM_WEIGHT = 0.45
```

### Degradation Applied

After computing raw Momentum Score, multiply by degradation factor:
- QUALIFIED: x 1.0
- DEGRADED: x 0.6
- DISQUALIFIED: x 0.0

### Final Re-Rank

All tickers (Top 10 from council + qualified momentum candidates outside Top 10) are sorted by Final Composite Score. Top 10 are selected. A proven runner outside the council's Top 10 can displace a weak fresh pick. A strong fresh pick can still beat a runner.

---

## Storage and Auditability

### SQLite: `momentum_candidates` table

```sql
CREATE TABLE IF NOT EXISTS momentum_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_date TEXT NOT NULL,
    scan_type TEXT NOT NULL,
    ticker TEXT NOT NULL,
    qualifying_pick_id INTEGER REFERENCES pick_history(id),
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
);
```

### Prisma: New fields on Spike model

```prisma
// Momentum Persistence Engine (v6.2)
momentumScore        Int?
momentumStatus       String?   // 'QUALIFIED', 'DEGRADED', null
```

### SpikeCard UI (follow-on, not blocking)

- **Momentum badge:** Amber "Momentum" tag for QUALIFIED, dimmed for DEGRADED, absent for fresh picks
- **Momentum detail row:** `Momentum: 78/100 | ROC +8.2% | ADX 34 | ATR up | vs Sector +5.1%`
- Failing confirming signals shown in red for DEGRADED candidates

---

## Pipeline Integration

```
Pre-Council:
  1. Fetch universe (existing)
  2. Fetch quotes + liquidity filter (existing)
  3. MPE: Identify candidates from pick_history
  4. MPE: Fetch 10-day FMP historical bars for candidates
  5. MPE: Compute 4 signals, run re-qualification gate
  6. MPE: Attach Momentum Data Packets, inject into universe
  7. Build payloads (existing, now includes MPE packets)
  8. Noise filter (existing)

Council:
  Stages 1-4 run normally (see MPE context in payloads)

Post-Council:
  9. MPE: Compute Momentum Score for Top 10 + qualified outsiders
  10. MPE: Apply degradation, blend composite scores
  11. MPE: Re-rank by Final Score, take Top 10
  12. MPE: Write momentum_candidates audit row
  13. Record picks (existing)
  14. Archive + Report + Email + Vault (existing)
```

---

## Data Sources

| Data | Source | New API calls? |
|------|--------|---------------|
| Recent picks + actual returns | pick_history + accuracy_records SQLite | No |
| Live prices | LiveDataFetcher.fetch_quotes() | No (already fetched) |
| 10-day historical bars | LiveDataFetcher.fetch_historical() via FMP | Yes — 2-5 calls per scan |
| ADX | Council payload per ticker | No |
| ATR | Council payload + historical bars | No new calls |
| Sector avg return | pick_history same-sector picks | No |
| TSX change (fallback) | Council macro context | No |

---

## What This Does NOT Change

- No changes to the 4 LLM stage prompts (they see the data packet in the payload, they reason about it naturally)
- No changes to the scoring formula inside the council stages
- No changes to email templates, archive structure, or report format
- No schema migrations beyond 2 new nullable fields on Spike model
- No changes to accuracy tracking or backfill logic

---

## Configuration Constants

```python
# Eligibility
MPE_LOOKBACK_TRADING_DAYS = 10
MPE_MIN_RETURN_3D = 3.0
MPE_MIN_RETURN_5D = 5.0

# Re-qualification thresholds
MPE_CORE_ROC_MIN = 0.0
MPE_CORE_ADX_MIN = 25.0
MPE_DEGRADATION_FACTOR = 0.6

# Blend weights
MORNING_SPIKE_WEIGHT = 0.65
MORNING_MOMENTUM_WEIGHT = 0.35
EVENING_SPIKE_WEIGHT = 0.55
EVENING_MOMENTUM_WEIGHT = 0.45
```

All configurable — can be tuned after 30 trading days of data without code changes.
