# Conviction Score Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Institutional Conviction Score (IIC) as a third graduated bar on SpikeCard between Council and History, and add an explicit `[0.5, 1.5]` cap on the 7-multiplier adjustment stack in `build_consensus_top10()`.

**Architecture:** Pure-function IIC scorer in the council brain (insider 35 / institutional 30 / analyst 20 / srs 15), new FMP endpoint fetcher for institutional ownership, new Prisma column on `Spike`, 6-file edit across the Python brain, api_server, TypeScript analyzer, types, and SpikeCard component. No backfill. Always-3-bars with "No Scoring — Insufficient Data" placeholder.

**Tech Stack:** Python 3.11 (aiohttp, Pydantic), FMP Ultimate REST, Next.js 14 App Router, Prisma + Postgres, TypeScript.

**Spec:** `docs/superpowers/specs/2026-04-08-conviction-score-cleanup-design.md`

**Verification approach:** No unit test framework exists in this project. Verification is build checks, live endpoint probes, psql queries, and browser DevTools — same pattern as the User Activity Heartbeat plan from earlier today.

---

## File Structure

### New files
None.

### Modified files

| Path | Responsibility | LoC delta |
|---|---|---|
| `prisma/schema.prisma` | Add `institutionalConvictionScore Int?` to Spike model | +1 |
| `canadian_llm_council_brain.py` | NEW `fetch_institutional_ownership` endpoint fetcher, `institutional_ownership_pct` field on StockDataPayload + populate, NEW `compute_iic` + 4 score helpers, call in `build_consensus_top10()`, multiplier cap block, `institutional_conviction_score` field on FinalHotPick | ~120 |
| `api_server.py` | Add `institutionalConvictionScore` to `mapped_spikes` dict | +1 |
| `src/lib/scheduling/analyzer.ts` | Add field to internal interface + `spikeData.map()` block | +2 |
| `src/types/index.ts` | Add `institutionalConvictionScore: number \| null` to SpikeCard type | +1 |
| `src/components/spikes/SpikeCard.tsx` | Update Council label conditional (always show), insert Smart bar block between Council and History | +35 |

### Not touched
- Stage 1/2/3/4 LLM prompts
- 100-point rubric text
- Stage weights `{0.15, 0.20, 0.30, 0.35}`
- `ConvictionEngine` threshold logic (HIGH/MEDIUM/LOW tiering)
- History bar rendering
- Learning engine bypass
- Heartbeat code, admin code, auth code

---

## Pre-flight: branch + verification baseline

### Task 0: Create feature branch and verify baseline

**Files:** none

- [ ] **Step 1: Fetch and verify clean working tree**

Run:
```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat fetch origin
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat status
```
Expected: working tree clean. The feature branch `feat/iic-conviction-score` already exists (created during spec-writing) and contains the spec commit. Confirm HEAD is on `feat/iic-conviction-score` and branch is up to date with origin.

- [ ] **Step 2: Verify the spec commit is present**

Run:
```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat log --oneline origin/main..HEAD
```
Expected: exactly one commit on top of main — `docs(spec): conviction score cleanup design (Sibling A)`.

- [ ] **Step 3: Baseline TypeScript build is green**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && npm run build 2>&1 | tail -20
```
Expected: build succeeds with no errors. This is the pre-change baseline.

- [ ] **Step 4: Baseline Python syntax check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```
Expected: `syntax OK` with no traceback.

---

## Task 1: Prisma schema addition

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Locate the Spike model**

Run:
```bash
grep -n "^model Spike" /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat/prisma/schema.prisma
```
Find the line number of `model Spike {`.

- [ ] **Step 2: Add the new field**

In `prisma/schema.prisma`, locate the line:
```prisma
  historicalConfidence              Float?
```

Add a new field directly after the existing `historicalConfidence`, `calibrationSamples`, and `overconfidenceFlag` block. If those fields exist in that order, add after `overconfidenceFlag`:

```prisma
  institutionalConvictionScore      Int?
```

The exact location is: find the line containing `historicalConfidence` in the Spike model, then add `institutionalConvictionScore Int?` on its own line within the Spike model block.

