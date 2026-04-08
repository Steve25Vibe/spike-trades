# Conviction Score Cleanup — Design Spec

**Date:** 2026-04-08
**Author:** Steven Weagle (with Claude)
**Status:** Draft, awaiting user review
**Topic:** Add Institutional Conviction Score (IIC) as a third graduated bar on SpikeCard, and add an explicit cap on the 7-multiplier adjustment stack in the council brain

---

## Origin

Emerged from an architectural audit of `canadian_llm_council_brain.py` against a proposed 4-LLM sequential council. The audit concluded that 21/23 elements of the proposal were already implemented in the current brain (Sonnet → Gemini → Opus → Grok 4-stage pipeline with the same 100-point rubric and `{0.15, 0.20, 0.30, 0.35}` stage weights). **Two genuine improvements** from the proposal were identified and are the subject of this spec:

1. **A unified Institutional Conviction Score (0–100)** surfaced as a third graduated bar on SpikeCard. Currently, seven different multipliers (`sector_adj`, `directional_multiplier`, `earnings_mult`, `insider_adj`, `analyst_adj`, `srs_adj`, `disagreement_adj`, `iv_check`, `edge_mult`) adjust `consensus_score` invisibly inside `build_consensus_top10()`. Users see only the final number. A unified IIC exposes smart-money positioning as an orthogonal signal.

2. **An explicit cap on the combined multiplier product** before it hits the `[0, 100]` clamp at line 2335. The current clamp silently swallows mathematically-impossible scores. An explicit cap in `[0.5, 1.5]` makes the adjustment envelope honest.

---

## Problem

### Problem 1: Conviction signals are invisible

The current SpikeCard shows two graduated confidence bars:

```
Confidence
Council  ████████░░  82%
History  ██████░░░░  56%
```

The **Council** bar is the consensus score from the 4-stage LLM council (weighted stage scores). The **History** bar is the backward-looking base rate (`historicalConfidence`). Missing from this view: what is the actual smart money doing RIGHT NOW? That signal exists internally as a collection of multipliers but is never surfaced to the user.

### Problem 2: The 7-multiplier stack can produce impossible scores

In `canadian_llm_council_brain.py` `build_consensus_top10()` (lines 2153–2257), seven multiplicative adjustments compound onto `consensus_score`:

| Multiplier | Range | Source |
|---|---|---|
| `sector_adj` | ~0.8–1.2 | Macro regime or learning engine |
| `directional_multiplier` | 0.1–~1.5 | Stage 4 forecast direction × magnitude |
| `earnings_mult` | 0.70–1.00 | Days until earnings |
| `insider_adj` | `1.0 + recency_score × 0.08` | Insider trades |
| `analyst_adj` | `1.0 + sentiment × 0.05 (+0.03)` | Analyst consensus |
| `srs_adj` | `1.0 + capped × 0.017` | Sector relative strength |
| `disagreement_adj` | varies | Learning engine (currently bypassed) |
| `iv_check` | 0.90–1.03 | IV vs predicted move |
| `edge_mult` | varies | Historical edge analyzer |

Combined, these can push `consensus_score` above 100 or below 0 — which gets silently clamped to `[0, 100]` at line 2335. The clamp hides the fact that some scores are mathematically out of bounds. **This is dishonest math.**

---

## Goal

Produce a cleaner, more trustworthy view of each pick by:

1. **Surfacing a dedicated Institutional Conviction Score (0–100)** as a third graduated bar on SpikeCard, between Council and History.
2. **Capping the combined multiplier product** in `[0.5, 1.5]` before applying to `consensus_score`, eliminating the silent clamp.
3. **Preserving all existing logic** — IIC is a derived view, not a replacement. The existing 7-multiplier math continues to operate on `consensus_score` unchanged (except for the cap).

Out of scope: hybrid FMP/EODHD data audit, ghost stock detection (those become Sibling B project).

---

## Non-goals

- No changes to the 4-stage LLM pipeline
- No changes to stage weights `{0.15, 0.20, 0.30, 0.35}` (locked in by the LE bypass)
- No changes to the 100-point rubric
- No changes to the Historical Confidence ("History") bar — that is the queued B3 project
- No backfill of historical Spike rows (new column is NULL for pre-deploy picks — honest, not a bug)
- No new external data sources (uses only data the brain already fetches)

---

## Approach

### Visual layout: 3 graduated bars, stair-step opacity

