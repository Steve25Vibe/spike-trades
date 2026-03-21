'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/layout/Sidebar';
import ParticleBackground from '@/components/layout/ParticleBackground';
import { cn, formatCurrency, formatPercent } from '@/lib/utils';
import CsvImportExport from '@/components/portfolio/CsvImportExport';

interface Position {
  id: string;
  spikeId: string;
  ticker: string;
  name: string;
  entryPrice: number;
  currentPrice: number;
  shares: number;
  positionSize: number;
  currentValue: number;
  positionPct: number;
  portfolioWeight: number;
  target3Day: number;
  target5Day: number;
  target8Day: number;
  stopLoss: number;
  entryDate: string;
  daysHeld: number;
  exitPrice: number | null;
  exitDate: string | null;
  exitReason: string | null;
  realizedPnl: number | null;
  realizedPnlPct: number | null;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  progressTo3Day: number;
  riskStatus: 'on_track' | 'caution' | 'danger' | 'target_hit';
  status: string;
  spikeScore: number;
  originalConfidence: number;
  spikeNarrative: string;
}

interface Summary {
  activePositions: number;
  totalInvested: number;
  totalCurrentValue: number;
  totalUnrealizedPnl: number;
  totalUnrealizedPnlPct: number;
  totalRealizedPnl: number;
  totalCombinedPnl: number;
  winRate: number;
  avgReturn: number;
  totalTrades: number;
  bestPosition: Position | null;
  worstPosition: Position | null;
}

