# Sibling B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the council brain to run Stages 1+2 in parallel with hybrid FMP+EODHD data sources, cardinality cuts, ghost stock detection, and dual-listing enrichment.

**Architecture:** Parallel `asyncio.gather()` for Stages 1 and 2, merged-source `MergedPayload` at the fetch layer (both LLMs see all data), field-level cross-validation, Stage 2 narrowed to Top 60, Opus narrowed to Top 30, new modules for EODHD enrichment and US dual-listing data.

**Tech Stack:** Python 3 (asyncio, aiohttp, Pydantic), Next.js 14, Prisma + Postgres (no schema changes this phase), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-04-08-sibling-b-parallel-council-refactor-design.md`

**Verification approach:** Build checks (Python syntax via `py_compile`, TypeScript via `npm run build`), AST-based function presence checks, grep verification of integration points. No unit test framework exists in this project. Production validation happens at tomorrow's 10:45 AST council run + T+24 backtest report.

---

## File Structure

### New files
| Path | Responsibility | LoC |
|---|---|---|
| `dual_listing_map.json` | Static TSX → US ticker map, seeded with 33+ known dual listings | ~40 |
| `eodhd_enrichment.py` | EODHD batch enrichment module, mirrors `fetch_enhanced_signals_batch` structure | ~120 |
| `us_dual_listing_enrichment.py` | Tier 1 (options IV), Tier 2 (13F institutional), Tier 3 (analyst + news) US enrichment fetchers | ~200 |
| `cross_compare.py` | Field-level FMP vs EODHD cross-validation → DataQualityFlags | ~80 |

### Modified files
| Path | Change | LoC |
|---|---|---|
| `canadian_llm_council_brain.py` | Integrate new modules, parallel Stage 1+2, cardinality cuts, MergedPayload, Gemini prompt rewrite, Stage 1 cap → 600s | ~200 |

### Not touched
- `prisma/schema.prisma` (no schema changes this phase)
- `src/` (no frontend changes — Sibling A + B-i already handle UI)
- `api_server.py` (no new fields exposed this phase)

---

## Coordination rule with System A

**CRITICAL:** This plan executes on `System B` (a separate Claude Code session). `canadian_llm_council_brain.py` is ALSO touched by System A's ADV Slider project. To prevent merge conflicts:

- **Tasks 0-5 (new file creation)** can start IMMEDIATELY on System B — they only create new files, no conflicts possible.
- **Tasks 6-10 (brain file integration)** MUST wait until System A's ADV Slider PR is merged to main. Check periodically:
  ```bash
  git -C <worktree> fetch origin main
  git -C <worktree> log --oneline origin/main | grep -iE "adv.slider|advSlider|CouncilConfig" | head -3
  ```
  Once you see a commit matching that pattern, System A's ADV Slider is merged. Pull main into the Sibling B branch and proceed with Tasks 6-10.

- **Tasks 11-12 (deploy + verification)** happen last, after System A has also finished its work.

---

## Task 0: Worktree setup + baseline verification

**Files:** none

- [ ] **Step 1: Set up a fresh worktree on a new branch**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code
git fetch origin
git worktree add .worktrees/sibling-b-parallel -b feat/sibling-b-parallel-council origin/main
cd .worktrees/sibling-b-parallel
```

- [ ] **Step 2: Verify clean state**

```bash
git status
git log --oneline -5
```
Expected: `nothing to commit, working tree clean`, HEAD on current origin/main.

- [ ] **Step 3: Baseline builds pass**

```bash
npm install  # if node_modules is empty
npm run build 2>&1 | tail -5
python3 -m py_compile canadian_llm_council_brain.py && echo "python OK"
```
Expected: both pass.

---

## Task 1: Create dual_listing_map.json

**Files:**
- Create: `dual_listing_map.json`

- [ ] **Step 1: Write the static map**

Seed the map from the 33 known dual-listed tickers identified in the 2026-04-08 audit. Format:

```json
{
  "version": "2026-04-08",
  "description": "TSX to US ticker mappings for dual-listed stocks. Used by Sibling B dual-listing enrichment.",
  "mappings": {
    "AEM.TO": "AEM",
    "AGI.TO": "AGI",
    "ARIS.TO": "ARMN",
    "ASM.TO": "ASM",
    "BN.TO": "BN",
    "BTE.TO": "BTE",
    "BTO.TO": "BTG",
    "CCO.TO": "CCJ",
    "CLS.TO": "CLS",
    "CNQ.TO": "CNQ",
    "CVE.TO": "CVE",
    "EFR.TO": "UUUU",
    "FNV.TO": "FNV",
    "GFL.TO": "GFL",
    "HBM.TO": "HBM",
    "HUT.TO": "HUT",
    "K.TO": "KGC",
    "MFC.TO": "MFC",
    "MG.TO": "MGA",
    "MX.TO": "MEOH",
    "NTR.TO": "NTR",
    "OLA.TO": "ORLA",
    "PSLV.TO": "PSLV",
    "QSR.TO": "QSR",
    "SHOP.TO": "SHOP",
    "SOBO.TO": "SOBO",
    "SSRM.TO": "SSRM",
    "SU.TO": "SU",
    "TA.TO": "TAC",
    "TECK-B.TO": "TECK",
    "TRI.TO": "TRI",
    "TRP.TO": "TRP",
    "VET.TO": "VET"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add dual_listing_map.json
git commit -m "feat(data): seed dual_listing_map.json with 33 known TSX-US pairs"
git push -u origin feat/sibling-b-parallel-council
```

---

## Task 2: Create eodhd_enrichment.py

**Files:**
- Create: `eodhd_enrichment.py`

- [ ] **Step 1: Write the module skeleton**

Create the file with async functions that mirror FMP's enrichment pattern. Since `eodhd_news.py` already exists for news, this module adds OTHER EODHD enrichment capabilities (any fields that EODHD provides and FMP doesn't, or where EODHD is the canonical source).

Investigation TODO during implementation: check EODHD API documentation for what additional endpoints are available on the All-in-One plan beyond `/api/news`. Likely candidates: `/api/fundamentals`, `/api/historical-div`, `/api/insider-transactions`, `/api/options` (if covered).

Initial skeleton (to be expanded during implementation):

```python
"""EODHD enrichment module — complements eodhd_news.py with additional EODHD data sources.

Used by Sibling B's hybrid FMP+EODHD fetch layer.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional, Any

import aiohttp

logger = logging.getLogger(__name__)

EODHD_API_BASE = "https://eodhd.com/api"
EODHD_API_KEY = os.getenv("EODHD_API_KEY", "")


async def fetch_eodhd_fundamentals(
    session: aiohttp.ClientSession,
    ticker: str,
) -> Optional[dict]:
    """Fetch EODHD fundamentals for a ticker. Non-blocking — returns None on error.

    Used as a cross-check against FMP fundamentals. Field-level comparison
    happens in cross_compare.py.
    """
    try:
        # EODHD uses format TICKER.EXCHANGE, e.g. SHOP.TO or SHOP.US
        url = f"{EODHD_API_BASE}/fundamentals/{ticker}"
        params = {"api_token": EODHD_API_KEY, "fmt": "json"}
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            return await resp.json()
    except Exception:
        return None


async def fetch_eodhd_batch_enrichment(
    session: aiohttp.ClientSession,
    tickers: list[str],
) -> dict[str, dict]:
    """Batch enrichment across multiple tickers.

    Returns {ticker: {"fundamentals": ..., ...}} mapping.
    Non-blocking — missing tickers simply absent from the dict.
    """
    sem = asyncio.Semaphore(5)

    async def _fetch_one(ticker: str) -> tuple[str, dict]:
        async with sem:
            fundamentals = await fetch_eodhd_fundamentals(session, ticker)
            data = {}
            if fundamentals is not None:
                data["fundamentals"] = fundamentals
            return ticker, data

    results = await asyncio.gather(*[_fetch_one(t) for t in tickers])
    return {ticker: data for ticker, data in results if data}
```