```
Confidence                        [Council Optimistic flag, when applicable]
Council  ████████░░  82%    (opacity 100%)
Smart    ███████░░░  68%    (opacity  80%)
History  ██████░░░░  56%    (opacity  60%)
```

Hierarchy reinforces the narrative: top bar = forward judgment (what we think), middle bar = current smart-money positioning (what others are doing), bottom bar = backward base rate (what's happened before in similar setups). All three use identical color logic (≥80 green / ≥60 amber / else red) so users can scan the trio and compare at a glance.

### Always-3-bars rule

All three bars are always present in the layout. If a score cannot be computed for a specific bar because of insufficient data, the bar slot displays:

```
Smart    [ empty grey bar ]   —
         No Scoring — Insufficient Data
```

**Rationale:** Hiding a bar because data is missing makes the layout inconsistent across cards and forces users to remember the suppression rule. Fabricating a neutral placeholder number (50) implies "we have this signal and it's neutral," which is a lie when the truth is "we have no data." The explicit "No Scoring — Insufficient Data" caption is honest in both directions.

### IIC formula

```python
def compute_iic(
    insider_activity: InsiderActivity | None,
    institutional_ownership_pct: float | None,
    analyst_consensus: AnalystConsensus | None,
    sector_relative_strength: float | None,
) -> int | None:
    """
    Institutional Conviction Score 0-100 from smart-money signals.
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

    # Insufficient-data threshold: zero smart-money signals
    if not (has_insider or has_institutional or has_analyst or has_srs):
        return None

    insider_pts       = _score_insider(insider_activity)            # 0-35
    institutional_pts = _score_institutional(institutional_ownership_pct)  # 0-30
    analyst_pts       = _score_analyst(analyst_consensus)           # 0-20
    srs_pts           = _score_srs(sector_relative_strength)        # 0-15

    total = insider_pts + institutional_pts + analyst_pts + srs_pts
    return int(round(min(max(total, 0), 100)))
```

Each component score function clamps its contribution to its allocated range:

```python
def _score_insider(ia: InsiderActivity | None) -> float:
    """Insider buying gets 0-35 points. Strongest single smart-money signal."""
    if ia is None or ia.recency_weighted_score is None:
        return 0.0
    r = ia.recency_weighted_score
    # r is clamped to [-1.0, 1.0] by the InsiderActivity Pydantic schema (line 113).
    # Thresholds are calibrated to that range.
    if r >= 0.70:   return 35.0
    if r >= 0.45:   return 30.0
    if r >= 0.20:   return 25.0
    if r >= 0.00:   return 18.0
    if r >= -0.20:  return 10.0
    if r >= -0.50:  return 5.0
    return 0.0

def _score_institutional(ownership_pct: float | None) -> float:
    """Institutional ownership 0-30 points. Captures 13F/13G filings over time."""
    if ownership_pct is None:
        return 0.0
    # ownership_pct is the fraction of shares held by institutions (0.0-1.0)
    if ownership_pct >= 0.70:  return 30.0
    if ownership_pct >= 0.50:  return 26.0
    if ownership_pct >= 0.30:  return 22.0
    if ownership_pct >= 0.15:  return 16.0
    if ownership_pct >= 0.05:  return 10.0
    if ownership_pct > 0.0:    return 5.0
    return 0.0

def _score_analyst(ac: AnalystConsensus | None) -> float:
    """Analyst consensus 0-20 points."""
    if ac is None or ac.sentiment_score is None:
        return 0.0
    s = ac.sentiment_score  # range -1.0 to +1.0
    if s >= 0.7:   return 20.0
    if s >= 0.4:   return 17.0
    if s >= 0.2:   return 13.0
    if s >= 0.0:   return 9.0
    if s >= -0.3:  return 5.0
    return 0.0

def _score_srs(srs: float | None) -> float:
    """Sector relative strength 0-15 points."""
    if srs is None:
        return 0.0
    # srs range roughly -3.0 to +3.0 (std deviations above/below sector)
    if srs >= 2.0:   return 15.0
    if srs >= 1.0:   return 12.0
    if srs >= 0.5:   return 9.0
    if srs >= 0.0:   return 6.0
    if srs >= -0.5:  return 3.0
    return 0.0
```

**Component weights:** insider 35 / institutional 30 / analyst 20 / srs 15 = 100.

Insider receives the highest weight because insider buying is the most directly actionable smart-money signal — a CEO buying $5M of her own stock is unambiguous. Institutional ownership is the second-most-reliable signal because 13F filings capture real capital at risk. Analyst consensus is moderately useful but diluted by sell-side incentive bias. Sector relative strength is the broadest and most derivative signal, so it gets the lowest weight.

### Multiplier cap

After all existing multiplications in `build_consensus_top10()` compound onto `consensus_score`, but BEFORE the existing `[0, 100]` clamp at line 2335, add:

```python
# Cap the combined product of all adjustment multipliers.
# Prevents the [0, 100] clamp at line 2335 from silently swallowing
# mathematically impossible scores.
#
# NOTE: directional_multiplier is excluded from the cap because it is
# an LLM forecast direction/probability signal, not a smart-money multiplier.
CAP_MIN, CAP_MAX = 0.5, 1.5
combined_adj_multiplier = (
    sector_adj * earnings_mult * insider_adj * analyst_adj
    * srs_adj * disagreement_adj * iv_check * edge_mult
)
if combined_adj_multiplier > CAP_MAX:
    # Scale back proportionally to cap at CAP_MAX
    consensus_score *= CAP_MAX / combined_adj_multiplier
elif combined_adj_multiplier < CAP_MIN:
    # Scale up proportionally to cap at CAP_MIN
    consensus_score *= CAP_MIN / combined_adj_multiplier
adjustments["combined_adj_multiplier"] = round(combined_adj_multiplier, 4)
adjustments["was_capped"] = combined_adj_multiplier > CAP_MAX or combined_adj_multiplier < CAP_MIN
```

The cap only fires on outlier picks where the 7 multipliers compound to >1.5 or <0.5. For the vast majority of picks the cap is a no-op. When it fires, `adjustments["was_capped"]` logs the event for later audit.

---

## Architecture

### Component 1: `compute_iic()` helper (NEW)

**Location:** `canadian_llm_council_brain.py`, inserted near the existing scoring helpers around line 2060 (before `build_consensus_top10`).

- Pure function: takes insider/institutional/analyst/SRS inputs, returns `int | None`
- Four helper functions `_score_insider`, `_score_institutional`, `_score_analyst`, `_score_srs` — each pure, each clamped to its allocated range
- Easy to audit: the mapping from raw inputs to output points is threshold-based and visible in code

### Component 2: IIC integration in `build_consensus_top10()` (MODIFIED)

**Location:** `canadian_llm_council_brain.py` around line 2260 (after all existing multipliers, before ticker is appended to `scored_tickers`).

One new call site:

```python
# After adjustments["edge_multiplier"] = edge_mult (existing line 2258)

# Compute Institutional Conviction Score (0-100, None if insufficient data)
iic = compute_iic(
    insider_activity=payload.insider_activity if payload else None,
    institutional_ownership_pct=payload.institutional_ownership_pct if payload else None,
    analyst_consensus=payload.analyst_consensus if payload else None,
    sector_relative_strength=payload.sector_relative_strength if payload else None,
)
data["institutional_conviction_score"] = iic
```

The value is threaded through to `FinalHotPick` via the existing stage_map → pick build flow.

### Component 3: Multiplier cap in `build_consensus_top10()` (MODIFIED)

**Location:** `canadian_llm_council_brain.py`, inserted AFTER the existing `edge_mult` application (line 2257) and BEFORE the `scored_tickers.append(...)` on line 2261.

Computes the combined multiplier as a post-hoc audit, then rescales `consensus_score` if out of cap range. Five lines.

### Component 4: `institutional_ownership_pct` field + NEW endpoint fetcher (MODIFIED)

**Location:** `canadian_llm_council_brain.py` around line 136 (StockDataPayload model) and in `LiveDataFetcher` class.

**4A. Add the field to the payload model:**

```python
class StockDataPayload(BaseModel):
    # ... existing fields ...
    institutional_ownership_pct: Optional[float] = Field(None, ge=0.0, le=1.0,
        description="Fraction of shares held by institutions (from /v3/institutional-ownership)")
```

**4B. Add a new fetcher method to `LiveDataFetcher`** — the brain does NOT currently fetch `/v3/institutional-ownership`. This is a new endpoint call. The FMP Ultimate plan includes this endpoint. Proposed implementation pattern matches the existing `fetch_insider_trades` (line 911):

```python
async def fetch_institutional_ownership(
    session: aiohttp.ClientSession,
    ticker: str,
    api_key: str,
) -> Optional[float]:
    """
    Fetch institutional ownership percentage from FMP.
    Returns the fraction of shares held by institutions (0.0-1.0), or None.
    Non-blocking — returns None on any error rather than raising.
    """
    try:
        url = f"https://financialmodelingprep.com/api/v4/institutional-ownership/symbol-ownership"
        params = {"symbol": ticker, "includeCurrentQuarter": "false", "apikey": api_key}
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            if not data or not isinstance(data, list) or len(data) == 0:
                return None
            # Use the most recent quarter's ownershipPercent
            latest = data[0]
            pct = latest.get("ownershipPercent")
            if pct is None:
                return None
            # FMP returns as percentage (e.g., 45.7 for 45.7%); normalize to 0-1
            return min(max(float(pct) / 100.0, 0.0), 1.0)
    except Exception:
        return None
```

**4C. Populate the field in the payload builder** — wherever other per-ticker fetchers are called (e.g., `fetch_enhanced_signals_batch` at line 967 or the enrichment loop), add one `gather` call for institutional ownership:

```python
# Alongside existing gather() calls for insider trades, analyst consensus, etc.
inst_ownership = await fetch_institutional_ownership(session, ticker, api_key)
payload.institutional_ownership_pct = inst_ownership
```

~25 lines total (new fetcher function + wiring). Small additional cost per council run (~1 HTTP call per candidate ticker × ~40 tickers at Stage 3 = 40 extra HTTP calls per run, well within FMP Ultimate rate limits).

### Component 5: `FinalHotPick` schema addition (MODIFIED)

**Location:** `canadian_llm_council_brain.py` around line 225 (FinalHotPick model).

Add one optional field:

```python
class FinalHotPick(BaseModel):
    # ... existing fields ...
    institutional_conviction_score: Optional[int] = Field(None, ge=0, le=100)
```

Populated from `data["institutional_conviction_score"]` in the final loop around line 2335.

### Component 6: Prisma Spike model (MODIFIED)

**Location:** `prisma/schema.prisma`.

One new nullable column:

```prisma
model Spike {
  // ... existing fields ...
  institutionalConvictionScore  Int?
  // ...
}
```

Applied via `prisma db push --skip-generate` (same pattern as yesterday's heartbeat deploy).

### Component 7: `api_server.py` mapped_spikes dict (MODIFIED)

One new line in the dict that maps `FinalHotPick` to the frontend payload (around line 260 alongside existing `historicalConfidence` mapping at line 311):

```python
"institutionalConvictionScore": pick.get("institutional_conviction_score"),
```

### Component 7B: `src/lib/scheduling/analyzer.ts` — Spike persist pipeline (MODIFIED)

**Location:** `src/lib/scheduling/analyzer.ts` around line 221–264.

This is the bridge between the Python council brain (via `api_server.py`) and the Prisma Spike table. The `spikeData` dict at line 221 maps api_server response fields to Prisma columns, then `prisma.dailyReport.upsert(... spikes: { create: spikeData } ...)` writes the rows at line 266.

Two additions:

**7B-a.** Add `institutionalConvictionScore` to the TypeScript interface for the spike object (around line 79 where `historicalConfidence: number | null` is declared):

```ts
institutionalConvictionScore: number | null;
```

**7B-b.** Add the field to the `spikeData.map()` block (around line 260 next to `historicalConfidence`):

```ts
institutionalConvictionScore: spike.institutionalConvictionScore,
```

### Component 8: TypeScript SpikeCard type (MODIFIED)

**Location:** `src/types/index.ts`.

Add one optional field:

```ts
export interface SpikeCard {
  // ... existing fields ...
  institutionalConvictionScore: number | null;
}
```

### Component 9: SpikeCard.tsx (MODIFIED)

**Location:** `src/components/spikes/SpikeCard.tsx` Confidence section (lines 122–171).

Two specific changes:

**9A. Update the Council label conditional on line 135** — currently shows label only when `spike.historicalConfidence != null`. New rule: always show label (we are always in 3-bar mode now):

```tsx
<span className="text-xs text-spike-text-muted w-14 font-medium">Council</span>
```

**9B. Insert the Smart bar block between the Council bar (lines 133–150) and the History bar (lines 152–170):**

```tsx
{/* Smart bar — Institutional Conviction Score */}
<div className="flex items-center gap-2 mb-1.5"
     title={spike.institutionalConvictionScore != null
       ? "Insider activity, institutional ownership, analyst consensus, and sector strength combined (0-100)"
       : "No insider trades, institutional ownership, analyst data, or SRS available"}>
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
```

The History bar remains unchanged. Its position naturally becomes the third bar because it follows the new Smart bar in the JSX.

---

## File manifest

### New files
- None. All changes modify existing files.

### Modified files

| Path | Change | LoC delta |
|---|---|---|
| `prisma/schema.prisma` | Add `institutionalConvictionScore Int?` to Spike model | +1 |
| `canadian_llm_council_brain.py` | Add `compute_iic()` + 4 score helpers, NEW `fetch_institutional_ownership` endpoint fetcher, `institutional_ownership_pct` on StockDataPayload + wiring, `institutional_conviction_score` on FinalHotPick, call in `build_consensus_top10()`, multiplier cap block | ~120 |
| `api_server.py` | Add `institutionalConvictionScore` to `mapped_spikes` dict | +1 |
| `src/lib/scheduling/analyzer.ts` | Add `institutionalConvictionScore` to interface + spikeData mapping | +2 |
| `src/types/index.ts` | Add `institutionalConvictionScore: number \| null` to SpikeCard type | +1 |
| `src/components/spikes/SpikeCard.tsx` | Update Council label conditional (line 135), insert Smart bar block | +35 |

### Not touched
- Stage 1/2/3/4 prompts
- The 100-point rubric
- Stage weights `{0.15, 0.20, 0.30, 0.35}`
- `ConvictionEngine` threshold logic (HIGH/MEDIUM/LOW tiering)
- History bar rendering
- Learning engine bypass
- Any heartbeat / admin / auth code

---

## Verification plan

### Local build check (pre-PR)
- `npm run build` passes
- `npx prisma generate` clean

### Post-deploy verification (T+0, after first council run with new code)

1. Verify schema column exists on production DB:
   ```sql
   \d "Spike"
   ```
   Expected: `institutionalConvictionScore | integer` in the column list.

2. Verify today's council run populated the new field:
   ```sql
   SELECT ticker, "spikeScore", "institutionalConvictionScore"
   FROM "Spike"
   WHERE date = (SELECT MAX(date) FROM "Spike")
   ORDER BY rank;
   ```
   Expected: new picks have non-null `institutionalConvictionScore` values in the 0–100 range. Some picks may legitimately have NULL if none of their 4 smart-money signals had data.

3. Open the dashboard in a browser. Expected:
   - Every SpikeCard shows 3 bars in order Council / Smart / History
   - Picks with data show a colored Smart bar (green ≥80, amber ≥60, red <60)
   - Picks without sufficient data show an empty grey Smart bar with "No Scoring — Insufficient Data" caption
   - Tooltip on hover explains the score or the missing-data reason

4. Verify multiplier cap logging:
   ```bash
   ssh prod 'docker compose logs council --since 10m | grep was_capped'
   ```
   Expected: at least some `was_capped: false` entries (normal picks). Any `was_capped: true` entries are the outlier case the cap was designed to catch — log them for review.

### T+24h verification

Not applicable. This deploy does not have an observability gate because it does not affect archived tables or existing data. Any regression would be immediately visible on the first council run after deploy.

---

## Rollout

### Branch strategy
New worktree: `.worktrees/feat-iic-conviction-score` on branch `feat/iic-conviction-score` from `origin/main`.

### Deploy sequence (matches yesterday's heartbeat pattern)

1. Merge PR to main
2. SSH production: `git pull origin main`
3. `docker compose build app` (bakes new schema into image)
4. `docker compose run --rm --no-deps app node node_modules/prisma/build/index.js db push --skip-generate` (applies column add from a one-off container with the new image)
5. Verify column exists on DB
6. `docker compose up -d app` (restarts live app with new code)
7. Verify container health
8. Wait for next council run (or trigger manual one if convenient)
9. Run T+0 verification above

### Rollback

Additive schema change. To roll back:
1. `git revert` the merge commit
2. Redeploy previous image
3. The `institutionalConvictionScore` column remains in the database (harmless NULL on old code paths). Can be dropped later via `prisma db push` if schema is cleaned.

### Timing

Target: ship before tomorrow's 10:45 AST council run so that tomorrow's picks are the first IIC-populated set. Today's picks (10:45 AST) will predate the deploy and carry NULL.

---

## Open questions

None. All design decisions are locked in:
- Component weights: insider 35 / institutional 30 / analyst 20 / srs 15
- Multiplier cap: `[0.5, 1.5]`
- Always-3-bars rule with "No Scoring — Insufficient Data" placeholder
- Bar order: Council → Smart → History
- Opacity stair-step: 100% / 80% / 60%
- Same color thresholds (≥80 green / ≥60 amber / else red)
- No backfill of historical Spike rows
