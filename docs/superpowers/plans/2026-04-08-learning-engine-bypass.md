# Learning Engine Conservative Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a conservative bypass of the broken `compute_stage_weights()` and `build_prompt_context()` Learning Engine methods so the council's next scheduled run (Wednesday 2026-04-08 13:45 UTC) uses the intended `{1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}` stage weights instead of the buggy uniform `{0.25, 0.25, 0.25, 0.25}`.

**Architecture:** Pure call-site bypass. The broken functions remain in `canadian_llm_council_brain.py` untouched. Their two hot-path call sites in `_build_consensus` and one cold-path dashboard call site in the council result assembly are replaced with hardcoded literals. The four `build_prompt_context()` call sites in the stage entry functions are replaced with empty-string literals. The `/learning-state` API endpoint in `api_server.py` is extended with a `bypassed_mechanisms` field so admin-panel-facing code can surface the bypass state honestly.

**Tech Stack:** Python 3.12, FastAPI, SQLite (not modified), SSH + Docker Compose (deploy).

**Spec:** `docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md`

**Branch:** `fix/learning-engine-bypass` (already created from `origin/main` tip `79d4f83`, spec committed as `57d8cda`)

**Deploy deadline:** Before 2026-04-08 13:45 UTC (the next natural council cron fire).

---

## File Structure

### Files modified (2)

```
canadian_llm_council_brain.py   ← 6 edits: 5 bypass sites + 0 functional deletions
api_server.py                   ← 1 edit: /learning-state endpoint
```

### Files explicitly NOT modified

```
prisma/schema.prisma                          ← zero-touch continuing from Phase 1
spike_trades_council.db                       ← no DDL, no DML, no data migration
src/                                          ← no frontend changes (admin panel UI deferred)
tests/                                        ← no test file changes
scripts/                                      ← no Phase 1 tooling changes
docs/superpowers/specs/*learning-engine*      ← the core+admin-panel spec docs stay as-is (they document the intended design; this bypass is a workaround)
All other *.py files in repo root             ← unchanged
Dockerfile, Dockerfile.council, Dockerfile.cron, docker-compose.yml ← unchanged (container content changes; no infrastructure changes)
```

### Functions that REMAIN structurally broken (out of scope)

These stay in `canadian_llm_council_brain.py` with their bugs intact. They are no longer called from the hot path but the code is preserved for future repair:

- `LearningEngine.compute_stage_weights()` — the buggy JOIN that returns uniform weights
- `LearningEngine.build_prompt_context()` — the buggy JOIN that returns stage-identical text
- `LearningEngine.get_mechanism_states()` "Factor-Level Feedback" gate check — the dashboard-vs-reality mismatch (uses all-horizon count, actual function uses 3d-only)

These are documented for future repair in the spec Section 5 follow-ups list.

---

## Task 1: Bypass compute_stage_weights in _build_consensus (the critical hot-path fix)

**Files:**
- Modify: `canadian_llm_council_brain.py:2122` (the call site)
- Modify: `canadian_llm_council_brain.py:2140` (the adjustments dict)

This is the task that actually changes council scoring. After this task lands and deploys, Stage 4 regains its intended 35% weight in consensus computation, and the per-pick `adjustments` dict includes a `le_stage_weights_bypassed: true` flag so downstream consumers can tell the pick ran under the bypass.

- [ ] **Step 1: Verify current state of line 2122**

Run:
```bash
grep -n "STAGE_WEIGHTS = learning_engine.compute_stage_weights" canadian_llm_council_brain.py
```

Expected output (one match):
```
2122:    STAGE_WEIGHTS = learning_engine.compute_stage_weights() if learning_engine else {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
```

If the line number differs or the text differs, stop and investigate before proceeding. The file may have been edited by another change.

- [ ] **Step 2: Verify current state of line 2140**

Run:
```bash
grep -n 'adjustments: dict\[str, Any\] = {"stage_weights"' canadian_llm_council_brain.py
```

Expected output:
```
2140:        adjustments: dict[str, Any] = {"stage_weights": dict(STAGE_WEIGHTS)}
```

- [ ] **Step 3: Replace the compute_stage_weights call with a hardcoded literal**

Use the Edit tool on `canadian_llm_council_brain.py`:

**old_string:**
```
    STAGE_WEIGHTS = learning_engine.compute_stage_weights() if learning_engine else {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
```

