# Phase 1 — Surgical Removal of Radar and Opening Bell

**Status:** Approved for implementation
**Date:** 2026-04-07
**Author:** Steve + Claude (brainstorm transcript: see session 13 follow-up)
**Phase number:** 1 of 4 in the Spike Trades focus pivot
**Related phases:** Phase 2 (EODHD hybrid) → Phase 3 (Learning Loop audit) → Phase 4 (Today's Spikes refinements)

---

## Context

Spike Trades currently runs three product surfaces:
1. **Today's Spikes** — overnight council scan, 10 picks per day, the core product
2. **Smart Money Radar** — pre-market institutional flow scanner, retired in this phase
3. **Opening Bell** — early-momentum scanner, retired in this phase

Recent investigation surfaced multiple issues across all three surfaces, with the worst hitting Opening Bell (the NGD.TO frozen-quote incident on 2026-04-07). Rather than continue maintaining three pipelines while their data quality and learning loops degrade, the product is pivoting to focus 100% on Today's Spikes. Radar and Opening Bell are being removed as features.

This spec covers Phase 1 of that pivot: the surgical removal of all Radar and Opening Bell runtime code from the codebase, with a strict guarantee that the underlying database is left physically unchanged. Phases 2–4 follow in their own specs.

---

## Section 1 — Goal and Non-Goals

### Goal

Surgically remove every line of runtime code that reads from, writes to, or renders the Radar and Opening Bell features. The Today's Spikes pipeline ends Phase 1 byte-identical (except where surgical exceptions are explicitly authorized). The Postgres database ends Phase 1 physically unchanged — same schema, same row counts, same column values.

### In scope — exhaustive file manifest

#### Frontend pages — DELETE files
- `src/app/radar/page.tsx`
- `src/app/opening-bell/page.tsx`

#### Frontend components — DELETE files
- `src/components/radar/RadarCard.tsx`
- `src/components/radar/RadarIcon.tsx` (OK to delete because of SpikeCard exception)
- `src/components/radar/RadarLockInModal.tsx`
- `src/components/opening-bell/OpeningBellCard.tsx`

#### Frontend — STRIP refs (file remains)
- `src/components/layout/Sidebar.tsx` — remove BOTH `/radar` and `/opening-bell` nav entries
- `src/app/reports/page.tsx` — strip Radar+OB tab infrastructure (lines 35, 55, 59, 66, 70, 76–88, 102–103, 119–155, 222–287, 288–344). Page becomes single Spikes archive view.
- `src/app/admin/page.tsx` — strip `OpeningBellStatus` interface (line 63), `radarAccuracy` interface (97–102), state fields (93–96), `triggerOpeningBell` (274), `triggerRadar` (284), Radar Scanner panel (614–664), Radar Accuracy panel (666–712), Opening Bell Scanner panel (716+), Radar+OB columns of Data Source Health (1029–1037, keep FMP column)
- `src/app/settings/page.tsx` — strip `emailOpeningBell` and `emailRadar` toggles (lines 10–11, 59–60)
- `src/components/spikes/SpikeCard.tsx` — **AUTHORIZED SURGICAL EXCEPTION**: delete only line 7 (`RadarIcon` import) and lines 84–90 (the two badge conditional blocks). ~10 lines, all deletions. Diff shown to user before applying (two-keys-to-fire).

#### Backend API routes — DELETE files
- `src/app/api/radar/route.ts`
- `src/app/api/cron/radar/route.ts`
- `src/app/api/reports/radar/route.ts`
- `src/app/api/reports/radar/[id]/xlsx/route.ts`
- `src/app/api/opening-bell/route.ts`
- `src/app/api/opening-bell/[id]/route.ts`
- `src/app/api/cron/opening-bell/route.ts`
- `src/app/api/reports/opening-bell/route.ts`
- `src/app/api/reports/opening-bell/[id]/xlsx/route.ts`

#### Backend API — STRIP refs (file remains)
- `src/app/api/admin/council/route.ts` — strip parallel-fetches for `/run-radar-status` + `/radar-health` (61–64), `prisma.radarPick.findMany` accuracy block (82–91), Radar/OB result destructuring (38–44), all Radar/OB response fields (100–141), `type: 'radar'` POST branch (163–179)
- `src/app/api/portfolio/route.ts` — strip `openingBellPickIds` + `radarPickIds` destructure (176), `obIdsToLock` + `radarIdsToLock` setup (179–184), entire OB processing block (~270–336), entire Radar processing block (337–394). Spikes lock-in path stays untouched.
- `src/app/api/spikes/route.ts` — strip `openingBellTickers` query (51–58), `radarTickerMap` query (62–69), `isOpeningBellPick` + `isRadarPick` + `radarScore` fields in response (135–138). Today's Spikes core logic stays untouched.
- `src/app/api/accuracy/check/route.ts` — strip OB picks accuracy backfill block (177–220), Radar accuracy backfill block (224–275), Radar pipeline flag update block (277–316), update return shape to drop `openingBellFilled` and `radarFilled` fields. Today's Spikes accuracy backfill stays.
- `src/app/api/user/preferences/route.ts` — strip `emailRadar` and `emailOpeningBell` field handling. `User.emailRadar` column on the User table stays (data preservation).

#### Library and scheduling — DELETE files
- `src/lib/radar-analyzer.ts`
- `src/lib/opening-bell-analyzer.ts`
- `src/lib/email/radar-email.ts`
- `src/lib/email/opening-bell-email.ts`

#### Library and scheduling — STRIP refs
- `src/lib/email/resend.ts` — strip OB+Radar template wiring
- `src/lib/scheduling/analyzer.ts` — strip OB+Radar pipeline calls (6 refs). Spike scheduling stays untouched.
- `scripts/start-cron.ts` — strip Radar cron entry (lines 48–66) and OB cron entry (similar adjacent block)

#### Types and config — STRIP refs
- `src/types/index.ts` — strip `isOpeningBellPick`, `isRadarPick`, `radarScore` fields from the Spike type (lines 100–102)
- `tailwind.config.ts` — strip `radar-green` color token (line 32) and `radar-sweep` animation entries (lines 60, 83)

#### Python — DELETE files
- `opening_bell_scanner.py`

#### Python — STRIP refs (file remains)
- `api_server.py` — 124 refs. Largest single surgery. Strip all Radar + OB endpoint handlers, type defs, cache invalidation logic, response shaping. Today's Spikes endpoints (`/run-council`, etc.) stay untouched.
- `canadian_llm_council_brain.py` — 72 refs. Strip `RadarScanner` class, `RadarPick` / `RadarResult` / `RadarScoreBreakdown` dataclasses, `OpeningBellScanner` integration points. Council brain Today's Spikes flow stays untouched.
- `canadian_portfolio_interface.py` — strip `radar_tickers` parameter (88, 94, 102), `radar_badge` HTML (364), `is_radar` conditional rendering (371, 375)
- `eodhd_news.py` — update docstring at line 20 (trivial — comment cleanup only)
- `fmp_bulk_cache.py` — update docstring at line 3 (trivial — comment cleanup only)

#### Tests — DELETE files
- `src/__tests__/opening-bell-api.test.ts`
- `tests/test_opening_bell_integration.py`
- `tests/test_opening_bell_scanner.py`
- `tests/test_radar_scanner.py`

#### Empty directory removal (after files deleted)
- `src/app/opening-bell/`
- `src/app/api/opening-bell/`
- `src/app/api/radar/`
- `src/app/radar/`
- `src/components/opening-bell/`
- `src/components/radar/`

#### Operational (not code commits)
- Stop the OB and Radar cron containers / processes after deploy
- Remove any cron entries from server-side host crontab if they exist outside `start-cron.ts`

### Explicitly NOT in scope — preservation list

#### Database (zero touch — physical guarantee)
- No migrations, no `ALTER TABLE`, no `DROP TABLE`, no `CREATE TABLE`
- No row deletions in `RadarReport`, `RadarPick`, `OpeningBellReport`, `OpeningBellPick`, `PortfolioEntry`, or anywhere else
- `User.emailRadar` column stays. No flipping of `true → false`. Subscriber rows untouched.

#### Prisma schema (zero touch)
- `RadarReport`, `RadarPick`, `OpeningBellReport`, `OpeningBellPick` models stay verbatim
- `User.emailRadar` and `User.emailOpeningBell` fields stay
- `PortfolioEntry.openingBellPickId` and `PortfolioEntry.radarPickId` relations stay
- No new fields, no removed fields, no renamed fields

#### False positives confirmed safe (do NOT touch)
- `src/app/dashboard/analysis/[id]/page.tsx` — 8 "radar" references are recharts `<RadarChart>` library imports, NOT Smart Money Radar
- `prisma/migrations/20260404_add_radar_models/` — historical migration, deleting breaks Prisma history
- `prisma/migrations/20260404_add_radar_accuracy_fields/` — same
- All `docs/` files — historical record
- `SESSION_8_TRANSITION.md`, `SESSION_10_PROMPT.md`, `SESSION_11_PROMPT.md` — historical session prompts
- `.claude/plans/radar-time-change.md` — internal historical
- `.claude/settings.local.json` — historical Bash permission allowlist, no runtime impact

#### Hand-offs to other phases
- **Phase 2:** FMP freshness gate, EODHD integration, dual-source cross-validation, news/sentiment migration, Data Source Health panel rebuild with EODHD column
- **Phase 3:** Learning Loop forensic audit (24 missing accuracy_records bug, calibration_council under-population, statistical relevance metrics)
- **Phase 4:** Today's Spikes scoring/ranking/UI refinements

### Definition of done

1. `npm run build` exits 0 with zero errors and zero new warnings
2. `npm run lint` passes
3. All remaining tests pass (`npm test` and `python -m pytest`)
4. Manual smoke test: login → dashboard → Today's Spikes scan → portfolio → admin (FMP-only health) → reports (Spikes-only archive)
5. Grep verification on `src/`, `tests/`, root `*.py` returns ONLY: `prisma/schema.prisma` (4 archived models + emailRadar field), `dashboard/analysis/[id]/page.tsx` (recharts imports), and historical `docs/`/`SESSION_*` files
6. Postgres row counts for `RadarReport`, `RadarPick`, `OpeningBellReport`, `OpeningBellPick`, `User.emailRadar=true`, `PortfolioEntry` (and the FK-linked subsets) are identical pre vs post, proven by `phase1_db_parity.sh` exit 0
7. No customer reports of breakage in 24 hours post-deploy

---

## Section 2 — Bottom-Up Commit Manifest

11 commits total: Commit 0 sets up verification tooling without touching production code, then Commits 1–10 perform the work. Each commit is sequenced so it leaves the codebase building, tests passing, and Today's Spikes functional. Per-commit verification gate before proceeding to the next. Any failure on a verification gate = revert that single commit, diagnose, retry — never roll forward over a red gate.

### Commit 0 — Setup (verification tooling, no production code)

Add the three Phase 1 scripts and capture the pre-snapshot.

**Files added:**
- `scripts/phase1_snapshot.sh`
- `scripts/phase1_verify.sh`
- `scripts/phase1_db_parity.sh`
- `scripts/phase1_snapshot_pre.txt` (output of `./scripts/phase1_snapshot.sh pre`)

**Verification gate:**
- All 3 scripts are executable
- `phase1_snapshot_pre.txt` exists, is non-empty, contains the row counts for the 4 archived tables

### Commit 1 — Tests (true leaves)

**Delete:** the 4 test files listed in Section 1.

**Verification gate:** `npm test`, `python -m pytest`, `npm run build` all pass.

**Risk:** Lowest. Tests are pure leaves.

### Commit 2 — Cron schedule (stop launching new runs)

**Strip:** `scripts/start-cron.ts` Radar cron entry (lines 48–66) + OB cron entry.

**Verification gate:** `npm run build` clean, manual inspection of `start-cron.ts`.

**Operational after deploy:** restart cron container, verify logs show no Radar/OB triggers.

**Risk:** Low. Stops new scheduled runs but existing routes still functional.

### Commit 3 — User-facing UI entry points

**Strip:** `src/components/layout/Sidebar.tsx` — remove BOTH `/radar` and `/opening-bell` nav entries.

**Delete:** `src/app/radar/page.tsx`, `src/app/opening-bell/page.tsx`.

**Strip:** `src/app/reports/page.tsx` — full tab infrastructure removal per Section 1.

**Verification gate:** Build clean, lint clean, manual smoke. **Critical false-positive guard:** `/dashboard/analysis/[id]` recharts polygon chart still renders. If broken, revert immediately.

**Risk:** Medium.

### Commit 4 — Settings + User Preferences API

**Strip:** `src/app/settings/page.tsx` toggles, `src/app/api/user/preferences/route.ts` field handling.

**Verification gate:** Build clean, manual settings page check, Postgres `User.emailRadar` row count unchanged.

**Risk:** Medium.

### Commit 5 — Admin Panel + Admin Council Route

**Strip:** `src/app/admin/page.tsx` per Section 1 line list, `src/app/api/admin/council/route.ts` per Section 1 line list.

**Verification gate:** Build clean, `/admin` page renders with FMP-only Data Source Health, council telemetry intact, manual council trigger works.

**Risk:** Medium-high.

### Commit 6 — SpikeCard surgical exception + Spike type cleanup ⚠ TWO-KEYS-TO-FIRE

**Edit (PROTECTED — diff shown to user before applying):** `src/components/spikes/SpikeCard.tsx` — delete line 7 + lines 84–90.

**Strip:** `src/types/index.ts` — delete lines 100–102.

**Verification gate:** Diff shows ONLY deletions, ONLY touches the authorized lines, build clean, lint clean, no missing-property TypeScript errors, dashboard renders Today's Spikes minus Radar/OB badges.

**Risk:** High (touching protected file).

### Commit 7 — Cross-references in shared backend routes

**Strip:** `src/app/api/spikes/route.ts`, `src/app/api/portfolio/route.ts`, `src/app/api/accuracy/check/route.ts`, `src/lib/scheduling/analyzer.ts`, `src/lib/email/resend.ts` per Section 1 line lists.

**Verification gate:** Build clean, lint clean, tests pass, `/api/spikes` returns clean response, portfolio lock-in works for Spikes, accuracy check returns valid response shape, Postgres `PortfolioEntry` row counts (including the FK-linked subsets) unchanged.

**Risk:** High. Largest backend surgery.

### Commit 8 — Bulk delete of leaf components, API routes, library files

**Delete:** RadarCard, RadarIcon, RadarLockInModal, OpeningBellCard, all 9 deleted API route files, radar-analyzer, opening-bell-analyzer, radar-email, opening-bell-email.

**Verification gate:** Build clean (the smoking gun: if this passes, the import graph really is decoupled). Grep returns zero matches for the deleted file basenames.

**Risk:** Low (callers already removed in earlier commits).

### Commit 9 — Tailwind config cleanup

**Strip:** `tailwind.config.ts` — `radar-green` color token, `radar-sweep` animation entries.

**Verification gate:** Build clean (Tailwind validates classes), grep returns zero matches for `radar-green` / `radar-sweep` anywhere in `src/`, dashboard renders with no broken styles.

**Risk:** Low.

### Commit 10 — Python source surgery ⚠ TWO-KEYS-TO-FIRE

**Strip:** `api_server.py`, `canadian_llm_council_brain.py`, `canadian_portfolio_interface.py`, `eodhd_news.py`, `fmp_bulk_cache.py` per Section 1.

**Delete:** `opening_bell_scanner.py`.

**Verification gate:** All 5 Python imports succeed, pytest passes, manual `/run-council` endpoint test, grep on root `*.py` returns expected zero, database snapshot of 4 archived tables unchanged.

**Risk:** Highest. Single atomic commit because of Python's circular import potential. Two-keys-to-fire applied.

---

## Section 3 — Verification Gate Scripts

Three scripts created in Commit 0, used throughout Phase 1.

### `scripts/phase1_snapshot.sh`

Captures an immutable proof of database state. Runs in `pre` mode before Commit 1, `post` mode after Commit 10 deploys, and `t24h` mode after the 24-hour observability window.

**SQL captured:**
```sql
SELECT 'snapshot_taken_at'        AS metric, NOW()::text AS value
UNION ALL SELECT 'RadarReport_count',          COUNT(*)::text FROM "RadarReport"
UNION ALL SELECT 'RadarPick_count',            COUNT(*)::text FROM "RadarPick"
UNION ALL SELECT 'OpeningBellReport_count',    COUNT(*)::text FROM "OpeningBellReport"
UNION ALL SELECT 'OpeningBellPick_count',      COUNT(*)::text FROM "OpeningBellPick"
UNION ALL SELECT 'PortfolioEntry_total',       COUNT(*)::text FROM "PortfolioEntry"
UNION ALL SELECT 'PortfolioEntry_with_obPick', COUNT(*)::text FROM "PortfolioEntry" WHERE "openingBellPickId" IS NOT NULL
UNION ALL SELECT 'PortfolioEntry_with_radarPick', COUNT(*)::text FROM "PortfolioEntry" WHERE "radarPickId" IS NOT NULL
UNION ALL SELECT 'User_total',                 COUNT(*)::text FROM "User"
UNION ALL SELECT 'User_emailRadar_true',       COUNT(*)::text FROM "User" WHERE "emailRadar" = true
UNION ALL SELECT 'User_emailOpeningBell_true', COUNT(*)::text FROM "User" WHERE "emailOpeningBell" = true
UNION ALL SELECT 'Spike_total',                COUNT(*)::text FROM "Spike"
UNION ALL SELECT 'DailyReport_total',          COUNT(*)::text FROM "DailyReport"
UNION ALL SELECT 'CouncilLog_total',           COUNT(*)::text FROM "CouncilLog"
ORDER BY metric;
```

The script is read-only (no writes, no DELETEs).

### `scripts/phase1_verify.sh <commit_number>`

Per-commit verification gate. Runs build, lint, tests, and a commit-number-specific grep check that becomes stricter as Phase 1 progresses. Exit 0 = green. Non-zero = revert. The grep checks per commit are listed in Section 2.

### `scripts/phase1_db_parity.sh`

The proof script for the database-untouched guarantee. Diffs `phase1_snapshot_pre.txt` against `phase1_snapshot_post.txt` (excluding the `snapshot_taken_at` line). Exit 0 = parity verified. Exit 1 = drift detected → Playbook B.

---

## Section 4 — Risk Register and Rollback Procedures

### Risk register

| ID | Risk | Triggers in commit | Severity | Probability | Detection | Playbook |
|---|---|---|---|---|---|---|
| R1 | Today's Spikes UI broken (any spike card fails to render) | 6, 7 | Critical | Low | Build + manual smoke | A |
| R2 | Today's Spikes pipeline (council scan) fails | 7, 10 | Critical | Low–Med | Python imports + manual `/run-council` | A |
| R3 | Database row count drift in any tracked table | Any, esp. 7, 10 | Critical | Very Low | `phase1_db_parity.sh` | B |
| R4 | Build fails due to missed import reference | 6, 7, 8, 9 | High | Med | Build check | A |
| R5 | Tailwind class still referenced in remaining files | 9 | High | Low | Grep check | A |
| R6 | dashboard/analysis recharts polygon chart broken | 3 onwards | High | Very Low | Manual smoke | A |
| R7 | Settings page crashes for users with `emailRadar=true` | 4 | High | Low | Manual + post-deploy | A |
| R8 | Admin panel partial render | 5 | High | Low–Med | Manual `/admin` | A |
| R9 | Portfolio lock-in path broken for Spikes | 7 | Critical | Low | Manual portfolio-add | A |
| R10 | Python `api_server.py` fails to import after strip | 10 | Critical | Med | Python import + pytest | C |
| R11 | Council brain `canadian_llm_council_brain.py` fails to import | 10 | Critical | Med | Python import | C |
| R12 | Cron container fails to restart with new `start-cron.ts` | 2 | High | Low | Docker logs | D |
| R13 | Production deploy succeeds but customer reports breakage in 24h | Any post-deploy | High | Low | Customer report / Activity panel | D |
| R14 | Mid-deploy session: user is mid-action when an endpoint they rely on is deleted | 8 | Low | Med | None (acceptable for current user volume) | (none) |

### Playbook A — Local revert before deploy

Applies to R1, R2, R4, R5, R6, R7, R8, R9.

```bash
# 1. STOP. Do not push. Do not deploy.
# 2. Capture failure state for diagnosis:
git status > /tmp/phase1_failure_status.txt
git diff HEAD~1 > /tmp/phase1_failure_diff.txt
./scripts/phase1_verify.sh <N> 2>&1 > /tmp/phase1_failure_verify.txt || true

# 3. Revert (NEVER --hard, NEVER --no-verify):
git revert --no-edit HEAD

# 4. Re-verify the reverted state:
./scripts/phase1_verify.sh $((N-1))

# 5. Diagnose using the captured files before re-attempting commit N.
```

### Playbook B — Database drift detected

Applies to R3 (the promise we made would never break).

```bash
# 1. STOP all operator activity.
# 2. Save the diff:
cat /tmp/phase1_diff.txt > /tmp/phase1_DRIFT_$(date +%s).txt

# 3. Identify which table drifted (Radar/OB/User_emailRadar/PortfolioEntry → violation;
#    Spike/DailyReport/CouncilLog → check whether a normal Spikes scan ran during the window).

# 4. Forensic query against the affected table.
# 5. If a row was deleted, escalate to backup restore (with explicit confirmation).
# 6. Phase 1 is HALTED until parity is restored or drift is explained.
```

Drift on any of the 4 archived tables → immediate halt + Steve notification.

### Playbook C — Python import broken post-strip

Applies to R10, R11. Standard `git revert HEAD` plus extra verification that the revert restored a working state. If the revert is incomplete, identify the last known good commit and (with explicit confirmation) `git reset --hard` to it. This is the only place in Phase 1 where `--hard` is permitted, and only with confirmation.

### Playbook D — Post-deploy production rollback

Applies to R12, R13. Capture production state, identify the offending commit, `git revert --no-edit <commit-sha>..HEAD`, push, redeploy, verify production recovered. Total rollback time budget: under 15 minutes.

### Cross-cutting safeguards

- **Two-keys-to-fire** on Commits 6 and 10 (procedure in Section 5)
- **No `--hard` resets, no `--no-verify`, no destructive git ops without confirmation**
- **Backup-before-risk** on Commits 6, 7, 10 (Steve's call per commit; daily 07:00 UTC backup is the floor)
- **Local gate must pass before deploy**
- **Cron must be silent for Radar/OB during the entire phase**

---

## Section 5 — Two-Keys-to-Fire Procedures

### Commit 6 — SpikeCard surgical exception

1. Prepare the edit locally, do NOT commit
2. Run `git diff` against the two affected files, paste the unified diff in chat
3. Report metrics: lines deleted (expected ~13), lines added (must be 0), lines modified (must be 0), files touched (2), functions touched (SpikeCard only), imports remaining (all other imports byte-identical)
4. Ask: "SpikeCard surgical exception ready. Diff above shows N deletions, 0 additions, 0 modifications. Touches only line 7 + lines 84–90 in SpikeCard.tsx and lines 100–102 in types/index.ts. Reply 'apply' to commit, or tell me what to change."
5. Wait for explicit "apply"
6. Run `./scripts/phase1_verify.sh 6` after commit lands

### Commit 10 — Python source surgery

1. Prepare all strips and the deletion of `opening_bell_scanner.py`
2. Produce a per-file structured change report (line counts, function/class removals, import removals, functions verified untouched). Note: any specific line-count numbers shown in this protocol description (e.g., "344 lines deleted") are illustrative — the actual report will use the real numbers from the prepared diff.
3. Run import verification BEFORE asking for confirmation:
   - `python -c "import api_server"`
   - `python -c "import canadian_llm_council_brain"`
   - `python -c "import canadian_portfolio_interface"`
   - `python -c "import eodhd_news"`
   - `python -c "import fmp_bulk_cache"`
   - `python -m pytest tests/ -q --tb=no`
4. Show spot-check excerpts for the 4 largest removal blocks (RadarScanner class, OpeningBellScanner integration, api_server imports, render() signature change)
5. Ask: "Commit 10 Python surgery prepared. 6 files touched, 344 lines deleted, 0 added, 0 modified, 1 file removed. All 5 Python imports verified clean BEFORE asking for your approval. pytest passes. Spot-check excerpts shown above. Today's Spikes pipeline functions verified untouched by grep. Reply 'apply' to commit. Reply 'show me X' if you want to see any specific function or line range. Reply 'wait' or describe a change and I'll rework."
6. Wait for explicit "apply"
7. Run `./scripts/phase1_verify.sh 10` after commit lands

### Edge case rules

1. **Unexpected reference found mid-strip** → STOP, do not commit, report the file:line, ask how to proceed
2. **User changes mind after "apply"** → `git revert HEAD` immediately, diagnose, re-prepare
3. **Verification gate fails after "apply"** → Playbook A (or C for Commit 10)
4. **Any change made that user did not see in diff/summary** → disclose immediately, `git revert HEAD`, re-run protocol
5. **User wants to add scope to a two-keys commit** → treat as a separate commit, not slipped-in

---

## Section 6 — Live Acceptance Test Plan

### T+0 acceptance — within 30 minutes of Commit 10 deploy

10 test groups, each with explicit URLs, commands, and pass/fail criteria. Phase 1 acceptance is granted only when ALL groups pass AND `phase1_db_parity.sh` exits 0.

#### Group 1 — Deploy sanity
- HTTPS server up (`curl -sI https://spiketrades.ca/`)
- All Docker containers healthy
- Recent deploy logs clean of unexpected errors

#### Group 2 — Today's Spikes (the thing that must NOT regress)
- Login flow works
- `/api/spikes` returns 10 picks WITHOUT `isRadarPick`/`isOpeningBellPick`/`radarScore` fields
- Dashboard renders 10 spike cards, no Radar/OB badges
- Spike detail page renders the recharts polygon chart (false-positive guard)
- Council brain callable, returns Today's Spikes data

#### Group 3 — Portfolio
- Portfolio API returns user's positions
- Historical entries that referenced Radar/OB picks still display
- Locking in a new Spike works end-to-end

#### Group 4 — Admin panel
- Admin council telemetry returns FMP-only health (no `radarStatus`/`radarHealth`/`radarAccuracy`/`openingBellStatus`/`openingBellHealth` keys)
- Admin page renders without Radar/OB sections, FMP-only Data Source Health column
- Manual council trigger works

#### Group 5 — Reports archive
- Reports page loads as single Spikes archive (no tab strip)
- Stale URL params (`?tab=opening-bell`, `?tab=radar`) resolve cleanly
- Deleted top-level pages (`/radar`, `/opening-bell`) return 404

#### Group 6 — Settings
- Settings page renders without OB/Radar toggles
- Preferences API does not modify the database `emailRadar` value when sent

#### Group 7 — Deleted routes return 404
- All 6 deleted API route URLs return 404

#### Group 8 — Cron silence + Today's Spikes still scheduled
- Cron logs show no Radar/OB scheduled jobs post-deploy
- Cron logs show Today's Spikes still scheduled

#### Group 9 — Database parity (the proof gate)
- `./scripts/phase1_snapshot.sh post`
- `./scripts/phase1_db_parity.sh` exits 0
- Manual spot-check of the 4 archived tables confirms identical row counts

#### Group 10 — Final grep on production
- No runtime Radar/OB references in deployed `src/`, `tests/`, root `*.py` (only schema, recharts, historical docs)

### T+24h observability

Lighter checks across the next 24 hours:
1. **O1** — Zero customer error reports related to Spikes/portfolio/dashboard/settings/admin
2. **O2** — Today's Spikes nightly cron ran successfully (~4:30 AM AST check)
3. **O3** — `/api/spikes` returns the new day's picks
4. **O4** — Zero Radar/OB-related errors in production logs (24h window)
5. **O5** — Database drift check at T+24h (only Spike/DailyReport/CouncilLog/PortfolioEntry may grow; the 4 archived + emailRadar/emailOpeningBell + FK-linked counts must be unchanged)
6. **O6** — Zero Radar/OB emails sent in the 24-hour window (Resend dashboard verification)

### Final Phase 1 sign-off

Phase 1 is COMPLETE when:
1. T+0 acceptance: all 10 groups pass
2. T+24h observability: all 6 checks pass
3. Database parity verified at T+0 AND T+24h
4. Final grep on deployed source returns only expected matches
5. No customer-impacting incidents in the 24-hour window

A Phase 1 Final Report is produced after sign-off, containing pre/post snapshots, every commit's diff, every verification gate output, two-keys-to-fire confirmation logs, any failures encountered, and the hand-off contract to Phase 2.

---

## Section 7 — Hand-off Contracts to Phases 2/3/4

### Phase 1 → Phase 2 contract (EODHD hybrid integration)

#### What Phase 2 inherits

**Codebase state:** All deletions and strips per Section 1 are complete. Python files import cleanly. No Radar/OB code path remains in any runtime file.

**Frontend invariants:**
- Sidebar nav contains only Today's Spikes related links
- `/reports` is a single-view Spikes archive
- `/admin` has Today's Spikes telemetry plus FMP-only Data Source Health
- `/settings` has no `emailRadar` or `emailOpeningBell` toggles
- `/dashboard` and `/dashboard/analysis/[id]` are byte-identical to Phase-1-start

**Backend invariants:**
- `/api/spikes` returns spike objects without `isRadarPick`/`isOpeningBellPick`/`radarScore` fields
- `/api/portfolio` lock-in path accepts only `spikeIds`
- `/api/accuracy/check` returns `{filled}` only
- `/api/admin/council` returns Today's Spikes status + FMP health only
- `/api/user/preferences` does not read or write `emailRadar` / `emailOpeningBell` fields

**Database invariants (the iron-clad guarantee):**
- All 4 archived tables exist with EXACT row counts from Phase 1 start, proven by `phase1_db_parity.sh` exit 0
- `User.emailRadar` and `User.emailOpeningBell` columns preserved
- `PortfolioEntry.openingBellPickId` and `PortfolioEntry.radarPickId` columns preserved
- Prisma schema for all 4 archived models, the 2 User email fields, and the 2 PortfolioEntry FK relations is byte-identical
- Zero new migrations added during Phase 1

**Operational invariants:**
- Cron container shows no Radar/OB scheduled triggers
- Today's Spikes nightly cron still fires
- No Radar/OB emails sent during the entire Phase 1 window
- All deployed Docker containers healthy

#### What Phase 2 may freely change
Add new files, new fields to `User` (e.g., `emailEodhd`), new tables for EODHD caching, new tailwind tokens, modify the admin Data Source Health panel to add an EODHD column, modify the council brain to call EODHD as a second source, add EODHD passthrough endpoints, add EODHD-related cron jobs, modify the Today's Spikes scanner to apply the freshness gate.

#### What Phase 2 must NOT change
- `SpikeCard.tsx` remains protected (only the Phase 1 Commit 6 surgical exception is grandfathered)
- The 4 archived database tables remain untouched
- `User.emailRadar` and `User.emailOpeningBell` columns remain in the schema
- The Today's Spikes scoring algorithm itself (Phase 4 territory)
- The learning loop tables (Phase 3 territory)

#### Open work explicitly handed to Phase 2
1. **FMP quote-freshness gate** — fix the NGD.TO bug class
2. **News + sentiment migration** — decide between EODHD-only, parallel, or fallback
3. **Data Source Health panel** — add the EODHD column
4. **Two-source freshness oracle** — when FMP and EODHD disagree, that disagreement IS the freshness signal
5. **Cost / rate-limit accounting** — instrument EODHD's 100K calls/day and 1000/min limits

#### Phase 1 deliverables Phase 2 can reference
- This spec
- The Phase 1 implementation plan (created next)
- The Phase 1 Final Report
- The 3 verification scripts as templates for Phase 2's own scripts
- The pre/post/t24h snapshot files as the baseline reference

### Phase 1 → Phase 3 contract (Learning Loop forensic audit and repair)

#### What Phase 3 inherits

**Database state — exactly as it was at Phase 1 start:**
- The 198-resolved-rows / 24-missing-rows state in `accuracy_records`
- The 222 rows in `calibration_base_rates`
- The 28 rows in `calibration_council`
- The 339 rows in `stage_scores`
- The 120 rows in `pick_history`
- The exact list of 24 picks with no `accuracy_records` row (the bug discovered on 2026-04-07)
- All Postgres `Spike` table rows with their `historicalConfidence`, `calibrationSamples`, `overconfidenceFlag` values

**Codebase state:**
- The `/api/accuracy/check` route is intact (Phase 1 only stripped the OB+Radar branches)
- The council brain's calibration logic is intact (`apply_calibration`, `run_historical_backtest`, `build_council_calibration` untouched, verified by Section 5 grep)
- All bucket helper functions intact

#### What Phase 3 may freely change
The accuracy backfill cron logic, the calibration tables (with two-keys-to-fire), the learning gate threshold logic, the admin learning panel display, new tables for statistical relevance metrics, new tables for bias detection, new tables for an audit log.

#### What Phase 3 must NOT change
- The Today's Spikes scoring algorithm (Phase 4)
- The 4 archived Radar/OB tables
- `SpikeCard.tsx`
- The EODHD integration from Phase 2 (consume only)

#### Open work explicitly handed to Phase 3
1. **The 24 missing accuracy_records bug** — find why ~30–40% of picks are silently dropped at creation time, fix it, backfill safely
2. **`calibration_council` under-population** — investigate why only 28 rows
3. **Statistical relevance metrics** — sample size per bucket, confidence intervals, variance, drift over time
4. **Bias detection** — non-random pattern monitoring
5. **Audit log table** — every learning-table modification writes a forensic trail
6. **The "198 stuck" symptom** — admin telemetry that makes stagnation visible

#### Hard rule enforcement for Phase 3
The unconditional-delete hard rule from `feedback_no_unconditional_delete.md` is especially relevant: any `DELETE FROM <learning_table>` MUST have a `WHERE` clause and MUST go through two-keys-to-fire confirmation. The Session 10 incident is the exact failure mode Phase 3 is repairing.

### Phase 1 → Phase 4 contract (Today's Spikes refinements)

#### What Phase 4 inherits
A clean codebase with only Today's Spikes. Pipeline byte-identical to Phase-1-start. Freshness gate from Phase 2 in place. Learning loop healed by Phase 3. Spike type definition cleaned.

#### What Phase 4 may freely change
Scoring algorithm (`spike-score.ts` + Python council brain consensus), ranking logic (the 15-pt gap problem), UI presentation (`SpikeCard.tsx` may need badges/indicators), predictions display, confidence calibration UI.

#### Specific open work explicitly handed to Phase 4
1. **The ranking divergence problem** — ARIS.TO #1 (spikeScore 84.73, conviction 6) vs CJ.TO #7 (spikeScore 69.48, conviction 7). Decide tie-breaker, conviction multiplier, display badge, or full re-ranking
2. **The `convictionScore` mislabeling** — field is `best_stage.get("conviction", 0)`, not deeper Council judgment. Rename or change semantics
3. **`SpikeCard.tsx` protection** — Phase 4 must explicitly decide whether to lift the protection (recommendation: lift it for Phase 4 with two-keys-to-fire on every edit)
4. **Scoring algorithm refinements** — 12-factor weight tuning, regime adjustments, new factors
5. **Anything Phase 3's audit reveals** as needing scoring/algorithm changes

### Things that survive ALL phases

1. The 4 archived database tables exist forever unless explicitly authorized
2. `User.emailRadar` and `User.emailOpeningBell` columns exist forever unless explicitly authorized
3. Two-keys-to-fire applies to any destructive operation for the entire project lifetime
4. No `DELETE FROM <table>` without `WHERE`, ever
5. Daily Postgres backup at 07:00 UTC continues running
6. Daily integrity check on row-count thresholds continues running
7. Today's Spikes is the only product — anything that competes with that focus needs a new spec
8. Spec → plan → execute → verify → final report is the workflow for every change of meaningful size

### Sign-off and transition protocol

When Phase 1's T+24h observability passes:
1. Produce the Phase 1 Final Report at `docs/superpowers/reports/<YYYY-MM-DD>-phase-1-final-report.md` where `<YYYY-MM-DD>` is the date of T+24h sign-off (the day Phase 1 is officially declared complete, not the day Phase 1 started)
2. Final report contains: pre+post snapshots, every commit's diff, every verification gate output, two-keys-to-fire confirmation logs for Commits 6 and 10, any failures + resolutions, explicit "Phase 1 ACCEPTED" stamp
3. Commit and push the final report
4. Update `.claude/memory/` with `project_phase1_complete.md`
5. Recommend a fresh session for Phase 2 brainstorming, with this spec + the Phase 1 final report as input
6. **Phase 2 cannot start until Steve gives the explicit go signal** — even if T+24h passes, the transition is a manual call

---

## Appendix A — Inventory verification snapshot

Captured 2026-04-07 during the brainstorm. Per-file ref counts that drove Section 1's manifest:

**TS/TSX in `src/` (34 files):** see Section 1 in-scope list. Notable counts: `api/admin/council/route.ts` (51), `admin/page.tsx` (41), `reports/page.tsx` (40), `portfolio/route.ts` (35), `accuracy/check/route.ts` (32), `app/radar/page.tsx` (31), `lib/opening-bell-analyzer.ts` (30), `lib/radar-analyzer.ts` (26).

**Python (9 files):** `api_server.py` (124), `canadian_llm_council_brain.py` (72), `tests/test_opening_bell_integration.py` (25), `tests/test_opening_bell_scanner.py` (24), `opening_bell_scanner.py` (19), `tests/test_radar_scanner.py` (9), `canadian_portfolio_interface.py` (6), `eodhd_news.py` (1), `fmp_bulk_cache.py` (1).

**Config / scripts:** `scripts/start-cron.ts` (6), `tailwind.config.ts` (3).

**Total runtime files touched:** ~55. Total documentation/historical files preserved (not touched): ~15.

**False positive ruled out:** `src/app/dashboard/analysis/[id]/page.tsx` — 8 "radar" references are recharts library imports, NOT Smart Money Radar.

---

## Appendix B — Decision history

All decisions made via AskUserQuestion confirmations during the brainstorm:

1. **Decomposition:** 4 sequential sub-projects in order (Removal → EODHD hybrid → Learning Loop audit → Spikes refinements)
2. **Data strategy:** Pure code-only removal — DB and Prisma schema 100% untouched
3. **Historical UI:** Full UI removal — no read-only history views
4. **Email subscribers:** Silent stop — no farewell, no banner
5. **Freshness gate:** Deferred to Phase 2 (architecturally correct home for cross-source validation)
6. **Removal strategy:** Bottom-up layered commits
7. **Data Source Health panel:** Keep, FMP-only column (Phase 2 adds EODHD)
8. **SpikeCard exception:** One-time surgical exception, ~10 lines, diff shown before applying
