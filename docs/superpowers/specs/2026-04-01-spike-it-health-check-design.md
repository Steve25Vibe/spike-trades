# Spike It — Live Intraday Health Check

**Date:** 2026-04-01
**Feature:** "Spike It" button on portfolio tiles — real-time continuation-vs-reversal analysis powered by SuperGrok Heavy
**Version:** Spike Trades Ver 3.2

---

## Hard Constraints

- **No existing data may be altered.** No database schema changes (PostgreSQL or SQLite), no migration risk, no modifications to existing API routes, no changes to `run_council()` or any council brain pipeline functions.
- **All timestamps displayed in AST** (Atlantic Standard Time). Market hours gate uses AST equivalents.
- **FMP data only** — no Finnhub or other data sources for this feature.

---

## Overview

A "Spike It" button on each portfolio tile that triggers a live intraday health check via SuperGrok Heavy. The user clicks the button, a skeleton modal opens immediately, and within ~10-15 seconds Grok returns a structured analysis: continuation probability (traffic light), expected price move, intraday chart, key support/stop levels, and a risk warning. The goal is to help the user make a quick hold-or-close decision based on real-time data.

---

## Architecture

**Backend:** New `POST /spike-it` endpoint on the existing Python FastAPI council service (port 8100). This keeps LLM calling logic consolidated — the service already has the Grok caller (`_call_grok()`), FMP key, and retry logic.

**Frontend:** New Next.js API proxy route (`POST /api/portfolio/spike-it`) that forwards to the council service. New `SpikeItModal` React component for the result display.

**Data flow:**
1. User clicks "Spike It" on a portfolio tile
2. Frontend opens skeleton modal immediately, calls Next.js proxy route
3. Next.js proxy forwards `{ ticker, entry_price }` to `POST council:8100/spike-it`
4. Python endpoint checks in-memory cache (5-min TTL per ticker)
5. On cache miss: fetches FMP data in parallel, calculates VWAP + RSI, assembles Grok prompt, calls Grok
6. Returns combined payload: Grok analysis JSON + raw intraday bars + VWAP array
7. Frontend populates modal sections with fade-in transition

---

## Backend: `/spike-it` Endpoint

### Request

```
POST /spike-it
Content-Type: application/json

{ "ticker": "VET.TO", "entry_price": 18.43 }
```

### Processing Pipeline

1. **Cache check** — In-memory dict keyed by ticker. If result exists and < 5 min old, return immediately with `"cached": true`.

2. **FMP data fetch** (parallel where possible):
   - Real-time quote: price, volume, change, previousClose
   - 5-min intraday bars (today): OHLCV array
   - 10-day historical daily bars: for average volume calculation
   - Stock news (limit 5): recent catalysts
   - Macro context: oil (USO), gold (GLD), CAD/USD, TSX (XIU.TO)

3. **Python calculations** (deterministic, no LLM):
   - VWAP: `sum(typical_price * volume) / sum(volume)` from intraday bars
   - Relative volume: `today_volume / avg_10day_volume`
   - 14-period RSI from 5-min closing prices
   - Price position vs VWAP (above/below, dollar distance)

4. **Grok call** — Assembled data + system prompt → structured JSON response. Uses existing `_call_grok()` utility (not modified). Falls back to Opus if Grok fails (same pattern as Stage 4).

5. **JSON extraction** — Uses existing `_extract_json()` to parse Grok response.

6. **Response assembly** — Merges Grok output with raw chart data arrays.

### Response Schema

