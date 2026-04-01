# Spike It — Live Intraday Health Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Spike It" button to portfolio tiles that triggers a real-time SuperGrok-powered intraday health check, displaying continuation probability, expected move, intraday chart, key levels, and risk warnings in a modal.

**Architecture:** New `POST /spike-it` FastAPI endpoint on the council service (port 8100) fetches FMP intraday data, calculates VWAP/RSI, calls Grok for structured analysis, and returns a combined payload. Next.js proxies via `POST /api/portfolio/spike-it`. A new `SpikeItModal` component renders the results with a real SVG chart. 5-minute in-memory cache per ticker. Market hours only (10:30 AM - 5:00 PM AST).

**Tech Stack:** Python (FastAPI, aiohttp, openai SDK), TypeScript/React (Next.js 15, SVG), FMP API, xAI Grok API

**Spec:** `docs/superpowers/specs/2026-04-01-spike-it-health-check-design.md`

**Hard Constraints:**
- No database schema changes (PostgreSQL or SQLite)
- No modifications to existing API routes or council pipeline functions
- No changes to `run_council()`, `_call_grok()`, or `_extract_json()` — use them as-is
- All timestamps displayed in AST (Atlantic Standard Time)
- All existing historical data must remain untouched

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `api_server.py` | Modify | New `/spike-it` endpoint, FMP data fetching, VWAP/RSI calculation, Grok prompt, in-memory cache |
| `src/app/api/portfolio/spike-it/route.ts` | Create | Next.js proxy route to council service |
| `src/components/portfolio/SpikeItModal.tsx` | Create | Result modal with traffic light, chart, levels, risk |
| `src/app/portfolio/page.tsx` | Modify | Spike It button, market hours check, modal state |
| Version string files (8 pages) | Modify | Bump "Ver 3.1" → "Ver 3.2" |

---

## Task 1: Python `/spike-it` Endpoint — FMP Data Fetching & Calculations

**Files:**
- Modify: `api_server.py` (insert before the `# ── Main ──` section at line 588)

This task adds the FMP data fetching, VWAP calculation, RSI calculation, and in-memory cache. No Grok call yet — that's Task 2.

- [ ] **Step 1: Add imports and constants at top of api_server.py**

Add after the existing imports (line 33, after `from pydantic import BaseModel`):

```python
import aiohttp
import ssl
import certifi
import re
import math
```

Add after `load_dotenv(override=True)` (line 35), before the brain imports:

```python
# ── FMP config for Spike It ──────────────────────────────────────────
FMP_BASE = "https://financialmodelingprep.com/stable"
FMP_API_KEY = os.environ.get("FMP_API_KEY", "")
```

- [ ] **Step 2: Add the Pydantic request model**