- [ ] **Step 3: Generate Prisma client**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && npx prisma generate
```
Expected: "Generated Prisma Client" with no errors.

- [ ] **Step 4: TypeScript build check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && npm run build 2>&1 | tail -20
```
Expected: build succeeds. The new field is optional so no consumer code breaks.

- [ ] **Step 5: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add prisma/schema.prisma
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(schema): add institutionalConvictionScore to Spike model"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 2: New FMP institutional ownership fetcher

**Files:**
- Modify: `canadian_llm_council_brain.py` (add new async function near other fetchers, around line 930)

- [ ] **Step 1: Locate the existing fetcher functions**

Run:
```bash
grep -n "^async def fetch_" /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat/canadian_llm_council_brain.py | head -10
```
Expected output shows `fetch_earnings_calendar`, `fetch_insider_trades`, `fetch_analyst_consensus`, `fetch_enhanced_signals_batch`. The new fetcher goes right after `fetch_analyst_consensus` (around line 966).

- [ ] **Step 2: Add `fetch_institutional_ownership` function**

Open `canadian_llm_council_brain.py` and find the end of `fetch_analyst_consensus` (the blank line right before `async def fetch_enhanced_signals_batch`).

Insert this function immediately before `fetch_enhanced_signals_batch`:

```python
async def fetch_institutional_ownership(
    session: aiohttp.ClientSession,
    ticker: str,
    api_key: str,
) -> Optional[float]:
    """
    Fetch institutional ownership percentage for a ticker from FMP.
    Returns the fraction of shares held by institutions (0.0-1.0), or None.
    Non-blocking: returns None on any error rather than raising.

    Endpoint: /api/v4/institutional-ownership/symbol-ownership (FMP Ultimate plan)
    """
    try:
        url = "https://financialmodelingprep.com/api/v4/institutional-ownership/symbol-ownership"
        params = {
            "symbol": ticker,
            "includeCurrentQuarter": "false",
            "apikey": api_key,
        }
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            if not data or not isinstance(data, list) or len(data) == 0:
                return None
            latest = data[0]
            pct = latest.get("ownershipPercent")
            if pct is None:
                return None
            # FMP returns as a percentage (e.g. 45.7 for 45.7%); normalize to [0,1]
            return min(max(float(pct) / 100.0, 0.0), 1.0)
    except Exception:
        return None
```

- [ ] **Step 3: Python syntax check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add canadian_llm_council_brain.py
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(brain): add fetch_institutional_ownership FMP endpoint"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 3: Payload field + fetcher wiring

**Files:**
- Modify: `canadian_llm_council_brain.py` (StockDataPayload around line 156, and the batch enrichment function around line 967)

- [ ] **Step 1: Add `institutional_ownership_pct` to StockDataPayload**

In `canadian_llm_council_brain.py`, find the `StockDataPayload` class (around line 136). Locate the line:
```python
    sector_relative_strength: Optional[float] = Field(None, description="Ticker change% minus sector avg")
```

Add a new field directly after it:
```python
    sector_relative_strength: Optional[float] = Field(None, description="Ticker change% minus sector avg")
    institutional_ownership_pct: Optional[float] = Field(None, ge=0.0, le=1.0, description="Fraction of shares held by institutions (from /v4/institutional-ownership)")
```

- [ ] **Step 2: Locate the per-ticker enrichment site**

Run:
```bash
grep -n "fetch_insider_trades\|fetch_analyst_consensus" /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat/canadian_llm_council_brain.py
```
Expected output shows both the function definitions AND their call sites. The call sites are the locations where per-ticker fetchers run.

- [ ] **Step 3: Add `fetch_institutional_ownership` call at the enrichment site**

Open `canadian_llm_council_brain.py` and locate the enrichment code (around line 970+ in `fetch_enhanced_signals_batch` or wherever per-ticker fetchers are gathered). Find where `fetch_insider_trades` and `fetch_analyst_consensus` are awaited on a per-ticker basis.

Alongside the existing gather/await calls for insider trades and analyst consensus, add:
```python
    inst_ownership = await fetch_institutional_ownership(session, ticker, api_key)
```

Then wherever the payload is being constructed or mutated with insider/analyst data, add:
```python
    payload.institutional_ownership_pct = inst_ownership
```

