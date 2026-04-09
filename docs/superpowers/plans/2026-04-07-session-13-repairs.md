# Session 13 Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five post-Session-12 production bugs: (1) Radar/Opening Bell Archives missing view/download, (2) Radar accuracy displayed in wrong location, (3) EODHD news endpoints invisible in Data Source Health, (4) Admin Analytics 3/5/8d tables showing dashes/low numbers, (5) Today's Spikes learning thresholds reset after destructive Session 10 repair wiped `accuracy_records`.

**Architecture:** Three categories of changes — (a) pure frontend fixes for Bugs 1 and 2, (b) Python scanner instrumentation for Bug 3, (c) one-time data recovery for Bugs 4 and 5 using the Postgres `Spike` table's existing `actual3Day/5Day/8Day` columns (no FMP calls needed). Safeguards are added as deprecation warnings in the old Session 10 repair doc so the destructive DELETE never runs again.

**Tech Stack:** Next.js 15 (App Router) + TypeScript + Tailwind + Prisma + Postgres, Python 3 + FastAPI + SQLite, Docker Compose on DigitalOcean.

---

## Root Cause Summary (verified against production DB on 2026-04-07)

| Bug | Root Cause | Verified |
|---|---|---|
| 1 | `reports/page.tsx:86` reads `json.reports` but API returns `json.data` (Radar tab permanently empty); no XLSX route/button for Radar | ✓ Code grep + API inspection |
| 2 | `/api/accuracy/route.ts:132-162` computes + returns Radar accuracy; `accuracy/page.tsx:55,74,184-223` displays it | ✓ Code read |
| 3 | `eodhd_news.py` uses its own `aiohttp.ClientSession` and never calls the fetcher's `_track_endpoint()`, so EODHD calls are invisible to the Data Source Health dashboard | ✓ Code read |
| 4 | `accuracy_records` table is empty → `LEFT JOIN` returns NULL → all `checked_Nd` = 0 → dashes in Admin/Analytics Daily Accuracy Trend | ✓ SQL query on prod DB |
| 5 | Same — `accuracy_records` is empty → all gate queries return 0 → mechanisms revert to "Waiting" state | ✓ SQL query on prod DB |

**Stale data artifact (not a code bug):** `latest_*_output.json` files show `/news/stock` and `/price-target-consensus` entries because they were last written 2026-04-06 14:07 UTC by pre-Session-11 code. Current production code does NOT call those endpoints. The stale entries disappear automatically when a fresh scan regenerates the files.

---

## File Structure

### Files to CREATE

| Path | Purpose |
|---|---|
| `src/app/api/reports/radar/[id]/xlsx/route.ts` | Radar XLSX download endpoint, mirrors Opening Bell pattern |
| `scripts/recover_accuracy_records.py` | One-time Python script: reads `spike_actuals.json` dump + `pick_history`, writes `accuracy_records` rows |

### Files to MODIFY

| Path | Change |
|---|---|
| `src/app/reports/page.tsx` | Fix `json.reports` → `json.data` key mismatch; add XLSX button to Radar card |
| `src/app/api/accuracy/route.ts` | Remove Radar computation block and `radar` payload |
| `src/app/accuracy/page.tsx` | Remove `radar` state + render block |
| `src/app/api/admin/council/route.ts` | Add `radarAccuracy` Prisma query to parallel fetch, return under `data.radarAccuracy` |
| `src/app/admin/page.tsx` | Add `radarAccuracy` to `CouncilStatus` type; render new Radar Accuracy glass-card directly below Radar Scanner card |
| `eodhd_news.py` | Add optional `endpoint_health: dict` parameter to `fetch_news` and `fetch_news_batch`; populate under key `eodhd/news` |
| `canadian_llm_council_brain.py` | At lines 896, 4436: pass `self.fetcher.endpoint_health` to eodhd_news calls |
| `opening_bell_scanner.py` | At line 134-136: pass `self._endpoint_health` to `eodhd_news.fetch_news_batch` |
| `docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md` | Add `⚠️ DEPRECATED — DO NOT RUN` warning above the destructive DELETE block |

### Files NOT to touch (hard constraints from Session 12)

- `src/components/spikes/SpikeCard.tsx` — reference design, no changes
- `src/app/dashboard/page.tsx` — reference design, no changes
- `src/components/radar/RadarCard.tsx`, `RadarIcon.tsx`, `RadarLockInModal.tsx` — locked
- `src/components/opening-bell/OpeningBellCard.tsx` — locked
- `src/components/portfolio/*.tsx`, `usePortfolios.ts` — locked
- `src/styles/globals.css` — no changes
- Prisma schema — no changes

---

## Task Order

1. **Task 1:** Bug 1a — Fix Radar JSON key mismatch in reports page
2. **Task 2:** Bug 1b — Add XLSX button to Radar card in reports page
3. **Task 3:** Bug 1c — Create Radar XLSX API route
4. **Task 4:** Bug 1d — Smoke test Archives (Spikes, OB, Radar) in dev server
5. **Task 5:** Bug 2a — Add `radarAccuracy` fetch to Admin Council API
6. **Task 6:** Bug 2b — Add Radar Accuracy card to Admin Council tab
7. **Task 7:** Bug 2c — Remove Radar block from public Accuracy Engine API
8. **Task 8:** Bug 2d — Remove Radar render block from public Accuracy Engine page
9. **Task 9:** Bug 3a — Add `endpoint_health` parameter to `eodhd_news.py`
10. **Task 10:** Bug 3b — Wire EODHD tracking into `canadian_llm_council_brain.py`
11. **Task 11:** Bug 3c — Wire EODHD tracking into `opening_bell_scanner.py`
12. **Task 12:** Bug 5a — Add deprecation warning to Session 10 repair doc
13. **Task 13:** Bug 5b — Create recovery script (`scripts/recover_accuracy_records.py`)
14. **Task 14:** Local build + dev server smoke test
15. **Task 15:** Commit + push + deploy to production
16. **Task 16:** Run recovery script on production
17. **Task 17:** Trigger fresh Council + Radar + OB scans to refresh Data Source Health
18. **Task 18:** End-to-end production verification

---

## Task 1: Bug 1a — Fix Radar JSON key mismatch

**Files:**
- Modify: `src/app/reports/page.tsx:85-97`

**Context:** `/api/reports/radar/route.ts:29-35` returns `{ success: true, data: reports, page, pageSize, total }`. The frontend at line 86 checks `if (json.reports)` which is undefined, so `radarReports` stays empty forever. This makes the Radar tab permanently show "No Radar reports yet."

- [ ] **Step 1.1: Read the current fetchReports function**

Already verified at `src/app/reports/page.tsx:72-103`. Current logic:

```tsx
if (activeTab === 'radar') {
  if (json.reports) {
    setRadarReports(json.reports);
    setTotal(json.total);
  }
} else if (json.success) {
  if (activeTab === 'opening-bell') {
    setOpeningBellReports(json.data);
  } else {
    setSpikeReports(json.data);
  }
  setTotal(json.total);
}
```

- [ ] **Step 1.2: Apply the fix**

Use Edit tool on `src/app/reports/page.tsx`:

**old_string:**
```tsx
      if (activeTab === 'radar') {
        if (json.reports) {
          setRadarReports(json.reports);
          setTotal(json.total);
        }
      } else if (json.success) {
        if (activeTab === 'opening-bell') {
          setOpeningBellReports(json.data);
        } else {
          setSpikeReports(json.data);
        }
        setTotal(json.total);
      }
```

**new_string:**
```tsx
      if (json.success) {
        if (activeTab === 'radar') {
          setRadarReports(json.data);
        } else if (activeTab === 'opening-bell') {
          setOpeningBellReports(json.data);
        } else {
          setSpikeReports(json.data);
        }
        setTotal(json.total);
      }
```

- [ ] **Step 1.3: Verify the edit**

Run: `grep -n "setRadarReports" /Users/coeus/spiketrades.ca/claude-code/src/app/reports/page.tsx`

Expected: Exactly one match — the line inside the `if (activeTab === 'radar')` branch.

Run: `grep -n "json.reports" /Users/coeus/spiketrades.ca/claude-code/src/app/reports/page.tsx`

Expected: No matches (the bad key reference is gone).

- [ ] **Step 1.4: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/reports/page.tsx
git commit -m "fix(archives): read json.data instead of json.reports for Radar tab

The Radar archives tab read json.reports which was always undefined
because /api/reports/radar returns { success, data, page, pageSize, total }
— same shape as Spikes and Opening Bell. Unifying the success branch
restores Radar list loading.

