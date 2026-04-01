# API Cost Tracking + Model Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-stage token usage from LLM API responses, display a cost breakdown card on the Admin panel, and upgrade Sonnet/Opus models to 4.6.

**Architecture:** Modify the three LLM callers to return `(text, usage_dict)` tuples. Stage functions accumulate tokens across batches. `run_council()` writes token totals into `stage_metadata.token_usage` in the council output JSON. Admin panel reads this via `/latest-output` and computes costs client-side. Model strings updated from 4 to 4.6 for Sonnet and Opus.

**Tech Stack:** Python (Anthropic SDK, OpenAI SDK, Google GenAI SDK), TypeScript/React (Next.js 15)

**Spec:** `docs/superpowers/specs/2026-04-01-api-cost-tracking-design.md`

**Hard Constraints:**
- No database schema changes
- No existing historical data altered
- Every task tested before proceeding
- All existing functionality must continue working

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `canadian_llm_council_brain.py` | Modify | Caller tuple returns, token accumulation in stages, model upgrades, stage_metadata.token_usage |
| `api_server.py` | Modify | Update Spike It call sites for new tuple returns |
| `src/app/admin/page.tsx` | Modify | New Run Cost Breakdown card + pricing constant |
| Version string files (8 pages) | Modify | "Ver 3.2" → "Ver 3.5" |
| `FEATURES.md` | Modify | Ver 3.5 changelog |

---

## Task 1: Modify LLM Callers to Return Token Usage

**Files:**
- Modify: `canadian_llm_council_brain.py` (lines 1248-1371)

This task changes all three callers to return `(text, usage)` tuples. No other changes yet — call sites will break until Task 2 fixes them.

- [ ] **Step 1: Modify `_call_anthropic()` (lines 1248-1279)**

Replace the entire function with:

```python
async def _call_anthropic(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 8192,
    temperature: float = 0.3,
) -> tuple[str, dict]:
    """Call Anthropic Claude API using streaming with retry on rate limits.
    Returns (text, {"input_tokens": N, "output_tokens": N})."""
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    for attempt in range(4):
        try:
            chunks = []
            with client.messages.stream(
                model=model,
                max_tokens=max_tokens,
                temperature=temperature,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            ) as stream:
                for text in stream.text_stream:
                    chunks.append(text)
                # Capture usage from the final message before stream context exits
                final_message = stream.get_final_message()
                usage = {
                    "input_tokens": getattr(final_message.usage, "input_tokens", 0),
                    "output_tokens": getattr(final_message.usage, "output_tokens", 0),
                }
            return "".join(chunks), usage
        except anthropic.RateLimitError as e:
            wait = 60 * (attempt + 1)
            logger.warning(f"Anthropic {model} rate limited, waiting {wait}s (attempt {attempt + 1}/4)")
            await asyncio.sleep(wait)
        except Exception as e:
            logger.error(f"Anthropic {model} call failed: {e}")
            raise
    raise RuntimeError(f"Anthropic {model} rate limited after 4 retries")
```

- [ ] **Step 2: Modify `_call_gemini()` (lines 1296-1337)**

Replace the entire function with:

```python
async def _call_gemini(
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 8192,
    temperature: float = 0.3,
) -> tuple[str, dict]:
    """Call Google Gemini via Vertex AI with retry on transient failures.
    Returns (text, {"input_tokens": N, "output_tokens": N})."""
    from google import genai
    from google.genai import types

    gcp_project = os.getenv("GCP_PROJECT_ID", "gen-lang-client-0879620722")
    gcp_location = os.getenv("GCP_LOCATION", "global")
    client = genai.Client(vertexai=True, project=gcp_project, location=gcp_location)

    max_retries = 4
    for attempt in range(max_retries):
        try:
            resp = client.models.generate_content(
                model=model,
                contents=user_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    max_output_tokens=max_tokens,
                    temperature=temperature,
                    response_mime_type="application/json",
                    thinking_config=types.ThinkingConfig(
                        thinking_level=types.ThinkingLevel.LOW,
                    ),
                ),
            )
            usage = {"input_tokens": 0, "output_tokens": 0}
            if hasattr(resp, "usage_metadata") and resp.usage_metadata:
                usage["input_tokens"] = getattr(resp.usage_metadata, "prompt_token_count", 0) or 0
                usage["output_tokens"] = getattr(resp.usage_metadata, "candidates_token_count", 0) or 0
            return resp.text, usage
        except Exception as e:
            if _is_transient(e) and attempt < max_retries - 1:
                wait = min(30 * (2 ** attempt), 300)
                logger.warning(f"Gemini {model} transient error, retrying in {wait}s (attempt {attempt + 1}/{max_retries}): {e}")
                await asyncio.sleep(wait)
            else:
                logger.error(f"Gemini {model} call failed: {e}")
                raise
```

