'use client';

import React, { useState, useEffect } from 'react';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import { cn } from '@/lib/utils';
// recharts removed — no charts on this page currently

// ---- Types ----

interface Scorecard {
  horizon: number;
  wins: number;
  losses: number;
  total: number;
  winRate: number | null;
  avgReturn: number | null;
  indexValue: number;
  hasData: boolean;
}

interface RecentPick {
  date: string;
  ticker: string;
  name: string;
  rank: number;
  score: number;
  predicted3: number;
  predicted5: number;
  predicted8: number;
  actual3: number | null;
  actual5: number | null;
  actual8: number | null;
}

interface IndexValues {
  day3: number;
  day5: number;
  day8: number;
}

// ---- Constants ----

const HORIZON_COLORS = {
  3: { main: '#00F0FF', dim: '#00F0FF80', label: '3-Day' },
  5: { main: '#00FF88', dim: '#00FF8880', label: '5-Day' },
  8: { main: '#A855F7', dim: '#A855F780', label: '8-Day' },
};

// ---- Page ----

export default function AccuracyPage() {
  const [scorecards, setScorecards] = useState<Scorecard[]>([]);
  const [recentPicks, setRecentPicks] = useState<RecentPick[]>([]);
  const [indexValues, setIndexValues] = useState<IndexValues>({ day3: 100, day5: 100, day8: 100 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;

  useEffect(() => {
    fetchAccuracy();
  }, []);

  const fetchAccuracy = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/accuracy?days=90');
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (json.success) {
        setScorecards(json.data.scorecards || []);
        setRecentPicks(json.data.recentPicks || []);
        setIndexValues(json.data.indexValues || { day3: 100, day5: 100, day8: 100 });
      }
    } catch { /* handle */ }
    finally { setLoading(false); }
  };

  return (
    <ResponsiveLayout>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <h2 className="text-xl sm:text-2xl font-display font-bold text-spike-cyan tracking-wide">
            ACCURACY ENGINE
          </h2>
          <div className="flex items-center gap-2">
            {([3, 5, 8] as const).map((h) => {
              const idx = indexValues[`day${h}` as keyof IndexValues];
              const hasData = scorecards.find((s) => s.horizon === h)?.hasData;
              const { main, label } = HORIZON_COLORS[h];
              return (
                <div key={h} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-spike-bg-card border border-spike-border">
                  <span className="w-2 h-2 rounded-full" style={{ background: main }} />
                  <span className="text-xs text-spike-text-dim">{label}</span>
                  <span className={cn('text-xs mono font-bold', hasData ? (idx >= 100 ? 'text-spike-green' : 'text-spike-red') : 'text-spike-text-muted')}>
                    {hasData ? idx.toFixed(1) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ============================================================ */}
        {/* Horizon Scorecards */}
        {/* ============================================================ */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {([3, 5, 8] as const).map((h) => {
            const card = scorecards.find((s) => s.horizon === h);
            const { main, label } = HORIZON_COLORS[h];

            if (!card || !card.hasData) {
              return (
                <div key={h} className="glass-card p-5 text-center">
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <span className="w-3 h-3 rounded-full" style={{ background: main }} />
                    <span className="text-sm font-bold text-spike-text uppercase tracking-wider">{label}</span>
                  </div>
                  <p className="text-spike-text-muted text-sm">Awaiting Data</p>
                  <p className="text-spike-text-dim text-xs mt-1">
                    Results appear {h} trading days after picks are made
                  </p>
                </div>
              );
            }

            const winPct = card.winRate || 0;
            const winBarWidth = card.total > 0 ? (card.wins / card.total) * 100 : 0;

            return (
              <div key={h} className="glass-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ background: main }} />
                    <span className="text-sm font-bold text-spike-text uppercase tracking-wider">{label}</span>
                  </div>
                  <span className="text-xs text-spike-text-dim mono">
                    Index: {card.indexValue.toFixed(1)}
                  </span>
                </div>

                {/* Big win rate number */}
                <div className="text-center mb-3">
                  <p className={cn(
                    'text-3xl font-bold mono',
                    winPct >= 55 ? 'text-spike-green' : winPct >= 50 ? 'text-spike-amber' : 'text-spike-red'
                  )}>
                    {winPct.toFixed(1)}%
                  </p>
                  <p className="text-xs text-spike-text-dim">Win Rate</p>
                </div>

                {/* W-L record */}
                <div className="flex items-center justify-center gap-3 mb-3">
                  <span className="text-sm font-medium text-spike-green mono">{card.wins}W</span>
                  <span className="text-spike-text-muted">—</span>
                  <span className="text-sm font-medium text-spike-red mono">{card.losses}L</span>
                </div>

                {/* Win/Loss bar */}
                <div className="w-full h-3 rounded-full bg-spike-red/30 overflow-hidden mb-2">
                  <div
                    className="h-full rounded-full bg-spike-green/80 transition-all"
                    style={{ width: `${winBarWidth}%` }}
                  />
                </div>

                {/* Avg return */}
                <p className="text-center text-xs text-spike-text-dim">
                  Avg Return:{' '}
                  <span className={cn('mono font-medium', (card.avgReturn || 0) >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                    {(card.avgReturn || 0) >= 0 ? '+' : ''}{(card.avgReturn || 0).toFixed(2)}%
                  </span>
                  {' '}per pick
                </p>
              </div>
            );
          })}
        </div>

        {/* ============================================================ */}
        {/* Pick Results Table — Winners first, paginated */}
        {/* ============================================================ */}
        {(() => {
          // Sort: winners first (best return desc), then losers (least negative first), then no-data
          const sorted = [...recentPicks].sort((a, b) => {
            const aActuals = [a.actual3, a.actual5, a.actual8].filter((v): v is number => v !== null);
            const bActuals = [b.actual3, b.actual5, b.actual8].filter((v): v is number => v !== null);
            const aHasData = aActuals.length > 0;
            const bHasData = bActuals.length > 0;
            const aBest = aHasData ? Math.max(...aActuals) : -Infinity;
            const bBest = bHasData ? Math.max(...bActuals) : -Infinity;
            const aIsWinner = aHasData && aActuals.some((v) => v >= 0);
            const bIsWinner = bHasData && bActuals.some((v) => v >= 0);

            // 1. Picks with data before picks without
            if (aHasData && !bHasData) return -1;
            if (!aHasData && bHasData) return 1;
            if (!aHasData && !bHasData) {
              // Both no data: newest date first, then score desc
              const dateCmp = new Date(b.date).getTime() - new Date(a.date).getTime();
              return dateCmp !== 0 ? dateCmp : b.score - a.score;
            }
            // 2. Winners before losers
            if (aIsWinner && !bIsWinner) return -1;
            if (!aIsWinner && bIsWinner) return 1;
            // 3. Best actual return descending
            return bBest - aBest;
          });

          const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
          const pagePicks = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

          // Detect date boundaries for separator rows
          let lastDate = '';

          return (
            <div className="glass-card p-6">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider">
                  Pick Results
                </h3>
                {sorted.length > 0 && (
                  <span className="text-xs text-spike-text-muted mono">
                    {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
                  </span>
                )}
              </div>
              <p className="text-xs text-spike-text-muted mb-4">
                Winners first — predicted vs actual across all three horizons
              </p>
              {pagePicks.length > 0 ? (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-spike-border text-spike-text-dim text-[10px] uppercase tracking-wider">
                          <th className="py-2 px-2 text-left">Ticker</th>
                          <th className="py-2 px-2 text-left">Date</th>
                          <th className="py-2 px-2 text-center">#</th>
                          <th className="py-2 px-1 text-right" title="3-Day Predicted">
                            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: HORIZON_COLORS[3].main }} />3D Pred
                          </th>
                          <th className="py-2 px-1 text-right" title="3-Day Actual">3D Act</th>
                          <th className="py-2 px-1 text-right" title="5-Day Predicted">
                            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: HORIZON_COLORS[5].main }} />5D Pred
                          </th>
                          <th className="py-2 px-1 text-right" title="5-Day Actual">5D Act</th>
                          <th className="py-2 px-1 text-right" title="8-Day Predicted">
                            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: HORIZON_COLORS[8].main }} />8D Pred
                          </th>
                          <th className="py-2 px-1 text-right" title="8-Day Actual">8D Act</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagePicks.map((pick, idx) => {
                          const pickDate = new Date(pick.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
                          const showDateSep = pickDate !== lastDate;
                          lastDate = pickDate;

                          const anyPositive = [pick.actual3, pick.actual5, pick.actual8].some((v) => v !== null && v >= 0);
                          const anyActual = [pick.actual3, pick.actual5, pick.actual8].some((v) => v !== null);

                          return (
                            <React.Fragment key={`${pick.ticker}-${pick.date}-${idx}`}>
                              {showDateSep && (
                                <tr>
                                  <td colSpan={9} className="py-1.5 px-2 text-[10px] text-spike-text-muted uppercase tracking-wider bg-spike-bg-card/50 border-b border-spike-border/20">
                                    {pickDate}
                                  </td>
                                </tr>
                              )}
                              <tr
                                className={cn(
                                  'border-b border-spike-border/30 transition-colors hover:bg-spike-bg-hover',
                                  anyActual && anyPositive ? 'bg-spike-green/[0.03]' : anyActual ? 'bg-spike-red/[0.03]' : ''
                                )}
                              >
                                <td className="py-2 px-2">
                                  <a
                                    href={`https://finance.yahoo.com/quote/${pick.ticker}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-spike-cyan hover:underline font-medium text-xs"
                                    title={pick.name}
                                  >
                                    {pick.ticker.replace('.TO', '')}
                                  </a>
                                </td>
                                <td className="py-2 px-2 text-spike-text-dim text-xs mono">
                                  {pickDate}
                                </td>
                                <td className="py-2 px-2 text-center text-spike-text-dim text-xs">
                                  #{pick.rank}
                                </td>
                                <ActualCell predicted={pick.predicted3} actual={null} isPred />
                                <ActualCell predicted={pick.predicted3} actual={pick.actual3} />
                                <ActualCell predicted={pick.predicted5} actual={null} isPred />
                                <ActualCell predicted={pick.predicted5} actual={pick.actual5} />
                                <ActualCell predicted={pick.predicted8} actual={null} isPred />
                                <ActualCell predicted={pick.predicted8} actual={pick.actual8} />
                              </tr>
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-spike-border/30">
                      <button
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        disabled={page === 0}
                        className={cn(
                          'px-4 py-2 rounded-lg text-xs font-medium transition-all',
                          page === 0
                            ? 'text-spike-text-muted cursor-not-allowed'
                            : 'text-spike-cyan hover:bg-spike-cyan/10 border border-spike-cyan/20'
                        )}
                      >
                        Previous
                      </button>
                      <span className="text-xs text-spike-text-dim mono">
                        Page {page + 1} of {totalPages}
                      </span>
                      <button
                        onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                        disabled={page >= totalPages - 1}
                        className={cn(
                          'px-4 py-2 rounded-lg text-xs font-medium transition-all',
                          page >= totalPages - 1
                            ? 'text-spike-text-muted cursor-not-allowed'
                            : 'text-spike-cyan hover:bg-spike-cyan/10 border border-spike-cyan/20'
                        )}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="py-12 text-center text-spike-text-muted text-sm">
                  {loading ? 'Loading...' : 'No picks data yet.'}
                </div>
              )}
            </div>
          );
        })()}

        <div className="legal-footer">
          <p>
            For educational and informational purposes only. Not financial advice.
            Past performance is no guarantee of future results.
            Trading stocks involves risk. You may lose your entire investment.
          </p>
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca &middot; Ver 3.5</p>
        </div>
    </ResponsiveLayout>
  );
}

// ---- Helper Component: Predicted/Actual table cell ----

function ActualCell({ predicted, actual, isPred }: { predicted: number; actual: number | null; isPred?: boolean }) {
  if (isPred) {
    return (
      <td className="py-2 px-1 text-right mono text-xs text-spike-text-dim">
        {predicted >= 0 ? '+' : ''}{predicted.toFixed(1)}%
      </td>
    );
  }

  if (actual === null) {
    return (
      <td className="py-2 px-1 text-right mono text-xs text-spike-text-muted">
        —
      </td>
    );
  }

  const hit = (predicted >= 0 && actual >= 0) || (predicted < 0 && actual < 0);

  return (
    <td className={cn(
      'py-2 px-1 text-right mono text-xs font-medium',
      actual >= 0 ? 'text-spike-green' : 'text-spike-red'
    )}>
      {actual >= 0 ? '+' : ''}{actual.toFixed(1)}%
      <span className="ml-0.5 text-[9px]">{hit ? '✓' : '✗'}</span>
    </td>
  );
}