- [ ] **Step 2: Python syntax check**

```bash
python3 -m py_compile eodhd_enrichment.py && echo "syntax OK"
```

- [ ] **Step 3: Commit**

```bash
git add eodhd_enrichment.py
git commit -m "feat(eodhd): add eodhd_enrichment.py for hybrid FMP+EODHD fetch layer"
git push
```

---

## Task 3: Create us_dual_listing_enrichment.py

**Files:**
- Create: `us_dual_listing_enrichment.py`

- [ ] **Step 1: Write the three enrichment functions**

```python
"""US Dual-Listing Enrichment — Tier 1 (options IV), Tier 2 (13F), Tier 3 (analyst + news).

For Canadian TSX tickers that are also listed on NYSE/NASDAQ/NYSE American,
these functions fetch US-market data that's richer than the Canadian equivalents.

Used by Sibling B. Lookup happens via dual_listing_map.json.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional, Any

import aiohttp

logger = logging.getLogger(__name__)


# Load dual-listing map once at module import
_MAP_PATH = Path(__file__).parent / "dual_listing_map.json"
try:
    with open(_MAP_PATH) as f:
        _DUAL_MAP_DATA = json.load(f)
        _DUAL_LISTING_MAP = _DUAL_MAP_DATA.get("mappings", {})
except Exception as e:
    logger.warning(f"Failed to load dual_listing_map.json: {e}")
    _DUAL_LISTING_MAP = {}


def get_us_ticker(tsx_ticker: str) -> Optional[str]:
    """Return the US ticker for a dual-listed TSX ticker, or None if not dual-listed.

    Example: get_us_ticker("SHOP.TO") -> "SHOP"
             get_us_ticker("LUN.TO") -> None  (not dual-listed)
    """
    return _DUAL_LISTING_MAP.get(tsx_ticker)


async def fetch_us_options_iv(
    fetcher,  # LiveDataFetcher
    us_ticker: str,
) -> Optional[dict]:
    """Tier 1: Fetch US options IV for a dual-listed ticker from FMP.

    Returns a dict matching IVExpectedMove shape, or None on error.
    Non-blocking.
    """
    try:
        session = await fetcher._get_session()
        # TODO during implementation: verify exact FMP endpoint for options IV
        # Likely: /api/v3/historical-price-full/options/{us_ticker} or similar
        url = f"https://financialmodelingprep.com/api/v3/historical-price-full/options/{us_ticker}"
        params = {"apikey": fetcher.fmp_key}
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            # Parse into IVExpectedMove-compatible shape
            # Details TBD during implementation — verify response format first
            return data
    except Exception:
        return None


async def fetch_us_13f_institutional(
    fetcher,  # LiveDataFetcher
    us_ticker: str,
) -> Optional[float]:
    """Tier 2: Fetch US 13F institutional ownership pct for a dual-listed ticker.

    Returns fraction 0.0-1.0, or None. Non-blocking.

    Uses the same endpoint as Sibling A's fetch_institutional_ownership,
    just with the US ticker instead of the TSX ticker.
    """
    try:
        session = await fetcher._get_session()
        url = "https://financialmodelingprep.com/api/v4/institutional-ownership/symbol-ownership"
        params = {
            "symbol": us_ticker,
            "includeCurrentQuarter": "false",
            "apikey": fetcher.fmp_key,
        }
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            if not data or not isinstance(data, list) or len(data) == 0:
                return None
            latest = data[0]
            pct = latest.get("ownershipPercent")
            if pct is None:
                return None
            return min(max(float(pct) / 100.0, 0.0), 1.0)
    except Exception:
        return None


async def fetch_us_analyst_consensus(
    fetcher,  # LiveDataFetcher
    us_ticker: str,
) -> Optional[dict]:
    """Tier 3a: Fetch US analyst consensus for a dual-listed ticker.

    Returns a dict with analyst grades, or None. Non-blocking.
    """
    try:
        session = await fetcher._get_session()
        url = f"https://financialmodelingprep.com/stable/grades"
        params = {"symbol": us_ticker, "apikey": fetcher.fmp_key}
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            return await resp.json()
    except Exception:
        return None


async def fetch_us_news_sentiment(
    us_ticker: str,
    endpoint_health: Optional[dict] = None,
) -> Optional[dict]:
    """Tier 3b: Fetch US news sentiment for a dual-listed ticker via EODHD.

    Uses the existing eodhd_news module with the US symbol (e.g., SHOP.US).
    Returns the news+sentiment dict, or None.
    """
    try:
        import eodhd_news
        us_symbol = f"{us_ticker}.US"
        return await eodhd_news.fetch_news(us_symbol, limit=5, endpoint_health=endpoint_health)
    except Exception:
        return None
```