- [ ] **Step 3: Modify `_call_grok()` (lines 1340-1371)**

Replace the entire function with:

```python
async def _call_grok(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 8192,
    temperature: float = 0.3,
) -> tuple[str, dict]:
    """Call xAI Grok API (OpenAI-compatible) with retry on transient failures.
    Returns (text, {"input_tokens": N, "output_tokens": N})."""
    from openai import OpenAI
    client = OpenAI(api_key=api_key, base_url="https://api.x.ai/v1")
    max_retries = 4
    for attempt in range(max_retries):
        try:
            resp = client.chat.completions.create(
                model=model,
                max_tokens=max_tokens,
                temperature=temperature,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )
            usage = {"input_tokens": 0, "output_tokens": 0}
            if resp.usage:
                usage["input_tokens"] = getattr(resp.usage, "prompt_tokens", 0) or 0
                usage["output_tokens"] = getattr(resp.usage, "completion_tokens", 0) or 0
            return resp.choices[0].message.content, usage
        except Exception as e:
            if _is_transient(e) and attempt < max_retries - 1:
                wait = min(30 * (2 ** attempt), 300)
                logger.warning(f"Grok {model} transient error, retrying in {wait}s (attempt {attempt + 1}/{max_retries}): {e}")
                await asyncio.sleep(wait)
            else:
                logger.error(f"Grok {model} call failed: {e}")
                raise
```

- [ ] **Step 4: Verify syntax**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "import ast; ast.parse(open('canadian_llm_council_brain.py').read()); print('Syntax OK')"
```

Expected: `Syntax OK`

Note: The module will NOT import successfully yet because call sites expect a string, not a tuple. That's fixed in Task 2.

- [ ] **Step 5: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add canadian_llm_council_brain.py
git commit -m "feat(cost): LLM callers return (text, usage) tuples with token counts"
```

---

## Task 2: Update All Call Sites in Stage Functions

**Files:**
- Modify: `canadian_llm_council_brain.py` (stage functions)

Update every call site to unpack the tuple and accumulate tokens.

- [ ] **Step 1: Update Stage 1 (Sonnet) call site (~line 1481)**

Find:
```python
raw = await _call_anthropic(
    api_key=api_key,
    model="claude-sonnet-4-20250514",
```

Replace `raw = await _call_anthropic(` with `raw, _usage = await _call_anthropic(` at this call site.

Also, add a token accumulator at the top of the `run_stage1_sonnet` function (after the function signature and any initial variables):

```python
stage_tokens = {"model": "claude-sonnet-4-20250514", "input_tokens": 0, "output_tokens": 0}
```

And after the call, add:
```python
stage_tokens["input_tokens"] += _usage.get("input_tokens", 0)
stage_tokens["output_tokens"] += _usage.get("output_tokens", 0)
```

At the end of the function, change the return to include tokens. Find the existing return statement and change it to also return `stage_tokens`. If it currently returns `results`, change to `return results, stage_tokens`.

- [ ] **Step 2: Update Stage 2 (Gemini) call site (~line 1584)**

Same pattern. Find:
```python
raw = await _call_gemini(
    model=
```

Change to `raw, _usage = await _call_gemini(`.

Add accumulator at top of `run_stage2_gemini`:
```python
stage_tokens = {"model": gemini_model, "input_tokens": 0, "output_tokens": 0}
```

(Use the variable name for the gemini model, not a hardcoded string, since it comes from an env var.)