Session 13 repair (Bug 1a)"
```

---

## Task 2: Bug 1b — Add XLSX button to Radar card in reports page

**Files:**
- Modify: `src/app/reports/page.tsx:322-329`

**Context:** Spikes cards render `<Link View>` + `<a XLSX>` (lines 197-213). Opening Bell cards render the same pattern (lines 263-279). Radar cards only render `<Link View>` at lines 322-329 with no XLSX button. We add an XLSX anchor matching the OB pattern, pointing to the route we will create in Task 3.

- [ ] **Step 2.1: Read the Radar card render block**

Already verified at `src/app/reports/page.tsx:322-329`:

```tsx
              <Link
                href={`/radar?date=${new Date(report.date).toISOString().split('T')[0]}`}
                className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-green-400 border border-green-400/30 hover:bg-green-400/10 transition-colors"
                title="Open this Radar report"
              >
                View
              </Link>
```

- [ ] **Step 2.2: Wrap Link in a flex container with XLSX anchor**

Use Edit tool on `src/app/reports/page.tsx`:

**old_string:**
```tsx
              <Link
                href={`/radar?date=${new Date(report.date).toISOString().split('T')[0]}`}
                className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-green-400 border border-green-400/30 hover:bg-green-400/10 transition-colors"
                title="Open this Radar report"
              >
                View
              </Link>
```

**new_string:**
```tsx
              <div className="flex items-center gap-3">
                <Link
                  href={`/radar?date=${new Date(report.date).toISOString().split('T')[0]}`}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-green-400 border border-green-400/30 hover:bg-green-400/10 transition-colors"
                  title="Open this Radar report"
                >
                  View
                </Link>
                <a
                  href={`/api/reports/radar/${report.id}/xlsx`}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-spike-green border border-spike-green/30 hover:bg-spike-green/10 transition-colors"
                  title="Download this Radar report as an Excel file"
                  onClick={(e) => e.stopPropagation()}
                >
                  XLSX
                </a>
              </div>
```

- [ ] **Step 2.3: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/reports/page.tsx
git commit -m "feat(archives): add XLSX download button to Radar report cards

Matches the Spikes and Opening Bell card patterns. Button points to
/api/reports/radar/[id]/xlsx which is created in the next commit.

Session 13 repair (Bug 1b)"
```

---

## Task 3: Bug 1c — Create Radar XLSX API route

**Files:**
- Create: `src/app/api/reports/radar/[id]/xlsx/route.ts`

**Context:** `src/app/api/reports/opening-bell/[id]/xlsx/route.ts` exists as the reference pattern. We mirror it exactly but query `radarReport` instead of `openingBellReport` and emit Radar-specific columns.

- [ ] **Step 3.1: Check the RadarPick model fields**

Run: `grep -A 30 "model RadarPick" /Users/coeus/spiketrades.ca/claude-code/prisma/schema.prisma`

Expected: A Prisma model definition. Note the field names — we use these in the XLSX writer.

- [ ] **Step 3.2: Create the directory and write the route file**

Create `src/app/api/reports/radar/[id]/xlsx/route.ts` with Write tool:

```ts
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

  const report = await prisma.radarReport.findUnique({
    where: { id },
    include: {
      picks: { orderBy: { rank: 'asc' } },
    },
  });

  if (!report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  }

  const reportDate = report.date.toISOString().split('T')[0];
  const durationSec = (report.scanDurationMs / 1000).toFixed(1);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Radar Report');

  const colCount = 14;
  const lastCol = String.fromCharCode(64 + colCount); // 'N'

  // Title row — Radar green background
  sheet.mergeCells(`A1:${lastCol}1`);
  const titleCell = sheet.getCell('A1');
  titleCell.value = `Smart Money Radar — ${reportDate}`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF88' } };
  titleCell.alignment = { horizontal: 'center' };

  // Subtitle row
  sheet.mergeCells(`A2:${lastCol}2`);
  const subtitleCell = sheet.getCell('A2');
  subtitleCell.value = `Tickers Scanned: ${report.tickersScanned} | Flagged: ${report.tickersFlagged} | Duration: ${durationSec}s`;
  subtitleCell.font = { size: 11, italic: true };
  subtitleCell.alignment = { horizontal: 'center' };

  // Empty spacer row
  sheet.addRow([]);

  // Headers
  const headers = [
    'Rank', 'Ticker', 'Name', 'Exchange', 'Sector',
    'Price at Scan', 'Smart Money Score',
    'Volume Divergence', 'Institutional Flow',
    'Options Signal', 'Dark Pool Activity',
    'News Catalyst', 'Top Catalyst', 'Narrative',
  ];

  sheet.addRow(headers);
  const hRow = sheet.getRow(4);
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
      pick.smartMoneyScore,
      pick.volumeDivergence ?? '',
      pick.institutionalFlow ?? '',
      pick.optionsSignal ?? '',
      pick.darkPoolActivity ?? '',
      pick.newsCatalyst ?? '',
      pick.topCatalyst ?? '',
      pick.narrative ?? '',
    ]);
  }

  // Auto-fit column widths
  sheet.columns.forEach((col) => {
    let maxLen = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = cell.value ? cell.value.toString().length : 0;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 2, 40);
  });

  const buffer = await workbook.xlsx.writeBuffer();

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="radar-${reportDate}.xlsx"`,
    },
  });
}
```

- [ ] **Step 3.3: Verify field names match the Prisma schema**

Run: `grep -E "volumeDivergence|institutionalFlow|optionsSignal|darkPoolActivity|newsCatalyst|topCatalyst|narrative|smartMoneyScore|priceAtScan" /Users/coeus/spiketrades.ca/claude-code/prisma/schema.prisma`

Expected: All referenced field names exist on the `RadarPick` model. If any do not exist, remove that column from headers AND data rows, AND decrement `colCount` to match. **Do not** leave a header without corresponding data.

- [ ] **Step 3.4: Type-check the file**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx tsc --noEmit 2>&1 | grep -E "radar.*xlsx" || echo "no errors in radar xlsx route"`

Expected: `no errors in radar xlsx route`

If errors appear, fix field names based on the actual Prisma model, then re-run.

- [ ] **Step 3.5: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/api/reports/radar/[id]/xlsx/route.ts
git commit -m "feat(archives): add Radar XLSX download API route

Mirrors the Opening Bell xlsx route pattern. Generates a single-sheet
workbook with rank, ticker, score, and signal breakdown columns.
Required by the XLSX button added to reports/page.tsx in the previous
commit.

Session 13 repair (Bug 1c)"
```

---

## Task 4: Bug 1d — Smoke test Archives in dev server

**Files:** (no code changes — verification only)

- [ ] **Step 4.1: Ensure .claude/launch.json exists with the dev server entry**

Run: `cat /Users/coeus/spiketrades.ca/claude-code/.claude/launch.json 2>/dev/null || echo "MISSING"`

If MISSING, create it with Write tool at `.claude/launch.json`:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "spike-trades-dev",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "port": 3000
    }
  ]
}
```

- [ ] **Step 4.2: Start dev server**

Use `mcp__Claude_Preview__preview_start` with name `spike-trades-dev`.

Expected: Server starts on port 3000. Returns a `serverId`.

- [ ] **Step 4.3: Check dev server logs for compile errors**

Use `mcp__Claude_Preview__preview_logs` with `level: "error"`.

Expected: No TypeScript or build errors.

- [ ] **Step 4.4: Navigate to /reports?tab=radar**

Use `mcp__Claude_Preview__preview_eval` with:

```js
window.location.href = '/reports?tab=radar'
```

Wait 2 seconds, then `mcp__Claude_Preview__preview_snapshot`.

Expected: Radar tab is active, the list area shows either Radar report cards OR the "No Radar reports yet" empty state (depending on whether dev DB has radar reports). It must NOT crash.

- [ ] **Step 4.5: Test the Opening Bell tab**

Navigate: `mcp__Claude_Preview__preview_eval` with `window.location.href = '/reports?tab=opening-bell'`

Snapshot. Expected: Opening Bell cards or empty state. No crash.

- [ ] **Step 4.6: Test the Spikes tab**

Navigate: `mcp__Claude_Preview__preview_eval` with `window.location.href = '/reports?tab=spikes'`

Snapshot. Expected: Spike cards or empty state. No crash.

- [ ] **Step 4.7: Check console for errors**

`mcp__Claude_Preview__preview_console_logs` with `level: "error"`.

Expected: No React errors, no 500 responses, no TypeScript runtime errors.

---

## Task 5: Bug 2a — Add `radarAccuracy` fetch to Admin Council API

**Files:**
- Modify: `src/app/api/admin/council/route.ts`

**Context:** The Admin Council API currently fetches health data via `Promise.all`. We add a Prisma query that computes Radar accuracy (the same computation as `/api/accuracy/route.ts:132-162`) and returns it under `data.radarAccuracy`. This moves the computation to the admin side while keeping the DB columns populated by the 4:30 PM cron.

- [ ] **Step 5.1: Read the current Council route**

Already verified at `src/app/api/admin/council/route.ts:30-124`.

- [ ] **Step 5.2: Add the radarAccuracy Prisma query to the Promise.all**

Use Edit tool on `src/app/api/admin/council/route.ts`:

**old_string:**
```ts
      // Prisma: latest council log
      prisma.councilLog.findFirst({
        orderBy: { date: 'desc' },
        select: { processingTime: true, consensusScore: true, date: true },
      }),
    ]);
```