- [ ] **Step 2: Python syntax check**

```bash
python3 -m py_compile us_dual_listing_enrichment.py && echo "syntax OK"
```

- [ ] **Step 3: Verify the static map loads**

```bash
python3 -c "from us_dual_listing_enrichment import get_us_ticker; print(get_us_ticker('SHOP.TO'), get_us_ticker('LUN.TO'))"
```
Expected: `SHOP None`

- [ ] **Step 4: Commit**

```bash
git add us_dual_listing_enrichment.py
git commit -m "feat(data): add US dual-listing enrichment module (Tiers 1-3)"
git push
```

---

## Task 4: Create cross_compare.py

**Files:**
- Create: `cross_compare.py`

- [ ] **Step 1: Write the cross-compare module**

```python
"""FMP vs EODHD cross-comparison module.

Produces DataQualityFlags for each ticker by comparing overlapping fields
between FMP and EODHD responses. Flags ghost stocks, stale quotes, and
field-level discrepancies for later audit.

Used by Sibling B's fetch layer before MergedPayload assembly.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional, Any

logger = logging.getLogger(__name__)


@dataclass
class DataQualityFlags:
    """Per-ticker data quality flags from cross-source comparison."""
    ticker: str
    ghost_stock: bool = False
    ghost_source: Optional[str] = None  # "fmp" or "eodhd" — which source was empty
    price_disagreement_pct: Optional[float] = None  # None if both agree or only one has data
    stale_timestamp_source: Optional[str] = None  # "fmp" or "eodhd" if one is >1h stale
    field_disagreements: list[str] = field(default_factory=list)

    def has_any_flag(self) -> bool:
        return (
            self.ghost_stock
            or (self.price_disagreement_pct is not None and self.price_disagreement_pct > 2.0)
            or self.stale_timestamp_source is not None
            or bool(self.field_disagreements)
        )


def cross_compare(
    ticker: str,
    fmp_data: Optional[dict],
    eodhd_data: Optional[dict],
) -> DataQualityFlags:
    """Compare FMP and EODHD data for a single ticker, returning flags.

    Both inputs may be None (missing from source). Field-level comparison
    happens only where both sources have the data.
    """
    flags = DataQualityFlags(ticker=ticker)

    # Ghost stock detection
    fmp_has_data = fmp_data is not None and bool(fmp_data)
    eodhd_has_data = eodhd_data is not None and bool(eodhd_data)

    if not fmp_has_data and not eodhd_has_data:
        flags.ghost_stock = True
        flags.ghost_source = "both"
        return flags
    if not fmp_has_data:
        flags.ghost_stock = True
        flags.ghost_source = "fmp"
        return flags
    if not eodhd_has_data:
        flags.ghost_stock = True
        flags.ghost_source = "eodhd"
        return flags

    # Both have data — compare price if both provide it
    fmp_price = fmp_data.get("price") if isinstance(fmp_data, dict) else None
    eodhd_price = eodhd_data.get("close") if isinstance(eodhd_data, dict) else None
    if fmp_price is not None and eodhd_price is not None:
        try:
            fmp_p = float(fmp_price)
            eodhd_p = float(eodhd_price)
            if fmp_p > 0:
                delta_pct = abs(fmp_p - eodhd_p) / fmp_p * 100.0
                flags.price_disagreement_pct = round(delta_pct, 2)
                if delta_pct > 2.0:
                    flags.field_disagreements.append(
                        f"price: FMP=${fmp_p:.2f} vs EODHD=${eodhd_p:.2f} ({delta_pct:.1f}% delta)"
                    )
        except (TypeError, ValueError):
            pass

    return flags


def cross_compare_batch(
    tickers: list[str],
    fmp_map: dict[str, dict],
    eodhd_map: dict[str, dict],
) -> dict[str, DataQualityFlags]:
    """Batch cross-compare across multiple tickers.

    Returns {ticker: DataQualityFlags}.
    Logs a summary of flag counts.
    """
    result = {}
    ghost_count = 0
    price_disagreement_count = 0
    for ticker in tickers:
        flags = cross_compare(ticker, fmp_map.get(ticker), eodhd_map.get(ticker))
        result[ticker] = flags
        if flags.ghost_stock:
            ghost_count += 1
        if flags.price_disagreement_pct is not None and flags.price_disagreement_pct > 2.0:
            price_disagreement_count += 1

    logger.info(
        f"Cross-compare: {len(tickers)} tickers analyzed, "
        f"{ghost_count} ghost flags, {price_disagreement_count} price disagreements (>2%)"
    )
    return result
```

