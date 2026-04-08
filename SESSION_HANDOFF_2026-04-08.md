# Session Handoff — 2026-04-08

> **Purpose:** Persistent record of where this session ended and what is queued for future sessions. Read this first when resuming.

---

## TL;DR

- **Phase 1** (Radar + Opening Bell removal): code-surgery complete, deployed, T+0 acceptance passed. Task 12 (T+24h sign-off) waits for Thursday ~02:00 UTC.
- **Learning Engine bypass**: deployed live. Stage weights restored to intended `{0.15, 0.20, 0.30, 0.35}`. Council brain ready for Wednesday's 13:45 UTC cron fire.
- **Admin panel Learning tab**: hollowed to a stub message; the misleading "Mechanism Activation Status" and "Current Stage Weights" displays are gone.
- **Audit findings** (Topics D, C, E1, E2, Historical Confidence): all documented in this session and in committed spec/plan docs. No further action requested by user.
- **Backlog of design work**: 16 queued items below. Next session likely starts with either Phase 1 Task 12 sign-off or Phase 2 Tier 1A brainstorm.
- **One outstanding ambiguity**: Topic A "User Tracking update" — user said "previously discussed" but no docs/memory/commits reference it. Must clarify next session.

---

## Production state at handoff

| Component | State | Notes |
|---|---|---|
| Production HEAD | `82e5cd1` | Merge commit of PR #4 (LE UI stub) |
| `app` container | `Up` (rebuilt 2026-04-08T03:20 UTC) | Serves new Learning tab stub |
| `council` container | `Up (healthy)` (rebuilt 2026-04-08T01:38 UTC) | Serves LE bypass code |
| `cron` container | `Up` (from initial Phase 1 deploy 2026-04-08T01:53 UTC) | Schedules: 10:45 ADT daily analysis, 16:30 ADT accuracy check, 16:35 ADT backfill-actuals, 15-min portfolio alerts |
| `db` container | `Up (healthy)` | Untouched, row counts match Phase 1 baseline modulo +2 PortfolioEntry from real user activity |
| Disk on production | 96 GB / 117 GB used (83%) | Build cache ~88 GB, can `docker builder prune` when convenient |
| `/learning-state` endpoint | Returns intended weights + bypassed_mechanisms field | Verified 2026-04-08 03:08 UTC |
| Phase 1 verification gate | `./scripts/phase1_verify.sh 10` passes locally | All 8 checks green |

### Phase 1 baseline (DO NOT touch — this is the parity reference)

`scripts/phase1_snapshot_pre.txt` (committed in `a6d7138`):
```
CouncilLog_total|14
DailyReport_total|13
OpeningBellPick_count|3
OpeningBellReport_count|1
PortfolioEntry_total|34
PortfolioEntry_with_obPick|0
PortfolioEntry_with_radarPick|0
RadarPick_count|20
RadarReport_count|2
Spike_total|121
User_emailOpeningBell_true|5
User_emailRadar_true|5
User_total|5
```

`scripts/phase1_snapshot_post.txt` (committed in `afaf7fb` on `worktree-phase-1-radar-ob-removal` branch only — never merged to main): byte-identical to pre except timestamp.

`scripts/phase1_snapshot_post_le_bypass.txt` (uncommitted local artifact, captured 2026-04-08 03:04 UTC): only delta is `PortfolioEntry_total: 34→36` from real user activity, archived FK columns still 0.

---

## What was completed in this session

### Phase 1 Tasks 0–11 (already done before this session's "Go" started)
Tasks 0–10 completed code surgery. Task 11 T+0 acceptance passed all 10 groups. See `docs/superpowers/specs/2026-04-07-phase-1-radar-ob-removal-design.md` and `docs/superpowers/plans/2026-04-07-phase-1-radar-ob-removal.md`.

