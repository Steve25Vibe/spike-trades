# Historical Hit Rate Refresh (B2 + B3) — Design Spec

**Date:** 2026-04-08
**Status:** Draft, to be reviewed after spec write
**Topic:** Rename "Historical Confidence" → "Historical Hit Rate" and add display hardening for low sample sizes on the SpikeCard History bar
**Sibling:** System A (this session)
**Scope note:** B1 (per-stock 6-month price-action profile) is DEFERRED per user decision (Q6 = C). Only B2 (rename) and B3 (display hardening) are in scope for today.

---

## Problem

The SpikeCard History bar currently displays a `historicalConfidence` value computed by the HistoricalCalibrationEngine. Two honest-labeling problems:

1. **Misleading name.** The field is called `historicalConfidence` and labeled "History" in the UI, but what it actually measures is **the hit rate of past picks with similar characteristics**. "Confidence" overstates what the number represents — it's a base-rate frequency, not a confidence interval.

2. **Precision overstatement at small sample sizes.** The display shows values like `57.4%` even when `calibrationSamples = 19`, which is statistically weak. Users see a precise number and interpret it as reliable signal when the underlying sample is too thin to be trusted.

Both problems were identified during the Sibling A audit earlier today. They are cosmetic/display-layer issues — no change to the underlying calibration math or computed values.

---

## Goal

1. **Rename `historicalConfidence` → `historicalHitRate`** throughout the TypeScript/display layer (not the Prisma column — that stays `historicalConfidence` to avoid a destructive DB rename). The frontend now reads the same DB value but labels and refers to it as "Historical Hit Rate" or "Hit Rate".

2. **Add a low-confidence visual cue** (Q7 = B) on the History bar when `calibrationSamples < 100`. Single-tier: either the bar shows normally (n ≥ 100) or with a low-confidence cue (n < 100). Tooltip explains sample size.

---

## Non-goals

- No changes to `HistoricalCalibrationEngine` Python code — the underlying computation stays identical.
- No changes to the Prisma `Spike.historicalConfidence` column name (would force a DB migration and break historical data).
- No per-stock 6-month price-action profile (B1 deferred to later).
- No changes to the Smart bar (Sibling A already handles that).
- No changes to the Council bar.

---

## Approach

### Rename strategy

- **Database column:** stays `historicalConfidence` (Prisma `Float?`). **No migration.**
- **TypeScript interface `SpikeCard`:** keep the field name `historicalConfidence` (matches DB schema). Just CHANGE the label text in the UI.
- **User-facing label in SpikeCard.tsx:** `"History"` → `"Hit Rate"`
- **Tooltip text:** update to use "Hit Rate" terminology
- **Overconfidence flag wording:** `"Council Optimistic"` label exists — we keep this but can refine the tooltip to say "Council confidence exceeds historical hit rate by >10 points" instead of "historical base rate"

### Display hardening (B3 Q7 = B)

When `calibrationSamples < 100`:
- Reduce bar opacity from the current `opacity-60` to `opacity-30` (halved)
- Add a warning marker next to the "Hit Rate" label (e.g., a small `⚠` symbol, or the text ` (low n)` appended)
- Tooltip includes the sample size explicitly: `"Based on N=${calibrationSamples} similar historical setups (low sample — treat as directional only)"`

When `calibrationSamples >= 100`:
- Render normally at current `opacity-60`
- Standard tooltip: `"Based on N=${calibrationSamples} similar historical setups"`

When `calibrationSamples` is null or `historicalConfidence` is null:
- Existing behavior — the History row doesn't render at all
- **Change:** align with Sibling A's Smart bar "No Scoring" pattern — show an inline "No History — Insufficient Data" placeholder in the History slot so the 3-bar layout stays consistent
- Apply the same visual style as the Smart bar's "No Scoring" placeholder

---

## File manifest

### Modified files

| Path | Change | LoC |
|---|---|---|
| `src/components/spikes/SpikeCard.tsx` | Label text, tooltip text, opacity logic, inline placeholder when null | ~30 |
| `src/app/api/spikes/route.ts` | If any `historicalConfidence` field gets renamed in the response shape, update here. Likely NO change if we keep the DB field name. | 0 (probably) |
| `src/lib/scheduling/analyzer.ts` | No change — field name stays `historicalConfidence` | 0 |
| `src/types/index.ts` | No change — field name stays `historicalConfidence` | 0 |
| `src/app/dashboard/analysis/[id]/page.tsx` | If this page displays historicalConfidence with the old label, update to "Hit Rate" | ~5 (if present) |

