# Fix: Dual-Bar Confidence Meter Not Displaying on Today's Spikes

## Root Cause

**The `analyzer.ts` spike mapping (lines 217-255) does NOT include the three calibration fields** when saving to PostgreSQL via Prisma. The Python `api_server.py` correctly maps `historicalConfidence`, `calibrationSamples`, and `overconfidenceFlag` in its response (lines 235-237), but `analyzer.ts` silently drops them because they're not in the `spikeData` object.

### Why yesterday's report has calibration data
Session 14 manually backfilled calibration values directly into PostgreSQL via SQL. This bypassed `analyzer.ts` entirely, which is why it appeared to work — but it was a one-time manual fix, not a pipeline fix.

### Data flow showing where the break occurs
```
Python brain → apply_calibration() → picks have calibration ✅
  → api_server.py _map_to_prisma() → response includes historicalConfidence ✅
    → analyzer.ts receives mapped response ✅
      → analyzer.ts spikeData mapping → DROPS historicalConfidence/calibrationSamples/overconfidenceFlag ❌
        → Prisma creates Spike records with NULL calibration fields ❌
          → Frontend checks spike.historicalConfidence != null → false → hides history bar ❌
```

## Fix Plan

### Step 1: Add calibration fields to analyzer.ts spike mapping
**File:** `src/lib/scheduling/analyzer.ts` (around line 254)

Add the three missing fields to the `spikeData` mapping:
```typescript
atr: spike.atr,
// Calibration data for dual-bar confidence meter
historicalConfidence: spike.historicalConfidence,
calibrationSamples: spike.calibrationSamples,
overconfidenceFlag: spike.overconfidenceFlag,
```

This is the only code change needed. The Python brain, api_server.py, spikes API route, and frontend SpikeCard component are all correct already.

### Step 2: Backfill today's spikes from the existing JSON output
Rather than re-running the entire council pipeline (~45 min), we can:
1. Call the existing `/latest-output-mapped` endpoint to get today's mapped data with calibration values
2. Run a SQL UPDATE on today's 10 spikes to set `historicalConfidence`, `calibrationSamples`, `overconfidenceFlag` from the existing data

### Step 3: Deploy the fix
1. Commit and push the analyzer.ts change
2. Rebuild the app container on the server
3. Verify today's tiles now show the dual-bar meter

### Step 4: Verify future runs are protected
The next council run (tomorrow 10:45 AM) will automatically save calibration data through the fixed analyzer.ts pipeline.

## Files to modify
- `src/lib/scheduling/analyzer.ts` — add 3 fields to spikeData mapping (1 change, ~3 lines)

## Risk assessment
- **Low risk** — adding optional fields to an existing Prisma create. The fields already exist in the schema as nullable, so no migration needed.
- No changes to the Python brain, API server, or frontend components.