### Production deploy (this session)
- Merged PR #1 `bd8b6b0` (Phase 1 commits)
- Hit Dockerfile.council build failure — discovered hardcoded `COPY opening_bell_scanner.py .` not caught by Task 10 plan
- Fixed in commit `d17e1ce` → PR #2 `79d4f83`
- Production rebuild + restart, all containers healthy
- Council brain `/health` returned valid JSON, FMP integration verified live via `/spike-it` direct curl test

### Topic D — Council pipeline post-Phase-1 static health audit
Static checks all green: no errors in container logs, container resources idle, last pre-deploy council run (2026-04-07 14:06 UTC) was nominal (consensus 72.572, 21 min processing). Static-only, full dynamic proof waits for Wed 13:45 UTC natural cron. **Documented in chat, not in a separate doc.**

### Topic C — Spike It Operation post-Phase-1 confirmation
Static + dynamic green. Production `/spike-it` endpoint responds correctly with Pydantic validation, FMP fetch path verified (got "Failed to fetch market data for ZZZZ.TO" — the right error for a fake ticker). Bonus: real user activity (+2 PortfolioEntry rows between 01:57 and 03:04 UTC) is independent runtime evidence Spike It is working in production. **Documented in chat.**

### Topic E1 — Learning Engine data volume + statistical significance
Found: 198 resolved accuracy records in `spike_trades_council.db`, dated 2026-03-20 to 2026-04-02 (~14 distinct run days). Hit rates 53.6% (3d) / 57.4% (5d) / 54.3% (8d) — **NOT statistically distinguishable from coin flip at 95% confidence**. Sample size needed for 5pp edge: ~400 per horizon (~1,200 total), currently at 16% of needed.

### Topic E2 — Learning Engine behavior audit
**Found a critical bug**: `LearningEngine.compute_stage_weights()` (line 3441 of `canadian_llm_council_brain.py`) has a SQL JOIN defect — the query returns identical rows for all 4 stage iterations, so normalized weights always collapse to `{0.25 × 4}` regardless of data. This has been silently underweighting Stage 4 by 10pp from the intended `{0.15, 0.20, 0.30, 0.35}` for ~10 days. `build_prompt_context()` (line 3482) has the same JOIN defect. Factor-Level Feedback dashboard has a separate mismatch (uses all-horizon count for gate check, actual function uses 3d-only).

### Learning Engine Conservative Bypass — DEPLOYED LIVE (PR #3)
Spec: `docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md`
Plan: `docs/superpowers/plans/2026-04-08-learning-engine-bypass.md`

5 edit sites across 2 files (commits `0d21f14`, `8eba6ef`, `c786a1c`, `cb77cca`):
- `canadian_llm_council_brain.py:2122` — replaced `compute_stage_weights()` call with hardcoded literal
- `canadian_llm_council_brain.py:2140` — added `"le_stage_weights_bypassed": True` to per-pick adjustments dict
- `canadian_llm_council_brain.py:1565, 1642, 1730, 1866` — replaced 4 `build_prompt_context()` calls with empty strings
- `canadian_llm_council_brain.py:4841` — replaced second `compute_stage_weights()` call (result_dict assembly)
- `api_server.py /learning-state` — added `bypassed_mechanisms` field

PR #3 merged as `f9208bd`. Council container rebuilt + restarted. Runtime verified via `/learning-state` returning intended weights + bypassed_mechanisms field.

The buggy functions are still in `canadian_llm_council_brain.py` untouched — only their call sites are bypassed. They are documented for future repair.

### LE UI Stub — DEPLOYED LIVE (PR #4)
Hollowed the Admin Panel Learning tab. Removed the misleading "Mechanism Activation Status" grid (which showed 7/8 mechanisms with green "Active" badges including the bypassed ones) and the "Current Stage Weights" cards. Replaced with a single static stub explaining the bypass.

Commit: `25d68be` → PR #4 merged as `82e5cd1`. App container rebuilt + restarted. Build artifact verified contains "Learning Engine — Bypassed" text.

