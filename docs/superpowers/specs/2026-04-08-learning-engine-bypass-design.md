# Learning Engine Conservative Bypass — Design

**Status:** Approved for implementation
**Date:** 2026-04-08
**Author:** Steve + Claude (brainstorm transcript: Session 13 follow-up, post-Phase-1 audit pass)
**Related work:** Post-Phase-1 audit of Council pipeline health, Spike It operation, and Learning Engine statistical significance. Follow-up to `2026-03-29-learning-engine-core` and `2026-03-29-learning-admin-panel`.

---

## Context

The post-Phase-1 audit of the Learning Engine surfaced a confirmed, latent bug in `LearningEngine.compute_stage_weights()` (`canadian_llm_council_brain.py:3441`). The function's SQL query joins `accuracy_records → pick_history → stage_scores` but filters only on stage number, while the accuracy metric it reads (`ar.accurate`) is pick-level, not stage-level. The same result set is returned for all four stage iterations, so `hit_rates[1] = hit_rates[2] = hit_rates[3] = hit_rates[4]`, and the normalized weights always collapse to `{1: 0.25, 2: 0.25, 3: 0.25, 4: 0.25}` regardless of actual data.

This has been the case since the Learning Engine Core was deployed on 2026-03-29 (~10 days of council runs). Every council run in that window has used uniform stage weights instead of the intended `{1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}` defaults, silently underweighting Stage 4 (the Opus-4.6 final synthesis) by 10 percentage points relative to design.

`build_prompt_context()` (line 3482) has the same JOIN defect. Each stage's LLM receives a "RECENT PERFORMANCE FEEDBACK" paragraph claiming "your stage N picks had X% accuracy" — but X is pick-level and identical across all four stages. The "your" pronoun is misleading.

A third, smaller issue: the `/learning-state` endpoint reports "Factor-Level Feedback" as active when total resolved accuracy records (all horizons) meets the gate of 100, but the actual `compute_factor_weights()` function filters on `horizon_days = 3` only and has ~84 matching rows — so the mechanism silently returns `None` even though the admin dashboard claims it is active.

A parallel statistical-significance concern (E1 findings): across the 198 resolved accuracy records currently in SQLite, the council's directional hit rate at every horizon (3d: 53.6%, 5d: 57.4%, 8d: 54.3%) is **not statistically distinguishable from a coin flip** at 95% confidence. Even with the code bugs fixed, the Learning Engine's sample sizes are too small for its gate thresholds (30 per stage, 50 total, 100 total) to support reliable learning.

The user explicitly chose the **conservative bypass** path: smallest possible change to stop the confirmed bug's effect on council output, with no attempt to fix the underlying functions and no attempt to redesign the Learning Engine. Other mechanisms that are structurally correct but noisy (sector multiplier, disagreement adjustment, conviction thresholds) stay active.

---

## Section 1 — Goal and Non-Goals

### Goal

Restore the council's intended stage-weight distribution `{1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}` on the next and subsequent council runs by bypassing the confirmed-buggy `compute_stage_weights()` call. Simultaneously silence the structurally-defective `build_prompt_context()` by forcing it to return empty strings at all four call sites. Surface the bypass state honestly in the admin dashboard so users can see which mechanisms are active vs bypassed.

### In scope

1. **`canadian_llm_council_brain.py:2122`** — replace the `compute_stage_weights()` call in `_build_consensus` with the hardcoded `{1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}` dict. This is the hot-path fix that actually changes scoring. Add a comment referencing this spec.
2. **`canadian_llm_council_brain.py:2140`** — extend the per-pick `adjustments` dict to include `"le_stage_weights_bypassed": True` so downstream consumers and logs can tell this pick ran under the bypass.
3. **`canadian_llm_council_brain.py:1565, 1642, 1730, 1866`** — replace the four `build_prompt_context()` call sites with empty-string literals. Add comments referencing this spec.
4. **`canadian_llm_council_brain.py:4830`** — replace the second `compute_stage_weights()` call (which assembles `result_dict["stage_weights_used"]` for dashboard/output visibility) with the same hardcoded `{1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}` dict. Without this fix, the admin dashboard would continue to display the buggy uniform weights even while the actual scoring uses the correct ones — creating a confusing internal inconsistency. Added during plan-writing self-review after discovering this second call site during exact-line verification.
5. **`api_server.py` `/learning-state` endpoint (lines 406–421)** — extend the response JSON with a `"bypassed_mechanisms"` field listing `["Dynamic Stage Weights", "Prompt Accuracy Context"]`.

### Not in scope