**new_string:**
```
    # LE BYPASS (2026-04-08): compute_stage_weights() has a confirmed JOIN defect
    # that always returns uniform {0.25 × 4}, underweighting Stage 4 by 10pp from
    # the intended {0.15, 0.20, 0.30, 0.35}. Bypassed pending full audit.
    # See docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md
    STAGE_WEIGHTS = {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
```

- [ ] **Step 4: Add the bypass flag to the adjustments dict**

Use the Edit tool on `canadian_llm_council_brain.py`:

**old_string:**
```
        adjustments: dict[str, Any] = {"stage_weights": dict(STAGE_WEIGHTS)}
```

**new_string:**
```
        adjustments: dict[str, Any] = {"stage_weights": dict(STAGE_WEIGHTS), "le_stage_weights_bypassed": True}
```

- [ ] **Step 5: Syntax-check the file**

Run:
```bash
python3 -m py_compile canadian_llm_council_brain.py && echo "PY_COMPILE_OK"
```

Expected output: `PY_COMPILE_OK`. Exit code 0.

If py_compile fails, the edit introduced a syntax error. Revert with `git checkout canadian_llm_council_brain.py` and re-apply the Edit tool steps more carefully.

- [ ] **Step 6: Verify the old pattern is gone from the hot path**

Run:
```bash
grep -n "STAGE_WEIGHTS = learning_engine.compute_stage_weights" canadian_llm_council_brain.py
```

Expected output: no matches (grep exits 1, no lines printed).

If the grep finds matches, the Edit tool didn't actually apply the change or there's another copy of the line we didn't know about. Stop and investigate.

- [ ] **Step 7: Verify the new bypass marker is present**

Run:
```bash
grep -n "LE BYPASS (2026-04-08)" canadian_llm_council_brain.py
```

Expected: at least one match showing the bypass comment.

- [ ] **Step 8: Verify the adjustments flag is present**

Run:
```bash
grep -n "le_stage_weights_bypassed" canadian_llm_council_brain.py
```

Expected: at least one match showing the bypass flag assignment.

- [ ] **Step 9: Commit Task 1**

Run:
```bash
git add canadian_llm_council_brain.py
git status --short
git commit -m "$(cat <<'EOF'
fix(council): bypass buggy compute_stage_weights at _build_consensus

Task 1/5 of LE bypass.

compute_stage_weights() has a confirmed SQL JOIN defect: the query
returns identical rows for all 4 stage iterations because it filters
on stage_scores.stage without using a per-stage accuracy metric. The
normalized weights always collapse to {0.25, 0.25, 0.25, 0.25}
regardless of data.

Replaced the call at _build_consensus line 2122 with the intended
hardcoded defaults {1:0.15, 2:0.20, 3:0.30, 4:0.35}. Stage 4 regains
its 35% weight in consensus scoring. Added
"le_stage_weights_bypassed": True to the per-pick adjustments dict
so downstream consumers and pick_history can tell this pick ran
under the bypass.

Does not fix the compute_stage_weights() function itself — stays
in place untouched, just no longer called from the hot path. Does
not touch any other Learning Engine mechanism.

Spec: docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit created. Working tree clean.

---

## Task 2: Bypass build_prompt_context at all 4 stage entry points

**Files:**
- Modify: `canadian_llm_council_brain.py:1565` (Stage 1)
- Modify: `canadian_llm_council_brain.py:1642` (Stage 2)
- Modify: `canadian_llm_council_brain.py:1730` (Stage 3)
- Modify: `canadian_llm_council_brain.py:1866` (Stage 4)

The `build_prompt_context()` function has the same JOIN defect as `compute_stage_weights()` — it queries pick-level accuracy and returns a "your accuracy is X%" paragraph that is identical for all 4 stages. This task replaces all 4 call sites with empty-string literals so the LLM prompts stop receiving the misleading text.

- [ ] **Step 1: Verify current state of all 4 call sites**

Run:
```bash
grep -n "prompt_context = learning_engine.build_prompt_context" canadian_llm_council_brain.py
```

Expected output (exactly 4 matches):
```
1565:    prompt_context = learning_engine.build_prompt_context(1) if learning_engine else ""
1642:    prompt_context = learning_engine.build_prompt_context(2) if learning_engine else ""
1730:    prompt_context = learning_engine.build_prompt_context(3) if learning_engine else ""
1866:    prompt_context = learning_engine.build_prompt_context(4) if learning_engine else ""
```

If fewer or more than 4 matches, or the line numbers differ, stop and investigate. Line numbers may shift after Task 1's commit (they shouldn't — Task 1 edited lines 2122 and 2140, which are below all four of these).

- [ ] **Step 2: Bypass the Stage 1 call site**

Use the Edit tool on `canadian_llm_council_brain.py`:

**old_string:**
```
    prompt_context = learning_engine.build_prompt_context(1) if learning_engine else ""
