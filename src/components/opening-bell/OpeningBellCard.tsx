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