- **The buggy functions themselves.** `compute_stage_weights()` and `build_prompt_context()` stay in the file, structurally unchanged. They are no longer called from the hot path, but the code remains for future repair.
- **The other Learning Engine mechanisms.** `compute_sector_multiplier()`, `compute_disagreement_adjustment()`, `compute_conviction_thresholds()`, `compute_factor_weights()`, and `compute_prefilter_adjustments()` are untouched. They will continue to run on every council run.
- **The gate thresholds.** `GATE_STAGE_WEIGHTS = 30`, `GATE_PROMPT_CONTEXT = 10`, etc. stay at their current values.
- **The SQLite learning DB.** No schema changes. No data migration. No DELETE statements.
- **The admin panel UI.** The `/learning-state` endpoint returns the new `bypassed_mechanisms` field, but visual treatment in `src/app/admin/page.tsx` is deferred to a follow-up commit. Users querying the API will see the bypass state; users looking at the UI will still see the old "active/inactive" indicators until the UI is updated.
- **The Factor-Level Feedback dashboard-vs-reality mismatch (E2 finding #3).** Known and documented, not fixed in this bypass.
- **The statistical significance concern (E1 finding).** The Learning Engine's gates remain generous. Future work required.
- **Prisma schema, Postgres state, Next.js build, tests, documentation outside this file.** Zero collateral touches.

### Explicitly preserved (zero-touch list)

- `prisma/schema.prisma`
- `spike_trades_council.db` SQLite file (no DDL, no DML)
- `pick_history` row format (except the new optional `adjustments.le_stage_weights_bypassed` boolean)
- All existing Council API contracts (`/run-council`, `/run-council-status`, `/spike-it`, `/health`, etc.)
- All Next.js API routes
- All Next.js frontend pages including the admin panel UI
- All tests

---

## Section 2 — Architecture

### Call-site bypass pattern

The Learning Engine is wired into `_build_consensus()` as an optional positional argument. When present, its methods are called at specific points to compute adjustments; when absent, hardcoded fallbacks are used. The bypass replaces the "present" branch of each affected call site with the fallback literal, leaving the "absent" branch unchanged.

This means:
- The `LearningEngine` class is still instantiated at `CanadianStockCouncilBrain.__init__()` line 4175.
- The `learning_engine` object is still passed as a kwarg into every stage function and `_build_consensus`.
- Methods that are NOT bypassed (`compute_sector_multiplier`, `compute_disagreement_adjustment`, `compute_conviction_thresholds`) continue to be called with the live `learning_engine` object.
- Only the `compute_stage_weights()` and `build_prompt_context()` calls are replaced with literals.

### Admin dashboard transparency

The `/learning-state` endpoint returns the existing `mechanisms` array (which now still claims "Dynamic Stage Weights" and "Prompt Accuracy Context" are active, because the gate queries haven't changed and the underlying row counts are unchanged). To avoid lying to admins, a new top-level `bypassed_mechanisms` field lists the two mechanism names that are no longer in use regardless of their reported active state.

API consumers (including the current Next.js admin page and any future UI work) can filter or annotate the mechanism list using this new field.

### No persistence changes

The bypass leaves all SQLite learning tables untouched. Future council runs will continue writing to `pick_history`, `accuracy_records`, and `stage_scores` exactly as before. The only difference in row content is that `pick_history.adjustments` (stored as JSON) will include the new `le_stage_weights_bypassed: true` flag. This is an additive field; existing consumers that do not look for it are unaffected.

---

## Section 3 — Testing & Verification

### Local

1. `python3 -m py_compile canadian_llm_council_brain.py api_server.py` — must exit 0.
2. `./scripts/phase1_verify.sh 10` — must exit 0 with all checks passing. This re-runs the full Phase 1 commit-10 gate which includes Python syntax, the build check, and the "no Radar/OB refs" grep.

### Post-deploy (production)

3. SSH to `147.182.150.30`, rebuild the `council` Docker image only, restart it.
4. Confirm the council container comes up `(healthy)` per `docker compose ps`.
5. Hit `GET http://localhost:8100/health` — must return `status: ok`, `council_running: false`.
6. Hit `GET http://localhost:8100/learning-state` — must include `bypassed_mechanisms: ["Dynamic Stage Weights", "Prompt Accuracy Context"]`.
7. Optionally (if time permits): wait for Wednesday 2026-04-08 10:45 ADT (13:45 UTC) natural cron fire. After the run completes, inspect the latest `pick_history` row's `adjustments` JSON — must contain `"le_stage_weights_bypassed": true` and `"stage_weights": {"1": 0.15, "2": 0.20, "3": 0.30, "4": 0.35}`.

### Database parity

8. Run `./scripts/phase1_snapshot.sh post_le_bypass` **immediately after the deploy completes and before the next natural council cron fires**. Then run `./scripts/phase1_db_parity.sh` to diff against `scripts/phase1_snapshot_post.txt` from Task 11. Parity must hold at that point — this bypass's code change does not write any database rows, so row counts must be byte-identical. (Once Wednesday's 13:45 UTC council cron fires, `CouncilLog_total`, `DailyReport_total`, and `Spike_total` will legitimately increase. That drift is expected production behavior from a successful council run and is Task 12's concern, not this bypass's concern.)

### What's being traded off

- The bypass ships during the Phase 1 T+24h observability window that is still in progress. Task 12's sign-off needs to account for the bypass as a separate variable. Mitigation: the bypass is a distinct commit on a distinct branch, and its behavior is isolated from Phase 1's code changes.

---

## Section 4 — Rollback

### Hot rollback

Single `git revert` of the PR merge commit on `main`, push to `main`, pull on production, rebuild the `council` Docker image, restart the `council` container. Same steps as the forward deploy, in reverse. If the bypass PR was merged with a merge commit (not squash), the revert targets that single merge SHA. If it was squashed, the revert targets the single squash commit. Either way it's one `git revert` + one `git push`.

### Verification after rollback

- `/learning-state` no longer has the `bypassed_mechanisms` field.
- Next council run's `pick_history.adjustments` does NOT contain `le_stage_weights_bypassed`.
- Stage weights used revert to `{0.25, 0.25, 0.25, 0.25}` (the buggy state we're rolling back to).

### Why rollback may be needed

- If Wednesday's council run produces materially different pick quality that the user judges worse (subjective, hard to measure in a single day).
- If the bypass introduces a Python syntax error that py_compile missed. (Extremely unlikely given the change is additive literals and comments.)
- If the new `adjustments.le_stage_weights_bypassed` field breaks a downstream consumer. (There should be no such consumer — the adjustments dict is write-only from `_build_consensus` and read-only for display.)

### What rollback does NOT restore

- If the bypass is rolled back, the buggy stage weights behavior returns. Rollback is always worse than staying deployed unless there's a concrete regression signal.

---

## Section 5 — Follow-ups (not part of this commit)

These are documented here so the bypass does not become a permanent workaround:

1. **Rewrite `compute_stage_weights()` correctly** to use `stage_scores.predicted_direction` vs `accuracy_records.actual_direction` for per-stage accuracy. This requires designing a test fixture and ensuring the per-stage prediction is actually being recorded (it is — the schema has the column).
2. **Rewrite `build_prompt_context()`** with the same per-stage correction.
3. **Fix the Factor-Level Feedback dashboard query** to filter on `horizon_days = 3` so the dashboard matches what `compute_factor_weights()` actually runs.
4. **Reevaluate `compute_disagreement_adjustment()`** logic — the pick-level accuracy metric doesn't cleanly map to per-stage prediction correctness, so the "which stage was right in disagreements" learning signal is muddled. Not a code bug but a design question.
5. **Raise the Learning Engine activation gates** to levels where statistical significance can be claimed honestly. Per E1 analysis: ~400 resolved picks per horizon to detect a 5pp edge at 95% confidence. Current: ~66/horizon average.
6. **Admin panel UI update** to render `bypassed_mechanisms` as a visible warning/flag next to the mechanism list.
7. **Decide whether the Learning Engine is worth the maintenance cost at current data volumes** or whether it should be dormant until ~90 days of data accumulates.

Items 1–5 are independent fixes. Item 6 is UI-only. Item 7 is a product decision.

---

## Section 6 — Risk assessment

### Blast radius

- Scope: one Python file for logic (`canadian_llm_council_brain.py`), one Python file for API surface (`api_server.py`).
- Data: Council output scores shift. Stage 4 regains its 10pp weight from the current buggy 25% back to the intended 35%. Picks where Stage 4 scored higher than other stages (the common case for "heavy" council picks) will score marginally higher after this change. Top-10 pick list may reorder slightly.
- Infrastructure: one Docker image rebuild (`council`), one container restart.
- Users: no user-facing UI changes. No data loss. No session invalidation.

### What could go wrong

1. **The hardcoded `{0.15, 0.20, 0.30, 0.35}` may not be optimal.** It's the pre-Learning-Engine design default, which is what Sessions 1–12 ran on. It has known working behavior but is not provably optimal for current market conditions. *Mitigation:* same values the system ran on for ~60 days before the Learning Engine was added. This is a known-working state.

2. **Dropping prompt_context may reduce LLM quality.** The current context text was supposed to provide learning feedback to each stage. Removing it means stages run without that feedback paragraph. *Mitigation:* the feedback was broken (all stages saw the same identical text), so its learning value was near zero. Removing it is net neutral or mildly positive. The LLMs still have all their other context (sector data, technicals, payload, etc.).

3. **Downstream consumers of `adjustments` may not expect the new `le_stage_weights_bypassed` field.** *Mitigation:* the `adjustments` dict is persisted as JSON and read only by display code. Adding a boolean field is additive and backward-compatible.

4. **Timing collision with Phase 1 Task 12 T+24h observability.** Deploying during the observability window introduces a confounding variable. *Mitigation:* this bypass is a distinct commit tied to a distinct spec, with its own verification plan. Task 12's observability checks (customer reports, cron fire confirmation, database parity) are independent of the stage-weight computation and are not compromised by the bypass.

### What definitely will not go wrong

- No database writes at deploy time.
- No schema changes.
- No API contract changes (response shapes are additive-only).
- No Next.js build changes.
- No tests affected.
- No Prisma changes.
- No cron schedule changes.
- No user session invalidation.

---

## Appendix A — The confirmed bug, spelled out

For future maintainers: `compute_stage_weights()` at `canadian_llm_council_brain.py:3441` reads:

```python
for stage in [1, 2, 3, 4]:
    rows = conn.execute(
        "SELECT ar.accurate FROM accuracy_records ar "
        "JOIN pick_history ph ON ar.pick_id = ph.id "
        "JOIN stage_scores ss ON ss.pick_id = ph.id AND ss.stage = ? "
        "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
        "AND ph.run_date >= date('now', ?)",
        (stage, f'-{self.STAGE_WEIGHT_WINDOW_DAYS} days')
    ).fetchall()
    if len(rows) < self.GATE_STAGE_WEIGHTS:
        return DEFAULT
    hit_rates[stage] = sum(r[0] for r in rows) / len(rows)
```

The `JOIN stage_scores ss ON ss.pick_id = ph.id AND ss.stage = ?` filter requires that stage N has a row in `stage_scores` for the pick. But every pick has rows for all four stages (the council always runs all four), so this filter does not actually exclude any picks. Every iteration of the outer `for stage` loop returns the same set of rows. `hit_rates` ends up with four identical values, and after normalization (`weights[s] = r/total`), the weights are all `1/4 = 0.25`.

The intended per-stage metric is **"how often was this specific stage's prediction correct?"** The schema supports it — `stage_scores.predicted_direction` and `stage_scores.predicted_move_pct` are stored per stage — but the query ignores them and uses `ar.accurate` (the pick-level outcome) instead.

A correct rewrite would be approximately:

```python
for stage in [1, 2, 3, 4]:
    rows = conn.execute(
        "SELECT ss.predicted_direction, ar.actual_direction "
        "FROM stage_scores ss "
        "JOIN pick_history ph ON ss.pick_id = ph.id "
        "JOIN accuracy_records ar ON ar.pick_id = ph.id AND ar.horizon_days = 3 "
        "WHERE ss.stage = ? AND ar.accurate IS NOT NULL "
        "AND ph.run_date >= date('now', ?)",
        (stage, f'-{self.STAGE_WEIGHT_WINDOW_DAYS} days')
    ).fetchall()
    if len(rows) < self.GATE_STAGE_WEIGHTS:
        return DEFAULT
    correct = sum(1 for r in rows if r[0] == r[1])
    hit_rates[stage] = correct / len(rows)
```

This correct version is not implemented as part of this bypass. It is documented here for the follow-up work listed in Section 5.

---

## Appendix B — The E1 statistical-significance numbers

For context on why the Learning Engine is not just buggy but also operating on underpowered data:

| Horizon | Resolved n | Hit rate | 95% CI under null | Significant? |
|---|---|---|---|---|
| 3-day | 84 | 53.6% | [39.3%, 60.7%] | No |
| 5-day | 68 | 57.4% | [38.1%, 61.9%] | No |
| 8-day | 46 | 54.3% | [35.5%, 64.5%] | No |
| Pooled | 198 | 55.1% | [42.8%, 57.2%] | No |

None of the observed hit rates are statistically distinguishable from a coin flip at 95% confidence. The data is directionally positive (55%-ish) but the sample sizes are too small to call the lean "real".

Sample size needed to detect a 5pp edge (55% vs 50%) at 95% confidence: ~400 resolved picks per horizon (~1,200 total). Current rate of resolution is ~15 picks per day, so ~90 days from now at current accumulation rate.

This is the deeper reason the bypass is the right choice: even if the bugs were fixed, the Learning Engine's output would remain within the noise floor for another 2–3 months.