```

**new_string:**
```
    # LE BYPASS (2026-04-08): build_prompt_context has the same JOIN defect
    # as compute_stage_weights — returns stage-identical "your accuracy is X%"
    # text derived from pick-level accuracy instead of per-stage accuracy.
    # Bypassed. See docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md
    prompt_context = ""
```

- [ ] **Step 3: Bypass the Stage 2 call site**

Use the Edit tool on `canadian_llm_council_brain.py`:

**old_string:**
```
    prompt_context = learning_engine.build_prompt_context(2) if learning_engine else ""
```

**new_string:**
```
    # LE BYPASS (2026-04-08): see Stage 1 call site for rationale.
    prompt_context = ""
```

- [ ] **Step 4: Bypass the Stage 3 call site**

Use the Edit tool on `canadian_llm_council_brain.py`:

**old_string:**
```
    prompt_context = learning_engine.build_prompt_context(3) if learning_engine else ""
```

**new_string:**
```
    # LE BYPASS (2026-04-08): see Stage 1 call site for rationale.
    prompt_context = ""
```

- [ ] **Step 5: Bypass the Stage 4 call site**

Use the Edit tool on `canadian_llm_council_brain.py`:

**old_string:**
```
    prompt_context = learning_engine.build_prompt_context(4) if learning_engine else ""
```

**new_string:**
```
    # LE BYPASS (2026-04-08): see Stage 1 call site for rationale.
    prompt_context = ""
```

- [ ] **Step 6: Syntax-check the file**

Run:
```bash
python3 -m py_compile canadian_llm_council_brain.py && echo "PY_COMPILE_OK"
```

Expected output: `PY_COMPILE_OK`. Exit code 0.

- [ ] **Step 7: Verify the old pattern is gone**

Run:
```bash
grep -n "prompt_context = learning_engine.build_prompt_context" canadian_llm_council_brain.py
```

Expected output: no matches (grep exits 1, no lines printed).

- [ ] **Step 8: Verify exactly 4 bypass markers are present for prompt_context**

Run:
```bash
grep -c "LE BYPASS (2026-04-08)" canadian_llm_council_brain.py
```

Expected output: `5` or higher (1 from Task 1 stage_weights comment block + 4 from the 4 prompt_context call sites). It will be 5 exactly if each bypass comment contains exactly one match line.

If the count is off, stop and investigate.

- [ ] **Step 9: Commit Task 2**

Run:
```bash
git add canadian_llm_council_brain.py
git status --short
git commit -m "$(cat <<'EOF'
fix(council): bypass build_prompt_context at all 4 stage entry points

Task 2/5 of LE bypass.

build_prompt_context() has the same structural JOIN defect as
compute_stage_weights: the query reads pick-level accuracy
(ar.accurate) for each stage but filters only on stage_scores.stage,
so every stage sees the same rows and the returned "your stage N
accuracy is X%" text is identical across all 4 stages. This is
misleading to the LLMs.

Replaced all 4 call sites (Stage 1 @1565, Stage 2 @1642, Stage 3
@1730, Stage 4 @1866) with the empty string. LLMs no longer receive
the stale/misleading performance feedback paragraph.

Does not fix the build_prompt_context() function itself — stays
in place untouched, just no longer called.

Spec: docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit created. Working tree clean.

---

## Task 3: Bypass compute_stage_weights at result_dict assembly (line 4830)

**Files:**
- Modify: `canadian_llm_council_brain.py:4830` (second call site)

This is the cold-path call site that writes `result_dict["stage_weights_used"]` for dashboard/output visibility. Fixing Task 1 alone would leave this site still calling the buggy function, causing the admin dashboard's `stage_weights_used` display to show uniform weights while the actual pick scoring uses the correct ones. This task fixes that inconsistency.

- [ ] **Step 1: Verify current state of line 4830**

Run:
```bash
grep -n 'result_dict\["stage_weights_used"\]' canadian_llm_council_brain.py
```

Expected output (one match, line number may differ slightly after Tasks 1–2 edits but the content should be identical):
```
4830:                result_dict["stage_weights_used"] = self.learning_engine.compute_stage_weights()
```

If the line number differs, that is fine — the Edit tool matches by content, not line number. If the text differs or zero/multiple matches, stop and investigate.

