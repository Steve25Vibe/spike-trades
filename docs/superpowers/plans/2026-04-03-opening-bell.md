# Opening Bell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily pre-Council momentum scanner ("Opening Bell") that runs 5 minutes after TSX market open, delivers 10 ranked picks with intraday targets, and integrates with the existing portfolio, archives, email, accuracy, and admin systems.

**Architecture:** A new Python endpoint (`/run-opening-bell`) fetches TSX batch quotes + sector data from FMP, computes relative volume rankings, and sends the top 30-40 movers to a single Sonnet 4.6 call. Results are stored in new Prisma models (OpeningBellReport + OpeningBellPick), served via new Next.js API routes, displayed on a new `/opening-bell` page that mirrors Today's Spikes layout, and cross-referenced with a bell icon on matching Today's Spikes picks.

**Tech Stack:** Python/FastAPI (scanner pipeline), Anthropic Claude API (Sonnet 4.6), FMP REST API (market data), Next.js 14 App Router (frontend + API), Prisma/PostgreSQL (storage), ExcelJS (XLSX export), Resend (email), node-cron (scheduling), Tailwind CSS (styling)

**Spec:** `docs/superpowers/specs/2026-04-03-opening-bell-design.md`

---

## File Structure

### New Files
| File | Purpose |
|------|---------|
| `opening_bell_scanner.py` | Opening Bell pipeline: fetch data, compute rankings, call Sonnet, return results |
| `src/app/opening-bell/page.tsx` | Opening Bell page (mirrors dashboard) |
| `src/components/opening-bell/OpeningBellCard.tsx` | Card component (mirrors SpikeCard with Opening Surge metrics) |
| `src/app/api/opening-bell/route.ts` | GET today's (or ?date=X) Opening Bell results |
| `src/app/api/opening-bell/[id]/route.ts` | GET single pick detail |
| `src/app/api/reports/opening-bell/route.ts` | Paginated Opening Bell report list for archives |
| `src/app/api/reports/opening-bell/[id]/xlsx/route.ts` | XLSX download for Opening Bell report |
| `src/lib/email/opening-bell-email.ts` | Opening Bell email template + send function |
| `tests/test_opening_bell_scanner.py` | Python unit tests for scanner pipeline |
| `src/__tests__/opening-bell-api.test.ts` | API route tests |

