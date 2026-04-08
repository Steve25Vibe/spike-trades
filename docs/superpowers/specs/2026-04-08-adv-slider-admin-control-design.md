# ADV Slider Admin Control — Design Spec

**Date:** 2026-04-08
**Status:** Draft, to be reviewed after spec write
**Topic:** New admin UI slider in the Council tab that controls the minimum Average Daily Dollar Volume (ADV) threshold used by the council brain's Step 3 liquidity filter. Replaces the hardcoded `MIN_ADV_DOLLARS = 5_000_000` constant with a database-persisted configurable value.
**Sibling:** System A (this session)

---

## Problem

The council brain currently uses a **hardcoded** minimum ADV threshold of $5M:

```python
# canadian_llm_council_brain.py:4440
MIN_ADV_DOLLARS = 5_000_000
```

This constant is used at line 4483 in the Step 3 liquidity filter to narrow the candidate universe. Changing it requires a code edit + redeploy.

Operationally, the admin may want to adjust this threshold day-to-day depending on market conditions (e.g., lower threshold in quiet markets to widen the candidate pool, higher threshold in volatile markets to focus on the most-liquid names). The current workflow forces code changes for what should be a runtime configuration.

**Side finding:** A stale comment at line 4468 reads `# Full liquidity filter: ADV >= $8M` but the actual constant is $5M. This documentation bug should be fixed as part of this work.

---

## Goal

Add an admin-only slider in the Council tab that:
- Allows the admin to select a minimum ADV threshold between **$500,000** and **$8,000,000**
- Uses **$500,000 increments** (16 discrete positions)
- Defaults to **$5,000,000** (matches current hardcoded behavior — zero behavior change on default)
- **Persists to the database** so tomorrow's 10:45 AST cron picks up the value automatically
- Applies to the **next** council run (not a run already in progress)
- Is only visible and changeable by **admin-role** users

---

## Non-goals

- No changes to the council brain's other filter logic (price floor, volume heuristic, whitelist filter, etc.)
- No per-user personalization — the slider is global, one value for all runs
- No history log of slider changes (nice-to-have for future, YAGNI for now)
- No A/B testing with different thresholds
- No automatic adjustment based on market conditions

---

## Approach

### 1. Database layer — new `CouncilConfig` table

A single-row key-value-ish table that stores council runtime configuration:

```prisma
model CouncilConfig {
  id                String   @id @default("singleton")  // enforce single row via default
  minAdvDollars     Int      @default(5000000)           // $5M default
  updatedAt         DateTime @updatedAt
  updatedByUserId   String?                              // audit: who changed it
  updatedByEmail    String?                              // cached at write time for display
}
```

**Single-row pattern:** the `id` field defaults to the literal string `"singleton"` so all reads/writes upsert on that key. No risk of multiple config rows.

**Why a separate table instead of adding fields to an existing one:** keeps council-specific config isolated, allows future config additions (other sliders, toggles, etc.) without polluting `User` or `DailyReport`.

### 2. API layer — `GET/POST /api/admin/council/config`

New endpoint for reading and updating the config. Auth-gated to admin role via `requireAdmin()`.

**GET** `/api/admin/council/config` → returns `{ minAdvDollars: 5000000, updatedAt: "...", updatedByEmail: "..." }`

**POST** `/api/admin/council/config` body `{ minAdvDollars: 5500000 }` → validates range and increment, upserts the singleton row, returns updated config. On invalid input (below 500k, above 8M, or not a multiple of 500k) returns 400 with error message.

**Validation rules:**
- `minAdvDollars >= 500000`
- `minAdvDollars <= 8000000`
- `minAdvDollars % 500000 === 0`

### 3. Python brain layer — read config at run start

In `run_council_analysis()` in `canadian_llm_council_brain.py`, around line 4440 where the hardcoded constant currently lives, replace with a read from the database:

```python
# Read min ADV threshold from CouncilConfig table (set via admin panel)
# Falls back to $5M default if table empty or unreachable
MIN_ADV_DOLLARS = await _read_council_config_min_adv(default=5_000_000)
```

Where `_read_council_config_min_adv()` is a new helper function that:
- Queries the `CouncilConfig` table via a direct Postgres connection (the council brain has DB access via `DATABASE_URL` env var — confirm this during implementation)
- Returns the stored value OR the default on any error
- Non-blocking: a DB read failure falls back to the default, never crashes the run
- Logs which value was used: `logger.info(f"Council config: MIN_ADV_DOLLARS=${MIN_ADV_DOLLARS:,} (from DB)")` or fallback

**Alternative if council brain cannot reach Postgres directly:** the Python brain could read from an env var `COUNCIL_MIN_ADV_DOLLARS` which the Next.js side writes to a shared file the council container mounts. Less clean but works. The implementation task should verify the brain's DB access first and prefer the direct-read approach.

