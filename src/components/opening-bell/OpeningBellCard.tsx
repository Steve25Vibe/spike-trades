'use client';

import { useState } from 'react';
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
          {selected && <span className="text-xs font-bold">&#10003;</span>}
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
              {pick.isRadarPick && (
                <RadarIcon
                  size={24}
                  title={`Flagged by Smart Money Radar${pick.radarScore ? ` (Score: ${pick.radarScore})` : ''}`}
                />
              )}
              <span
                className="inline-block text-xl animate-bell-ring"
                title="Opening Bell pick"
              >
                🔔
              </span>
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
          <div className="text-lg font-bold font-mono text-spike-amber mt-0.5">{pick.sectorMomentum != null ? `${pick.sectorMomentum >= 0 ? '+' : ''}${pick.sectorMomentum.toFixed(1)}%` : '\u2014'}</div>
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
        <div className="text-[11px] text-spike-amber uppercase tracking-wider font-bold mb-1.5 flex items-center gap-1">Why This Stock?</div>
        <p className="text-[13px] text-spike-text-dim leading-relaxed">{pick.rationale || 'No rationale provided.'}</p>
      </div>

      {/* Footer */}
      <div className="flex justify-between items-center pt-3 border-t border-spike-border">
        <div className="flex gap-3 text-xs text-spike-text-muted font-mono">
          <span>VWAP: \u2014</span>
          <span>ADX: \u2014</span>
        </div>
        <div className="flex gap-2 items-center">
          {!selectionMode && (
            <button
              onClick={handleLockIn}
              disabled={locking}
              className="flex items-center gap-1 px-4 py-1.5 rounded-md text-xs font-bold transition-all bg-gradient-to-r from-spike-amber to-orange-500 text-spike-bg hover:opacity-90 disabled:opacity-50"
            >
              {locking ? 'Locking...' : 'Lock In'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