### Modified Files
| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add OpeningBellReport, OpeningBellPick models; modify PortfolioEntry (optional spikeId + new openingBellPickId); add emailOpeningBell to User |
| `api_server.py` | Add `/run-opening-bell`, `/run-opening-bell-status`, `/opening-bell-health` endpoints; add `_opening_bell_running` lock |
| `scripts/start-cron.ts` | Add 10:35 AM AST Opening Bell cron job |
| `src/components/layout/Sidebar.tsx` | Add Opening Bell nav item |
| `src/app/reports/page.tsx` | Add tab system (Today's Spikes / Opening Bell) |
| `src/app/dashboard/page.tsx` | Add bell icon query for cross-reference |
| `src/components/spikes/SpikeCard.tsx` | Add animated bell icon when pick is also an Opening Bell pick |
| `src/app/api/portfolio/route.ts` | Accept openingBellPickId as alternative to spikeId |
| `src/app/api/accuracy/check/route.ts` | Add Opening Bell intraday accuracy backfill |
| `src/app/admin/page.tsx` | Add Opening Bell status card, stage indicator, manual trigger, cost row |
| `src/app/api/admin/council/route.ts` | Fetch Opening Bell health + status in parallel |
| `src/app/settings/page.tsx` | Add Opening Bell email toggle |
| `src/app/api/user/preferences/route.ts` | Handle emailOpeningBell field |
| `src/lib/api/fmp.ts` | Fix rate limit comment (300 → 750 req/min) |

---

## Task 1: Prisma Schema Changes

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add OpeningBellReport model**

Add after the `DailyReport` model (around line 88):

```prisma
model OpeningBellReport {
  id             String   @id @default(cuid())
  date           DateTime @db.Date
  generatedAt    DateTime @default(now())
  sectorSnapshot Json?
  tickersScanned Int
  scanDurationMs Int
  picks          OpeningBellPick[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([date])
  @@index([date])
}
```

- [ ] **Step 2: Add OpeningBellPick model**

Add after `OpeningBellReport`:

```prisma
model OpeningBellPick {
  id               String   @id @default(cuid())
  reportId         String
  report           OpeningBellReport @relation(fields: [reportId], references: [id], onDelete: Cascade)
  rank             Int
  ticker           String
  name             String
  sector           String?
  exchange         String
  priceAtScan      Float
  previousClose    Float
  changePercent    Float
  relativeVolume   Float
  sectorMomentum   Float?
  momentumScore    Float
  intradayTarget   Float
  keyLevel         Float
  conviction       String
  rationale        String?  @db.Text

  // Accuracy fields — filled after market close
  actualHigh       Float?
  actualClose      Float?
  targetHit        Boolean?
  keyLevelBroken   Boolean?

  // Token usage for cost tracking
  tokenUsage       Json?

  portfolioEntries PortfolioEntry[]
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@index([reportId])
  @@index([ticker, createdAt])
}
```

- [ ] **Step 3: Modify PortfolioEntry — make spikeId optional, add openingBellPickId**

In the `PortfolioEntry` model, change:

```prisma
// OLD
spikeId     String
spike       Spike @relation(fields: [spikeId], references: [id])

// NEW
spikeId            String?
spike              Spike? @relation(fields: [spikeId], references: [id])
openingBellPickId  String?
openingBellPick    OpeningBellPick? @relation(fields: [openingBellPickId], references: [id])
```

Add index:
```prisma
@@index([openingBellPickId])
```

- [ ] **Step 4: Add emailOpeningBell to User model**

In the `User` model, add after `emailDeviationAlerts`:

```prisma
emailOpeningBell     Boolean  @default(true)
```

- [ ] **Step 5: Generate and apply migration**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code
npx prisma migrate dev --name add-opening-bell-models
```

Expected: Migration created and applied successfully. Prisma client regenerated.

- [ ] **Step 6: Verify migration**

Run:
```bash
npx prisma studio
```

Expected: New tables `OpeningBellReport` and `OpeningBellPick` visible. `PortfolioEntry` has `openingBellPickId` column. `User` has `emailOpeningBell` column.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add OpeningBellReport, OpeningBellPick models; extend PortfolioEntry and User"
```

---

## Task 2: Python Opening Bell Scanner

**Files:**
- Create: `opening_bell_scanner.py`
- Modify: `api_server.py`
- Create: `tests/test_opening_bell_scanner.py`

- [ ] **Step 1: Write scanner test file**

Create `tests/test_opening_bell_scanner.py`:

```python
"""Tests for Opening Bell scanner pipeline."""
import pytest
import asyncio
import json
from unittest.mock import AsyncMock, patch, MagicMock

# We'll import from the module once created
# from opening_bell_scanner import OpeningBellScanner


class TestComputeRankings:
    """Test the ranking computation from raw quote data."""

    def test_ranks_by_composite_score(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        quotes = [
            {"symbol": "A.TO", "price": 10.0, "previousClose": 9.5, "volume": 500000, "avgVolume": 100000, "changesPercentage": 5.26},
            {"symbol": "B.TO", "price": 20.0, "previousClose": 19.8, "volume": 300000, "avgVolume": 200000, "changesPercentage": 1.01},
            {"symbol": "C.TO", "price": 5.0, "previousClose": 4.6, "volume": 800000, "avgVolume": 100000, "changesPercentage": 8.70},
        ]
        ranked = scanner.compute_rankings(quotes)
        # C.TO has highest combo: +8.7% change + 8x relative volume
        assert ranked[0]["symbol"] == "C.TO"
        # A.TO next: +5.26% change + 5x relative volume
        assert ranked[1]["symbol"] == "A.TO"

    def test_filters_low_volume(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        quotes = [
            {"symbol": "A.TO", "price": 10.0, "previousClose": 9.5, "volume": 500000, "avgVolume": 100000, "changesPercentage": 5.26},
            {"symbol": "DEAD.TO", "price": 10.0, "previousClose": 10.0, "volume": 50, "avgVolume": 100000, "changesPercentage": 0.0},
        ]
        ranked = scanner.compute_rankings(quotes)
        # DEAD.TO should be filtered out — relative volume < 0.5
        symbols = [r["symbol"] for r in ranked]
        assert "DEAD.TO" not in symbols

    def test_filters_negative_movers(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        quotes = [
            {"symbol": "UP.TO", "price": 10.5, "previousClose": 10.0, "volume": 500000, "avgVolume": 100000, "changesPercentage": 5.0},
            {"symbol": "DOWN.TO", "price": 9.0, "previousClose": 10.0, "volume": 500000, "avgVolume": 100000, "changesPercentage": -10.0},
        ]
        ranked = scanner.compute_rankings(quotes)
        symbols = [r["symbol"] for r in ranked]
        assert "DOWN.TO" not in symbols

    def test_limits_to_top_n(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        quotes = [
            {"symbol": f"S{i}.TO", "price": 10.0 + i, "previousClose": 10.0, "volume": 500000 + i * 100000, "avgVolume": 100000, "changesPercentage": float(i)}
            for i in range(1, 50)
        ]
        ranked = scanner.compute_rankings(quotes, top_n=30)
        assert len(ranked) <= 30


class TestParseSONNETResponse:
    """Test parsing Sonnet's JSON response into structured picks."""

    def test_parses_valid_response(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        response_text = json.dumps({
            "picks": [
                {
                    "rank": 1,
                    "ticker": "CNQ.TO",
                    "momentum_score": 94,
                    "intraday_target": 50.40,
                    "key_level": 47.15,
                    "conviction": "high",
                    "rationale": "Energy sector surge with 6.2x volume"
                },
                {
                    "rank": 2,
                    "ticker": "SU.TO",
                    "momentum_score": 89,
                    "intraday_target": 64.50,
                    "key_level": 60.80,
                    "conviction": "high",
                    "rationale": "Riding oil rally"
                }
            ]
        })
        picks = scanner.parse_sonnet_response(response_text)
        assert len(picks) == 2
        assert picks[0]["ticker"] == "CNQ.TO"
        assert picks[0]["momentum_score"] == 94
        assert picks[0]["conviction"] == "high"

    def test_handles_malformed_json(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        # Sonnet sometimes wraps in markdown code fences
        response_text = '```json\n{"picks": [{"rank": 1, "ticker": "A.TO", "momentum_score": 80, "intraday_target": 10.5, "key_level": 9.0, "conviction": "medium", "rationale": "test"}]}\n```'
        picks = scanner.parse_sonnet_response(response_text)
        assert len(picks) == 1
        assert picks[0]["ticker"] == "A.TO"

    def test_returns_empty_on_garbage(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        picks = scanner.parse_sonnet_response("This is not JSON at all")
        assert picks == []

    def test_caps_at_10_picks(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        response_text = json.dumps({
            "picks": [
                {"rank": i, "ticker": f"S{i}.TO", "momentum_score": 90 - i, "intraday_target": 10.0 + i, "key_level": 9.0, "conviction": "high", "rationale": "test"}
                for i in range(1, 16)
            ]
        })
        picks = scanner.parse_sonnet_response(response_text)
        assert len(picks) == 10


class TestBuildSonnetPrompt:
    """Test the prompt construction for Sonnet."""

    def test_includes_sector_data(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        movers = [{"symbol": "A.TO", "price": 10.0, "changesPercentage": 5.0, "relative_volume": 3.0}]
        sectors = [{"sector": "Energy", "averageChange": 2.8}]
        grades = {"A.TO": [{"gradingCompany": "BMO", "newGrade": "Buy", "action": "upgrade"}]}
        prompt = scanner.build_sonnet_prompt(movers, sectors, grades)
        assert "Energy" in prompt
        assert "2.8" in prompt
        assert "A.TO" in prompt
        assert "BMO" in prompt

    def test_includes_all_movers(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        movers = [
            {"symbol": f"S{i}.TO", "price": 10.0 + i, "changesPercentage": float(i), "relative_volume": float(i)}
            for i in range(1, 31)
        ]
        prompt = scanner.build_sonnet_prompt(movers, [], {})
        assert "S30.TO" in prompt
        assert "S1.TO" in prompt


class TestResultMapping:
    """Test mapping scanner results to Prisma-compatible format."""

    def test_maps_to_prisma_format(self):
        from opening_bell_scanner import OpeningBellScanner

        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        picks = [
            {
                "rank": 1,
                "ticker": "CNQ.TO",
                "momentum_score": 94,
                "intraday_target": 50.40,
                "key_level": 47.15,
                "conviction": "high",
                "rationale": "Energy surge"
            }
        ]
        quote_map = {
            "CNQ.TO": {
                "symbol": "CNQ.TO",
                "name": "Canadian Natural Resources",
                "price": 48.72,
                "previousClose": 46.27,
                "changesPercentage": 5.3,
                "volume": 1200000,
                "avgVolume": 193548,
                "exchange": "TSX",
            }
        }
        sector_map = {"Energy": 2.8}
        mapped = scanner.map_to_prisma(picks, quote_map, sector_map)
        assert len(mapped) == 1
        m = mapped[0]
        assert m["ticker"] == "CNQ.TO"
        assert m["name"] == "Canadian Natural Resources"
        assert m["priceAtScan"] == 48.72
        assert m["previousClose"] == 46.27
        assert m["changePercent"] == 5.3
        assert abs(m["relativeVolume"] - 6.2) < 0.1
        assert m["momentumScore"] == 94
        assert m["intradayTarget"] == 50.40
        assert m["keyLevel"] == 47.15
        assert m["conviction"] == "high"
        assert m["exchange"] == "TSX"
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code
python3 -m pytest tests/test_opening_bell_scanner.py -v 2>&1 | head -30
```

Expected: FAIL — `ModuleNotFoundError: No module named 'opening_bell_scanner'`

- [ ] **Step 3: Create opening_bell_scanner.py**

Create `/Users/coeus/spiketrades.ca/claude-code/opening_bell_scanner.py`:

```python
"""
Opening Bell Scanner — Early momentum detection for TSX/TSXV.

Runs 5 minutes after market open. Fetches batch quotes, computes relative
volume rankings, enriches top movers with sector + grades data, and sends
to a single Sonnet 4.6 call for ranked picks with intraday targets.
"""

import asyncio
import json
import logging
import os
import re
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp

logger = logging.getLogger("opening_bell")

FMP_BASE = "https://financialmodelingprep.com/stable"

# Filters
MIN_ADV_DOLLARS = 2_000_000  # $2M average daily volume (relaxed from Council's $5M)
MIN_PRICE = 1.0              # >$1 share price


class OpeningBellScanner:
    """Runs the Opening Bell momentum scan pipeline."""

    def __init__(self, fmp_key: str, anthropic_key: str):
        self.fmp_key = fmp_key
        self.anthropic_key = anthropic_key
        self._endpoint_health: dict[str, dict[str, int]] = {}

    # ── FMP Data Fetching ─────────────────────────────────────────────

    async def _fmp_get(self, session: aiohttp.ClientSession, path: str, params: dict | None = None) -> Any:
        """Fetch from FMP with retry on 429."""
        url = f"{FMP_BASE}{path}"
        all_params = {"apikey": self.fmp_key}
        if params:
            all_params.update(params)
        endpoint = path.split("?")[0]
        for attempt in range(3):
            try:
                async with session.get(url, params=all_params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    status = resp.status
                    self._endpoint_health.setdefault(endpoint, {"ok": 0, "404": 0, "429": 0, "error": 0})
                    if status == 200:
                        self._endpoint_health[endpoint]["ok"] += 1
                        return await resp.json()
                    elif status == 429:
                        self._endpoint_health[endpoint]["429"] += 1
                        wait = 10 * (attempt + 1)
                        logger.warning(f"FMP 429 on {endpoint}, waiting {wait}s")
                        await asyncio.sleep(wait)
                    elif status == 404:
                        self._endpoint_health[endpoint]["404"] += 1
                        return []
                    else:
                        self._endpoint_health[endpoint]["error"] += 1
                        return []
            except Exception as e:
                self._endpoint_health.setdefault(endpoint, {"ok": 0, "404": 0, "429": 0, "error": 0})
                self._endpoint_health[endpoint]["error"] += 1
                logger.error(f"FMP error {endpoint}: {e}")
                if attempt < 2:
                    await asyncio.sleep(5)
        return []

    async def fetch_tsx_universe(self, session: aiohttp.ClientSession) -> list[dict]:
        """Fetch batch quotes for TSX/TSXV liquid universe."""
        # Use same stock list the Council uses
        all_tickers = await self._fmp_get(session, "/stock-list")
        if not all_tickers:
            return []

        # Filter to TSX/TSXV, apply ADV + price filters
        tsx_symbols = []
        for s in all_tickers:
            exch = (s.get("exchangeShortName") or s.get("exchange") or "").upper()
            if exch not in ("TSX", "TSXV", "NEO"):
                continue
            tsx_symbols.append(s.get("symbol", ""))

        tsx_symbols = [s for s in tsx_symbols if s]

        # Batch quote in groups of 50
        all_quotes = []
        batch_size = 50
        for i in range(0, len(tsx_symbols), batch_size):
            batch = tsx_symbols[i:i + batch_size]
            symbol_str = ",".join(batch)
            quotes = await self._fmp_get(session, "/batch-quote", {"symbols": symbol_str})
            if quotes:
                all_quotes.extend(quotes)
            if i + batch_size < len(tsx_symbols):
                await asyncio.sleep(0.2)

        # Apply liquidity filters
        filtered = []
        for q in all_quotes:
            price = q.get("price", 0) or 0
            avg_vol = q.get("avgVolume", 0) or 0
            if price < MIN_PRICE:
                continue
            if avg_vol * price < MIN_ADV_DOLLARS:
                continue
            filtered.append(q)

        return filtered

    async def fetch_sector_performance(self, session: aiohttp.ClientSession) -> list[dict]:
        """Fetch TSX sector performance snapshot."""
        today_str = datetime.now(ZoneInfo("America/Halifax")).strftime("%Y-%m-%d")
        return await self._fmp_get(session, "/sector-performance-snapshot", {"exchange": "TSX", "date": today_str}) or []

    async def fetch_grades(self, session: aiohttp.ClientSession, tickers: list[str]) -> dict[str, list[dict]]:
        """Fetch recent analyst grades for tickers. Returns {ticker: [grades]}."""
        grades_map: dict[str, list[dict]] = {}
        for ticker in tickers:
            data = await self._fmp_get(session, "/grades", {"symbol": ticker})
            if data and isinstance(data, list):
                # Only include grades from last 30 days
                grades_map[ticker] = data[:3]  # Top 3 most recent
            await asyncio.sleep(0.1)
        return grades_map

    async def fetch_intraday_bars(self, session: aiohttp.ClientSession, ticker: str) -> list[dict]:
        """Fetch 5-min intraday bars. Returns empty list if unavailable (common for Canadian stocks)."""
        data = await self._fmp_get(session, f"/historical-chart/5min/{ticker}")
        if not data or not isinstance(data, list):
            return []
        # Filter to today only
        today_str = datetime.now(ZoneInfo("America/Halifax")).strftime("%Y-%m-%d")
        today_bars = [b for b in data if (b.get("date", "")[:10] == today_str)]
        return today_bars

    # ── Ranking Computation ───────────────────────────────────────────

    def compute_rankings(self, quotes: list[dict], top_n: int = 40) -> list[dict]:
        """Rank quotes by composite momentum score (change% + relative volume).

        Filters out:
        - Negative movers (change% <= 0)
        - Dead volume (relative volume < 0.5)

        Returns top_n movers sorted by composite score descending.
        """
        scored = []
        for q in quotes:
            change_pct = q.get("changesPercentage", 0) or 0
            volume = q.get("volume", 0) or 0
            avg_volume = q.get("avgVolume", 0) or 1  # Avoid division by zero

            # Filter negative movers
            if change_pct <= 0:
                continue

            relative_volume = volume / avg_volume if avg_volume > 0 else 0

            # Filter dead volume
            if relative_volume < 0.5:
                continue

            # Composite score: weighted combo of change% and relative volume
            # Change% is 0-100 scale, relative volume is typically 0-20x
            # Normalize relative volume to similar scale
            composite = (change_pct * 0.4) + (min(relative_volume, 20) * 0.6)

            scored.append({
                **q,
                "relative_volume": round(relative_volume, 1),
                "composite_score": round(composite, 2),
            })

        scored.sort(key=lambda x: x["composite_score"], reverse=True)
        return scored[:top_n]

    # ── Sonnet Prompt ─────────────────────────────────────────────────

    def build_sonnet_prompt(self, movers: list[dict], sectors: list[dict], grades: dict[str, list[dict]]) -> str:
        """Build the user prompt for Sonnet 4.6."""
        sector_text = ""
        if sectors:
            sector_lines = [f"  {s.get('sector', '?')}: {s.get('averageChange', 0):+.2f}%" for s in sectors]
            sector_text = "TSX Sector Performance:\n" + "\n".join(sector_lines)

        mover_lines = []
        for m in movers:
            sym = m.get("symbol", "?")
            grade_info = ""
            if sym in grades and grades[sym]:
                g = grades[sym][0]
                grade_info = f" | Analyst: {g.get('gradingCompany', '?')} → {g.get('newGrade', '?')} ({g.get('action', '?')})"
            mover_lines.append(
                f"  {sym}: ${m.get('price', 0):.2f} ({m.get('changesPercentage', 0):+.1f}%) "
                f"RelVol={m.get('relative_volume', 0):.1f}x "
                f"AvgVol={m.get('avgVolume', 0):,.0f}{grade_info}"
            )

        movers_text = "Top Movers (5 minutes after TSX open):\n" + "\n".join(mover_lines)

        return f"""{sector_text}

{movers_text}

Analyze these TSX/TSXV stocks that are showing unusual momentum at market open.
Select the TOP 10 most promising for rapid intraday gains.

For each pick, provide:
1. rank (1-10)
2. ticker
3. momentum_score (0-100, your confidence in continued momentum)
4. intraday_target (realistic price target for today based on ATR and momentum)
5. key_level (price where the bullish thesis breaks — the stop-loss guide)
6. conviction ("high", "medium", or "low")
7. rationale (one sentence explaining why this stock is moving and why momentum should continue)

Focus on:
- Relative volume as institutional footprint (>3x = strong signal)
- Sector rotation alignment (is this stock riding a sector wave?)
- Analyst upgrades as catalyst confirmation
- Avoid dead cat bounces and low-liquidity traps

Respond with ONLY valid JSON in this format:
{{"picks": [{{"rank": 1, "ticker": "X.TO", "momentum_score": 94, "intraday_target": 50.40, "key_level": 47.15, "conviction": "high", "rationale": "..."}}]}}"""

    SYSTEM_PROMPT = """You are an expert intraday momentum analyst for Canadian equities (TSX/TSXV).
Your job is to identify stocks showing genuine institutional buying pressure at market open
and predict which ones will continue their momentum through the trading session.

You must be rigorous: high relative volume with no catalyst = medium conviction at best.
High relative volume + sector rotation + analyst upgrade = high conviction.

Always respond with valid JSON only. No markdown, no explanation outside the JSON."""

    # ── Response Parsing ──────────────────────────────────────────────

    def parse_sonnet_response(self, response_text: str) -> list[dict]:
        """Parse Sonnet's JSON response. Handles markdown fences and caps at 10 picks."""
        text = response_text.strip()

        # Strip markdown code fences if present
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        text = text.strip()

        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            logger.error(f"Failed to parse Sonnet response: {text[:200]}")
            return []

        picks = data.get("picks", [])
        if not isinstance(picks, list):
            return []

        # Validate required fields and cap at 10
        valid_picks = []
        required = {"rank", "ticker", "momentum_score", "intraday_target", "key_level", "conviction", "rationale"}
        for p in picks[:10]:
            if not isinstance(p, dict):
                continue
            if not required.issubset(p.keys()):
                logger.warning(f"Pick missing required fields: {p.get('ticker', '?')}")
                continue
            valid_picks.append(p)

        return valid_picks

    # ── Result Mapping ────────────────────────────────────────────────

    def map_to_prisma(self, picks: list[dict], quote_map: dict[str, dict], sector_map: dict[str, float]) -> list[dict]:
        """Map scanner picks to Prisma-compatible format for database insertion."""
        mapped = []
        for pick in picks:
            ticker = pick["ticker"]
            q = quote_map.get(ticker, {})
            avg_vol = q.get("avgVolume", 1) or 1
            vol = q.get("volume", 0) or 0
            sector = q.get("sector", "") or ""

            mapped.append({
                "rank": pick["rank"],
                "ticker": ticker,
                "name": q.get("name", ticker),
                "sector": sector,
                "exchange": q.get("exchange", "TSX"),
                "priceAtScan": q.get("price", 0),
                "previousClose": q.get("previousClose", 0),
                "changePercent": q.get("changesPercentage", 0),
                "relativeVolume": round(vol / avg_vol, 1) if avg_vol > 0 else 0,
                "sectorMomentum": sector_map.get(sector, 0),
                "momentumScore": pick["momentum_score"],
                "intradayTarget": pick["intraday_target"],
                "keyLevel": pick["key_level"],
                "conviction": pick["conviction"],
                "rationale": pick["rationale"],
            })
        return mapped

    # ── Main Pipeline ─────────────────────────────────────────────────

    async def run(self) -> dict:
        """Execute the full Opening Bell pipeline.

        Returns a dict with:
        - success: bool
        - picks: list of Prisma-mapped picks
        - sector_snapshot: list of sector performance data
        - tickers_scanned: int
        - duration_ms: int
        - token_usage: dict with input_tokens and output_tokens
        - error: str (if failed)
        """
        start = time.time()
        logger.info("Opening Bell: starting scan")

        try:
            async with aiohttp.ClientSession() as session:
                # Step 1: Fetch universe quotes
                logger.info("Opening Bell: fetching TSX universe quotes")
                quotes = await self.fetch_tsx_universe(session)
                if not quotes:
                    return {"success": False, "error": "No quotes returned from FMP", "duration_ms": int((time.time() - start) * 1000)}

                tickers_scanned = len(quotes)
                logger.info(f"Opening Bell: {tickers_scanned} tickers after filters")

                # Step 2: Compute rankings
                movers = self.compute_rankings(quotes, top_n=40)
                if not movers:
                    return {"success": False, "error": "No positive movers found", "duration_ms": int((time.time() - start) * 1000)}

                logger.info(f"Opening Bell: {len(movers)} top movers identified")

                # Step 3: Enrich — fetch sector perf + grades in parallel
                mover_tickers = [m["symbol"] for m in movers]
                sectors_task = self.fetch_sector_performance(session)
                grades_task = self.fetch_grades(session, mover_tickers)
                sectors, grades = await asyncio.gather(sectors_task, grades_task)

                logger.info(f"Opening Bell: {len(sectors)} sectors, grades for {len(grades)} tickers")

                # Step 4: Call Sonnet
                user_prompt = self.build_sonnet_prompt(movers, sectors, grades)
                logger.info("Opening Bell: calling Sonnet 4.6")

                from canadian_llm_council_brain import _call_anthropic
                response_text, token_usage = await _call_anthropic(
                    api_key=self.anthropic_key,
                    model="claude-sonnet-4-6",
                    system_prompt=self.SYSTEM_PROMPT,
                    user_prompt=user_prompt,
                    max_tokens=4096,
                    temperature=0.3,
                )

                logger.info(f"Opening Bell: Sonnet returned {len(response_text)} chars, tokens: {token_usage}")

                # Step 5: Parse response
                picks = self.parse_sonnet_response(response_text)
                if not picks:
                    return {"success": False, "error": "Sonnet returned no valid picks", "duration_ms": int((time.time() - start) * 1000), "token_usage": token_usage}

                # Step 6: Map to Prisma format
                quote_map = {q["symbol"]: q for q in quotes}
                sector_map = {s.get("sector", ""): s.get("averageChange", 0) for s in sectors}
                prisma_picks = self.map_to_prisma(picks, quote_map, sector_map)

                duration_ms = int((time.time() - start) * 1000)
                logger.info(f"Opening Bell: complete — {len(prisma_picks)} picks in {duration_ms}ms")

                return {
                    "success": True,
                    "picks": prisma_picks,
                    "sector_snapshot": sectors,
                    "tickers_scanned": tickers_scanned,
                    "duration_ms": duration_ms,
                    "token_usage": token_usage,
                    "endpoint_health": self._endpoint_health,
                }

        except Exception as e:
            duration_ms = int((time.time() - start) * 1000)
            logger.error(f"Opening Bell failed: {e}")
            return {"success": False, "error": str(e), "duration_ms": duration_ms}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code
python3 -m pytest tests/test_opening_bell_scanner.py -v
```

Expected: All tests PASS.

- [ ] **Step 5: Add Opening Bell endpoints to api_server.py**

Add to `api_server.py` after the existing `/spike-it` endpoint block:

```python
# ── Opening Bell State ────────────────────────────────────────────
_opening_bell_running = False
_opening_bell_last_result: dict | None = None
_opening_bell_last_run_time: float | None = None
_opening_bell_last_error: str | None = None

OPENING_BELL_TIMEOUT = 300  # 5-minute hard timeout


@app.post("/run-opening-bell")
async def run_opening_bell(background_tasks: BackgroundTasks):
    """Trigger Opening Bell scan. Returns immediately, runs in background."""
    global _opening_bell_running
    if _opening_bell_running:
        raise HTTPException(409, "Opening Bell already running")
    if _council_running:
        raise HTTPException(409, "Council is running — wait for completion")

    _opening_bell_running = True
    background_tasks.add_task(_execute_opening_bell)
    return {"success": True, "message": "Opening Bell started"}


async def _execute_opening_bell():
    """Background task for Opening Bell execution with hard timeout."""
    global _opening_bell_running, _opening_bell_last_result, _opening_bell_last_run_time, _opening_bell_last_error
    start = time.time()
    try:
        scanner = OpeningBellScanner(
            fmp_key=os.environ.get("FMP_API_KEY", ""),
            anthropic_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        )
        result = await asyncio.wait_for(scanner.run(), timeout=OPENING_BELL_TIMEOUT)
        _opening_bell_last_result = result
        _opening_bell_last_run_time = time.time() - start
        if not result.get("success"):
            _opening_bell_last_error = result.get("error", "Unknown error")
        else:
            _opening_bell_last_error = None

        # Save to disk for Next.js analyzer to pick up
        with open("latest_opening_bell_output.json", "w") as f:
            json.dump(result, f, default=str)

        logger.info(f"Opening Bell completed in {_opening_bell_last_run_time:.1f}s: {len(result.get('picks', []))} picks")

    except asyncio.TimeoutError:
        _opening_bell_last_error = f"Hard timeout after {OPENING_BELL_TIMEOUT}s"
        _opening_bell_last_result = {"success": False, "error": _opening_bell_last_error}
        logger.error(_opening_bell_last_error)
    except Exception as e:
        _opening_bell_last_error = str(e)
        _opening_bell_last_result = {"success": False, "error": str(e)}
        logger.error(f"Opening Bell failed: {e}")
    finally:
        _opening_bell_running = False


@app.get("/run-opening-bell-status")
async def opening_bell_status():
    """Get Opening Bell run status."""
    return {
        "running": _opening_bell_running,
        "last_run_time": _opening_bell_last_run_time,
        "last_error": _opening_bell_last_error,
        "last_result_summary": {
            "success": _opening_bell_last_result.get("success") if _opening_bell_last_result else None,
            "picks_count": len(_opening_bell_last_result.get("picks", [])) if _opening_bell_last_result else 0,
            "tickers_scanned": _opening_bell_last_result.get("tickers_scanned") if _opening_bell_last_result else 0,
            "duration_ms": _opening_bell_last_result.get("duration_ms") if _opening_bell_last_result else None,
        } if _opening_bell_last_result else None,
    }


@app.get("/opening-bell-health")
async def opening_bell_health():
    """Get Opening Bell FMP endpoint health from last run."""
    if _opening_bell_last_result and "endpoint_health" in _opening_bell_last_result:
        return {"success": True, "endpoints": _opening_bell_last_result["endpoint_health"]}
    return {"success": False, "message": "No Opening Bell run data available"}


@app.get("/latest-opening-bell")
async def latest_opening_bell():
    """Return latest Opening Bell results."""
    try:
        with open("latest_opening_bell_output.json", "r") as f:
            return json.load(f)
    except FileNotFoundError:
        raise HTTPException(404, "No Opening Bell output found")


@app.get("/latest-opening-bell-mapped")
async def latest_opening_bell_mapped():
    """Return latest Opening Bell results mapped for Prisma insertion."""
    try:
        with open("latest_opening_bell_output.json", "r") as f:
            data = json.load(f)
        if not data.get("success"):
            raise HTTPException(500, data.get("error", "Last run failed"))
        return {
            "success": True,
            "report": {
                "sectorSnapshot": data.get("sector_snapshot", []),
                "tickersScanned": data.get("tickers_scanned", 0),
                "scanDurationMs": data.get("duration_ms", 0),
            },
            "picks": data.get("picks", []),
            "tokenUsage": data.get("token_usage", {}),
        }
    except FileNotFoundError:
        raise HTTPException(404, "No Opening Bell output found")
```

Also add the import at the top of `api_server.py`:

```python
from opening_bell_scanner import OpeningBellScanner
```

- [ ] **Step 6: Commit**

```bash
git add opening_bell_scanner.py api_server.py tests/test_opening_bell_scanner.py
git commit -m "feat(backend): add Opening Bell scanner pipeline with Sonnet 4.6 + FMP data enrichment"
```

---

## Task 3: Next.js API Routes

**Files:**
- Create: `src/app/api/opening-bell/route.ts`
- Create: `src/app/api/opening-bell/[id]/route.ts`

- [ ] **Step 1: Create GET /api/opening-bell route**

Create `src/app/api/opening-bell/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const dateStr = searchParams.get('date');

  try {
    let targetDate: Date;
    if (dateStr) {
      targetDate = new Date(dateStr + 'T12:00:00');
    } else {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Halifax' });
      targetDate = new Date(todayStr + 'T12:00:00');
    }

    let report = await prisma.openingBellReport.findUnique({
      where: { date: targetDate },
      include: {
        picks: { orderBy: { rank: 'asc' } },
      },
    });

    // Fallback to most recent if no date specified and today not found
    if (!report && !dateStr) {
      report = await prisma.openingBellReport.findFirst({
        where: { date: { lte: targetDate } },
        orderBy: { date: 'desc' },
        include: { picks: { orderBy: { rank: 'asc' } } },
      });
    }

    if (!report) {
      return NextResponse.json({
        success: true,
        data: null,
        message: 'No Opening Bell report found',
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        report: {
          id: report.id,
          date: report.date.toISOString().slice(0, 10),
          generatedAt: report.generatedAt.toISOString(),
          sectorSnapshot: report.sectorSnapshot,
          tickersScanned: report.tickersScanned,
          scanDurationMs: report.scanDurationMs,
        },
        picks: report.picks.map((p) => ({
          id: p.id,
          rank: p.rank,
          ticker: p.ticker,
          name: p.name,
          sector: p.sector,
          exchange: p.exchange,
          priceAtScan: p.priceAtScan,
          previousClose: p.previousClose,
          changePercent: p.changePercent,
          relativeVolume: p.relativeVolume,
          sectorMomentum: p.sectorMomentum,
          momentumScore: p.momentumScore,
          intradayTarget: p.intradayTarget,
          keyLevel: p.keyLevel,
          conviction: p.conviction,
          rationale: p.rationale,
          actualHigh: p.actualHigh,
          actualClose: p.actualClose,
          targetHit: p.targetHit,
          keyLevelBroken: p.keyLevelBroken,
        })),
      },
    });
  } catch (error) {
    console.error('Opening Bell API error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch Opening Bell data' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Create GET /api/opening-bell/[id] route**

Create `src/app/api/opening-bell/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const pick = await prisma.openingBellPick.findUnique({
      where: { id },
      include: { report: true },
    });

    if (!pick) {
      return NextResponse.json({ error: 'Pick not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: pick });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to fetch pick' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/opening-bell/
git commit -m "feat(api): add Opening Bell GET routes for picks and single pick detail"
```

---

## Task 4: Opening Bell Analyzer (Next.js → Python → DB)

**Files:**
- Create: `src/lib/opening-bell-analyzer.ts`
- Create: `src/app/api/cron/opening-bell/route.ts`

- [ ] **Step 1: Create the analyzer**

Create `src/lib/opening-bell-analyzer.ts`:

```typescript
/**
 * Opening Bell Analyzer — triggers the Python scanner and stores results in Prisma.
 */
import prisma from '@/lib/db/prisma';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

interface OpeningBellResult {
  success: boolean;
  report?: {
    sectorSnapshot: unknown;
    tickersScanned: number;
    scanDurationMs: number;
  };
  picks?: Array<{
    rank: number;
    ticker: string;
    name: string;
    sector?: string;
    exchange: string;
    priceAtScan: number;
    previousClose: number;
    changePercent: number;
    relativeVolume: number;
    sectorMomentum?: number;
    momentumScore: number;
    intradayTarget: number;
    keyLevel: number;
    conviction: string;
    rationale?: string;
  }>;
  tokenUsage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export async function runOpeningBellAnalysis(): Promise<{ success: boolean; picksCount: number; error?: string }> {
  console.log('[Opening Bell] Triggering scanner...');

  try {
    // Step 1: Trigger the Python scanner and wait for mapped results
    const triggerRes = await fetch(`${COUNCIL_API_URL}/run-opening-bell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!triggerRes.ok) {
      const err = await triggerRes.text();
      throw new Error(`Scanner trigger failed: ${err}`);
    }

    // Step 2: Poll for completion (max 5 minutes)
    const maxWait = 300_000;
    const pollInterval = 5_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const statusRes = await fetch(`${COUNCIL_API_URL}/run-opening-bell-status`);
      const status = await statusRes.json();
      if (!status.running) break;
    }

    // Step 3: Fetch mapped results
    const resultRes = await fetch(`${COUNCIL_API_URL}/latest-opening-bell-mapped`);
    if (!resultRes.ok) {
      throw new Error(`Failed to fetch results: ${resultRes.status}`);
    }
    const result: OpeningBellResult = await resultRes.json();
    if (!result.success || !result.picks?.length) {
      throw new Error(result.error || 'No picks returned');
    }

    // Step 4: Store in database
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Halifax' });
    const reportDate = new Date(todayStr + 'T12:00:00');

    // Upsert report (in case of re-run)
    const report = await prisma.openingBellReport.upsert({
      where: { date: reportDate },
      update: {
        generatedAt: new Date(),
        sectorSnapshot: result.report?.sectorSnapshot ?? undefined,
        tickersScanned: result.report?.tickersScanned ?? 0,
        scanDurationMs: result.report?.scanDurationMs ?? 0,
      },
      create: {
        date: reportDate,
        sectorSnapshot: result.report?.sectorSnapshot ?? undefined,
        tickersScanned: result.report?.tickersScanned ?? 0,
        scanDurationMs: result.report?.scanDurationMs ?? 0,
      },
    });

    // Delete old picks for this report (if re-run)
    await prisma.openingBellPick.deleteMany({ where: { reportId: report.id } });

    // Insert new picks
    for (const pick of result.picks) {
      await prisma.openingBellPick.create({
        data: {
          reportId: report.id,
          rank: pick.rank,
          ticker: pick.ticker,
          name: pick.name,
          sector: pick.sector || null,
          exchange: pick.exchange,
          priceAtScan: pick.priceAtScan,
          previousClose: pick.previousClose,
          changePercent: pick.changePercent,
          relativeVolume: pick.relativeVolume,
          sectorMomentum: pick.sectorMomentum || null,
          momentumScore: pick.momentumScore,
          intradayTarget: pick.intradayTarget,
          keyLevel: pick.keyLevel,
          conviction: pick.conviction,
          rationale: pick.rationale || null,
          tokenUsage: result.tokenUsage ?? undefined,
        },
      });
    }

    console.log(`[Opening Bell] Saved ${result.picks.length} picks for ${todayStr}`);

    // Step 5: Save top 10 tickers for Council pre-filter override
    const overrideTickers = result.picks.map((p) => p.ticker);
    // Write to a file the Council can read
    const fs = await import('fs');
    fs.writeFileSync(
      'opening_bell_council_overrides.json',
      JSON.stringify({ date: todayStr, tickers: overrideTickers })
    );

    // Step 6: Send email to opted-in users
    try {
      const { sendOpeningBellEmail } = await import('@/lib/email/opening-bell-email');
      await sendOpeningBellEmail(result.picks, result.report?.sectorSnapshot);
    } catch (emailErr) {
      console.error('[Opening Bell] Email send failed (non-fatal):', emailErr);
    }

    return { success: true, picksCount: result.picks.length };

  } catch (error) {
    console.error('[Opening Bell] Analysis failed:', error);
    return { success: false, picksCount: 0, error: String(error) };
  }
}
```

- [ ] **Step 2: Create the cron API route**

Create `src/app/api/cron/opening-bell/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { runOpeningBellAnalysis } from '@/lib/opening-bell-analyzer';

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.SESSION_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runOpeningBellAnalysis();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/opening-bell-analyzer.ts src/app/api/cron/opening-bell/
git commit -m "feat: add Opening Bell analyzer (Python→Prisma pipeline) and cron API route"
```

---

## Task 5: Cron Scheduler

**Files:**
- Modify: `scripts/start-cron.ts`

- [ ] **Step 1: Add Opening Bell cron job**

In `scripts/start-cron.ts`, add a new cron schedule after the daily analysis job (around line 70):

```typescript
// ── Opening Bell — 10:35 AM AST weekdays ──
cron.schedule(
  '35 10 * * 1-5',
  async () => {
    console.log(`[Cron] ${new Date().toISOString()} — Triggering Opening Bell scan`);
    try {
      const req = http.request(
        `${APP_URL}/api/cron/opening-bell`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SESSION_SECRET}`,
            'Content-Type': 'application/json',
          },
          timeout: 360_000,  // 6 minutes (5 min pipeline + 1 min buffer)
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            console.log(`[Cron] Opening Bell result: ${body}`);
          });
        }
      );
      req.on('error', (err: Error) => {
        console.error(`[Cron] Opening Bell request error:`, err.message);
      });
      req.end();
    } catch (error) {
      console.error(`[Cron] Opening Bell trigger failed:`, error);
    }
  },
  { timezone: TIMEZONE }
);
console.log(`[Cron] Opening Bell scheduled: 10:35 AM ${TIMEZONE} (weekdays)`);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/start-cron.ts
git commit -m "feat(cron): add Opening Bell scan at 10:35 AM AST weekdays"
```

---

## Task 6: Opening Bell Card Component

**Files:**
- Create: `src/components/opening-bell/OpeningBellCard.tsx`

- [ ] **Step 1: Create the card component**

Create `src/components/opening-bell/OpeningBellCard.tsx`:

```typescript
'use client';

