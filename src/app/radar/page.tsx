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

        {/* Lock-in confirmation toast — inline banner */}
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