Changes:
- `src/app/admin/page.tsx` — 1 file, 99 deletions, 37 insertions
- Removed: `learning` state, `setLearning` calls, `tab === 'learning'` data fetch branch, 2 display sections
- Kept: Tab type, tab strip button, `/api/admin/learning` route + Python `/learning-state` endpoint (still callable for direct debugging)

### Historical Confidence audit
Found via tracing: `historicalConfidence` is computed by `HistoricalCalibrationEngine.calibrate_picks()` (independent of LearningEngine, untouched by bypass), persisted to Postgres `Spike.historicalConfidence`, displayed on `SpikeCard.tsx` lines 152–168.

Live data (2026-04-07 picks): values cluster 49.7%–57.4%, sample sizes vary 19–628, 100% of picks flagged as overconfident. Mechanically working, statistically weak, display overstates precision. Connected to E1 finding — same noise floor problem from a different angle. **Documented in chat, no action requested by user yet.**

### Recommended rename: `Historical Confidence` → `Historical Hit Rate`
User asked "what would you name it" — recommended `Historical Hit Rate`. Cosmetic-only rename (TS + JSX, no DB column rename) requires ~5 file edits. **Queued, not implemented.**

### Phase 2 Tier 1A: Per-stock 6-month price-action profile
User asked "is there data from FMP/EODHD that could improve results — history of the stock in question, 6 month historic data". I confirmed: yes, the strongest immediate addition would be per-stock 6-month price-action statistics from FMP `/historical-price-full/{ticker}`. Would augment (not replace) the current bucket-based Historical Hit Rate. **Queued as Phase 2 Tier 1A. Needs full brainstorm → spec → plan cycle. Gated on Phase 1 close + Prisma column add.**

---

## What's pending — backlog ordered by my recommended priority

### A. Phase 1 close-out (highest priority — finishes existing work)

**A1. Phase 1 Task 12: T+24h observability + final sign-off**
- Earliest run window: Thursday 2026-04-09 ~02:00 UTC
- Needs: Wed 13:45 UTC cron to have fired + ~24h elapsed
- Steps: per `docs/superpowers/plans/2026-04-07-phase-1-radar-ob-removal.md` Task 12 (lines 2392+)
- Trigger: user says `run T+24h checks` or `run task 12`

**A2. LE bypass cron-fire verification**
- Earliest run window: Wednesday 2026-04-08 ~14:30 UTC (after the 13:45 UTC cron has had 45 min for the council pipeline to complete)
- Verification:
  ```bash
  ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'docker compose exec -T council python3 -c "
  import sqlite3, json
  conn = sqlite3.connect(\"/app/data/spike_trades_council.db\")
  for row in conn.execute(\"SELECT ticker, run_date, source FROM pick_history ORDER BY id DESC LIMIT 12\").fetchall():
      print(row)
  "'
  ```
  Confirm: most recent rows have `run_date >= 2026-04-08` and the council ran successfully on the bypass code. Then check the Postgres `Spike` table for the new picks and confirm they have `historicalConfidence` populated (proves the calibration engine still ran).
- Trigger: user says `verify wed cron` or just lumped into A1