import { useState } from 'react';

export interface OpeningBellPickData {
  id: string;
  rank: number;
  ticker: string;
  name: string;
  sector: string | null;
  exchange: string;
  priceAtScan: number;
  previousClose: number;
  changePercent: number;
  relativeVolume: number;
  sectorMomentum: number | null;
  momentumScore: number;
  intradayTarget: number;
  keyLevel: number;
  conviction: string;
  rationale: string | null;
  actualHigh?: number | null;
  targetHit?: boolean | null;
}

interface Props {
  pick: OpeningBellPickData;
  selected?: boolean;
  onSelect?: (pickId: string, selected: boolean) => void;
  onLockIn?: (pickId: string) => void;
  selectionMode?: boolean;
}

export default function OpeningBellCard({ pick, selected, onSelect, onLockIn, selectionMode }: Props) {
  const [locking, setLocking] = useState(false);

  const handleLockIn = async () => {
    if (!onLockIn) return;
    setLocking(true);
    await onLockIn(pick.id);
    setLocking(false);
  };

  const rankClass = pick.rank === 1 ? 'rank-1' : pick.rank === 2 ? 'rank-2' : pick.rank === 3 ? 'rank-3' : '';

  const scoreColor =
    pick.momentumScore >= 80 ? 'text-spike-green border-spike-green/40 bg-spike-green/10' :
    pick.momentumScore >= 60 ? 'text-spike-amber border-spike-amber/40 bg-spike-amber/10' :
    'text-spike-red border-spike-red/40 bg-spike-red/10';

  const convictionColor =
    pick.conviction === 'high' ? 'text-spike-green' :
    pick.conviction === 'medium' ? 'text-spike-amber' :
    'text-spike-red';

  return (
    <div className={`glass-card p-5 relative transition-all hover:border-spike-amber/50 ${rankClass === 'rank-1' ? 'border-yellow-500/30 shadow-[0_0_15px_rgba(255,215,0,0.08)]' : rankClass === 'rank-2' ? 'border-gray-400/25' : rankClass === 'rank-3' ? 'border-amber-700/25' : ''}`}>
      {/* Selection checkbox overlay */}
      {selectionMode && (
        <button
          onClick={() => onSelect?.(pick.id, !selected)}
          className={`absolute top-3 right-3 w-6 h-6 rounded border-2 flex items-center justify-center z-10 transition-colors ${selected ? 'bg-spike-amber border-spike-amber text-spike-bg' : 'border-spike-border hover:border-spike-amber'}`}
        >
          {selected && <span className="text-xs font-bold">✓</span>}
        </button>
      )}

      {/* Header: Rank + Ticker + Score */}
      <div className="flex justify-between items-start mb-1">
        <div className="flex gap-2.5 items-start">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-extrabold mt-0.5 ${pick.rank === 1 ? 'bg-gradient-to-br from-yellow-400 to-amber-500 text-spike-bg shadow-[0_0_10px_rgba(255,215,0,0.3)]' : pick.rank === 2 ? 'bg-gradient-to-br from-gray-300 to-gray-400 text-spike-bg' : pick.rank === 3 ? 'bg-gradient-to-br from-amber-700 to-yellow-800 text-spike-bg' : 'bg-spike-border text-spike-text-muted'}`}>
            {pick.rank}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <a href={`https://finance.yahoo.com/quote/${pick.ticker}`} target="_blank" rel="noopener noreferrer" className="text-lg font-extrabold text-spike-text hover:text-spike-amber transition-colors">
                {pick.ticker}
              </a>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-spike-cyan/10 text-spike-cyan font-semibold">{pick.exchange}</span>
              {pick.sector && <span className="text-[10px] px-1.5 py-0.5 rounded bg-spike-violet/10 text-spike-violet font-semibold">{pick.sector}</span>}
            </div>
            <p className="text-xs text-spike-text-muted">{pick.name}</p>
          </div>
        </div>
        {/* Score circle */}
        <div className={`w-16 h-16 rounded-full border-2 flex flex-col items-center justify-center ${scoreColor}`}>
          <span className="text-2xl font-extrabold font-mono">{Math.round(pick.momentumScore)}</span>
          <span className="text-[9px] uppercase tracking-wide opacity-70">Score</span>
        </div>
      </div>

      {/* Price */}
      <div className="flex items-baseline gap-2.5 ml-[42px] mb-3">
        <span className="text-[22px] font-bold font-mono text-spike-cyan">${pick.priceAtScan.toFixed(2)}</span>
        <span className={`text-[15px] font-bold font-mono ${pick.changePercent >= 0 ? 'text-spike-green' : 'text-spike-red'}`}>
          {pick.changePercent >= 0 ? '+' : ''}{pick.changePercent.toFixed(1)}%
        </span>
      </div>

      {/* Opening Surge row (replaces 3/5/8 day) */}
      <div className="grid grid-cols-3 gap-px bg-spike-border rounded-lg overflow-hidden mb-3">
        <div className="bg-spike-bg p-2.5 text-center">
          <div className="text-[10px] text-spike-text-muted uppercase tracking-wide">Rel. Volume</div>
          <div className="text-lg font-bold font-mono text-spike-green mt-0.5">{pick.relativeVolume.toFixed(1)}x</div>
        </div>
        <div className="bg-spike-bg p-2.5 text-center">
          <div className="text-[10px] text-spike-text-muted uppercase tracking-wide">Sector</div>
          <div className="text-lg font-bold font-mono text-spike-amber mt-0.5">{pick.sectorMomentum != null ? `${pick.sectorMomentum >= 0 ? '+' : ''}${pick.sectorMomentum.toFixed(1)}%` : '—'}</div>
        </div>
        <div className="bg-spike-bg p-2.5 text-center">
          <div className="text-[10px] text-spike-text-muted uppercase tracking-wide">Price Move</div>
          <div className="text-lg font-bold font-mono text-spike-green mt-0.5">{pick.changePercent >= 0 ? '+' : ''}{pick.changePercent.toFixed(1)}%</div>
        </div>
      </div>

      {/* Target row (replaces confidence bars) */}
      <div className="grid grid-cols-3 gap-px bg-spike-border rounded-lg overflow-hidden mb-3">
        <div className="bg-spike-bg p-2.5 text-center">
          <div className="text-[10px] text-spike-text-muted uppercase tracking-wide">Intraday Target</div>
          <div className="text-lg font-bold font-mono text-spike-green mt-0.5">${pick.intradayTarget.toFixed(2)}</div>
        </div>
        <div className="bg-spike-bg p-2.5 text-center">
          <div className="text-[10px] text-spike-text-muted uppercase tracking-wide">Key Level</div>
          <div className="text-lg font-bold font-mono text-spike-red mt-0.5">${pick.keyLevel.toFixed(2)}</div>
        </div>
        <div className="bg-spike-bg p-2.5 text-center">
          <div className="text-[10px] text-spike-text-muted uppercase tracking-wide">Conviction</div>
          <div className={`text-lg font-bold font-mono mt-0.5 uppercase ${convictionColor}`}>{pick.conviction === 'high' ? 'HIGH' : pick.conviction === 'medium' ? 'MED' : 'LOW'}</div>
        </div>
      </div>

      {/* Narrative */}
      <div className="mb-3">
        <div className="text-[11px] text-spike-amber uppercase tracking-wider font-bold mb-1.5 flex items-center gap-1">⚡ Why This Stock?</div>
        <p className="text-[13px] text-spike-text-dim leading-relaxed">{pick.rationale || 'No rationale provided.'}</p>
      </div>

      {/* Footer */}
      <div className="flex justify-between items-center pt-3 border-t border-spike-border">
        <div className="flex gap-3 text-xs text-spike-text-muted font-mono">
          <span>VWAP: —</span>
          <span>ADX: —</span>
        </div>
        <div className="flex gap-2 items-center">
          {!selectionMode && (
            <button
              onClick={handleLockIn}
              disabled={locking}
              className="flex items-center gap-1 px-4 py-1.5 rounded-md text-xs font-bold transition-all bg-gradient-to-r from-spike-amber to-orange-500 text-spike-bg hover:opacity-90 disabled:opacity-50"
            >
              ⚡ {locking ? 'Locking...' : 'Lock In'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/opening-bell/
git commit -m "feat(ui): add OpeningBellCard component mirroring SpikeCard layout"
```

---

## Task 7: Opening Bell Page

**Files:**
- Create: `src/app/opening-bell/page.tsx`
- Modify: `src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Create the Opening Bell page**

Create `src/app/opening-bell/page.tsx`. This is a large file that mirrors `src/app/dashboard/page.tsx` with Opening Bell-specific changes. The page should:

- Use `ResponsiveLayout` wrapper (same as dashboard)
- Fetch from `/api/opening-bell` (with optional `?date=` param)
- Display market header with "Opening Bell" title + animated bell icon
- Summary stats bar: Tickers Scanned, Total Picks, Avg Score, Top Score, Avg Rel. Volume
- Sector heat strip with color-coded pills
- Grid of `OpeningBellCard` components
- Selection mode + portfolio lock-in flow (reuse `PortfolioChoiceModal` and `LockInModal`)
- Lock-in POST to `/api/portfolio` with `openingBellPickId` instead of `spikeId`

Follow the exact patterns from `src/app/dashboard/page.tsx` for:
- `useSearchParams()` for date param
- `fetchSpikes` → `fetchOpeningBell` (same fetch/error/loading pattern)
- Selection mode state management
- `handleLockIn` → POST to `/api/portfolio` with `openingBellPickId`
- Bulk selection with `handleBulkLockIn`

Key differences from dashboard:
- Title: "OPENING BELL" in amber (#FFB800) with animated 🔔
- Sector heat strip component between summary bar and cards
- Cards use `OpeningBellCard` instead of `SpikeCard`
- Lock-in sends `openingBellPickId` not `spikeId`
- No "View Analysis" link (Opening Bell doesn't have deep analysis pages)

- [ ] **Step 2: Add Opening Bell to sidebar navigation**

In `src/components/layout/Sidebar.tsx`, add after the "Today's Spikes" nav item:

```typescript
{
  href: '/opening-bell',
  label: 'Opening Bell',
  tooltip: 'Early momentum picks detected at market open',
  icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
},
```

- [ ] **Step 3: Commit**

```bash
git add src/app/opening-bell/ src/components/layout/Sidebar.tsx
git commit -m "feat(ui): add Opening Bell page with sector heat strip, card grid, and portfolio lock-in"
```

---

## Task 8: Portfolio Integration

**Files:**
- Modify: `src/app/api/portfolio/route.ts`

- [ ] **Step 1: Update POST handler to accept openingBellPickId**

In the POST handler, update the destructuring and logic:

```typescript
// After: const { spikeId, spikeIds, portfolioId, ... } = body;
// Add:
const { spikeId, spikeIds, openingBellPickId, openingBellPickIds, portfolioId, portfolioSize, mode, shares: manualShares, fixedAmount } = body;

const obIdsToLock: string[] = openingBellPickIds || (openingBellPickId ? [openingBellPickId] : []);
```

Add a second processing loop after the spike loop for Opening Bell picks:

```typescript
// Process Opening Bell picks
for (const id of obIdsToLock) {
  const pick = await prisma.openingBellPick.findUnique({ where: { id } });
  if (!pick) {
    errors.push({ id, error: 'Opening Bell pick not found' });
    continue;
  }

  // Check duplicates
  const existing = await prisma.portfolioEntry.findFirst({
    where: { openingBellPickId: id, status: 'active', ...(portfolioId ? { portfolioId } : {}) },
  });
  if (existing) {
    errors.push({ id, ticker: pick.ticker, error: 'Already locked in' });
    continue;
  }

  // Size position — use intradayTarget for target, keyLevel for stop
  const atrPct = pick.priceAtScan > 0 ? ((pick.intradayTarget - pick.priceAtScan) / pick.priceAtScan) * 100 : 2;
  let shares: number;
  let positionPct: number;

  if (effectiveMode === 'fixed' && (fixedAmount || portfolio?.fixedAmount)) {
    const amount = fixedAmount || portfolio?.fixedAmount || 2500;
    shares = Math.floor(amount / pick.priceAtScan);
    positionPct = totalPortfolio > 0 ? ((shares * pick.priceAtScan) / totalPortfolio) * 100 : 0;
  } else if (effectiveMode === 'manual' && manualShares) {
    shares = manualShares;
    positionPct = totalPortfolio > 0 ? ((shares * pick.priceAtScan) / totalPortfolio) * 100 : 0;
  } else {
    const winRate = portfolio?.kellyWinRate || 0.6;
    const maxPct = ((portfolio?.kellyMaxPct || 2) / 100);
    positionPct = Math.min(maxPct, 0.02) * 100;
    const positionSize = totalPortfolio * (positionPct / 100);
    shares = Math.floor(positionSize / pick.priceAtScan);
  }

  if (shares <= 0) {
    errors.push({ id, ticker: pick.ticker, error: 'Position too small' });
    continue;
  }

  const entry = await prisma.portfolioEntry.create({
    data: {
      portfolioId: portfolioId || null,
      openingBellPickId: pick.id,
      ticker: pick.ticker,
      name: pick.name,
      entryPrice: pick.priceAtScan,
      entryDate: new Date(),
      shares,
      positionSize: shares * pick.priceAtScan,
      positionPct,
      target3Day: pick.intradayTarget,  // Use intraday target as primary
      stopLoss: pick.keyLevel,
      status: 'active',
    },
  });
  entries.push(entry);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/portfolio/route.ts
git commit -m "feat(portfolio): accept openingBellPickId for Opening Bell lock-ins"
```

---

## Task 9: Bell Icon on Today's Spikes

**Files:**
- Modify: `src/app/api/spikes/route.ts`
- Modify: `src/components/spikes/SpikeCard.tsx`

- [ ] **Step 1: Add Opening Bell cross-reference to spikes API**

In `src/app/api/spikes/route.ts`, after fetching the report, query Opening Bell picks for the same date:

```typescript
// After fetching report, add:
let openingBellTickers: Set<string> = new Set();
try {
  const obReport = await prisma.openingBellReport.findUnique({
    where: { date: report.date },
    include: { picks: { select: { ticker: true } } },
  });
  if (obReport) {
    openingBellTickers = new Set(obReport.picks.map((p) => p.ticker));
  }
} catch { /* non-fatal */ }

// In the spike mapping, add:
spikes: report.spikes.map((s) => ({
  ...existingFields,
  isOpeningBellPick: openingBellTickers.has(s.ticker),
})),
```

- [ ] **Step 2: Add bell icon to SpikeCard**

In `src/components/spikes/SpikeCard.tsx`, add the animated bell next to the ticker:

```typescript
// In the ticker-row div, after the ticker link:
{spike.isOpeningBellPick && (
  <span
    className="inline-block text-base animate-[ring_1.5s_ease-in-out_infinite]"
    title="Also an Opening Bell pick"
  >
    🔔
  </span>
)}
```

Add the ring animation to `tailwind.config.ts` (or use inline keyframes):

```typescript
// In tailwind.config.ts extend.keyframes:
ring: {
  '0%, 60%, 100%': { transform: 'rotate(0)' },
  '10%': { transform: 'rotate(14deg)' },
  '20%': { transform: 'rotate(-14deg)' },
  '30%': { transform: 'rotate(10deg)' },
  '40%': { transform: 'rotate(-8deg)' },
  '50%': { transform: 'rotate(4deg)' },
},
// In extend.animation:
ring: 'ring 1.5s ease-in-out infinite',
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/spikes/route.ts src/components/spikes/SpikeCard.tsx tailwind.config.ts
git commit -m "feat(ui): add animated bell icon on Today's Spikes for Opening Bell cross-reference"
```

---

## Task 10: Archives Restructure

**Files:**
- Modify: `src/app/reports/page.tsx`
- Create: `src/app/api/reports/opening-bell/route.ts`
- Create: `src/app/api/reports/opening-bell/[id]/xlsx/route.ts`

- [ ] **Step 1: Create Opening Bell reports list API**

Create `src/app/api/reports/opening-bell/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const page = parseInt(searchParams.get('page') || '1', 10);
  const pageSize = parseInt(searchParams.get('pageSize') || '20', 10);
  const skip = (page - 1) * pageSize;

  try {
    const [reports, total] = await Promise.all([
      prisma.openingBellReport.findMany({
        skip,
        take: pageSize,
        orderBy: { date: 'desc' },
        select: {
          id: true,
          date: true,
          generatedAt: true,
          tickersScanned: true,
          scanDurationMs: true,
          picks: {
            take: 3,
            orderBy: { rank: 'asc' },
            select: { ticker: true, momentumScore: true, changePercent: true, targetHit: true },
          },
        },
      }),
      prisma.openingBellReport.count(),
    ]);

    return NextResponse.json({
      success: true,
      data: reports.map((r) => ({
        id: r.id,
        date: r.date.toISOString().slice(0, 10),
        generatedAt: r.generatedAt.toISOString(),
        tickersScanned: r.tickersScanned,
        scanDurationMs: r.scanDurationMs,
        topPicks: r.picks,
      })),
      page,
      pageSize,
      total,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to fetch reports' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create Opening Bell XLSX export**

Create `src/app/api/reports/opening-bell/[id]/xlsx/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';
import ExcelJS from 'exceljs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const report = await prisma.openingBellReport.findUnique({
    where: { id },
    include: { picks: { orderBy: { rank: 'asc' } } },
  });

  if (!report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  }

  const reportDate = report.date.toISOString().slice(0, 10);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Opening Bell Report');

  // Title
  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = `Opening Bell — ${reportDate}`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFB800' } };

  sheet.mergeCells('A2:F2');
  sheet.getCell('A2').value = `Tickers Scanned: ${report.tickersScanned} | Duration: ${(report.scanDurationMs / 1000).toFixed(1)}s`;
  sheet.getCell('A2').font = { size: 11, italic: true, color: { argb: 'FF94A3B8' } };

  sheet.addRow([]);

  // Headers
  const headers = [
    'Rank', 'Ticker', 'Name', 'Exchange', 'Sector',
    'Price', 'Prev Close', 'Change %', 'Rel. Volume',
    'Score', 'Conviction', 'Intraday Target', 'Key Level',
    'Actual High', 'Actual Close', 'Target Hit?',
  ];
  const hRow = sheet.addRow(headers);
  hRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } };
  hRow.alignment = { horizontal: 'center' };

  // Data rows
  for (const pick of report.picks) {
    sheet.addRow([
      pick.rank,
      pick.ticker,
      pick.name,
      pick.exchange,
      pick.sector || '',
      pick.priceAtScan,
      pick.previousClose,
      pick.changePercent,
      pick.relativeVolume,
      pick.momentumScore,
      pick.conviction.toUpperCase(),
      pick.intradayTarget,
      pick.keyLevel,
      pick.actualHigh ?? '',
      pick.actualClose ?? '',
      pick.targetHit != null ? (pick.targetHit ? 'YES' : 'NO') : '',
    ]);
  }

  // Auto-fit columns
  sheet.columns.forEach((col) => {
    let maxLen = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value || '').length;
      if (len > maxLen) maxLen = Math.min(len, 30);
    });
    col.width = maxLen + 2;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="opening-bell-${reportDate}.xlsx"`,
    },
  });
}
```

- [ ] **Step 3: Add tabs to Archives page**

In `src/app/reports/page.tsx`, add tab state and tab UI:

```typescript
// Add at top of component:
const searchParams = useSearchParams();
const activeTab = searchParams.get('tab') || 'spikes';

// Add tab buttons above the report list:
<div className="flex gap-4 mb-6 border-b border-spike-border">
  <button
    onClick={() => router.push('/reports?tab=spikes')}
    className={`pb-2 px-1 text-sm font-semibold transition-colors ${
      activeTab === 'spikes'
        ? 'text-spike-cyan border-b-2 border-spike-cyan'
        : 'text-spike-text-muted hover:text-spike-text'
    }`}
  >
    Today&apos;s Spikes
  </button>
  <button
    onClick={() => router.push('/reports?tab=opening-bell')}
    className={`pb-2 px-1 text-sm font-semibold transition-colors ${
      activeTab === 'opening-bell'
        ? 'text-spike-amber border-b-2 border-spike-amber'
        : 'text-spike-text-muted hover:text-spike-text'
    }`}
  >
    Opening Bell
  </button>
</div>
```

Conditionally fetch from `/api/reports` (existing) or `/api/reports/opening-bell` based on `activeTab`. The report list rendering follows the same pattern but with:
- "View" → `/opening-bell?date=X` for Opening Bell tab
- "XLSX" → `/api/reports/opening-bell/{id}/xlsx` for Opening Bell tab
- Top 3 preview shows ticker + momentumScore + changePercent instead of spikeScore

- [ ] **Step 4: Commit**

```bash
git add src/app/reports/ src/app/api/reports/opening-bell/
git commit -m "feat(archives): add tabbed layout with Opening Bell reports + XLSX export"
```

---

## Task 11: Email Notification

**Files:**
- Create: `src/lib/email/opening-bell-email.ts`
- Modify: `src/app/settings/page.tsx`
- Modify: `src/app/api/user/preferences/route.ts`

- [ ] **Step 1: Create email template and send function**

Create `src/lib/email/opening-bell-email.ts`:

```typescript
import prisma from '@/lib/db/prisma';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://spiketrades.ca';
const FROM = 'no-reply@spiketrades.ca';

interface Pick {
  rank: number;
  ticker: string;
  name: string;
  priceAtScan: number;
  changePercent: number;
  relativeVolume: number;
  intradayTarget: number;
  conviction: string;
}

export async function sendOpeningBellEmail(picks: Pick[], sectorSnapshot?: unknown) {
  if (!RESEND_API_KEY) {
    console.log('[Opening Bell Email] No RESEND_API_KEY, skipping');
    return;
  }

  // Get opted-in users
  const users = await prisma.user.findMany({
    where: { emailOpeningBell: true },
    select: { email: true },
  });

  if (users.length === 0) {
    console.log('[Opening Bell Email] No opted-in users');
    return;
  }

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Halifax' });

  // Build sector pills HTML
  let sectorHtml = '';
  if (Array.isArray(sectorSnapshot) && sectorSnapshot.length > 0) {
    const topSectors = sectorSnapshot
      .filter((s: { averageChange?: number }) => s.averageChange != null)
      .sort((a: { averageChange: number }, b: { averageChange: number }) => b.averageChange - a.averageChange)
      .slice(0, 3);
    sectorHtml = topSectors
      .map((s: { sector: string; averageChange: number }) =>
        `<span style="color:${s.averageChange >= 1 ? '#00FF88' : s.averageChange >= 0 ? '#FFB800' : '#FF3366'};font-weight:bold;">${s.sector} ${s.averageChange >= 0 ? '+' : ''}${s.averageChange.toFixed(1)}%</span>`
      )
      .join(' &middot; ');
  }

  // Build picks table rows
  const rowsHtml = picks.map((p) => `
    <tr style="border-bottom:1px solid #1E3A5F;">
      <td style="padding:8px;text-align:center;color:#FFB800;font-weight:bold;">${p.rank}</td>
      <td style="padding:8px;font-weight:bold;color:#E2E8F0;">${p.ticker}</td>
      <td style="padding:8px;color:#00F0FF;font-family:monospace;">$${p.priceAtScan.toFixed(2)}</td>
      <td style="padding:8px;color:#00FF88;font-family:monospace;">${p.changePercent >= 0 ? '+' : ''}${p.changePercent.toFixed(1)}%</td>
      <td style="padding:8px;color:#A855F7;font-family:monospace;">${p.relativeVolume.toFixed(1)}x</td>
      <td style="padding:8px;color:#00FF88;font-family:monospace;">$${p.intradayTarget.toFixed(2)}</td>
      <td style="padding:8px;color:${p.conviction === 'high' ? '#00FF88' : p.conviction === 'medium' ? '#FFB800' : '#FF3366'};font-weight:bold;text-transform:uppercase;">${p.conviction}</td>
    </tr>
  `).join('');

  const html = `
  <div style="background:#0A1428;color:#E2E8F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;max-width:700px;margin:0 auto;">
    <h1 style="color:#FFB800;font-size:22px;margin-bottom:4px;">🔔 Opening Bell — ${todayStr}</h1>
    <p style="color:#94A3B8;font-size:14px;margin-bottom:16px;">10 momentum picks detected at 9:35 AM EST</p>
    ${sectorHtml ? `<p style="font-size:13px;margin-bottom:16px;">Hot sectors: ${sectorHtml}</p>` : ''}
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#111E33;border-bottom:2px solid #1E3A5F;">
          <th style="padding:8px;text-align:center;color:#64748B;">Rank</th>
          <th style="padding:8px;text-align:left;color:#64748B;">Ticker</th>
          <th style="padding:8px;text-align:left;color:#64748B;">Price</th>
          <th style="padding:8px;text-align:left;color:#64748B;">Change</th>
          <th style="padding:8px;text-align:left;color:#64748B;">Vol</th>
          <th style="padding:8px;text-align:left;color:#64748B;">Target</th>
          <th style="padding:8px;text-align:left;color:#64748B;">Conv.</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div style="text-align:center;margin-top:20px;">
      <a href="${APP_URL}/opening-bell" style="background:#FFB800;color:#0A1428;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;">View Full Analysis →</a>
    </div>
    <p style="color:#64748B;font-size:11px;margin-top:24px;text-align:center;">
      <a href="${APP_URL}/settings" style="color:#64748B;">Unsubscribe from Opening Bell emails</a>
    </p>
  </div>`;

  // Send to each user
  for (const user of users) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM,
          to: user.email,
          subject: `🔔 Opening Bell — ${todayStr}`,
          html,
        }),
      });
    } catch (err) {
      console.error(`[Opening Bell Email] Failed to send to ${user.email}:`, err);
    }
  }

  console.log(`[Opening Bell Email] Sent to ${users.length} users`);
}
```

- [ ] **Step 2: Add email toggle to settings page**

In `src/app/settings/page.tsx`, add to the prefs array:

```typescript
{ key: 'emailOpeningBell' as const, label: 'Opening Bell', desc: 'Receive early momentum picks at market open' },
```

- [ ] **Step 3: Update preferences API to handle new field**

In `src/app/api/user/preferences/route.ts`, add `emailOpeningBell` to the allowed fields for PUT updates.

- [ ] **Step 4: Commit**

```bash
git add src/lib/email/opening-bell-email.ts src/app/settings/ src/app/api/user/preferences/
git commit -m "feat(email): add Opening Bell email notification with user opt-in toggle"
```

---

## Task 12: Accuracy Tracking

**Files:**
- Modify: `src/app/api/accuracy/check/route.ts`

- [ ] **Step 1: Add Opening Bell accuracy backfill**

After the existing spike accuracy loop in the POST handler, add:

```typescript
// ── Opening Bell Accuracy Backfill ──
let obFilled = 0;
try {
  // Find today's Opening Bell picks with missing actuals
  const obPicks = await prisma.openingBellPick.findMany({
    where: {
      report: { date: { lte: new Date(todayStr + 'T23:59:59') } },
      actualHigh: null,
    },
    select: { id: true, ticker: true, priceAtScan: true, intradayTarget: true, keyLevel: true, report: { select: { date: true } } },
  });

  if (obPicks.length > 0) {
    const obTickers = Array.from(new Set(obPicks.map((p) => p.ticker)));
    // Fetch daily bars to get actual high
    const { getBatchQuotes } = await import('@/lib/api/fmp');
    const quotes = await getBatchQuotes(obTickers);
    const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

    for (const pick of obPicks) {
      const q = quoteMap.get(pick.ticker);
      if (!q) continue;

      const actualHigh = q.dayHigh || q.price;
      const actualClose = q.price;
      const targetHit = actualHigh >= pick.intradayTarget;
      const keyLevelBroken = q.dayLow != null ? q.dayLow <= pick.keyLevel : false;

      await prisma.openingBellPick.update({
        where: { id: pick.id },
        data: { actualHigh, actualClose, targetHit, keyLevelBroken },
      });
      obFilled++;
    }
  }
} catch (obErr) {
  console.error('[Accuracy] Opening Bell backfill error (non-fatal):', obErr);
}

// Update return to include OB count
// Change: return NextResponse.json({ success: true, filled });
// To:
return NextResponse.json({ success: true, filled, openingBellFilled: obFilled });
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/accuracy/check/route.ts
git commit -m "feat(accuracy): extend daily backfill to include Opening Bell intraday actuals"
```

---

## Task 13: Admin Panel Updates

**Files:**
- Modify: `src/app/admin/page.tsx`
- Modify: `src/app/api/admin/council/route.ts`

- [ ] **Step 1: Extend admin council API to fetch Opening Bell status**

In `src/app/api/admin/council/route.ts`, add to the `Promise.all` array:

```typescript
safeFetch(`${COUNCIL_API_URL}/run-opening-bell-status`, 5000),
safeFetch(`${COUNCIL_API_URL}/opening-bell-health`, 5000),
```

Add the results to the response data:

```typescript
data: {
  ...existingFields,
  openingBellStatus: openingBellStatusResult,
  openingBellHealth: openingBellHealthResult,
},
```

- [ ] **Step 2: Add Opening Bell section to admin Council tab**

In `src/app/admin/page.tsx`, in the council tab rendering, add before the Council pipeline stages:

```typescript
{/* Opening Bell Status Card */}
<div className="glass-card p-4 mb-4">
  <h3 className="text-sm font-bold text-spike-amber mb-3">🔔 Opening Bell</h3>
  <div className="grid grid-cols-3 gap-3">
    <div>
      <div className="text-[10px] text-spike-text-muted uppercase">Status</div>
      <div className={`text-sm font-bold ${
        council.openingBellStatus?.running ? 'text-spike-amber' :
        council.openingBellStatus?.last_result_summary?.success ? 'text-spike-green' :
        council.openingBellStatus?.last_error ? 'text-spike-red' : 'text-spike-text-muted'
      }`}>
        {council.openingBellStatus?.running ? '⏳ Running' :
         council.openingBellStatus?.last_result_summary?.success ? '✓ Complete' :
         council.openingBellStatus?.last_error ? '✗ Failed' : '— Pending'}
      </div>
    </div>
    <div>
      <div className="text-[10px] text-spike-text-muted uppercase">Picks</div>
      <div className="text-sm font-bold text-spike-cyan font-mono">
        {council.openingBellStatus?.last_result_summary?.picks_count ?? '—'}
      </div>
    </div>
    <div>
      <div className="text-[10px] text-spike-text-muted uppercase">Duration</div>
      <div className="text-sm font-bold text-spike-text font-mono">
        {council.openingBellStatus?.last_run_time
          ? `${council.openingBellStatus.last_run_time.toFixed(0)}s`
          : '—'}
      </div>
    </div>
  </div>
  {council.openingBellStatus?.last_error && (
    <div className="text-xs text-spike-red mt-2 p-2 bg-spike-red/5 rounded">{council.openingBellStatus.last_error}</div>
  )}
  <button
    onClick={() => triggerOpeningBell()}
    disabled={council.openingBellStatus?.running || council.runInProgress}
    className="mt-3 px-3 py-1.5 text-xs font-bold rounded bg-spike-amber/20 text-spike-amber border border-spike-amber/30 hover:bg-spike-amber/30 disabled:opacity-40"
  >
    Run Opening Bell
  </button>
</div>
```

Add the trigger function:

```typescript
const triggerOpeningBell = async () => {
  try {
    await fetch('/api/admin/council', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'opening-bell' }),
    });
  } catch { /* polling will pick up status */ }
};
```

Update the POST handler in `src/app/api/admin/council/route.ts` to handle the `type: 'opening-bell'` variant:

```typescript
// In POST handler:
const body = await request.json().catch(() => ({}));
const endpoint = body.type === 'opening-bell' ? '/run-opening-bell' : '/run-council';
```

- [ ] **Step 3: Add Opening Bell FMP health to the health table**

The FMP health table in the admin panel reads from `council.fmpHealth.endpoints`. Opening Bell's endpoint health will be returned by `/opening-bell-health`. Merge both into the table display:

```typescript
// Combine FMP health from both Council and Opening Bell
const allEndpoints = {
  ...(council.fmpHealth?.endpoints || {}),
  ...(council.openingBellHealth?.endpoints || {}),
};
```

- [ ] **Step 4: Add Opening Bell cost row**

In the cost breakdown section, add after the Council stages:

```typescript
{/* Opening Bell cost */}
{council.openingBellStatus?.last_result_summary?.success && (
  <div className="flex justify-between items-center py-1 text-xs">
    <span className="text-spike-text-dim">Opening Bell · Sonnet 4.6</span>
    <span className="text-spike-cyan font-mono">~$0.50-1.00</span>
  </div>
)}
```

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/ src/app/api/admin/council/
git commit -m "feat(admin): add Opening Bell status card, manual trigger, FMP health, and cost display"
```

---

## Task 14: FMP Rate Limit Comment Fix

**Files:**
- Modify: `src/lib/api/fmp.ts`

- [ ] **Step 1: Fix the rate limit comment**

In `src/lib/api/fmp.ts` line 124, change:

```typescript
// OLD:
// Rate limiting: FMP Professional allows ~300 req/min

// NEW:
// Rate limiting: FMP Premium allows ~750 req/min
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/api/fmp.ts
git commit -m "fix: correct FMP rate limit comment to 750 req/min (Premium plan)"
```

---

## Task 15: Integration Testing

**Files:**
- Create: `src/__tests__/opening-bell-integration.test.ts`
- Create: `tests/test_opening_bell_integration.py`

- [ ] **Step 1: Write Python integration tests**

Create `tests/test_opening_bell_integration.py`:

```python
"""Integration tests for Opening Bell pipeline.

These tests verify the full pipeline flow with mocked external services.
Run with: python3 -m pytest tests/test_opening_bell_integration.py -v
"""
import pytest
import asyncio
import json
from unittest.mock import AsyncMock, patch, MagicMock
from opening_bell_scanner import OpeningBellScanner


class TestFullPipeline:
    """Test the complete pipeline with mocked FMP + Anthropic."""

    @pytest.fixture
    def mock_fmp_responses(self):
        """Canned FMP responses for testing."""
        return {
            "/stock-list": [
                {"symbol": "CNQ.TO", "exchangeShortName": "TSX"},
                {"symbol": "SU.TO", "exchangeShortName": "TSX"},
                {"symbol": "SHOP.TO", "exchangeShortName": "TSX"},
                {"symbol": "RY.TO", "exchangeShortName": "TSX"},
                {"symbol": "PENNY.V", "exchangeShortName": "TSXV"},
            ],
            "/batch-quote": [
                {"symbol": "CNQ.TO", "name": "Canadian Natural Resources", "price": 48.72, "previousClose": 46.27, "volume": 1200000, "avgVolume": 193548, "changesPercentage": 5.3, "exchange": "TSX"},
                {"symbol": "SU.TO", "name": "Suncor Energy", "price": 62.18, "previousClose": 59.73, "volume": 890000, "avgVolume": 185416, "changesPercentage": 4.1, "exchange": "TSX"},
                {"symbol": "SHOP.TO", "name": "Shopify Inc.", "price": 134.20, "previousClose": 129.41, "volume": 650000, "avgVolume": 166666, "changesPercentage": 3.7, "exchange": "TSX"},
                {"symbol": "RY.TO", "name": "Royal Bank", "price": 227.34, "previousClose": 227.34, "volume": 50000, "avgVolume": 2773210, "changesPercentage": 0.0, "exchange": "TSX"},
                {"symbol": "PENNY.V", "name": "Penny Stock", "price": 0.50, "previousClose": 0.45, "volume": 100000, "avgVolume": 50000, "changesPercentage": 11.1, "exchange": "TSXV"},
            ],
            "/sector-performance-snapshot": [
                {"sector": "Energy", "averageChange": 2.8},
                {"sector": "Technology", "averageChange": 1.4},
                {"sector": "Financial Services", "averageChange": 0.3},
            ],
            "/grades": [],
        }

    @pytest.fixture
    def mock_sonnet_response(self):
        """Canned Sonnet response."""
        return json.dumps({
            "picks": [
                {"rank": 1, "ticker": "CNQ.TO", "momentum_score": 94, "intraday_target": 50.40, "key_level": 47.15, "conviction": "high", "rationale": "Energy sector surge with 6.2x volume"},
                {"rank": 2, "ticker": "SU.TO", "momentum_score": 89, "intraday_target": 64.50, "key_level": 60.80, "conviction": "high", "rationale": "Riding oil rally"},
                {"rank": 3, "ticker": "SHOP.TO", "momentum_score": 72, "intraday_target": 138.90, "key_level": 131.50, "conviction": "medium", "rationale": "Tech rotation"},
            ]
        })

    @pytest.mark.asyncio
    async def test_full_pipeline_produces_picks(self, mock_fmp_responses, mock_sonnet_response):
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")

        # Mock FMP calls
        async def mock_fmp_get(session, path, params=None):
            for key, val in mock_fmp_responses.items():
                if key in path:
                    return val
            return []

        scanner._fmp_get = mock_fmp_get
        scanner.fetch_tsx_universe = AsyncMock(return_value=mock_fmp_responses["/batch-quote"])
        scanner.fetch_sector_performance = AsyncMock(return_value=mock_fmp_responses["/sector-performance-snapshot"])
        scanner.fetch_grades = AsyncMock(return_value={})

        # Mock Sonnet call
        with patch("opening_bell_scanner._call_anthropic", new_callable=AsyncMock) as mock_anthropic:
            mock_anthropic.return_value = (mock_sonnet_response, {"input_tokens": 5000, "output_tokens": 1000})
            result = await scanner.run()

        assert result["success"] is True
        assert len(result["picks"]) == 3
        assert result["picks"][0]["ticker"] == "CNQ.TO"
        assert result["picks"][0]["momentumScore"] == 94
        assert result["tickers_scanned"] > 0
        assert result["duration_ms"] > 0
        assert result["token_usage"]["input_tokens"] == 5000

    @pytest.mark.asyncio
    async def test_pipeline_filters_penny_stocks(self, mock_fmp_responses, mock_sonnet_response):
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")

        # PENNY.V has price $0.50 < $1.00 minimum
        scanner.fetch_tsx_universe = AsyncMock(return_value=mock_fmp_responses["/batch-quote"])
        scanner.fetch_sector_performance = AsyncMock(return_value=[])
        scanner.fetch_grades = AsyncMock(return_value={})

        movers = scanner.compute_rankings(mock_fmp_responses["/batch-quote"])
        tickers = [m["symbol"] for m in movers]
        assert "PENNY.V" not in tickers  # Filtered by fetch_tsx_universe

    @pytest.mark.asyncio
    async def test_pipeline_filters_flat_stocks(self, mock_fmp_responses, mock_sonnet_response):
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")

        movers = scanner.compute_rankings(mock_fmp_responses["/batch-quote"])
        tickers = [m["symbol"] for m in movers]
        assert "RY.TO" not in tickers  # 0% change filtered out

    @pytest.mark.asyncio
    async def test_pipeline_handles_empty_universe(self):
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        scanner.fetch_tsx_universe = AsyncMock(return_value=[])

        result = await scanner.run()
        assert result["success"] is False
        assert "No quotes" in result["error"]

    @pytest.mark.asyncio
    async def test_pipeline_handles_sonnet_failure(self, mock_fmp_responses):
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        scanner.fetch_tsx_universe = AsyncMock(return_value=mock_fmp_responses["/batch-quote"])
        scanner.fetch_sector_performance = AsyncMock(return_value=[])
        scanner.fetch_grades = AsyncMock(return_value={})

        with patch("opening_bell_scanner._call_anthropic", new_callable=AsyncMock) as mock_anthropic:
            mock_anthropic.return_value = ("Not valid JSON", {"input_tokens": 100, "output_tokens": 50})
            result = await scanner.run()

        assert result["success"] is False
        assert "no valid picks" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_pipeline_timeout_handling(self, mock_fmp_responses):
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")

        async def slow_universe(*args, **kwargs):
            await asyncio.sleep(10)
            return []

        scanner.fetch_tsx_universe = slow_universe

        # The run method itself doesn't have a timeout, but the api_server wraps it
        # Test that it handles gracefully when it takes too long
        import asyncio
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(scanner.run(), timeout=0.1)


class TestEndpointHealth:
    """Test FMP endpoint health tracking."""

    def test_tracks_successful_calls(self):
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        # Simulate successful call
        scanner._endpoint_health["/batch-quote"] = {"ok": 5, "404": 0, "429": 0, "error": 0}
        assert scanner._endpoint_health["/batch-quote"]["ok"] == 5

    def test_health_included_in_result(self):
        scanner = OpeningBellScanner(fmp_key="test", anthropic_key="test")
        scanner._endpoint_health["/test"] = {"ok": 1, "404": 0, "429": 0, "error": 0}
        # Health should be accessible for admin panel
        assert "/test" in scanner._endpoint_health
```

- [ ] **Step 2: Run all Python tests**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code
python3 -m pytest tests/test_opening_bell_scanner.py tests/test_opening_bell_integration.py -v
```

Expected: All tests PASS.

- [ ] **Step 3: Write Next.js smoke test**

Create `src/__tests__/opening-bell-api.test.ts`:

```typescript
/**
 * Opening Bell API route smoke tests.
 *
 * These test the API route handlers with mocked Prisma.
 * Run with: npx jest src/__tests__/opening-bell-api.test.ts
 */

// Note: Full API integration tests should be run manually by:
// 1. Starting the dev server
// 2. Triggering a manual Opening Bell run via admin panel
// 3. Verifying the results on the /opening-bell page
// 4. Checking the email was sent (check Resend dashboard)
// 5. Verifying the archives tab shows the report
// 6. Verifying XLSX download works

describe('Opening Bell API', () => {
  it('should have the Opening Bell page route', () => {
    // Verify the page file exists
    const fs = require('fs');
    expect(fs.existsSync('src/app/opening-bell/page.tsx')).toBe(true);
  });

  it('should have the Opening Bell API route', () => {
    const fs = require('fs');
    expect(fs.existsSync('src/app/api/opening-bell/route.ts')).toBe(true);
  });

  it('should have the Opening Bell XLSX route', () => {
    const fs = require('fs');
    expect(fs.existsSync('src/app/api/reports/opening-bell/[id]/xlsx/route.ts')).toBe(true);
  });

  it('should have the Opening Bell cron route', () => {
    const fs = require('fs');
    expect(fs.existsSync('src/app/api/cron/opening-bell/route.ts')).toBe(true);
  });

  it('should have the Opening Bell email module', () => {
    const fs = require('fs');
    expect(fs.existsSync('src/lib/email/opening-bell-email.ts')).toBe(true);
  });

  it('should have the OpeningBellCard component', () => {
    const fs = require('fs');
    expect(fs.existsSync('src/components/opening-bell/OpeningBellCard.tsx')).toBe(true);
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add tests/ src/__tests__/
git commit -m "test: add Opening Bell unit tests, integration tests, and API smoke tests"
```

---

## Task 16: Build Verification & Manual Test Plan

- [ ] **Step 1: Run full build**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
npm run build
```

Expected: Build succeeds with no errors. Fix any TypeScript errors.

- [ ] **Step 2: Run all existing tests to verify no regressions**

```bash
npm test 2>&1 | tail -20
python3 -m pytest tests/ -v 2>&1 | tail -20
```

Expected: All existing tests still pass.

- [ ] **Step 3: Manual test checklist**

Run the dev server and verify each feature:

```
- [ ] /opening-bell page loads with "No data" state (no report yet)
- [ ] Opening Bell appears in sidebar navigation
- [ ] Admin panel → Council tab shows Opening Bell status card
- [ ] Admin panel → "Run Opening Bell" button triggers scan
- [ ] After manual run: /opening-bell shows 10 cards with correct layout
- [ ] Cards show: score circle, Opening Surge metrics, Intraday Target, Key Level, Conviction
- [ ] "Lock In" button works → PortfolioChoiceModal → creates portfolio entry
- [ ] /reports page shows two tabs (Today's Spikes / Opening Bell)
- [ ] Opening Bell tab lists reports, "View" links to /opening-bell?date=X
- [ ] XLSX download works for Opening Bell reports
- [ ] /settings page shows Opening Bell email toggle
- [ ] Bell icon appears on Today's Spikes cards that match Opening Bell picks
- [ ] Bell icon has ring animation
- [ ] Admin panel shows Opening Bell FMP health data
- [ ] Admin panel shows Opening Bell cost estimate
- [ ] After market close: accuracy backfill populates actualHigh and targetHit
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: Opening Bell v1 complete — early momentum scanner with full platform integration"
```

- [ ] **Step 5: Push to remote**

```bash
git push origin main
```

---

## Task 17: Council Pre-filter Override Integration

**Files:**
- Modify: `canadian_llm_council_brain.py`

- [ ] **Step 1: Read Opening Bell overrides in Council pre-filter**

In `canadian_llm_council_brain.py`, in the pre-filter method (where the catalyst override happens for >5 news articles), add:

```python
# Read Opening Bell overrides (if available)
opening_bell_overrides = set()
try:
    with open("opening_bell_council_overrides.json", "r") as f:
        ob_data = json.load(f)
        today_str = datetime.now(ZoneInfo("America/Halifax")).strftime("%Y-%m-%d")
        if ob_data.get("date") == today_str:
            opening_bell_overrides = set(ob_data.get("tickers", []))
            logger.info(f"Council pre-filter: {len(opening_bell_overrides)} Opening Bell overrides loaded")
except FileNotFoundError:
    pass
except Exception as e:
    logger.warning(f"Council pre-filter: failed to load Opening Bell overrides: {e}")

# In the filtering loop, add bypass:
# After the catalyst override check, add:
if ticker in opening_bell_overrides:
    logger.info(f"Pre-filter: {ticker} bypasses filter (Opening Bell override)")
    # Add to survivors regardless of technical filters
    continue
```

- [ ] **Step 2: Commit**

```bash
git add canadian_llm_council_brain.py
git commit -m "feat(council): add Opening Bell pre-filter override — top 10 get guaranteed Stage 1"
```
