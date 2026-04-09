# Session Handoff — 2026-04-09

> **Purpose:** Persistent record of where this session ended and what is queued for the next one. Read this first when resuming. Companion to `SESSION_HANDOFF_2026-04-08.md` (which still contains the older backlog and reference material).

---

## TL;DR

- **PR #15 (Sibling B parallel council)** merged at 2026-04-09 00:19 UTC.
- **Production outage** immediately after: council container in restart loop because `Dockerfile.council` did not `COPY` the new Sibling B Python modules.
- **Hotfix PR #16** merged at 2026-04-09 00:26 UTC — production restored. All 6 containers healthy, `/health` and `/learning-state` returning HTTP 200.
- **Session ran out of context** mid-discussion of whether to do a manual council re-run for 2026-04-09 (since the natural 10:45 AST cron did not fire on the bypass-fixed Sibling B code today). **No decision was reached and no action was taken.**
- Repo working tree is dirty on a stale fix branch and several stale local branches + worktrees still exist from the outage scramble.
- New backlog item from the user: **review the code to ensure scans only return `.TO` tickers in Today's Spikes.**

---

## Production state at handoff

| Component | State | Notes |
|---|---|---|
| Production HEAD | `ad62da4` | Hotfix #16 merge commit |
| `app` container | `Up` (rebuilt + restarted post-hotfix) | |
| `council` container | `Up (healthy)` | Sibling B modules now present in image |
| `cron` container | `Up` | Did NOT successfully fire today's 10:45 AST council run on the Sibling B code (timing collided with the deploy/outage window) |
| `db` + others | `Up (healthy)` | |
| `/health` | HTTP 200 | Verified post-hotfix |
| `/learning-state` | HTTP 200 | Bypass still in effect post-merge (assumed — re-verify next session) |