**A3. afaf7fb post-snapshot commit cleanup (cosmetic)**
- The Phase 1 T+0 parity-proof snapshot (`scripts/phase1_snapshot_post.txt`) was committed only on the `worktree-phase-1-radar-ob-removal` branch as commit `afaf7fb`. It was never merged to main. The snapshot file is read by future Task 12 runs via `git show worktree-phase-1-radar-ob-removal:scripts/phase1_snapshot_post.txt` (which works) but the commit itself is orphaned from main.
- Resolution options: (a) cherry-pick to main via tiny PR, (b) ignore and let the snapshot file stay branch-only (it's just a record), (c) delete the branch after Task 12 closes
- Recommendation: cherry-pick to main during Phase 1 close-out so main has a complete record

### B. Phase 2 design backlog (highest priority NEW work)

**B1. Per-stock 6-month price-action profile (Tier 1A) — RECOMMENDED FIRST**
- Origin: this session, in response to user's question about FMP/EODHD data
- Concept: For each council pick, pull last ~130 trading days from FMP `/historical-price-full/{ticker}` and compute the stock's own 3d/5d/8d hit rate using rolling windows. Combine with current bucket-based Historical Hit Rate as a blended display (or two separate bars).
- Why first: Always-available data (every stock has price history), directly answers "what does THIS stock's history say" question, statistically validatable as data accumulates.
- Implementation cost: moderate
  - 1 new FMP endpoint call per pick (~10/run, trivial vs FMP quota)
  - New compute function in `canadian_llm_council_brain.py` (~50–100 lines)
  - New field in `api_server.py` mapped_spikes dict (~3 lines)
  - **New column in Prisma `Spike` model** ← THE BLOCKER, requires DB write
  - New rendering in `src/components/spikes/SpikeCard.tsx` (~10 lines)
- Gating: cannot start until Phase 1 Task 12 closes (no DB writes during observability window). Earliest start: Thursday 2026-04-09.
- Process: should go through full brainstorm → spec → plan → implement cycle. Not a hot patch.

**B2. Historical Confidence rename → Historical Hit Rate**
- Cosmetic-only TS+JSX rename, no DB column rename
- ~5 file edits: `src/types/index.ts`, `src/components/spikes/SpikeCard.tsx`, `src/app/api/spikes/route.ts`, `src/lib/scheduling/analyzer.ts`, `src/app/dashboard/analysis/[id]/page.tsx`
- Could land standalone OR bundled with B1 (since both touch the same field)
- Note: the visible label on SpikeCard line 135 currently shows "Council" not "Historical Confidence" — needs full UI label audit before commit

**B3. Historical Confidence display hardening**
- Suppress the historical confidence bar when `calibrationSamples < 100` (would hide it for ~8/10 picks today)
- OR show wider confidence intervals: `~53% (range 41–65, n=66)` instead of `57.4%`
- Demote the universal overconfidence flag (currently fires on 100% of picks, conveys no per-pick info)
- Likely bundled with B2

**B4. Tier 1B: Earnings cycle context**
- FMP `/earning_calendar/{ticker}` and `/historical/earning_calendar/{ticker}`
- Compute: days since last earnings, days until next earnings (already in earnings_flag), historical surprise %, post-earnings-drift window
- Add as new fields on Spike table

**B5. Tier 1C: Insider trading 6-month trend**
- FMP `/insider-trading/{ticker}` going back 180 days
- Compute: net dollar value, distinct insiders, recency-weighted score, filter routine option exercises
- Add as new fields on Spike table

**B6. Tier 2D: EODHD news sentiment trend**
- EODHD `/news` and `/sentiment` per pick
- 30/90/180-day article count + net sentiment trajectory + catalyst event detection
- Lower priority — sentiment scoring is noisy, validation is harder

**B7. Tier 2E: Enriched sector relative strength**
- Already partially captured by `sector_relative_strength`. Could add 30/60/90/180-day windows.
- Lower priority

### C. Learning Engine — full repair (when ready)

**C1. Rewrite `compute_stage_weights()` correctly**
- Use `stage_scores.predicted_direction` vs `accuracy_records.actual_direction` for per-stage accuracy
- Suggested correct query is in spec Appendix A: `docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md`
- Once fixed, can remove the bypass at `canadian_llm_council_brain.py:2122` and the result_dict bypass at line 4841

**C2. Rewrite `build_prompt_context()` correctly**
- Same per-stage correction
- Once fixed, can remove the 4 prompt_context bypasses at lines 1565/1642/1730/1866

**C3. Fix Factor-Level Feedback dashboard mismatch (E2 #3)**
- `LearningEngine.get_mechanism_states()` uses all-horizon count for the Factor Feedback gate check, but `compute_factor_weights()` filters on `horizon_days = 3` only
- Dashboard says "active" (198 ≥ 100) while function returns `None` (84 < 100)
- Fix: align dashboard query with compute query
- Low priority — no current user impact since UI is already hollowed

**C4. Raise Learning Engine activation gates**
- Per E1 finding: ~400 resolved picks per horizon needed for 5pp edge detection at 95% confidence
- Current gates (`GATE_STAGE_WEIGHTS=30`, `GATE_CONVICTION_THRESHOLDS=50`, `GATE_FACTOR_FEEDBACK=100`) are dangerously generous
- Reevaluate after data accumulates — at current rate ~15 resolved picks/day, this is 60–90 days out
- Don't act before data justifies it

### D. Operational hygiene — ✅ ALL CLOSED 2026-04-08

**D1. ✅ CLOSED — Pre-existing 2026-04-03 DailyReport gap**
- Resolution: NOT a bug. April 3, 2026 = Good Friday (Canadian stat holiday, TSX closed). The holiday-skip logic correctly suppressed the `DailyReport` write while `CouncilLog` row was still created (council brain ran but report write was correctly gated). Working as intended.
- Closed in same-day session 2026-04-08

**D2. ✅ CLOSED — Production build cache prune**
- Executed `docker builder prune -f` 2026-04-08 ~10:35 UTC
- Reclaimed 89.5 GB. Disk dropped from 80% (93G/117G used) to 9% (10G/117G used)
- Image cache also dropped from 87 GB to 4.2 GB (dangling images that were pinned by build cache)
- All 6 containers remained healthy through the operation
- Closed in same-day session 2026-04-08

### E. Topic A blocker — ✅ RESOLVED 2026-04-08

**E1. ✅ RESOLVED — "User Tracking update previously discussed"**
- User clarified: the admin Activity tab dashboard was showing nonsensical data (21h durations, 0s durations, "Active Today: 0"). Root cause: the dashboard tracked LOGIN EVENTS, not user activity.
- Resolution: User Activity Heartbeat feature designed, implemented, deployed via PR #7 (`8286a2d`) on 2026-04-08 ~12:00 UTC
- 60s visibility-gated client heartbeat → POST /api/activity/heartbeat → lazy session extend/rotate → COALESCE-aware admin query → 68 contaminated legacy rows scoped-deleted via `scripts/wipe_legacy_user_sessions.sql`
- T+0 verification confirmed: real heartbeat sessions created, `User.lastSeenAt` updates correctly
- Spec: `docs/superpowers/specs/2026-04-08-user-activity-heartbeat-design.md`
- Plan: `docs/superpowers/plans/2026-04-08-user-activity-heartbeat.md`
- Closed in same-day session 2026-04-08

---

## Files / SHAs / URLs reference

### Branches (live on origin)
| Branch | State | Tip |
|---|---|---|
| `main` | live | `82e5cd1` |
| `worktree-phase-1-radar-ob-removal` | merged via PR #1 + #2, plus orphan `afaf7fb` post-snapshot | `afaf7fb` |
| `fix/learning-engine-bypass` | merged via PR #3, kept | `cb77cca` |
| `fix/le-admin-tab-stub` | merged via PR #4, kept | `25d68be` |
| `docs/session-handoff-2026-04-08` | new this session | (this commit) |

### PRs
- #1 Phase 1 Radar/OB removal — merged `bd8b6b0` (2026-04-08 01:34 UTC)
- #2 Dockerfile.council fix — merged `79d4f83` (2026-04-08 ~01:38 UTC)
- #3 Learning Engine conservative bypass — merged `f9208bd` (2026-04-08 03:00 UTC)
- #4 Admin Learning tab hollow stub — merged `82e5cd1` (2026-04-08 03:14 UTC)

### Spec / plan docs
- `docs/superpowers/specs/2026-04-07-phase-1-radar-ob-removal-design.md`
- `docs/superpowers/plans/2026-04-07-phase-1-radar-ob-removal.md`
- `docs/superpowers/plans/2026-04-07-phase-1-delta-notes.md`
- `docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md` (committed `a9b1847`, revised `57d8cda`)
- `docs/superpowers/plans/2026-04-08-learning-engine-bypass.md` (committed `22ad0dc`)
- This handoff: `SESSION_HANDOFF_2026-04-08.md`

### Phase 1 verification scripts (always usable)
- `scripts/phase1_snapshot.sh [pre|post|t24h|<label>]` — captures DB row counts via SSH+psql
- `scripts/phase1_verify.sh <commit_number>` — per-commit verification gate (build + commit-specific stringency)
- `scripts/phase1_db_parity.sh` — diffs `phase1_snapshot_pre.txt` against `phase1_snapshot_post.txt`, hardcoded paths

### Production access
- SSH: `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
- App path: `/opt/spike-trades`
- Council brain endpoint: `http://localhost:8100` (inside container — only accessible via SSH)
- Public URL: `https://spiketrades.ca`
- Council brain SQLite: `/app/data/spike_trades_council.db` (inside `council` container)
- Postgres: `docker compose exec db psql -U spiketrades -d spiketrades`

### Key file references (post-Phase-1, post-LE-bypass)
- `canadian_llm_council_brain.py:2122` — bypass site for stage weights (hot path)
- `canadian_llm_council_brain.py:2140` — `le_stage_weights_bypassed` flag added here
- `canadian_llm_council_brain.py:1565, 1642, 1730, 1866` — bypass sites for build_prompt_context
- `canadian_llm_council_brain.py:4841` — bypass site for stage weights (result_dict)
- `canadian_llm_council_brain.py:3441` — `compute_stage_weights()` definition (still buggy, no longer called)
- `canadian_llm_council_brain.py:3482` — `build_prompt_context()` definition (still buggy, no longer called)
- `canadian_llm_council_brain.py:2941` — `HistoricalCalibrationEngine` class (independent of LE, untouched)
- `api_server.py:311` — `historicalConfidence` mapping site
- `api_server.py:368` — `SpikeItRequest` Pydantic model (working)
- `api_server.py:406-433` — `/learning-state` endpoint (now returns `bypassed_mechanisms`)
- `src/app/admin/page.tsx:1209` — Learning tab stub block
- `src/components/spikes/SpikeCard.tsx:152-168` — historicalConfidence display (current state)

---

## Open questions for user (next session)

1. **Topic A clarification**: What does "User Tracking update previously discussed" mean? Cannot find any reference to it.
2. **Phase 1 Task 12 timing**: When do you want me to run the T+24h observability checks? Earliest is Thursday ~02:00 UTC.
3. **Phase 2 sequence**: Once Phase 1 closes, do you want me to start the Tier 1A brainstorm immediately, or pause for your direction?
4. **Historical Confidence rename**: Want me to land the cosmetic-only rename (B2) as a standalone PR, or bundle it with the per-stock 6-month profile work (B1)?
5. **`afaf7fb` cleanup**: cherry-pick to main, or leave as orphan branch record?

---

## How to resume next session

1. Read this file first.
2. Check production state with one command: `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && git log --oneline -3 && docker compose ps'`
3. Read the in-flight todo list (will have been re-created from this file or from memory)
4. Confirm Phase 1 + LE bypass are still live: `curl -s https://spiketrades.ca/admin -I` (expect 307→login) and SSH `curl -s http://localhost:8100/learning-state | jq .bypassed_mechanisms`
5. Ask user which queued item to start with, or what they want to do.

The first action of the next session should be to RE-VERIFY production HEAD and the LE bypass state, because production state may have drifted (other deploys, rebuilds, container restarts) between sessions.
