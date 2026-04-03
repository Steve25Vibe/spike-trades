'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import MarketHeader from '@/components/layout/MarketHeader';
import OpeningBellCard, { type OpeningBellPickData } from '@/components/opening-bell/OpeningBellCard';
import LockInModal from '@/components/portfolio/LockInModal';
import BulkLockInModal from '@/components/portfolio/BulkLockInModal';
import PortfolioChoiceModal from '@/components/portfolio/PortfolioChoiceModal';
import PortfolioSettings from '@/components/portfolio/PortfolioSettings';
import { usePortfolios } from '@/components/portfolio/usePortfolios';
import type { SizingMode } from '@/components/portfolio/PortfolioSettings';
import { cn } from '@/lib/utils';

interface SectorSnapshot {
  sector: string;
  averageChange: number;
}

interface ReportData {
  report: {
    id: string;
    date: string;
    generatedAt: string;
    sectorSnapshot: SectorSnapshot[];
    tickersScanned: number;
    scanDurationMs: number;
  };
  picks: OpeningBellPickData[];
}

export default function OpeningBellPage() {
  return (
    <Suspense fallback={null}>
      <OpeningBellContent />
    </Suspense>
  );
}

function OpeningBellContent() {
  const searchParams = useSearchParams();
  const dateParam = searchParams.get('date');
  const [data, setData] = useState<ReportData | null>(null);
  const [marketData, setMarketData] = useState<{ marketRegime: string; tsxLevel: number; tsxChange: number; oilPrice: number; goldPrice: number; btcPrice: number; cadUsd: number; prevOilPrice: number | null; prevGoldPrice: number | null; prevBtcPrice: number | null; prevCadUsd: number | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [lockResults, setLockResults] = useState<{ locked: number; skipped: any[] } | null>(null);
  const [lockInPick, setLockInPick] = useState<OpeningBellPickData | null>(null);
  const [bulkLockInPicks, setBulkLockInPicks] = useState<OpeningBellPickData[] | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [pendingSinglePick, setPendingSinglePick] = useState<OpeningBellPickData | null>(null);
  const [pendingBulkPicks, setPendingBulkPicks] = useState<OpeningBellPickData[] | null>(null);
  const [chosenPortfolioId, setChosenPortfolioId] = useState<string | null>(null);

  const { portfolios, refresh: refreshPortfolios } = usePortfolios();

  useEffect(() => {
    fetchPicks();
  }, [dateParam]);

  const fetchPicks = async () => {
    try {
      const url = dateParam ? `/api/opening-bell?date=${dateParam}` : '/api/opening-bell';
      const res = await fetch(url);
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
        // Fetch market indicators from the daily report for the same date
        try {
          const spikesUrl = dateParam ? `/api/spikes?date=${dateParam}` : '/api/spikes';
          const spikesRes = await fetch(spikesUrl);
          const spikesJson = await spikesRes.json();
          if (spikesJson.success && spikesJson.data?.report) {
            const r = spikesJson.data.report;
            setMarketData({
              marketRegime: r.marketRegime || 'neutral',
              tsxLevel: r.tsxLevel || 0,
              tsxChange: r.tsxChange || 0,
              oilPrice: r.oilPrice || 0,
              goldPrice: r.goldPrice || 0,
              btcPrice: r.btcPrice || 0,
              cadUsd: r.cadUsd || 0,
              prevOilPrice: r.prevOilPrice,
              prevGoldPrice: r.prevGoldPrice,
              prevBtcPrice: r.prevBtcPrice,
              prevCadUsd: r.prevCadUsd,
            });
          }
        } catch { /* market data is non-essential */ }
      } else {
        setError(json.message || 'No data available');
      }
    } catch {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  // Step 1: user clicks Lock In → show portfolio choice modal
  const handleLockIn = (pickId: string) => {
    const pick = data?.picks.find((p) => p.id === pickId);
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

  // Cancel choice modal
  const handleCancelChoice = () => {
    setPendingSinglePick(null);
    setPendingBulkPicks(null);
  };

  const handleConfirmLockIn = async (params: { spikeId: string; portfolioId: string; shares?: number; positionSize?: number; portfolioSize?: number; mode: SizingMode }) => {
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, openingBellPickId: params.spikeId, spikeId: undefined }),
    });
    const json = await res.json();
    if (json.success) {
      setLockInPick(null);
      setLockResults({ locked: 1, skipped: [] });
      setTimeout(() => setLockResults(null), 3000);
      refreshPortfolios();
    }
  };

  const handleSelect = (pickId: string, isSelected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isSelected) next.add(pickId);
      else next.delete(pickId);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (!data) return;
    if (selectedIds.size === data.picks.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(data.picks.map((p) => p.id)));
    }
  };

  const handleBulkLockIn = () => {
    if (selectedIds.size === 0 || !data) return;
    const selected = data.picks.filter((p) => selectedIds.has(p.id));
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
      body: JSON.stringify({ ...params, openingBellPickIds: params.spikeIds, spikeIds: undefined }),
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

  // Sector pill color based on average change
  const getSectorPillColor = (averageChange: number) => {
    if (averageChange > 1) return 'bg-spike-green/10 text-spike-green border border-spike-green/30';
    if (averageChange >= 0) return 'bg-spike-amber/10 text-spike-amber border border-spike-amber/30';
    return 'bg-spike-red/10 text-spike-red border border-spike-red/30';
  };

  return (
    <ResponsiveLayout>
      {loading ? (
        <div className="flex items-center justify-center h-[60vh]">
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-spike-amber/20 border-t-spike-amber rounded-full animate-spin mx-auto mb-4" />
            <p className="text-spike-text-dim">Loading Opening Bell analysis...</p>
          </div>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-[60vh]">
          <div className="glass-card p-8 text-center max-w-md">
            <div className="w-16 h-16 rounded-full bg-spike-amber/10 flex items-center justify-center mx-auto mb-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FFB800" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-spike-text mb-2">No Opening Bell Data</h3>
            <p className="text-spike-text-dim text-sm">{error}</p>
            <p className="text-spike-text-muted text-xs mt-4">
              Opening Bell scans run at market open on trading days.
            </p>
          </div>
        </div>
      ) : data ? (
        <>
          <MarketHeader
            title="OPENING BELL"
            titleColor="text-spike-amber"
            date={new Date(new Date(data.report.date).toISOString().split('T')[0] + 'T12:00:00').toLocaleDateString('en-CA', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            })}
            regime={marketData?.marketRegime || 'neutral'}
            tsxLevel={marketData?.tsxLevel || 0}
            tsxChange={marketData?.tsxChange || 0}
            oilPrice={marketData?.oilPrice || 0}
            goldPrice={marketData?.goldPrice || 0}
            btcPrice={marketData?.btcPrice || 0}
            cadUsd={marketData?.cadUsd || 0}
            prevOilPrice={marketData?.prevOilPrice}
            prevGoldPrice={marketData?.prevGoldPrice}
            prevBtcPrice={marketData?.prevBtcPrice}
            prevCadUsd={marketData?.prevCadUsd}
          />

          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 lg:gap-4 mb-6">
            {[
              { label: 'Tickers Scanned', value: data.report.tickersScanned?.toLocaleString() || '--', color: 'text-spike-amber' },
              { label: 'Total Picks', value: data.picks.length, color: 'text-spike-cyan' },
              { label: 'Avg Score', value: data.picks.length > 0 ? (data.picks.reduce((a, p) => a + p.momentumScore, 0) / data.picks.length).toFixed(0) : '--', color: 'text-spike-green' },
              { label: 'Top Score', value: data.picks[0]?.momentumScore.toFixed(0) || '--', color: 'text-spike-gold' },
              { label: 'Avg Rel. Volume', value: data.picks.length > 0 ? (data.picks.reduce((a, p) => a + p.relativeVolume, 0) / data.picks.length).toFixed(1) + 'x' : '--', color: 'text-spike-violet' },
            ].map((stat) => (
              <div key={stat.label} className="glass-card p-4 text-center">
                <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">{stat.label}</p>
                <p className={`text-2xl font-bold mono ${stat.color}`}>{stat.value}</p>
              </div>
            ))}
          </div>

          {/* Sector heat strip */}
          {data.report.sectorSnapshot && data.report.sectorSnapshot.length > 0 && (
            <div className="mb-6">
              <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-2">Sector Snapshot</p>
              <div className="flex flex-wrap gap-2">
                {data.report.sectorSnapshot
                  .sort((a, b) => b.averageChange - a.averageChange)
                  .map((s) => (
                    <span
                      key={s.sector}
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${getSectorPillColor(s.averageChange)}`}
                    >
                      {s.sector}
                      <span className="font-mono">
                        {s.averageChange >= 0 ? '+' : ''}{s.averageChange.toFixed(1)}%
                      </span>
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Selection toolbar */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {/* Portfolio settings gear */}
              <button
                onClick={() => setShowSettings(true)}
                className="w-9 h-9 rounded-lg border border-spike-border hover:border-spike-amber/30 flex items-center justify-center text-spike-text-dim hover:text-spike-amber transition-all"
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
                    ? 'bg-spike-amber/10 text-spike-amber border-spike-amber/30'
                    : 'text-spike-text-dim border-spike-border hover:border-spike-amber/30 hover:text-spike-text'
                )}
                title={selectionMode ? 'Exit selection mode without making changes' : 'Pick multiple stocks to add to your portfolio at once'}
              >
                {selectionMode ? '✕ Cancel Selection' : '☐ Select Picks for Portfolio'}
              </button>

              {selectionMode && (
                <>
                  <button
                    onClick={handleSelectAll}
                    className="px-3 py-2 rounded-lg text-xs font-medium text-spike-text-dim hover:text-spike-text border border-spike-border hover:border-spike-amber/30 transition-all"
                    title="Select or deselect all picks on this page"
                  >
                    {selectedIds.size === data.picks.length ? 'Deselect All' : 'Select All'}
                  </button>
                  <span className="text-sm text-spike-text-dim">
                    {selectedIds.size} of {data.picks.length} selected
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

          {/* Lock-in confirmation toast */}
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

          {/* Opening Bell cards grid */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {data.picks.map((pick) => (
              <OpeningBellCard
                key={pick.id}
                pick={pick}
                selected={selectedIds.has(pick.id)}
                onSelect={handleSelect}
                onLockIn={handleLockIn}
                selectionMode={selectionMode}
              />
            ))}
          </div>

          {/* Legal footer */}
          <div className="legal-footer">
            <p>
              For educational and informational purposes only. Not financial advice.
              Past performance is no guarantee of future results.
              Trading stocks involves risk. You may lose your entire investment.
            </p>
            <p className="mt-2">
              &copy; {new Date().getFullYear()} Spike Trades &mdash; spiketrades.ca. All rights reserved. &middot; Ver 4.0
            </p>
          </div>
        </>
      ) : null}

      {/* Portfolio Choice Modal — appears first when locking in */}
      {(pendingSinglePick || pendingBulkPicks) && (
        <PortfolioChoiceModal
          portfolios={portfolios}
          spikeCount={pendingSinglePick ? 1 : (pendingBulkPicks?.length || 0)}
          onSelect={handlePortfolioChosen}
          onCreate={handlePortfolioChosen}
          onCancel={handleCancelChoice}
        />
      )}

      {/* Lock-In Confirmation Modal — after portfolio chosen */}
      {lockInPick && chosenPortfolioId && (
        <LockInModal
          spike={{
            id: lockInPick.id,
            ticker: lockInPick.ticker,
            name: lockInPick.name,
            price: lockInPick.priceAtScan,
            predicted3Day: lockInPick.changePercent,
            predicted5Day: lockInPick.changePercent,
            predicted8Day: lockInPick.changePercent,
            atr: undefined,
          }}
          portfolios={portfolios}
          activePortfolioId={chosenPortfolioId}
          onConfirm={handleConfirmLockIn}
          onCancel={() => { setLockInPick(null); setChosenPortfolioId(null); }}
        />
      )}

      {/* Bulk Lock-In Modal — after portfolio chosen */}
      {bulkLockInPicks && bulkLockInPicks.length > 0 && chosenPortfolioId && (
        <BulkLockInModal
          spikes={bulkLockInPicks.map((p) => ({
            id: p.id,
            ticker: p.ticker,
            name: p.name,
            price: p.priceAtScan,
            predicted3Day: p.changePercent,
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
