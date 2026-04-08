# Sibling B: Parallel Council Refactor + Hybrid FMP/EODHD + Dual-Listing Enrichment

**PR title:** `feat: Sibling B parallel council refactor + hybrid FMP/EODHD + dual-listing`

**Branch:** `feat/sibling-b-parallel-council`
**Base:** `main` (at `dc2cef0` — post-ADV Slider)
**HEAD commit:** `5ca0ab3`
**Commits ahead of main:** 9
**Author:** `Steven Weagle <steve@boomerang.energy>`

> **⚠️ Do not auto-merge.** This is the highest-risk refactor in the Sibling
> B series. Requires human review and explicit "go" before merge. The final
> validation is tomorrow morning's 10:45 AST council run (T+1).

## Summary

Implements all 12 tasks of the Sibling B Parallel Council Refactor spec per
`docs/superpowers/specs/2026-04-08-sibling-b-parallel-council-refactor-design.md`.

**The four headline changes:**

1. **Parallel Stages 1+2 via `asyncio.wait`** — Sonnet and Gemini now score
   the full ~120-ticker liquid universe independently and concurrently under
   a single shared 600s wall-clock cap. Eliminates the Stage 1 timeout
   failure mode (when Sonnet got stuck on the full universe, Gemini had
   nothing to merge — now either stage can rescue a run).
2. **Hybrid FMP + EODHD fetch layer with cross-compare** — EODHD enrichment
   runs in parallel with the existing FMP enhanced-signals fetch. A new
   cross-compare step produces per-ticker `DataQualityFlags` that detects
   ghost stocks (tickers present in one source but missing in the other).
3. **Dual-listing Tier 2 enrichment** — for the ~33 TSX tickers that are
   also listed on NYSE/NASDAQ/NYSE American, the US 13F institutional
   ownership (deeper holder base) now overrides the Canadian institutional
   value. Sibling A's IIC score will pick up this higher-quality signal
   automatically.
4. **Cardinality cuts** — Stage 2 output narrows from Top 80 → Top 60, and
   Opus (Stage 3) output narrows from Top 40 → Top 30. Empirically-validated
   per the spec. Stage 3 (Opus) now processes fewer tickers, reducing its
   expensive token budget.

## What's in the 9 commits

| # | SHA | Subject |
|---|---|---|
| 1 | `5690cf8` | `feat(data): seed dual_listing_map.json with 33 known TSX-US pairs` |
| 2 | `57a8778` | `feat(eodhd): add eodhd_enrichment.py for hybrid FMP+EODHD fetch layer` |
| 3 | `29dd519` | `feat(data): add US dual-listing enrichment module (Tiers 1-3)` |
| 4 | `a290ae7` | `feat(data): add cross_compare module for fetch-layer validation` |
| 5 | `1f6230f` | `feat(brain): import sibling-b modules (eodhd_enrichment, us_dual_listing_enrichment, cross_compare)` |
| 6 | `b334e8d` | `feat(brain): raise Stage 1 wall-clock cap from 420s to 600s` |
| 7 | `e3d8c2a` | `feat(brain): cardinality cuts Stage 2 output 80→60, Opus output 40→30` |
| 8 | `6830942` | `feat(brain): parallelize Stages 1+2 + rewrite Gemini for independent scoring` |
| 9 | `5ca0ab3` | `feat(brain): integrate Sibling B fetch layer — EODHD + cross-compare + dual-listing Tier 2` |

## Files changed

### New files (created in commits 1-4)
| Path | LoC | Purpose |
|---|---|---|
| `dual_listing_map.json` | 39 | Static TSX → US ticker map (33 pairs) |
| `eodhd_enrichment.py` | 62 | EODHD batch enrichment skeleton (fundamentals) |
| `us_dual_listing_enrichment.py` | 135 | US-market fetchers (Tier 1 options IV, Tier 2 13F, Tier 3a analyst, Tier 3b news) |
| `cross_compare.py` | 112 | FMP/EODHD cross-comparison + `DataQualityFlags` dataclass |

### Modified files (commits 5-9)
| Path | Change | Net LoC |
|---|---|---|
| `canadian_llm_council_brain.py` | Imports, cardinality cuts, timeout bump, parallel Stage 1+2 refactor, Gemini prompt rewrite, dual-listing fetch integration, Stage 1 telemetry gap fix | +~260 net |