**If the existing code uses `asyncio.gather()` to run multiple fetchers in parallel, add `fetch_institutional_ownership(session, ticker, api_key)` as one of the awaitables and unpack the result alongside the others.** Preserve the existing parallel-fetch pattern; do not serialize calls.

- [ ] **Step 4: Python syntax check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add canadian_llm_council_brain.py
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(brain): wire institutional_ownership_pct into payload"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 4: IIC compute helpers

**Files:**
- Modify: `canadian_llm_council_brain.py` (insert new functions around line 2060, immediately before the `build_consensus_top10` function)

- [ ] **Step 1: Locate the insertion point**

Run:
```bash
grep -n "def build_consensus_top10\|^def _" /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat/canadian_llm_council_brain.py | head -10
```
Find the line number of `def build_consensus_top10` (around line 2060).

- [ ] **Step 2: Add the 5 IIC compute functions**

Insert the following block of code immediately BEFORE the `def build_consensus_top10` line:

```python
# ═══════════════════════════════════════════════════════════════════════════
# INSTITUTIONAL CONVICTION SCORE (IIC)
# ═══════════════════════════════════════════════════════════════════════════
# Unified 0-100 smart-money conviction signal surfaced on SpikeCard as a
# third graduated bar between Council and History.
#
# Weights: insider 35 / institutional 30 / analyst 20 / srs 15 = 100.
# Returns None ("No Scoring — Insufficient Data") when ALL 4 inputs are missing.
#
# Spec: docs/superpowers/specs/2026-04-08-conviction-score-cleanup-design.md

def _score_insider(ia: Optional["InsiderActivity"]) -> float:
    """Insider buying gets 0-35 points. Strongest single smart-money signal."""
    if ia is None or ia.recency_weighted_score is None:
        return 0.0
    r = ia.recency_weighted_score
    # r is clamped to [-1.0, 1.0] by the InsiderActivity Pydantic schema.
    if r >= 0.70:   return 35.0
    if r >= 0.45:   return 30.0
    if r >= 0.20:   return 25.0
    if r >= 0.00:   return 18.0
    if r >= -0.20:  return 10.0
    if r >= -0.50:  return 5.0
    return 0.0


def _score_institutional(ownership_pct: Optional[float]) -> float:
    """Institutional ownership 0-30 points. Captures 13F/13G filings."""
    if ownership_pct is None:
        return 0.0
    if ownership_pct >= 0.70:  return 30.0
    if ownership_pct >= 0.50:  return 26.0
    if ownership_pct >= 0.30:  return 22.0
    if ownership_pct >= 0.15:  return 16.0
    if ownership_pct >= 0.05:  return 10.0
    if ownership_pct > 0.0:    return 5.0
    return 0.0


def _score_analyst(ac: Optional["AnalystConsensus"]) -> float:
    """Analyst consensus 0-20 points."""
    if ac is None or ac.sentiment_score is None:
        return 0.0
    s = ac.sentiment_score  # clamped to [-1.0, 1.0]
    if s >= 0.70:   return 20.0
    if s >= 0.40:   return 17.0
    if s >= 0.20:   return 13.0
    if s >= 0.00:   return 9.0
    if s >= -0.30:  return 5.0
    return 0.0


def _score_srs(srs: Optional[float]) -> float:
    """Sector relative strength 0-15 points."""
    if srs is None:
        return 0.0
    # srs is ticker-change% minus sector-average-change%, effectively [-3, +3]
    if srs >= 2.0:   return 15.0
    if srs >= 1.0:   return 12.0
    if srs >= 0.5:   return 9.0
    if srs >= 0.0:   return 6.0
    if srs >= -0.5:  return 3.0
    return 0.0


def compute_iic(
    insider_activity: Optional["InsiderActivity"],
    institutional_ownership_pct: Optional[float],
    analyst_consensus: Optional["AnalystConsensus"],
    sector_relative_strength: Optional[float],
) -> Optional[int]:
    """
    Institutional Conviction Score (0-100) from smart-money signals.
    Returns None if ALL four input signals are missing or neutral
    (triggers "No Scoring — Insufficient Data" in the UI).
    """
    has_insider = (
        insider_activity is not None
        and insider_activity.recency_weighted_score is not None
        and insider_activity.recency_weighted_score != 0
    )
    has_institutional = (
        institutional_ownership_pct is not None
        and institutional_ownership_pct > 0
    )
    has_analyst = (
        analyst_consensus is not None
        and analyst_consensus.sentiment_score is not None
    )
    has_srs = sector_relative_strength is not None

    if not (has_insider or has_institutional or has_analyst or has_srs):
        return None

    total = (
        _score_insider(insider_activity)
        + _score_institutional(institutional_ownership_pct)
        + _score_analyst(analyst_consensus)
        + _score_srs(sector_relative_strength)
    )
    return int(round(min(max(total, 0), 100)))


```

