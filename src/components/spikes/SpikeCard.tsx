'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn, formatCurrency, formatPercent, formatVolume } from '@/lib/utils';
import type { SpikeCard as SpikeCardType } from '@/types';

interface Props {
  spike: SpikeCardType;
  selected?: boolean;
  onSelect?: (spikeId: string, selected: boolean) => void;
  onLockIn?: (spikeId: string) => void;
  selectionMode?: boolean;
}

export default function SpikeCard({ spike, selected, onSelect, onLockIn, selectionMode }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [locking, setLocking] = useState(false);

  const handleLockIn = async () => {
    if (!onLockIn) return;
    setLocking(true);
    await onLockIn(spike.id);
    setLocking(false);
  };

  const handleCheckbox = () => {
    onSelect?.(spike.id, !selected);
  };

  const rankClass = spike.rank === 1 ? 'rank-1' : spike.rank === 2 ? 'rank-2' : spike.rank === 3 ? 'rank-3' : 'rank-default';

  return (
    <div className={cn(
      'glass-card p-5 relative group transition-all',
      selected && 'ring-2 ring-spike-green/50 border-spike-green/30',
      selectionMode && 'cursor-pointer'
    )}>
      {/* Top glow for top 3 */}
      {spike.rank <= 3 && (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-spike-cyan to-transparent rounded-t-2xl" />
      )}

      {/* Selection checkbox (visible in selection mode or always visible on hover) */}
      <div className={cn(
        'absolute top-4 right-4 z-10 transition-opacity',
        selectionMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      )}>
        <button
          onClick={handleCheckbox}
          className={cn(
            'w-7 h-7 rounded-lg border-2 flex items-center justify-center transition-all',
            selected
              ? 'bg-spike-green border-spike-green text-spike-bg'
              : 'border-spike-border hover:border-spike-cyan/50 bg-spike-bg/50'
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

      <div className="flex items-start gap-4">
        {/* Rank badge */}
        <div className={cn('rank-badge flex-shrink-0', rankClass)}>
          {spike.rank}
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <a href={`https://finance.yahoo.com/quote/${spike.ticker}`} target="_blank" rel="noopener noreferrer" title={`View ${spike.ticker} on Yahoo Finance`} className="text-lg font-bold text-spike-text hover:text-spike-cyan transition-colors">{spike.ticker}</a>
            <span className="text-xs px-2 py-0.5 rounded-full bg-spike-border/50 text-spike-text-dim flex-shrink-0">
              {spike.exchange}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-spike-violet/10 text-spike-violet flex-shrink-0">
              {spike.sector}
            </span>
          </div>
          <p className="text-sm text-spike-text-dim line-clamp-2">{spike.name}</p>

          {/* Price */}
          <div className="flex items-baseline gap-3 mt-2">
            <span className="text-2xl font-bold mono">{formatCurrency(spike.price)}</span>
          </div>
        </div>

        {/* Spike Score */}
        <div className="flex-shrink-0 text-center mr-8">
          <div className={cn(
            'w-16 h-16 rounded-xl flex items-center justify-center font-bold text-xl mono',
            spike.spikeScore >= 80 ? 'bg-spike-green/15 text-spike-green border border-spike-green/30' :
            spike.spikeScore >= 60 ? 'bg-spike-amber/15 text-spike-amber border border-spike-amber/30' :
            'bg-spike-red/15 text-spike-red border border-spike-red/30'
          )}>
            {spike.spikeScore.toFixed(0)}
          </div>
          <p className="text-[10px] text-spike-text-muted mt-1 uppercase tracking-wider">Score</p>
        </div>
      </div>

      {/* Predicted Returns */}
      <div className="grid grid-cols-3 gap-3 mt-4">
        {[
          { label: '3-Day', value: spike.predicted3Day, color: 'text-spike-green' },
          { label: '5-Day', value: spike.predicted5Day, color: 'text-spike-cyan' },
          { label: '8-Day', value: spike.predicted8Day, color: 'text-spike-violet' },
        ].map((pred) => (
          <div key={pred.label} className="bg-spike-bg/50 rounded-lg p-3 text-center">
            <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">{pred.label}</p>
            <p className={cn('text-lg font-bold mono', pred.value ? pred.color : 'text-spike-text-muted')}>
              {pred.value ? formatPercent(pred.value) : '--'}
            </p>
          </div>
        ))}
      </div>

      {/* Dual confidence meter */}
      <div className="mt-3">
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-xs text-spike-text-muted uppercase tracking-wider font-medium">Confidence</span>
          {spike.overconfidenceFlag && (
            <span className={cn(
              'text-xs font-medium',
              spike.spikeScore >= 80 ? 'text-spike-green' : spike.spikeScore >= 60 ? 'text-spike-amber' : 'text-spike-red'
            )} title="Council confidence exceeds historical hit rate by &gt;10 points">Council Optimistic</span>
          )}
        </div>
        {/* Council bar */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs text-spike-text-muted w-14 font-medium">Council</span>
          <div className="flex-1 h-2 bg-spike-bg rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000"
              style={{
                width: `${spike.confidence}%`,
                background: spike.confidence >= 80
                  ? 'linear-gradient(90deg, rgba(0,255,136,0.3), #00FF88)'
                  : spike.confidence >= 60
                  ? 'linear-gradient(90deg, rgba(255,184,0,0.3), #FFB800)'
                  : 'linear-gradient(90deg, rgba(255,51,102,0.3), #FF3366)',
              }}
            />
          </div>
          <span className="text-xs mono text-spike-text-dim w-9 text-right">{spike.confidence.toFixed(0)}%</span>
        </div>
        {/* Smart bar — Institutional Conviction Score (inline "No Scoring" placeholder when insufficient data) */}
        <div className="flex items-center gap-2 mb-1.5"
             title={spike.institutionalConvictionScore != null
               ? "Insider activity, institutional ownership, analyst consensus, and sector strength combined (0-100)"
               : "No insider trades, institutional ownership, analyst data, or sector relative strength available"}>
          <span className="text-xs text-spike-text-muted w-14 font-medium">Smart</span>
          {spike.institutionalConvictionScore != null ? (
            <>
              <div className="flex-1 h-2 bg-spike-bg rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-1000 opacity-80"
                  style={{
                    width: `${spike.institutionalConvictionScore}%`,
                    background: spike.institutionalConvictionScore >= 80
                      ? 'linear-gradient(90deg, rgba(0,255,136,0.3), #00FF88)'
                      : spike.institutionalConvictionScore >= 60
                      ? 'linear-gradient(90deg, rgba(255,184,0,0.3), #FFB800)'
                      : 'linear-gradient(90deg, rgba(255,51,102,0.3), #FF3366)',
                  }}
                />
              </div>
              <span className="text-xs mono text-spike-text-dim w-9 text-right">{spike.institutionalConvictionScore}%</span>
            </>
          ) : (
            <span className="flex-1 text-xs text-spike-text-muted italic">No Scoring — Insufficient Data</span>
          )}
        </div>
        {/* Hit Rate bar — renamed from History, with low-confidence cue when n<100 and inline placeholder when missing */}
        {(() => {
          const rate = spike.historicalConfidence;
          const n = spike.calibrationSamples;
          const hasData = rate != null && n != null && n > 0;

          if (!hasData) {
            return (
              <div className="flex items-center gap-2 mb-1.5"
                   title="No similar historical setups available for calibration">
                <span className="text-xs text-spike-text-muted w-14 font-medium">Hit Rate</span>
                <span className="flex-1 text-xs text-spike-text-muted italic">No History — Insufficient Data</span>
              </div>
            );
          }

          const lowSample = n < 100;
          const opacityClass = lowSample ? 'opacity-30' : 'opacity-60';
          const labelSuffix = lowSample ? ' ⚠' : '';
          const tooltipText = lowSample
            ? `Based on N=${n.toLocaleString()} similar historical setups (low sample — treat as directional only)`
            : `Based on N=${n.toLocaleString()} similar historical setups`;

          return (
            <div className="flex items-center gap-2" title={tooltipText}>
              <span className="text-xs text-spike-text-muted w-14 font-medium">Hit Rate{labelSuffix}</span>
              <div className="flex-1 h-2 bg-spike-bg rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ${opacityClass}`}
                  style={{
                    width: `${rate}%`,
                    background: rate >= 80
                      ? 'linear-gradient(90deg, rgba(0,255,136,0.3), #00FF88)'
                      : rate >= 60
                      ? 'linear-gradient(90deg, rgba(255,184,0,0.3), #FFB800)'
                      : 'linear-gradient(90deg, rgba(255,51,102,0.3), #FF3366)',
                  }}
                />
              </div>
              <span className="text-xs mono text-spike-text-dim w-9 text-right">{rate.toFixed(0)}%</span>
            </div>
          );
        })()}
      </div>

      {/* Plain-language reasoning summary (always visible) */}
      {spike.narrative && (
        <div className="mt-3 p-3 bg-spike-bg/40 rounded-lg border border-spike-border/30">
          <div className="flex items-center gap-2 mb-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00F0FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="text-[10px] text-spike-cyan uppercase tracking-wider font-semibold">Why This Stock?</span>
          </div>
          <p className="text-sm text-spike-text-dim leading-relaxed">{spike.narrative}</p>
        </div>
      )}

      {/* Actions row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mt-4 pt-3 border-t border-spike-border/30 gap-3">
        <div className="flex gap-4 text-xs text-spike-text-muted mono">
          <span>Vol: {formatVolume(spike.technicals?.obv || 0)}</span>
          <span>RSI: {spike.technicals?.rsi?.toFixed(0) || '--'}</span>
          <span>ADX: {spike.technicals?.adx?.toFixed(0) || '--'}</span>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* View Full Analysis link */}
          <Link
            href={`/dashboard/analysis/${spike.id}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-spike-cyan bg-spike-cyan/5 border border-spike-cyan/15 hover:bg-spike-cyan/10 hover:border-spike-cyan/30 transition-all"
            title="See the full AI analysis for this stock"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
            View Analysis
          </Link>

          {/* Lock In button (only when NOT in bulk selection mode) */}
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