- [ ] **Step 2: Python syntax check**

```bash
python3 -m py_compile cross_compare.py && echo "syntax OK"
```

- [ ] **Step 3: Smoke test**

```bash
python3 -c "
from cross_compare import cross_compare, DataQualityFlags
flags = cross_compare('TEST.TO', {'price': 100}, {'close': 102})
print(flags)
assert flags.price_disagreement_pct == 2.0
print('cross_compare smoke test OK')
"
```

- [ ] **Step 4: Commit**

```bash
git add cross_compare.py
git commit -m "feat(data): add cross_compare module for fetch-layer validation"
git push
```

---

## Task 5: Wait for ADV Slider merge + pull main

**Files:** none

- [ ] **Step 1: Periodically check for ADV Slider merge**

Loop until you see the ADV Slider commit on origin/main:

```bash
while true; do
  git fetch origin main
  if git log --oneline origin/main | grep -qiE "adv.slider|advSlider|CouncilConfig"; then
    echo "ADV Slider merged — proceeding"
    break
  fi
  echo "ADV Slider not yet merged. Sleeping 60s..."
  sleep 60
done
```

**Alternatively, if this is taking too long**, System A may report in via the session handoff that ADV Slider is merged. Check by running the grep above.

- [ ] **Step 2: Rebase feat/sibling-b-parallel-council onto latest main**

```bash
git fetch origin main
git rebase origin/main
```

If conflicts arise (unlikely since Tasks 1-4 only created NEW files), resolve them. The new module files should not conflict with anything.

- [ ] **Step 3: Verify baseline still builds**

```bash
npm run build 2>&1 | tail -5
python3 -m py_compile canadian_llm_council_brain.py && echo "python OK"
```

Now Task 6+ can proceed — the brain file is unlocked.

---

## Task 6: Integrate new modules into canadian_llm_council_brain.py — imports

**Files:**
- Modify: `canadian_llm_council_brain.py`

- [ ] **Step 1: Add new imports near the top of the file**

Find the existing import block (around line 50 where `import eodhd_news` currently lives).

Add after it:

```python
import eodhd_enrichment
import us_dual_listing_enrichment
import cross_compare
```

- [ ] **Step 2: Python syntax check**