### Not touched

- `prisma/schema.prisma` — keep `historicalConfidence Float?` as-is
- `canadian_llm_council_brain.py` — no changes (backend field stays the same)
- `api_server.py` — no changes
- Any cron scripts, env vars, etc.

---

## SpikeCard.tsx changes — detailed

### Current state (after Sibling A)

```tsx
        {/* History bar (only shown when calibration data exists) */}
        {spike.historicalConfidence != null && (
          <div className="flex items-center gap-2" title={`Based on ${spike.calibrationSamples?.toLocaleString() || '?'} similar historical setups`}>
            <span className="text-xs text-spike-text-muted w-14 font-medium">History</span>
            <div className="flex-1 h-2 bg-spike-bg rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-1000 opacity-60"
                style={{ width: `${spike.historicalConfidence}%`, background: /* green/amber/red */ }}
              />
            </div>
            <span className="text-xs mono text-spike-text-dim w-9 text-right">{spike.historicalConfidence.toFixed(0)}%</span>
          </div>
        )}
```

### Proposed state

```tsx
        {/* Hit Rate bar — renamed from History, with low-confidence cue when n<100 */}
        {(() => {
          const lowSample = spike.calibrationSamples != null && spike.calibrationSamples < 100;
          const rate = spike.historicalConfidence;
          const n = spike.calibrationSamples;
          const hasData = rate != null && n != null && n > 0;

          if (!hasData) {
            // Inline "No History" placeholder matching Sibling A's Smart bar pattern
            return (
              <div className="flex items-center gap-2 mb-1.5"
                   title="No similar historical setups available for calibration">
                <span className="text-xs text-spike-text-muted w-14 font-medium">Hit Rate</span>
                <span className="flex-1 text-xs text-spike-text-muted italic">No History — Insufficient Data</span>
              </div>
            );
          }

          const opacityClass = lowSample ? 'opacity-30' : 'opacity-60';
          const labelSuffix = lowSample ? ' ⚠' : '';
          const tooltipText = lowSample
            ? `Based on N=${n.toLocaleString()} similar historical setups (low sample — treat as directional only)`
            : `Based on N=${n.toLocaleString()} similar historical setups`;

          return (
            <div className="flex items-center gap-2" title={tooltipText}>
              <span className="text-xs text-spike-text-muted w-14 font-medium">Hit Rate{labelSuffix}</span>
              <div className="flex-1 h-2 bg-spike-bg rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ${opacityClass}`}
                  style={{
                    width: `${rate}%`,
                    background: rate >= 80
                      ? 'linear-gradient(90deg, rgba(0,255,136,0.3), #00FF88)'
                      : rate >= 60
                      ? 'linear-gradient(90deg, rgba(255,184,0,0.3), #FFB800)'
                      : 'linear-gradient(90deg, rgba(255,51,102,0.3), #FF3366)',
                  }}
                />
              </div>
              <span className="text-xs mono text-spike-text-dim w-9 text-right">{rate.toFixed(0)}%</span>
            </div>
          );
        })()}
```

Also update the overconfidence flag tooltip from `"Council confidence exceeds historical base rate by >10 points"` to `"Council confidence exceeds historical hit rate by >10 points"`.

### Dashboard analysis page (`src/app/dashboard/analysis/[id]/page.tsx`)

If this page references `historicalConfidence` in display, update any label/heading from "Historical Confidence" to "Historical Hit Rate". Implementation detail: grep the file and adjust.

---

## Verification plan

1. **Local build check:** `npm run build` passes
2. **Visual check in production after deploy:**
   - Open `/dashboard` — SpikeCards now show "Hit Rate" label
   - Hover a pick with `calibrationSamples < 100` — see the ⚠ marker, reduced opacity, and "low sample" tooltip
   - Hover a pick with `calibrationSamples >= 100` — standard display, standard tooltip
   - Find a pick with NULL calibration (some new/unusual tickers) — see "No History — Insufficient Data" inline placeholder
3. **Tomorrow's 10:45 AST council run** produces new picks and all three bars render correctly

---

## Rollout

- Branch: `feat/historical-hit-rate-refresh` off `origin/main`
- Single PR — frontend-only, no schema, no backend
- Deploy: `git pull` on production, `docker compose up -d --build app`, no `prisma db push` needed
- T+0 verification via browser
- Rollback: revert the commit if visual regression

---

## Open questions

None. Design is straightforward. Ready for implementation.
