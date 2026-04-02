# Spike It Per-User Isolation

## Problem

Spike It is currently global — all users share a single cache keyed by ticker only. This causes:

1. **Wrong analysis served to users.** User A requests ENB.TO with entry price $55, result is cached. User B requests ENB.TO with entry price $40 and receives User A's analysis — wrong P&L, wrong hold/sell recommendation, wrong stop-loss levels relative to their position.
2. **No authentication on the endpoint.** The Next.js route doesn't check session. The Python endpoint has no concept of who is asking.
3. **No per-user isolation of any kind.** Cache, rate of requests, and results are entirely shared.

## Solution

Make Spike It analysis per-user by passing user identity through the request chain and splitting the cache into two layers: global market data and per-user analysis.

## Design

### Two-Layer Cache

| Layer | Key | TTL | Contents |
|---|---|---|---|
| **Data cache** (global) | `ticker` | 5 min | FMP market data (quotes, bars, news, macro, calculated VWAP/RSI) |
| **Analysis cache** (per-user) | `userId:ticker` | 5 min (skipped on read for admin) | LLM result (signal, levels, expected move, chart) |

This means if 3 users all Spike It on the same ticker within 5 minutes, FMP is called once but the LLM runs 3 times — each with the correct entry price for that user's position.

### Changes by File

#### 1. `src/app/api/portfolio/spike-it/route.ts`

- Import `getSession` from `@/lib/auth`
- Extract `userId` and `role` from iron-session cookie
- Return 401 if no valid session
- Pass `user_id` (string) and `is_admin` (boolean, true when `role === 'admin'`) to the Python endpoint alongside existing `ticker` and `entry_price`

#### 2. `api_server.py` — Request model

Add two fields to `SpikeItRequest`:
```python
class SpikeItRequest(BaseModel):
    ticker: str
    entry_price: float
    user_id: str = ""       # empty = legacy/unauthenticated (treat as unique)
    is_admin: bool = False
```

#### 3. `api_server.py` — Cache split

Replace single `_spike_it_cache` dict with two:

```python
_spike_it_data_cache: dict[str, dict] = {}    # key: ticker, value: {data, timestamp}
_spike_it_analysis_cache: dict[str, dict] = {} # key: userId:ticker, value: {result, timestamp}
```

**Data cache (global):** `_fetch_spike_it_data(ticker)` checks `_spike_it_data_cache[ticker]` first. On miss, fetches from FMP and caches. TTL: 5 minutes.

**Analysis cache (per-user):**
- Cache key: `f"{user_id}:{ticker}"`
- On read: skip if `is_admin` is true (admin always gets fresh LLM analysis)
- On write: always cache (so admin sees "cached" indicator on rapid re-click)
- TTL: 5 minutes

#### 4. `api_server.py` — Endpoint logic

Restructure the `spike_it()` function:

```
1. Normalize ticker
2. Build analysis cache key = f"{request.user_id}:{ticker}"
3. If not admin, check analysis cache → return if hit
4. Fetch market data (uses global data cache internally)
5. Build LLM prompt with request.entry_price
6. Call LLM (Grok → Opus fallback)
7. Construct result
8. Write to analysis cache
9. Return result
```

### What Does NOT Change

- `SpikeItModal.tsx` — zero changes. Already sends `{ticker, entryPrice}`.
- `src/app/portfolio/page.tsx` — zero changes. Button and modal logic unchanged.
- `_fetch_spike_it_data()` internals — same FMP calls, same VWAP/RSI calculations. Only wrapped with data cache check.
- LLM prompt and system prompt — unchanged.
- Council pipeline, cron, daily reports — completely unaffected.

### Request Flow

```
User clicks "Spike It" on position card
  POST /api/portfolio/spike-it {ticker, entryPrice}
    Next.js: extract userId + role from iron-session
      No session → 401 Unauthorized
    POST to Python /spike-it {ticker, entry_price, user_id, is_admin}
      Check analysis cache [userId:ticker]
        Hit + not admin → return cached result
        Miss or admin →
          Check data cache [ticker]
            Hit → use cached market data
            Miss → fetch from FMP, cache globally
          Build prompt with user's entry_price
          Call Grok (fallback Opus)
          Cache analysis under [userId:ticker]
          Return fresh result
```

### Server Impact

| Concern | Impact |
|---|---|
| LLM costs | Increases linearly with active users. ~$0.05/call. At 5 users, worst case ~$2.50/day vs ~$0.50/day currently. |
| FMP API calls | No increase — market data stays globally cached per ticker. |
| Memory | Negligible. Analysis cache grows to ~users x tickers entries (max ~50 for 5 users). |
| Python server load | Async LLM calls. 5 concurrent users = 5 parallel HTTP calls to Grok/Opus. Well within capacity. |
| Council/cron pipeline | Zero impact. Spike It is fully independent. |
| Database | No schema changes. No migrations. Feature remains stateless. |

### Admin Behavior

- Admin (`role === 'admin'`) always gets a fresh LLM call — analysis cache is skipped on read.
- Result is still written to analysis cache (so accidental rapid double-click within ~1 second doesn't trigger two LLM calls).
- Regular users get 5-minute cached analysis per ticker, reflecting their own entry price.

### Edge Cases

| Scenario | Behavior |
|---|---|
| User averages down, clicks Spike It again within 5 min | Gets cached result with old entry price. Acceptable — 5 min max staleness. If unacceptable later, cache key can include entry price. |
| Unauthenticated request reaches Python directly | `user_id` defaults to empty string. Treated as a unique user. Next.js gate prevents this in normal flow. |
| User deleted while analysis cached | Cache expires in 5 min. No persistent state to clean up. |
| Two users, same ticker, same entry price | Each gets their own LLM call and cache entry. No cross-contamination. |