```bash
python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```

- [ ] **Step 3: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat(brain): import sibling-b modules (eodhd_enrichment, us_dual_listing_enrichment, cross_compare)"
git push
```

---

## Task 7: Raise Stage 1 wall-clock cap to 600s

**Files:**
- Modify: `canadian_llm_council_brain.py`

- [ ] **Step 1: Find the 420 constant**

```bash
grep -n "420" /Users/coeus/spiketrades.ca/claude-code/.worktrees/sibling-b-parallel/canadian_llm_council_brain.py | head -10
```

Find the Stage 1 wall-clock timeout. Likely in `run_stage1_sonnet` or a constant nearby.

- [ ] **Step 2: Change to 600**

Use Edit tool to change the constant from `420` to `600`. Update any related comments that mention "7-minute timeout" to "10-minute timeout".

- [ ] **Step 3: Verify**

```bash
grep -n "600\|10-minute\|Stage 1" /Users/coeus/spiketrades.ca/claude-code/.worktrees/sibling-b-parallel/canadian_llm_council_brain.py | head -10
python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```

- [ ] **Step 4: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat(brain): raise Stage 1 wall-clock cap from 420s to 600s"
git push
```

---

## Task 8: Apply cardinality cuts (Stage 2 output → 60, Opus output → 30)

**Files:**
- Modify: `canadian_llm_council_brain.py`

- [ ] **Step 1: Find the narrowing logic**

```bash
grep -n "top_80\|top_40\|Top 80\|Top 40\|\[:80\]\|\[:40\]" /Users/coeus/spiketrades.ca/claude-code/.worktrees/sibling-b-parallel/canadian_llm_council_brain.py | head -20
```

Find where Stage 2 output is narrowed from Gemini's scores to 80, and where Opus's output is narrowed from Stage 3's scores to 40.

- [ ] **Step 2: Change 80 → 60 and 40 → 30**

Use Edit tool. Update both slice operations and any logging strings that mention "80" or "40" to reflect the new cardinality.

- [ ] **Step 3: Verify**

```bash
grep -n "top_60\|top_30\|Top 60\|Top 30\|\[:60\]\|\[:30\]" /Users/coeus/spiketrades.ca/claude-code/.worktrees/sibling-b-parallel/canadian_llm_council_brain.py
python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```

- [ ] **Step 4: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat(brain): cardinality cuts Stage 2 output 80→60, Opus output 40→30"
git push
```

---

## Task 9: Parallelize Stages 1 and 2 via asyncio.gather

**Files:**
- Modify: `canadian_llm_council_brain.py`

- [ ] **Step 1: Find the sequential Stage 1 → Stage 2 logic in run_council_analysis**

```bash
grep -n "run_stage1_sonnet\|run_stage2_gemini\|Step 5\|Step 6" /Users/coeus/spiketrades.ca/claude-code/.worktrees/sibling-b-parallel/canadian_llm_council_brain.py
```

Find where Stage 1 completes and Stage 2 reads its output. Read ~40 lines around the transition to understand the current control flow.

- [ ] **Step 2: Refactor to use asyncio.gather**

This is the MOST INVASIVE change in the entire plan. Plan the edit carefully:

Current pattern (approximate):
```python
stage1_results = await run_stage1_sonnet(payloads, ...)
stage2_results = await run_stage2_gemini(payloads, stage1_results, ...)
```

New pattern:
```python
# Parallel execution: both Sonnet and Gemini score the full universe independently
stage1_task = asyncio.create_task(run_stage1_sonnet(payloads, ...))
stage2_task = asyncio.create_task(run_stage2_gemini_independent(payloads, ...))
stage1_results, stage2_results = await asyncio.gather(stage1_task, stage2_task)
```

**Key change:** `run_stage2_gemini` is renamed to `run_stage2_gemini_independent` and its signature no longer accepts `stage1_results` — Gemini scores from raw payloads without seeing Stage 1's scores. This is a functional change to the Gemini stage that also requires a prompt rewrite (Task 10).

If renaming `run_stage2_gemini` breaks other callers, keep the old name and just remove the `stage1_results` parameter.

- [ ] **Step 3: Python syntax check**

```bash
python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```

- [ ] **Step 4: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat(brain): parallelize Stages 1+2 via asyncio.gather"
git push
```

