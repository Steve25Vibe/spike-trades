# Opening Bell — Design Spec

**Date:** April 3, 2026
**Feature:** Early-morning momentum scanner that runs 5 minutes after TSX market open, using a single Sonnet 4.6 call to detect institutional flow and rapid movers.

## Overview

Opening Bell is a daily pre-Council scan that catches early institutional momentum on TSX/TSXV stocks. It runs at 10:35 AM AST (9:35 AM EST), 10 minutes before the Council triggers, and delivers 10 ranked picks with intraday price targets within ~3 minutes. Results are presented on a dedicated page, stored in archives, and optionally emailed to users.

The feature complements Today's Spikes — Opening Bell catches what's moving *now* based on opening volume and price action; the Council validates what's fundamentally *worth holding* over 3-8 days. When both agree on a pick, an animated bell icon on Today's Spikes signals that convergence.

## Timing & Schedule

- **Cron trigger:** `35 10 * * 1-5` (weekdays, 10:35 AM AST / 9:35 AM EST)
- **Pipeline duration:** ~2.5-3 minutes
- **Hard timeout:** 5 minutes — if not complete by 10:40 AM AST, kill and return partial results
- **Results ready:** ~10:38 AM AST
- **Council starts:** 10:45 AM AST — 7-minute gap, no overlap
- **No Council schedule change required**

## Backend Pipeline

### New Python Endpoint: `POST /run-opening-bell`

Runs on the existing FastAPI server (port 8100).

**Step 1 — Fetch TSX universe quotes (~1s)**
- Call `/stable/batch-quote` for all TSX/TSXV tickers meeting filters
- Filters: $2M+ average daily volume, >$1.00 price
- ~3-5 batch calls, well within 750 req/min FMP Premium limit

