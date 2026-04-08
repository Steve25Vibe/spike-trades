# System B Handoff Prompt — Sibling B Parallel Council Refactor

**Purpose:** This document contains the precise prompt to paste into the other Claude Code session ("System B") to start executing Sibling B autonomously.

**Instructions for the user:** Open a new Claude Code session on the second computer (same Anthropic account). Paste the content between the `PROMPT BEGIN` and `PROMPT END` markers below into that session. Claude Code will read the instructions and begin work.

---

## PROMPT BEGIN ─────────────────────────────────────────────────────────

You are a Claude Code session working on the **Spike Trades** project (autonomous AI stock analyst for TSX/TSXV, deployed at spiketrades.ca). Your role is **System B** executing the **Sibling B Parallel Council Refactor** project.

This session runs in parallel with **System A** on another computer (same Anthropic account, same GitHub repo). System A is currently executing smaller projects (B-i Historical Hit Rate Refresh and ADV Slider admin control). You focus entirely on Sibling B.

## Your first actions

1. **Acknowledge the project context** by reading these documents in order:
   - `SESSION_HANDOFF_2026-04-08.md` at the repo root (general project state)
   - `docs/superpowers/specs/2026-04-08-sibling-b-parallel-council-refactor-design.md` (the Sibling B spec)
   - `docs/superpowers/plans/2026-04-08-sibling-b-parallel-council-refactor.md` (the implementation plan with 12 tasks)
   - Memory note at `~/.claude/projects/-Users-coeus-spiketrades-ca-claude-code/memory/project_sibling_b_parallel_council_refactor.md` (background context on decisions made during the brainstorm)