**First action of next session: re-verify production HEAD and the LE bypass state**, because state may drift between sessions.

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  'cd /opt/spike-trades && git log --oneline -3 && docker compose ps'
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  'curl -s http://localhost:8100/learning-state | jq .bypassed_mechanisms'
```

---

## Where the conversation cut off

User asked: **"Is there a plan to deal with the manual run data?"**

Context: today's natural 10:45 AST council cron did not fire on the bypass-fixed Sibling B code (deploy/restart timing collided with the cron window). We were debating whether to trigger a manual council re-run for 2026-04-09 and what that would do to today's data — specifically the behavior of `src/lib/scheduling/analyzer.ts` when re-running on an existing date (overwrite vs. append, DailyReport row collisions, Spike row dedup, hit-rate refresh implications).

**No decision was reached. No manual run was triggered. No data was modified.** This is the #1 thing to resume on.

---

## Pending tasks — ordered

### P0 — Decide first thing next session

**1. Manual council run decision for 2026-04-09**
- Do we trigger one, or wait for tomorrow's natural 10:45 AST cron?
- Need to reason through `analyzer.ts` re-run behavior on an existing date before pulling the trigger:
  - Does it overwrite or append on `DailyReport` rows?
  - How are `Spike` rows deduped?
  - Does it touch `historicalConfidence` recompute?
  - What does it do to the hit-rate refresh project (gated on "after today's council cron run post-10:45 AST")?
- File to read first: `src/lib/scheduling/analyzer.ts`
- Trigger to use if we go: `/api/cron?cached=true` saves existing output rather than running new (per memory `feedback_cron_cached.md`) — but we want a NEW run here, so this is the wrong endpoint. Need to find / confirm the right manual-run trigger.
- **Hard rule reminder** (`feedback_no_silent_data_policy_changes.md`): no changes to retention / pruning / pick counts without explicit user approval.

### P1 — Repo hygiene from the outage

**2. Stale current branch**
- Working tree is currently on `fix/dockerfile-council-sibling-b-modules` — the *original* fix branch from before the worktree confusion. The actual hotfix went through `hotfix/dockerfile-council-copy-sibling-b-modules` via PR #16. This branch should be deleted after the working-tree files are dealt with.

**3. Uncommitted / untracked files in the main repo**
```
M  docs/superpowers/plans/2026-04-04-smart-money-radar-v5.md
?? .claude/ob_apr6.pdf
?? .claude/plans/radar-time-change.md
?? .claude/worktrees/
?? SESSION_8_TRANSITION.md
?? SESSION_HANDOFF_2026-04-09.md           ← this file
?? docs/superpowers/plans/2026-04-06-card-consistency-portfolio.md
?? docs/superpowers/plans/2026-04-07-session-13-repairs.md
```
Each needs a per-file decision: commit, gitignore, or delete. Do not blanket-add.

**4. Stale local branches to prune** (most already merged via PRs #1–#16)
- `chore/phase1-post-snapshot-to-main`
- `feat/iic-conviction-score`
- `feat/sibling-b-parallel-council`
- `feat/user-activity-heartbeat`
- `fix/dockerfile-council-sibling-b-modules` (the stale current branch)
- `fix/le-admin-tab-stub`
- `fix/learning-engine-bypass`
- `worktree-phase-1-radar-ob-removal`

**5. Stray worktrees on disk**
- `.claude/worktrees/phase-1-radar-ob-removal` → `docs/session-handoff-2026-04-08`
- `.worktrees/feat-user-activity-heartbeat` → `main`
- Verify each has no uncommitted work, then `git worktree remove`.

### P2 — Sibling B post-merge verification (incomplete because the outage swallowed it)

**6. Verify the first natural Sibling B council run** (whichever run we end up using — manual today or tomorrow's natural cron)
- Parallel council actually ran
- Hybrid FMP/EODHD data path exercised
- Dual-listing logic produced the expected pick set
- ADV Slider admin control value is reflected in the run
- No regressions in `pick_history` (council SQLite) or `Spike` (Postgres) row counts vs. baseline
- No new errors in `council` or `app` logs

**7. Prove the Learning Engine bypass is still in effect post-Sibling-B**
- `/learning-state` still returns `bypassed_mechanisms` field
- Stage weights still the literal `{0.15, 0.20, 0.30, 0.35}` (not anything LE-derived)
- Re-verifies that PR #15 didn't accidentally re-introduce the buggy `compute_stage_weights()` / `build_prompt_context()` call sites

### P3 — NEW backlog item (added by user this session)

**8. Audit: Today's Spikes scans must only return `.TO` tickers**
- User requirement: every pick rendered in Today's Spikes must be a TSX-listed `.TO` ticker. No `.V` (TSXV), no US tickers, no foreign exchanges.
- Why this matters now: Sibling B (PR #15) introduced **dual-listing logic** and **hybrid FMP/EODHD data path**, which is exactly the kind of change that can quietly leak non-`.TO` tickers into the result set if the post-resolution filter is wrong or missing.
- Audit scope:
  1. Council brain pick generation — where does the candidate universe come from? Does it filter to `.TO` before or after dual-listing resolution?
  2. `api_server.py` mapping layer — does it strip non-`.TO` after the council returns?
  3. `src/lib/scheduling/analyzer.ts` — any filtering on the Next.js side?
  4. `src/app/api/spikes/route.ts` — final query that powers Today's Spikes UI. Any ticker-suffix filter? Should there be one as a defense-in-depth final gate?
  5. `src/components/spikes/SpikeCard.tsx` — does it render whatever the API returns, or does it filter?
- Likely starting points to grep:
  - `\.TO` literal usages
  - `dual_listing`, `dual-listing`, `dualListing`
  - `exchange`, `Exchange`, `TSX`, `TSXV`
  - The Sibling B PR #15 diff itself for what it actually does to ticker resolution
- Output of this audit: a written finding in chat (or a small spec doc) saying either "✅ already filtered, here are the gates" or "⚠️ leak found at file:line, here's the fix."
- **Do not** apply a fix without showing the user the finding first.
- Connects to `feedback_no_silent_data_policy_changes.md` if any "filter" change would actually shrink the pick set.

### P4 — Older queued backlog still alive (from `SESSION_HANDOFF_2026-04-08.md`)

**9. Historical Hit Rate refresh** (combined B1+B2+B3 unified project, in memory `project_historical_hit_rate_refresh.md`)
- Gated on "after today's council cron run post-10:45 AST"
- Today's cron didn't run successfully → **still gated** until P0 #1 is decided.

**10. B1 Per-stock 6-month price-action profile** (Tier 1A)
- Was gated on Phase 1 close (now closed) and Sibling B merge (now merged)
- **Unblocked.** Needs full brainstorm → spec → plan → implement cycle.

**11. C1–C4 Learning Engine full repair**
- Rewrite `compute_stage_weights()` correctly (canadian_llm_council_brain.py:3441)
- Rewrite `build_prompt_context()` correctly (canadian_llm_council_brain.py:3482)
- Fix Factor-Level Feedback dashboard mismatch
- Raise Learning Engine activation gates (data-gated, ~60–90 days out)
- Long-tail, no urgency.

**12. `afaf7fb` Phase 1 post-snapshot orphan commit**
- Cherry-pick to main, or leave as branch-only record.
- Cosmetic only.

---

## Recommended order for the next session

1. Re-verify production is still healthy (one SSH + `docker compose ps` + `/learning-state` curl).
2. Read this file + the tail of the prior session's transcript.
3. **Decide on the manual run question (P0 #1)** — this gates several other items.
4. **Run the `.TO`-only ticker audit (P3 #8)** — high priority because it's a correctness question on freshly-deployed Sibling B code.
5. Repo hygiene cleanup (P1 #2–#5) — quick, low risk, reduces clutter.
6. Sibling B post-merge verification on whichever council run we use (P2 #6, #7).
7. Then pick from B1 / Historical Hit Rate refresh / LE repair (P4).

---

## Files / SHAs / URLs reference

### PRs from this session
- **#15** Sibling B parallel council — merged `dc7fb4e` (2026-04-09 00:19 UTC)
- **#16** Hotfix Dockerfile.council COPY Sibling B modules — merged `ad62da4` (2026-04-09 00:26 UTC)

### Production access (unchanged)
- SSH: `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
- App path: `/opt/spike-trades`
- Council brain endpoint: `http://localhost:8100` (inside container)
- Public URL: `https://spiketrades.ca`
- Council brain SQLite: `/app/data/spike_trades_council.db` (inside `council` container)
- Postgres: `docker compose exec db psql -U spiketrades -d spiketrades`

### Companion handoff (still valid)
- `SESSION_HANDOFF_2026-04-08.md` — older backlog, reference material, full Phase 1 + LE bypass file/line index. Do not delete; this file builds on it.

---

## Open questions for user (next session)

1. **Manual council run for 2026-04-09**: trigger it, or wait for tomorrow's natural cron?
2. **`.TO` ticker audit**: standalone audit + report, or roll any fix into a follow-up PR same-session?
3. **Repo hygiene**: OK to delete the listed stale local branches and worktrees in one batch after verifying each is clean?
4. **Uncommitted plan/doc files**: which to commit, which to gitignore, which to delete?