Add after call:
```python
stage_tokens["input_tokens"] += _usage.get("input_tokens", 0)
stage_tokens["output_tokens"] += _usage.get("output_tokens", 0)
```

Change return to: `return results, stage_tokens`

- [ ] **Step 3: Update Stage 3 (Opus) call site (~line 1690)**

Same pattern. Find:
```python
raw = await _call_anthropic(
    api_key=api_key,
    model="claude-opus-4-20250514",
```

Change to `raw, _usage = await _call_anthropic(`.

Add accumulator at top of `run_stage3_opus`:
```python
stage_tokens = {"model": "claude-opus-4-20250514", "input_tokens": 0, "output_tokens": 0}
```

Add accumulation after call. Change return to include `stage_tokens`.

- [ ] **Step 4: Update Stage 4 (Grok) call sites (~lines 1847 and 1860)**

Stage 4 has TWO call sites: the primary Grok call and the Opus fallback.

Find the Grok call:
```python
raw = await _call_grok(
```
Change to `raw, _usage = await _call_grok(`.

Find the Opus fallback:
```python
raw = await _call_anthropic(
    api_key=anthropic_key,
    model="claude-opus-4-20250514",
```
Change to `raw, _usage = await _call_anthropic(`.

Add accumulator at top of `run_stage4_grok`:
```python
stage_tokens = {"model": "grok-4-0709", "input_tokens": 0, "output_tokens": 0}
```

After each call (both Grok and fallback), add:
```python
stage_tokens["input_tokens"] += _usage.get("input_tokens", 0)
stage_tokens["output_tokens"] += _usage.get("output_tokens", 0)
```

If fallback is used, also update the model:
```python
stage_tokens["model"] = "claude-opus-4-20250514"
```

Change return to include `stage_tokens`.

- [ ] **Step 5: Update `run_council()` to collect token data and write to stage_metadata**

Find where `run_council()` calls each stage function. Each now returns `(results, tokens)`. Update the unpacking:

Where it currently says something like:
```python
stage1_results = await run_stage1_sonnet(...)
```
Change to:
```python
stage1_results, stage1_tokens = await run_stage1_sonnet(...)
```

Do the same for stages 2, 3, and 4.

Then find the `stage_metadata` assembly (~line 4721):
```python
stage_metadata={
    "stage1_count": len(stage1_results),
    ...
    "skipped_stages": skipped_stages,
},
```

Add the `token_usage` field:
```python
stage_metadata={
    "stage1_count": len(stage1_results),
    "stage2_count": len(stage2_results),
    "stage3_count": len(stage3_results),
    "stage4_count": len(stage4_results),
    "batching_used": len(payloads_list) > 50,
    "total_runtime_seconds": round(total_runtime, 1),
    "skipped_stages": skipped_stages,
    "token_usage": {
        "stage1": stage1_tokens,
        "stage2": stage2_tokens,
        "stage3": stage3_tokens,
        "stage4": stage4_tokens,
    },
},
```

Handle skipped stages: if a stage was skipped, use `{"model": "skipped", "input_tokens": 0, "output_tokens": 0}` as the default. Initialize all `stageN_tokens` variables at the top of `run_council()` with this default so they're always defined.

- [ ] **Step 6: Verify syntax and basic import**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "import ast; ast.parse(open('canadian_llm_council_brain.py').read()); print('Syntax OK')"
```

Expected: `Syntax OK`

Then verify import works:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "from canadian_llm_council_brain import CanadianStockCouncilBrain; print('Import OK')"
```

Expected: `Import OK`

- [ ] **Step 7: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add canadian_llm_council_brain.py
git commit -m "feat(cost): stage functions accumulate tokens, stage_metadata includes token_usage"
```

---

## Task 3: Update Spike It Call Sites in api_server.py

**Files:**
- Modify: `api_server.py` (Spike It endpoint, lines ~947-968)

The Spike It endpoint calls `_call_grok` and `_call_anthropic` which now return tuples.

- [ ] **Step 1: Update the Grok call (line ~947)**

Find:
```python
            grok_raw = await _call_grok(
                api_key=xai_key,
                model="grok-4-0709",
                system_prompt=SPIKE_IT_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                max_tokens=2048,
                temperature=0.3,
            )