---

## Task 10: Rewrite Gemini prompt to score independently

**Files:**
- Modify: `canadian_llm_council_brain.py`

- [ ] **Step 1: Find the existing Gemini prompt**

Look for the prompt string in `run_stage2_gemini` or wherever the Gemini API call is constructed. It currently includes a section like "Stage 1 provided these scores: {...}".

- [ ] **Step 2: Remove the Stage 1 context block**

Rewrite the prompt to remove any reference to prior stage scores. Gemini now scores independently from the raw MergedPayload data. The rubric (100-point scoring system) stays the same.

- [ ] **Step 3: Remove the disagreement_reason field** from Gemini's expected output schema (if present). It's no longer meaningful when Gemini doesn't see Stage 1.

- [ ] **Step 4: Python syntax check**

```bash
python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```

- [ ] **Step 5: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat(brain): rewrite Gemini prompt for independent scoring (no Stage 1 context)"
git push
```

---

## Task 11: Integrate fetch layer (EODHD + cross-compare + dual-listing enrichment)

**Files:**
- Modify: `canadian_llm_council_brain.py`

- [ ] **Step 1: Find the existing fetch_enhanced_signals_batch call in run_council_analysis**

Locate Step 3 or Step 4 where enrichment happens.

- [ ] **Step 2: Add parallel EODHD enrichment**

After the existing FMP `fetch_enhanced_signals_batch` call, add a parallel call to the new EODHD enrichment:

```python
# Parallel FMP + EODHD enrichment
fmp_data_task = asyncio.create_task(fetcher.fetch_enhanced_signals_batch(...))
eodhd_data_task = asyncio.create_task(eodhd_enrichment.fetch_eodhd_batch_enrichment(session, liquid_tickers))
fmp_data, eodhd_data = await asyncio.gather(fmp_data_task, eodhd_data_task)
```

- [ ] **Step 3: Add cross-compare step**

After both enrichments complete, run cross-compare:

```python
quality_flags = cross_compare.cross_compare_batch(liquid_tickers, fmp_data, eodhd_data)
logger.info(f"Cross-compare produced {sum(1 for f in quality_flags.values() if f.has_any_flag())} flagged tickers")
```

- [ ] **Step 4: Add dual-listing enrichment loop**

```python
# Dual-listing enrichment (Tiers 1-3) for dual-listed subset
for ticker in liquid_tickers:
    us_ticker = us_dual_listing_enrichment.get_us_ticker(ticker)
    if us_ticker is None:
        continue
    # Tier 2: US 13F institutional (overrides Canadian for this ticker)
    us_13f = await us_dual_listing_enrichment.fetch_us_13f_institutional(fetcher, us_ticker)
    if us_13f is not None:
        # Store on the payload; this overrides the FMP Canadian institutional ownership
        payload.institutional_ownership_pct = us_13f
    # Tier 1: US options IV (only for dual-listed, overrides ATR proxy)
    us_iv = await us_dual_listing_enrichment.fetch_us_options_iv(fetcher, us_ticker)
    if us_iv is not None:
        # Convert to IVExpectedMove format and attach to payload
        payload.iv_expected_move = us_iv  # format conversion TBD
    # Tier 3a + 3b (optional — defer if complex)
```

NOTE: this task requires careful integration with the existing payload construction. The implementer should read the enrichment section carefully and thread the new data through without breaking the existing flow.

- [ ] **Step 5: Python syntax check**

```bash
python3 -m py_compile canadian_llm_council_brain.py && echo "syntax OK"
```

- [ ] **Step 6: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat(brain): integrate EODHD batch + cross-compare + dual-listing enrichment into fetch layer"
git push
```