export default function PortfolioPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<'active' | 'closed' | 'all'>('active');
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { fetchPortfolio(); }, [filter]);

  const fetchPortfolio = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/portfolio?status=${filter}&t=${Date.now()}`, { cache: 'no-store' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (json.success) {
        setPositions(json.data.positions);
        setSummary(json.data.summary);
      }
    } catch { /* handle */ }
    finally { setLoading(false); }
  };

  const handleClosePosition = async (positionId: string) => {
    setClosing(positionId);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId, exitReason: 'manual' }),
      });
      const json = await res.json();
      if (json.success) {
        setToast(`Closed ${json.data.ticker} — ${json.data.realizedPnlPct >= 0 ? '+' : ''}${json.data.realizedPnlPct.toFixed(2)}% (${formatCurrency(json.data.realizedPnl)})`);
        setTimeout(() => setToast(null), 4000);
        // Immediately remove from UI, then refresh from server
        setPositions((prev) => prev.filter((p) => p.id !== positionId));
        setClosing(null);
        setCloseConfirm(null);
        await fetchPortfolio();
        return;
      }
    } catch { /* handle */ }
    finally {
      setClosing(null);
      setCloseConfirm(null);
    }
  };

  const riskColors = {
    on_track: 'text-spike-green',
    caution: 'text-spike-amber',
    danger: 'text-spike-red',
    target_hit: 'text-spike-gold',
  };

  const riskLabels = {
    on_track: 'On Track',
    caution: 'Caution',
    danger: 'At Risk',
    target_hit: 'Target Hit!',
  };

  return (
    <div className="min-h-screen bg-spike-bg">
      <ParticleBackground />
      <Sidebar />

      <main className="ml-64 p-8 relative z-10">
        <h2 className="text-2xl font-display font-bold text-spike-cyan tracking-wide mb-6">
          PORTFOLIO
        </h2>

        {/* Toast */}
        {toast && (
          <div className="mb-4 p-4 rounded-xl bg-spike-green/10 border border-spike-green/30 text-spike-green font-medium text-sm animate-fade-in flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            {toast}
          </div>
        )}

        {/* Summary — redesigned with live P&L */}
        {summary && (
          <div className="grid grid-cols-6 gap-3 mb-6">
            {[
              { label: 'Active Positions', value: summary.activePositions.toString(), color: 'text-spike-cyan' },
              { label: 'Total Invested', value: formatCurrency(summary.totalInvested), color: 'text-spike-text' },
              { label: 'Current Value', value: formatCurrency(summary.totalCurrentValue), color: 'text-spike-text' },
              { label: 'Unrealized P&L', value: `${summary.totalUnrealizedPnl >= 0 ? '+' : ''}${formatCurrency(summary.totalUnrealizedPnl)}`, sub: formatPercent(summary.totalUnrealizedPnlPct), color: summary.totalUnrealizedPnl >= 0 ? 'text-spike-green' : 'text-spike-red' },
              { label: 'Realized P&L', value: formatCurrency(summary.totalRealizedPnl), color: summary.totalRealizedPnl >= 0 ? 'text-spike-green' : 'text-spike-red' },
              { label: 'Win Rate', value: `${summary.winRate.toFixed(0)}%`, sub: `${summary.totalTrades} trades`, color: summary.winRate >= 50 ? 'text-spike-green' : 'text-spike-amber' },
            ].map((stat) => (
              <div key={stat.label} className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">{stat.label}</p>
                <p className={`text-lg font-bold mono ${stat.color}`}>{stat.value}</p>
                {(stat as any).sub && <p className={`text-xs mono ${stat.color}`}>{(stat as any).sub}</p>}
              </div>
            ))}
          </div>
        )}

        {/* Best/Worst position highlight */}
        {summary?.bestPosition && summary?.worstPosition && filter === 'active' && (
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="glass-card p-4 border-spike-green/20 flex items-center gap-4">
              <div className="w-10 h-10 rounded-lg bg-spike-green/10 flex items-center justify-center text-spike-green text-lg">↑</div>
              <div>
                <p className="text-[10px] text-spike-text-muted uppercase tracking-wider">Best Position</p>
                <p className="font-bold text-spike-text">{summary.bestPosition.ticker} <span className="text-spike-green mono text-sm">{formatPercent(summary.bestPosition.unrealizedPnlPct)}</span></p>
              </div>
            </div>
            <div className="glass-card p-4 border-spike-red/20 flex items-center gap-4">
              <div className="w-10 h-10 rounded-lg bg-spike-red/10 flex items-center justify-center text-spike-red text-lg">↓</div>
              <div>
                <p className="text-[10px] text-spike-text-muted uppercase tracking-wider">Worst Position</p>
                <p className="font-bold text-spike-text">{summary.worstPosition.ticker} <span className="text-spike-red mono text-sm">{formatPercent(summary.worstPosition.unrealizedPnlPct)}</span></p>
              </div>
            </div>
          </div>
        )}

        {/* Filter tabs + CSV import/export */}
        <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          {(['active', 'closed', 'all'] as const).map((f) => {
            const tooltips: Record<string, string> = {
              active: 'Show stocks you currently hold',
              closed: 'Show positions you\'ve sold',
              all: 'Show all positions, active and closed',
            };
            return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              title={tooltips[f]}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium transition-all capitalize',
                filter === f
                  ? 'bg-spike-cyan/10 text-spike-cyan border border-spike-cyan/20'
                  : 'text-spike-text-dim hover:text-spike-text hover:bg-spike-bg-hover'
              )}
            >
              {f}
            </button>);
          })}
        </div>
          <CsvImportExport onImportComplete={fetchPortfolio} />
        </div>

        {/* Position cards (active) or table (closed) */}
        {filter !== 'closed' ? (
          <div className="space-y-3">
            {positions.filter((p) => filter === 'all' || p.status === 'active').map((pos) => (
              pos.status === 'active' ? (
                <div key={pos.id} className={cn(
                  'glass-card p-5 transition-all',
                  pos.riskStatus === 'danger' && 'border-spike-red/30',
                  pos.riskStatus === 'target_hit' && 'border-spike-gold/30',
                )}>
                  <div className="flex items-start justify-between gap-6">
                    {/* Left: Ticker + meta */}
                    <div className="flex items-center gap-4 min-w-0">
                      <div>
                        <div className="flex items-center gap-2">
                          <Link href={`/dashboard/analysis/${pos.spikeId}`} title="See the full AI analysis for this stock" className="text-xl font-bold text-spike-text hover:text-spike-cyan transition-colors">
                            {pos.ticker}
                          </Link>
                          <span className={cn('text-xs px-2 py-0.5 rounded-full font-semibold', riskColors[pos.riskStatus], `bg-current/10`)}>
                            <span className={riskColors[pos.riskStatus]}>{riskLabels[pos.riskStatus]}</span>
                          </span>
                        </div>
                        <p className="text-sm text-spike-text-dim">{pos.name}</p>
                        <p className="text-xs text-spike-text-muted mt-0.5">
                          Entered {new Date(pos.entryDate).toLocaleDateString('en-CA')} &middot; {pos.daysHeld} day{pos.daysHeld !== 1 ? 's' : ''} held &middot; Score: {pos.spikeScore?.toFixed(0)}
                        </p>
                      </div>
                    </div>

                    {/* Center: P&L */}
                    <div className="text-center flex-shrink-0">
                      <p className={cn('text-2xl font-bold mono', pos.unrealizedPnl >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                        {pos.unrealizedPnl >= 0 ? '+' : ''}{formatCurrency(pos.unrealizedPnl)}
                      </p>
                      <p className={cn('text-sm mono', pos.unrealizedPnlPct >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                        {formatPercent(pos.unrealizedPnlPct)}
                      </p>
                    </div>

                    {/* Right: Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Link
                        href={`/dashboard/analysis/${pos.spikeId}`}
                        className="px-3 py-2 rounded-lg text-xs font-medium text-spike-cyan bg-spike-cyan/5 border border-spike-cyan/15 hover:bg-spike-cyan/10 transition-all"
                        title="See the full AI analysis for this stock"
                      >
                        View Analysis
                      </Link>
                      {closeConfirm === pos.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleClosePosition(pos.id)}
                            disabled={closing === pos.id}
                            className="px-3 py-2 rounded-lg text-xs font-bold text-spike-red bg-spike-red/10 border border-spike-red/30 hover:bg-spike-red/20 transition-all disabled:opacity-50"
                          >
                            {closing === pos.id ? 'Closing...' : 'Confirm Sell'}
                          </button>
                          <button
                            onClick={() => setCloseConfirm(null)}
                            className="px-2 py-2 rounded-lg text-xs text-spike-text-muted hover:text-spike-text"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setCloseConfirm(pos.id)}
                          className="px-3 py-2 rounded-lg text-xs font-medium text-spike-text-dim bg-spike-bg border border-spike-border hover:border-spike-red/30 hover:text-spike-red transition-all"
                          title="Close this position and record the result"
                        >
                          Sell / Close
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Price details row */}
                  <div className="grid grid-cols-7 gap-3 mt-4 pt-3 border-t border-spike-border/20">
                    {[
                      { label: 'Entry', value: formatCurrency(pos.entryPrice), color: 'text-spike-text' },
                      { label: 'Current', value: formatCurrency(pos.currentPrice), color: pos.currentPrice >= pos.entryPrice ? 'text-spike-green' : 'text-spike-red' },
                      { label: 'Shares', value: pos.shares.toString(), color: 'text-spike-text' },
                      { label: 'Target 3D', value: formatCurrency(pos.target3Day), color: 'text-spike-green' },
                      { label: 'Target 5D', value: formatCurrency(pos.target5Day), color: 'text-spike-cyan' },
                      { label: 'Target 8D', value: formatCurrency(pos.target8Day), color: 'text-spike-violet' },
                      { label: 'Stop Loss', value: formatCurrency(pos.stopLoss), color: 'text-spike-red' },
                    ].map((cell) => (
                      <div key={cell.label} className="text-center">
                        <p className="text-[9px] text-spike-text-muted uppercase tracking-wider">{cell.label}</p>
                        <p className={`text-sm font-bold mono ${cell.color}`}>{cell.value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Progress toward 3-day target */}
                  <div className="mt-3">
                    <div className="flex justify-between text-[10px] text-spike-text-muted mb-1">
                      <span>Progress to 3-Day Target</span>
                      <span className="mono">{Math.round(Math.max(0, Math.min(pos.progressTo3Day, 100)))}%</span>
                    </div>
                    <div className="h-1.5 bg-spike-bg rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all duration-500',
                          pos.progressTo3Day >= 100 ? 'bg-spike-gold' :
                          pos.progressTo3Day >= 0 ? 'bg-gradient-to-r from-spike-cyan to-spike-green' :
                          'bg-spike-red'
                        )}
                        style={{ width: `${Math.max(0, Math.min(pos.progressTo3Day, 100))}%` }}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                /* Closed position — compact row */
                <div key={pos.id} className="glass-card p-4 opacity-70 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-spike-text-dim">{pos.ticker}</span>
                    <span className="text-xs text-spike-text-muted">{pos.name}</span>
                    <span className="text-xs text-spike-text-muted">Closed {pos.exitDate ? new Date(pos.exitDate).toLocaleDateString('en-CA') : ''}</span>
                    <span className="text-xs text-spike-text-muted italic capitalize">{pos.exitReason}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="mono text-sm text-spike-text-muted">{formatCurrency(pos.entryPrice)} → {formatCurrency(pos.exitPrice || 0)}</span>
                    <span className={cn('mono text-sm font-bold', (pos.realizedPnlPct || 0) >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                      {formatPercent(pos.realizedPnlPct || 0)}
                    </span>
                    <span className={cn('mono text-sm', (pos.realizedPnl || 0) >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                      {formatCurrency(pos.realizedPnl || 0)}
                    </span>
                  </div>
                </div>
              )
            ))}

            {positions.length === 0 && !loading && (
              <div className="glass-card p-12 text-center">
                <p className="text-spike-text-dim">
                  {filter === 'active' ? 'No active positions.' : 'No closed positions yet.'}
                </p>
                <Link href="/dashboard" className="text-spike-cyan text-sm mt-3 inline-block hover:underline">
                  ← Go pick some spikes
                </Link>
              </div>
            )}
          </div>
        ) : (
          /* Closed positions table view */
          <div className="glass-card overflow-hidden">
            <table className="w-full spike-table">
              <thead>
                <tr className="border-b border-spike-border">
                  {['Ticker', 'Entry', 'Exit', 'Shares', 'P&L ($)', 'P&L (%)', 'Reason', 'Held', 'Closed'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] text-spike-text-muted uppercase tracking-wider font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => (
                  <tr key={pos.id} className="border-b border-spike-border/30 hover:bg-spike-bg-hover/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-bold text-spike-text">{pos.ticker}</div>
                      <div className="text-xs text-spike-text-dim">{pos.name}</div>
                    </td>
                    <td className="px-4 py-3 mono text-sm">{formatCurrency(pos.entryPrice)}</td>
                    <td className="px-4 py-3 mono text-sm">{formatCurrency(pos.exitPrice || 0)}</td>
                    <td className="px-4 py-3 mono text-sm">{pos.shares}</td>
                    <td className={cn('px-4 py-3 mono text-sm font-bold', (pos.realizedPnl || 0) >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                      {(pos.realizedPnl || 0) >= 0 ? '+' : ''}{formatCurrency(pos.realizedPnl || 0)}
                    </td>
                    <td className={cn('px-4 py-3 mono text-sm font-bold', (pos.realizedPnlPct || 0) >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                      {formatPercent(pos.realizedPnlPct || 0)}
                    </td>
                    <td className="px-4 py-3 text-xs text-spike-text-dim capitalize">{pos.exitReason || '—'}</td>
                    <td className="px-4 py-3 mono text-xs text-spike-text-dim">{pos.daysHeld}d</td>
                    <td className="px-4 py-3 text-xs text-spike-text-dim">
                      {pos.exitDate ? new Date(pos.exitDate).toLocaleDateString('en-CA') : '—'}
                    </td>
                  </tr>
                ))}
                {positions.length === 0 && !loading && (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-spike-text-dim">No closed trades yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="legal-footer">
          <p>For educational and informational purposes only. Not financial advice. Past performance is no guarantee of future results.</p>
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca</p>
        </div>
      </main>
    </div>
  );
}