- [ ] **Step 3: Python syntax check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add canadian_llm_council_brain.py
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(brain): add compute_iic helper + 4 component scorers"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 5: IIC call site + multiplier cap inside build_consensus_top10

**Files:**
- Modify: `canadian_llm_council_brain.py` — `build_consensus_top10` function, around lines 2250–2265

- [ ] **Step 1: Locate the end of the multiplier stack**

Run:
```bash
grep -n "edge_multiplier\|scored_tickers.append" /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat/canadian_llm_council_brain.py
```
Expected output shows `adjustments["edge_multiplier"] = edge_mult` around line 2258 and `scored_tickers.append(...)` around line 2261.

- [ ] **Step 2: Add multiplier cap + IIC compute between the two**

Find the exact block:
```python
        adjustments["edge_multiplier"] = edge_mult

        data["learning_adjustments"] = adjustments
        scored_tickers.append((ticker, consensus_score, len(stages), data))
```

Replace it with:
```python
        adjustments["edge_multiplier"] = edge_mult

        # ── Combined multiplier cap ──
        # Prevents the [0,100] clamp at FinalHotPick construction from
        # silently swallowing mathematically impossible scores.
        # directional_multiplier is excluded — it is an LLM forecast signal,
        # not a smart-money multiplier.
        CAP_MIN, CAP_MAX = 0.5, 1.5
        combined_adj = (
            sector_adj * earnings_mult * insider_adj * analyst_adj
            * srs_adj * disagreement_adj * iv_check * edge_mult
        )
        if combined_adj > CAP_MAX:
            consensus_score *= CAP_MAX / combined_adj
            adjustments["was_capped"] = True
        elif combined_adj < CAP_MIN:
            consensus_score *= CAP_MIN / combined_adj
            adjustments["was_capped"] = True
        else:
            adjustments["was_capped"] = False
        adjustments["combined_adj_multiplier"] = round(combined_adj, 4)

        # ── Institutional Conviction Score (IIC) ──
        # Pure derived view of smart-money signals. Does NOT replace the
        # existing consensus_score math — surfaces it as an orthogonal bar.
        iic_score = compute_iic(
            insider_activity=payload.insider_activity if payload else None,
            institutional_ownership_pct=payload.institutional_ownership_pct if payload else None,
            analyst_consensus=payload.analyst_consensus if payload else None,
            sector_relative_strength=payload.sector_relative_strength if payload else None,
        )
        data["institutional_conviction_score"] = iic_score

        data["learning_adjustments"] = adjustments
        scored_tickers.append((ticker, consensus_score, len(stages), data))
```

- [ ] **Step 3: Python syntax check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add canadian_llm_council_brain.py
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(brain): multiplier cap [0.5, 1.5] + IIC call site"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 6: FinalHotPick field + flow to pick construction

**Files:**
- Modify: `canadian_llm_council_brain.py` — `FinalHotPick` class around line 225 and the pick construction around line 2328–2358

- [ ] **Step 1: Add `institutional_conviction_score` field to FinalHotPick**

Find the `FinalHotPick` class (around line 225). Locate the line:
```python
    stages_appeared: int = Field(..., ge=1, le=4)
```