Add after the existing `RunCouncilRequest` model (find it with grep — it's a `class RunCouncilRequest(BaseModel)`):

```python
class SpikeItRequest(BaseModel):
    ticker: str
    entry_price: float
```

- [ ] **Step 3: Add the in-memory cache and FMP helper**

Add before the `# ── Main ──` section (line 588):

```python
# ── Spike It: Live Health Check ──────────────────────────────────────

_spike_it_cache: dict[str, dict] = {}  # {ticker: {"result": {...}, "timestamp": float}}
SPIKE_IT_CACHE_TTL = 300  # 5 minutes

_spike_it_session: Optional[aiohttp.ClientSession] = None


async def _get_spike_session() -> aiohttp.ClientSession:
    """Get or create an aiohttp session for FMP calls."""
    global _spike_it_session
    if _spike_it_session is None or _spike_it_session.closed:
        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
        conn = aiohttp.TCPConnector(ssl=ssl_ctx, limit=10)
        _spike_it_session = aiohttp.ClientSession(
            connector=conn,
            timeout=aiohttp.ClientTimeout(total=15),
        )
    return _spike_it_session


async def _fmp_get_spike(path: str, params: dict | None = None) -> Any:
    """Make a GET request to FMP /stable/ API for Spike It."""
    session = await _get_spike_session()
    params = params or {}
    params["apikey"] = FMP_API_KEY
    url = f"{FMP_BASE}{path}"
    for attempt in range(3):
        try:
            async with session.get(url, params=params) as resp:
                if resp.status == 429:
                    wait = 5 * (2 ** attempt)
                    logger.warning(f"Spike It FMP {path} rate limited, retrying in {wait}s")
                    await asyncio.sleep(wait)
                    continue
                if resp.status != 200:
                    logger.error(f"Spike It FMP {path} returned {resp.status}")
                    return None
                return await resp.json()
        except Exception as e:
            logger.error(f"Spike It FMP {path} error: {e}")
            return None
    return None
```

- [ ] **Step 4: Add VWAP and RSI calculation functions**

Add directly after the `_fmp_get_spike` function:

```python
def _calculate_vwap(bars: list[dict]) -> list[dict]:
    """Calculate VWAP from intraday OHLCV bars. Returns [{time, value}, ...]."""
    cumulative_tpv = 0.0  # sum of (typical_price * volume)
    cumulative_vol = 0.0
    vwap_points = []
    for bar in bars:
        typical = (bar["high"] + bar["low"] + bar["close"]) / 3
        vol = bar.get("volume", 0)
        if vol <= 0:
            # Carry forward last VWAP if volume is 0
            vwap_points.append({"time": bar["time"], "value": round(vwap_points[-1]["value"], 4) if vwap_points else round(typical, 4)})
            continue
        cumulative_tpv += typical * vol
        cumulative_vol += vol
        vwap = cumulative_tpv / cumulative_vol
        vwap_points.append({"time": bar["time"], "value": round(vwap, 4)})
    return vwap_points


def _calculate_rsi(closes: list[float], period: int = 14) -> float | None:
    """Calculate RSI from a list of closing prices. Returns None if insufficient data."""
    if len(closes) < period + 1:
        return None
    gains = []
    losses = []
    for i in range(1, len(closes)):
        delta = closes[i] - closes[i - 1]
        gains.append(max(delta, 0))
        losses.append(max(-delta, 0))

    # Use exponential moving average (Wilder's smoothing)
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 1)
```

- [ ] **Step 5: Add the FMP data assembly function**

Add directly after the RSI function:

```python
async def _fetch_spike_it_data(ticker: str) -> dict[str, Any] | None:
    """Fetch all FMP data needed for Spike It analysis. Returns assembled dict or None on critical failure."""
    # Fetch in parallel: quote, intraday bars, historical (for avg vol), news, macro
    quote_task = _fmp_get_spike("/batch-quote", {"symbols": ticker})
    bars_task = _fmp_get_spike(f"/historical-chart/5min/{ticker}")
    hist_task = _fmp_get_spike(f"/historical-price-eod/full/{ticker}", {"from": "", "limit": "10"})
    news_task = _fmp_get_spike("/news/stock", {"symbols": ticker, "limit": "5"})
    # Macro: oil, gold, CAD, TSX
    macro_task = _fmp_get_spike("/batch-quote", {"symbols": "USO,GLD,CADUSD=X,XIU.TO"})

    quote_data, bars_data, hist_data, news_data, macro_data = await asyncio.gather(
        quote_task, bars_task, hist_task, news_task, macro_task,
        return_exceptions=True,
    )

    # ── Validate critical data ──
    # Quote
    if isinstance(quote_data, Exception) or not quote_data or len(quote_data) == 0:
        logger.error(f"Spike It: failed to fetch quote for {ticker}")
        return None
    quote = quote_data[0]

    # Intraday bars
    if isinstance(bars_data, Exception) or not bars_data or len(bars_data) < 5:
        logger.error(f"Spike It: failed to fetch intraday bars for {ticker} (got {len(bars_data) if bars_data else 0})")
        return None

    # ── Process intraday bars (FMP returns newest first, reverse to chronological) ──
    today_str = datetime.now(ZoneInfo("America/Halifax")).strftime("%Y-%m-%d")
    today_bars = []
    for bar in reversed(bars_data):
        bar_date = bar.get("date", "")[:10]
        if bar_date == today_str:
            # Convert timestamp to AST time string
            try:
                dt = datetime.fromisoformat(bar["date"])
                ast_time = dt.astimezone(ZoneInfo("America/Halifax")).strftime("%H:%M")
            except Exception:
                ast_time = bar["date"][11:16]  # Fallback: extract HH:MM
            today_bars.append({
                "time": ast_time,
                "open": bar["open"],
                "high": bar["high"],
                "low": bar["low"],
                "close": bar["close"],
                "volume": bar.get("volume", 0),
            })

    if len(today_bars) < 3:
        logger.error(f"Spike It: insufficient intraday bars for {ticker} today ({len(today_bars)})")
        return None

    # ── Calculate metrics ──
    vwap_points = _calculate_vwap(today_bars)
    current_vwap = vwap_points[-1]["value"] if vwap_points else None
    closes = [b["close"] for b in today_bars]
    rsi = _calculate_rsi(closes, 14)

    # Relative volume
    avg_volume = None
    if not isinstance(hist_data, Exception) and hist_data and len(hist_data) > 0:
        volumes = [d.get("volume", 0) for d in hist_data[:10] if d.get("volume", 0) > 0]
        if volumes:
            avg_volume = sum(volumes) / len(volumes)
    today_volume = quote.get("volume", 0)
    rel_volume = round(today_volume / avg_volume, 2) if avg_volume and avg_volume > 0 else None

    # Price vs VWAP
    current_price = quote.get("price", closes[-1])
    vwap_distance = round(current_price - current_vwap, 4) if current_vwap else None
    above_vwap = vwap_distance > 0 if vwap_distance is not None else None

    # ── Data limitations ──
    data_limitations = []
    if rsi is None:
        data_limitations.append("Insufficient bars for 14-period RSI calculation")
    if rel_volume is None:
        data_limitations.append("Could not calculate relative volume (missing historical data)")
    if not isinstance(news_data, Exception) and not news_data:
        data_limitations.append("News data unavailable")
    if isinstance(news_data, Exception):
        news_data = []
        data_limitations.append("News data unavailable")

    # ── Process macro data ──
    macro = {}
    if not isinstance(macro_data, Exception) and macro_data:
        for item in macro_data:
            sym = item.get("symbol", "")
            if sym == "USO":
                macro["oil"] = {"price": item.get("price"), "changePct": item.get("changesPercentage")}
            elif sym == "GLD":
                macro["gold"] = {"price": item.get("price"), "changePct": item.get("changesPercentage")}
            elif "CAD" in sym:
                macro["cadUsd"] = item.get("price")
            elif sym == "XIU.TO":
                macro["tsx"] = {"price": item.get("price"), "changePct": item.get("changesPercentage")}
    else:
        data_limitations.append("Macro context unavailable")

    # ── Clean news for prompt ──
    clean_news = []
    if not isinstance(news_data, Exception) and news_data:
        for n in news_data[:5]:
            clean_news.append({
                "title": n.get("title", ""),
                "publishedDate": n.get("publishedDate", ""),
                "sentiment": n.get("sentiment", ""),
                "text": (n.get("text", "") or "")[:200],
            })

    return {
        "ticker": ticker,
        "quote": quote,
        "today_bars": today_bars,
        "vwap_points": vwap_points,
        "current_vwap": current_vwap,
        "rsi": rsi,
        "rel_volume": rel_volume,
        "today_volume": today_volume,
        "avg_volume": avg_volume,
        "current_price": current_price,
        "vwap_distance": vwap_distance,
        "above_vwap": above_vwap,
        "news": clean_news,
        "macro": macro,
        "data_limitations": data_limitations,
    }
```

- [ ] **Step 6: Verify the Python code has no syntax errors**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "import ast; ast.parse(open('api_server.py').read()); print('Syntax OK')"
```

Expected: `Syntax OK`

- [ ] **Step 7: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add api_server.py
git commit -m "feat(spike-it): FMP data fetching, VWAP/RSI calculations, in-memory cache"
```

---

## Task 2: Python `/spike-it` Endpoint — Grok Integration & Response Assembly

**Files:**
- Modify: `api_server.py` (add after code from Task 1, before `# ── Main ──`)

- [ ] **Step 1: Add the Grok system prompt constant**

Add after the `_fetch_spike_it_data` function from Task 1:

```python
SPIKE_IT_SYSTEM_PROMPT = """You are SuperGrok Heavy, elite real-time TSX intraday analyst.

You will receive a JSON payload containing live FMP data for a single TSX stock that the user holds in an active position. Your job is to perform a quick health check: should they hold for more upside today, or has momentum faded?

You MUST respond with valid JSON matching this exact schema — no markdown, no commentary outside the JSON:

{
  "continuation_probability": <int 0-100>,
  "light": "<green|yellow|red>",
  "summary": "<one sentence, max 80 chars>",
  "expected_move": {
    "direction": "<up|down|flat>",
    "dollar_amount": <float>,
    "target_price": <float>
  },
  "support_price": <float>,
  "support_label": "<string, e.g. 'VWAP' or 'High-volume node'>",
  "stop_loss_price": <float>,
  "stop_loss_label": "<string>",
  "rsi_assessment": "<string, e.g. 'Healthy' or 'Overbought'>",
  "risk_warning": "<1-2 sentences, main risk for rest of day>",
  "data_limitations": ["<any honest caveats about data quality>"]
}

Traffic light rules:
- GREEN (60-100%): Price above VWAP, RSI < 75, volume confirming, no bearish divergence
- YELLOW (40-59%): Mixed signals — near VWAP, fading volume, or RSI approaching overbought
- RED (0-39%): Below VWAP, bearish divergence, volume dying, or adverse catalyst

Ground every number in the FMP data provided. Do not hallucinate price levels or invent catalysts. If data is insufficient for a field, say so in data_limitations."""
```

- [ ] **Step 2: Add the user prompt builder**

```python
def _build_spike_it_user_prompt(data: dict, entry_price: float) -> str:
    """Build the user prompt for Grok from assembled FMP data."""
    quote = data["quote"]
    current_price = data["current_price"]
    change_pct = quote.get("changesPercentage", 0)
    prev_close = quote.get("previousClose", 0)
    pnl = current_price - entry_price
    pnl_pct = (pnl / entry_price * 100) if entry_price > 0 else 0

    # Compact bars for prompt (reduce tokens)
    compact_bars = json.dumps(
        [{"t": b["time"], "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"], "v": b["volume"]}
         for b in data["today_bars"]],
        separators=(",", ":"),
    )

    macro_lines = []
    macro = data.get("macro", {})
    if "oil" in macro:
        macro_lines.append(f"- Oil (USO): ${macro['oil']['price']} ({macro['oil']['changePct']}%)")
    if "gold" in macro:
        macro_lines.append(f"- Gold (GLD): ${macro['gold']['price']} ({macro['gold']['changePct']}%)")
    if "cadUsd" in macro:
        macro_lines.append(f"- CAD/USD: {macro['cadUsd']}")
    if "tsx" in macro:
        macro_lines.append(f"- TSX (XIU.TO): ${macro['tsx']['price']} ({macro['tsx']['changePct']}%)")
    macro_block = "\n".join(macro_lines) if macro_lines else "Unavailable"

    news_block = json.dumps(data.get("news", []), separators=(",", ":"), default=str)

    return f"""Ticker: {data['ticker']}
Current Price: ${current_price} ({change_pct:+.2f}% today)
Previous Close: ${prev_close}
Today's Volume: {data['today_volume']:,} (Relative: {data['rel_volume']}x 10-day avg)

Intraday 5-min bars (OHLCV): {compact_bars}

Calculated Metrics:
- VWAP: ${data['current_vwap']}
- 14-period RSI (5-min): {data['rsi'] if data['rsi'] is not None else 'N/A'}
- Price vs VWAP: {'above' if data['above_vwap'] else 'below'} by ${abs(data['vwap_distance']) if data['vwap_distance'] else 'N/A'}

Recent News: {news_block}

Macro Context:
{macro_block}

Position context: User entered at ${entry_price:.2f}, currently {'up' if pnl >= 0 else 'down'} ${abs(pnl):.2f} ({pnl_pct:+.1f}%)."""
```

- [ ] **Step 3: Add the `/spike-it` endpoint**

```python
@app.post("/spike-it")
async def spike_it(request: SpikeItRequest):
    """Live intraday health check for a single ticker using SuperGrok."""
    ticker = request.ticker.upper().strip()
    entry_price = request.entry_price

    # ── Cache check ──
    now = time.time()
    if ticker in _spike_it_cache:
        cached = _spike_it_cache[ticker]
        if now - cached["timestamp"] < SPIKE_IT_CACHE_TTL:
            result = cached["result"].copy()
            result["cached"] = True
            result["cache_age_seconds"] = int(now - cached["timestamp"])
            return JSONResponse(content=result)

    # ── Fetch FMP data ──
    data = await _fetch_spike_it_data(ticker)
    if data is None:
        raise HTTPException(502, f"Failed to fetch market data for {ticker}")

    # ── Build prompt and call Grok ──
    user_prompt = _build_spike_it_user_prompt(data, entry_price)
    xai_key = os.environ.get("XAI_API_KEY", "")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")

    grok_raw = None
    used_model = "grok-4-0709"

    if xai_key:
        try:
            grok_raw = await _call_grok(
                api_key=xai_key,
                model="grok-4-0709",
                system_prompt=SPIKE_IT_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                max_tokens=2048,
                temperature=0.3,
            )
        except Exception as e:
            logger.warning(f"Spike It: Grok failed for {ticker}, falling back to Opus: {e}")

    # Opus fallback
    if not grok_raw and anthropic_key:
        try:
            used_model = "claude-opus-4-6"
            grok_raw = await _call_anthropic(
                api_key=anthropic_key,
                model="claude-opus-4-6",
                system_prompt=SPIKE_IT_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                max_tokens=2048,
                temperature=0.3,
            )
        except Exception as e:
            logger.error(f"Spike It: Opus fallback also failed for {ticker}: {e}")
            raise HTTPException(502, f"LLM analysis failed for {ticker}")

    if not grok_raw:
        raise HTTPException(502, f"No LLM API keys available for Spike It")

    # ── Parse Grok response ──
    parsed = _extract_json(grok_raw)
    if parsed is None:
        logger.error(f"Spike It: failed to parse Grok JSON for {ticker}")
        raise HTTPException(502, f"Failed to parse analysis for {ticker}")

    # ── Assemble response ──
    ast_now = datetime.now(ZoneInfo("America/Halifax"))
    chart_bars = [{"time": b["time"], "close": b["close"]} for b in data["today_bars"]]

    result = {
        "ticker": ticker,
        "timestamp": ast_now.isoformat(),
        "cached": False,
        "model": used_model,
        "signal": {
            "continuation_probability": parsed.get("continuation_probability", 50),
            "light": parsed.get("light", "yellow"),
            "summary": parsed.get("summary", "Analysis complete"),
        },
        "expected_move": parsed.get("expected_move", {"direction": "flat", "dollar_amount": 0, "target_price": data["current_price"]}),
        "levels": {
            "support": {"price": parsed.get("support_price", data.get("current_vwap", 0)), "label": parsed.get("support_label", "VWAP")},
            "stop_loss": {"price": parsed.get("stop_loss_price", 0), "label": parsed.get("stop_loss_label", "")},
            "rsi": {"value": data.get("rsi", 0), "label": parsed.get("rsi_assessment", "N/A")},
        },
        "risk_warning": parsed.get("risk_warning", "No specific risks identified."),
        "relative_volume": data.get("rel_volume"),
        "chart": {
            "bars": chart_bars,
            "vwap": data.get("vwap_points", []),
        },
        "data_limitations": list(set(data.get("data_limitations", []) + parsed.get("data_limitations", []))),
    }

    # ── Cache result ──
    _spike_it_cache[ticker] = {"result": result, "timestamp": now}

    return JSONResponse(content=result)
```

- [ ] **Step 4: Add the `_call_anthropic` import**

The `_call_grok` function is already imported via the brain module. But `_call_anthropic` is also in the brain module. Add to the import at line 37:

```python
from canadian_llm_council_brain import CanadianStockCouncilBrain, _call_grok, _extract_json, _call_anthropic
```

Note: If `_call_grok`, `_extract_json`, and `_call_anthropic` are not exported at module level (they're standalone functions, not class methods), this import will work directly. Verify by checking that they're defined as top-level functions (not inside a class) — which they are per the codebase analysis.

- [ ] **Step 5: Update the docstring at the top of api_server.py**

Add the new endpoint to the docstring (line 6):

```python
  POST /spike-it             → live intraday health check (SuperGrok)
```

- [ ] **Step 6: Verify syntax**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "import ast; ast.parse(open('api_server.py').read()); print('Syntax OK')"
```

Expected: `Syntax OK`

- [ ] **Step 7: Test the endpoint locally (manual smoke test)**

Run the council service:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && timeout 10 python3 -c "
import asyncio, json
from api_server import _fetch_spike_it_data, _calculate_vwap, _calculate_rsi

async def test():
    # Test VWAP calculation with fake data
    bars = [
        {'time': '10:30', 'open': 18.0, 'high': 18.5, 'low': 17.8, 'close': 18.2, 'volume': 1000},
        {'time': '10:35', 'open': 18.2, 'high': 18.6, 'low': 18.1, 'close': 18.4, 'volume': 1500},
        {'time': '10:40', 'open': 18.4, 'high': 18.7, 'low': 18.3, 'close': 18.5, 'volume': 800},
    ]
    vwap = _calculate_vwap(bars)
    print(f'VWAP points: {vwap}')
    assert len(vwap) == 3
    assert vwap[0]['value'] > 0

    # Test RSI with 20 prices
    prices = [18.0 + i * 0.1 for i in range(20)]  # Uptrend
    rsi = _calculate_rsi(prices, 14)
    print(f'RSI (uptrend): {rsi}')
    assert rsi is not None and rsi > 50

    print('All smoke tests passed')

asyncio.run(test())
" 2>&1 || echo "Test complete"
```

Expected: VWAP points printed, RSI > 50 for uptrend, "All smoke tests passed"

- [ ] **Step 8: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add api_server.py
git commit -m "feat(spike-it): Grok integration, prompt builder, /spike-it endpoint with cache"
```

---

## Task 3: Next.js API Proxy Route

**Files:**
- Create: `src/app/api/portfolio/spike-it/route.ts`

- [ ] **Step 1: Create the proxy route**

```typescript
import { NextResponse } from 'next/server';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { ticker, entryPrice } = body;

    if (!ticker || typeof entryPrice !== 'number') {
      return NextResponse.json(
        { error: 'Missing required fields: ticker (string), entryPrice (number)' },
        { status: 400 }
      );
    }

    const res = await fetch(`${COUNCIL_API_URL}/spike-it`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, entry_price: entryPrice }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: `Council service error: ${errText}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return NextResponse.json(
        { error: 'Analysis timed out — try again in a moment' },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Verify the directory exists and file is valid**

Run:
```bash
ls /Users/coeus/spiketrades.ca/claude-code/src/app/api/portfolio/
```

If the `portfolio` directory doesn't exist under `api`, create it. The `spike-it` directory needs to be created as well.

- [ ] **Step 3: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/api/portfolio/spike-it/route.ts
git commit -m "feat(spike-it): Next.js API proxy route to council service"
```

---

## Task 4: SpikeItModal Component

**Files:**
- Create: `src/components/portfolio/SpikeItModal.tsx`

- [ ] **Step 1: Create the SpikeItModal component**

This is the largest single file. It includes: skeleton loading state, traffic light signal, expected move cards, SVG intraday chart, key levels grid, risk callout, and error state.

```tsx
'use client';

import { useState, useEffect, useCallback } from 'react';

interface SpikeItResult {
  ticker: string;
  timestamp: string;
  cached: boolean;
  cache_age_seconds?: number;
  signal: {
    continuation_probability: number;
    light: 'green' | 'yellow' | 'red';
    summary: string;
  };
  expected_move: {
    direction: 'up' | 'down' | 'flat';
    dollar_amount: number;
    target_price: number;
  };
  levels: {
    support: { price: number; label: string };
    stop_loss: { price: number; label: string };
    rsi: { value: number; label: string };
  };
  risk_warning: string;
  relative_volume: number | null;
  chart: {
    bars: { time: string; close: number }[];
    vwap: { time: string; value: number }[];
  };
  data_limitations: string[];
}

interface Props {
  ticker: string;
  companyName: string;
  entryPrice: number;
  onClose: () => void;
}

const SIGNAL_COLORS = {
  green: { bg: 'rgba(76,175,80,0.08)', border: 'rgba(76,175,80,0.2)', text: '#4caf50', emoji: '🟢' },
  yellow: { bg: 'rgba(255,193,7,0.08)', border: 'rgba(255,193,7,0.2)', text: '#ffc107', emoji: '🟡' },
  red: { bg: 'rgba(255,82,82,0.08)', border: 'rgba(255,82,82,0.2)', text: '#ff5252', emoji: '🔴' },
};

function IntradayChart({ bars, vwap }: { bars: { time: string; close: number }[]; vwap: { time: string; value: number }[] }) {
  if (bars.length < 2) return null;

  const prices = bars.map(b => b.close);
  const vwapPrices = vwap.map(v => v.value);
  const allValues = [...prices, ...vwapPrices];
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const range = maxVal - minVal || 1;
  const padding = range * 0.1;
  const yMin = minVal - padding;
  const yMax = maxVal + padding;

  const w = 400;
  const h = 80;
  const toX = (i: number) => (i / (bars.length - 1)) * w;
  const toY = (v: number) => h - ((v - yMin) / (yMax - yMin)) * h;

  const priceLine = bars.map((b, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(b.close).toFixed(1)}`).join(' ');
  const priceArea = `${priceLine} L${w},${h} L0,${h} Z`;
  const isUp = bars[bars.length - 1].close >= bars[0].close;
  const lineColor = isUp ? '#4caf50' : '#ff5252';
  const gradId = `spike-it-grad-${isUp ? 'up' : 'down'}`;

  // VWAP line (map by index since they should align)
  const vwapLine = vwap.length >= 2
    ? vwap.map((v, i) => {
        const xi = (i / (vwap.length - 1)) * w;
        return `${i === 0 ? 'M' : 'L'}${xi.toFixed(1)},${toY(v.value).toFixed(1)}`;
      }).join(' ')
    : '';

  // Time labels (show 5 evenly spaced)
  const labelCount = 5;
  const labels = [];
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round((i / (labelCount - 1)) * (bars.length - 1));
    labels.push({ x: toX(idx), text: bars[idx].time });
  }

  return (
    <div className="rounded-lg border border-spike-border/30 p-3 mb-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="text-[9px] uppercase tracking-wider text-spike-text-dim mb-2">Intraday Price Action</div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 60 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.3} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        {vwapLine && (
          <path d={vwapLine} fill="none" stroke="#ff6b35" strokeWidth="1" strokeDasharray="4,4" opacity={0.6} />
        )}
        <path d={priceArea} fill={`url(#${gradId})`} />
        <path d={priceLine} fill="none" stroke={lineColor} strokeWidth="2" />
      </svg>
      <div className="flex justify-between text-[9px] text-spike-text-dim mt-1">
        {labels.map((l, i) => (
          <span key={i}>{i === labels.length - 1 ? 'Now' : l.text}</span>
        ))}
      </div>
      {vwapLine && (
        <div className="flex items-center gap-2 mt-1">
          <div className="w-4 border-t border-dashed" style={{ borderColor: '#ff6b35' }} />
          <span className="text-[9px]" style={{ color: '#ff6b35' }}>VWAP</span>
        </div>
      )}
    </div>
  );
}

