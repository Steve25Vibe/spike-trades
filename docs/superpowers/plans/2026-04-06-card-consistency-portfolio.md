# Card Consistency & Portfolio Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Opening Bell and Radar card physical formatting to match SpikeCard's layout structure, and add full portfolio menu system (selection, bulk lock-in, settings) to the Radar page. Opening Bell page already has portfolio support — only the card component itself changes.

**Architecture:** Two card components are modified to match SpikeCard's structural layout (rank badge, header flex row, score box positioning, narrative box, footer). Each card retains its own specialized data sections and color theme. The Radar page gains selection mode, bulk lock-in, portfolio settings, and confirmation toast — matching the existing patterns in Dashboard and Opening Bell pages.

**Tech Stack:** TypeScript, Next.js 15 (App Router), React, Tailwind CSS

---

## DO NOT TOUCH

- `src/components/spikes/SpikeCard.tsx` — zero changes
- `src/app/dashboard/page.tsx` — zero changes
- `src/components/radar/RadarIcon.tsx` — zero changes
- `src/components/radar/RadarLockInModal.tsx` — zero changes
- `src/components/portfolio/LockInModal.tsx` — zero changes
- `src/components/portfolio/BulkLockInModal.tsx` — zero changes
- `src/components/portfolio/PortfolioChoiceModal.tsx` — zero changes
- `src/components/portfolio/PortfolioSettings.tsx` — zero changes
- `src/components/portfolio/PortfolioSelector.tsx` — zero changes
- `src/components/portfolio/usePortfolios.ts` — zero changes
- `src/app/api/portfolio/route.ts` — zero changes
- `src/styles/globals.css` — zero changes (all needed classes already exist: `rank-badge`, `rank-1`–`rank-default`, `btn-lock-in`, `glass-card`)
- All Python files — zero changes
- All Prisma/config files — zero changes

## File Map

### Modified Files

| File | Change |
|------|--------|
| `src/components/opening-bell/OpeningBellCard.tsx` | Restructure layout to match SpikeCard physical formatting |
| `src/components/radar/RadarCard.tsx` | Restructure layout to match SpikeCard physical formatting, add selection support |
| `src/app/radar/page.tsx` | Add selection mode, bulk lock-in, portfolio settings, confirmation toast |

---

## Task 1: Restructure OpeningBellCard Layout

**Files:**
- Modify: `src/components/opening-bell/OpeningBellCard.tsx`

This task changes ONLY the physical layout/structure of OpeningBellCard to match SpikeCard. The data displayed (Rel. Volume, Sector, Price Move, Intraday Target, Key Level, Conviction) stays the same. The amber color theme stays.

### What changes from current:

1. **Rank badge**: Round circle with inline gradient → square `rank-badge` class with `rank-1`/`rank-2`/`rank-3`/`rank-default`
2. **Top glow bar**: Absent → amber gradient glow for ranks 1-3 (like SpikeCard's cyan but amber)
3. **Header layout**: Split `justify-between` layout → single `flex items-start gap-4` row (rank + info + score)
4. **Price position**: Separately indented with `ml-[42px]` → inside info block under company name
5. **Score box**: No right margin → `mr-8` to make room for checkbox
6. **Bell icon**: Removed (redundant on Opening Bell page)
7. **Checkbox**: Only visible in selectionMode → visible on hover (like SpikeCard: `opacity-0 group-hover:opacity-100`)
8. **Narrative**: Plain text with amber title → wrapped in styled box with info icon SVG
9. **Lock In button**: Inline `bg-gradient-to-r from-spike-amber to-orange-500` → `btn-lock-in` class
10. **Radar icon**: Show `<RadarIcon>` ONLY when `isRadarPick` is true (reaffirmed by upstream Radar scan). No bell icon ever.

- [ ] **Step 1: Rewrite OpeningBellCard.tsx**

Replace the entire component body with the new layout. The full replacement code:

```tsx
'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import RadarIcon from '@/components/radar/RadarIcon';

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
  isRadarPick?: boolean;
  radarScore?: number | null;
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

  const handleCheckbox = () => {
    onSelect?.(pick.id, !selected);
  };

  const rankClass = pick.rank === 1 ? 'rank-1' : pick.rank === 2 ? 'rank-2' : pick.rank === 3 ? 'rank-3' : 'rank-default';

  const convictionColor =
    pick.conviction === 'high' ? 'text-spike-green' :
    pick.conviction === 'medium' ? 'text-spike-amber' :
    'text-spike-red';

  return (
    <div className={cn(
      'glass-card p-5 relative group transition-all',
      selected && 'ring-2 ring-spike-amber/50 border-spike-amber/30',
      selectionMode && 'cursor-pointer'
    )}>
      {/* Top glow for top 3 — amber theme */}
      {pick.rank <= 3 && (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-spike-amber to-transparent rounded-t-2xl" />
      )}

      {/* Selection checkbox — visible on hover or always in selection mode */}
      <div className={cn(
        'absolute top-4 right-4 z-10 transition-opacity',
        selectionMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      )}>
        <button
          onClick={handleCheckbox}
          className={cn(
            'w-7 h-7 rounded-lg border-2 flex items-center justify-center transition-all',
            selected
              ? 'bg-spike-amber border-spike-amber text-spike-bg'
              : 'border-spike-border hover:border-spike-amber/50 bg-spike-bg/50'
          )}
          title={selected ? 'Remove from selection' : 'Add to selection'}
        >
          {selected && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
      </div>

      {/* Header row: rank + info + score — matches SpikeCard flex layout */}
      <div className="flex items-start gap-4">
        {/* Rank badge — square, using shared CSS class */}
        <div className={cn('rank-badge flex-shrink-0', rankClass)}>
          {pick.rank}
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <a href={`https://finance.yahoo.com/quote/${pick.ticker}`} target="_blank" rel="noopener noreferrer" title={`View ${pick.ticker} on Yahoo Finance`} className="text-lg font-bold text-spike-text hover:text-spike-amber transition-colors">{pick.ticker}</a>
            <span className="text-xs px-2 py-0.5 rounded-full bg-spike-border/50 text-spike-text-dim flex-shrink-0">
              {pick.exchange}
            </span>
            {pick.sector && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-spike-violet/10 text-spike-violet flex-shrink-0">
                {pick.sector}
              </span>
            )}
            {pick.isRadarPick && (
              <RadarIcon
                size={24}
                title={`Flagged by Smart Money Radar${pick.radarScore ? ` (Score: ${pick.radarScore})` : ''}`}
              />
            )}
          </div>
          <p className="text-sm text-spike-text-dim line-clamp-2">{pick.name}</p>

          {/* Price — inside info block */}
          <div className="flex items-baseline gap-3 mt-2">
            <span className="text-2xl font-bold mono">${pick.priceAtScan.toFixed(2)}</span>
            <span className={cn('text-sm font-bold mono', pick.changePercent >= 0 ? 'text-spike-green' : 'text-spike-red')}>
              {pick.changePercent >= 0 ? '+' : ''}{pick.changePercent.toFixed(1)}%
            </span>
          </div>
        </div>

        {/* Score box — with mr-8 for checkbox space */}
        <div className="flex-shrink-0 text-center mr-8">
          <div className={cn(
            'w-16 h-16 rounded-xl flex items-center justify-center font-bold text-xl mono',
            pick.momentumScore >= 80 ? 'bg-spike-green/15 text-spike-green border border-spike-green/30' :
            pick.momentumScore >= 60 ? 'bg-spike-amber/15 text-spike-amber border border-spike-amber/30' :
            'bg-spike-red/15 text-spike-red border border-spike-red/30'
          )}>
            {Math.round(pick.momentumScore)}
          </div>
          <p className="text-[10px] text-spike-text-muted mt-1 uppercase tracking-wider">Score</p>
        </div>
      </div>

      {/* Opening Bell specialized data: Surge metrics */}
      <div className="grid grid-cols-3 gap-3 mt-4">
        {[
          { label: 'Rel. Volume', value: `${pick.relativeVolume.toFixed(1)}x`, color: 'text-spike-green' },
          { label: 'Sector', value: pick.sectorMomentum != null ? `${pick.sectorMomentum >= 0 ? '+' : ''}${pick.sectorMomentum.toFixed(1)}%` : '\u2014', color: 'text-spike-amber' },
          { label: 'Price Move', value: `${pick.changePercent >= 0 ? '+' : ''}${pick.changePercent.toFixed(1)}%`, color: 'text-spike-green' },
        ].map((item) => (
          <div key={item.label} className="bg-spike-bg/50 rounded-lg p-3 text-center">
            <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">{item.label}</p>
            <p className={cn('text-lg font-bold mono', item.color)}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* Opening Bell specialized data: Targets */}
      <div className="grid grid-cols-3 gap-3 mt-3">
        {[
          { label: 'Intraday Target', value: `$${pick.intradayTarget.toFixed(2)}`, color: 'text-spike-green' },
          { label: 'Key Level', value: `$${pick.keyLevel.toFixed(2)}`, color: 'text-spike-red' },
          { label: 'Conviction', value: pick.conviction === 'high' ? 'HIGH' : pick.conviction === 'medium' ? 'MED' : 'LOW', color: convictionColor },
        ].map((item) => (
          <div key={item.label} className="bg-spike-bg/50 rounded-lg p-3 text-center">
            <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">{item.label}</p>
            <p className={cn('text-lg font-bold mono', item.color)}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* Narrative — styled box with info icon, matching SpikeCard */}
      {pick.rationale && (
        <div className="mt-3 p-3 bg-spike-bg/40 rounded-lg border border-spike-border/30">
          <div className="flex items-center gap-2 mb-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFB800" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="text-[10px] text-spike-amber uppercase tracking-wider font-semibold">Why This Stock?</span>
          </div>
          <p className="text-sm text-spike-text-dim leading-relaxed">{pick.rationale}</p>
        </div>
      )}

      {/* Footer — matches SpikeCard structure */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mt-4 pt-3 border-t border-spike-border/30 gap-3">
        <div className="flex gap-4 text-xs text-spike-text-muted mono">
          <span>Vol: {pick.relativeVolume.toFixed(1)}x</span>
          <span>Chg: {pick.changePercent >= 0 ? '+' : ''}{pick.changePercent.toFixed(1)}%</span>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {!selectionMode && (
            <button
              onClick={handleLockIn}
              disabled={locking}
              className="btn-lock-in disabled:opacity-50"
              title="Add this stock to your portfolio"
            >
              {locking ? 'Locking...' : '⚡ Lock In'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx next build 2>&1 | head -30`

Expected: Build succeeds without TypeScript errors in OpeningBellCard.

- [ ] **Step 3: Commit**

```bash
git add src/components/opening-bell/OpeningBellCard.tsx
git commit -m "refactor: align OpeningBellCard layout to match SpikeCard formatting"
```

---

## Task 2: Restructure RadarCard Layout

**Files:**
- Modify: `src/components/radar/RadarCard.tsx`

This task changes the physical layout of RadarCard to match SpikeCard. The Radar-specific data (Top Catalyst box, score breakdown bars) stays. The green color theme stays. Selection/checkbox support is added.

### What changes from current:

1. **Score box**: No right margin → `mr-8` to make room for checkbox
2. **Checkbox**: Completely absent → added with hover visibility (like SpikeCard)
3. **Pipeline status**: Removed (Radar doesn't reference downstream scans)
4. **Redundant RadarIcon next to ticker**: Removed (you're already on the Radar page)
5. **Narrative**: Plain text with `border-t` separator → wrapped in styled box with info icon SVG
6. **Footer**: Empty left side, just Lock In button → stats row (Vol/RSI/ADX placeholder) + Lock In button matching SpikeCard structure
7. **Selection support**: `selected`, `onSelect`, `selectionMode` props added to interface

- [ ] **Step 1: Rewrite RadarCard.tsx**

Replace the entire component with the new layout. The full replacement code:

```tsx
'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface RadarPickData {
  id: string;
  rank: number;
  ticker: string;
  name: string;
  sector: string | null;
  exchange: string;
  priceAtScan: number;
  smartMoneyScore: number;
  catalystStrength: number;
  newsSentiment: number;
  technicalSetup: number;
  volumeSignals: number;
  sectorAlignment: number;
  rationale: string | null;
  topCatalyst: string | null;
  passedOpeningBell: boolean;
  passedSpikes: boolean;
}

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 text-spike-text-muted truncate">{label}</span>
      <div className="flex-1 h-1.5 bg-spike-bg rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-radar-green" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right text-spike-text-dim">{value}</span>
    </div>
  );
}

interface Props {
  pick: RadarPickData;
  selected?: boolean;
  onSelect?: (pickId: string, selected: boolean) => void;
  onLockIn?: (pickId: string) => void;
  selectionMode?: boolean;
}

export default function RadarCard({ pick, selected, onSelect, onLockIn, selectionMode }: Props) {
  const [locking, setLocking] = useState(false);
  const rankClass = pick.rank === 1 ? 'rank-1' : pick.rank === 2 ? 'rank-2' : pick.rank === 3 ? 'rank-3' : 'rank-default';

  const handleLockIn = async () => {
    if (!onLockIn) return;
    setLocking(true);
    await onLockIn(pick.id);
    setLocking(false);
  };

  const handleCheckbox = () => {
    onSelect?.(pick.id, !selected);
  };

  return (
    <div className={cn(
      'glass-card p-5 relative group transition-all',
      selected && 'ring-2 ring-radar-green/50 border-radar-green/30',
      selectionMode && 'cursor-pointer'
    )}>
      {/* Top glow for top 3 */}
      {pick.rank <= 3 && (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-radar-green to-transparent rounded-t-2xl" />
      )}

      {/* Selection checkbox — visible on hover or always in selection mode */}
      <div className={cn(
        'absolute top-4 right-4 z-10 transition-opacity',
        selectionMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      )}>
        <button
          onClick={handleCheckbox}
          className={cn(
            'w-7 h-7 rounded-lg border-2 flex items-center justify-center transition-all',
            selected
              ? 'bg-radar-green border-radar-green text-spike-bg'
              : 'border-spike-border hover:border-radar-green/50 bg-spike-bg/50'
          )}
          title={selected ? 'Remove from selection' : 'Add to selection'}
        >
          {selected && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
      </div>

      {/* Header row: rank + info + score — matches SpikeCard flex layout */}
      <div className="flex items-start gap-4">
        {/* Rank badge */}
        <div className={cn('rank-badge flex-shrink-0', rankClass)}>
          {pick.rank}
        </div>

        {/* Main info — no RadarIcon here (redundant on Radar page) */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <a
              href={`https://finance.yahoo.com/quote/${pick.ticker}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`View ${pick.ticker} on Yahoo Finance`}
              className="text-lg font-bold text-spike-text hover:text-radar-green transition-colors"
            >
              {pick.ticker}
            </a>
            <span className="text-xs px-2 py-0.5 rounded-full bg-spike-border/50 text-spike-text-dim flex-shrink-0">
              {pick.exchange}
            </span>
            {pick.sector && pick.sector !== 'Unknown' && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-spike-violet/10 text-spike-violet flex-shrink-0">
                {pick.sector}
              </span>
            )}
          </div>
          <p className="text-sm text-spike-text-dim line-clamp-2">{pick.name}</p>

          {/* Price */}
          <div className="flex items-baseline gap-3 mt-2">
            <span className="text-2xl font-bold mono">${pick.priceAtScan.toFixed(2)}</span>
          </div>
        </div>

        {/* Score — with mr-8 for checkbox space */}
        <div className="flex-shrink-0 text-center mr-8">
          <div className={cn(
            'w-16 h-16 rounded-xl flex items-center justify-center font-bold text-xl mono',
            pick.smartMoneyScore >= 80 ? 'bg-spike-green/15 text-spike-green border border-spike-green/30' :
            pick.smartMoneyScore >= 60 ? 'bg-spike-amber/15 text-spike-amber border border-spike-amber/30' :
            'bg-spike-red/15 text-spike-red border border-spike-red/30'
          )}>
            {pick.smartMoneyScore}
          </div>
          <p className="text-[10px] text-spike-text-muted mt-1 uppercase tracking-wider">Score</p>
        </div>
      </div>

      {/* Radar specialized: Top Catalyst */}
      {pick.topCatalyst && (
        <div className="mt-4 p-3 bg-radar-green/5 border border-radar-green/20 rounded-lg">
          <div className="text-[10px] uppercase text-radar-green/60 mb-1">Top Catalyst</div>
          <div className="text-sm text-spike-text-dim">{pick.topCatalyst}</div>
        </div>
      )}

      {/* Radar specialized: Score breakdown bars */}
      <div className="space-y-1.5 mt-4">
        <ScoreBar label="Catalyst" value={pick.catalystStrength} max={30} />
        <ScoreBar label="News" value={pick.newsSentiment} max={25} />
        <ScoreBar label="Technical" value={pick.technicalSetup} max={25} />
        <ScoreBar label="Volume" value={pick.volumeSignals} max={10} />
        <ScoreBar label="Sector" value={pick.sectorAlignment} max={10} />
      </div>

      {/* Narrative — styled box with info icon, matching SpikeCard */}
      {pick.rationale && (
        <div className="mt-3 p-3 bg-spike-bg/40 rounded-lg border border-spike-border/30">
          <div className="flex items-center gap-2 mb-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00FF88" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="text-[10px] text-radar-green uppercase tracking-wider font-semibold">Why This Stock?</span>
          </div>
          <p className="text-sm text-spike-text-dim leading-relaxed">{pick.rationale}</p>
        </div>
      )}

      {/* Footer — matches SpikeCard structure */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mt-4 pt-3 border-t border-spike-border/30 gap-3">
        <div className="flex gap-4 text-xs text-spike-text-muted mono">
          <span>Score: {pick.smartMoneyScore}</span>
          <span>Cat: {pick.catalystStrength}/{30}</span>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {!selectionMode && onLockIn && (
            <button
              onClick={handleLockIn}
              disabled={locking}
              className="btn-lock-in disabled:opacity-50"
              title="Add this stock to your portfolio"
            >
              {locking ? 'Locking...' : '⚡ Lock In'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx next build 2>&1 | head -30`

Expected: Build succeeds. The Radar page (`src/app/radar/page.tsx`) currently passes only `pick` and `onLockIn` to RadarCard — the new optional props (`selected`, `onSelect`, `selectionMode`) default to `undefined`, so existing usage still works.

- [ ] **Step 3: Commit**

```bash
git add src/components/radar/RadarCard.tsx
git commit -m "refactor: align RadarCard layout to match SpikeCard formatting, add selection support"
```

---

## Task 3: Add Full Portfolio System to Radar Page

**Files:**
- Modify: `src/app/radar/page.tsx`

This task adds selection mode, bulk lock-in, portfolio settings, and the confirmation toast to the Radar page — matching the exact patterns already used in `src/app/dashboard/page.tsx` and `src/app/opening-bell/page.tsx`. The existing single lock-in flow (PortfolioChoiceModal → RadarLockInModal) is already present and stays.

### What gets added:

1. **Imports**: `BulkLockInModal`, `PortfolioSettings`, `SizingMode`, `cn`
2. **State**: `selectedIds`, `selectionMode`, `pendingBulkPicks`, `bulkLockInPicks`, `showSettings`
3. **Handlers**: `handleSelect`, `handleSelectAll`, `handleBulkLockIn`, `handleConfirmBulkLockIn`
4. **Selection toolbar**: Settings gear + Select/Deselect/Bulk Lock In buttons (matching Opening Bell pattern with radar-green theme instead of amber)
5. **Confirmation toast**: Inline banner (matching Opening Bell pattern) instead of current fixed-position toast
6. **RadarCard props**: Pass `selected`, `onSelect`, `selectionMode` to each RadarCard
7. **BulkLockInModal**: Rendered when `bulkLockInPicks` is set
8. **PortfolioSettings**: Rendered when `showSettings` is true

- [ ] **Step 1: Rewrite radar/page.tsx**

Replace the entire file with the updated version. The full replacement code:

```tsx
'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import RadarCard, { type RadarPickData } from '@/components/radar/RadarCard';
import RadarIcon from '@/components/radar/RadarIcon';
import RadarLockInModal from '@/components/radar/RadarLockInModal';
import BulkLockInModal from '@/components/portfolio/BulkLockInModal';
import PortfolioChoiceModal from '@/components/portfolio/PortfolioChoiceModal';
import PortfolioSettings from '@/components/portfolio/PortfolioSettings';
import { usePortfolios } from '@/components/portfolio/usePortfolios';
import type { SizingMode } from '@/components/portfolio/PortfolioSettings';
import { cn } from '@/lib/utils';

function RadarContent() {
  const searchParams = useSearchParams();
  const dateParam = searchParams.get('date');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Portfolio lock-in state
  const { portfolios, activeId: activePortfolioId, refresh: refreshPortfolios } = usePortfolios();
  const [pendingSinglePick, setPendingSinglePick] = useState<RadarPickData | null>(null);
  const [lockInPick, setLockInPick] = useState<RadarPickData | null>(null);
  const [chosenPortfolioId, setChosenPortfolioId] = useState<string>('');
  const [lockResults, setLockResults] = useState<{ locked: number; skipped: any[] } | null>(null);

  // Selection & bulk lock-in state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [pendingBulkPicks, setPendingBulkPicks] = useState<RadarPickData[] | null>(null);
  const [bulkLockInPicks, setBulkLockInPicks] = useState<RadarPickData[] | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const url = dateParam ? `/api/radar?date=${dateParam}` : '/api/radar';
    fetch(url)
      .then(r => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [dateParam]);

  // Step 1: user clicks Lock In → show portfolio choice modal
  const handleLockIn = (pickId: string) => {
    const pick = data?.picks.find((p: any) => p.id === pickId);
    if (pick) setPendingSinglePick(pick);
  };

  // Step 2a: user chose a portfolio → show lock-in modal
  const handlePortfolioChosen = (portfolioId: string) => {
    setChosenPortfolioId(portfolioId);
    if (pendingSinglePick) {
      setLockInPick(pendingSinglePick);
      setPendingSinglePick(null);
    }
    if (pendingBulkPicks) {
      setBulkLockInPicks(pendingBulkPicks);
      setPendingBulkPicks(null);
    }
    refreshPortfolios();
  };

  const handleCancelChoice = () => {
    setPendingSinglePick(null);
    setPendingBulkPicks(null);
  };

  const handleConfirmLockIn = async (params: { spikeId: string; portfolioId: string; shares?: number; positionSize?: number; portfolioSize?: number; mode: SizingMode }) => {
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, radarPickId: params.spikeId, spikeId: undefined }),
    });
    const json = await res.json();
    if (json.success) {
      setLockInPick(null);
      setLockResults({ locked: 1, skipped: [] });
      setTimeout(() => setLockResults(null), 3000);
      refreshPortfolios();
    }
  };

  // Selection handlers
  const handleSelect = (pickId: string, isSelected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isSelected) next.add(pickId);
      else next.delete(pickId);
      return next;
    });
  };

  const handleSelectAll = () => {
    const picks = data?.picks || [];
    if (selectedIds.size === picks.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(picks.map((p: any) => p.id)));
    }
  };

  const handleBulkLockIn = () => {
    if (selectedIds.size === 0 || !data) return;
    const selected = data.picks.filter((p: any) => selectedIds.has(p.id));
    setPendingBulkPicks(selected);
  };

  const handleConfirmBulkLockIn = async (params: {
    spikeIds: string[];
    portfolioId: string;
    mode: SizingMode;
    portfolioSize?: number;
    fixedAmount?: number;
    perSpikeShares?: Record<string, number>;
  }) => {
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, radarPickIds: params.spikeIds, spikeIds: undefined }),
    });
    const json = await res.json();
    if (json.success) {
      setBulkLockInPicks(null);
      setLockResults({ locked: json.locked, skipped: json.skipped || [] });
      setSelectedIds(new Set());
      setSelectionMode(false);
      setTimeout(() => setLockResults(null), 5000);
      refreshPortfolios();
    }
  };

  if (loading) {
    return (
      <ResponsiveLayout>
        <div className="flex items-center justify-center min-h-[50vh] text-gray-500">Loading Radar data...</div>
      </ResponsiveLayout>
    );
  }

  const report = data?.report;
  const picks = data?.picks || [];

  if (!report) {
    return (
      <ResponsiveLayout>
        <div className="flex items-center justify-center h-[60vh]">
          <div className="glass-card p-8 text-center max-w-md">
            <div className="w-16 h-16 rounded-full bg-radar-green/10 flex items-center justify-center mx-auto mb-4">
              <RadarIcon size={32} />
            </div>
            <h3 className="text-lg font-bold text-spike-text mb-2">No Radar Data</h3>
            <p className="text-spike-text-dim text-sm">No Radar report found</p>
            <p className="text-spike-text-muted text-xs mt-4">
              The pre-market scan runs at 10:05 AM AST on trading days.
            </p>
          </div>
        </div>
      </ResponsiveLayout>
    );
  }

  const avgScore = picks.length > 0
    ? Math.round(picks.reduce((s: number, p: any) => s + p.smartMoneyScore, 0) / picks.length)
    : 0;
  const topScore = picks.length > 0 ? Math.max(...picks.map((p: any) => p.smartMoneyScore)) : 0;

  return (
    <ResponsiveLayout>
      <div className="max-w-7xl mx-auto">
        {/* Radar header */}
        <div className="glass-card p-4 mb-6">
          <div className="flex items-center gap-3">
            <RadarIcon size={28} />
            <div>
              <h2 className="text-xl font-display font-bold tracking-wide text-radar-green">SMART MONEY RADAR</h2>
              <p className="text-sm text-spike-text-dim">
                Pre-Market Signals &mdash; {report.date ? new Date(report.date).toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'Today'}
              </p>
            </div>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {[
            { label: 'Tickers Scanned', value: report.tickersScanned.toLocaleString() },
            { label: 'Tickers Flagged', value: report.tickersFlagged },
            { label: 'Avg Score', value: avgScore },
            { label: 'Top Score', value: topScore },
            { label: 'Scan Duration', value: `${(report.scanDurationMs / 1000).toFixed(1)}s` },
          ].map((stat) => (
            <div key={stat.label} className="bg-gray-900/60 border border-gray-800 rounded-lg p-3 text-center">
              <div className="text-[10px] uppercase text-gray-500 mb-1">{stat.label}</div>
              <div className="text-xl font-bold text-radar-green">{stat.value}</div>
            </div>
          ))}
        </div>

        {/* Selection toolbar — matches Dashboard/Opening Bell pattern */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {/* Portfolio settings gear */}
            <button
              onClick={() => setShowSettings(true)}
              className="w-9 h-9 rounded-lg border border-spike-border hover:border-radar-green/30 flex items-center justify-center text-spike-text-dim hover:text-radar-green transition-all"
              title="Portfolio Settings"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>

            <button
              onClick={() => { setSelectionMode(!selectionMode); if (selectionMode) setSelectedIds(new Set()); }}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium transition-all border',
                selectionMode
                  ? 'bg-radar-green/10 text-radar-green border-radar-green/30'
                  : 'text-spike-text-dim border-spike-border hover:border-radar-green/30 hover:text-spike-text'
              )}
              title={selectionMode ? 'Exit selection mode without making changes' : 'Pick multiple stocks to add to your portfolio at once'}
            >
              {selectionMode ? '✕ Cancel Selection' : '☐ Select Picks for Portfolio'}
            </button>

            {selectionMode && (
              <>
                <button
                  onClick={handleSelectAll}
                  className="px-3 py-2 rounded-lg text-xs font-medium text-spike-text-dim hover:text-spike-text border border-spike-border hover:border-radar-green/30 transition-all"
                  title="Select or deselect all picks on this page"
                >
                  {selectedIds.size === picks.length ? 'Deselect All' : 'Select All'}
                </button>
                <span className="text-sm text-spike-text-dim">
                  {selectedIds.size} of {picks.length} selected
                </span>
              </>
            )}

            {selectionMode && selectedIds.size > 0 && (
              <button
                onClick={handleBulkLockIn}
                className="btn-lock-in text-base px-6 py-2.5 flex items-center gap-2"
                title="Add your selected picks to your portfolio"
              >
                ⚡ Lock In {selectedIds.size} Pick{selectedIds.size > 1 ? 's' : ''}
              </button>
            )}
          </div>
        </div>

        {/* Lock-in confirmation toast — inline banner matching Opening Bell pattern */}
        {lockResults && (
          <div className="mb-4 p-4 rounded-xl bg-spike-green/10 border border-spike-green/30 flex items-center justify-between animate-fade-in">
            <div className="flex items-center gap-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00FF88" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="text-spike-green font-medium">
                {lockResults.locked} position{lockResults.locked > 1 ? 's' : ''} locked into portfolio!
              </span>
              {lockResults.skipped.length > 0 && (
                <span className="text-spike-amber text-sm ml-2">
                  ({lockResults.skipped.length} skipped — {lockResults.skipped.map((s: any) => s.ticker || s.error).join(', ')})
                </span>
              )}
            </div>
            <a href="/portfolio" className="text-sm text-spike-cyan hover:underline">View Portfolio →</a>
          </div>
        )}

        {/* RadarCard grid */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {picks.map((pick: any) => (
            <RadarCard
              key={pick.id}
              pick={pick}
              selected={selectedIds.has(pick.id)}
              onSelect={handleSelect}
              onLockIn={handleLockIn}
              selectionMode={selectionMode}
            />
          ))}
        </div>

        {picks.length === 0 && (
          <div className="text-center text-gray-500 py-12">
            No tickers flagged — quiet overnight. Check back tomorrow.
          </div>
        )}

        {/* Legal footer */}
        <div className="legal-footer">
          <p>
            For educational and informational purposes only. Not financial advice.
            Past performance is no guarantee of future results.
            Trading stocks involves risk. You may lose your entire investment.
          </p>
          <p className="mt-2">
            &copy; {new Date().getFullYear()} Spike Trades &mdash; spiketrades.ca. All rights reserved. &middot; Ver 5.0
          </p>
        </div>
      </div>

      {/* Portfolio Choice Modal — appears first when locking in */}
      {(pendingSinglePick || pendingBulkPicks) && (
        <PortfolioChoiceModal
          spikeCount={pendingSinglePick ? 1 : (pendingBulkPicks?.length || 0)}
          portfolios={portfolios}
          onSelect={handlePortfolioChosen}
          onCreate={handlePortfolioChosen}
          onCancel={handleCancelChoice}
        />
      )}

      {/* Lock-In Confirmation Modal — after portfolio chosen (single pick) */}
      {lockInPick && (
        <RadarLockInModal
          pick={{
            id: lockInPick.id,
            ticker: lockInPick.ticker,
            name: lockInPick.name,
            price: lockInPick.priceAtScan,
            smartMoneyScore: lockInPick.smartMoneyScore,
            topCatalyst: lockInPick.topCatalyst,
          }}
          activePortfolioId={chosenPortfolioId || activePortfolioId}
          portfolios={portfolios}
          onConfirm={handleConfirmLockIn}
          onCancel={() => setLockInPick(null)}
        />
      )}

      {/* Bulk Lock-In Modal — after portfolio chosen (multiple picks) */}
      {bulkLockInPicks && bulkLockInPicks.length > 0 && chosenPortfolioId && (
        <BulkLockInModal
          spikes={bulkLockInPicks.map((p) => ({
            id: p.id,
            ticker: p.ticker,
            name: p.name,
            price: p.priceAtScan,
            predicted3Day: 0,
            atr: undefined,
          }))}
          portfolios={portfolios}
          activePortfolioId={chosenPortfolioId}
          onConfirm={handleConfirmBulkLockIn}
          onCancel={() => { setBulkLockInPicks(null); setChosenPortfolioId(null); }}
        />
      )}

      {/* Sizing Mode Settings */}
      {showSettings && (
        <PortfolioSettings
          portfolio={null}
          onClose={() => setShowSettings(false)}
          onUpdated={refreshPortfolios}
        />
      )}
    </ResponsiveLayout>
  );
}

export default function RadarPage() {
  return (
    <Suspense fallback={
      <ResponsiveLayout>
        <div className="flex items-center justify-center min-h-[50vh] text-gray-500">Loading...</div>
      </ResponsiveLayout>
    }>
      <RadarContent />
    </Suspense>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx next build 2>&1 | head -30`

Expected: Build succeeds without TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/radar/page.tsx
git commit -m "feat: add selection mode, bulk lock-in, and portfolio settings to Radar page"
```

---

## Task 4: Verify Portfolio API Handles Radar Bulk Lock-In

**Files:**
- Read only: `src/app/api/portfolio/route.ts`

The portfolio API POST route already handles `radarPickId` for single picks and `radarPickIds` for bulk. This task verifies that — no code changes expected.

- [ ] **Step 1: Verify radarPickIds is handled in the API**

Search for `radarPickId` in the portfolio route:

Run: `grep -n 'radarPickId' src/app/api/portfolio/route.ts`

Expected: The route should already handle both `radarPickId` (single) and `radarPickIds` (bulk array). If `radarPickIds` is NOT handled, add it following the same pattern as `openingBellPickIds`.

- [ ] **Step 2: Test build one final time**

Run: `cd /Users/coeus/spiketrades.ca/claude-code && npx next build 2>&1 | tail -5`

Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit (only if API changes were needed)**

```bash
git add src/app/api/portfolio/route.ts
git commit -m "fix: add radarPickIds bulk handling to portfolio API"
```

---

## Task 5: Deploy and Verify

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Deploy to server**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "cd /opt/spike-trades && git pull && docker compose up -d --build app cron"
```

- [ ] **Step 3: Verify on production**

Check spiketrades.ca:
1. Opening Bell page — cards use square rank badges, top glow, unified header layout, narrative box, `btn-lock-in` button, no bell icon
2. Radar page — cards have checkbox on hover, narrative box, footer stats, no RadarIcon next to ticker, no pipeline status
3. Radar page — selection toolbar visible (gear + Select Picks button), bulk lock-in works
4. Today's Spikes — completely unchanged (spot check)

- [ ] **Step 4: Final commit tag**

```bash
git tag -a v5.0.2 -m "Card consistency + Radar portfolio integration"
git push origin v5.0.2
```