2. **Verify production state** before touching anything:
   ```bash
   ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && git log --oneline -5 && docker compose ps'
   ```
   Expected: production HEAD on main includes the recent IIC Conviction Score Cleanup (PR #9 `2f4de3b`) and Phase 1 Final Report (PR #11 `49b6b10`). All 6 containers Up and healthy.

3. **Invoke the superpowers:subagent-driven-development skill** — this plan must be executed via fresh subagents per task with two-stage review (spec compliance + code quality), following the discipline System A has demonstrated today.

## Coordination with System A (CRITICAL)

**System A is actively editing `canadian_llm_council_brain.py` for the ADV Slider project.** If you touch that file before System A merges the ADV Slider PR, you will create merge conflicts.

**Rule:** You can freely work on Tasks 0-5 (worktree setup + creating NEW files) immediately. Do NOT begin Tasks 6-12 (which modify `canadian_llm_council_brain.py`) until System A's ADV Slider PR is merged to main.

**Check whether ADV Slider is merged:**
```bash
git -C <your worktree> fetch origin main
git -C <your worktree> log --oneline origin/main | grep -iE "adv.slider|advSlider|CouncilConfig" | head -3
```
If you see a matching commit, the ADV Slider is merged and you can proceed with Tasks 6+.

**While waiting:** make the most of Tasks 0-5 creating the new module files. These are standalone and can be committed immediately without affecting System A.

## Work plan summary

The plan has 12 tasks. Your execution order:

1. **Task 0:** Set up worktree at `.worktrees/sibling-b-parallel` on branch `feat/sibling-b-parallel-council` from `origin/main`. Run baseline build checks.
2. **Tasks 1-4:** Create 4 new files (NO brain file touches): `dual_listing_map.json`, `eodhd_enrichment.py`, `us_dual_listing_enrichment.py`, `cross_compare.py`. Each gets its own commit. Can start immediately.
3. **Task 5:** Wait for ADV Slider merge. Rebase your branch onto latest main.
4. **Tasks 6-11:** Integrate new modules into `canadian_llm_council_brain.py`. Each task is a focused change (import, timeout raise, cardinality cuts, parallel stages, Gemini prompt rewrite, fetch layer integration).
5. **Task 12:** Final build verification, open PR, **STOP for user approval before merge**, then merge + deploy + verify.

## Deployment pattern (when you reach Task 12)

The deploy pattern matches today's Sibling A deploy:

1. `gh pr create` with the title, body, and test plan
2. **Pause for user approval** — Sibling B is high-risk, do not merge without explicit "go" from the user
3. `gh pr merge --squash`
4. SSH production, `git pull origin main`
5. `docker compose build app && docker compose build council` (both need rebuild — brain file is in council container)
6. `docker compose up -d app council`
7. No `prisma db push` needed (no schema changes)
8. Verify containers healthy + no Python import errors in council logs
9. Write a brief deployment summary note (`docs/superpowers/reports/2026-04-08-sibling-b-deployed.md`) so System A knows it's live

## What to report back

When done, write a short summary including:
- The PR number + merge commit SHA
- Production HEAD after deploy
- Container health post-deploy
- Any deviations from the plan
- Any TODO items you identified for follow-up

Save this to `docs/superpowers/reports/2026-04-08-sibling-b-deployed.md` and commit it to main (via a docs branch + quick PR).

## Key decisions already locked (don't re-litigate)

- **No shadow deployment** — ship directly to production (user decision Q1 = A)
- **Parallel Stage 1+2** via asyncio.gather (locked in brainstorm)
- **Cardinality cuts 80→60 and 40→30** (empirically validated, locked)
- **Dual-listing Tiers 1+2+3 all ship** (user decision)
- **Gemini scores independently** (no Stage 1 context in its prompt anymore)
- **Stage 1 wall-clock cap raised to 600s** (safety net)
- **No schema changes** this phase
- **No UI changes** this phase (System A's Sibling A + B-i handle UI)

## Constraints

- **Subagent-driven development is REQUIRED** — each task gets an implementer subagent + spec reviewer + code quality reviewer per the superpowers discipline
- **You MUST NOT touch `canadian_llm_council_brain.py` until ADV Slider is merged** (Task 5 gate)
- **You MUST pause at Task 12 for user approval before merge** — Sibling B is high-risk, requires human sign-off
- **No shadow mode** — ship direct, backtest after
- **All file paths are absolute** — no `cd` reliance, use `git -C <worktree>` and `/Users/coeus/spiketrades.ca/claude-code/.worktrees/sibling-b-parallel/...` paths

## Success criteria

Sibling B is "done" when:
1. PR is merged to main
2. Production has been deployed (app + council rebuilt + restarted)
3. Containers are healthy
4. No Python import errors in council logs
5. Deployment summary is written and committed
6. Tomorrow morning's 10:45 AST council run (T+1) is the first real validation — it should:
   - Use parallel Stage 1+2 (log shows parallel gather)
   - Process the full ~120 ticker universe even if one stage is slow (parallelism eliminates the Stage 1 timeout failure mode)
   - Show Stage 2 output at exactly 60 (not 80) and Opus output at exactly 30 (not 40)
   - Populate institutional_conviction_score with HIGHER values for dual-listed names (because Sibling A's IIC uses the new US 13F data from dual-listing enrichment)
   - Complete in the historical 21-24 min window (or faster, since parallelism should help)

## Start now

Read the spec and plan docs first. Then set up Task 0 (worktree + baseline). Then begin Tasks 1-4 (new files — no waiting required). Check periodically for the ADV Slider merge before moving on to Task 5+.

Good luck. System A will coordinate cleanup + v6.0a backup ritual after Sibling B deploys.

## PROMPT END ──────────────────────────────────────────────────────────

---

## Notes for the user operating System B

### Expected session duration
~5-8 hours of subagent work. System B's session will be long and intensive.

### Monitoring System B's progress
The session on System B will produce commits on the branch `feat/sibling-b-parallel-council`. You can monitor from System A (this computer) via:
```bash
git fetch origin
git log --oneline origin/feat/sibling-b-parallel-council | head -20
```

### If System B gets stuck
Each task in the plan has explicit BLOCKED status reporting for subagents. If an implementer subagent reports BLOCKED, System B's coordinator (the main Claude Code session on that computer) should propose a fix and re-dispatch. If you see a long pause with no progress, check System B's session for an open BLOCKED status.

### Cross-session communication
System A and System B communicate via:
- **Git commits on shared branches** — both can fetch each other's work
- **Session handoff docs in `docs/superpowers/reports/`** — written by the completing side
- **Memory notes in `~/.claude/projects/-Users-coeus-spiketrades-ca-claude-code/memory/`** — shared knowledge base, both can read and write
- **You (the user) as the human relay** — you can copy important messages between the two sessions

### When both are done
System A completes cleanup + v6.0a ritual after both Sibling B (System B) and ADV Slider + B-i (System A's own work) are deployed and verified.