**Step 2 — Compute rankings (~instant)**
- Calculate change% from previous close
- Calculate relative volume (today's volume / avgVolume)
- Sort by composite score (change% weighted + relative volume weighted)
- Take top 30-40 movers

**Step 3 — Enrich top movers (~10-15s)**
- Attempt 5-min intraday bars for top 30-40 tickers (volume acceleration, VWAP)
  - Endpoint: `/stable/historical-chart/5min/{ticker}` — same as Spike It uses
  - Canadian stocks may return empty outside market hours; include daily quote fallback (same pattern as Spike It in api_server.py lines 707-739)
  - If intraday bars unavailable, use batch quote data (open, high, low, volume) as synthetic single bar
- Fetch sector performance snapshot (`/stable/sector-performance-snapshot?exchange=TSX&date={today}`)
- Fetch recent grades (`/stable/grades?symbol=X`) for top 30-40 tickers
- ~50 FMP calls total — 6.7% of 750/min budget

**Step 4 — Single Sonnet 4.6 call (~60-90s)**
- Input: Top 30-40 enriched tickers + sector heat map + historical ATR data (90-day bars)
- Model: `claude-sonnet-4-6`
- Temperature: 0.3
- Max tokens: 8,192
- Output: Top 10 ranked picks, each with:
  - Momentum score (0-100)
  - Intraday target price (based on ATR + momentum)
  - Key level (price where thesis breaks / stop-loss guide)
  - Conviction: High / Medium / Low
  - One-line rationale

**Step 5 — Save + feed Council (~instant)**
- Store results in database (OpeningBellReport + OpeningBellPick)
- Cache top 10 tickers for Council pre-filter override

**Step 6 — Send email + push to frontend (~0.5s)**
- Send Opening Bell email to opted-in users via Resend
- Results available on `/opening-bell` page

### FMP Rate Limit Budget

| Phase | Calls | Budget Impact |
|-------|-------|---------------|
| Opening Bell (~10:35 AM) | ~50 calls | 6.7% of 750/min |
| Council (~10:45 AM) | Existing load | Unaffected — 7-min gap |

### Concurrency Lock
- Add `_opening_bell_running` boolean lock (same pattern as `_council_running`)
- If Opening Bell is still running when Council triggers, Council waits until Opening Bell completes
- Opening Bell's 5-minute hard timeout guarantees Council is never blocked more than 5 minutes

## Council Integration

### Pre-filter Override
Opening Bell's top 10 tickers are fed into the Council's pre-filter as guaranteed Stage 1 candidates. These tickers bypass:
- ADV threshold ($5M filter)
- Technical pre-filter (RSI, ADX, relative volume checks)

The Council's 4-stage pipeline still evaluates them fully — Stage 1 Sonnet can reject them, Stage 3 Opus can kill them. The override only guarantees they get *considered*, not selected.

Implementation: Store Opening Bell top 10 in a cache/file that the Council reads at pre-filter time. Same mechanism as the existing catalyst override (>5 news articles).

### Bell Icon on Today's Spikes
When a Today's Spikes pick also appeared in that day's Opening Bell top 10:
- Show animated 🔔 icon next to the ticker name in the card header
- Tooltip: "Also an Opening Bell pick"
- Animation: Same ring animation as Opening Bell page header
- Implementation: Simple database query comparing ticker lists when Today's Spikes page renders

## Database Schema

### New Models

**OpeningBellReport** (one per trading day):

| Field | Type | Notes |
|-------|------|-------|
| id | String @id @default(cuid()) | Primary key |
| date | DateTime @db.Date | Unique per day |
| generatedAt | DateTime @default(now()) | When results were ready |
| sectorSnapshot | Json | Full sector performance data |
| tickersScanned | Int | How many tickers evaluated |
| scanDurationMs | Int | Pipeline duration for monitoring |
| picks | OpeningBellPick[] | Relation |
| createdAt | DateTime @default(now()) | |
| updatedAt | DateTime @updatedAt | |

**OpeningBellPick** (10 per report):

| Field | Type | Notes |
|-------|------|-------|
| id | String @id @default(cuid()) | Primary key |
| reportId | String | FK → OpeningBellReport |
| report | OpeningBellReport @relation | |
| rank | Int | 1-10 |
| ticker | String | e.g. "CNQ.TO" |
| name | String | Company name |
| sector | String | |
| exchange | String | TSX / TSXV |
| priceAtScan | Float | Price at time of scan |
| previousClose | Float | Yesterday's close |
| changePercent | Float | % change since close |
| relativeVolume | Float | Today's vol / 20-day avg |
| sectorMomentum | Float | Sector's avg change % |
| momentumScore | Float | Sonnet's 0-100 score |
| intradayTarget | Float | Predicted intraday high |
| keyLevel | Float | Price where thesis breaks |
| conviction | String | "high" / "medium" / "low" |
| rationale | String @db.Text | Sonnet's one-line explanation |
| actualHigh | Float? | Filled after market close |
| actualClose | Float? | Filled after market close |
| targetHit | Boolean? | Did it reach intradayTarget? |
| keyLevelBroken | Boolean? | Did it break below keyLevel? |
| portfolioEntries | PortfolioEntry[] | Relation |
| createdAt | DateTime @default(now()) | |
| updatedAt | DateTime @updatedAt | |

### Modified Models

**PortfolioEntry:**
- `spikeId` becomes optional (String?)
- Add `openingBellPickId` (String?, optional)
- Add relation: `openingBellPick OpeningBellPick? @relation`
- A portfolio entry links to either a Spike or an OpeningBellPick, never both

**User:**
- Add `emailOpeningBell Boolean @default(true)`

## Frontend

### New Page: `/opening-bell`

Mirrors Today's Spikes layout with targeted changes.

**What stays the same:**
- Card structure and grid layout (2-column on XL)
- Score circle (top right, 64px, color-coded: green 80+, amber 60-79, red <60)
- Narrative section ("Why This Stock?" with ⚡ icon)
- Footer (Vol, VWAP, ADX + Lock In button)
- Select for Portfolio bar + bulk selection mode
- Summary stats bar (5 KPIs)
- Market header with macro data
- "Lock In" flow (PortfolioChoiceModal → LockInModal → POST /api/portfolio)

**What changes:**
- Header: "Opening Bell" with animated 🔔, amber accent
- 3/5/8 day prediction row → **Opening Surge** row (Rel. Volume, Sector, Price Move) — same 3-column grid
- Confidence bars → **Target** row (Intraday Target, Key Level, Conviction) — same 3-column grid
- Summary bar KPIs: Tickers Scanned, Total Picks, Avg Score, Top Score, Avg Rel. Volume
- Sector heat strip below summary bar (color-coded pills: green=hot, amber=warm, red=cold)
- Lock In button uses amber gradient instead of cyan
- Supports `?date=YYYY-MM-DD` param for historical viewing (from archives)

**Branding distinction:**
- Opening Bell accent color: amber (#FFB800)
- Today's Spikes accent color: cyan (#00F0FF)

### Navigation

Add to Sidebar navItems between "Today's Spikes" and "Portfolio":
```
{ href: '/opening-bell', label: 'Opening Bell', icon: bell-icon }
```

### Archives Page Restructure (`/reports`)

Two tabs at top of existing page:

- **Today's Spikes** (default) — existing report list, unchanged
- **Opening Bell** — same layout for Opening Bell reports

Tab behavior:
- URL: `/reports?tab=spikes` (default), `/reports?tab=opening-bell`
- Independent pagination per tab
- Active tab styling: cyan underline for Spikes, amber for Opening Bell
- "View" button: Spikes → `/dashboard?date=X`, Opening Bell → `/opening-bell?date=X`
- "XLSX" button: Downloads respective report format

### Opening Bell XLSX Format

Generated via ExcelJS (same approach as Today's Spikes):

```
Rank | Ticker | Name | Exchange | Sector |
Price at Scan | Previous Close | Change % | Rel. Volume |
Momentum Score | Conviction | Intraday Target | Key Level |
Actual High | Actual Close | Target Hit?
```

Dark header row, auto-fit columns, amber header color for brand distinction.

## API Endpoints

### New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/opening-bell` | Fetch today's (or ?date=X) Opening Bell results |
| GET | `/api/opening-bell/[id]` | Single pick detail |
| GET | `/api/reports/opening-bell` | Paginated Opening Bell report list |
| GET | `/api/reports/opening-bell/[id]/xlsx` | XLSX download |
| POST | `/run-opening-bell` (Python) | Trigger Opening Bell pipeline |
| GET | `/run-opening-bell-status` (Python) | Pipeline progress |

### Modified Endpoints

| Endpoint | Change |
|----------|--------|
| `POST /api/portfolio` | Accept `openingBellPickId` as alternative to `spikeId` |
| `GET /api/portfolio` | Include Opening Bell picks in position display |
| `POST /api/accuracy/check` | Also backfill Opening Bell actual data |
| `GET /api/spikes` | Include `isOpeningBellPick` boolean per spike for bell icon |

## Email Notification

### `sendOpeningBellEmail()`

- **Trigger:** Immediately when Opening Bell results are ready (~10:38 AM AST)
- **Recipients:** Users with `emailOpeningBell = true`
- **From:** `no-reply@spiketrades.ca`

**Content:**
- Header: "🔔 Opening Bell — [Date]"
- Subheader: "10 momentum picks detected at 9:35 AM EST"
- Top 3 hot sectors as colored text
- Compact table: Rank, Ticker, Price, Change%, Rel.Vol, Target, Conviction
- CTA: "View Full Analysis →" linking to `/opening-bell`
- Footer: Unsubscribe link to `/settings`

**User settings:**
- New toggle on `/settings` page: "Opening Bell email"
- Default: true (opted in)

## Accuracy Tracking

### Backfill Process

Extends the existing 4:30 PM AST accuracy check cron:

1. Fetch actual intraday high and closing price for each Opening Bell pick
2. Update `OpeningBellPick` with `actualHigh`, `actualClose`, `targetHit`, `keyLevelBroken`

### Metrics Tracked

| Metric | Description |
|--------|-------------|
| Target hit rate | % of picks that reached intraday target |
| Key level hold rate | % of picks that held above key level |
| Conviction accuracy | Hit rate broken down by High/Medium/Low |
| Avg overshoot/undershoot | Distance past or short of targets |
| Sector accuracy | Which sectors produce most reliable signals |

### Data Accumulation

10 picks/day × ~20 trading days/month = ~200 data points/month. Within 2-3 months, sufficient data to calibrate Sonnet's conviction levels and potentially feed accuracy data back into the prompt.

Accuracy data is stored in the database and visible through the admin panel. A dedicated Opening Bell accuracy dashboard is a future iteration.

## Cron Schedule Summary

| Time (AST) | Job | Status |
|-------------|-----|--------|
| 10:35 AM | Opening Bell scan | **New** |
| 10:45 AM | Council daily analysis | Existing (unchanged) |
| 4:30 PM | Accuracy check (Spikes + Opening Bell) | Extended |
| 4:35 PM | SQLite backfill | Existing (unchanged) |
| Every 15 min (9-4) | Portfolio alerts | Existing (unchanged) |

## FMP Endpoints Used

All verified working on FMP Premium plan ($69/mo, 750 req/min):

| Endpoint | Purpose | Verified |
|----------|---------|----------|
| `/stable/batch-quote` | TSX universe quotes | Yes — existing |
| `/stable/sector-performance-snapshot?exchange=TSX` | Sector heat map | Yes — tested 2026-04-03 |
| `/stable/grades?symbol=X` | Analyst upgrades/downgrades | Yes — existing |
| `/stable/historical-chart/5min/{symbol}` | Intraday bars (volume, VWAP) | Partially — already used by Spike It; Canadian stocks may return empty, daily quote fallback required (existing pattern) |

FMP rate limit comment in codebase (`src/lib/api/fmp.ts` line 124) should be corrected from `~300 req/min` to `750 req/min`.

## Admin Panel Updates

The admin panel's Council tab needs to be extended to show Opening Bell status alongside the existing Council monitoring.

### Council Tab Changes

**Opening Bell Status Card (new):**
- Shows alongside existing "Last Run" and "Python Server" cards
- Displays: last Opening Bell run time, duration, pick count, status (Success/Failed/Pending)
- Status indicator: green = ran today, amber = running now, gray = not yet run today

**Opening Bell Stage Indicator (new):**
- Single stage card (vs Council's 6-stage pipeline) labeled "Opening Bell — Sonnet 4.6"
- Shows: status (pending/running/complete), duration, picks generated
- Appears above the Council pipeline stages to reflect execution order

**Manual Trigger Button (new):**
- "Run Opening Bell" button alongside existing "Run Council" button
- Same fire-and-forget pattern, returns immediately
- Disabled while Opening Bell or Council is running

### FMP Health Table Changes

**New endpoints tracked:**
- `/stable/sector-performance-snapshot` — OK/404/429/error counts
- `/stable/historical-chart/5min/{ticker}` — already tracked by Spike It, but Opening Bell usage adds volume

The existing FMP health table (`/fmp-health` endpoint) will automatically pick up Opening Bell's FMP calls if the Python server tracks them with the same `_endpoint_health` dict used by the Council.

### Cost Card Changes

**New cost row for Opening Bell:**
- Add `claude-sonnet-4-6` pricing entry for Opening Bell's single Sonnet call
- Display as separate "Opening Bell" section in cost breakdown
- Token usage tracked in Opening Bell's result metadata (same `input_tokens` / `output_tokens` pattern)

### Opening Bell Accuracy on Analytics Tab

**New section or separate sub-tab:**
- Target hit rate, key level hold rate, conviction accuracy
- Separate from Council accuracy (different metrics — intraday vs 3/5/8 day)
- Uses same color coding: green ≥60%, amber 50-59%, red <50%

## What Does NOT Change

- Council 4-stage pipeline, LLM models, prompts, scoring — untouched
- Council ADV filter stays at $5M
- Council cron schedule stays at 10:45 AM AST
- Today's Spikes page layout — identical except bell icon addition
- Existing portfolio functionality — unchanged, extended
- Existing accuracy tracking — unchanged, extended
- Existing email system — unchanged, new email type added