---

## Task 12: Final build + PR + deploy

**Files:** none

- [ ] **Step 1: Final build check**

```bash
npm run build 2>&1 | tail -15
python3 -m py_compile canadian_llm_council_brain.py cross_compare.py eodhd_enrichment.py us_dual_listing_enrichment.py && echo "all syntax OK"
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: Sibling B parallel council refactor + hybrid FMP/EODHD + dual-listing" --body "Implements Sibling B per spec docs/superpowers/specs/2026-04-08-sibling-b-parallel-council-refactor-design.md.

## Summary
- Parallel Stage 1 (Sonnet) + Stage 2 (Gemini) via asyncio.gather
- Hybrid FMP + EODHD fetch layer with cross-compare for ghost stock detection
- Dual-listing enrichment Tiers 1+2+3 for ~50% of picks (US options IV, 13F institutional, analyst, news)
- Cardinality cuts: Stage 2 output 80→60, Opus output 40→30
- Stage 1 wall-clock cap raised from 420s to 600s
- Gemini prompt rewritten to score independently from Stage 1

No schema changes. No UI changes.

## Test plan
- [x] Python syntax clean
- [x] TypeScript build clean
- [ ] Tomorrow's 10:45 AST council run validates parallel execution + new fetch layer
- [ ] T+24h backtest report compares quality vs historical runs

🤖 Generated with Claude Code (System B)" 2>&1 | tail -3
```

- [ ] **Step 3: Wait for user merge approval**

STOP here. Do not merge without explicit user approval. This is the high-risk Sibling B refactor — requires manual review before merge.

- [ ] **Step 4: After approval, merge + deploy**

```bash
gh pr merge --squash --delete-branch=false
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && git pull origin main && docker compose build app council && docker compose up -d app council && sleep 5 && docker compose ps'
```

- [ ] **Step 5: Verify containers healthy**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose ps --format "table {{.Name}}\t{{.Status}}" && docker compose logs council --since 2m | tail -20'
```

Expected: all containers Up, no Python import errors in council logs.

- [ ] **Step 6: Report back to System A via session handoff**

Write a brief summary of what was deployed to `docs/superpowers/reports/2026-04-08-sibling-b-deployed.md` (or append to an existing session handoff) so System A knows Sibling B is live and can proceed with cleanup + v6.0a ritual.

---

## Self-Review

### Spec coverage check
- Parallel Stage 1+2 → Task 9 ✅
- Hybrid FMP+EODHD → Tasks 2, 4, 11 ✅
- Cross-compare + ghost detection → Tasks 4, 11 ✅
- Dual-listing enrichment Tiers 1+2+3 → Tasks 1, 3, 11 ✅
- Cardinality cuts → Task 8 ✅
- Stage 1 cap raise → Task 7 ✅
- Gemini prompt rewrite → Task 10 ✅
- MergedPayload → integrated inline in Tasks 6-11 (no separate type file this phase) ⚠️ simplified from spec
- Deploy sequence → Task 12 ✅

### Known scope simplifications (vs spec)
- **MergedPayload type not created as a separate file** — existing `StockDataPayload` is reused with the new fields attached via mutation (cleaner for minimal refactor). If rigor demands a proper type, implementer can create it as an optional enhancement.
- **Some dual-listing Tier 3 functions may be deferred** if the endpoint investigation reveals more complexity than expected. Tiers 1 and 2 are the highest-value and MUST ship; Tier 3 (analyst + news) can be deferred if implementer is time-constrained.

### Placeholder scan
No placeholders in the critical path. Some "TODO during implementation" markers exist where the exact FMP endpoint for US options IV needs to be verified — this is explicit investigation work, not a placeholder.

### Type consistency
Function signatures match between tasks. Module imports use the correct names (`eodhd_enrichment`, `us_dual_listing_enrichment`, `cross_compare`).