**new_string:**
```ts
      // Prisma: latest council log
      prisma.councilLog.findFirst({
        orderBy: { date: 'desc' },
        select: { processingTime: true, consensusScore: true, date: true },
      }),
      // Prisma: Radar accuracy (last 90 days)
      prisma.radarPick.findMany({
        where: {
          actualOpenPrice: { not: null },
          report: { date: { gte: new Date(Date.now() - 90 * 86400000) } },
        },
        select: {
          actualOpenChangePct: true,
          openMoveCorrect: true,
          passedOpeningBell: true,
          passedSpikes: true,
        },
      }),
    ]);
```

- [ ] **Step 5.3: Update the destructuring to receive the new array**

**old_string:**
```ts
    const [
      councilHealthResult,
      fmpHealthResult,
      runStatusResult,
      latestOutputResult,
      openingBellStatusResult,
      openingBellHealthResult,
      radarStatusResult,
      radarHealthResult,
      recentReports,
      latestLog,
    ] = await Promise.all([
```

**new_string:**
```ts
    const [
      councilHealthResult,
      fmpHealthResult,
      runStatusResult,
      latestOutputResult,
      openingBellStatusResult,
      openingBellHealthResult,
      radarStatusResult,
      radarHealthResult,
      recentReports,
      latestLog,
      radarAccuracyPicks,
    ] = await Promise.all([
```

- [ ] **Step 5.4: Compute radarAccuracy from the raw picks and add it to the response payload**

**old_string:**
```ts
    const councilHealth = councilHealthResult ?? { status: 'unreachable', council_running: false };
    const fmpHealth = fmpHealthResult?.success ? fmpHealthResult : null;
    const latestStageMetadata = latestOutputResult?.stage_metadata ?? null;
    const openingBellStatus = openingBellStatusResult ?? null;
    const openingBellHealth = openingBellHealthResult ?? null;
    const radarStatus = radarStatusResult ?? null;
    const radarHealth = radarHealthResult ?? null;
```

**new_string:**
```ts
    const councilHealth = councilHealthResult ?? { status: 'unreachable', council_running: false };
    const fmpHealth = fmpHealthResult?.success ? fmpHealthResult : null;
    const latestStageMetadata = latestOutputResult?.stage_metadata ?? null;
    const openingBellStatus = openingBellStatusResult ?? null;
    const openingBellHealth = openingBellHealthResult ?? null;
    const radarStatus = radarStatusResult ?? null;
    const radarHealth = radarHealthResult ?? null;

    // Compute Radar accuracy from resolved picks
    const radarTotal = radarAccuracyPicks.length;
    const radarCorrect = radarAccuracyPicks.filter((p) => p.openMoveCorrect).length;
    const radarHitRate = radarTotal > 0 ? (radarCorrect / radarTotal) * 100 : null;
    const radarAvgOpenMove = radarTotal > 0
      ? radarAccuracyPicks.reduce((s, p) => s + (p.actualOpenChangePct || 0), 0) / radarTotal
      : null;
    const radarPassedOB = radarAccuracyPicks.filter((p) => p.passedOpeningBell).length;
    const radarPassedSpikes = radarAccuracyPicks.filter((p) => p.passedSpikes).length;
    const radarAccuracy = radarTotal > 0 ? {
      total: radarTotal,
      correct: radarCorrect,
      hitRate: radarHitRate != null ? Math.round(radarHitRate * 10) / 10 : null,
      avgOpenMove: radarAvgOpenMove != null ? Math.round(radarAvgOpenMove * 100) / 100 : null,
      passedOpeningBell: radarPassedOB,
      passedSpikes: radarPassedSpikes,
    } : null;
```

- [ ] **Step 5.5: Add `radarAccuracy` to the returned JSON**

**old_string:**
```ts
        radarStatus,
        radarHealth: radarHealth?.success ? radarHealth : null,
        recentReports: recentReports.map((r) => ({
```

**new_string:**
```ts
        radarStatus,
        radarHealth: radarHealth?.success ? radarHealth : null,
        radarAccuracy,
        recentReports: recentReports.map((r) => ({
```

- [ ] **Step 5.6: Type-check**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx tsc --noEmit 2>&1 | grep -E "council/route" || echo "ok"`

Expected: `ok`

- [ ] **Step 5.7: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/api/admin/council/route.ts
git commit -m "feat(admin): add radarAccuracy to Council API response

Computes Radar open-direction hit rate, average open move, and
pipeline passthrough counts over the last 90 days from resolved
RadarPick rows. Returned under data.radarAccuracy for the new
Radar Accuracy card on the Admin Council tab.

Session 13 repair (Bug 2a)"
```

---

## Task 6: Bug 2b — Add Radar Accuracy card to Admin Council tab

**Files:**
- Modify: `src/app/admin/page.tsx` (type definition + Council tab render block)

**Context:** The CouncilStatus TypeScript interface lives around line 76-97. The Radar Scanner card is at lines 606-656. We insert the new Radar Accuracy card directly after the Radar Scanner closing brace, before the Opening Bell section.

- [ ] **Step 6.1: Add `radarAccuracy` to the CouncilStatus type**

Use Edit tool on `src/app/admin/page.tsx`:

**old_string:**
```tsx
  radarStatus?: { running?: boolean; picks_count?: number; last_run_time?: number; last_error?: string; status?: string } | null;
  radarHealth?: { endpoints?: Record<string, Record<string, number>> } | null;
}
```

**new_string:**
```tsx
  radarStatus?: { running?: boolean; picks_count?: number; last_run_time?: number; last_error?: string; status?: string } | null;
  radarHealth?: { endpoints?: Record<string, Record<string, number>> } | null;
  radarAccuracy?: {
    total: number;
    correct: number;
    hitRate: number | null;
    avgOpenMove: number | null;
    passedOpeningBell: number;
    passedSpikes: number;
  } | null;
}
```

- [ ] **Step 6.2: Insert the Radar Accuracy card between Radar Scanner and Opening Bell**

The Radar Scanner IIFE ends at approximately line 656 (closing `})()` followed by the next block `{/* 3. Opening Bell ... */}`). Use Edit tool:

**old_string:**
```tsx
            {/* 3. Opening Bell (second in pipeline sequence) */}
```

**new_string:**
```tsx
            {/* 2b. Radar Accuracy (moved from public Accuracy Engine in Session 13) */}
            {council?.radarAccuracy && council.radarAccuracy.total > 0 && (
              <div className="glass-card p-5 border border-green-400/20">
                <div className="flex items-center gap-2 mb-4">
                  <span className="w-3 h-3 rounded-full bg-green-400" />
                  <span className="text-xs font-bold text-green-400 uppercase tracking-wider">
                    Radar Accuracy — Pre-Market Signal
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                  <div>
                    <p className={cn(
                      'text-2xl font-bold mono',
                      (council.radarAccuracy.hitRate ?? 0) >= 55 ? 'text-spike-green'
                        : (council.radarAccuracy.hitRate ?? 0) >= 50 ? 'text-spike-amber'
                        : 'text-spike-red'
                    )}>
                      {council.radarAccuracy.hitRate != null ? `${council.radarAccuracy.hitRate.toFixed(1)}%` : '—'}
                    </p>
                    <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Open Direction Hit Rate</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold mono text-spike-text">
                      {council.radarAccuracy.correct}/{council.radarAccuracy.total}
                    </p>
                    <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Correct / Total</p>
                  </div>
                  <div>
                    <p className={cn(
                      'text-2xl font-bold mono',
                      (council.radarAccuracy.avgOpenMove ?? 0) >= 0 ? 'text-spike-green' : 'text-spike-red'
                    )}>
                      {council.radarAccuracy.avgOpenMove != null
                        ? `${(council.radarAccuracy.avgOpenMove >= 0 ? '+' : '')}${council.radarAccuracy.avgOpenMove.toFixed(2)}%`
                        : '—'}
                    </p>
                    <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Avg Open Move</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold mono text-spike-text">
                      {council.radarAccuracy.passedSpikes}/{council.radarAccuracy.total}
                    </p>
                    <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Made Final Spikes</p>
                  </div>
                </div>
              </div>
            )}

            {/* 3. Opening Bell (second in pipeline sequence) */}
```

- [ ] **Step 6.3: Type-check**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx tsc --noEmit 2>&1 | grep -E "admin/page" || echo "ok"`

Expected: `ok`

- [ ] **Step 6.4: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/admin/page.tsx
git commit -m "feat(admin): add Radar Accuracy card below Radar Scanner status

Displays Open Direction Hit Rate, Correct/Total, Avg Open Move, and
Made Final Spikes — same metrics previously shown on public Accuracy
Engine but scoped to the admin panel where they belong. The card
renders only when data.radarAccuracy.total > 0 so it stays hidden
until real resolved data exists.

Session 13 repair (Bug 2b)"
```

---

## Task 7: Bug 2c — Remove Radar block from public Accuracy Engine API