```

Change to:
```python
            grok_raw, _ = await _call_grok(
                api_key=xai_key,
                model="grok-4-0709",
                system_prompt=SPIKE_IT_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                max_tokens=2048,
                temperature=0.3,
            )
```

- [ ] **Step 2: Update the Anthropic fallback call (line ~961)**

Find:
```python
            grok_raw = await _call_anthropic(
                api_key=anthropic_key,
                model="claude-opus-4-6",
                system_prompt=SPIKE_IT_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                max_tokens=2048,
                temperature=0.3,
            )
```

Change to:
```python
            grok_raw, _ = await _call_anthropic(
                api_key=anthropic_key,
                model="claude-opus-4-6",
                system_prompt=SPIKE_IT_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                max_tokens=2048,
                temperature=0.3,
            )
```

- [ ] **Step 3: Verify syntax**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "import ast; ast.parse(open('api_server.py').read()); print('Syntax OK')"
```

Expected: `Syntax OK`

- [ ] **Step 4: Verify the full app loads**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "from api_server import app; print('App loaded OK')" 2>&1 | head -5
```

Expected: `App loaded OK`

- [ ] **Step 5: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add api_server.py
git commit -m "feat(cost): update Spike It call sites for tuple returns"
```

---

## Task 4: Model Upgrades (Sonnet 4.6, Opus 4.6)

**Files:**
- Modify: `canadian_llm_council_brain.py`

- [ ] **Step 1: Upgrade Stage 1 (Sonnet) model string**

Find all instances of `"claude-sonnet-4-20250514"` in the file and replace with `"claude-sonnet-4-6-20250514"`. There should be instances in:
- The Stage 1 call site (model parameter)
- The stage_tokens accumulator (from Task 2)
- The system prompt metadata string (search for `"model": "claude-sonnet-4.6"` or similar display string)

```bash
cd /Users/coeus/spiketrades.ca/claude-code
grep -n "claude-sonnet-4-20250514\|claude-sonnet-4\.6\|claude-sonnet-4\"" canadian_llm_council_brain.py
```

Replace `claude-sonnet-4-20250514` with `claude-sonnet-4-6-20250514` everywhere it appears. Also update any display/metadata strings like `"claude-sonnet-4.6"` to remain consistent.

- [ ] **Step 2: Upgrade Stage 3 (Opus) model string**

Find all instances of `"claude-opus-4-20250514"` and replace with `"claude-opus-4-6-20250514"`. This appears in:
- Stage 3 call site
- Stage 4 Opus fallback call site
- The stage_tokens accumulators
- System prompt metadata strings

```bash
cd /Users/coeus/spiketrades.ca/claude-code
grep -n "claude-opus-4-20250514\|claude-opus-4\.6\|claude-opus-4\"" canadian_llm_council_brain.py
```

Replace `claude-opus-4-20250514` with `claude-opus-4-6-20250514` everywhere.

- [ ] **Step 3: Update the Spike It fallback model in api_server.py**

Find `model="claude-opus-4-6"` in api_server.py (Spike It fallback) and update to `model="claude-opus-4-6-20250514"` for consistency:

```bash
cd /Users/coeus/spiketrades.ca/claude-code
grep -n "claude-opus-4-6" api_server.py
```

Ensure the model string is the full versioned name: `claude-opus-4-6-20250514`.

- [ ] **Step 4: Verify syntax of both files**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "import ast; ast.parse(open('canadian_llm_council_brain.py').read()); ast.parse(open('api_server.py').read()); print('Both files Syntax OK')"
```

Expected: `Both files Syntax OK`

- [ ] **Step 5: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add canadian_llm_council_brain.py api_server.py
git commit -m "feat: upgrade Sonnet 4→4.6 and Opus 4→4.6 (66% cost reduction on Stage 3)"
```

---

## Task 5: Deploy & Test Model Upgrades + Token Capture

**Files:** None (deployment and testing only)

