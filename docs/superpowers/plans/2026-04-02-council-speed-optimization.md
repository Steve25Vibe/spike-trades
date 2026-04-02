# Council Speed Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce council run time from ~15-20 minutes to ~10-13 minutes without any quality or reliability trade-offs.

**Architecture:** Two independent changes: (1) reduce overly conservative 15s inter-batch delay on Anthropic LLM calls to 8s, (2) parallelize two independent FMP fetch steps that currently run sequentially. Both changes are safe — the existing retry logic handles any rate limits, and the parallelized fetches hit different endpoints with no shared state.

**Tech Stack:** Python asyncio, existing retry/backoff in `_fmp_get()` and `_call_anthropic()`

---

### Task 1: Reduce Anthropic inter-batch delay from 15s to 8s

**Files:**
- Modify: `canadian_llm_council_brain.py:4441`

This single constant controls the sleep between batches in both Stage 1 (Sonnet) and Stage 3 (Opus). Reducing from 15s to 8s saves ~7s per batch gap. With ~9 gaps in Stage 1 and ~7 in Stage 3, that's approximately **112 seconds saved**.

- [ ] **Step 1: Change the delay constant**

In `canadian_llm_council_brain.py`, line 4441, change:

```python
INTER_BATCH_DELAY = 15  # seconds between batches to avoid 429s
```

to:

```python
INTER_BATCH_DELAY = 8  # seconds between batches (reduced from 15s; retry logic handles any 429s)
```

- [ ] **Step 2: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "perf: reduce Anthropic inter-batch delay from 15s to 8s

Saves ~112s per council run. Existing exponential backoff retry logic
(5s, 10s, 20s, 40s, 80s) handles any rate-limit 429s gracefully.
Previous 15s delay was overly conservative."
```

---

### Task 2: Parallelize earnings calendar + enhanced signals fetches

**Files:**
- Modify: `canadian_llm_council_brain.py:4395-4411`

Steps 4d (earnings calendar) and 4e (enhanced signals) currently run sequentially. They are completely independent — different FMP endpoints, no shared state, no data dependency. Running them concurrently with `asyncio.gather()` saves ~15-20s (the time enhanced signals takes, since it's the longer operation).

- [ ] **Step 1: Wrap both fetches in asyncio.gather()**

In `canadian_llm_council_brain.py`, replace lines 4395-4411:

```python
            # ── Step 4d: Fetch earnings calendar (1 API call) ──
            logger.info("Step 4d: Fetching earnings calendar")
            try:
                earnings_map = await fetch_earnings_calendar(self.fetcher, days_ahead=10)
            except Exception as e:
                logger.warning(f"Earnings calendar fetch failed (non-fatal): {e}")
                earnings_map = {}

            # ── Step 4e: Fetch enhanced signals (insider + analyst) ──
            logger.info(f"Step 4e: Fetching insider + analyst data for {len(payloads_list)} tickers")
            try:
                insider_map, analyst_map = await fetch_enhanced_signals_batch(
                    self.fetcher, [p.ticker for p in payloads_list], quotes
                )
            except Exception as e:
                logger.warning(f"Enhanced signals fetch failed (non-fatal): {e}")
                insider_map, analyst_map = {}, {}
```

with:

```python
            # ── Steps 4d + 4e: Fetch earnings + enhanced signals in parallel ──
            logger.info(f"Steps 4d+4e: Fetching earnings calendar + analyst data for {len(payloads_list)} tickers (parallel)")

            async def _fetch_earnings():
                try:
                    return await fetch_earnings_calendar(self.fetcher, days_ahead=10)
                except Exception as e:
                    logger.warning(f"Earnings calendar fetch failed (non-fatal): {e}")
                    return {}

            async def _fetch_enhanced():
                try:
                    return await fetch_enhanced_signals_batch(
                        self.fetcher, [p.ticker for p in payloads_list], quotes
                    )
                except Exception as e:
                    logger.warning(f"Enhanced signals fetch failed (non-fatal): {e}")
                    return {}, {}

            earnings_map, (insider_map, analyst_map) = await asyncio.gather(
                _fetch_earnings(), _fetch_enhanced()
            )
```

- [ ] **Step 2: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "perf: parallelize earnings + enhanced signals FMP fetches

Steps 4d and 4e are independent (different endpoints, no shared state).
Running them concurrently saves ~15-20s per council run."
```

---

### Task 3: Deploy and verify on next trading day

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Deploy to server**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "cd /opt/spike-trades && git pull --rebase origin main && docker compose up -d --build council"
```

- [ ] **Step 3: Verify council container is healthy**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "curl -s http://localhost:8100/health | python3 -m json.tool"
```

Expected: `"status": "ok"`, `"council_running": false`

- [ ] **Step 4: After Monday's 10:45 AM cron run, verify:**

Check run duration via admin panel → Council tab → "Last Run" card.

**Expected:** 10-13 minutes (down from 15-20).

Check FMP health for 429 increases:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "docker compose exec -T council python3 -c \"import json; d=json.load(open('/app/data/latest_council_output.json')); print(json.dumps(d.get('fmp_endpoint_health',{}), indent=2))\""
```

**Expected:** Zero or minimal 429s on `/grades` and `/price-target-consensus`.

Check Anthropic 429s in council logs:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "docker compose logs council --since 30m 2>&1 | grep -i '429\|rate.limit'"
```

**Expected:** No Anthropic rate limit messages.

- [ ] **Step 5: Verify output quality**

Compare Monday's report (10 picks, scores, conviction tiers) against recent reports. Confirm:
- 10 picks generated (not fewer due to timeouts)
- All 4 stages completed (no skips in pipeline run status)
- Consensus scores and conviction tiers look normal
- Token usage per stage is consistent with prior runs

---

## Rollback Plan

If Monday's run shows Anthropic 429s causing retries or stage timeouts:

```python
# Revert line 4441 back to:
INTER_BATCH_DELAY = 15
```

Commit, push, rebuild council. The parallelized FMP fetch (Task 2) is 100% safe and should stay regardless.