**Files:**
- Modify: `src/app/api/accuracy/route.ts`

**Context:** Lines 132-162 compute Radar accuracy and lines 174-182 return it under `data.radar`. We remove both. The backfill that writes to `RadarPick.actualOpenPrice` etc. is left running (you approved this earlier).

- [ ] **Step 7.1: Remove the Radar computation block**

Use Edit tool on `src/app/api/accuracy/route.ts`:

**old_string:**
```ts
    // 5. Radar accuracy
    const radarPicks = await prisma.radarPick.findMany({
      where: {
        actualOpenPrice: { not: null },
        report: { date: { gte: cutoff } },
      },
      select: {
        ticker: true,
        smartMoneyScore: true,
        priceAtScan: true,
        actualOpenPrice: true,
        actualOpenChangePct: true,
        actualDayHigh: true,
        actualDayClose: true,
        openMoveCorrect: true,
        passedOpeningBell: true,
        passedSpikes: true,
        report: { select: { date: true } },
      },
      orderBy: { report: { date: 'desc' } },
    });

    const radarTotal = radarPicks.length;
    const radarCorrect = radarPicks.filter(p => p.openMoveCorrect).length;
    const radarHitRate = radarTotal > 0 ? (radarCorrect / radarTotal) * 100 : null;
    const radarAvgOpenMove = radarTotal > 0
      ? radarPicks.reduce((s, p) => s + (p.actualOpenChangePct || 0), 0) / radarTotal
      : null;
    const radarPassedOB = radarPicks.filter(p => p.passedOpeningBell).length;
    const radarPassedSpikes = radarPicks.filter(p => p.passedSpikes).length;

    return NextResponse.json({
      success: true,
      data: {
        candlestickData,
        scorecards,
        recentPicks: allSpikes,
        indexValues: {
          day3: Math.round(index3 * 100) / 100,
          day5: Math.round(index5 * 100) / 100,
          day8: Math.round(index8 * 100) / 100,
        },
        radar: {
          total: radarTotal,
          correct: radarCorrect,
          hitRate: radarHitRate != null ? Math.round(radarHitRate * 10) / 10 : null,
          avgOpenMove: radarAvgOpenMove != null ? Math.round(radarAvgOpenMove * 100) / 100 : null,
          passedOpeningBell: radarPassedOB,
          passedSpikes: radarPassedSpikes,
          recentPicks: radarPicks.slice(0, 20),
        },
      },
    });
```

**new_string:**
```ts
    return NextResponse.json({
      success: true,
      data: {
        candlestickData,
        scorecards,
        recentPicks: allSpikes,
        indexValues: {
          day3: Math.round(index3 * 100) / 100,
          day5: Math.round(index5 * 100) / 100,
          day8: Math.round(index8 * 100) / 100,
        },
      },
    });
```

- [ ] **Step 7.2: Verify no orphan references remain**

Run: `grep -n "radar" /Users/coeus/spiketrades.ca/claude-code/src/app/api/accuracy/route.ts`

Expected: Zero matches (case-insensitive: run with `-i` if needed).

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx tsc --noEmit 2>&1 | grep -E "api/accuracy" || echo "ok"`

Expected: `ok`

- [ ] **Step 7.3: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/api/accuracy/route.ts
git commit -m "refactor(accuracy): remove Radar block from public Accuracy Engine API

Radar is a pre-scan ranking tool, not a prediction — measuring it as
win/loss is a category error. Moving the display to the Admin Council
tab where it belongs. DB columns (actualOpenPrice, openMoveCorrect,
passedOpeningBell, passedSpikes) remain populated by the backfill job,
so nothing is lost — just no longer surfaced publicly.

Session 13 repair (Bug 2c)"
```

---

## Task 8: Bug 2d — Remove Radar render block from public Accuracy Engine page

**Files:**
- Modify: `src/app/accuracy/page.tsx`

**Context:** Lines 55 declares the `radar` state, line 74 populates it, lines 184-223 render the card. All three must go.

- [ ] **Step 8.1: Remove the `radar` state declaration**

Use Edit tool on `src/app/accuracy/page.tsx`:

**old_string:**
```tsx
  const [scorecards, setScorecards] = useState<Scorecard[]>([]);
  const [recentPicks, setRecentPicks] = useState<RecentPick[]>([]);
  const [indexValues, setIndexValues] = useState<IndexValues>({ day3: 100, day5: 100, day8: 100 });
  const [radar, setRadar] = useState<{ total: number; correct: number; hitRate: number | null; avgOpenMove: number | null; passedOpeningBell: number; passedSpikes: number } | null>(null);
  const [loading, setLoading] = useState(true);
```

**new_string:**
```tsx
  const [scorecards, setScorecards] = useState<Scorecard[]>([]);
  const [recentPicks, setRecentPicks] = useState<RecentPick[]>([]);
  const [indexValues, setIndexValues] = useState<IndexValues>({ day3: 100, day5: 100, day8: 100 });
  const [loading, setLoading] = useState(true);
```

- [ ] **Step 8.2: Remove the `setRadar` call inside fetchAccuracy**

**old_string:**
```tsx
      if (json.success) {
        setScorecards(json.data.scorecards || []);
        setRecentPicks(json.data.recentPicks || []);
        setIndexValues(json.data.indexValues || { day3: 100, day5: 100, day8: 100 });
        if (json.data.radar) setRadar(json.data.radar);
      }
```

**new_string:**
```tsx
      if (json.success) {
        setScorecards(json.data.scorecards || []);
        setRecentPicks(json.data.recentPicks || []);
        setIndexValues(json.data.indexValues || { day3: 100, day5: 100, day8: 100 });
      }
```

- [ ] **Step 8.3: Remove the Radar scorecard render block**

**old_string:**
```tsx
        {/* ============================================================ */}
        {/* Radar Accuracy Scorecard */}
        {/* ============================================================ */}
        {radar && radar.total > 0 && (
          <div className="glass-card p-5 mb-6 border border-green-400/20">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-3 h-3 rounded-full bg-green-400" />
              <span className="text-sm font-bold text-green-400 uppercase tracking-wider">Radar — Pre-Market Signal Accuracy</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              <div>
                <p className={cn(
                  'text-2xl font-bold mono',
                  (radar.hitRate || 0) >= 55 ? 'text-spike-green' : (radar.hitRate || 0) >= 50 ? 'text-spike-amber' : 'text-spike-red'
                )}>
                  {radar.hitRate?.toFixed(1)}%
                </p>
                <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Open Direction Hit Rate</p>
              </div>
              <div>
                <p className="text-2xl font-bold mono text-spike-text">
                  {radar.correct}/{radar.total}
                </p>
                <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Correct / Total</p>
              </div>
              <div>
                <p className={cn(
                  'text-2xl font-bold mono',
                  (radar.avgOpenMove || 0) >= 0 ? 'text-spike-green' : 'text-spike-red'
                )}>
                  {(radar.avgOpenMove || 0) >= 0 ? '+' : ''}{radar.avgOpenMove?.toFixed(2)}%
                </p>
                <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Avg Open Move</p>
              </div>
              <div>
                <p className="text-2xl font-bold mono text-spike-text">
                  {radar.passedSpikes}/{radar.total}
                </p>
                <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Made Final Spikes</p>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* Pick Results Table — Winners first, paginated */}
        {/* ============================================================ */}
```

**new_string:**
```tsx
        {/* ============================================================ */}
        {/* Pick Results Table — Winners first, paginated */}
        {/* ============================================================ */}
```

- [ ] **Step 8.4: Verify no orphan references**

Run: `grep -n "radar\|setRadar" /Users/coeus/spiketrades.ca/claude-code/src/app/accuracy/page.tsx`

Expected: Zero matches.

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx tsc --noEmit 2>&1 | grep -E "accuracy/page" || echo "ok"`

Expected: `ok`

- [ ] **Step 8.5: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add src/app/accuracy/page.tsx
git commit -m "refactor(accuracy): remove Radar display from public Accuracy Engine

Moved to Admin Council tab. See previous commit for API change.

Session 13 repair (Bug 2d)"
```

---

## Task 9: Bug 3a — Add `endpoint_health` parameter to `eodhd_news.py`

**Files:**
- Modify: `eodhd_news.py`

**Context:** The module uses its own `aiohttp.ClientSession` and never reports endpoint health. We add an optional `endpoint_health` dict parameter to both public functions. When provided, calls bump counters under key `eodhd/news`. This matches the shape used by the FMP fetcher's `_track_endpoint()` so the admin frontend displays it without changes.

- [ ] **Step 9.1: Read the current file**

Run: `cat /Users/coeus/spiketrades.ca/claude-code/eodhd_news.py`

Note: The file is 2705 bytes, roughly 70-90 lines. It defines at least `fetch_news(ticker, limit, api_key)` and `fetch_news_batch(tickers, limit, api_key)` and `get_sentiment_score(news_data)`.

- [ ] **Step 9.2: Apply the tracking modification**

Use Edit tool. Based on what's at lines 14-50 (already read earlier), apply these edits in sequence:

**Edit 1 — add helper near top of module, after imports but before `fetch_news`:**

**old_string:**
```python
EODHD_BASE = "https://eodhd.com/api/news"


async def fetch_news(
    ticker: str, limit: int = 10, api_key: str | None = None
) -> list[dict]:
```

**new_string:**
```python
EODHD_BASE = "https://eodhd.com/api/news"
EODHD_HEALTH_KEY = "eodhd/news"


def _track(endpoint_health: dict | None, status: str) -> None:
    """Increment the eodhd/news counter in a fetcher-style endpoint_health dict.
    No-op when endpoint_health is None."""
    if endpoint_health is None:
        return
    if EODHD_HEALTH_KEY not in endpoint_health:
        endpoint_health[EODHD_HEALTH_KEY] = {"ok": 0, "404": 0, "429": 0, "error": 0}
    bucket = endpoint_health[EODHD_HEALTH_KEY]
    bucket[status] = bucket.get(status, 0) + 1


async def fetch_news(
    ticker: str,
    limit: int = 10,
    api_key: str | None = None,
    endpoint_health: dict | None = None,
) -> list[dict]:
```

**Edit 2 — instrument the fetch_news network block:**

Read lines 23-50 of the current `fetch_news` body (shown above in Step 9.1), then replace only the try/except block to increment on each outcome.

**old_string:**
```python
    key = api_key or os.environ.get("EODHD_API_KEY", "")
    if not key:
        logger.warning("EODHD_API_KEY not set, skipping news fetch")
        return []

    url = f"{EODHD_BASE}?s={ticker}&limit={limit}&api_token={key}&fmt=json"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    logger.warning(f"EODHD news for {ticker} returned {resp.status}")
                    return []
                data = await resp.json(content_type=None)
    except Exception as e:
        logger.warning(f"EODHD news fetch failed for {ticker}: {e}")
        return []
```

**new_string:**
```python
    key = api_key or os.environ.get("EODHD_API_KEY", "")
    if not key:
        logger.warning("EODHD_API_KEY not set, skipping news fetch")
        return []

    url = f"{EODHD_BASE}?s={ticker}&limit={limit}&api_token={key}&fmt=json"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    _track(endpoint_health, "ok")
                elif resp.status == 404:
                    _track(endpoint_health, "404")
                    return []
                elif resp.status == 429:
                    _track(endpoint_health, "429")
                    logger.warning(f"EODHD news for {ticker} returned 429")
                    return []
                else:
                    _track(endpoint_health, "error")
                    logger.warning(f"EODHD news for {ticker} returned {resp.status}")
                    return []
                data = await resp.json(content_type=None)
    except Exception as e:
        _track(endpoint_health, "error")
        logger.warning(f"EODHD news fetch failed for {ticker}: {e}")
        return []
```

**Edit 3 — add the parameter to `fetch_news_batch` and pass it through:**

Run first: `grep -n "def fetch_news_batch" /Users/coeus/spiketrades.ca/claude-code/eodhd_news.py`

Note the line number and read that section to get the exact signature and body. Then edit:

The pattern to transform is:

```python
async def fetch_news_batch(
    tickers: list[str], limit: int = 5, api_key: str | None = None
) -> dict[str, list[dict]]:
```

into:

```python
async def fetch_news_batch(
    tickers: list[str],
    limit: int = 5,
    api_key: str | None = None,
    endpoint_health: dict | None = None,
) -> dict[str, list[dict]]:
```

And wherever inside the batch function `fetch_news(...)` is called, propagate `endpoint_health=endpoint_health` as a kwarg. If the batch function uses `asyncio.gather([fetch_news(t, limit, api_key) for t in tickers])`, change to `asyncio.gather([fetch_news(t, limit, api_key, endpoint_health=endpoint_health) for t in tickers])`.

Use the Edit tool on the exact body you read. Do NOT guess — read first.

- [ ] **Step 9.3: Verify the module still imports**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "import eodhd_news; print(eodhd_news.EODHD_HEALTH_KEY)"`

Expected: `eodhd/news`

If it fails, read the error and fix the Python syntax before continuing.

- [ ] **Step 9.4: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add eodhd_news.py
git commit -m "feat(eodhd): accept optional endpoint_health tracking dict

Adds an optional endpoint_health parameter to fetch_news and
fetch_news_batch. When provided, each call increments ok/404/429/error
counters under key 'eodhd/news' — same shape as the FMP fetcher's
_track_endpoint. This makes EODHD calls visible in the admin Data
Source Health dashboard once scanners pass their tracking dicts in.

Session 13 repair (Bug 3a)"
```

---

## Task 10: Bug 3b — Wire EODHD tracking into `canadian_llm_council_brain.py`

**Files:**
- Modify: `canadian_llm_council_brain.py` (two call sites: lines 896 and 4436)

**Context:** Line 896 is inside a council-brain function that has a `fetcher` instance available. Line 4436 is inside `RadarScanner.run()` which has `self.fetcher` available (line 4319 initializes `self.endpoint_health: dict[str, dict] = {}` but the fetcher instance has its own). We pass the fetcher's endpoint_health dict so EODHD calls land in the same place as FMP calls.

- [ ] **Step 10.1: Read the line 896 context**

Run: `sed -n '885,905p' /Users/coeus/spiketrades.ca/claude-code/canadian_llm_council_brain.py`

Note the surrounding code so the edit is uniquely identifiable. The current snippet is:

```python
        # Fetch news + sentiment from EODHD
        news_data = await eodhd_news.fetch_news(ticker, limit=5)
        sentiment = eodhd_news.get_sentiment_score(news_data) if news_data else 0.0
```

- [ ] **Step 10.2: Determine the fetcher reference available at line 896**

Run: `sed -n '850,900p' /Users/coeus/spiketrades.ca/claude-code/canadian_llm_council_brain.py`

Look for the enclosing function signature (`async def ...`). It will have either `fetcher: LiveDataFetcher` as a parameter or `self.fetcher`. Record which one.

- [ ] **Step 10.3: Apply the edit to line 896 call site**

If the function takes `fetcher` as a parameter:

**old_string:**
```python
        # Fetch news + sentiment from EODHD
        news_data = await eodhd_news.fetch_news(ticker, limit=5)
```

**new_string:**
```python
        # Fetch news + sentiment from EODHD
        news_data = await eodhd_news.fetch_news(ticker, limit=5, endpoint_health=fetcher.endpoint_health)
```

If the function uses `self.fetcher`:

**old_string:**
```python
        # Fetch news + sentiment from EODHD
        news_data = await eodhd_news.fetch_news(ticker, limit=5)
```

**new_string:**
```python
        # Fetch news + sentiment from EODHD
        news_data = await eodhd_news.fetch_news(ticker, limit=5, endpoint_health=self.fetcher.endpoint_health)
```

- [ ] **Step 10.4: Read the line 4436 context inside RadarScanner**

Run: `sed -n '4425,4445p' /Users/coeus/spiketrades.ca/claude-code/canadian_llm_council_brain.py`

Expected: A line like `data = await eodhd_news.fetch_news(t, limit=10)` inside a function on a `RadarScanner` instance.

- [ ] **Step 10.5: Determine the correct endpoint_health reference inside RadarScanner**

Run: `sed -n '4225,4330p' /Users/coeus/spiketrades.ca/claude-code/canadian_llm_council_brain.py`

Look for where `RadarScanner` initializes its fetcher. At line 4319 we already saw `self.endpoint_health: dict[str, dict] = {}`. Check if this is the same dict that's surfaced in the output file (`endpoint_health=self.fetcher.endpoint_health` at line 4387). We want the dict that ends up in the output JSON — that is `self.fetcher.endpoint_health`.

- [ ] **Step 10.6: Apply the edit to line 4436**

**old_string:**
```python
                data = await eodhd_news.fetch_news(t, limit=10)
```

**new_string:**
```python
                data = await eodhd_news.fetch_news(t, limit=10, endpoint_health=self.fetcher.endpoint_health)
```

- [ ] **Step 10.7: Verify the file still imports**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "import canadian_llm_council_brain; print('ok')"`

Expected: `ok` (may print some setup warnings; ignore non-errors)

- [ ] **Step 10.8: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add canadian_llm_council_brain.py
git commit -m "feat(council): pass endpoint_health to EODHD news calls

Council brain and RadarScanner now pass the fetcher's endpoint_health
dict to eodhd_news.fetch_news so EODHD calls are tracked alongside FMP
calls in the admin Data Source Health dashboard.

Session 13 repair (Bug 3b)"
```

---

## Task 11: Bug 3c — Wire EODHD tracking into `opening_bell_scanner.py`

**Files:**
- Modify: `opening_bell_scanner.py` (line ~134-136)

**Context:** `opening_bell_scanner.py:134-136` calls `eodhd_news.fetch_news_batch(tickers, limit=5, api_key=...)` inside a method on a scanner instance that has `self._endpoint_health`.

- [ ] **Step 11.1: Read the current call site**