- [ ] **Step 1: Push to GitHub**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && git push origin main
```

- [ ] **Step 2: Deploy council container**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "cd /opt/spike-trades && git pull origin main && docker compose up -d --build council 2>&1 | tail -10"
```

- [ ] **Step 3: Verify council is healthy**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "sleep 15 && curl -s http://localhost:8100/health | python3 -m json.tool"
```

Expected: `"status": "ok"`

- [ ] **Step 4: Trigger a manual council run from admin panel**

Navigate to spiketrades.ca admin panel → Council tab → trigger a manual run. Monitor logs:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "docker logs spike-trades-council --tail 5 -f 2>&1"
```

Watch for:
- Stage 1: `claude-sonnet-4-6-20250514` (not the old `4-20250514`)
- Stage 2: `gemini-3.1-pro-preview` (unchanged)
- Stage 3: `claude-opus-4-6-20250514` (not the old `4-20250514`)
- Stage 4: `grok-4-0709` (unchanged)
- All stages complete successfully
- No errors related to tuple unpacking

- [ ] **Step 5: Verify token_usage in output**

After the run completes:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "curl -s http://localhost:8100/latest-output | python3 -c \"import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('stage_metadata',{}).get('token_usage',{}), indent=2))\""
```

Expected: JSON with 4 stages, each with `model`, `input_tokens` (non-zero), `output_tokens` (non-zero).

- [ ] **Step 6: Test Spike It still works**

Navigate to portfolio page and click "Spike It" on any position during market hours. Verify the modal opens and shows results (or appropriate error if market is closed).

---

## Task 6: Admin Panel Cost Card

**Files:**
- Modify: `src/app/admin/page.tsx`

- [ ] **Step 1: Add pricing constant**

Near the top of the file (after imports, before the component function), add:

```typescript
// API pricing per million tokens (USD) — update when provider prices change
const LLM_PRICING: Record<string, { input: number; output: number; label: string }> = {
  'claude-sonnet-4-6-20250514': { input: 3.00, output: 15.00, label: 'Sonnet 4.6' },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, label: 'Sonnet 4' },
  'claude-opus-4-6-20250514': { input: 5.00, output: 25.00, label: 'Opus 4.6' },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00, label: 'Opus 4' },
  'gemini-3.1-pro-preview': { input: 1.25, output: 10.00, label: 'Gemini 3.1 Pro' },
  'gemini-3.1-pro': { input: 1.25, output: 10.00, label: 'Gemini 3.1 Pro' },
  'grok-4-0709': { input: 3.00, output: 15.00, label: 'Grok 4' },
};
const FALLBACK_PRICING = { input: 15.00, output: 75.00, label: 'Unknown' };