```json
{
  "ticker": "VET.TO",
  "timestamp": "2026-04-01T15:34:00-03:00",
  "cached": false,
  "signal": {
    "continuation_probability": 72,
    "light": "green",
    "summary": "Momentum intact — price above VWAP with strong volume"
  },
  "expected_move": {
    "direction": "up",
    "dollar_amount": 0.35,
    "target_price": 19.52
  },
  "levels": {
    "support": { "price": 18.95, "label": "VWAP" },
    "stop_loss": { "price": 18.72, "label": "Below VWAP" },
    "rsi": { "value": 64, "label": "Healthy" }
  },
  "risk_warning": "Oil prices softening mid-session. If WTI breaks below $68, energy names may give back gains.",
  "relative_volume": 1.8,
  "chart": {
    "bars": [{ "time": "10:30", "close": 18.55 }, { "time": "10:35", "close": 18.60 }],
    "vwap": [{ "time": "10:30", "value": 18.50 }, { "time": "10:35", "value": 18.53 }]
  },
  "data_limitations": []
}
```

Note: All times in the response are AST.

### Grok System Prompt

Stored as `SPIKE_IT_SYSTEM_PROMPT` constant in `api_server.py`.

```
You are SuperGrok Heavy, elite real-time TSX intraday analyst.

You will receive a JSON payload containing live FMP data for a single TSX stock
that the user holds in an active position. Your job is to perform a quick
health check: should they hold for more upside today, or has momentum faded?

You MUST respond with valid JSON matching this exact schema — no markdown,
no commentary outside the JSON:

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

Ground every number in the FMP data provided. Do not hallucinate price levels
or invent catalysts. If data is insufficient for a field, say so in data_limitations.
```

### User Prompt (dynamically assembled)

```
Ticker: {ticker}
Current Price: ${price} ({change_pct}% today)
Previous Close: ${prev_close}
Today's Volume: {volume} (Relative: {rel_vol}x 10-day avg)

Intraday 5-min bars (OHLCV): {json_bars}

Calculated Metrics:
- VWAP: ${vwap}
- 14-period RSI (5-min): {rsi}
- Price vs VWAP: {above_below} by ${distance}

Recent News: {news_json}

Macro Context:
- Oil (USO): ${oil_price} ({oil_change}%)
- Gold (GLD): ${gold_price} ({gold_change}%)
- CAD/USD: {cad_usd}
- TSX (XIU.TO): ${tsx_price} ({tsx_change}%)

Position context: User entered at ${entry_price}, currently {pnl_direction} ${pnl_amount} ({pnl_pct}%).
```

---

## Frontend: Button

**Placement:** Inline with existing action buttons on each portfolio tile, left of "View Analysis".

**Appearance:**
- Orange gradient background (`linear-gradient(135deg, #ff6b35, #ff8c42)`)
- White text, `⚡ Spike It` label
- Matches size/padding of adjacent buttons

**Tooltip on hover:** "Live health check — is this spike still running?"

**Market hours gate:**
- Client-side check: current time converted to AST, compared against 10:30 AM - 5:00 PM AST on weekdays (Mon-Fri)
- Outside market hours: button visible but disabled/greyed with tooltip "Available during market hours (10:30 AM - 5:00 PM AST)"

**In-flight state:** Button shows small spinner + "Analyzing..." text, disabled to prevent double-clicks.

---

## Frontend: Next.js API Proxy

**Route:** `POST /api/portfolio/spike-it`

**Request:** `{ ticker: string, entryPrice: number }`

**Behavior:**
- Forwards to `${COUNCIL_API_URL}/spike-it` with `{ ticker, entry_price }`
- 30-second timeout
- Returns council response directly on success
- Returns `{ error: string }` on failure

---

## Frontend: SpikeItModal Component

**New file:** `src/components/portfolio/SpikeItModal.tsx`

**Props:** `{ ticker: string, companyName: string, entryPrice: number, onClose: () => void }`

**Loading state (skeleton):**
- Modal opens immediately on button click
- Full layout structure visible with pulsing grey placeholder bars
- Header shows ticker + company name immediately (known from tile data)
- Sections populate with fade-in when response arrives

**Result layout (top to bottom):**

