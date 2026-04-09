# New Session Prompt — 2026-04-09 (resume after context limit)

Copy everything below the line into the new session as the first user message.

---

You are resuming work on **Spike Trades** (autonomous AI stock analyst for TSX/TSXV, deployed at https://spiketrades.ca). The previous session ran out of context immediately after recovering from a production outage. Read the handoff file before doing anything else, then proceed in the order specified.

## Step 0 — Read these files first, in this order

1. `SESSION_HANDOFF_2026-04-09.md` (repo root) — primary handoff for this session, written at the end of the previous one. Contains the full pending-task list and the open question that cut the previous session off mid-discussion.
2. `SESSION_HANDOFF_2026-04-08.md` (repo root) — companion handoff with the older backlog, reference material, and the full Phase 1 + Learning Engine bypass file/line index. Still valid.
3. Your auto-memory `MEMORY.md` is already loaded. Pay particular attention to:
   - `feedback_no_silent_data_policy_changes.md`
   - `feedback_no_unconditional_delete.md` (HARD RULE — never `DELETE FROM <table>` without `WHERE`)
   - `feedback_cron_cached.md`
   - `feedback_always_push.md`
   - `feedback_timezone_ast.md`
   - `project_session_2026-04-08_handoff.md`
   - `project_historical_hit_rate_refresh.md`
   - `project_prisma_db_push.md`

Do NOT skim these. The previous session's context is gone — these files ARE the context.

## Step 1 — Re-verify production state

Production state may have drifted since the previous session ended. Run these and report results before proceeding:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  'cd /opt/spike-trades && git log --oneline -3 && docker compose ps'
```

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  'curl -s http://localhost:8100/health; echo; curl -s http://localhost:8100/learning-state | jq .bypassed_mechanisms'
```

Expected at handoff time:
- HEAD = `ad62da4` (PR #16 hotfix merge) or newer
- All 6 containers `Up` and the council container `(healthy)`
- `/health` returns HTTP 200
- `/learning-state` returns a `bypassed_mechanisms` field (proves the LE bypass from PR #3 is still in effect)

If anything is unexpected, STOP and report to the user before continuing.

## Step 2 — Ask the user the four open questions

These are listed at the bottom of `SESSION_HANDOFF_2026-04-09.md`. Do not assume answers. Ask all four together via `AskUserQuestion`:

1. **Manual council run for 2026-04-09**: trigger one now, or wait for tomorrow's natural 10:45 AST cron?
2. **`.TO` ticker audit scope**: standalone audit + written report only, or roll any fix into a follow-up PR same session?
3. **Repo hygiene**: OK to delete the listed stale local branches and worktrees in one batch after verifying each is clean?
4. **Uncommitted plan/doc files**: which to commit, which to gitignore, which to delete? (List the files in the question.)

The answer to #1 unblocks the Historical Hit Rate refresh project (memory `project_historical_hit_rate_refresh.md`), so don't skip it.

## Step 3 — The P0 task: Manual council run decision

Before recommending or executing a manual run, you MUST first read `src/lib/scheduling/analyzer.ts` and understand its behavior when re-run on an existing date. Specifically:

- Does it overwrite or append on `DailyReport` rows for the same date?
- How are `Spike` rows deduped?
- Does it touch the `historicalConfidence` recompute path?
- Does it interact with the council brain SQLite `pick_history` table?
- What are the side effects on the bypass-fixed Learning Engine? (Should be none — the bypass is at the call sites in `canadian_llm_council_brain.py`, not in analyzer.)

Then read whatever endpoint/cron/script actually triggers a council run. Note that `feedback_cron_cached.md` says `/api/cron?cached=true` *saves existing output rather than triggering a new run* — so that's the WRONG endpoint for a fresh run. Find the correct one.

Only after you understand the data implications do you present a recommendation to the user. Do not trigger anything without explicit chat-interface approval.

## Step 4 — The new P3 task: `.TO`-only ticker audit

User requirement: **every pick rendered in Today's Spikes must be a TSX-listed `.TO` ticker.** No `.V` (TSXV), no US tickers, no foreign exchanges.

Why this matters now: Sibling B (PR #15, merged `dc7fb4e`) introduced **dual-listing logic** and a **hybrid FMP/EODHD data path**. That is exactly the kind of change that can quietly leak non-`.TO` tickers into the result set if the post-resolution filter is wrong, missing, or applied at the wrong layer.

**Audit scope — check all five layers:**

1. **Council brain pick generation** — `canadian_llm_council_brain.py`. Where does the candidate universe come from? Does it filter to `.TO` *before* or *after* dual-listing resolution? What does Sibling B's parallel council path do?
2. **Sibling B's new modules** (added by PR #15). Read the diff: `gh pr view 15 --json files | jq '.files[].path'` then read each new/modified file. Look for ticker resolution, exchange detection, dual-listing handling.
3. **`api_server.py` mapping layer** — does it strip non-`.TO` tickers after the council returns, or pass through whatever the council emits?
4. **`src/lib/scheduling/analyzer.ts`** — any filtering on the Next.js side?
5. **`src/app/api/spikes/route.ts`** — final query that powers Today's Spikes UI. Any ticker-suffix filter? Should there be one as defense-in-depth?
6. **`src/components/spikes/SpikeCard.tsx`** — does it render whatever the API returns, or does it filter?

**Useful greps to start:**
- `\.TO` (literal usages)
- `dual_listing|dual-listing|dualListing`
- `exchange|TSX|TSXV`
- `\.V[\"'\\b]` (any `.V` ticker references)
- `suffix|symbol_suffix|ticker_suffix`

**Live data sanity check** — query production for current pick state:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c "SELECT ticker, COUNT(*) FROM \"Spike\" WHERE \"createdAt\" > now() - interval '\''7 days'\'' GROUP BY ticker ORDER BY ticker;"'
```
Look for any ticker that does not end in `.TO`. If you find any → leak confirmed, find the source.

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  'cd /opt/spike-trades && docker compose exec -T council python3 -c "
import sqlite3
conn = sqlite3.connect(\"/app/data/spike_trades_council.db\")
for row in conn.execute(\"SELECT DISTINCT ticker FROM pick_history WHERE run_date >= date('\''now'\'', '\''-7 days'\'') ORDER BY ticker\").fetchall():
    print(row[0])
"'
```
Same check at the council brain layer.

**Output of the audit:** a written finding in chat (or a small spec doc if it's complex). Either:
- ✅ "Already filtered, here are the gates at file:line, no leak found" — and show the live data confirming it
- ⚠️ "Leak found at file:line, here is the fix" — and show the offending row(s) from the live data check

**Do not apply a fix without showing the user the finding first.** If the audit suggests a "filter" change that would shrink the visible pick set, that triggers `feedback_no_silent_data_policy_changes.md` — explicit user approval required.

## Step 5 — Repo hygiene (after user answers Q3 and Q4)

If the user approves:

**Stale current branch:** working tree is on `fix/dockerfile-council-sibling-b-modules` (the original fix branch from before the worktree confusion — the actual hotfix went through `hotfix/dockerfile-council-copy-sibling-b-modules` via PR #16). Move uncommitted files to wherever they belong, then delete this branch.

**Stale local branches to prune** (most already merged via PRs #1–#16, but verify each before deleting):
- `chore/phase1-post-snapshot-to-main`
- `feat/iic-conviction-score`
- `feat/sibling-b-parallel-council`
- `feat/user-activity-heartbeat`
- `fix/dockerfile-council-sibling-b-modules`
- `fix/le-admin-tab-stub`
- `fix/learning-engine-bypass`
- `worktree-phase-1-radar-ob-removal`

For each: confirm it's merged to `main` (or its content is otherwise preserved) before `git branch -D`.

**Stray worktrees on disk:**
- `.claude/worktrees/phase-1-radar-ob-removal` → branch `docs/session-handoff-2026-04-08`
- `.worktrees/feat-user-activity-heartbeat` → branch `main`

For each: `cd` in, run `git status` to confirm no uncommitted work, then `git worktree remove <path>` from the main repo.

**Uncommitted / untracked files in the main repo at handoff:**
```
M  docs/superpowers/plans/2026-04-04-smart-money-radar-v5.md
?? .claude/ob_apr6.pdf
?? .claude/plans/radar-time-change.md
?? .claude/worktrees/
?? SESSION_8_TRANSITION.md
?? SESSION_HANDOFF_2026-04-09.md
?? SESSION_PROMPT_2026-04-09.md
?? docs/superpowers/plans/2026-04-06-card-consistency-portfolio.md
?? docs/superpowers/plans/2026-04-07-session-13-repairs.md
```

Per-file decisions required from the user (covered by Q4). Do not blanket-add. The two `SESSION_HANDOFF_*` and `SESSION_PROMPT_*` files probably belong on a fresh `docs/session-handoff-2026-04-09` branch off `main`, mirroring how the 04-08 handoff was handled.

## Step 6 — Sibling B post-merge verification (whichever council run we end up using)

This was supposed to happen right after PR #15 merged but the outage swallowed it. Once a council run actually fires on the Sibling B code (manual today or natural tomorrow):

1. **Parallel council actually ran** — confirm via `docker compose logs council` that the parallel path was hit, not just the legacy path.
2. **Hybrid FMP/EODHD data path exercised** — confirm both providers were called for the same run.
3. **Dual-listing logic produced the expected pick set** — and overlaps with the `.TO` audit (Step 4).
4. **ADV Slider admin control value reflected in the run** — whatever the admin set, the council should have honored.
5. **No regressions in row counts** — `pick_history` (council SQLite) and `Spike` (Postgres) should look reasonable vs. the prior baseline.
6. **No new errors** in `council` or `app` logs since the run.
7. **LE bypass still in effect** — `/learning-state` still returns `bypassed_mechanisms`, stage weights are still the literal `{0.15, 0.20, 0.30, 0.35}`.

## Step 7 — Only after all of the above

Pick from the longer-tail backlog (P4 in the handoff): Historical Hit Rate refresh, B1 per-stock 6-month price-action profile, C1–C4 LE full repair, `afaf7fb` cherry-pick. Ask the user which to start.

## Operating rules for this session

- **Be concise.** The previous session burned a lot of context on lengthy chat. Lead with the answer or action, not the reasoning. Save prose for genuine decision points.
- **TodoWrite** the pending items once you've read the handoffs and have a working list. Mark items in_progress one at a time.
- **No autonomous destructive actions.** Branch deletion, worktree removal, manual council runs, any DB writes, any production restarts — all require explicit user approval in the chat. The hotfix outage is fresh; do not assume permission carries over from the previous session.
- **Always commit and push** after edits (memory `feedback_always_push.md`).
- **AST timezone** for anything user-facing (memory `feedback_timezone_ast.md`). UTC is fine for commit timestamps and logs.
- **HARD RULE on deletes** — never `DELETE FROM <table>` without a `WHERE` clause. Refuse and propose a scoped variant. (memory `feedback_no_unconditional_delete.md`)
- **No silent data policy changes** — never modify report retention, pruning, or pick counts without explicit approval. (memory `feedback_no_silent_data_policy_changes.md`)
- **Schema deploys via `prisma db push`**, not migrations. `prisma/migrations/` is gitignored. One-shot SQL goes in `scripts/`. (memory `project_prisma_db_push.md`)

## First message of the new session should be

"Production state verified" or "Production state DRIFT — here's what I found", followed by the four open questions for the user, followed by waiting for answers. Do not start work on Steps 3–7 until the user has answered.