### NOT touched (spec-confirmed)
- `prisma/schema.prisma` (no schema changes this phase — ADV Slider's `CouncilConfig` addition in `dc2cef0` is untouched)
- `src/**/*.tsx` (no frontend changes — Sibling A's IIC cleanup + B-i's Hit Rate refresh already landed separately)
- `api_server.py` (no new fields exposed this phase — verified via grep)

## Architecture details

### Parallel Stage 1+2 dispatch

In `run_council` (the entry point formerly known as `run_council_analysis`
in older docstrings), Steps 5 and 6 merged into a single parallel block:

```python
stage1_task = asyncio.create_task(_run_stage1_async())
stage2_task = asyncio.create_task(_run_stage2_async())
done, pending = await asyncio.wait(
    {stage1_task, stage2_task},
    timeout=600.0,
    return_when=asyncio.ALL_COMPLETED,
)
```

- Uses `asyncio.wait(..., ALL_COMPLETED)` instead of
  `asyncio.wait_for(asyncio.gather(...))` so partial results are preserved
  when the 600s cap fires — cancelled stages fall through to empty, the
  surviving stage's results are still used.
- The old per-stage `STAGE_WALL_CLOCK_TIMEOUT` checks inside Stage 1's
  batch loop and Stage 2's `wait_for` have been removed — the gather-level
  cap is the only cap for Stages 1+2.
- Stages 3 (Opus) and 4 (Grok) still use `STAGE_WALL_CLOCK_TIMEOUT` for
  their own per-stage timeouts. They run sequentially after the Stage 1+2
  gather completes.
- The hard guard relaxed from `if not stage1_results: raise` to
  `if not stage1_results and not stage2_results: raise` — either stage can
  rescue a run.

### Gemini scoring is now truly independent

`run_stage2_gemini`'s signature changed from 4 args to 3:

```python
# Old
async def run_stage2_gemini(payloads, macro, stage1_results, learning_engine=None)

# New
async def run_stage2_gemini(payloads, macro, learning_engine=None)
```

The `GEMINI_SYSTEM_PROMPT` was rewritten to remove all references to Stage
1, and the `StockScore.disagreement_reason` Pydantic field (which was
"Gemini Stage 2 only") has been deleted entirely. Gemini now receives only
the macro context and the raw payload dicts for the full liquid universe —
no Sonnet context. The batching inside `_run_stage2_async` chunks
`payloads_list` directly instead of chunking Stage 1 output.

**Implication:** Gemini now scores ~120 tickers per run (vs ~100 before).
Cost impact: ~20 extra tickers × ~$0.001/ticker = ~$0.02/run × ~250
runs/year = ~$5/year. Negligible.

### Cardinality cuts

| Stage | Before | After |
|---|---|---|
| Stage 2 output (narrowing input to Opus) | Top 80 | Top 60 |
| Stage 3 output (Opus narrowing input to Grok) | Top 40 | Top 30 |

**Preserved:** the `[:40]` slices at lines 1956-1957 of
`canadian_llm_council_brain.py` are NOT narrowing operations — they're
prompt context samples showing Opus the top 40 Stage 1/2 scores for
reference. Kept as-is per user decision to avoid a semantic mismatch
where Opus sees "30 top picks for context" while being asked to narrow a
pool of 60.

### Fetch-layer integration (Task 11)

The existing 2-way parallel fetch at Step 4d/4e extended to 3-way:

```python
earnings_map, (insider_map, analyst_map, institutional_map), eodhd_map = await asyncio.gather(
    _fetch_earnings(),
    _fetch_enhanced(),
    _fetch_eodhd(),  # NEW
)
```

Immediately after the gather, Step 4e.5 runs cross-compare:

```python
quality_flags_map = cross_compare.cross_compare_batch(
    [p.ticker for p in payloads_list], quotes, eodhd_map
)
```

After the existing per-ticker mutation loop (Step 4f), a new Step 4g runs
concurrent dual-listing enrichment under a `Semaphore(5)`:

```python
async def _enrich_dual(p):
    us_ticker = us_dual_listing_enrichment.get_us_ticker(p.ticker)
    if us_ticker is None:
        return
    async with dual_sem:
        us_13f = await us_dual_listing_enrichment.fetch_us_13f_institutional(
            self.fetcher, us_ticker
        )
        if us_13f is not None:
            p.institutional_ownership_pct = us_13f  # overrides Canadian value
```

**Order matters** — Step 4g runs AFTER Step 4f's Canadian institutional
assignment so the US 13F value overrides the Canadian value for dual-listed
tickers. The code has an explicit comment explaining this.

## Deferred follow-ups

### Tier 1 (US options IV → `IVExpectedMove`) — deferred to Task 11.5

The `fetch_us_options_iv` function exists as a skeleton in
`us_dual_listing_enrichment.py` but is NOT called from the brain. The FMP
`/api/v3/historical-price-full/options/{ticker}` endpoint returns raw
historical options data; converting it to an `IVExpectedMove(implied_volatility,
expected_move_1sd_pct, expected_move_2sd_pct, iv_available)` instance
requires Black-Scholes back-out or a different FMP endpoint. Non-trivial
and deferred to a follow-up task.

### Tier 3a (US analyst consensus) + Tier 3b (US news sentiment) — deferred

The fetchers exist in `us_dual_listing_enrichment.py` but are not called
from the brain in this commit. The marginal value (the current `AnalystConsensus`
Pydantic shape doesn't trivially map to the FMP grades response, and the
news sentiment override needs thought on whether to replace or supplement
the Canadian signal) does not justify the added latency of two more API
calls per dual-listed ticker (~33 extra calls × 2 = 66 extra API calls per
run). Deferred until a design pass on the Canadian vs US signal-merge
strategy.

### Cross-compare price disagreement detection — deferred

`cross_compare.cross_compare_batch` produces `DataQualityFlags` with ghost
detection fully working. The price-disagreement branch silently no-ops
because `eodhd_enrichment.fetch_eodhd_batch_enrichment` fetches
`/api/fundamentals/{ticker}` which has no top-level `close` field. To
enable price-diff detection, extend EODHD enrichment with a real-time
quote endpoint and pass `{ticker: {"close": X}}` to the cross-compare
batch call. Deferred to a follow-up.

### Four minor code-quality concerns from Tasks 1-4 reviews

These were deferred at task-review time with the note "fold into Task 11":

1. Unused `from typing import ... Any` imports in `eodhd_enrichment.py`,
   `us_dual_listing_enrichment.py`, `cross_compare.py` — the plan's verbatim
   skeletons include them, and Task 11 didn't end up needing them, so
   they're still unused. Linter noise, not functional.
2. Unused `f` prefix on `url = f"https://financialmodelingprep.com/stable/grades"`
   in `us_dual_listing_enrichment.py` line 111 — no string interpolation
   added in Task 11. Cosmetic.
3. `us_dual_listing_enrichment` calls `fetcher._get_session()` (a private
   method). Task 11 validated this works with the concrete `LiveDataFetcher`
   instance, so the "private method" concern is moot in practice.
4. `cross_compare.cross_compare` uses `bool(fmp_data)` for ghost detection
   instead of `isinstance(fmp_data, dict)`. Task 11's call site passes
   `quotes` (always `dict | None`), so the practical risk is zero.

These are all trivial cleanup items that can ship in a separate
`refactor(sibling-b): cleanup minor deferred concerns` commit if desired,
or just left alone. None are blocking.

### Pre-existing `package-lock.json` drift

`package.json` has `"version": "5.0.0"` but the committed `package-lock.json`
was at `"version": "1.0.0"` when Sibling B's work started. My Task 0
baseline `npm install` synced the lockfile to `5.0.0`, creating a 2-line
working-tree diff that I excluded from all Sibling B commits (via specific-
file `git add canadian_llm_council_brain.py` etc.). This is a pre-existing
main inconsistency, not Sibling B's responsibility. Recommend a standalone
`chore: sync package-lock.json version to 5.0.0` commit to main separately.

## Test plan

Since this project has no Python unit test framework, validation is
structured as:

- [x] **`python3 -m py_compile`** — all 4 new Sibling B modules and the
      modified brain file compile cleanly (verified after every commit).
- [x] **`python3 -c "import ..."`** — runtime import resolution for all 3
      new brain-imported modules passed at Task 6.
- [x] **AST checks** — `run_stage2_gemini` 3-arg signature verified after
      merged Task 9+10. `_fetch_eodhd` and `_enrich_dual` nested coroutines
      verified after Task 11.
- [x] **`npm run build`** — Next.js TypeScript build clean after
      `npm run db:generate` (Prisma client needed regeneration after
      rebasing onto the ADV Slider merge; this is a local environment
      step, not a code change).
- [x] **Smoke tests** — `cross_compare` dataclass equality (`== 2.0`
      rounding), `us_dual_listing_enrichment.get_us_ticker("SHOP.TO") ==
      "SHOP"`, verified at Tasks 3 + 4.
- [x] **Spec + code-quality review** for every task commit via
      `superpowers:subagent-driven-development` discipline (implementer
      subagent → spec reviewer → code-quality reviewer per task, with two
      review cycles for the merged Task 9+10 and Task 11 commits).
- [ ] **T+1 production validation** — tomorrow's 10:45 AST scheduled
      council run. Expected observations:
  - Logs show `Steps 5+6: Stages 1 (Sonnet) + 2 (Gemini) PARALLEL` at dispatch
  - Logs show `Cross-compare: N flagged tickers (M ghost)` after Step 4e.5
  - Logs show `Step 4g: Dual-listing Tier 2 complete — X/Y tickers have US 13F override`
  - Stage 2 output count is ≤60 (was ≤80)
  - Stage 3 (Opus) output count is ≤30 (was ≤40)
  - `institutional_conviction_score` values are HIGHER for dual-listed
    tickers vs. the previous run (picks up US 13F data)
  - Total council run time is in the 21-24 min historical window, or
    faster thanks to parallelism
- [ ] **T+24h backtest report** — comparison of today's run quality
      against the previous two weeks' baseline

## Deployment steps (for System A to execute manually after merge)

```bash
# Merge the PR via the GitHub UI — not via gh CLI (not installed on System B's machine)

# After merge, on the production droplet:
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  'cd /opt/spike-trades && git pull origin main && \
   docker compose build app council && \
   docker compose up -d app council && \
   sleep 5 && \
   docker compose ps && \
   docker compose logs --tail=50 council | grep -iE "import error|traceback"'
```

No `prisma db push` needed — no schema changes in this PR.
No frontend rebuild gate — no `src/` touched in this PR.

Verify all 6 containers healthy. Check council logs for any Python import
errors (especially around the three new imports: `eodhd_enrichment`,
`us_dual_listing_enrichment`, `cross_compare`).

## Coordination notes

- This PR is System B's work on Computer 2.
- System A (Computer 1) shipped the following during the same session
  before Sibling B reached Task 12:
  - Sibling A (IIC conviction score cleanup) — PR #9 `2f4de3b` + hotfix
    PR #10 `80f2743`
  - Phase 1 Final Report — PR #11 `49b6b10`
  - Session 16 docs bundle (Sibling B specs + plan + handoff prompt) — PR #12 `2a0d38d`
  - B-i Historical Hit Rate Refresh — PR #13 `0ffd1f6`
  - ADV Slider admin control — PR #14 `dc2cef0` (this PR's base)
- The ADV Slider PR's `CouncilConfig` Prisma model is untouched by Sibling B.
- The merged Task 9+10 commit's Stage 1 exception handler now calls
  `tracker.skip_stage("stage1_sonnet", reason=str(e))` — a 1-line gap fix
  surfaced during the Task 11 dispatch review. Folded into the Task 11
  commit per the user's guidance.

## Related documents

- **Spec:** `docs/superpowers/specs/2026-04-08-sibling-b-parallel-council-refactor-design.md`
- **Plan:** `docs/superpowers/plans/2026-04-08-sibling-b-parallel-council-refactor.md`
- **Handoff prompt:** `docs/superpowers/plans/2026-04-08-sibling-b-system-b-handoff-prompt.md`
- **Task 9/10 gap analysis:** `docs/superpowers/reports/2026-04-08-system-b-unexpected.md` (on `docs/system-b-unexpected` branch)
- **Task 11 recon report:** `docs/superpowers/reports/2026-04-08-system-b-task11-recon.md` (on `docs/system-b-unexpected` branch)
- **System B online note:** `docs/superpowers/reports/2026-04-08-system-b-online.md` (on `docs/system-b-online` branch)
- **Progress snapshot:** `docs/superpowers/reports/2026-04-08-system-b-progress-tasks-1-5.md` (on `docs/system-b-online` branch)

## Final notes from System B

Sibling B is the highest-risk single refactor in the 2026-04-08 session.
Nine commits, ~80-150 lines of net brain file changes per the biggest
commits, four new modules, and a fundamental change to the Stage 1+2
execution model. Discipline was maintained via subagent-driven development
throughout: every task went through implementer → spec reviewer → code
quality reviewer, with the two largest commits (merged 9+10 and Task 11)
also gated by controller-side AST + grep sanity checks.

All deviations from the plan are documented in the unexpected and recon
reports. Two plan-vs-reality gaps were surfaced and resolved before
dispatching any code:
1. **Task 9/10 inseparability** — the plan described them as separable,
   but the code coupling required a single atomic commit. User-approved.
2. **Task 11 tuple-of-maps pattern + cross-compare EODHD `close` gap** —
   recon clarified the fetch-layer integration and the price-diff
   limitation before dispatch. No code changes required to the plan.

Merge with eyes on tomorrow's 10:45 AST council run and the T+24 backtest.