Anywhere in the class body (order doesn't matter for Pydantic), add:
```python
    institutional_conviction_score: Optional[int] = Field(None, ge=0, le=100, description="IIC 0-100, None if insufficient data")
```

A good specific place: right after `consensus_score` and `conviction_tier` fields (around line 233-234). Find the block:
```python
    consensus_score: float = Field(..., ge=0, le=100)
    conviction_tier: ConvictionTier
```

And add right after:
```python
    consensus_score: float = Field(..., ge=0, le=100)
    conviction_tier: ConvictionTier
    institutional_conviction_score: Optional[int] = Field(None, ge=0, le=100, description="IIC 0-100, None if insufficient data")
```

- [ ] **Step 2: Populate field in pick construction**

Find the `FinalHotPick(...)` constructor call around line 2328 (inside `build_consensus_top10`). The constructor has many `=` arguments spanning many lines. Find the line:
```python
            learning_adjustments=data.get("learning_adjustments"),
```

Add a new line directly BEFORE it:
```python
            institutional_conviction_score=data.get("institutional_conviction_score"),
            learning_adjustments=data.get("learning_adjustments"),
```

- [ ] **Step 3: Python syntax check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add canadian_llm_council_brain.py
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(brain): thread IIC into FinalHotPick output"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 7: api_server.py mapped_spikes field

**Files:**
- Modify: `api_server.py` around line 260–320

- [ ] **Step 1: Locate the mapped_spikes dict construction**

Run:
```bash
grep -n "historicalConfidence" /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat/api_server.py
```
Expected output shows line 311 with `"historicalConfidence": round(...)`.

- [ ] **Step 2: Add the new field to mapped_spikes**

Open `api_server.py` and find the block around line 311:
```python
            # Calibration data (from HistoricalCalibrationEngine)
            "historicalConfidence": round(cal.get("calibrated_confidence", 0) * 100, 1) if (cal := pick.get("calibration")) else None,
            "calibrationSamples": cal.get("sample_count") if (cal := pick.get("calibration")) else None,
            "overconfidenceFlag": cal.get("overconfidence_flag") if (cal := pick.get("calibration")) else None,
```

Add a new line directly BEFORE the calibration block:
```python
            # Institutional Conviction Score (from build_consensus_top10)
            "institutionalConvictionScore": pick.get("institutional_conviction_score"),
            # Calibration data (from HistoricalCalibrationEngine)
            "historicalConfidence": round(cal.get("calibrated_confidence", 0) * 100, 1) if (cal := pick.get("calibration")) else None,
```

- [ ] **Step 3: Python syntax check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && python3 -m py_compile api_server.py && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add api_server.py
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(api): expose institutionalConvictionScore in mapped_spikes"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 8: analyzer.ts interface + spikeData mapping

**Files:**
- Modify: `src/lib/scheduling/analyzer.ts` lines ~75–85 (interface) and ~258–264 (mapping)

- [ ] **Step 1: Locate the internal interface with historicalConfidence**

Run:
```bash
grep -n "historicalConfidence" /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat/src/lib/scheduling/analyzer.ts
```
Expected output shows at least two lines: one in an interface declaration (around line 79) and one in a `spikeData.map()` block (around line 260).

- [ ] **Step 2: Read context around the interface declaration**

Run:
```bash
sed -n '70,90p' /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat/src/lib/scheduling/analyzer.ts
```
Locate the interface that includes `historicalConfidence: number | null;`. Identify the interface name and the surrounding fields.

- [ ] **Step 3: Add the new field to the interface**

In the interface (around line 79), find:
```ts
    historicalConfidence: number | null;
```

Add a new line directly before it:
```ts
    institutionalConvictionScore: number | null;
    historicalConfidence: number | null;
```

- [ ] **Step 4: Add the new field to the spikeData.map() block**

Around line 260, find:
```ts
      // Calibration data for dual-bar confidence meter
      historicalConfidence: spike.historicalConfidence,
```

Add a new line directly before it:
```ts
      // IIC for third bar on SpikeCard
      institutionalConvictionScore: spike.institutionalConvictionScore,
      // Calibration data for dual-bar confidence meter
      historicalConfidence: spike.historicalConfidence,
```

- [ ] **Step 5: TypeScript build check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && npm run build 2>&1 | tail -20
```
Expected: build succeeds. The new Prisma column is now populated by analyzer.ts.

- [ ] **Step 6: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add src/lib/scheduling/analyzer.ts
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(analyzer): persist institutionalConvictionScore to Prisma"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 9: SpikeCard TypeScript type

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Locate the SpikeCard type**

Run:
```bash
grep -n "institutionalConvictionScore\|historicalConfidence" /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat/src/types/index.ts
```
Expected: matches on `historicalConfidence` at least.

- [ ] **Step 2: Add the new field to SpikeCard interface/type**

Open `src/types/index.ts` and find the `SpikeCard` interface/type definition. Locate the line with `historicalConfidence`:
```ts
  historicalConfidence?: number | null;
```

Add a new line directly before it:
```ts
  institutionalConvictionScore?: number | null;
  historicalConfidence?: number | null;
```

Match the existing optional `?` notation and semicolon style.

- [ ] **Step 3: TypeScript build check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && npm run build 2>&1 | tail -20
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add src/types/index.ts
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(types): add institutionalConvictionScore to SpikeCard type"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 10: SpikeCard third bar rendering

**Files:**
- Modify: `src/components/spikes/SpikeCard.tsx` lines 122–171 (Confidence section)

- [ ] **Step 1: Update the Council label conditional (line 135)**

Find the line:
```tsx
          <span className="text-xs text-spike-text-muted w-14 font-medium">{spike.historicalConfidence != null ? 'Council' : ''}</span>
```

Replace with:
```tsx
          <span className="text-xs text-spike-text-muted w-14 font-medium">Council</span>
```

Rationale: Always-3-bars mode means the Council label is always visible.

- [ ] **Step 2: Insert the Smart bar between Council and History**

Find the History bar block starting at line 152:
```tsx
        {/* History bar (only shown when calibration data exists) */}
        {spike.historicalConfidence != null && (
```

Insert the following block directly BEFORE that comment:

```tsx
        {/* Smart bar — Institutional Conviction Score (always shown, with N/A placeholder) */}
        <div className="flex items-center gap-2 mb-1.5"
             title={spike.institutionalConvictionScore != null
               ? "Insider activity, institutional ownership, analyst consensus, and sector strength combined (0-100)"
               : "No insider trades, institutional ownership, analyst data, or sector relative strength available"}>
          <span className="text-xs text-spike-text-muted w-14 font-medium">Smart</span>
          <div className="flex-1 h-2 bg-spike-bg rounded-full overflow-hidden">
            {spike.institutionalConvictionScore != null ? (
              <div
                className="h-full rounded-full transition-all duration-1000 opacity-80"
                style={{
                  width: `${spike.institutionalConvictionScore}%`,
                  background: spike.institutionalConvictionScore >= 80
                    ? 'linear-gradient(90deg, rgba(0,255,136,0.3), #00FF88)'
                    : spike.institutionalConvictionScore >= 60
                    ? 'linear-gradient(90deg, rgba(255,184,0,0.3), #FFB800)'
                    : 'linear-gradient(90deg, rgba(255,51,102,0.3), #FF3366)',
                }}
              />
            ) : (
              <div className="h-full w-full bg-spike-border/20" />
            )}
          </div>
          <span className="text-xs mono text-spike-text-dim w-9 text-right">
            {spike.institutionalConvictionScore != null
              ? `${spike.institutionalConvictionScore}%`
              : '—'}
          </span>
        </div>
        {spike.institutionalConvictionScore == null && (
          <div className="text-[10px] text-spike-text-muted italic mb-1.5 ml-16">
            No Scoring — Insufficient Data
          </div>
        )}
        {/* History bar (only shown when calibration data exists) */}
        {spike.historicalConfidence != null && (
```

Note: the closing `{/* History bar (...) */}` and the `{spike.historicalConfidence != null && (` line are NOT duplicated — they already exist right after the new block. The insertion ends at the `}` of the "No Scoring" caption block.

- [ ] **Step 3: TypeScript build check**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && npm run build 2>&1 | tail -20
```
Expected: build succeeds. The `SpikeCard.tsx` component now references `spike.institutionalConvictionScore` which exists on the type from Task 9.

- [ ] **Step 4: Commit**

```bash
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat add src/components/spikes/SpikeCard.tsx
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat commit -m "feat(spikecard): add Smart bar with IIC score and insufficient-data placeholder"
git -C /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat push
```

---

## Task 11: PR + production deploy

**Files:** none

- [ ] **Step 1: Open PR**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code/.worktrees/feat-user-activity-heartbeat && gh pr create --title "feat: IIC conviction score cleanup (Sibling A)" --body "$(cat <<'EOF'
## Summary
- Adds Institutional Conviction Score (IIC) 0-100 as a third graduated bar on SpikeCard between Council and History
- New FMP `/v4/institutional-ownership/symbol-ownership` endpoint fetcher
- New `compute_iic()` helper: insider 35 / institutional 30 / analyst 20 / srs 15
- Multiplier cap `[0.5, 1.5]` on the combined 7-multiplier adjustment stack, eliminating the silent `[0,100]` end-of-pipeline clamp
- Always-3-bars rule with "No Scoring — Insufficient Data" placeholder when IIC inputs are missing
- One new Prisma column on Spike (additive, nullable)

Spec: `docs/superpowers/specs/2026-04-08-conviction-score-cleanup-design.md`

## Deploy mechanism
Same pattern as yesterday's User Activity Heartbeat: build new app image first (bakes new schema into container), then `docker compose run --rm --no-deps app node node_modules/prisma/build/index.js db push --skip-generate`, then restart. No data wipe needed (additive change).

## Test plan
- [x] Local TypeScript build passes
- [x] Local Python syntax check passes
- [ ] Production schema column exists after deploy
- [ ] Post-deploy: next council run populates institutionalConvictionScore on new Spike rows
- [ ] Post-deploy: SpikeCard shows 3 bars for picks with data, "No Scoring" for picks without
- [ ] Post-deploy: multiplier cap `was_capped=true` entries are rare outliers only

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR URL printed.

- [ ] **Step 2: Wait for user approval to merge**

STOP here and ask the user: "PR is open. Want me to merge and deploy to production?"

Do NOT merge without explicit user confirmation.

- [ ] **Step 3: Merge after approval**

Run:
```bash
gh pr merge --squash --delete-branch=false
```

- [ ] **Step 4: SSH production and pull main**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && git pull origin main && git log --oneline -3'
```
Expected: HEAD advances to the merge commit.

- [ ] **Step 5: Build new app image (bakes new schema in)**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose build app 2>&1' | tail -15
```
Expected: build completes cleanly, "Image spike-trades-app Built".

- [ ] **Step 6: Apply schema change via one-off container**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose run --rm --no-deps app node node_modules/prisma/build/index.js db push --skip-generate 2>&1' | tail -10
```
Expected: `🚀  Your database is now in sync with your Prisma schema.`

- [ ] **Step 7: Verify the new column exists on production**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c '\d \"Spike\"'" 2>&1 | grep -i "institutionalConviction"
```
Expected: output shows `institutionalConvictionScore | integer` (nullable).

- [ ] **Step 8: Restart app with new image**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose up -d app && sleep 3 && docker compose ps --format "table {{.Name}}\t{{.Status}}"'
```
Expected: all containers up, app restarted cleanly.

---

## Task 12: T+0 production verification

**Files:** none

- [ ] **Step 1: Verify schema column was applied**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c 'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = \"Spike\" AND column_name = \"institutionalConvictionScore\";'"
```
Expected: one row returned with `integer | YES`.

- [ ] **Step 2: Check that existing Spike rows have NULL (no backfill)**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c 'SELECT COUNT(*) AS total, COUNT(\"institutionalConvictionScore\") AS populated FROM \"Spike\";'"
```
Expected: `total` = ~121 (from handoff snapshot), `populated` = 0. This is correct — no backfill, NULL is honest for pre-deploy picks.

- [ ] **Step 3: Wait for next council run OR trigger manually**

If the next 10:45 AST council run has not fired yet, wait for it. After it completes (typically ~20-30 min into the run), run:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c 'SELECT rank, ticker, \"spikeScore\", \"institutionalConvictionScore\" FROM \"Spike\" WHERE \"reportId\" = (SELECT id FROM \"DailyReport\" ORDER BY date DESC LIMIT 1) ORDER BY rank;'"
```
Expected: 10 rows, latest council run, `institutionalConvictionScore` populated with values in `[0, 100]` for most picks (may be NULL for picks with no smart-money data).

- [ ] **Step 4: Verify in browser**

Open `https://spiketrades.ca/dashboard` in a browser. Log in.

For each of today's 10 picks, inspect the Confidence section. Expected:
- Every SpikeCard shows 3 bars in order: Council, Smart, History
- Picks with IIC data show a colored Smart bar (green ≥80, amber ≥60, red <60) at 80% opacity
- Picks without IIC data show an empty grey Smart bar with "No Scoring — Insufficient Data" caption below
- Hover tooltip on the Smart bar explains the score or the missing-data reason
- History bar renders unchanged at 60% opacity

- [ ] **Step 5: Check for multiplier cap events**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose logs council --since 1h 2>&1 | grep -i "was_capped\|combined_adj" | tail -20'
```
Expected: `was_capped: false` entries are normal. Any `was_capped: true` entries identify outlier picks where the cap fired — log them for audit but do not treat as bugs.

- [ ] **Step 6: Report T+0 summary**

Post a summary in the session:

```
✅ Conviction Score Cleanup — DEPLOYED + T+0 VERIFIED

- Production HEAD: <commit>
- Schema column applied: institutionalConvictionScore Int? ✅
- Existing Spike rows: NULL (no backfill — honest)
- Latest council run: <N> of 10 picks populated with IIC score
- Multiplier cap: <X> picks hit the cap (was_capped=true)
- 3-bar display verified in browser
- No Scoring — Insufficient Data placeholder verified for picks without data
```

---

## Self-Review

### 1. Spec coverage check

- Section "Approach / Visual layout" → Task 10 (SpikeCard rendering) ✅
- Section "IIC formula" + component scorers → Task 4 (compute_iic helpers) ✅
- Section "Multiplier cap" → Task 5 (cap block in build_consensus_top10) ✅
- Section "Architecture / Component 1" (compute_iic) → Task 4 ✅
- Section "Architecture / Component 2" (IIC integration) → Task 5 ✅
- Section "Architecture / Component 3" (multiplier cap) → Task 5 ✅
- Section "Architecture / Component 4" (institutional_ownership_pct field + fetcher) → Tasks 2 + 3 ✅
- Section "Architecture / Component 5" (FinalHotPick schema) → Task 6 ✅
- Section "Architecture / Component 6" (Prisma Spike column) → Task 1 ✅
- Section "Architecture / Component 7" (api_server.py) → Task 7 ✅
- Section "Architecture / Component 7B" (analyzer.ts) → Task 8 ✅
- Section "Architecture / Component 8" (TypeScript type) → Task 9 ✅
- Section "Architecture / Component 9" (SpikeCard.tsx) → Task 10 ✅
- Section "Rollout" → Task 11 (PR + deploy) ✅
- Section "Verification plan" → Task 12 (T+0) ✅
- Section "File manifest" (6 modified files) → all 6 files touched across Tasks 1-10 ✅

All spec sections have a corresponding task. No gaps.

### 2. Placeholder scan

No "TBD", "TODO", "implement later", "fill in details", "add appropriate X", or "Similar to Task N" found. Every code block is complete and directly executable.

### 3. Type consistency check

- `institutionalConvictionScore` (camelCase) — used consistently in Prisma (Task 1), api_server (Task 7), analyzer.ts (Task 8), types/index.ts (Task 9), SpikeCard.tsx (Task 10) ✅
- `institutional_conviction_score` (snake_case) — used consistently in Python: StockDataPayload (not needed — that's institutional_ownership_pct), FinalHotPick (Task 6), data dict key (Tasks 5, 6), api_server `pick.get(...)` (Task 7) ✅
- `institutional_ownership_pct` (snake_case, 0.0-1.0 float) — defined in Task 3, used in Tasks 4 (`_score_institutional`), 5 (`compute_iic` call) ✅
- `compute_iic` function signature in Task 4 matches call site in Task 5 ✅
- `_score_insider`, `_score_institutional`, `_score_analyst`, `_score_srs` signatures in Task 4 match internal calls in `compute_iic` ✅
- The threshold values in `_score_insider` (0.70, 0.45, 0.20, ...) are in the clamped `[-1.0, 1.0]` range of `InsiderActivity.recency_weighted_score` ✅

All cross-task references check out. No mismatched names or signatures.