1. **Header** — "Live Health Check" uppercase label, ticker in cyan, company name dimmed, close (x) button
2. **Traffic light signal** — Large emoji (🟢/🟡/🔴), "XX% Continuation" in signal color, one-line summary. Background tinted to match: green → `rgba(76,175,80,0.08)`, yellow → `rgba(255,193,7,0.08)`, red → `rgba(255,82,82,0.08)`.
3. **Expected Move + Relative Volume** — 2-column grid. Left: direction arrow + dollar amount + target price. Right: Nx relative volume + "above 10-day avg".
4. **Intraday chart** — SVG rendered from `chart.bars[]` (price line, green if up / red if down) and `chart.vwap[]` (dashed orange line). Time axis in AST (10:30 AM to 5:00 PM). Fill gradient under price line.
5. **Key levels** — 3-column grid: Support (price + label, cyan), Stop Loss (price + label, red), RSI (value + assessment label, color by value)
6. **Risk callout** — Amber-tinted banner with ⚠ icon, warning text from Grok
7. **Footer** — "Powered by SuperGrok Heavy · {time} AST" left-aligned, Close button right-aligned. If cached, show "Cached result from X min ago".

**Modal style:** Follows existing pattern — `fixed inset-0 bg-black/60 backdrop-blur-sm z-50`, glass-card container, max-width ~480px, click-outside to close.

---

## Caching

- In-memory Python dictionary in `api_server.py`, keyed by ticker string
- 5-minute TTL per entry
- Cache cleared on service restart (acceptable for short-lived intraday data)
- Response includes `"cached": true/false` for frontend display
- No persistence to disk or database

---

## Error Handling

### FMP Data Resilience
- **Quote endpoint fails:** Return error to frontend — analysis cannot proceed without core price data
- **Intraday bars fail:** Return error — bars are required for VWAP, RSI, and chart
- **News endpoint fails:** Proceed without news, add "News data unavailable" to `data_limitations`
- **Macro endpoint fails:** Proceed without macro context, note in `data_limitations`

### Grok Resilience
- Uses existing `_call_grok()` with 4-attempt retry + exponential backoff
- If Grok fails after retries: fall back to Claude Opus (same as Stage 4 council pipeline)
- If fallback also fails: return error to frontend
- JSON parse failure: use existing `_extract_json()` to strip markdown fences, retry parse

### Frontend Error States
- Council service unreachable: modal shows "Health check unavailable — council service offline" + retry button
- Grok/analysis error: "Analysis failed — try again in a moment" + retry button
- Timeout (>30s): "Analysis timed out" + retry button

### Edge Cases
- **Ticker halted/delisted:** FMP returns stale/empty data → Python detects, returns descriptive error
- **Multiple simultaneous clicks (different tickers):** Independent requests, no queuing
- **Market just opened (< 30 min of bars):** Analysis proceeds with fewer data points, noted in `data_limitations`
- **Weekend/holiday click:** Button disabled by market hours gate (client-side)

---

## File Changes

### New Files (2)
1. `src/components/portfolio/SpikeItModal.tsx` — Result modal component
2. `src/app/api/portfolio/spike-it/route.ts` — Next.js API proxy route

### Modified Files (4)
3. `src/app/portfolio/page.tsx` — Add Spike It button to tile, market hours check, modal state management
4. `api_server.py` — New `/spike-it` POST endpoint, FMP data fetching, VWAP/RSI calculations, Grok prompt, caching, `SPIKE_IT_SYSTEM_PROMPT` constant
5. `src/app/portfolio/page.tsx` or relevant layout — Update version display from "Ver 3.1" to "Ver 3.2"

Note: `SPIKE_IT_SYSTEM_PROMPT` lives in `api_server.py` alongside the endpoint — not in `canadian_llm_council_brain.py`, since this feature is self-contained and unrelated to the 4-stage pipeline.

### Not Modified
- `src/lib/api/fmp.ts` — FMP calls happen in Python for this feature
- `docker-compose.yml` — Council service already has all needed env vars
- `prisma/schema.prisma` — No database changes
- Any existing API routes, council pipeline, or historical data