Run: `sed -n '130,142p' /Users/coeus/spiketrades.ca/claude-code/opening_bell_scanner.py`

Current code:

```python
    async def fetch_news_bulk(self, session: aiohttp.ClientSession, tickers: list[str]) -> dict[str, list[dict]]:
        """Fetch news batch for a list of tickers via EODHD."""
        return await eodhd_news.fetch_news_batch(tickers, limit=5, api_key=os.environ.get("EODHD_API_KEY", ""))
```

- [ ] **Step 11.2: Apply the edit**

Use Edit tool on `opening_bell_scanner.py`:

**old_string:**
```python
    async def fetch_news_bulk(self, session: aiohttp.ClientSession, tickers: list[str]) -> dict[str, list[dict]]:
        """Fetch news batch for a list of tickers via EODHD."""
        return await eodhd_news.fetch_news_batch(tickers, limit=5, api_key=os.environ.get("EODHD_API_KEY", ""))
```

**new_string:**
```python
    async def fetch_news_bulk(self, session: aiohttp.ClientSession, tickers: list[str]) -> dict[str, list[dict]]:
        """Fetch news batch for a list of tickers via EODHD.
        Tracks calls under 'eodhd/news' in self._endpoint_health."""
        return await eodhd_news.fetch_news_batch(
            tickers,
            limit=5,
            api_key=os.environ.get("EODHD_API_KEY", ""),
            endpoint_health=self._endpoint_health,
        )
```

- [ ] **Step 11.3: Verify the file still imports**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && python3 -c "import opening_bell_scanner; print('ok')"`

Expected: `ok`

- [ ] **Step 11.4: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add opening_bell_scanner.py
git commit -m "feat(opening-bell): pass endpoint_health to EODHD news calls

Opening Bell scanner now passes its _endpoint_health dict to
eodhd_news.fetch_news_batch so EODHD calls appear in Data Source
Health alongside FMP calls after the next scan.

Session 13 repair (Bug 3c)"
```

---

## Task 12: Bug 5a — Add deprecation warning to Session 10 repair doc

**Files:**
- Modify: `docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md`

**Context:** Line 134 of this doc contains `cur.execute("DELETE FROM accuracy_records")` which was the unconditional DELETE that destroyed training data. We add a prominent warning block directly above it so anyone reading this doc in the future sees the warning before the offending code.

- [ ] **Step 12.1: Apply the warning block**

Use Edit tool on `docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md`:

**old_string:**
```markdown
# Reset calibration tables (will rebuild from clean data on next run)
cur.execute("DELETE FROM calibration_base_rates")
cur.execute("DELETE FROM calibration_council")
cur.execute("DELETE FROM accuracy_records")

conn.commit()
conn.close()
```

**new_string:**
```markdown
# Reset calibration tables (will rebuild from clean data on next run)
cur.execute("DELETE FROM calibration_base_rates")
cur.execute("DELETE FROM calibration_council")

# ⚠️ DEPRECATED — DO NOT RUN (Session 13, 2026-04-07)
# The line below was unconditional and destroyed the entire accuracy_records
# table (>510 rows). This wiped all Today's Spikes learning training data,
# which caused every learning gate (conviction, stage weights, prompt context,
# factor feedback, pre-filter) to revert to hardcoded defaults and broke the
# Admin Analytics 3/5/8-day hit rate tables. Session 13 recovered the data
# from the Prisma Spike table's actual3Day/5Day/8Day columns. Never run a bare
# DELETE on accuracy_records again — if you need to prune, use a WHERE clause
# keyed on pick_id or run_date.
#
# cur.execute("DELETE FROM accuracy_records")  # ← DO NOT UNCOMMENT

conn.commit()
conn.close()
```

- [ ] **Step 12.2: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md
git commit -m "docs(session-10): deprecate destructive DELETE FROM accuracy_records

Adds a prominent warning above the line that wiped all Today's Spikes
learning training data in early April 2026. Preserves the audit trail
while making it impossible to run unintentionally.

Session 13 repair (Bug 5a)"
```

---

## Task 13: Bug 5b — Create recovery script

**Files:**
- Create: `scripts/recover_accuracy_records.py`

**Context:** One-time script that reads a JSON dump of `Spike` + `DailyReport` rows from Postgres and writes matching `accuracy_records` rows to the council SQLite DB. No FMP calls. We run it once on production in Task 16.

- [ ] **Step 13.1: Verify scripts directory exists**

Run: `ls /Users/coeus/spiketrades.ca/claude-code/scripts/`

Expected: `deploy.sh`, `start-cron.ts`. Directory exists.

- [ ] **Step 13.2: Create the recovery script**

Use Write tool to create `scripts/recover_accuracy_records.py`:

```python
"""One-time recovery script for accuracy_records table.

Rebuilds the Today's Spikes learning system's accuracy_records table from the
Prisma (Postgres) Spike table's actual3Day/5Day/8Day columns, after Session 10's
destructive DELETE wiped the entire table on 2026-04-06.

Reads:
  - /tmp/spike_actuals.json  (dumped from Postgres — see scripts/dump_spike_actuals.sh)
  - /app/data/spike_trades_council.db  (SQLite council DB)

Writes:
  - accuracy_records rows (INSERT OR IGNORE, safe to re-run)

Zero FMP calls. Zero writes to pick_history or stage_scores.
Matching key: (ticker, run_date) where run_date is YYYY-MM-DD.

Expected outcome (prod DB as of 2026-04-07):
  - Inserts ~333 placeholder+resolved rows (111 matched picks × 3 horizons)
  - ~189 of those have accurate set (83 × 3d + 66 × 5d + 40 × 8d)
  - Learning gates 1/2/4/6 flip to 'Active' after run

Usage (run inside council container):
  python3 /app/scripts/recover_accuracy_records.py /tmp/spike_actuals.json
"""

import json
import sqlite3
import sys
from pathlib import Path

DB_PATH = "/app/data/spike_trades_council.db"


