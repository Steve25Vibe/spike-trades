# Session 11 — Bug Fixes, EODHD News Integration, Finnhub Removal

**REQUIRED:** Use `/superpowers:executing-plans` to implement this session. Execute all fixes in order, verifying each before moving to the next.

## DO NOT TOUCH — Already Completed in Sessions 8, 9 & 10

These are DONE. Do not revisit, re-plan, re-investigate, or re-implement any of them:

| Commit | What was done | Files changed |
|--------|--------------|---------------|
| `c3eb05a` | Radar cron moved from 8:15 AM to 10:05 AM AST | `scripts/start-cron.ts`, `canadian_llm_council_brain.py`, UI pages, docs |
| `9aa8abd` | Empty state screens for Radar and Opening Bell | UI pages |
| `a776983` | Code simplification — shared utils, batch DB ops | Multiple |
| `1adfff1` | Radar cron timeout 360s → 600s | `scripts/start-cron.ts` |
| `1428254` | AI score clamping for Radar and Spikes | `canadian_llm_council_brain.py` |
| `a03b61a` | Opening Bell FMP field names (changesPercentage → changePercentage, .TO suffix, marketCap filter, profile enrichment) | `opening_bell_scanner.py` |
| `6c806e9` | Intraday chart path fix (/1min/{ticker} → /1min?symbol={ticker}), Opening Bell isActivelyTrading + isEtf filter | `api_server.py`, `canadian_llm_council_brain.py`, `opening_bell_scanner.py` |
| `fc80e9d` | Historical edge multiplier applied before ranking | `canadian_llm_council_brain.py` |
| SQL (no commit) | Today's Spikes ranks retroactively corrected — MX.TO now rank 1 at 84.69 | Direct DB update |
| SQL (no commit) | Phase 1 data repair — deleted ghost OB picks, trimmed Radar to 10, removed 14 ETFs from Spikes archive, trimmed Mar 19-24 to 10 picks, purged council SQLite | Direct DB + SQLite |
| `eb94c6a` | FMP bulk profile cache + pipeline integration | `fmp_bulk_cache.py` (new), `Dockerfile.council`, `canadian_llm_council_brain.py`, `opening_bell_scanner.py` |
| `7e74667` | Opening Bell 5-layer quality fix + UI score badge | `opening_bell_scanner.py`, `OpeningBellCard.tsx` |
| `7bf39d2` | Radar quality improvements (prompt, grade recency, catalyst majority, sector cap, volume anomaly, macro cache, quality threshold) + portfolio schema/API/UI | `canadian_llm_council_brain.py`, `prisma/schema.prisma`, portfolio `route.ts`, `RadarCard.tsx`, `radar/page.tsx` |
| `087c090` | Spikes ETF filter via bulk cache whitelist | `canadian_llm_council_brain.py` |
| `c6852be` | Revert Spikes ADV threshold back to $5M | `canadian_llm_council_brain.py` |

**Do NOT update any 8:15 AM references to 10:05 AM — this was done in Session 8.** Some documentation files still reference 8:15 AM but these are historical docs, not runtime code.

---

## Server Details