function SkeletonPulse({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-spike-border/20 ${className}`} />;
}

export default function SpikeItModal({ ticker, companyName, entryPrice, onClose }: Props) {
  const [result, setResult] = useState<SpikeItResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/portfolio/spike-it', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, entryPrice }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data: SpikeItResult = await res.json();
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ticker, entryPrice]);

  useEffect(() => {
    fetchAnalysis();
  }, [fetchAnalysis]);

  const colors = result ? SIGNAL_COLORS[result.signal.light] : SIGNAL_COLORS.yellow;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={onClose}>
      <div className="glass-card p-6 w-full max-w-[480px] mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-spike-text-dim">Live Health Check</div>
            <div className="text-xl font-bold text-spike-cyan">
              {ticker} <span className="text-sm font-normal text-spike-text-dim">{companyName}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-spike-text-dim hover:text-spike-text text-xl leading-none">&times;</button>
        </div>

        {/* Error state */}
        {error && !loading && (
          <div className="text-center py-8">
            <div className="text-spike-red text-sm mb-3">{error}</div>
            <button
              onClick={fetchAnalysis}
              className="px-4 py-2 rounded-lg text-xs font-medium text-spike-cyan bg-spike-cyan/5 border border-spike-cyan/15 hover:bg-spike-cyan/10 transition-all"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <>
            <div className="rounded-xl p-5 mb-4" style={{ background: 'rgba(255,193,7,0.05)', border: '1px solid rgba(255,193,7,0.1)' }}>
              <SkeletonPulse className="h-9 w-9 mx-auto mb-2 rounded-full" />
              <SkeletonPulse className="h-7 w-48 mx-auto mb-2" />
              <SkeletonPulse className="h-4 w-56 mx-auto" />
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg border border-spike-border/30 p-3"><SkeletonPulse className="h-5 w-20 mb-1" /><SkeletonPulse className="h-6 w-16" /></div>
              <div className="rounded-lg border border-spike-border/30 p-3"><SkeletonPulse className="h-5 w-20 mb-1" /><SkeletonPulse className="h-6 w-16" /></div>
            </div>
            <div className="rounded-lg border border-spike-border/30 p-3 mb-4"><SkeletonPulse className="h-[60px] w-full" /></div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="text-center"><SkeletonPulse className="h-4 w-12 mx-auto mb-1" /><SkeletonPulse className="h-5 w-14 mx-auto" /></div>
              <div className="text-center"><SkeletonPulse className="h-4 w-12 mx-auto mb-1" /><SkeletonPulse className="h-5 w-14 mx-auto" /></div>
              <div className="text-center"><SkeletonPulse className="h-4 w-12 mx-auto mb-1" /><SkeletonPulse className="h-5 w-14 mx-auto" /></div>
            </div>
            <SkeletonPulse className="h-16 w-full rounded-lg" />
          </>
        )}

        {/* Result */}
        {result && !loading && (
          <>
            {/* Traffic light signal */}
            <div
              className="rounded-xl p-5 mb-4 text-center"
              style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
            >
              <div className="text-4xl mb-1">{colors.emoji}</div>
              <div className="text-2xl font-bold" style={{ color: colors.text }}>
                {result.signal.continuation_probability}% Continuation
              </div>
              <div className="text-sm text-spike-text-dim mt-1">{result.signal.summary}</div>
            </div>

            {/* Expected Move + Relative Volume */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg border border-spike-border/30 p-3 text-center" style={{ background: 'rgba(255,255,255,0.03)' }}>
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">Expected Move</div>
                <div className="text-lg font-bold" style={{ color: result.expected_move.direction === 'up' ? '#4caf50' : result.expected_move.direction === 'down' ? '#ff5252' : '#ffc107' }}>
                  {result.expected_move.direction === 'up' ? '+' : result.expected_move.direction === 'down' ? '-' : ''}${result.expected_move.dollar_amount.toFixed(2)}
                </div>
                <div className="text-[10px] text-spike-text-dim">to ${result.expected_move.target_price.toFixed(2)} by close</div>
              </div>
              <div className="rounded-lg border border-spike-border/30 p-3 text-center" style={{ background: 'rgba(255,255,255,0.03)' }}>
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">Relative Volume</div>
                <div className="text-lg font-bold text-spike-cyan">
                  {result.relative_volume != null ? `${result.relative_volume}x` : 'N/A'}
                </div>
                <div className="text-[10px] text-spike-text-dim">
                  {result.relative_volume != null ? 'above 10-day avg' : 'data unavailable'}
                </div>
              </div>
            </div>

            {/* Intraday Chart */}
            <IntradayChart bars={result.chart.bars} vwap={result.chart.vwap} />

            {/* Key Levels */}
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="text-center">
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">Support</div>
                <div className="text-sm font-semibold text-spike-cyan">${result.levels.support.price.toFixed(2)}</div>
                <div className="text-[9px] text-spike-text-dim">{result.levels.support.label}</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">Stop Loss</div>
                <div className="text-sm font-semibold text-spike-red">${result.levels.stop_loss.price.toFixed(2)}</div>
                <div className="text-[9px] text-spike-text-dim">{result.levels.stop_loss.label}</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">RSI (5m)</div>
                <div className="text-sm font-semibold" style={{ color: result.levels.rsi.value > 70 ? '#ff5252' : result.levels.rsi.value > 60 ? '#ffc107' : '#4caf50' }}>
                  {result.levels.rsi.value || 'N/A'}
                </div>
                <div className="text-[9px] text-spike-text-dim">{result.levels.rsi.label}</div>
              </div>
            </div>

            {/* Risk Warning */}
            <div className="rounded-lg p-3 mb-4" style={{ background: 'rgba(255,193,7,0.08)', border: '1px solid rgba(255,193,7,0.15)' }}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-spike-gold mb-1">&#9888; Risk to Watch</div>
              <div className="text-xs text-spike-text/70 leading-relaxed">{result.risk_warning}</div>
            </div>

            {/* Data limitations */}
            {result.data_limitations.length > 0 && (
              <div className="text-[9px] text-spike-text-dim mb-3">
                Note: {result.data_limitations.join('. ')}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between">
              <div className="text-[9px] text-spike-text-dim">
                Powered by SuperGrok Heavy &middot; {new Date(result.timestamp).toLocaleTimeString('en-CA', { timeZone: 'America/Halifax', hour: 'numeric', minute: '2-digit', hour12: true })} AST
                {result.cached && result.cache_age_seconds != null && (
                  <span> &middot; Cached {Math.floor(result.cache_age_seconds / 60)}m ago</span>
                )}
              </div>
              <button
                onClick={onClose}
                className="px-4 py-1.5 rounded-lg text-xs font-medium text-spike-text-dim bg-spike-bg border border-spike-border hover:border-spike-text-dim/30 transition-all"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the component file exists and has no obvious issues**

Run:
```bash
wc -l /Users/coeus/spiketrades.ca/claude-code/src/components/portfolio/SpikeItModal.tsx
```

Expected: ~230-250 lines

- [ ] **Step 3: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/components/portfolio/SpikeItModal.tsx
git commit -m "feat(spike-it): SpikeItModal component with skeleton, chart, levels, risk"
```

---

## Task 5: Wire Spike It Button into Portfolio Page

**Files:**
- Modify: `src/app/portfolio/page.tsx`

- [ ] **Step 1: Add the SpikeItModal import**

Add to the imports at the top of the file (near other component imports):

```typescript
import SpikeItModal from '@/components/portfolio/SpikeItModal';
```

- [ ] **Step 2: Add the market hours helper function**

Add before the component function (outside the component, as a utility):

```typescript
function isMarketOpen(): boolean {
  const now = new Date();
  // Convert to AST (America/Halifax = UTC-4 standard, UTC-3 daylight)
  const ast = new Date(now.toLocaleString('en-US', { timeZone: 'America/Halifax' }));
  const day = ast.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hours = ast.getHours();
  const minutes = ast.getMinutes();
  const timeInMinutes = hours * 60 + minutes;
  // 10:30 AM = 630 min, 5:00 PM = 1020 min (AST)
  return timeInMinutes >= 630 && timeInMinutes <= 1020;
}
```

- [ ] **Step 3: Add state for the Spike It modal**

Add after the existing `useState` hooks (around line 67, near `sellModal` state):

```typescript
const [spikeItTicker, setSpikeItTicker] = useState<{ ticker: string; name: string; entryPrice: number } | null>(null);
```

- [ ] **Step 4: Add the Spike It button to each portfolio tile**

Find the button section at line 548-562. Insert the Spike It button before the `<Link>` for "View Analysis". The existing code is:

```typescript
<div className="flex items-center gap-2 flex-shrink-0">
  <Link
    href={`/dashboard/analysis/${pos.spikeId}`}
```

Change to:

```typescript
<div className="flex items-center gap-2 flex-shrink-0">
  <button
    onClick={() => setSpikeItTicker({ ticker: pos.ticker, name: pos.name, entryPrice: pos.entryPrice })}
    disabled={!isMarketOpen()}
    className="px-3 py-2 rounded-lg text-xs font-medium text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
    style={{ background: isMarketOpen() ? 'linear-gradient(135deg, #ff6b35, #ff8c42)' : '#333' }}
    title={isMarketOpen() ? 'Live health check — is this spike still running?' : 'Available during market hours (10:30 AM - 5:00 PM AST)'}
  >
    ⚡ Spike It
  </button>
  <Link
    href={`/dashboard/analysis/${pos.spikeId}`}
```

- [ ] **Step 5: Add the SpikeItModal render**

Find the existing sell modal render (around line 639, `{sellModal && (`). Add the SpikeItModal just before it:

```typescript
{spikeItTicker && (
  <SpikeItModal
    ticker={spikeItTicker.ticker}
    companyName={spikeItTicker.name}
    entryPrice={spikeItTicker.entryPrice}
    onClose={() => setSpikeItTicker(null)}
  />
)}
```

- [ ] **Step 6: Verify the build compiles**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && npx next build 2>&1 | tail -20
```

Expected: Build succeeds with no errors (warnings about unused variables are acceptable).

- [ ] **Step 7: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/portfolio/page.tsx
git commit -m "feat(spike-it): wire Spike It button + modal into portfolio tiles"
```

---

## Task 6: Version Bump to Ver 3.2

**Files:**
- Modify: 8 page files containing "Ver 3.1"

- [ ] **Step 1: Bump version in all page footers**

The following files contain `Ver 3.1` in their footer. Update each one:

1. `src/app/portfolio/page.tsx`
2. `src/app/reports/page.tsx`
3. `src/app/login/page.tsx`
4. `src/app/dashboard/page.tsx`
5. `src/app/dashboard/analysis/[id]/page.tsx`
6. `src/app/admin/page.tsx`
7. `src/app/accuracy/page.tsx`
8. `src/app/settings/page.tsx`

In each file, find `Ver 3.1` and replace with `Ver 3.2`.

Use a single sed command across all files:

```bash
cd /Users/coeus/spiketrades.ca/claude-code
grep -rl "Ver 3.1" src/app/ | xargs sed -i '' 's/Ver 3\.1/Ver 3.2/g'
```

- [ ] **Step 2: Update FEATURES.md**

Find the version header in `FEATURES.md` and add a new entry for Ver 3.2 at the top of the changelog:

```markdown
## Ver 3.2 — 2026-04-01
- **Spike It** — Live intraday health check button on portfolio tiles, powered by SuperGrok Heavy. Shows continuation probability, expected move, real-time chart, key levels, and risk warnings.
```

- [ ] **Step 3: Verify all version strings updated**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && grep -r "Ver 3.1" src/app/ | grep -v node_modules | grep -v ".next"
```

Expected: No output (all instances replaced). Note: `docs/` and `SESSION_TRANSITIONS.md` may still reference 3.1 historically — that's correct, don't change those.

- [ ] **Step 4: Verify build still compiles**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && npx next build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add -A src/app/ FEATURES.md
git commit -m "chore: version bump to Ver 3.2 + FEATURES.md changelog"
```

---

## Task 7: End-to-End Verification

**Files:** None (testing only)

- [ ] **Step 1: Verify Python endpoint starts without errors**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && timeout 5 python3 -c "
from api_server import app
print('FastAPI app loaded successfully')
print('Routes:')
for route in app.routes:
    if hasattr(route, 'path'):
        print(f'  {route.methods if hasattr(route, \"methods\") else \"\"} {route.path}')
" 2>&1
```

Expected: App loads, `/spike-it` route listed among routes.

- [ ] **Step 2: Verify the Next.js build includes the new route**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && ls -la src/app/api/portfolio/spike-it/route.ts
```

Expected: File exists.

- [ ] **Step 3: Verify SpikeItModal component exists with expected exports**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && grep "export default" src/components/portfolio/SpikeItModal.tsx
```

Expected: `export default function SpikeItModal`

- [ ] **Step 4: Verify portfolio page imports SpikeItModal**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && grep "SpikeItModal" src/app/portfolio/page.tsx
```

Expected: Import line + JSX usage (2-3 matches).

- [ ] **Step 5: Verify no existing tests are broken**

If there are existing tests:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && npm test 2>&1 | tail -20
```

If no test suite exists, verify the build passes:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && npx next build 2>&1 | tail -5
```

Expected: All tests pass / build succeeds.

- [ ] **Step 6: Final commit (if any fixes were needed)**

Only commit if fixes were made during verification. Otherwise skip.

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add -A
git commit -m "fix: address issues found during end-to-end verification"
```

- [ ] **Step 7: Verify git log shows all feature commits**

```bash
cd /Users/coeus/spiketrades.ca/claude-code && git log --oneline -8
```

Expected: 5-6 commits for this feature (Tasks 1-6), all with `spike-it` or `Ver 3.2` in the message.