- [ ] **Step 2: Replace the call with the same hardcoded literal**

Use the Edit tool on `canadian_llm_council_brain.py`:

**old_string:**
```
                result_dict["stage_weights_used"] = self.learning_engine.compute_stage_weights()
```

**new_string:**
```
                # LE BYPASS (2026-04-08): second compute_stage_weights call site.
                # Same hardcoded literal as _build_consensus so the dashboard's
                # stage_weights_used value matches what scoring actually used.
                result_dict["stage_weights_used"] = {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
```

- [ ] **Step 3: Syntax-check the file**

Run:
```bash
python3 -m py_compile canadian_llm_council_brain.py && echo "PY_COMPILE_OK"
```

Expected output: `PY_COMPILE_OK`.

- [ ] **Step 4: Verify the old pattern is gone**

Run:
```bash
grep -n "result_dict\[.stage_weights_used.\] = self.learning_engine.compute_stage_weights" canadian_llm_council_brain.py
```

Expected: no matches.

- [ ] **Step 5: Verify zero remaining compute_stage_weights() calls from the hot paths**

Run:
```bash
grep -n "learning_engine.compute_stage_weights\|self\.learning_engine\.compute_stage_weights" canadian_llm_council_brain.py
```

Expected: no matches. The buggy function definition at line 3441 is still present (just the `def` line), but nothing calls it anymore from application code.

To verify the function definition itself is still intact:
```bash
grep -n "def compute_stage_weights" canadian_llm_council_brain.py
```
Expected: one match showing `    def compute_stage_weights(self) -> dict[int, float]:` around line 3441.

- [ ] **Step 6: Commit Task 3**

