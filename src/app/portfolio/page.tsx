'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import { cn, formatCurrency, formatPercent } from '@/lib/utils';
import CsvImportExport from '@/components/portfolio/CsvImportExport';
import { usePortfolios, setActivePortfolioId } from '@/components/portfolio/usePortfolios';
import { getLocalConfig } from '@/components/portfolio/PortfolioSettings';
import SpikeItModal from '@/components/portfolio/SpikeItModal';

function isMarketOpen(): boolean {
  const now = new Date();
  // Convert to AST (America/Halifax = UTC-4 standard, UTC-3 daylight)
  const ast = new Date(now.toLocaleString('en-US', { timeZone: 'America/Halifax' }));
  const day = ast.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hours = ast.getHours();
  const minutes = ast.getMinutes();
  const timeInMinutes = hours * 60 + minutes;
  // 10:30 AM = 630 min, 5:00 PM = 1020 min (AST)
  return timeInMinutes >= 630 && timeInMinutes <= 1020;
}

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
  const filter = 'active' as const;
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<string | null>(null);
  const [sellModal, setSellModal] = useState<Position | null>(null);
  const [sellShares, setSellShares] = useState<number>(0);
  const [spikeItTicker, setSpikeItTicker] = useState<{ ticker: string; name: string; entryPrice: number } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkClosing, setBulkClosing] = useState(false);
  const [bulkCloseConfirm, setBulkCloseConfirm] = useState(false);
  const [showNewPortfolio, setShowNewPortfolio] = useState(false);
  const [newPortfolioName, setNewPortfolioName] = useState('');
  const [showChoosePortfolio, setShowChoosePortfolio] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteSelectedIds, setDeleteSelectedIds] = useState<Set<string>>(new Set());
  const [deleteStep, setDeleteStep] = useState<'select' | 'close_positions' | 'confirm_delete'>('select');
  const [deleting, setDeleting] = useState(false);

  const { portfolios, activeId, selectPortfolio, refresh: refreshPortfolios } = usePortfolios();

  useEffect(() => { fetchPortfolio(); }, [filter, activeId]);

  const fetchPortfolio = async () => {
    if (!activeId) {
      setPositions([]);
      setSummary(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: filter, t: Date.now().toString() });
      params.set('portfolioId', activeId);
      const res = await fetch(`/api/portfolio?${params}`, { cache: 'no-store' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (json.success) {
        setPositions(json.data.positions);
        setSummary(json.data.summary);
      }
    } catch { /* handle */ }
    finally { setLoading(false); }
  };

  const handleSellPosition = async (positionId: string, sharesToSell?: number) => {
    setClosing(positionId);
    try {
      const body: Record<string, unknown> = { positionId, exitReason: 'manual' };
      if (sharesToSell) body.sharesToSell = sharesToSell;
      const res = await fetch('/api/portfolio', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        const pnlPct = json.data.realizedPnlPct ?? 0;
        const pnl = json.data.realizedPnl ?? 0;
        if (json.partial) {
          setToast({ message: `Sold ${json.data.sharesSold} shares of ${json.data.ticker} — ${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)} (${json.data.remainingShares} remaining)`, type: 'success' });
        } else {
          setToast({ message: `Closed ${json.data.ticker} — ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${formatCurrency(pnl)})`, type: 'success' });
        }
        setTimeout(() => setToast(null), 4000);
        setSellModal(null);
        setSellShares(0);
        setClosing(null);
        setCloseConfirm(null);
        await fetchPortfolio();
        refreshPortfolios();
        return;
      }
    } catch { /* handle */ }
    finally {
      setClosing(null);
    }
  };

  const handleSelectPosition = (id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(id); else next.delete(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    const activeIds = positions.filter((p) => p.status === 'active').map((p) => p.id);
    if (selectedIds.size === activeIds.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(activeIds));
    }
  };

  const handleBulkClose = async () => {
    if (selectedIds.size === 0) return;
    setBulkClosing(true);
    let closed = 0;
    let totalPnl = 0;
    for (const positionId of selectedIds) {
      try {
        const res = await fetch('/api/portfolio', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positionId, exitReason: 'manual' }),
        });
        const json = await res.json();
        if (json.success) {
          closed++;
          totalPnl += json.data.realizedPnl ?? 0;
        }
      } catch { /* continue */ }
    }
    setPositions((prev) => prev.filter((p) => !selectedIds.has(p.id)));
    setSelectedIds(new Set());
    setSelectionMode(false);
    setBulkCloseConfirm(false);
    setBulkClosing(false);
    setToast({ message: `Closed ${closed} position${closed !== 1 ? 's' : ''} — ${totalPnl >= 0 ? '+' : ''}${formatCurrency(totalPnl)} realized`, type: 'success' });
    setTimeout(() => setToast(null), 5000);
    await fetchPortfolio();
    refreshPortfolios();
  };

  const handleCreatePortfolio = async () => {
    if (!newPortfolioName.trim()) return;
    const savedConfig = getLocalConfig();
    const res = await fetch('/api/portfolios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newPortfolioName.trim(),
        sizingMode: savedConfig.mode,
        portfolioSize: savedConfig.portfolioSize,
        fixedAmount: savedConfig.fixedAmount,
        kellyMaxPct: savedConfig.kellyMaxPct,
        kellyWinRate: savedConfig.kellyWinRate,
      }),
    });
    const json = await res.json();
    if (json.success) {
      setShowNewPortfolio(false);
      setNewPortfolioName('');
      await refreshPortfolios();
      selectPortfolio(json.data.id);
    }
  };

  const handleOpenDeleteModal = () => {
    setDeleteSelectedIds(new Set());
    setDeleteStep('select');
    setShowDeleteModal(true);
  };

  const handleToggleDeleteSelection = (id: string) => {
    setDeleteSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Step 2: Close all active positions in selected portfolios
  const handleClosePositions = async () => {
    if (deleteSelectedIds.size === 0) return;
    setDeleting(true);
    const errors: string[] = [];
    let totalClosed = 0;
    for (const portfolioId of deleteSelectedIds) {
      const portfolio = portfolios.find((p) => p.id === portfolioId);
      if (portfolio && portfolio.activePositions > 0) {
        // Close positions only (don't delete portfolio yet)
        const res = await fetch('/api/portfolios', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ portfolioId, closePositions: true, deletePortfolio: false }),
        });
        const json = await res.json();
        if (!json.success) {
          errors.push(`${portfolio.name}: ${json.error}`);
        } else {
          totalClosed += json.closedPositions || 0;
        }
      }
    }
    setDeleting(false);
    if (errors.length > 0) {
      setToast({ message: errors.join('; '), type: 'error' });
      setTimeout(() => setToast(null), 5000);
    } else {
      if (totalClosed > 0) {
        setToast({ message: `Closed ${totalClosed} position${totalClosed > 1 ? 's' : ''}. Now confirm portfolio deletion.`, type: 'success' });
        setTimeout(() => setToast(null), 5000);
      }
      // Move to step 3: confirm delete portfolios
      setDeleteStep('confirm_delete');
      await refreshPortfolios();
    }
  };

  // Step 3: Delete the portfolio records themselves
  const handleConfirmDelete = async () => {
    if (deleteSelectedIds.size === 0) return;
    setDeleting(true);
    const errors: string[] = [];
    for (const portfolioId of deleteSelectedIds) {
      const res = await fetch('/api/portfolios', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolioId, closePositions: true }),
      });
      const json = await res.json();
      if (!json.success) {
        const p = portfolios.find((x) => x.id === portfolioId);
        errors.push(`${p?.name || portfolioId}: ${json.error}`);
      }
    }
    const count = deleteSelectedIds.size;
    setDeleting(false);
    setShowDeleteModal(false);
    setDeleteSelectedIds(new Set());
    setDeleteStep('select');
    setPositions([]);
    setSummary(null);
    setActivePortfolioId(null);
    await refreshPortfolios();
    if (errors.length > 0) {
      setToast({ message: errors.join('; '), type: 'error' });
    } else {
      setToast({ message: `Deleted ${count} portfolio${count > 1 ? 's' : ''}`, type: 'success' });
    }
    setTimeout(() => setToast(null), 5000);
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

  const activePortfolio = portfolios.find((p) => p.id === activeId);

  return (
    <ResponsiveLayout>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-display font-bold text-spike-cyan tracking-wide">
            {activePortfolio ? activePortfolio.name : 'Portfolios'}
          </h2>
        </div>

        {/* Portfolio tabs — visible when multiple portfolios exist */}
        {portfolios.length > 1 && (
          <div className="flex gap-2 mb-6 flex-wrap">
            {portfolios.map((p) => (
              <button
                key={p.id}
                onClick={() => selectPortfolio(p.id)}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-all border',
                  p.id === activeId
                    ? 'bg-spike-cyan/10 text-spike-cyan border-spike-cyan/30'
                    : 'text-spike-text-dim border-spike-border hover:border-spike-cyan/20 hover:text-spike-text'
                )}
              >
                {p.name}
                <span className="ml-2 text-xs text-spike-text-muted">({p.activePositions})</span>
              </button>
            ))}
          </div>
        )}

        {!activePortfolio ? (
          <div className="glass-card p-12 text-center mb-6">
            <p className="text-spike-text-dim text-lg mb-4">No portfolios yet.</p>
            <p className="text-spike-text-muted text-sm mb-4">Lock in spikes from the dashboard to create your first portfolio.</p>
            <Link href="/dashboard" className="text-spike-cyan text-sm hover:underline">
              ← Go pick some spikes
            </Link>
          </div>
        ) : (
        <>

        {/* Toast */}
        {toast && (
          <div className={cn(
            'mb-4 p-4 rounded-xl font-medium text-sm animate-fade-in flex items-center gap-2',
            toast.type === 'error'
              ? 'bg-spike-red/10 border border-spike-red/30 text-spike-red'
              : 'bg-spike-green/10 border border-spike-green/30 text-spike-green'
          )}>
            {toast.type === 'error' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            )}
            {toast.message}
          </div>
        )}

        {/* Summary */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
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

        {/* CSV import/export */}
        <div className="flex items-center justify-end mb-4">
          <CsvImportExport portfolioId={activeId} onImportComplete={fetchPortfolio} />
        </div>

        {/* Selection toolbar */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {/* Choose Portfolio */}
            <button
              onClick={() => setShowChoosePortfolio(true)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all border border-spike-border text-spike-text-dim hover:border-spike-cyan/30 hover:text-spike-text"
              title="Switch to a different portfolio"
            >
              Choose Portfolio
            </button>

            {/* Select Positions to Close — only when active positions exist */}
            {positions.some((p) => p.status === 'active') && (
              <>
              <button
                onClick={() => { setSelectionMode(!selectionMode); if (selectionMode) { setSelectedIds(new Set()); setBulkCloseConfirm(false); } }}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-all border',
                  selectionMode
                    ? 'bg-spike-red/10 text-spike-red border-spike-red/30'
                    : 'text-spike-text-dim border-spike-border hover:border-spike-red/30 hover:text-spike-text'
                )}
                title="Select multiple positions to close at once"
              >
                {selectionMode ? '✕ Cancel Selection' : '☐ Select Positions to Close'}
              </button>

              {selectionMode && (
                <>
                  <button
                    onClick={handleSelectAll}
                    className="px-3 py-2 rounded-lg text-xs font-medium text-spike-text-dim hover:text-spike-text border border-spike-border hover:border-spike-red/30 transition-all"
                    title="Select or deselect all active positions"
                  >
                    {selectedIds.size === positions.filter((p) => p.status === 'active').length ? 'Deselect All' : 'Select All'}
                  </button>
                  <span className="text-sm text-spike-text-dim">
                    {selectedIds.size} selected
                  </span>
                </>
              )}
              </>
            )}

            {selectionMode && selectedIds.size > 0 && (
              bulkCloseConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-spike-red">Close {selectedIds.size} position{selectedIds.size !== 1 ? 's' : ''}?</span>
                  <button
                    onClick={handleBulkClose}
                    disabled={bulkClosing}
                    className="px-4 py-2 rounded-lg text-sm font-bold text-white bg-spike-red hover:bg-spike-red/80 transition-all disabled:opacity-50"
                  >
                    {bulkClosing ? 'Closing...' : 'Confirm Sell All'}
                  </button>
                  <button
                    onClick={() => setBulkCloseConfirm(false)}
                    className="px-3 py-2 rounded-lg text-xs text-spike-text-muted hover:text-spike-text"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setBulkCloseConfirm(true)}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-spike-red bg-spike-red/10 border border-spike-red/30 hover:bg-spike-red/20 transition-all"
                  title="Close all selected positions"
                >
                  Sell / Close {selectedIds.size} Position{selectedIds.size !== 1 ? 's' : ''}
                </button>
              )
            )}
          </div>

          {/* Delete Portfolio — far right */}
          <button
            onClick={handleOpenDeleteModal}
            className="px-3 py-2 rounded-lg text-xs font-medium text-spike-text-dim bg-spike-bg border border-spike-border hover:border-spike-red/30 hover:text-spike-red transition-all"
            title="Delete portfolios"
          >
            Delete Portfolio
          </button>
        </div>

        {/* Active position cards */}
        <div className="space-y-3">
            {positions.filter((p) => p.status === 'active').map((pos) => (
                <div key={pos.id} className={cn(
                  'glass-card p-5 transition-all',
                  selectedIds.has(pos.id) && 'ring-2 ring-spike-red/50 border-spike-red/30',
                  pos.riskStatus === 'danger' && !selectedIds.has(pos.id) && 'border-spike-red/30',
                  pos.riskStatus === 'target_hit' && !selectedIds.has(pos.id) && 'border-spike-gold/30',
                )}>
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-6">
                    <div className="flex items-start justify-between sm:flex-1 min-w-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link href={`/dashboard/analysis/${pos.spikeId}`} title="See the full AI analysis for this stock" className="text-xl font-bold text-spike-text hover:text-spike-cyan transition-colors">
                            {pos.ticker}
                          </Link>
                          <span className={cn('text-xs px-2 py-0.5 rounded-full font-semibold', riskColors[pos.riskStatus], `bg-current/10`)}>
                            <span className={riskColors[pos.riskStatus]}>{riskLabels[pos.riskStatus]}</span>
                          </span>
                        </div>
                        <p className="text-sm text-spike-text-dim line-clamp-1">{pos.name}</p>
                        <p className="text-xs text-spike-text-muted mt-0.5">
                          Entered {new Date(pos.entryDate).toLocaleDateString('en-CA')} &middot; {pos.daysHeld} day{pos.daysHeld !== 1 ? 's' : ''} held &middot; Score: {pos.spikeScore?.toFixed(0)}
                        </p>
                      </div>

                      {/* P&L — shown inline on mobile, separate column on desktop */}
                      <div className="text-right sm:hidden flex-shrink-0">
                        <p className={cn('text-xl font-bold mono', pos.unrealizedPnl >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                          {pos.unrealizedPnl >= 0 ? '+' : ''}{formatCurrency(pos.unrealizedPnl)}
                        </p>
                        <p className={cn('text-sm mono', pos.unrealizedPnlPct >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                          {formatPercent(pos.unrealizedPnlPct)}
                        </p>
                      </div>
                    </div>

                    {/* P&L — desktop only */}
                    <div className="text-center flex-shrink-0 hidden sm:block">
                      <p className={cn('text-2xl font-bold mono', pos.unrealizedPnl >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                        {pos.unrealizedPnl >= 0 ? '+' : ''}{formatCurrency(pos.unrealizedPnl)}
                      </p>
                      <p className={cn('text-sm mono', pos.unrealizedPnlPct >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                        {formatPercent(pos.unrealizedPnlPct)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => setSpikeItTicker({ ticker: pos.ticker, name: pos.name, entryPrice: pos.entryPrice })}
                        disabled={!isMarketOpen()}
                        className="px-3 py-2 rounded-lg text-xs font-medium text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ background: isMarketOpen() ? 'linear-gradient(135deg, #ff6b35, #ff8c42)' : '#333' }}
                        title={isMarketOpen() ? 'Live health check — is this spike still running?' : 'Available during market hours (10:30 AM - 5:00 PM AST)'}
                      >
                        ⚡ Spike It
                      </button>
                      <Link
                        href={`/dashboard/analysis/${pos.spikeId}`}
                        className="px-3 py-2 rounded-lg text-xs font-medium text-spike-cyan bg-spike-cyan/5 border border-spike-cyan/15 hover:bg-spike-cyan/10 transition-all"
                        title="See the full AI analysis for this stock"
                      >
                        View Analysis
                      </Link>
                      <button
                        onClick={() => { setSellModal(pos); setSellShares(pos.shares); }}
                        className="px-3 py-2 rounded-lg text-xs font-medium text-spike-text-dim bg-spike-bg border border-spike-border hover:border-spike-red/30 hover:text-spike-red transition-all"
                        title="Sell all or part of this position"
                      >
                        Sell / Close
                      </button>
                      {selectionMode && (
                        <button
                          onClick={() => handleSelectPosition(pos.id, !selectedIds.has(pos.id))}
                          className={cn(
                            'w-8 h-8 rounded-lg border-2 flex items-center justify-center transition-all flex-shrink-0',
                            selectedIds.has(pos.id)
                              ? 'bg-spike-red border-spike-red text-spike-bg'
                              : 'border-spike-border hover:border-spike-red/50 bg-spike-bg/50'
                          )}
                          title={selectedIds.has(pos.id) ? 'Remove from selection' : 'Add to selection'}
                        >
                          {selectedIds.has(pos.id) && (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3 mt-4 pt-3 border-t border-spike-border/20">
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
            ))}

            {positions.filter((p) => p.status === 'active').length === 0 && !loading && (
              <div className="glass-card p-12 text-center">
                <p className="text-spike-text-dim">No active positions.</p>
                <Link href="/dashboard" className="text-spike-cyan text-sm mt-3 inline-block hover:underline">
                  ← Go pick some spikes
                </Link>
              </div>
            )}
          </div>

        <div className="legal-footer">
          <p>For educational and informational purposes only. Not financial advice. Past performance is no guarantee of future results.</p>
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca &middot; Ver 3.1</p>
        </div>
        </>
        )}

        {spikeItTicker && (
          <SpikeItModal
            ticker={spikeItTicker.ticker}
            companyName={spikeItTicker.name}
            entryPrice={spikeItTicker.entryPrice}
            onClose={() => setSpikeItTicker(null)}
          />
        )}

        {/* Sell / Close Modal */}
        {sellModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={() => { setSellModal(null); setSellShares(0); }}>
            <div className="glass-card p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-spike-text">Sell {sellModal.ticker}</h2>
                <button onClick={() => { setSellModal(null); setSellShares(0); }} className="text-spike-text-dim hover:text-spike-text text-xl">&times;</button>
              </div>

              {/* Position info */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="p-3 rounded-lg bg-spike-bg/50 border border-spike-border/30">
                  <p className="text-[10px] text-spike-text-muted uppercase">Shares Held</p>
                  <p className="text-sm font-bold text-spike-text">{sellModal.shares.toLocaleString()}</p>
                </div>
                <div className="p-3 rounded-lg bg-spike-bg/50 border border-spike-border/30">
                  <p className="text-[10px] text-spike-text-muted uppercase">Current Price</p>
                  <p className="text-sm font-bold text-spike-text">{formatCurrency(sellModal.currentPrice)}</p>
                </div>
                <div className="p-3 rounded-lg bg-spike-bg/50 border border-spike-border/30">
                  <p className="text-[10px] text-spike-text-muted uppercase">Entry Price</p>
                  <p className="text-sm font-bold text-spike-text">{formatCurrency(sellModal.entryPrice)}</p>
                </div>
                <div className="p-3 rounded-lg bg-spike-bg/50 border border-spike-border/30">
                  <p className="text-[10px] text-spike-text-muted uppercase">Unrealized P&L</p>
                  <p className={cn('text-sm font-bold', sellModal.unrealizedPnl >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                    {sellModal.unrealizedPnl >= 0 ? '+' : ''}{formatCurrency(sellModal.unrealizedPnl)}
                  </p>
                </div>
              </div>

              {/* Shares to sell */}
              <div className="mb-4">
                <label className="text-xs text-spike-text-muted uppercase tracking-wider block mb-2">Shares to Sell</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={sellShares}
                    onChange={(e) => {
                      const val = Math.max(0, Math.min(sellModal.shares, parseInt(e.target.value) || 0));
                      setSellShares(val);
                    }}
                    min={1}
                    max={sellModal.shares}
                    className="flex-1 bg-spike-bg/50 border border-spike-border rounded-lg px-3 py-2.5 text-spike-text text-center text-lg font-bold focus:border-spike-cyan/50 focus:outline-none"
                    autoFocus
                  />
                  <button
                    onClick={() => setSellShares(sellModal.shares)}
                    className={cn(
                      'px-4 py-2.5 rounded-lg text-sm font-medium border transition-all',
                      sellShares === sellModal.shares
                        ? 'bg-spike-red/10 text-spike-red border-spike-red/30'
                        : 'text-spike-text-dim border-spike-border hover:border-spike-red/30 hover:text-spike-red'
                    )}
                  >
                    Sell All
                  </button>
                </div>
              </div>

              {/* Estimated proceeds */}
              {sellShares > 0 && (
                <div className="p-4 rounded-xl bg-spike-bg/50 border border-spike-border/30 mb-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-spike-text-muted">Est. Proceeds</span>
                    <span className="text-sm font-bold text-spike-text">{formatCurrency(sellShares * sellModal.currentPrice)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-spike-text-muted">Est. Realized P&L</span>
                    {(() => {
                      const pnl = (sellModal.currentPrice - sellModal.entryPrice) * sellShares;
                      return (
                        <span className={cn('text-sm font-bold', pnl >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                          {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                        </span>
                      );
                    })()}
                  </div>
                  {sellShares < sellModal.shares && (
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-spike-border/30">
                      <span className="text-xs text-spike-text-muted">Remaining Shares</span>
                      <span className="text-sm font-medium text-spike-text">{sellModal.shares - sellShares}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-3">
                <button
                  onClick={() => { setSellModal(null); setSellShares(0); }}
                  className="flex-1 py-2.5 rounded-lg text-sm font-medium text-spike-text-dim border border-spike-border"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleSellPosition(sellModal.id, sellShares)}
                  disabled={sellShares <= 0 || closing === sellModal.id}
                  className="flex-1 py-2.5 rounded-lg text-sm font-bold text-white bg-spike-red hover:bg-spike-red/80 transition-all disabled:opacity-50"
                >
                  {closing === sellModal.id ? 'Selling...' : sellShares === sellModal.shares ? `Sell All ${sellShares} Shares` : `Sell ${sellShares} Share${sellShares !== 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Choose Portfolio Modal */}
        {showChoosePortfolio && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={() => setShowChoosePortfolio(false)}>
            <div className="glass-card p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-spike-text">Choose Portfolio</h2>
                <button onClick={() => setShowChoosePortfolio(false)} className="text-spike-text-dim hover:text-spike-text text-xl">&times;</button>
              </div>
              {portfolios.length === 0 ? (
                <p className="text-sm text-spike-text-dim text-center py-6">No portfolios yet. Create one first.</p>
              ) : (
                <div className="space-y-2">
                  {portfolios.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { selectPortfolio(p.id); setShowChoosePortfolio(false); }}
                      className={cn(
                        'w-full text-left p-4 rounded-xl border transition-all flex items-center justify-between group',
                        p.id === activeId
                          ? 'bg-spike-cyan/10 border-spike-cyan/30'
                          : 'border-spike-border hover:border-spike-cyan/30 bg-spike-bg/50 hover:bg-spike-cyan/5'
                      )}
                    >
                      <div>
                        <p className={cn('font-semibold text-sm', p.id === activeId ? 'text-spike-cyan' : 'text-spike-text')}>{p.name}</p>
                        <p className="text-xs text-spike-text-muted mt-0.5">{p.activePositions} active · {p.sizingMode}</p>
                      </div>
                      {p.id === activeId && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-spike-cyan">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* New Portfolio Modal */}
        {showNewPortfolio && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={() => setShowNewPortfolio(false)}>
            <div className="glass-card p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-lg font-bold text-spike-text mb-4">New Portfolio</h2>
              <input
                type="text"
                value={newPortfolioName}
                onChange={(e) => setNewPortfolioName(e.target.value)}
                placeholder="Portfolio name"
                className="w-full bg-spike-bg/50 border border-spike-border rounded-lg px-3 py-2.5 text-spike-text focus:border-spike-cyan/50 focus:outline-none mb-4"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreatePortfolio(); }}
              />
              <div className="flex gap-3">
                <button onClick={() => setShowNewPortfolio(false)} className="flex-1 py-2.5 rounded-lg text-sm font-medium text-spike-text-dim border border-spike-border">Cancel</button>
                <button onClick={handleCreatePortfolio} disabled={!newPortfolioName.trim()} className="flex-1 btn-lock-in py-2.5 disabled:opacity-50">Create</button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Portfolio Modal */}
        {showDeleteModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={() => setShowDeleteModal(false)}>
            <div className="glass-card p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-spike-text">
                  {deleteStep === 'select' ? 'Delete Portfolios' : deleteStep === 'close_positions' ? 'Close Active Positions' : 'Confirm Portfolio Deletion'}
                </h2>
                <button onClick={() => setShowDeleteModal(false)} className="text-spike-text-dim hover:text-spike-text text-xl">&times;</button>
              </div>

              {deleteStep === 'select' ? (
                <>
                  <p className="text-sm text-spike-text-dim mb-4">Select which portfolios to delete:</p>
                  <div className="space-y-2 mb-5">
                    {portfolios.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => handleToggleDeleteSelection(p.id)}
                        className={cn(
                          'w-full text-left p-4 rounded-xl border transition-all flex items-center justify-between',
                          deleteSelectedIds.has(p.id)
                            ? 'bg-spike-red/10 border-spike-red/30'
                            : 'border-spike-border hover:border-spike-red/20 bg-spike-bg/50'
                        )}
                      >
                        <div>
                          <p className={cn('font-semibold text-sm', deleteSelectedIds.has(p.id) ? 'text-spike-red' : 'text-spike-text')}>{p.name}</p>
                          <p className="text-xs text-spike-text-muted mt-0.5">{p.activePositions} active · {p.totalPositions} total</p>
                        </div>
                        <div className={cn(
                          'w-6 h-6 rounded border-2 flex items-center justify-center transition-all',
                          deleteSelectedIds.has(p.id)
                            ? 'bg-spike-red border-spike-red'
                            : 'border-spike-border'
                        )}>
                          {deleteSelectedIds.has(p.id) && (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const selected = portfolios.filter((p) => deleteSelectedIds.has(p.id));
                    const totalActive = selected.reduce((sum, p) => sum + p.activePositions, 0);
                    return (
                      <div className="flex gap-3">
                        <button onClick={() => setShowDeleteModal(false)} className="flex-1 py-2.5 rounded-lg text-sm font-medium text-spike-text-dim border border-spike-border">Cancel</button>
                        <button
                          onClick={() => {
                            if (totalActive > 0) {
                              setDeleteStep('close_positions');
                            } else {
                              setDeleteStep('confirm_delete');
                            }
                          }}
                          disabled={deleteSelectedIds.size === 0}
                          className="flex-1 py-2.5 rounded-lg text-sm font-medium text-spike-red bg-spike-red/10 border border-spike-red/30 hover:bg-spike-red/20 disabled:opacity-50 transition-all"
                        >
                          Continue ({deleteSelectedIds.size})
                        </button>
                      </div>
                    );
                  })()}
                </>

              ) : deleteStep === 'close_positions' ? (() => {
                const selected = portfolios.filter((p) => deleteSelectedIds.has(p.id));
                const totalActive = selected.reduce((sum, p) => sum + p.activePositions, 0);
                return (
                <>
                  <div className="p-4 rounded-xl bg-spike-amber/10 border border-spike-amber/30 mb-5">
                    <p className="text-sm text-spike-amber font-medium mb-2">⚠ Active Positions Found</p>
                    <p className="text-xs text-spike-text-dim">
                      The selected portfolio{selected.length > 1 ? 's have' : ' has'} <span className="text-spike-amber font-medium">{totalActive} active position{totalActive > 1 ? 's' : ''}</span> that will be closed at current market price before deletion.
                    </p>
                  </div>
                  <div className="space-y-2 mb-5">
                    {selected.filter((p) => p.activePositions > 0).map((p) => (
                      <div key={p.id} className="flex items-center justify-between p-3 rounded-lg bg-spike-bg/50 border border-spike-border/30">
                        <span className="text-sm font-medium text-spike-text">{p.name}</span>
                        <span className="text-xs text-spike-amber">{p.activePositions} position{p.activePositions > 1 ? 's' : ''} to close</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => setDeleteStep('select')} className="flex-1 py-2.5 rounded-lg text-sm font-medium text-spike-text-dim border border-spike-border">Back</button>
                    <button
                      onClick={handleClosePositions}
                      disabled={deleting}
                      className="flex-1 py-2.5 rounded-lg text-sm font-bold text-white bg-spike-amber hover:bg-spike-amber/80 transition-all disabled:opacity-50"
                    >
                      {deleting ? 'Closing Positions...' : `Close ${totalActive} Position${totalActive > 1 ? 's' : ''}`}
                    </button>
                  </div>
                </>
                );
              })()

              : (() => {
                const selected = portfolios.filter((p) => deleteSelectedIds.has(p.id));
                return (
                <>
                  <div className="p-4 rounded-xl bg-spike-red/10 border border-spike-red/30 mb-5">
                    <p className="text-sm text-spike-red font-medium mb-2">⚠ This action cannot be undone.</p>
                    <p className="text-xs text-spike-text-dim">
                      {selected.length > 1 ? 'These portfolios' : 'This portfolio'} and all associated data will be permanently deleted.
                    </p>
                  </div>
                  <div className="space-y-2 mb-5">
                    {selected.map((p) => (
                      <div key={p.id} className="flex items-center justify-between p-3 rounded-lg bg-spike-bg/50 border border-spike-border/30">
                        <span className="text-sm font-medium text-spike-text">{p.name}</span>
                        <span className="text-xs text-spike-text-muted">will be deleted</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => setDeleteStep('select')} className="flex-1 py-2.5 rounded-lg text-sm font-medium text-spike-text-dim border border-spike-border">Back</button>
                    <button
                      onClick={handleConfirmDelete}
                      disabled={deleting}
                      className="flex-1 py-2.5 rounded-lg text-sm font-bold text-white bg-spike-red hover:bg-spike-red/80 transition-all disabled:opacity-50"
                    >
                      {deleting ? 'Deleting...' : `Delete ${selected.length} Portfolio${selected.length > 1 ? 's' : ''}`}
                    </button>
                  </div>
                </>
                );
              })()}
            </div>
          </div>
        )}
    </ResponsiveLayout>
  );
}