function calculateStageCost(stage: { model: string; input_tokens: number; output_tokens: number }) {
  const pricing = LLM_PRICING[stage.model] || FALLBACK_PRICING;
  const cost = (stage.input_tokens / 1_000_000) * pricing.input + (stage.output_tokens / 1_000_000) * pricing.output;
  return { cost, pricing };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
```

- [ ] **Step 2: Add the Run Cost Breakdown card to the Council tab**

Find the closing `</div>` of the 2-column status cards grid (the grid containing "Last Run" and "Python Server" cards, around line 550). After that grid's closing `</div>`, add:

```tsx
{/* Run Cost Breakdown */}
{(() => {
  const tokenUsage = council?.councilHealth?.latest_output?.stage_metadata?.token_usage
    || council?.latestOutput?.stage_metadata?.token_usage;
  if (!tokenUsage) return (
    <div className="glass-card p-4">
      <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-2">Run Cost Breakdown</p>
      <p className="text-xs text-spike-text-dim">Token data not available for this run</p>
    </div>
  );

  const stages = [
    { key: 'stage1', label: 'Stage 1', ...tokenUsage.stage1 },
    { key: 'stage2', label: 'Stage 2', ...tokenUsage.stage2 },
    { key: 'stage3', label: 'Stage 3', ...tokenUsage.stage3 },
    { key: 'stage4', label: 'Stage 4', ...tokenUsage.stage4 },
  ].filter(s => s.model && s.model !== 'skipped');

  let totalCost = 0;
  const rows = stages.map(s => {
    const { cost, pricing } = calculateStageCost(s);
    totalCost += cost;
    return { ...s, cost, label: `${s.label} · ${pricing.label}` };
  });

  return (
    <div className="glass-card p-4">
      <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-3">Run Cost Breakdown</p>
      <div className="space-y-2">
        {rows.map(r => (
          <div key={r.key} className="flex items-center justify-between text-xs">
            <div>
              <span className="text-spike-text">{r.label}</span>
              <span className="text-spike-text-dim ml-2">{formatTokens(r.input_tokens)} in / {formatTokens(r.output_tokens)} out</span>
            </div>
            <span className="text-spike-cyan mono font-medium">${r.cost.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="border-t border-spike-border/30 mt-3 pt-3 flex items-center justify-between">
        <span className="text-xs font-bold text-spike-text">Total</span>
        <span className="text-lg font-bold text-spike-cyan mono">${totalCost.toFixed(2)}</span>
      </div>
    </div>
  );
})()}
```

- [ ] **Step 3: Ensure the Council tab fetches latest output data**

Check that the admin page's council data fetch includes the latest output. Find the fetch call for the council tab (likely `/api/admin/council`). The token_usage field needs to be accessible. If the admin API route doesn't already return `stage_metadata`, add it to the response.

Check: `grep -n "stage_metadata\|latestOutput\|latest_output" src/app/admin/page.tsx | head -10`

If `stage_metadata` is not currently passed through, the admin API route (`src/app/api/admin/council/route.ts`) may need to fetch `/latest-output` from the council service and include `stage_metadata` in its response. Inspect and update as needed.

- [ ] **Step 4: Verify the build compiles**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && npx next build 2>&1 | grep -E "Compiled|error" | head -5
```

Expected: `Compiled successfully`

- [ ] **Step 5: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/admin/page.tsx src/app/api/admin/council/route.ts
git commit -m "feat(cost): Run Cost Breakdown card on admin Council tab"
```

---

## Task 7: Version Bump to Ver 3.5

**Files:**
- Modify: 8 page files + FEATURES.md

- [ ] **Step 1: Bump version in all page footers**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
grep -rl "Ver 3.2" src/app/ | xargs sed -i '' 's/Ver 3\.2/Ver 3.5/g'
```

- [ ] **Step 2: Update FEATURES.md**

Add at the top of the changelog:

```markdown
## Ver 3.5 — 2026-04-01
- **API Cost Tracking** — Per-stage token usage and cost breakdown on Admin panel. Shows input/output tokens and dollar cost for each LLM stage (Sonnet, Gemini, Opus, Grok).
- **Model Upgrades** — Sonnet 4 → 4.6 (same cost, better quality), Opus 4 → 4.6 (66% cost reduction: $15/$75 → $5/$25 per MTok).
```

- [ ] **Step 3: Verify no "Ver 3.2" remains**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && grep -r "Ver 3.2" src/app/ | grep -v node_modules | grep -v .next
```

Expected: No output.

- [ ] **Step 4: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add -A src/app/ FEATURES.md
git commit -m "chore: version bump to Ver 3.5 + FEATURES.md changelog"
```

---

## Task 8: Deploy & Verify Everything

**Files:** None (deployment and testing only)

- [ ] **Step 1: Push to GitHub**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && git push origin main
```

- [ ] **Step 2: Deploy both containers**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "cd /opt/spike-trades && git pull origin main && docker compose up -d --build council app 2>&1 | tail -10"
```

- [ ] **Step 3: Verify version string**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "curl -s http://localhost:3000/login | grep 'Ver'"
```

Expected: `Ver 3.5`

- [ ] **Step 4: Verify cost card on admin panel**

Navigate to spiketrades.ca → Admin → Council tab. The "Run Cost Breakdown" card should display with data from the latest run (triggered in Task 5).

If the latest run was before the token capture code was deployed, the card should show "Token data not available for this run".

- [ ] **Step 5: Verify Spike It still works**

Test the Spike It button on a portfolio position.

- [ ] **Step 6: Verify git log**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && git log --oneline -10
```

Expected: Commits for all tasks in this plan.