Run:
```bash
git add canadian_llm_council_brain.py
git status --short
git commit -m "$(cat <<'EOF'
fix(council): bypass compute_stage_weights at result_dict assembly

Task 3/5 of LE bypass.

Second call site to compute_stage_weights() lives at line ~4830,
where result_dict["stage_weights_used"] is populated for
dashboard/output visibility. Task 1 fixed the hot-path scoring
call; this task fixes the metadata call so the dashboard's
reported weights match what scoring actually used.

After this commit, zero remaining application-code calls to
compute_stage_weights() exist. The function definition stays in
place at line 3441 for future repair.

Spec: docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit created. Working tree clean.

---

## Task 4: Add bypassed_mechanisms field to /learning-state endpoint

**Files:**
- Modify: `api_server.py:406-421` (the `/learning-state` endpoint)

The `/learning-state` endpoint is the authoritative source of truth for the admin panel's Learning Engine display. The admin panel currently shows "Dynamic Stage Weights: ACTIVE" and "Prompt Accuracy Context: ACTIVE" based on gate checks that still pass (the gate queries haven't changed). After this task, the endpoint returns a new top-level `bypassed_mechanisms` field that API consumers can use to render bypassed state honestly. The admin panel UI update itself is deferred to a follow-up commit.

- [ ] **Step 1: Verify current state of the endpoint**

Run:
```bash
sed -n '406,421p' api_server.py
```

Expected output:
```python
@app.get("/learning-state")
async def learning_state():
    """Return current learning mechanism states for admin panel."""
    try:
        from canadian_llm_council_brain import LearningEngine, DB_PATH
        le = LearningEngine(db_path=DB_PATH)
        states = le.get_mechanism_states()
        weights = le.compute_stage_weights()
        return {
            "success": True,
            "mechanisms": states,
            "current_stage_weights": weights,
        }
    except Exception as e:
        logger.error(f"Learning state failed: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
```

If the function body differs, stop and investigate. Line numbers may drift from 406 — use content matching, not line numbers.

- [ ] **Step 2: Replace the endpoint with a bypass-aware version**

Use the Edit tool on `api_server.py`:

**old_string:**
```python
@app.get("/learning-state")
async def learning_state():
    """Return current learning mechanism states for admin panel."""
    try:
        from canadian_llm_council_brain import LearningEngine, DB_PATH
        le = LearningEngine(db_path=DB_PATH)
        states = le.get_mechanism_states()
        weights = le.compute_stage_weights()
        return {
            "success": True,
            "mechanisms": states,
            "current_stage_weights": weights,
        }
    except Exception as e:
        logger.error(f"Learning state failed: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
```

**new_string:**
```python
@app.get("/learning-state")
async def learning_state():
    """Return current learning mechanism states for admin panel.

    LE BYPASS (2026-04-08): Dynamic Stage Weights and Prompt Accuracy Context
    are bypassed in council runs due to confirmed JOIN defects in their compute
    functions. The dashboard's get_mechanism_states() still reports them as
    "active" because the gate queries themselves are unchanged, but the values
    are no longer used by _build_consensus. The bypassed_mechanisms field below
    lets the admin panel surface this honestly.
    See docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md
    """
    try:
        from canadian_llm_council_brain import LearningEngine, DB_PATH
        le = LearningEngine(db_path=DB_PATH)
        states = le.get_mechanism_states()
        # Hardcoded bypass weights — matches what _build_consensus uses at runtime.
        # See canadian_llm_council_brain.py:2122 for the single source of truth.
        bypass_weights = {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
        return {
            "success": True,
            "mechanisms": states,
            "current_stage_weights": bypass_weights,
            "bypassed_mechanisms": ["Dynamic Stage Weights", "Prompt Accuracy Context"],
        }
    except Exception as e:
        logger.error(f"Learning state failed: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
```

- [ ] **Step 3: Syntax-check both files**

Run:
```bash
python3 -m py_compile api_server.py canadian_llm_council_brain.py && echo "BOTH_PY_COMPILE_OK"
```

Expected output: `BOTH_PY_COMPILE_OK`.

- [ ] **Step 4: Verify no remaining compute_stage_weights calls in api_server.py**

Run:
```bash
grep -n "compute_stage_weights" api_server.py
```

Expected: no matches. The previous endpoint called `le.compute_stage_weights()`; after Task 4 that call is replaced with the literal.

- [ ] **Step 5: Verify the bypassed_mechanisms field is present**

Run:
```bash
grep -n "bypassed_mechanisms" api_server.py
```

Expected: one match showing the new field.

- [ ] **Step 6: Commit Task 4**

Run:
```bash
git add api_server.py
git status --short
git commit -m "$(cat <<'EOF'
fix(api): add bypassed_mechanisms field to /learning-state endpoint

Task 4/5 of LE bypass.

The /learning-state endpoint is the admin panel's source of truth
for Learning Engine mechanism states. After Tasks 1–3 bypass the
compute_stage_weights and build_prompt_context calls in the council
brain, this endpoint was still calling compute_stage_weights itself
to populate current_stage_weights for the dashboard — which would
have displayed the buggy uniform {0.25 × 4} even while scoring
used the correct {0.15, 0.20, 0.30, 0.35}.

Changes:
- Replace the le.compute_stage_weights() call with the same
  hardcoded literal used at canadian_llm_council_brain.py:2122.
- Add a new top-level "bypassed_mechanisms" field listing
  ["Dynamic Stage Weights", "Prompt Accuracy Context"] so
  API consumers can render the bypass state honestly.

The admin panel UI update to render bypassed_mechanisms as a
visible warning is deferred to a follow-up commit (not this
bypass — out of scope per spec Section 1).

Spec: docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit created. Working tree clean.

---

## Task 5: Local verification + PR + merge + production deploy + runtime verification

**Files:** None modified. Verification, deploy, and runtime proof.

This is the deploy-and-verify task. If any step fails, STOP and report the failure. Do not attempt ad-hoc repair steps.

- [ ] **Step 1: Full local syntax verification**

Run:
```bash
python3 -m py_compile canadian_llm_council_brain.py api_server.py canadian_portfolio_interface.py eodhd_news.py fmp_bulk_cache.py && echo "ALL_5_PY_COMPILE_OK"
```

Expected: `ALL_5_PY_COMPILE_OK`. All 5 production Python files syntax-clean.

- [ ] **Step 2: Verify all bypass markers are in place**

Run:
```bash
grep -c "LE BYPASS (2026-04-08)" canadian_llm_council_brain.py
```

Expected: `6` (1 from Task 1 stage_weights + 4 from Task 2 prompt_context + 1 from Task 3 result_dict).

Run:
```bash
grep -c "LE BYPASS (2026-04-08)" api_server.py
```

Expected: `1` (from Task 4 endpoint docstring).

- [ ] **Step 3: Verify zero application calls to the buggy functions**

Run:
```bash
grep -n "learning_engine.compute_stage_weights\|self\.learning_engine\.compute_stage_weights" canadian_llm_council_brain.py
```

Expected: no matches.

Run:
```bash
grep -n "learning_engine.build_prompt_context" canadian_llm_council_brain.py
```

Expected: no matches.

Run:
```bash
grep -n "compute_stage_weights\|build_prompt_context" api_server.py
```

Expected: no matches.

- [ ] **Step 4: Verify the buggy function definitions are still present (not accidentally deleted)**

Run:
```bash
grep -n "def compute_stage_weights\|def build_prompt_context" canadian_llm_council_brain.py
```

Expected: exactly 2 matches showing the function definitions still exist around lines 3441 and 3482. The bypass does not delete the functions; it only stops calling them from the hot path.

- [ ] **Step 5: Run the Phase 1 verification gate (commit 10 profile)**

Run:
```bash
./scripts/phase1_verify.sh 10
```

Expected: `ALL CHECKS PASS` banner in green. All 8 checks green:
- build ✓
- python: api_server syntax ✓
- python: council brain syntax ✓
- python: portfolio interface syntax ✓
- python: eodhd_news syntax ✓
- python: fmp_bulk_cache syntax ✓
- opening_bell_scanner.py deleted ✓
- no Radar/OB refs in production .py files ✓

If FAIL on any check, STOP. Do not proceed to deploy.

- [ ] **Step 6: Push the branch to origin**

Run:
```bash
git push origin fix/learning-engine-bypass
```

Expected: push succeeds. Branch already has upstream tracking from the earlier `git push -u origin fix/learning-engine-bypass` during spec commit.

- [ ] **Step 7: Open the PR**

Run:
```bash
gh pr create --base main --head fix/learning-engine-bypass --title "fix(council): Learning Engine conservative bypass — stop buggy stage_weights underweighting Stage 4" --body "$(cat <<'EOF'
## Summary

Post-Phase-1 audit surfaced a confirmed SQL JOIN defect in \`canadian_llm_council_brain.py\` \`LearningEngine.compute_stage_weights()\`. The function returns identical rows for all 4 stage iterations, so normalized weights always collapse to \`{0.25, 0.25, 0.25, 0.25}\` regardless of data. This has been the case for ~10 days since the Learning Engine Core deploy on 2026-03-29, silently underweighting Stage 4 (Opus-4.6 final synthesis) by 10 percentage points from the intended \`{0.15, 0.20, 0.30, 0.35}\` defaults.

\`build_prompt_context()\` has the same structural JOIN defect — stage-identical \"your accuracy is X%\" text.

Separate statistical-significance finding: across 198 resolved accuracy records, directional hit rates (3d: 53.6%, 5d: 57.4%, 8d: 54.3%) are NOT distinguishable from a coin flip at 95% confidence. Even bug-free code would be learning from noise at current sample sizes.

User chose the **conservative bypass** path: smallest possible change, leave the broken functions in place but stop calling them. Other Learning Engine mechanisms (sector, disagreement, conviction, factor, prefilter) are untouched and continue to run.

## Scope

5 edit sites across 2 files:

- \`canadian_llm_council_brain.py:2122\` — replace \`compute_stage_weights()\` hot-path call with hardcoded \`{1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}\`
- \`canadian_llm_council_brain.py:2140\` — add \`\"le_stage_weights_bypassed\": True\` to the per-pick adjustments dict
- \`canadian_llm_council_brain.py:1565, 1642, 1730, 1866\` — replace 4 \`build_prompt_context()\` call sites with empty strings
- \`canadian_llm_council_brain.py:4830\` — replace result_dict dashboard call site with same hardcoded literal
- \`api_server.py /learning-state\` — add \`bypassed_mechanisms\` field listing the two bypassed mechanism names

## NOT in scope

- Fixing the buggy functions themselves (stays for future repair)
- Other Learning Engine mechanisms (sector, disagreement, conviction, factor, prefilter)
- SQLite schema changes (zero-touch)
- Admin panel UI update to render bypassed_mechanisms visibly (deferred)
- Raising gate thresholds (deferred; separate concern)

## Spec

\`docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md\` — approved by user during brainstorming session with \"conservative bypass\" choice.

## Test plan

- [x] Python syntax check on all 5 production files (\`py_compile\`)
- [x] Phase 1 verification gate (\`./scripts/phase1_verify.sh 10\`)
- [x] Grep-based verification that all bypass markers are present (6 in council brain, 1 in api_server)
- [x] Grep-based verification that zero application code calls compute_stage_weights or build_prompt_context
- [x] Grep-based verification that the buggy function definitions are still present (not accidentally deleted)
- [ ] Post-deploy: council container rebuilds cleanly, comes up (healthy)
- [ ] Post-deploy: /health endpoint returns valid JSON
- [ ] Post-deploy: /learning-state returns bypassed_mechanisms field
- [ ] Post-deploy: database parity check (phase1_db_parity.sh) still passes
- [ ] Post-deploy (Wed 13:45 UTC): next natural council cron run writes pick_history with le_stage_weights_bypassed: true and stage_weights: {0.15, 0.20, 0.30, 0.35}

## Deploy timing

Tonight, before Wednesday 13:45 UTC natural council cron. This is intentional — confining the bypass effect to only the first post-Phase-1 council run. Phase 1 T+24h observability (Task 12) accounts for the bypass as a separate variable.

## Rollback

Single \`git revert\` of this PR's merge commit on main, push, pull on prod, rebuild council image, restart container. Rollback restores the buggy state \\u2014 only do it if there's a concrete regression signal.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Copy the PR number for the next step.

- [ ] **Step 8: Verify PR state before merge**

Run:
```bash
gh pr view fix/learning-engine-bypass --json number,state,mergeable,mergeStateStatus
```

Expected: `state: OPEN, mergeable: MERGEABLE, mergeStateStatus: CLEAN`.

If mergeable is `CONFLICTING`, something has changed on main since the branch was created. Stop and investigate.

- [ ] **Step 9: Merge the PR**

Run:
```bash
gh pr merge fix/learning-engine-bypass --merge --delete-branch=false
```

Expected: merge succeeds. The `--delete-branch=false` flag keeps the branch around for rollback purposes.

Capture the merge commit SHA:
```bash
gh pr view fix/learning-engine-bypass --json mergeCommit --jq '.mergeCommit.oid'
```

- [ ] **Step 10: Pull the merge onto production**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && git fetch origin main && git pull --ff-only origin main 2>&1 | tail -15 && echo "---HEAD_NOW:" && git log --oneline -1'
```

Expected:
- `Fast-forward` visible in the pull output
- The HEAD line shows the merge commit SHA from Step 9
- No untracked file conflicts

If the pull fails with untracked file conflicts, remove the specific untracked files that match the committed paths (only if their SHA256 matches the committed versions) and retry. Do not force-pull.

- [ ] **Step 11: Rebuild the council container ONLY**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose build --no-cache council 2>&1 | tail -30'
```

Expected: the council image rebuilds cleanly. The build should complete in 2–5 minutes.

Note: we build ONLY the council image because the bypass only touches Python files that go into `Dockerfile.council`. The app and cron containers don't need rebuilding — their content hasn't changed.

- [ ] **Step 12: Restart the council container**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose up -d council 2>&1 | tail -10'
```

Expected: council container recreated. Status lines show `Container spike-trades-council  Recreated` → `Starting` → `Started` → eventually `Healthy`.

- [ ] **Step 13: Wait for council health**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'sleep 15 && cd /opt/spike-trades && docker compose ps --format "table {{.Service}}\t{{.Status}}"'
```

Expected: `council: Up X seconds (healthy)`. The `(healthy)` designation is the critical signal that the new container boot succeeded.

If the container is `Up` but not `(healthy)`, check the logs:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose logs council --tail 30'
```

A Python import error or traceback here means the bypass introduced a runtime error that py_compile didn't catch. Rollback immediately with Step 18 if this happens.

- [ ] **Step 14: Verify /health endpoint**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'curl -s http://localhost:8100/health'
```

Expected: JSON response with `"status":"ok"` and no Python tracebacks. Example shape:
```
{"status":"ok","council_running":false,"last_run_time":null,"last_run_error":null,"has_latest_output":true,"timestamp":"..."}
```

- [ ] **Step 15: Verify /learning-state endpoint has bypassed_mechanisms field**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'curl -s http://localhost:8100/learning-state'
```

Expected: JSON response containing `"bypassed_mechanisms":["Dynamic Stage Weights","Prompt Accuracy Context"]` and `"current_stage_weights":{"1":0.15,"2":0.2,"3":0.3,"4":0.35}`.

If the response still shows `"current_stage_weights":{"1":0.25,"2":0.25,"3":0.25,"4":0.25}` or omits `bypassed_mechanisms`, the deploy didn't pick up the new code. Check:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'docker image inspect spike-trades-council --format "{{.Created}}"'
```
If the image timestamp is older than a few minutes, the rebuild didn't happen or the up -d didn't pick up the new image.

- [ ] **Step 16: Database parity check (local execution)**

Run:
```bash
./scripts/phase1_snapshot.sh post_le_bypass
./scripts/phase1_db_parity.sh
```

Expected:
- Snapshot saved to `scripts/phase1_snapshot_post_le_bypass.txt`
- **Wait — parity check compares `pre` vs `post`, not `pre` vs `post_le_bypass`.** The `phase1_db_parity.sh` script is hardcoded to read `post.txt`. So instead, diff manually:

```bash
diff <(grep -v "^snapshot_taken_at" scripts/phase1_snapshot_post.txt) <(grep -v "^snapshot_taken_at" scripts/phase1_snapshot_post_le_bypass.txt) && echo "PARITY_HELD"
```

Expected: `PARITY_HELD`. All 13 metric rows identical between the T+0 post-deploy snapshot (from Phase 1 Task 11) and the post-LE-bypass snapshot. No rows added, no rows changed.

- [ ] **Step 17: Commit the post-bypass snapshot to the branch**

Run:
```bash
git add scripts/phase1_snapshot_post_le_bypass.txt
git commit -m "$(cat <<'EOF'
chore(phase1): post-LE-bypass database parity proof

Captured after the LE bypass PR deployed to production. Row counts
are byte-identical to Phase 1 Task 11's T+0 post-deploy snapshot,
proving the bypass deploy wrote zero database rows.

Next expected row count changes are from Wednesday 2026-04-08
13:45 UTC natural council cron fire — those are production behavior,
not Phase 1 drift, and are Task 12's concern.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin fix/learning-engine-bypass
```

Wait — the branch may already be merged at this point. In that case, commit this to a new tiny follow-up branch or to main directly via a cherry-pick. The simpler approach: commit this snapshot file as a direct push to `main` via a new micro-PR, or just skip the commit and keep the snapshot file as a local reference.

**Decision for Step 17:** Skip the git commit. Leave `scripts/phase1_snapshot_post_le_bypass.txt` as a local artifact referenced in the PR body. Do not attempt to push it upstream.

- [ ] **Step 18: (Rollback only — DO NOT run unless something above failed)**

If any of Steps 13–16 revealed a runtime failure after deploy, execute the rollback:

```bash
# 1. Revert the merge commit on main (get SHA from Step 9's capture)
MERGE_SHA=$(gh pr view fix/learning-engine-bypass --json mergeCommit --jq '.mergeCommit.oid')
git checkout main
git pull origin main
git revert --no-edit $MERGE_SHA
git push origin main

# 2. Pull revert onto production
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && git pull origin main'

# 3. Rebuild and restart council
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose build --no-cache council && docker compose up -d council'

# 4. Verify container returns to (healthy)
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'sleep 15 && cd /opt/spike-trades && docker compose ps --format "table {{.Service}}\t{{.Status}}"'

# 5. Verify /learning-state no longer has bypassed_mechanisms field
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'curl -s http://localhost:8100/learning-state | python3 -m json.tool | grep -i bypass || echo "BYPASS_FIELD_GONE"'
```

Report the rollback outcome to the user. Do not re-attempt the deploy without understanding what went wrong.

---

## Self-Review (run before handing off to execution)

After writing this plan, verify against the spec:

1. **Spec Section 1 "In scope" items 1–5 all have a task?**
   - Item 1 (line 2122 stage_weights call) → Task 1 ✓
   - Item 2 (line 2140 adjustments flag) → Task 1 Step 4 ✓
   - Item 3 (lines 1565/1642/1730/1866 prompt_context calls) → Task 2 ✓
   - Item 4 (line 4830 result_dict call) → Task 3 ✓
   - Item 5 (/learning-state bypassed_mechanisms field) → Task 4 ✓

2. **No placeholders?** Scanned for TBD/TODO/FIXME — zero found.

3. **Internal consistency?** Task 5 references bypass marker count "6 in council brain, 1 in api_server" — verify against Tasks 1+2+3+4:
   - Task 1: adds 1 "LE BYPASS (2026-04-08)" marker at line 2122
   - Task 2: adds 4 "LE BYPASS (2026-04-08)" markers at lines 1565/1642/1730/1866
   - Task 3: adds 1 "LE BYPASS (2026-04-08)" marker at line 4830
   - Total in `canadian_llm_council_brain.py`: **6** ✓
   - Task 4: adds 1 "LE BYPASS (2026-04-08)" marker in the api_server.py docstring
   - Total in `api_server.py`: **1** ✓

4. **Deploy timing preserved?** Task 5 explicitly ties the deploy to before Wed 13:45 UTC. Yes.

5. **Rollback path documented?** Task 5 Step 18 covers it. Yes.

6. **Phase 1 implications acknowledged?** Task 5 mentions Phase 1 T+24h observability as a separate concern. Yes.
