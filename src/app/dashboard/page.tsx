'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import ParticleBackground from '@/components/layout/ParticleBackground';
import MarketHeader from '@/components/layout/MarketHeader';
import SpikeCard from '@/components/spikes/SpikeCard';
import LockInModal from '@/components/portfolio/LockInModal';
import BulkLockInModal from '@/components/portfolio/BulkLockInModal';
import PortfolioSettings from '@/components/portfolio/PortfolioSettings';
import PortfolioSelector from '@/components/portfolio/PortfolioSelector';
import { usePortfolios } from '@/components/portfolio/usePortfolios';
import type { SizingMode } from '@/components/portfolio/PortfolioSettings';
import { cn } from '@/lib/utils';

interface SpikeData {
  id: string;
  rank: number;
  ticker: string;
  name: string;
  sector: string;
  exchange: string;
  price: number;
  spikeScore: number;
  confidence: number;
  predicted3Day: number;
  predicted5Day: number;
  predicted8Day: number;
  narrative: string;
  rsi: number;
  macd: number;
  adx: number;
  atr: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  momentumScore: number;
  volumeScore: number;
  technicalScore: number;
  macroScore: number;
  sentimentScore: number;
}

interface ReportData {
  report: {
    date: string;
    marketRegime: string;
    tsxLevel: number;
    tsxChange: number;
    oilPrice: number;
    goldPrice: number;
    btcPrice: number;
    cadUsd: number;
    csvUrl: string;
    prevOilPrice: number | null;
    prevGoldPrice: number | null;
    prevBtcPrice: number | null;
    prevCadUsd: number | null;
    stocksAnalyzed: number | null;
  };
  spikes: SpikeData[];
}

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardContent() {
  const searchParams = useSearchParams();
  const dateParam = searchParams.get('date');
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [lockResults, setLockResults] = useState<{ locked: number; skipped: any[] } | null>(null);
  const [lockInSpike, setLockInSpike] = useState<SpikeData | null>(null);
  const [bulkLockInSpikes, setBulkLockInSpikes] = useState<SpikeData[] | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewPortfolio, setShowNewPortfolio] = useState(false);
  const [newPortfolioName, setNewPortfolioName] = useState('');

  const { portfolios, activeId, activePortfolio, selectPortfolio, refresh: refreshPortfolios } = usePortfolios();

  useEffect(() => {
    fetchSpikes();
  }, [dateParam]);

  const fetchSpikes = async () => {
    try {
      const url = dateParam ? `/api/spikes?date=${dateParam}` : '/api/spikes';
      const res = await fetch(url);
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      } else {
        setError(json.message || 'No data available');
      }
    } catch {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleLockIn = (spikeId: string) => {
    const spike = data?.spikes.find((s) => s.id === spikeId);
    if (spike) setLockInSpike(spike);
  };

  const handleConfirmLockIn = async (params: { spikeId: string; portfolioId: string; shares?: number; positionSize?: number; portfolioSize?: number; mode: SizingMode }) => {
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (json.success) {
      setLockInSpike(null);
      setLockResults({ locked: 1, skipped: [] });
      setTimeout(() => setLockResults(null), 3000);
      refreshPortfolios();
    }
  };

  const handleSelect = (spikeId: string, isSelected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isSelected) next.add(spikeId);
      else next.delete(spikeId);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (!data) return;
    if (selectedIds.size === data.spikes.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(data.spikes.map((s) => s.id)));
    }
  };

  const handleBulkLockIn = () => {
    if (selectedIds.size === 0 || !data) return;
    const selected = data.spikes.filter((s) => selectedIds.has(s.id));
    setBulkLockInSpikes(selected);
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
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (json.success) {
      setBulkLockInSpikes(null);
      setLockResults({ locked: json.locked, skipped: json.skipped || [] });
      setSelectedIds(new Set());
      setSelectionMode(false);
      setTimeout(() => setLockResults(null), 5000);
      refreshPortfolios();
    }
  };

  const handleCreatePortfolio = async () => {
    if (!newPortfolioName.trim()) return;
    const res = await fetch('/api/portfolios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newPortfolioName.trim() }),
    });
    const json = await res.json();
    if (json.success) {
      setShowNewPortfolio(false);
      setNewPortfolioName('');
      await refreshPortfolios();
      selectPortfolio(json.data.id);
    }
  };

  const buildSpikeCardData = (spike: SpikeData) => ({
    ...spike,
    exchange: spike.exchange as 'TSX' | 'TSXV',
    technicals: {
      rsi: spike.rsi,
      macd: spike.macd,
      macdSignal: 0,
      macdHistogram: 0,
      adx: spike.adx,
      bollingerUpper: 0,
      bollingerMiddle: 0,
      bollingerLower: 0,
      ema3: 0,
      ema8: 0,
      ema21: 0,
      sma50: 0,
      sma200: 0,
      atr: spike.atr,
      obv: spike.volume,
    },
    scoreBreakdown: {
      momentum: spike.momentumScore || 0,
      volumeSurge: spike.volumeScore || 0,
      technical: spike.technicalScore || 0,
      macroSensitivity: spike.macroScore || 0,
      sentiment: spike.sentimentScore || 0,
      shortInterest: 0,
      volatilityAdj: 0,
      sectorRotation: 0,
      patternMatch: 0,
      liquidityDepth: 0,
      insiderSignal: 0,
      gapPotential: 0,
    },
  });

  return (
    <div className="min-h-screen bg-spike-bg">
      <ParticleBackground />
      <Sidebar />

      <main className="ml-64 p-8 relative z-10">
        {loading ? (
          <div className="flex items-center justify-center h-[60vh]">
            <div className="text-center">
              <div className="w-16 h-16 border-4 border-spike-cyan/20 border-t-spike-cyan rounded-full animate-spin mx-auto mb-4" />
              <p className="text-spike-text-dim">Loading today&apos;s analysis...</p>
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
              <h3 className="text-lg font-bold text-spike-text mb-2">No Analysis Available</h3>
              <p className="text-spike-text-dim text-sm">{error}</p>
              <p className="text-spike-text-muted text-xs mt-4">
                The daily analysis runs at 10:45 AM AST on trading days.
              </p>
            </div>
          </div>
        ) : data ? (
          <>
            <MarketHeader
              date={new Date(new Date(data.report.date).toISOString().split('T')[0] + 'T12:00:00').toLocaleDateString('en-CA', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              })}
              regime={data.report.marketRegime || 'neutral'}
              tsxLevel={data.report.tsxLevel || 0}
              tsxChange={data.report.tsxChange || 0}
              oilPrice={data.report.oilPrice || 0}
              goldPrice={data.report.goldPrice || 0}
              btcPrice={data.report.btcPrice || 0}
              cadUsd={data.report.cadUsd || 0}
              prevOilPrice={data.report.prevOilPrice}
              prevGoldPrice={data.report.prevGoldPrice}
              prevBtcPrice={data.report.prevBtcPrice}
              prevCadUsd={data.report.prevCadUsd}
            />

            {/* Summary stats */}
            <div className="grid grid-cols-5 gap-4 mb-6">
              {[
                { label: 'Stocks Analyzed', value: data.report.stocksAnalyzed?.toLocaleString() || '--', color: 'text-spike-amber' },
                { label: 'Total Spikes', value: data.spikes.length, color: 'text-spike-cyan' },
                { label: 'Avg Score', value: (data.spikes.reduce((a, s) => a + s.spikeScore, 0) / data.spikes.length).toFixed(1), color: 'text-spike-green' },
                { label: 'Top Score', value: data.spikes[0]?.spikeScore.toFixed(1) || '--', color: 'text-spike-gold' },
                { label: 'Avg Confidence', value: (data.spikes.reduce((a, s) => a + s.confidence, 0) / data.spikes.length).toFixed(0) + '%', color: 'text-spike-violet' },
              ].map((stat) => (
                <div key={stat.label} className="glass-card p-4 text-center">
                  <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">{stat.label}</p>
                  <p className={`text-2xl font-bold mono ${stat.color}`}>{stat.value}</p>
                </div>
              ))}
            </div>

            {/* Selection toolbar */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                {/* Portfolio settings gear */}
                <button
                  onClick={() => setShowSettings(true)}
                  className="w-9 h-9 rounded-lg border border-spike-border hover:border-spike-cyan/30 flex items-center justify-center text-spike-text-dim hover:text-spike-cyan transition-all"
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
                      ? 'bg-spike-cyan/10 text-spike-cyan border-spike-cyan/30'
                      : 'text-spike-text-dim border-spike-border hover:border-spike-cyan/30 hover:text-spike-text'
                  )}
                  title={selectionMode ? 'Exit selection mode without making changes' : 'Pick multiple stocks to add to your portfolio at once'}
                >
                  {selectionMode ? '✕ Cancel Selection' : '☐ Select Spikes for Portfolio'}
                </button>

                {selectionMode && (
                  <>
                    <button
                      onClick={handleSelectAll}
                      className="px-3 py-2 rounded-lg text-xs font-medium text-spike-text-dim hover:text-spike-text border border-spike-border hover:border-spike-cyan/30 transition-all"
                      title="Select or deselect all stocks on this page"
                    >
                      {selectedIds.size === data.spikes.length ? 'Deselect All' : 'Select All'}
                    </button>
                    <span className="text-sm text-spike-text-dim">
                      {selectedIds.size} of {data.spikes.length} selected
                    </span>
                  </>
                )}

                {selectionMode && selectedIds.size > 0 && (
                <button
                  onClick={handleBulkLockIn}
                  className="btn-lock-in text-base px-6 py-2.5 flex items-center gap-2"
                  title="Add your selected stocks to your portfolio"
                >
                  ⚡ Lock In {selectedIds.size} Spike{selectedIds.size > 1 ? 's' : ''}
                </button>
                )}
              </div>

              {/* Portfolio selector — far right */}
              <PortfolioSelector
                portfolios={portfolios}
                activeId={activeId}
                onSelect={selectPortfolio}
                onCreateNew={() => setShowNewPortfolio(true)}
              />
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

            {/* Spike cards grid */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {data.spikes.map((spike) => (
                <SpikeCard
                  key={spike.id}
                  spike={buildSpikeCardData(spike)}
                  selected={selectedIds.has(spike.id)}
                  onSelect={handleSelect}
                  onLockIn={handleLockIn}
                  selectionMode={selectionMode}
                />
              ))}
            </div>

            {/* Download CSV */}
            {data.report.csvUrl && (
              <div className="text-center mt-8">
                <a
                  href={data.report.csvUrl}
                  className="inline-flex items-center gap-2 text-sm text-spike-cyan hover:text-spike-cyan/80 transition-colors"
                  title="Download today's full analysis as a spreadsheet"
                  download
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download Full Report (CSV)
                </a>
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
                &copy; {new Date().getFullYear()} Spike Trades &mdash; spiketrades.ca. All rights reserved. &middot; Ver 1.0
              </p>
            </div>
          </>
        ) : null}

        {/* Lock-In Confirmation Modal */}
        {lockInSpike && (
          <LockInModal
            spike={lockInSpike}
            portfolios={portfolios}
            activePortfolioId={activeId}
            onConfirm={handleConfirmLockIn}
            onCancel={() => setLockInSpike(null)}
          />
        )}

        {/* Bulk Lock-In Modal */}
        {bulkLockInSpikes && bulkLockInSpikes.length > 0 && (
          <BulkLockInModal
            spikes={bulkLockInSpikes.map((s) => ({
              id: s.id,
              ticker: s.ticker,
              name: s.name,
              price: s.price,
              predicted3Day: s.predicted3Day,
              atr: s.atr,
            }))}
            portfolios={portfolios}
            activePortfolioId={activeId}
            onConfirm={handleConfirmBulkLockIn}
            onCancel={() => setBulkLockInSpikes(null)}
          />
        )}

        {/* Portfolio Settings Modal */}
        {showSettings && (
          <PortfolioSettings
            portfolio={activePortfolio}
            onClose={() => setShowSettings(false)}
            onUpdated={refreshPortfolios}
          />
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
      </main>
    </div>
  );
}
