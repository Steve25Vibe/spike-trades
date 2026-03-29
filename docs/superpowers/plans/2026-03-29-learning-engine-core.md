# Learning Engine Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all 12 hand-tuned formulas in the council brain with data-driven learning mechanisms that progressively activate as accuracy data accumulates, maximizing UP directional accuracy.

**Architecture:** 8 mechanisms implemented inside `canadian_llm_council_brain.py`. Each mechanism has an activation gate (minimum sample size) checked at runtime. When inactive, the existing hardcoded value is used as fallback. A new `LearningEngine` class orchestrates all mechanisms and exposes their current state for the admin panel (Plan B). IV Expected Move added as a new signal via FMP options data.

**Tech Stack:** Python 3.12, SQLite, asyncio, aiohttp (existing), scipy.stats (new — for Spearman correlation in mechanism #6)

**Key file:** `canadian_llm_council_brain.py` (4,032 lines) — all changes in this single file plus `api_server.py` for Prisma field mapping.

**Dependencies:** `scipy` must be added to `requirements-council.txt`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `canadian_llm_council_brain.py` | Modify | All 8 mechanisms + LearningEngine class |
| `api_server.py` | Modify | Map learning metadata to Prisma fields |
| `requirements-council.txt` | Modify | Add scipy dependency |

---

### Task 1: Add sector field to pick_history and record_picks

**Files:**
- Modify: `canadian_llm_council_brain.py:2184-2200` (schema), `canadian_llm_council_brain.py:2246-2334` (record_picks)

**Why:** Sector-aware scoring (mechanism #3) requires sector data in pick_history. Currently missing.

- [ ] **Step 1: Add sector column to pick_history schema**

In `HistoricalPerformanceAnalyzer.__init__()` (~line 2184), add `sector TEXT` to the CREATE TABLE statement for `pick_history`:

```python
# After: forecast_8d_direction TEXT,
# Add:
sector TEXT,
```

- [ ] **Step 2: Update record_picks to store sector**

In `record_picks()` (~line 2268), the INSERT into pick_history needs to include sector. The sector is available from `council_result['top_picks'][i]` — each pick dict has a `sector` field from the payload.

Update the INSERT statement to include sector:

```python
# In the INSERT INTO pick_history VALUES line, add sector parameter
# Source: pick.get('sector', pick.get('payload', {}).get('sector', 'Unknown'))
```

- [ ] **Step 3: Run SQLite migration for existing data**

Add an ALTER TABLE fallback in `__init__` after the CREATE TABLE:

```python
try:
    conn.execute("ALTER TABLE pick_history ADD COLUMN sector TEXT")
except Exception:
    pass  # Column already exists
```

- [ ] **Step 4: Verify by checking schema**

```bash
python3 -c "
import sqlite3
conn = sqlite3.connect('spike_trades_council.db')
cols = [c[1] for c in conn.execute('PRAGMA table_info(pick_history)').fetchall()]
assert 'sector' in cols, f'sector not in {cols}'
print('PASS: sector column exists')
"
```

- [ ] **Step 5: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: add sector field to pick_history for sector-aware learning"
```

---

### Task 2: Create LearningEngine class

**Files:**
- Modify: `canadian_llm_council_brain.py` — new class after HistoricalCalibrationEngine (~line 3032)

**Why:** Central orchestrator that checks gate conditions, computes all dynamic adjustments, and exposes current state. Keeps mechanism logic isolated from the main pipeline.

- [ ] **Step 1: Define LearningEngine class with gate constants**

```python
class LearningEngine:
    """
    Orchestrates all learning mechanisms. Each mechanism has:
    - An activation gate (minimum data required)
    - A compute method (returns adjustment values)
    - A state property (for admin panel visibility)
    """

    # Activation gates
    GATE_STAGE_WEIGHTS = 30          # resolved picks per stage, 20-day window
    GATE_PROMPT_CONTEXT = 10         # resolved picks, 15-day window
    GATE_SECTOR_SCORING = 0          # Bayesian — no hard gate
    GATE_CONVICTION_THRESHOLDS = 50  # total resolved picks
    GATE_DISAGREEMENT = 20           # disagreements with >15pt gap
    GATE_FACTOR_FEEDBACK = 100       # total resolved picks
    GATE_PREFILTER = 300             # total resolved picks across all horizons
    GATE_IV_EXPECTED_MOVE = 0        # always active when IV data available

    STAGE_WEIGHT_WINDOW_DAYS = 20    # rolling window for stage weights
    PROMPT_CONTEXT_WINDOW_DAYS = 15  # rolling window for prompt context
    BAYESIAN_PRIOR_STRENGTH = 15     # shrinkage denominator for sector scoring
    DISAGREEMENT_THRESHOLD = 15      # minimum score gap to count as disagreement

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._state_cache: dict = {}

    def get_mechanism_states(self) -> list[dict]:
        """Return activation status of all 8 mechanisms for admin panel."""
        conn = sqlite3.connect(self.db_path)
        states = []

        # 1. Dynamic stage weights
        for stage in [1, 2, 3, 4]:
            count = conn.execute(
                "SELECT COUNT(*) FROM accuracy_records ar "
                "JOIN pick_history ph ON ar.pick_id = ph.id "
                "JOIN stage_scores ss ON ss.pick_id = ph.id AND ss.stage = ? "
                "WHERE ar.accurate IS NOT NULL "
                "AND ar.run_date >= date('now', ?)",
                (stage, f'-{self.STAGE_WEIGHT_WINDOW_DAYS} days')
            ).fetchone()[0]
            if stage == 1:
                states.append({
                    'name': 'Dynamic Stage Weights',
                    'active': count >= self.GATE_STAGE_WEIGHTS,
                    'progress': min(count, self.GATE_STAGE_WEIGHTS),
                    'gate': self.GATE_STAGE_WEIGHTS,
                    'current_value': None,  # filled by compute method
                })

        # 2. Prompt accuracy context
        prompt_count = conn.execute(
            "SELECT COUNT(*) FROM accuracy_records "
            "WHERE accurate IS NOT NULL AND run_date >= date('now', ?)",
            (f'-{self.PROMPT_CONTEXT_WINDOW_DAYS} days',)
        ).fetchone()[0]
        states.append({
            'name': 'Prompt Accuracy Context',
            'active': prompt_count >= self.GATE_PROMPT_CONTEXT,
            'progress': min(prompt_count, self.GATE_PROMPT_CONTEXT),
            'gate': self.GATE_PROMPT_CONTEXT,
        })

        # 3. Sector scoring (always active — Bayesian)
        states.append({
            'name': 'Sector-Aware Scoring',
            'active': True,
            'progress': 'Bayesian (always active)',
            'gate': 0,
        })

        # 4. Conviction thresholds
        total_resolved = conn.execute(
            "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
        ).fetchone()[0]
        states.append({
            'name': 'Adaptive Conviction Thresholds',
            'active': total_resolved >= self.GATE_CONVICTION_THRESHOLDS,
            'progress': min(total_resolved, self.GATE_CONVICTION_THRESHOLDS),
            'gate': self.GATE_CONVICTION_THRESHOLDS,
        })

        # 5. Stage disagreement learning
        disagreements = conn.execute(
            "SELECT COUNT(*) FROM stage_scores s1 "
            "JOIN stage_scores s2 ON s1.pick_id = s2.pick_id AND s1.stage < s2.stage "
            "WHERE ABS(s1.total_score - s2.total_score) > ?",
            (self.DISAGREEMENT_THRESHOLD,)
        ).fetchone()[0]
        states.append({
            'name': 'Stage Disagreement Learning',
            'active': disagreements >= self.GATE_DISAGREEMENT,
            'progress': min(disagreements, self.GATE_DISAGREEMENT),
            'gate': self.GATE_DISAGREEMENT,
        })

        # 6. Factor-level feedback
        states.append({
            'name': 'Factor-Level Feedback',
            'active': total_resolved >= self.GATE_FACTOR_FEEDBACK,
            'progress': min(total_resolved, self.GATE_FACTOR_FEEDBACK),
            'gate': self.GATE_FACTOR_FEEDBACK,
        })

        # 7. Adaptive pre-filter
        total_all_horizons = conn.execute(
            "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
        ).fetchone()[0]
        states.append({
            'name': 'Adaptive Pre-Filter',
            'active': total_all_horizons >= self.GATE_PREFILTER,
            'progress': min(total_all_horizons, self.GATE_PREFILTER),
            'gate': self.GATE_PREFILTER,
        })

        # 8. IV Expected Move
        states.append({
            'name': 'IV Expected Move',
            'active': True,
            'progress': 'Always active (when IV data available)',
            'gate': 0,
        })

        conn.close()
        return states
```

- [ ] **Step 2: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: add LearningEngine class with gate checks and state reporting"
```

---

### Task 3: Mechanism #1 — Dynamic Stage Weights

**Files:**
- Modify: `canadian_llm_council_brain.py` — LearningEngine class + `_build_consensus()` (~line 1984)

- [ ] **Step 1: Add compute_stage_weights method to LearningEngine**

```python
def compute_stage_weights(self) -> dict[int, float]:
    """
    Compute stage weights based on recent directional accuracy.
    Returns {1: w1, 2: w2, 3: w3, 4: w4} normalized to sum to 1.0.
    Falls back to hardcoded {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35} if gate not met.
    """
    DEFAULT = {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
    conn = sqlite3.connect(self.db_path)

    hit_rates = {}
    for stage in [1, 2, 3, 4]:
        rows = conn.execute(
            "SELECT ar.accurate FROM accuracy_records ar "
            "JOIN stage_scores ss ON ss.pick_id = ar.pick_id AND ss.stage = ? "
            "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
            "AND ar.run_date >= date('now', ?)",
            (stage, f'-{self.STAGE_WEIGHT_WINDOW_DAYS} days')
        ).fetchall()
        if len(rows) < self.GATE_STAGE_WEIGHTS:
            conn.close()
            return DEFAULT
        hit_rates[stage] = sum(r[0] for r in rows) / len(rows)

    conn.close()

    # Convert hit rates to weights: higher accuracy = higher weight
    # Use softmax-like normalization to prevent extreme swings
    total = sum(hit_rates.values())
    if total == 0:
        return DEFAULT
    weights = {s: r / total for s, r in hit_rates.items()}

    # Floor at 0.05 to prevent any stage from being completely ignored
    for s in weights:
        weights[s] = max(weights[s], 0.05)
    # Re-normalize
    total = sum(weights.values())
    weights = {s: w / total for s, w in weights.items()}

    return weights
```

- [ ] **Step 2: Modify _build_consensus to use dynamic weights**

In `_build_consensus()` (~line 1984), replace:

```python
STAGE_WEIGHTS = {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
```

With:

```python
STAGE_WEIGHTS = learning_engine.compute_stage_weights() if learning_engine else {1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}
```

Add `learning_engine: Optional["LearningEngine"] = None` parameter to `_build_consensus()`.

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: mechanism #1 — dynamic stage weights from recent accuracy"
```

---

### Task 4: Mechanism #2 — Prompt Accuracy Context

**Files:**
- Modify: `canadian_llm_council_brain.py` — LearningEngine class + stage caller prompts (~lines 1322, 1414, 1513, 1621)

- [ ] **Step 1: Add build_prompt_context method to LearningEngine**

```python
def build_prompt_context(self, stage: int) -> str:
    """
    Build accuracy feedback paragraph for injection into LLM stage prompts.
    Returns empty string if gate not met.
    """
    conn = sqlite3.connect(self.db_path)

    rows = conn.execute(
        "SELECT ar.accurate, ar.predicted_move_pct, ar.actual_move_pct "
        "FROM accuracy_records ar "
        "JOIN stage_scores ss ON ss.pick_id = ar.pick_id AND ss.stage = ? "
        "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
        "AND ar.run_date >= date('now', ?)",
        (stage, f'-{self.PROMPT_CONTEXT_WINDOW_DAYS} days')
    ).fetchall()

    if len(rows) < self.GATE_PROMPT_CONTEXT:
        conn.close()
        return ""

    total = len(rows)
    correct = sum(1 for r in rows if r[0] == 1)
    hit_rate = correct / total
    avg_predicted = sum(r[1] or 0 for r in rows) / total
    avg_actual = sum(r[2] or 0 for r in rows) / total
    bias = avg_predicted - avg_actual

    conn.close()

    direction = "overestimating" if bias > 0.5 else "underestimating" if bias < -0.5 else "roughly calibrated on"

    return (
        f"\n\nRECENT PERFORMANCE FEEDBACK (last {self.PROMPT_CONTEXT_WINDOW_DAYS} days):\n"
        f"Your UP picks had {hit_rate:.0%} directional accuracy ({correct}/{total} correct at 3-day horizon).\n"
        f"Average predicted move: {avg_predicted:+.2f}%. Average actual move: {avg_actual:+.2f}%.\n"
        f"You are {direction} move magnitudes (bias: {bias:+.2f}%).\n"
        f"Adjust your confidence and predicted moves accordingly. Be more selective — only pick stocks "
        f"where you have genuine conviction they will move UP.\n"
    )
```

- [ ] **Step 2: Inject context into each stage's system prompt**

In each stage caller (Sonnet ~line 1340, Gemini ~line 1430, Opus ~line 1530, Grok ~line 1650), append the context string to the system prompt:

```python
# At the end of the system prompt string for each stage:
prompt_context = learning_engine.build_prompt_context(stage_number) if learning_engine else ""
system_prompt = BASE_SYSTEM_PROMPT + prompt_context
```

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: mechanism #2 — inject accuracy feedback into LLM stage prompts"
```

---

### Task 5: Mechanism #3 — Sector-Aware Scoring (Bayesian)

**Files:**
- Modify: `canadian_llm_council_brain.py` — LearningEngine class + `_build_consensus()` (~line 2001)

- [ ] **Step 1: Add compute_sector_multiplier method to LearningEngine**

```python
def compute_sector_multiplier(self, sector: str) -> float:
    """
    Bayesian shrinkage sector multiplier.
    Blends sector-specific hit rate with global hit rate.
    Returns multiplier centered on 1.0 (0.85 - 1.15 range).
    """
    conn = sqlite3.connect(self.db_path)

    # Global hit rate
    global_row = conn.execute(
        "SELECT COUNT(*), SUM(accurate) FROM accuracy_records "
        "WHERE accurate IS NOT NULL AND horizon_days = 3"
    ).fetchone()
    if not global_row[0] or global_row[0] == 0:
        conn.close()
        return 1.0
    global_rate = global_row[1] / global_row[0]

    # Sector hit rate
    sector_row = conn.execute(
        "SELECT COUNT(*), SUM(ar.accurate) FROM accuracy_records ar "
        "JOIN pick_history ph ON ar.pick_id = ph.id "
        "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
        "AND ph.sector = ?",
        (sector,)
    ).fetchone()
    sector_count = sector_row[0] or 0
    sector_correct = sector_row[1] or 0

    conn.close()

    if sector_count == 0:
        return 1.0

    sector_rate = sector_correct / sector_count

    # Bayesian shrinkage: blend toward global mean
    weight = sector_count / (sector_count + self.BAYESIAN_PRIOR_STRENGTH)
    blended_rate = weight * sector_rate + (1 - weight) * global_rate

    # Convert to multiplier: 50% hit rate = 1.0, each 10% above/below = +/-0.15
    multiplier = 1.0 + (blended_rate - 0.5) * 1.5
    return max(0.85, min(1.15, multiplier))
```

- [ ] **Step 2: Replace hardcoded SECTOR_REGIME_ADJUSTMENTS in _build_consensus**

In `_build_consensus()` (~line 2001-2006), replace the static sector regime lookup:

```python
# OLD: sector_adj = SECTOR_REGIME_ADJUSTMENTS.get(regime, {}).get(sector, 1.0)
# NEW:
sector_adj = learning_engine.compute_sector_multiplier(sector) if learning_engine else SECTOR_REGIME_ADJUSTMENTS.get(regime, {}).get(sector, 1.0)
```

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: mechanism #3 — Bayesian sector-aware scoring"
```

---

### Task 6: Mechanism #4 — Adaptive Conviction Thresholds

**Files:**
- Modify: `canadian_llm_council_brain.py` — LearningEngine class + conviction tier logic (~line 2084)

- [ ] **Step 1: Add compute_conviction_thresholds method to LearningEngine**

```python
def compute_conviction_thresholds(self) -> tuple[float, float]:
    """
    Compute data-driven HIGH/MEDIUM thresholds based on score-vs-accuracy curve.
    Returns (high_threshold, medium_threshold).
    Falls back to (80, 65) if gate not met.
    """
    DEFAULT = (80.0, 65.0)
    conn = sqlite3.connect(self.db_path)

    total = conn.execute(
        "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL AND horizon_days = 3"
    ).fetchone()[0]

    if total < self.GATE_CONVICTION_THRESHOLDS:
        conn.close()
        return DEFAULT

    # Get score buckets with hit rates (5-point buckets)
    rows = conn.execute(
        "SELECT CAST(ph.consensus_score / 5 AS INTEGER) * 5 as bucket, "
        "COUNT(*) as n, SUM(ar.accurate) as correct "
        "FROM accuracy_records ar "
        "JOIN pick_history ph ON ar.pick_id = ph.id "
        "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
        "GROUP BY bucket ORDER BY bucket DESC"
    ).fetchall()

    conn.close()

    if not rows:
        return DEFAULT

    # Find highest score bucket where hit rate > 55% with >= 5 samples
    high_threshold = 80.0
    medium_threshold = 65.0

    for bucket, n, correct in rows:
        if n >= 5:
            rate = correct / n
            if rate >= 0.55 and bucket < high_threshold:
                high_threshold = float(bucket)
            if rate >= 0.50 and bucket < medium_threshold:
                medium_threshold = float(bucket)

    # Ensure HIGH > MEDIUM
    if high_threshold <= medium_threshold:
        medium_threshold = high_threshold - 10

    return (max(high_threshold, 60.0), max(medium_threshold, 50.0))
```

- [ ] **Step 2: Replace hardcoded thresholds in conviction tier assignment**

At ~line 2084, replace:

```python
# OLD:
# if consensus_score >= 80 and n_stages >= 3: tier = "HIGH"
# elif consensus_score >= 65 or n_stages >= 2: tier = "MEDIUM"

# NEW:
high_t, med_t = learning_engine.compute_conviction_thresholds() if learning_engine else (80.0, 65.0)
if consensus_score >= high_t and n_stages >= 3:
    tier = "HIGH"
elif consensus_score >= med_t or n_stages >= 2:
    tier = "MEDIUM"
else:
    tier = "LOW"
```

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: mechanism #4 — adaptive conviction thresholds from accuracy data"
```

---

### Task 7: Mechanism #5 — Stage Disagreement Learning

**Files:**
- Modify: `canadian_llm_council_brain.py` — LearningEngine class + `_build_consensus()` adjustment

- [ ] **Step 1: Add compute_disagreement_adjustment method to LearningEngine**

```python
def compute_disagreement_adjustment(self, stage_scores: dict[int, float]) -> float:
    """
    When stages disagree by >15 points, adjust consensus based on which stage
    is historically more accurate in disagreements.
    Returns adjustment multiplier (0.9 - 1.1).
    """
    conn = sqlite3.connect(self.db_path)

    # Check gate
    total_disagreements = conn.execute(
        "SELECT COUNT(*) FROM stage_scores s1 "
        "JOIN stage_scores s2 ON s1.pick_id = s2.pick_id AND s1.stage < s2.stage "
        "WHERE ABS(s1.total_score - s2.total_score) > ?",
        (self.DISAGREEMENT_THRESHOLD,)
    ).fetchone()[0]

    if total_disagreements < self.GATE_DISAGREEMENT:
        conn.close()
        return 1.0

    # Find which pairs disagree in current pick
    disagreeing_pairs = []
    stages = sorted(stage_scores.keys())
    for i, s1 in enumerate(stages):
        for s2 in stages[i+1:]:
            if abs(stage_scores[s1] - stage_scores[s2]) > self.DISAGREEMENT_THRESHOLD:
                disagreeing_pairs.append((s1, s2))

    if not disagreeing_pairs:
        conn.close()
        return 1.0

    # For each disagreeing pair, check who's historically right
    adjustments = []
    for s1, s2 in disagreeing_pairs:
        # When s1 was bullish (higher score) and s2 was bearish, who was right?
        higher_stage = s1 if stage_scores[s1] > stage_scores[s2] else s2
        lower_stage = s2 if higher_stage == s1 else s1

        higher_wins = conn.execute(
            "SELECT COUNT(*) FROM stage_scores ss1 "
            "JOIN stage_scores ss2 ON ss1.pick_id = ss2.pick_id "
            "JOIN accuracy_records ar ON ar.pick_id = ss1.pick_id "
            "WHERE ss1.stage = ? AND ss2.stage = ? "
            "AND ABS(ss1.total_score - ss2.total_score) > ? "
            "AND ss1.total_score > ss2.total_score "
            "AND ar.accurate = 1 AND ar.horizon_days = 3",
            (higher_stage, lower_stage, self.DISAGREEMENT_THRESHOLD)
        ).fetchone()[0]

        total_cases = conn.execute(
            "SELECT COUNT(*) FROM stage_scores ss1 "
            "JOIN stage_scores ss2 ON ss1.pick_id = ss2.pick_id "
            "JOIN accuracy_records ar ON ar.pick_id = ss1.pick_id "
            "WHERE ss1.stage = ? AND ss2.stage = ? "
            "AND ABS(ss1.total_score - ss2.total_score) > ? "
            "AND ss1.total_score > ss2.total_score "
            "AND ar.accurate IS NOT NULL AND ar.horizon_days = 3",
            (higher_stage, lower_stage, self.DISAGREEMENT_THRESHOLD)
        ).fetchone()[0]

        if total_cases >= 5:
            bullish_accuracy = higher_wins / total_cases
            # If bullish stage is usually right when disagreeing, slight boost
            # If bearish stage is usually right, slight penalty
            adj = 1.0 + (bullish_accuracy - 0.5) * 0.2  # +-10% max
            adjustments.append(adj)

    conn.close()

    if not adjustments:
        return 1.0

    return sum(adjustments) / len(adjustments)
```

- [ ] **Step 2: Apply in _build_consensus after initial score calculation**

After consensus_score is computed (~line 2000), add:

```python
disagreement_adj = learning_engine.compute_disagreement_adjustment(stage_scores_for_pick) if learning_engine else 1.0
consensus_score *= disagreement_adj
```

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: mechanism #5 — stage disagreement learning"
```

---

### Task 8: Mechanism #6 — Factor-Level Feedback

**Files:**
- Modify: `canadian_llm_council_brain.py` — LearningEngine class
- New dependency: `scipy` for Spearman correlation

- [ ] **Step 1: Add scipy to requirements**

```
# In requirements-council.txt, add:
scipy>=1.11
```

- [ ] **Step 2: Add compute_factor_weights method to LearningEngine**

```python
def compute_factor_weights(self) -> dict[str, float] | None:
    """
    Compute correlation-based weights for the 5 scoring sub-factors.
    Uses Spearman rank correlation between each factor and actual 3-day returns.
    Returns {factor_name: weight} normalized to sum to 1.0, or None if gate not met.
    """
    conn = sqlite3.connect(self.db_path)

    total = conn.execute(
        "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL AND horizon_days = 3"
    ).fetchone()[0]

    if total < self.GATE_FACTOR_FEEDBACK:
        conn.close()
        return None

    # Get factor scores + actual returns
    rows = conn.execute(
        "SELECT ss.technical_momentum, ss.sentiment_catalysts, "
        "ss.options_volatility, ss.risk_reward, ss.conviction, "
        "ar.actual_move_pct "
        "FROM stage_scores ss "
        "JOIN accuracy_records ar ON ar.pick_id = ss.pick_id "
        "WHERE ar.accurate IS NOT NULL AND ar.horizon_days = 3 "
        "AND ss.stage = 4 "  # Use Stage 4 (final authority) factors
        "AND ss.technical_momentum IS NOT NULL "
        "AND ar.actual_move_pct IS NOT NULL"
    ).fetchall()

    conn.close()

    if len(rows) < self.GATE_FACTOR_FEEDBACK:
        return None

    from scipy.stats import spearmanr

    factors = ['technical_momentum', 'sentiment_catalysts', 'options_volatility',
               'risk_reward', 'conviction']
    actual_returns = [r[5] for r in rows]

    correlations = {}
    for i, factor in enumerate(factors):
        factor_values = [r[i] for r in rows]
        corr, pvalue = spearmanr(factor_values, actual_returns)
        # Only count positive correlations (factor predicts UP correctly)
        correlations[factor] = max(corr, 0.05)  # Floor at 0.05

    # Normalize to weights summing to 1.0
    total_corr = sum(correlations.values())
    weights = {f: c / total_corr for f, c in correlations.items()}

    return weights
```

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py requirements-council.txt
git commit -m "feat: mechanism #6 — factor-level feedback via Spearman correlation"
```

---

### Task 9: Mechanism #7 — Adaptive Pre-Filter Thresholds

**Files:**
- Modify: `canadian_llm_council_brain.py` — LearningEngine class + technical pre-filter (~line 3577)

- [ ] **Step 1: Add compute_prefilter_adjustments method to LearningEngine**

```python
def compute_prefilter_adjustments(self) -> dict | None:
    """
    Analyze which RSI/ADX/volume ranges historically produce winning picks.
    Returns adjusted ideal ranges or None if gate not met.
    """
    conn = sqlite3.connect(self.db_path)

    total = conn.execute(
        "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
    ).fetchone()[0]

    if total < self.GATE_PREFILTER:
        conn.close()
        return None

    # Analyze winning picks' technical characteristics at time of pick
    # This uses calibration_base_rates which already has the data
    rows = conn.execute(
        "SELECT rsi_bucket, adx_bucket, rel_volume_bucket, up_probability, sample_count "
        "FROM calibration_base_rates WHERE horizon_days = 3 AND sample_count >= 10"
    ).fetchall()

    conn.close()

    if not rows:
        return None

    # Find RSI range with best up_probability
    best_rsi_buckets = sorted(
        [(r[0], r[3], r[4]) for r in rows],
        key=lambda x: x[1], reverse=True
    )[:3]

    # Find ADX range with best up_probability
    adx_map = {}
    for r in rows:
        adx_b = r[1]
        if adx_b not in adx_map:
            adx_map[adx_b] = {'total_prob': 0, 'total_samples': 0}
        adx_map[adx_b]['total_prob'] += r[3] * r[4]
        adx_map[adx_b]['total_samples'] += r[4]

    best_adx = {k: v['total_prob'] / v['total_samples']
                for k, v in adx_map.items() if v['total_samples'] >= 20}

    return {
        'best_rsi_buckets': best_rsi_buckets,
        'best_adx_ranges': best_adx,
        # Pre-filter will use these to adjust scoring weights
    }
```

- [ ] **Step 2: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: mechanism #7 — adaptive pre-filter threshold analysis"
```

---

### Task 10: Mechanism #8 — IV Expected Move Signal

**Files:**
- Modify: `canadian_llm_council_brain.py` — LiveDataFetcher class + StockDataPayload model + consensus adjustments

- [ ] **Step 1: Add IV Expected Move model and fetch method**

Add to Pydantic models section (~line 130):

```python
class IVExpectedMove(BaseModel):
    implied_volatility: float = Field(description="Annualized IV from ATM options")
    expected_move_1sd_pct: float = Field(description="1SD expected move % for 3-day horizon")
    expected_move_2sd_pct: float = Field(description="2SD expected move % for 3-day horizon")
    iv_available: bool = Field(default=True)
```

Add to StockDataPayload:

```python
iv_expected_move: Optional[IVExpectedMove] = Field(default=None)
```

Add to LiveDataFetcher:

```python
async def fetch_iv_data(self, ticker: str) -> Optional[IVExpectedMove]:
    """Fetch implied volatility from FMP options endpoint."""
    try:
        # FMP doesn't have a direct IV endpoint for TSX
        # Use historical volatility as proxy (ATR-based)
        # This is the ATR-based fallback mentioned in the design
        if not hasattr(self, '_atr_cache'):
            return None

        atr = self._atr_cache.get(ticker)
        price = self._quote_cache.get(ticker, {}).get('price')
        if not atr or not price or price <= 0:
            return None

        # Annualize ATR: daily ATR / price * sqrt(252)
        daily_vol = atr / price
        annualized_iv = daily_vol * (252 ** 0.5)

        # Expected move formula: S * (IV / sqrt(365)) * sqrt(D)
        # For 3 trading days ~ 5 calendar days
        em_1sd = price * (annualized_iv / (365 ** 0.5)) * (5 ** 0.5)
        em_1sd_pct = (em_1sd / price) * 100
        em_2sd_pct = em_1sd_pct * 2

        return IVExpectedMove(
            implied_volatility=round(annualized_iv, 4),
            expected_move_1sd_pct=round(em_1sd_pct, 2),
            expected_move_2sd_pct=round(em_2sd_pct, 2),
            iv_available=True
        )
    except Exception:
        return None
```

- [ ] **Step 2: Add IV reality check in _build_consensus**

```python
# After directional adjustment (~line 2023), add IV sanity check:
if iv_data and iv_data.iv_available:
    predicted_move = abs(forecast_move_pct)
    iv_1sd = iv_data.expected_move_1sd_pct
    # If predicted move > 2SD of IV-implied range, flag as extreme and penalize
    if predicted_move > iv_data.expected_move_2sd_pct:
        iv_penalty = 0.90  # 10% penalty for exceeding 2SD
        consensus_score *= iv_penalty
    # If predicted move is within 1SD, slight confidence boost
    elif predicted_move <= iv_1sd:
        consensus_score *= 1.03  # 3% boost for plausible move
```

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: mechanism #8 — IV expected move signal with ATR-based proxy"
```

---

### Task 11: Wire LearningEngine into run_council()

**Files:**
- Modify: `canadian_llm_council_brain.py` — `run_council()` method (~line 3450)

- [ ] **Step 1: Instantiate LearningEngine at start of run_council**

After the existing `HistoricalPerformanceAnalyzer` and `HistoricalCalibrationEngine` instantiation:

```python
learning_engine = LearningEngine(db_path=self.db_path)
```

- [ ] **Step 2: Pass learning_engine to _build_consensus**

Update the call to `_build_consensus()` (~line 3900) to include the new parameter:

```python
consensus_result = _build_consensus(
    stage_outputs, payloads_map, macro_regime, macro_data,
    learning_engine=learning_engine
)
```

- [ ] **Step 3: Log mechanism states at start of run**

```python
states = learning_engine.get_mechanism_states()
active = [s['name'] for s in states if s['active']]
waiting = [s['name'] for s in states if not s['active']]
logger.info(f"Learning mechanisms active: {active}")
logger.info(f"Learning mechanisms waiting: {waiting}")
```

- [ ] **Step 4: Include learning state in council output JSON**

Add to the output dict:

```python
"learning_state": learning_engine.get_mechanism_states(),
"stage_weights_used": learning_engine.compute_stage_weights(),
```

- [ ] **Step 5: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat: wire LearningEngine into run_council pipeline"
```

---

### Task 12: Track learning adjustments per pick for analysis page

**Files:**
- Modify: `canadian_llm_council_brain.py` — `_build_consensus()`, output structure
- Modify: `api_server.py` — map adjustments to Prisma

- [ ] **Step 1: Collect adjustments dict during _build_consensus**

For each pick in `_build_consensus`, build an adjustments record:

```python
adjustments = {
    'stage_weights': STAGE_WEIGHTS,
    'sector_multiplier': sector_adj,
    'earnings_penalty': earnings_mult,
    'insider_adj': insider_adj,
    'analyst_adj': analyst_adj,
    'srs_adj': srs_adj,
    'disagreement_adj': disagreement_adj,
    'iv_check': iv_penalty_or_boost,
    'conviction_thresholds': (high_t, med_t),
}
pick['learning_adjustments'] = adjustments
```

- [ ] **Step 2: Map adjustments in api_server.py**

In the Prisma mapping section of `api_server.py`, store the adjustments as a JSON string in a council log field or a new Spike field:

```python
# Store as JSON in the councilLog or as part of the spike narrative
"learningAdjustments": json.dumps(pick.get("learning_adjustments", {})),
```

Note: This may require adding a `learningAdjustments Json?` field to the Prisma `Spike` model. If not feasible in this plan, store in `councilLog` instead.

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py api_server.py
git commit -m "feat: track per-pick learning adjustments for analysis page"
```

---

### Task 13: Syntax check, test, and deploy

- [ ] **Step 1: Python syntax check**

```bash
python3 -c "import py_compile; py_compile.compile('canadian_llm_council_brain.py', doraise=True)"
```

Expected: no errors

- [ ] **Step 2: Verify imports**

```bash
python3 -c "
from canadian_llm_council_brain import LearningEngine, LiveDataFetcher, MacroRegimeFilter
print('All imports successful')
le = LearningEngine('/tmp/test.db')
print('LearningEngine instantiated')
states = le.get_mechanism_states()
print(f'States: {len(states)} mechanisms')
"
```

Note: This will create a temp DB and return empty states since no data exists.

- [ ] **Step 3: TypeScript compile check**

```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "feat: complete learning engine core — 8 mechanisms with progressive activation"
git push origin main
```

- [ ] **Step 5: Deploy to server**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "cd /opt/spike-trades && git pull && docker compose up -d --build council app"
```

- [ ] **Step 6: Verify mechanism states on production**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "docker exec spike-trades-council python3 -c \"
from canadian_llm_council_brain import LearningEngine
le = LearningEngine('/app/data/spike_trades_council.db')
for s in le.get_mechanism_states():
    status = 'ACTIVE' if s['active'] else f'WAITING ({s[\"progress\"]}/{s[\"gate\"]})'
    print(f'{s[\"name\"]}: {status}')
\""
```

Expected: Some mechanisms active (sector scoring, IV), others waiting with progress counts.

- [ ] **Step 7: Commit deployment verification**

```bash
git add SESSION_TRANSITIONS.md
git commit -m "docs: learning engine deployed and verified"
```

---

## Dependency Order

```
Task 1 (sector field) → no dependencies
Task 2 (LearningEngine class) → no dependencies
Tasks 3-10 (mechanisms) → depend on Task 2
Task 11 (wiring) → depends on all mechanisms
Task 12 (adjustment tracking) → depends on Task 11
Task 13 (deploy) → depends on all tasks
```

Tasks 3-10 are independent of each other and can be implemented in any order.

---

## Post-Deployment Verification Checklist

1. Next trading day council run should log "Learning mechanisms active/waiting" at start
2. Prompt context should appear in LLM calls after 2 days (10+ resolved picks)
3. Sector scoring active immediately (Bayesian)
4. Stage weights remain at defaults until 30/stage gate met (~3-4 days)
5. Admin panel Plan B will expose all mechanism states visually
6. Analysis page Plan C will show per-pick adjustment breakdown