def main(dump_path: str) -> int:
    dump_file = Path(dump_path)
    if not dump_file.exists():
        print(f"ERROR: dump file not found at {dump_path}", file=sys.stderr)
        return 1

    with dump_file.open() as f:
        dump = json.load(f)

    if not isinstance(dump, list):
        print("ERROR: dump must be a JSON array of {run_date, ticker, actual3Day, ...} objects", file=sys.stderr)
        return 1

    # Build (ticker, run_date) → row index for fast lookup
    index: dict[tuple[str, str], dict] = {}
    for row in dump:
        key = (row["ticker"], row["run_date"])
        index[key] = row

    print(f"Loaded {len(dump)} Prisma Spike rows from {dump_path}")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    before_total = conn.execute("SELECT COUNT(*) FROM accuracy_records").fetchone()[0]
    before_resolved = conn.execute(
        "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
    ).fetchone()[0]

    pick_rows = conn.execute(
        """
        SELECT id, ticker, run_date, entry_price, predicted_direction,
               forecast_3d_move_pct, forecast_3d_direction,
               forecast_5d_move_pct, forecast_5d_direction,
               forecast_8d_move_pct, forecast_8d_direction
        FROM pick_history
        WHERE forecast_3d_move_pct IS NOT NULL
        """
    ).fetchall()

    print(f"Found {len(pick_rows)} pick_history rows with forecasts")

    matched = 0
    placeholder = 0
    resolved = 0

    try:
        for pick in pick_rows:
            pick_id = pick["id"]
            ticker = pick["ticker"]
            run_date = pick["run_date"]
            entry_price = pick["entry_price"]

            spike = index.get((ticker, run_date))
            if spike is not None:
                matched += 1

            for horizon, move_col, dir_col, actual_key in [
                (3, "forecast_3d_move_pct", "forecast_3d_direction", "actual3Day"),
                (5, "forecast_5d_move_pct", "forecast_5d_direction", "actual5Day"),
                (8, "forecast_8d_move_pct", "forecast_8d_direction", "actual8Day"),
            ]:
                pred_move = pick[move_col]
                if pred_move is None:
                    continue
                pred_dir = pick[dir_col] or pick["predicted_direction"] or "UP"

                # Skip orphan pick_history rows (Option C from brainstorming)
                if spike is None:
                    continue

                actual_move_pct = spike.get(actual_key)
                if actual_move_pct is not None:
                    actual_direction = "UP" if actual_move_pct >= 0 else "DOWN"
                    accurate = 1 if actual_direction == pred_dir else 0
                    actual_price = (
                        entry_price * (1 + actual_move_pct / 100)
                        if entry_price
                        else None
                    )
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO accuracy_records
                        (pick_id, ticker, horizon_days, predicted_direction, predicted_move_pct,
                         actual_direction, actual_move_pct, actual_price, accurate, checked_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                        """,
                        (
                            pick_id,
                            ticker,
                            horizon,
                            pred_dir,
                            pred_move,
                            actual_direction,
                            round(actual_move_pct, 4),
                            actual_price,
                            accurate,
                        ),
                    )
                    resolved += 1
                else:
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO accuracy_records
                        (pick_id, ticker, horizon_days, predicted_direction, predicted_move_pct)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (pick_id, ticker, horizon, pred_dir, pred_move),
                    )
                    placeholder += 1

        conn.commit()
    except Exception as e:
        conn.rollback()
        print(f"ERROR during insert, rolled back: {e}", file=sys.stderr)
        return 1
    finally:
        pass  # keep connection open for final queries

    after_total = conn.execute("SELECT COUNT(*) FROM accuracy_records").fetchone()[0]
    after_resolved = conn.execute(
        "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
    ).fetchone()[0]

    print()
    print("=== RECOVERY SUMMARY ===")
    print(f"  pick_history rows processed: {len(pick_rows)}")
    print(f"  matched in Prisma dump: {matched}")
    print(f"  resolved rows inserted: {resolved}")
    print(f"  placeholder rows inserted: {placeholder}")
    print(f"  skipped (orphan, not in Prisma): {len(pick_rows) - matched}")
    print()
    print("=== accuracy_records BEFORE/AFTER ===")
    print(f"  total rows: {before_total} → {after_total}")
    print(f"  resolved (accurate IS NOT NULL): {before_resolved} → {after_resolved}")
    print()
    print("=== LEARNING GATE SIMULATION ===")
    for name, sql, required in [
        ("Gate 1 Stage Weights stage 1 (20d)",
         "SELECT COUNT(*) FROM accuracy_records ar JOIN pick_history ph ON ar.pick_id = ph.id "
         "JOIN stage_scores ss ON ss.pick_id = ph.id AND ss.stage = 1 "
         "WHERE ar.accurate IS NOT NULL AND ph.run_date >= date('now', '-20 days')",
         30),
        ("Gate 2 Prompt Context (15d)",
         "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL "
         "AND checked_at >= date('now', '-15 days')",
         10),
        ("Gate 4 Conviction Thresholds",
         "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL",
         50),
        ("Gate 6 Factor Feedback",
         "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL",
         100),
        ("Gate 7 Adaptive Pre-Filter",
         "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL",
         660),
    ]:
        count = conn.execute(sql).fetchone()[0]
        status = "✓ ACTIVE" if count >= required else "✗ waiting"
        print(f"  {name}: {count}/{required} — {status}")

    conn.close()
    return 0


if __name__ == "__main__":
    dump_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/spike_actuals.json"
    sys.exit(main(dump_path))
```

- [ ] **Step 13.3: Verify the script parses as Python**

Run: `python3 -c "import py_compile; py_compile.compile('/Users/coeus/spiketrades.ca/claude-code/scripts/recover_accuracy_records.py', doraise=True); print('ok')"`

Expected: `ok`

- [ ] **Step 13.4: Commit**

```bash
cd /Users/coeus/spiketrades.ca/claude-code
git add scripts/recover_accuracy_records.py
git commit -m "feat(scripts): add one-time accuracy_records recovery script

Rebuilds accuracy_records from Prisma Spike actual3Day/5Day/8Day
columns after Session 10's destructive DELETE. Zero FMP calls. Uses
INSERT OR IGNORE so it's safe to re-run. Skips orphan pick_history
rows that have no Prisma match. Prints before/after counts and
live gate-simulation at the end.

Session 13 repair (Bug 5b)"
```

---

## Task 14: Local build + dev server smoke test

**Files:** (no code — verification)

- [ ] **Step 14.1: Run the Next.js production build locally**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx next build 2>&1 | tail -40`

Expected: `✓ Compiled successfully` (or equivalent). Any error lines must be resolved before proceeding.

If the build fails, read the error, fix the file, re-run. Do not commit a broken build.

- [ ] **Step 14.2: Restart the dev server if it's still running**

Use `mcp__Claude_Preview__preview_list`. If a `spike-trades-dev` server is listed, use `mcp__Claude_Preview__preview_stop` on it. Then `mcp__Claude_Preview__preview_start` with name `spike-trades-dev`.

- [ ] **Step 14.3: Smoke-test all three archive tabs**

Use `mcp__Claude_Preview__preview_eval` for each:

```js
window.location.href = '/reports?tab=spikes'
```

Snapshot. Expected: Spike cards or empty state.

```js
window.location.href = '/reports?tab=opening-bell'
```

Snapshot. Expected: Opening Bell cards (View + XLSX buttons both visible).

```js
window.location.href = '/reports?tab=radar'
```

Snapshot. Expected: Radar cards (View + XLSX buttons both visible) or empty state.

- [ ] **Step 14.4: Smoke-test the public Accuracy Engine**

Navigate to `/accuracy`. Snapshot.

Expected: Three horizon scorecards (3D/5D/8D), Pick Results table. **No Radar section visible.** `preview_console_logs` shows no errors.

- [ ] **Step 14.5: Smoke-test the Admin Council tab**

Navigate to `/admin`. Snapshot. Click the Council tab (if not already). Snapshot.

Expected: Python Server status, Radar Scanner card, **new Radar Accuracy card directly below** (will show "hidden" state if dev DB has no resolved RadarPick rows — that's OK), Opening Bell card, Today's Spikes pipeline.

Console logs show no errors.

- [ ] **Step 14.6: Stop the dev server**

`mcp__Claude_Preview__preview_stop` on the `spike-trades-dev` serverId.

---

## Task 15: Push to origin and deploy to production

**Files:** (no code — deployment)

- [ ] **Step 15.1: Review the commits**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && git log --oneline origin/main..HEAD`

Expected: ~11 commits from Tasks 1-13.

- [ ] **Step 15.2: Push to origin**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && git push origin main`

Expected: Fast-forward push succeeds.

- [ ] **Step 15.3: Deploy to production**

Run: `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "cd /opt/spike-trades && git pull && docker compose up -d --build app council"`

Expected: `git pull` reports the new commits; `docker compose` rebuilds the `app` (Next.js) and `council` (Python) containers; both come up healthy.

- [ ] **Step 15.4: Verify containers are healthy**

Run: `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "docker ps --format '{{.Names}}\t{{.Status}}' | grep spike-trades"`

Expected: Both `spike-trades-app` and `spike-trades-council` show `Up ... (healthy)` or `Up ... seconds` (no Restarting, no Exited).

- [ ] **Step 15.5: Verify the council container is running the new code**

Run: `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "docker exec spike-trades-council python3 -c 'import eodhd_news; print(eodhd_news.EODHD_HEALTH_KEY)'"`

Expected: `eodhd/news`

If it errors or prints anything else, the container has stale code — run `docker compose up -d --build --force-recreate council` and re-verify.

---

## Task 16: Run recovery script on production

**Files:** (no code — production data recovery)

- [ ] **Step 16.1: Dump the Prisma Spike actuals from Postgres**

Run:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'docker exec spike-trades-db psql -U spiketrades -d spiketrades -t -A -F"|" -c "SELECT dr.date::date AS run_date, s.ticker, s.\"actual3Day\", s.\"actual5Day\", s.\"actual8Day\" FROM \"Spike\" s JOIN \"DailyReport\" dr ON s.\"reportId\" = dr.id"' > /tmp/spike_actuals_raw.txt
wc -l /tmp/spike_actuals_raw.txt
head -3 /tmp/spike_actuals_raw.txt
```

Expected: ~111 lines. Each line is `YYYY-MM-DD|TICKER.TO|3d|5d|8d` (values may be empty strings when NULL).

- [ ] **Step 16.2: Convert the pipe-delimited dump to JSON**

Use Write tool to create `/tmp/convert_dump.py`:

```python
import json
import sys

rows = []
with open("/tmp/spike_actuals_raw.txt") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) != 5:
            continue
        run_date, ticker, a3, a5, a8 = parts
        rows.append({
            "run_date": run_date,
            "ticker": ticker,
            "actual3Day": float(a3) if a3 else None,
            "actual5Day": float(a5) if a5 else None,
            "actual8Day": float(a8) if a8 else None,
        })

with open("/tmp/spike_actuals.json", "w") as f:
    json.dump(rows, f, indent=2)

print(f"Wrote {len(rows)} rows to /tmp/spike_actuals.json")
```

Run: `python3 /tmp/convert_dump.py`

Expected: `Wrote NNN rows to /tmp/spike_actuals.json` where NNN ≈ 111.

- [ ] **Step 16.3: Copy the JSON and the recovery script to production**

Run:

```bash
scp -i ~/.ssh/digitalocean_saa /tmp/spike_actuals.json root@147.182.150.30:/tmp/spike_actuals.json
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "docker cp /tmp/spike_actuals.json spike-trades-council:/tmp/spike_actuals.json && docker exec spike-trades-council ls -la /app/scripts/recover_accuracy_records.py && docker exec spike-trades-council ls -la /tmp/spike_actuals.json"
```

Expected: Both files listed with reasonable sizes. If `/app/scripts/recover_accuracy_records.py` is missing, the Docker image didn't include the scripts dir — check the `Dockerfile` for a `COPY scripts/` line; if absent, copy the script manually:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "docker cp /opt/spike-trades/scripts/recover_accuracy_records.py spike-trades-council:/app/scripts/recover_accuracy_records.py"
```

- [ ] **Step 16.4: Run the recovery script**

Run:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "docker exec spike-trades-council python3 /app/scripts/recover_accuracy_records.py /tmp/spike_actuals.json"
```

Expected output (approximate):

```
Loaded 111 Prisma Spike rows from /tmp/spike_actuals.json
Found 149 pick_history rows with forecasts

=== RECOVERY SUMMARY ===
  pick_history rows processed: 149
  matched in Prisma dump: ~100
  resolved rows inserted: ~189
  placeholder rows inserted: ~100
  skipped (orphan, not in Prisma): ~49

=== accuracy_records BEFORE/AFTER ===
  total rows: 0 → ~290
  resolved (accurate IS NOT NULL): 0 → ~189

=== LEARNING GATE SIMULATION ===
  Gate 1 Stage Weights stage 1 (20d): ?/30 — ✓ ACTIVE or ✗ waiting (depends on 20d window)
  Gate 2 Prompt Context (15d): ?/10 — ✓ ACTIVE
  Gate 4 Conviction Thresholds: ~189/50 — ✓ ACTIVE
  Gate 6 Factor Feedback: ~189/100 — ✓ ACTIVE
  Gate 7 Adaptive Pre-Filter: ~189/660 — ✗ waiting
```

At minimum: gates 4 and 6 must flip to ACTIVE, total accuracy_records must be > 0.

- [ ] **Step 16.5: Spot-check the DB directly**

Run:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "docker exec spike-trades-council python3 -c \"
import sqlite3
c = sqlite3.connect('/app/data/spike_trades_council.db')
print('total:', c.execute('SELECT COUNT(*) FROM accuracy_records').fetchone()[0])
print('resolved:', c.execute('SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL').fetchone()[0])
print('correct:', c.execute('SELECT COUNT(*) FROM accuracy_records WHERE accurate = 1').fetchone()[0])
print('wrong:', c.execute('SELECT COUNT(*) FROM accuracy_records WHERE accurate = 0').fetchone()[0])
\""
```

Expected: total > 0, resolved > 0, correct + wrong = resolved.

- [ ] **Step 16.6: Clean up temp files on production**

Run:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "rm -f /tmp/spike_actuals_raw.txt /tmp/spike_actuals.json && docker exec spike-trades-council rm -f /tmp/spike_actuals.json"
```

Expected: Files removed.

---

## Task 17: Trigger fresh scans to refresh Data Source Health

**Files:** (no code — operational)

**Context:** After Task 16, `accuracy_records` is populated. Now we trigger one Council + Radar + Opening Bell run each to regenerate `latest_*_output.json` files with the new EODHD tracking (Bug 3).

- [ ] **Step 17.1: Check market state**

Today's date and trading status. If it's a weekend or holiday, the scanners may exit early with "not a trading day" messages — that still writes an output file but without endpoint activity. If it's a weekday between market hours, the full scan runs.

For Session 13, a truncated/error run is still sufficient to clear stale endpoint data (the new output file overwrites the old stale one). If you want full data, run during market hours.

- [ ] **Step 17.2: Trigger Radar**

Run:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "curl -s -X POST http://localhost:8100/run-radar"
```

Expected: `{"success": true, "message": "Radar scan started"}`

Wait ~2-3 minutes, then check:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "curl -s http://localhost:8100/run-radar-status"
```

Expected: `running: false, picks_count: N`

- [ ] **Step 17.3: Trigger Opening Bell**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "curl -s -X POST http://localhost:8100/run-opening-bell"
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "sleep 120 && curl -s http://localhost:8100/run-opening-bell-status"
```

Expected: `running: false` after sleep.

- [ ] **Step 17.4: Trigger Council (Today's Spikes)**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "curl -s -X POST http://localhost:3000/api/admin/council -H 'Content-Type: application/json' -d '{}' --cookie 'YOUR_AUTH_COOKIE'"
```

Note: The admin API requires auth. Alternative — trigger via the browser at `https://spiketrades.ca/admin` → Council tab → "Run Council Scan" button. This is also acceptable for Task 17 since it's a manual verification step.

- [ ] **Step 17.5: Verify the output files were refreshed**

Run:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "docker exec spike-trades-council ls -la /app/data/latest_*.json"
```

Expected: All three `latest_*.json` files have `mtime` within the last few minutes.

- [ ] **Step 17.6: Verify EODHD appears in the output**

Run:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "docker exec spike-trades-council python3 -c \"
import json
for label, path in [('Radar','/app/data/latest_radar_output.json'), ('OB','/app/data/latest_opening_bell_output.json'), ('Council','/app/data/latest_council_output.json')]:
    try:
        with open(path) as f: d = json.load(f)
        eh = d.get('endpoint_health') or d.get('fmp_endpoint_health') or {}
        has_eodhd = 'eodhd/news' in eh
        has_fmp_news = '/news/stock' in eh
        has_price_target = '/price-target-consensus' in eh
        print(f'{label}: eodhd/news={has_eodhd}, /news/stock={has_fmp_news}, /price-target-consensus={has_price_target}')
    except Exception as e:
        print(f'{label}: {e}')
\""
```

Expected:
- Radar: `eodhd/news=True, /news/stock=False, /price-target-consensus=False`
- OB: `eodhd/news=True, /news/stock=False, /price-target-consensus=False`
- Council: `eodhd/news=True, /news/stock=False, /price-target-consensus=False`

If any `eodhd/news` is False — the scanner didn't fetch any news articles this run (may happen on weekends/holidays). Re-run during market hours to confirm.

If any `/news/stock` or `/price-target-consensus` is True — that would indicate a real regression (not just stale data). **Stop and investigate** before claiming Bug 3 is fixed.

---

## Task 18: End-to-end production verification

**Files:** (no code — verification)

- [ ] **Step 18.1: Verify Archives tabs on production**

Open `https://spiketrades.ca/reports?tab=radar` in browser.

Expected: Radar report cards appear (one per past scan), each with "View" and "XLSX" buttons. Click XLSX on the most recent — file downloads successfully, opens in Excel, shows headers + data rows.

Repeat for `?tab=opening-bell` and `?tab=spikes`.

- [ ] **Step 18.2: Verify Accuracy Engine has no Radar section**

Open `https://spiketrades.ca/accuracy`.

Expected: 3D/5D/8D scorecards and Pick Results table. **No Radar card anywhere on the page.**

- [ ] **Step 18.3: Verify Admin Council tab shows Radar Accuracy**

Open `https://spiketrades.ca/admin`, click Council tab.

Expected: Radar Accuracy card directly below Radar Scanner card, showing real numbers (hit rate, correct/total, avg open move, made final spikes).

- [ ] **Step 18.4: Verify Admin Analytics Daily Accuracy Trend table**

Click Analytics tab.

Expected: Daily Accuracy Trend table shows real numbers in 3d/5d/8d columns for rows that have resolved data. Rows within the last N days (where N = horizon) may still show dashes — that's correct.

- [ ] **Step 18.5: Verify Admin Learning mechanism activation**

Click Learning tab.

Expected: At minimum, Gate 4 (Adaptive Conviction Thresholds) and Gate 6 (Factor-Level Feedback) show "ACTIVE" with full progress bars. Other gates may be active or waiting depending on exact sample counts and window boundaries — that's OK as long as Gates 4 and 6 flipped.

- [ ] **Step 18.6: Verify Admin Council → Data Source Health shows EODHD**

Still on Council tab, scroll to Data Source Health section.

Expected: Under each scanner section (Radar, Opening Bell, Today's Spikes), a row labeled `eodhd/news` with OK counts. No rows for `/news/stock` or `/price-target-consensus`.

- [ ] **Step 18.7: Update the todo list**

All 18 tasks complete. Mark the implementation todo as done.

---

## Appendix: Expected Diff Summary

Roughly 11 commits, ~650 lines changed:

| File | ± | Purpose |
|---|---|---|
| `src/app/reports/page.tsx` | +15 -11 | Bug 1a, 1b |
| `src/app/api/reports/radar/[id]/xlsx/route.ts` | +95 new | Bug 1c |
| `src/app/api/admin/council/route.ts` | +30 -0 | Bug 2a |
| `src/app/admin/page.tsx` | +55 -0 | Bug 2b |
| `src/app/api/accuracy/route.ts` | +0 -40 | Bug 2c |
| `src/app/accuracy/page.tsx` | +0 -50 | Bug 2d |
| `eodhd_news.py` | +30 -10 | Bug 3a |
| `canadian_llm_council_brain.py` | +2 -2 | Bug 3b |
| `opening_bell_scanner.py` | +6 -2 | Bug 3c |
| `docs/superpowers/plans/2026-04-06-session-10-v5-repairs.md` | +12 -1 | Bug 5a |
| `scripts/recover_accuracy_records.py` | +170 new | Bug 5b |