### 4. Admin UI — slider in Council tab

In `src/app/admin/page.tsx`, add a new section ABOVE the "Trigger Council Run" button in the `council` tab content. The slider component:

```
┌─ Council Configuration ──────────────────────────────────────┐
│                                                              │
│  Minimum ADV for next run:                  $5,000,000       │
│  [===============|===================]   (slider)            │
│   $500k                            $8M                       │
│                                                              │
│  Last updated: 2026-04-08 15:30 AST by steve@boomerang.energy │
│                                                              │
│  [ Save Configuration ]   [ Reset to Default ]               │
│                                                              │
└──────────────────────────────────────────────────────────────┘

[ Trigger Council Run ]  (existing button, unchanged)
```

**Component behavior:**
- On mount, GET `/api/admin/council/config` to populate the slider with the current value
- Slider uses HTML5 `<input type="range">` with `min={500000} max={8000000} step={500000}`
- Live-updates the displayed dollar value as the user drags (no debounce needed for display)
- "Save Configuration" button POSTs the new value; shows a saving state; displays success/error toast
- "Reset to Default" sets the slider to $5,000,000 in local state (does not POST until Save is clicked)
- If the POST returns an error (validation, auth, network), display it clearly
- After successful save, update the "Last updated" timestamp and user display

### 5. Stale comment fix

Line 4468 of `canadian_llm_council_brain.py` currently reads:
```python
# Full liquidity filter: ADV >= $8M using avgVolume from profile
```

Update to reflect the new dynamic behavior:
```python
# Full liquidity filter: ADV >= configured MIN_ADV_DOLLARS (from CouncilConfig table)
```

---

## File manifest

### New files
| Path | Responsibility | LoC |
|---|---|---|
| `src/app/api/admin/council/config/route.ts` | NEW GET+POST endpoint for reading/writing CouncilConfig | ~60 |

### Modified files

| Path | Change | LoC |
|---|---|---|
| `prisma/schema.prisma` | Add `CouncilConfig` model | +8 |
| `canadian_llm_council_brain.py` | Add `_read_council_config_min_adv()` helper, replace hardcoded constant, fix stale comment at line 4468 | ~30 |
| `src/app/admin/page.tsx` | Add `CouncilConfigPanel` component, wire it into Council tab above the Trigger Council Run button | ~80 |

### Not touched
- `src/components/spikes/SpikeCard.tsx` — no UI impact on public dashboards
- `src/types/index.ts` — no shared type impact
- `src/lib/scheduling/analyzer.ts` — no analyzer impact
- `api_server.py` — no api_server impact (config read happens in brain)

---

## Deploy sequence

1. Branch `feat/adv-slider-admin` from `origin/main`
2. Code changes across 4 files
3. `npm run build` verifies
4. Commit + push + PR
5. Merge to main
6. Production: `git pull` + `docker compose build app` + `docker compose run --rm --no-deps app node node_modules/prisma/build/index.js db push --skip-generate` (adds CouncilConfig table) + `docker compose up -d app`
7. Seed default row: the POST endpoint's upsert logic handles this automatically on first write, OR manually via psql: `INSERT INTO "CouncilConfig" (id, "minAdvDollars") VALUES ('singleton', 5000000) ON CONFLICT DO NOTHING;`
8. **Council container must be rebuilt too** to pick up the `_read_council_config_min_adv` code change: `docker compose build council && docker compose up -d council`
9. T+0 verification: open `/admin` → Council tab → confirm slider shows $5M default, adjust slider, save, reload, confirm persistence

---

## Verification plan

**T+0 (immediately after deploy):**
1. `SELECT * FROM "CouncilConfig";` → shows singleton row with `minAdvDollars=5000000` (or empty if not yet initialized — acceptable)
2. Admin user opens Council tab → slider renders with $5M value
3. Admin drags slider to $4.5M, clicks Save → POST returns 200
4. Refresh page → slider still shows $4.5M (persistence confirmed)
5. Non-admin user tries to POST → 403 Forbidden
6. Admin drags slider to $9M (out of range) → save button validates and rejects (or server returns 400)

**T+1 run (tomorrow's 10:45 AST council run):**
1. Council container logs show: `Council config: MIN_ADV_DOLLARS=$X,XXX,XXX (from DB)`
2. The Step 3 liquidity filter uses the configured value, not $5M (if changed)
3. Candidate count at Step 3 differs from historical runs if ADV was changed

---

## Rollback

- Revert the PR → `git revert` + redeploy
- The `CouncilConfig` table stays in the database (harmless with no readers)
- The brain falls back to hardcoded $5M if the helper function can't reach the DB

---

## Open questions

None. Design is straightforward. Ready for implementation.