- **Server:** `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
- **Deploy path:** `/opt/spike-trades`
- **DB:** PostgreSQL in `spike-trades-db` container, user `spiketrades`, db `spiketrades`
- **Council:** Python FastAPI in `spike-trades-council` container
- **FMP API key:** In `.env` as `FMP_API_KEY` (value: `Z0n16cRRU0Mvk45AvHoiyOr0X6TSYvLY`, Ultimate plan)
- **EODHD API key:** Must be added to `.env` as `EODHD_API_KEY` (value: `69d44c3cd78105.50351616`)

---

## Verified FMP Endpoint Status (Tested 2026-04-06, market open)

**WORKING for .TO tickers — keep using:**
| Endpoint | Purpose | Notes |
|----------|---------|-------|
| `/stable/profile?symbol=X` | Company profile (single ticker) | JSON, returns `averageVolume`, `sector`, `isEtf`, `isActivelyTrading`. Multi-ticker and batch-profile return empty for .TO. |
| `/stable/batch-quote?symbols=X,Y` | Real-time quotes | JSON, comma-separated works. Field name is `changePercentage` (no 's'). Does NOT include `avgVolume`. |
| `/stable/quote?symbol=X` | Single quote (macro symbols) | Used for USO, GCUSD, CADUSD, ^VIX, XIU.TO, BZUSD, BTCUSD |
| `/stable/stock-list` | All tickers | Filter by `.TO` suffix for TSX universe |
| `/stable/historical-price-eod/full?symbol=X` | Daily OHLCV bars | Works for 90-day history |
| `/stable/historical-chart/1min?symbol=X` | Intraday 1-min bars | 378 bars on trading day. Use `?symbol=` query param, NOT path param. |
| `/stable/historical-chart/5min?symbol=X` | Intraday 5-min bars | Fallback for 1-min |
| `/stable/grades?symbol=X` | Analyst grades | 145 historical grades for RY.TO |
| `/stable/earnings-calendar?from=X&to=Y` | Bulk earnings dates | 2531 results, filter to .TO/.V |
| `/stable/sector-performance-snapshot?exchange=TSX&date=X` | TSX sector rotation | 11 sectors, requires explicit `date` param |
| `/stable/profile-bulk?part=N` | CSV bulk profiles | CSV only, .TO tickers across parts 0-3 (~2050 tickers). Used ONLY for whitelist. |

**BROKEN — do NOT use:**
| Endpoint | Problem |
|----------|---------|
| `/stable/news/stock` | **Ignores symbol/symbols param entirely.** Returns AAPL articles for every symbol including ZZZZZZ. Tested with `symbol=`, `symbols=`, `tickers=` — none work for .TO. `symbols=AAPL` works for US only. |
| `/stable/news/stock-latest` | Ignores symbol, returns random tickers |
| `/stable/news/press-releases` | Returns AAPL regardless of symbol |
| `/stable/batch-profile` | Returns 404/empty for .TO |
| `/stable/price-target-consensus` | Returns empty `[]` for all .TO tickers |
| `/stable/earnings-surprises` | Returns 404 for .TO |
| `/stable/insider-trading` | Returns 404 |
| `/stable/institutional-ownership` | Returns 404 |
| `/stable/technical-indicator` | Returns 404 |
| `/stable/social-sentiment` | Returns empty for .TO |
| `/api/v3/*` | All v3 endpoints blocked — "Legacy Endpoint" error (account created after Aug 31, 2025) |

---

## EODHD News API (Verified 2026-04-06)

**Endpoint:** `GET https://eodhd.com/api/news?s={ticker}&limit={n}&api_token={key}&fmt=json`

**Verified working for .TO tickers:** SU.TO (5 articles), RY.TO (5), SHOP.TO (5), ENB.TO (5), GFL.TO (3), SCR.TO (3), DOO.TO (3)

**Rate limit:** 30 rapid sequential calls all returned HTTP 200. No throttling observed.

**Multi-ticker bulk:** NOT supported. Comma-separated tickers return HTML redirect. Must call per-ticker.

**Tag-based sector news:** Supported via `?t=energy` etc. (not needed for per-ticker use)

**Response format (JSON):**
```json
{
  "date": "2026-04-06T16:10:05+00:00",
  "title": "Will Suncor Energy (SU) Beat Estimates Again in Its Next Earnings Report?",
  "content": "Full article text here... (DO NOT send to LLMs — too many tokens)",
  "link": "https://finance.yahoo.com/...",
  "symbols": ["SM3.DU", "SM3.F", "SM3.MU", "SU.TO", "SU.US"],
  "tags": ["CONSENSUS ESTIMATE", "EARNINGS", "EARNINGS RELEASE", "EARNINGS SURPRISE", "ENERGY"],
  "sentiment": {
    "polarity": 0.994,
    "neg": 0.034,
    "neu": 0.818,
    "pos": 0.148
  }
}
```

**Key fields for our pipelines:**
- `title` — headline for LLM prompts
- `date` — publication timestamp (UTC)
- `tags` — category tags (EARNINGS, ANALYST-RATINGS, M&A, ENERGY, etc.) — useful for catalyst type detection
- `sentiment.polarity` — float 0-1, replaces Finnhub sentiment heuristic
- `symbols` — array of related tickers, includes `.TO` variant — use to verify relevance
- `content` — full article text. **Strip before sending to LLMs. Only send title + tags + sentiment.**
- `link` — source URL. **Strip before sending to LLMs to save tokens.**

---

## The 10 Fixes (Execute in Order)

### Fix 1: Add EODHD API key to server `.env`

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30
echo 'EODHD_API_KEY=69d44c3cd78105.50351616' >> /opt/spike-trades/.env
```

Verify: `grep EODHD /opt/spike-trades/.env`

### Fix 2: Create `eodhd_news.py` — new shared news module

**New file:** `eodhd_news.py`

**Requirements:**
- `fetch_news(ticker: str, limit: int = 10, api_key: str | None = None) -> list[dict]`
  - Calls `GET https://eodhd.com/api/news?s={ticker}&limit={limit}&api_token={key}&fmt=json`
  - Returns list of article dicts with: `title`, `date`, `tags`, `sentiment`, `symbols`
  - Strips `content` and `link` fields from returned dicts (not needed downstream, saves memory)
  - Validates that the requested ticker appears in the article's `symbols` array (relevance filter)
  - Handles HTTP errors gracefully — return empty list on failure, log warning
  - API key from param or `os.environ.get("EODHD_API_KEY", "")`

- `fetch_news_batch(tickers: list[str], limit: int = 5, api_key: str | None = None) -> dict[str, list[dict]]`
  - Calls `fetch_news()` per ticker with async concurrency (semaphore of 10)
  - Brief 0.1s delay between calls for politeness
  - Returns `{ticker: [articles]}` dict

- `get_sentiment_score(articles: list[dict]) -> float`
  - Accepts list of articles for a single ticker
  - Returns average `sentiment.polarity` across articles
  - Returns 0.0 if no articles
  - This replaces `fetch_finnhub_sentiment()` entirely

**Add to `Dockerfile.council`:** `COPY eodhd_news.py .` (after `COPY fmp_bulk_cache.py .`)

### Fix 3: Rewire Radar news — remove FMP `fetch_news()`, use EODHD

**File:** `canadian_llm_council_brain.py`

**Changes in `RadarScanner._fetch_enrichment()` (around line 4526-4530):**
- Current code:
  ```python
  async def _news(t):
      async with sem:
          data = await self.fetcher.fetch_news(t, limit=10)
          if data:
              news_map[t] = [n.model_dump() if hasattr(n, "model_dump") else n for n in data]
  ```
- Replace with:
  ```python
  async def _news(t):
      async with sem:
          import eodhd_news
          data = await eodhd_news.fetch_news(t, limit=10)
          if data:
              news_map[t] = data
  ```

**Changes in `_call_radar_sonnet()` prompt building (around line 4687-4691):**
- Current code reads `news_map[t]` and extracts `headline` or `title`
- EODHD uses `title` (not `headline`). Update:
  ```python
  if t in news_map:
      block += f"  NEWS: {len(news_map[t])} articles in 24h\n"
      for n in news_map[t][:2]:
          headline = n.get("title", "")[:80]
          tags = ", ".join(n.get("tags", [])[:3])
          block += f"    - {headline}"
          if tags:
              block += f" [{tags}]"
          block += "\n"
  ```
  This adds EODHD tags to the prompt so Sonnet can assess catalyst type (EARNINGS, ANALYST-RATINGS, M&A, etc.)

### Fix 4: Rewire Opening Bell news — remove FMP, use EODHD

**File:** `opening_bell_scanner.py`

**Replace `fetch_news_bulk()` method (lines 133-148):**
- Remove the FMP `/news/stock` call entirely
- Replace with EODHD:
  ```python
  async def fetch_news_bulk(self, session: aiohttp.ClientSession, tickers: list[str]) -> dict[str, list[dict]]:
      import eodhd_news
      return await eodhd_news.fetch_news_batch(tickers, limit=5, api_key=os.environ.get("EODHD_API_KEY", ""))
  ```
  Note: The `session` param is kept for interface compatibility but EODHD module creates its own session.

### Fix 5: Rewire Today's Spikes news + sentiment — remove FMP + Finnhub, use EODHD

**File:** `canadian_llm_council_brain.py`

**Changes in `build_payload()` (around lines 980-1000):**
- Current code:
  ```python
  news_task = self.fetch_news(ticker)
  sentiment_task = self.fetch_finnhub_sentiment(ticker)
  ...
  finnhub_sentiment=sentiment,
  ```
- Replace with:
  ```python
  import eodhd_news
  news_data = await eodhd_news.fetch_news(ticker, limit=5)
  sentiment = eodhd_news.get_sentiment_score(news_data) if news_data else 0.0
  ```
- Change the payload field from `finnhub_sentiment=sentiment` to `news_sentiment=sentiment`

**Changes in `StockDataPayload` Pydantic model (line 157):**
- Rename `finnhub_sentiment: Optional[float]` → `news_sentiment: Optional[float]`
- Update all references to `finnhub_sentiment` in the codebase to `news_sentiment`
- This field name appears in payload dicts sent to all 4 LLM stages — the LLMs will see `news_sentiment` instead of `finnhub_sentiment`

**Changes in `_slim_payload()` (around line 1370):**
- News items from EODHD have `content` and `link` fields. Strip them:
  ```python
  for item in d.get("news", []):
      item.pop("content", None)
      item.pop("link", None)
  ```
  (The existing code already strips `url` — replace with `link` since EODHD uses `link` not `url`)

### Fix 6: Rewire Spike It news — remove FMP, use EODHD

**File:** `api_server.py`

**Changes in `_fetch_spike_it_data()` (line 703):**
- Current code:
  ```python
  news_task = _fmp_get_spike("/news/stock", {"symbols": ticker, "limit": "5"})
  ```
- Replace with EODHD call. Since Spike It uses its own async context:
  ```python
  import eodhd_news
  news_task = eodhd_news.fetch_news(ticker, limit=5)
  ```
- Update the news processing block (around lines 831-875) to handle EODHD response format:
  - EODHD uses `title` (not `title` from FMP — same field name, no change needed)
  - EODHD uses `link` (FMP used `url`) — update the field access
  - EODHD uses `date` (same as FMP `publishedDate` — update the field access)
  - Add `tags` to the clean_news output for the Grok prompt

### Fix 7: Remove ALL Finnhub code

**File:** `canadian_llm_council_brain.py`

Delete these methods/blocks:
- `_finnhub_get()` method (lines 448-462)
- `fetch_finnhub_sentiment()` method (lines 841-858)
- Finnhub earnings backup block in `_fetch_enrichment()` (lines 4536-4561) — FMP `/stable/earnings-calendar` works reliably, Finnhub returned 0 Canadian tickers when tested
- Remove `finnhub_api_key` parameter from:
  - `LiveDataFetcher.__init__` (line 388) — remove param and `self.finnhub_key`
  - `RadarScanner.__init__` (line 4406) — remove param
  - `CanadianStockCouncilBrain.__init__` (line 4838) — remove param and `self.finnhub_key`
- Remove `self.fetcher = LiveDataFetcher(fmp_api_key, finnhub_api_key)` — change to `LiveDataFetcher(fmp_api_key)`

**File:** `api_server.py`
- Remove `finnhub_api_key=os.environ.get("FINNHUB_API_KEY", "")` from constructor calls (lines 162, 1278)

### Fix 8: Remove FMP `fetch_news()` method and dead code

**File:** `canadian_llm_council_brain.py`

- Delete `fetch_news()` method (lines 812-836) — replaced by EODHD module
- Delete `fetch_earnings_surprises()` method (around line 647-660) — never called, returns 404 for .TO
- In `fetch_analyst_consensus()` (around line 1069-1071): remove the `/price-target-consensus` call — returns empty `[]` for all .TO tickers. Just fetch `/grades` alone.

### Fix 9: Fix `changesPercentage` typo in Radar prompt

**File:** `canadian_llm_council_brain.py` line 4672

**Current code:**
```python
block += f"  Price: ${q.get('price', 0):.2f} | Change: {q.get('changesPercentage', 0):.2f}% | Volume: {q.get('volume', 0):,}\n"
```

**Fix — change `changesPercentage` to `changePercentage`:**
```python
block += f"  Price: ${q.get('price', 0):.2f} | Change: {q.get('changePercentage', 0):.2f}% | Volume: {q.get('volume', 0):,}\n"
```

**Why:** FMP `/stable/batch-quote` returns the field `changePercentage` (no 's'). Verified via live API on 2026-04-06. The current code reads a field that does not exist, so every ticker shows `Change: 0.00%` in the Sonnet prompt.

### Fix 10: Fix Radar Lock In modal — remove fake 3/5/8-day targets

**Problem:** `src/app/radar/page.tsx` lines 189-192 pass fabricated dollar amounts as percentage fields to `LockInModal`. The modal interprets `priceAtScan * 1.03` (~$94.76) as a 94.76% gain, computing a target of ~$179 for a $92 stock. Radar does not predict multi-day targets.

**Create new file:** `src/components/radar/RadarLockInModal.tsx`

**Requirements:**
- Copy sizing logic from `LockInModal.tsx` (auto/fixed/manual modes, Kelly Criterion)
- Display: ticker, name, price, smartMoneyScore, topCatalyst
- Display: stop-loss (default 5% below entry, or leave user-configurable)
- Do NOT display: 3-Day Target, 5-Day Target, 8-Day Target rows
- Do NOT require `predicted3Day`, `predicted5Day`, `predicted8Day` fields
- `onConfirm` sends `{ radarPickId, portfolioId, shares, positionSize, portfolioSize, mode }` (not `spikeId`)

**Update `src/app/radar/page.tsx`:**
- Import `RadarLockInModal` instead of `LockInModal`
- Remove the fabricated `predicted3Day/5Day/8Day` and `atr` values (lines 189-192)
- Pass actual Radar fields: `id`, `ticker`, `name`, `priceAtScan`, `smartMoneyScore`, `topCatalyst`

**Update `src/app/api/portfolio/route.ts` Radar section (lines 379-393):**
- Remove `stopLoss: pick.priceAtScan * 0.95` hardcode — leave null or compute from smartMoneyScore
- Leave `target3Day`, `target5Day`, `target8Day` as null (do not set them — Radar doesn't predict these)

### Fix 11: Add empty-movers guard in Opening Bell

**File:** `opening_bell_scanner.py` after line 403

**Current code (line 403):**
```python
movers = multi_signal_movers
```

**Add immediately after:**
```python
if not movers:
    return {"success": False, "error": "No movers pass multi-signal quality filter", "duration_ms": int((time.time() - start) * 1000)}
```

### Fix 12: Restructure `fmp_bulk_cache.py` — CSV for whitelist only, JSON for profiles

**File:** `fmp_bulk_cache.py`

**Changes:**
- `get_tsx_whitelist()` — keep CSV bulk download from `/stable/profile-bulk` parts 0-3. This is the only way to get all 2052 .TO tickers for ETF/ghost filtering. Add try/except around CSV parsing.
- `get_profile(ticker)` — change to call FMP `/stable/profile?symbol={ticker}` JSON endpoint. Cache results in module-level dict with 4-hour TTL (same as whitelist).
- `get_profiles(tickers)` — call `get_profile()` per ticker with async semaphore (10 concurrent). Return `{ticker: profile_dict}`.
- Remove `_normalize_profile()` function — JSON returns proper types (booleans are real booleans, numbers are real numbers). No string conversion needed.
- Fix asyncio.Lock: create lazily inside the first async call, not in sync `_get_lock()`.

**Callers remain unchanged** — `get_profile()`, `get_profiles()`, `get_tsx_whitelist()` keep exact same function signatures and return types.

### Fix 13: Opening Bell Phase 3.5 — news catalyst requirement (now implementable)

**File:** `opening_bell_scanner.py`

This was originally planned in Session 10 Phase 3.5 but could not be implemented because FMP news was broken. With EODHD providing real .TO news, it can now be built.

**After the multi-signal filter (after Fix 11's guard), add:**
- For each mover that passed the multi-signal filter, check if it has at least 1 news article from EODHD in the last 48 hours
- If zero news AND no analyst grade → reject the ticker
- If zero news BUT has analyst grade → keep (the grade is the catalyst)
- Log how many tickers were rejected by this layer

This ensures every pick sent to Sonnet has either a verifiable news catalyst or an analyst action backing it.

---

## Session 9 Hotfix Regression Check (REQUIRED after each fix group)

After completing ALL fixes, run these checks BEFORE deploying:

```bash
# 1. Score clamping still works (commit 1428254)
grep -n "RADAR_BOUNDS\|SCORE_BOUNDS\|clamp" canadian_llm_council_brain.py | head -10

# 2. Intraday chart path uses query param, not path param (commit 6c806e9)
grep -n "historical-chart" api_server.py canadian_llm_council_brain.py opening_bell_scanner.py | grep -v "docs\|#\|plans"

# 3. Edge multiplier applied before ranking (commit fc80e9d)
grep -n "edge_multi\|historical_analyzer" canadian_llm_council_brain.py | head -10

# 4. Cron timeout is 600s for Radar (commit 1adfff1)
grep -n "timeout.*600\|timeout.*Radar" scripts/start-cron.ts

# 5. Opening Bell uses changePercentage (not changesPercentage) and .TO suffix filter (commit a03b61a)
grep -n "changesPercentage\|exchangeShortName" opening_bell_scanner.py
# Should return ZERO results — both were replaced

# 6. No Finnhub references remain
grep -rn "finnhub\|FINNHUB" canadian_llm_council_brain.py api_server.py opening_bell_scanner.py
# Should return ZERO results

# 7. No FMP news/stock calls remain
grep -rn "news/stock\|news_task.*fmp\|fetch_news.*fmp" canadian_llm_council_brain.py api_server.py opening_bell_scanner.py
# Should return ZERO results

# 8. EODHD is the only news source
grep -rn "eodhd_news\|EODHD" canadian_llm_council_brain.py api_server.py opening_bell_scanner.py
# Should show EODHD calls in all three files
```

## Pre-Deployment Gate

Before deploying ANY changes:

1. **Python syntax valid:** `python3 -c "import ast; ast.parse(open('FILE').read())"` for all 4 Python files
2. **TypeScript builds:** `npx tsc --noEmit`
3. **No debug artifacts:** `grep -rn 'console.log("DEBUG\|print("TODO\|breakpoint()' *.py src/`
4. **`git diff --stat`** shows only files relevant to these fixes
5. **All regression checks pass**

## Deployment

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30
cd /opt/spike-trades
git pull
docker compose up -d --build council
docker compose up -d --build app
docker compose up -d --build cron
```

## Post-Deployment Verification

1. **Spike It test:** `curl -s -X POST 'http://localhost:8100/spike-it' -H 'Content-Type: application/json' -d '{"ticker":"SU.TO","entry_price":92.00}'` — verify it returns analysis with EODHD news (not AAPL)
2. **Council health:** `curl -s http://localhost:8100/health` — verify status ok
3. **EODHD connectivity:** From inside council container: `curl -s "https://eodhd.com/api/news?s=SU.TO&limit=1&api_token=$EODHD_API_KEY&fmt=json"` — verify returns SU.TO articles
4. **No Finnhub calls:** Check council logs for any Finnhub errors — there should be none

## Final Verification Checklist

- [ ] `changesPercentage` typo fixed — Radar prompt shows real change% (not 0.00%)
- [ ] EODHD news returns real .TO articles in all pipelines
- [ ] No FMP `/news/stock` calls anywhere in codebase
- [ ] No Finnhub calls anywhere in codebase
- [ ] `finnhub_sentiment` field renamed to `news_sentiment` in StockDataPayload
- [ ] EODHD `content` and `link` fields stripped before sending to LLMs
- [ ] Radar Lock In shows score + stop-loss only, no fake 3/5/8 day targets
- [ ] Opening Bell empty-movers guard in place
- [ ] Opening Bell Phase 3.5 news catalyst filter working
- [ ] `fmp_bulk_cache.py` uses JSON per-ticker for profiles, CSV only for whitelist
- [ ] All Session 9 regression checks pass
- [ ] No debug artifacts
- [ ] Spike It test returns analysis (cached result on non-trading hours is acceptable)
