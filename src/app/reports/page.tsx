'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import { cn } from '@/lib/utils';

interface SpikeReport {
  id: string;
  date: string;
  marketRegime: string;
  tsxLevel: number;
  tsxChange: number;
  csvUrl: string;
  topSpikes: { ticker: string; spikeScore: number; predicted3Day: number; actual3Day: number | null }[];
}

interface OpeningBellPick {
  ticker: string;
  momentumScore: number;
  changePercent: number;
  targetHit: boolean | null;
}

interface OpeningBellReport {
  id: string;
  date: string;
  generatedAt: string;
  tickersScanned: number;
  scanDurationMs: number;
  topPicks: OpeningBellPick[];
}

interface RadarReport {
  id: string;
  date: string;
  tickersScanned: number;
  tickersFlagged: number;
  scanDurationMs: number;
  picks: { ticker: string; smartMoneyScore: number }[];
}

export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsContent />
    </Suspense>
  );
}

function ReportsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = (searchParams.get('tab') || 'spikes') as 'spikes' | 'opening-bell' | 'radar';

  const [spikeReports, setSpikeReports] = useState<SpikeReport[]>([]);
  const [openingBellReports, setOpeningBellReports] = useState<OpeningBellReport[]>([]);
  const [radarReports, setRadarReports] = useState<RadarReport[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPage(1);
  }, [activeTab]);

  useEffect(() => {
    fetchReports();
  }, [activeTab, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchReports = async () => {
    setLoading(true);
    try {
      const endpoint =
        activeTab === 'radar'
          ? `/api/reports/radar?page=${page}&pageSize=20`
          : activeTab === 'opening-bell'
            ? `/api/reports/opening-bell?page=${page}&pageSize=20`
            : `/api/reports?page=${page}&pageSize=20`;

      const res = await fetch(endpoint);
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (activeTab === 'radar') {
        if (json.reports) {
          setRadarReports(json.reports);
          setTotal(json.total);
        }
      } else if (json.success) {
        if (activeTab === 'opening-bell') {
          setOpeningBellReports(json.data);
        } else {
          setSpikeReports(json.data);
        }
        setTotal(json.total);
      }
    } catch {
      // handle
    } finally {
      setLoading(false);
    }
  };

  const setTab = (tab: 'spikes' | 'opening-bell' | 'radar') => {
    router.push(`/reports?tab=${tab}`);
  };

  const regimeColors: Record<string, string> = {
    bull: 'text-spike-green bg-spike-green/10',
    bear: 'text-spike-red bg-spike-red/10',
    neutral: 'text-spike-amber bg-spike-amber/10',
    volatile: 'text-spike-violet bg-spike-violet/10',
  };

  return (
    <ResponsiveLayout>
      <h2 className="text-2xl font-display font-bold text-spike-cyan tracking-wide mb-6">
        REPORT ARCHIVES
      </h2>

      {/* Tab buttons */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab('spikes')}
          className={cn(
            'px-5 py-2 rounded-lg text-sm font-bold uppercase tracking-wide border transition-colors',
            activeTab === 'spikes'
              ? 'text-spike-cyan border-spike-cyan bg-spike-cyan/10'
              : 'text-spike-text-dim border-spike-text-dim/20 hover:text-spike-text hover:border-spike-text-dim/40'
          )}
        >
          Today&apos;s Spikes
        </button>
        <button
          onClick={() => setTab('opening-bell')}
          className={cn(
            'px-5 py-2 rounded-lg text-sm font-bold uppercase tracking-wide border transition-colors',
            activeTab === 'opening-bell'
              ? 'text-spike-amber border-spike-amber bg-spike-amber/10'
              : 'text-spike-text-dim border-spike-text-dim/20 hover:text-spike-text hover:border-spike-text-dim/40'
          )}
        >
          Opening Bell
        </button>
        <button
          onClick={() => setTab('radar')}
          className={cn(
            'px-5 py-2 rounded-lg text-sm font-bold uppercase tracking-wide border transition-colors',
            activeTab === 'radar'
              ? 'text-green-400 border-green-400 bg-green-400/10'
              : 'text-spike-text-dim border-spike-text-dim/20 hover:text-spike-text hover:border-spike-text-dim/40'
          )}
        >
          Radar
        </button>
      </div>

      {/* Spikes tab */}
      {activeTab === 'spikes' && (
        <div className="space-y-3">
          {spikeReports.map((report) => (
            <div
              key={report.id}
              className="glass-card p-4 flex items-center justify-between gap-4 hover:border-spike-cyan/30"
            >
              <div className="flex items-center gap-4">
                <div>
                  <p className="font-bold text-spike-text">
                    {new Date(new Date(report.date).toISOString().split('T')[0] + 'T12:00:00').toLocaleDateString('en-CA', {
                      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
                    })}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={cn(
                      'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase',
                      regimeColors[report.marketRegime] || regimeColors.neutral
                    )}>
                      {report.marketRegime}
                    </span>
                    <span className="text-xs text-spike-text-dim mono">
                      TSX {report.tsxLevel?.toFixed(0)}
                    </span>
                  </div>
                  {report.topSpikes?.length > 0 && (
                    <div className="flex gap-2 mt-1.5 flex-wrap">
                      {report.topSpikes.map((s) => (
                        <span key={s.ticker} className="text-[10px] mono text-spike-cyan/70">
                          {s.ticker} <span className="text-spike-text-dim">{s.spikeScore?.toFixed(1)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Link
                  href={`/dashboard?date=${new Date(report.date).toISOString().split('T')[0]}`}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-spike-cyan border border-spike-cyan/30 hover:bg-spike-cyan/10 transition-colors"
                  title="Open this day's report on the dashboard"
                >
                  View
                </Link>
                <a
                  href={`/api/reports/${report.id}/xlsx`}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-spike-green border border-spike-green/30 hover:bg-spike-green/10 transition-colors"
                  title="Download this report as an Excel file"
                  onClick={(e) => e.stopPropagation()}
                >
                  XLSX
                </a>
              </div>
            </div>
          ))}

          {spikeReports.length === 0 && !loading && (
            <div className="glass-card p-12 text-center text-spike-text-dim">
              No reports yet. The first analysis runs at 10:45 AM AST.
            </div>
          )}
        </div>
      )}

      {/* Opening Bell tab */}
      {activeTab === 'opening-bell' && (
        <div className="space-y-3">
          {openingBellReports.map((report) => (
            <div
              key={report.id}
              className="glass-card p-4 flex items-center justify-between gap-4 hover:border-spike-amber/30"
            >
              <div className="flex items-center gap-4">
                <div>
                  <p className="font-bold text-spike-text">
                    {new Date(report.date + 'T12:00:00').toLocaleDateString('en-CA', {
                      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
                    })}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-spike-text-dim mono">
                      {report.tickersScanned} tickers · {(report.scanDurationMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                  {report.topPicks?.length > 0 && (
                    <div className="flex gap-2 mt-1.5 flex-wrap">
                      {report.topPicks.map((p) => (
                        <span key={p.ticker} className="text-[10px] mono text-spike-amber/70">
                          {p.ticker}{' '}
                          <span className="text-spike-text-dim">{p.momentumScore?.toFixed(1)}</span>
                          {p.changePercent != null && (
                            <span className={p.changePercent >= 0 ? 'text-spike-green' : 'text-spike-red'}>
                              {' '}{p.changePercent >= 0 ? '+' : ''}{p.changePercent.toFixed(2)}%
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Link
                  href={`/opening-bell?date=${report.date}`}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-spike-amber border border-spike-amber/30 hover:bg-spike-amber/10 transition-colors"
                  title="Open this Opening Bell report"
                >
                  View
                </Link>
                <a
                  href={`/api/reports/opening-bell/${report.id}/xlsx`}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-spike-green border border-spike-green/30 hover:bg-spike-green/10 transition-colors"
                  title="Download this Opening Bell report as an Excel file"
                  onClick={(e) => e.stopPropagation()}
                >
                  XLSX
                </a>
              </div>
            </div>
          ))}

          {openingBellReports.length === 0 && !loading && (
            <div className="glass-card p-12 text-center text-spike-text-dim">
              No Opening Bell reports yet. The scan runs at 10:35 AM AST on market days.
            </div>
          )}
        </div>
      )}

      {/* Radar tab */}
      {activeTab === 'radar' && (
        <div className="space-y-3">
          {radarReports.map((report) => (
            <div
              key={report.id}
              className="glass-card p-4 flex items-center justify-between gap-4 hover:border-green-400/30"
            >
              <div>
                <p className="font-bold text-spike-text">
                  {new Date(new Date(report.date).toISOString().split('T')[0] + 'T12:00:00').toLocaleDateString('en-CA', {
                    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
                  })}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-green-400">{report.tickersFlagged} flagged</span>
                  <span className="text-xs text-spike-text-dim">·</span>
                  <span className="text-xs text-spike-text-dim mono">
                    {report.tickersScanned} scanned · {(report.scanDurationMs / 1000).toFixed(1)}s
                  </span>
                </div>
                {report.picks?.length > 0 && (
                  <div className="flex gap-2 mt-1.5 flex-wrap">
                    {report.picks.map((p) => (
                      <span key={p.ticker} className="text-[10px] mono text-green-400/70">
                        {p.ticker} <span className="text-spike-text-dim">{p.smartMoneyScore}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <Link
                href={`/radar?date=${new Date(report.date).toISOString().split('T')[0]}`}
                className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-green-400 border border-green-400/30 hover:bg-green-400/10 transition-colors"
                title="Open this Radar report"
              >
                View
              </Link>
            </div>
          ))}

          {radarReports.length === 0 && !loading && (
            <div className="glass-card p-12 text-center text-spike-text-dim">
              No Radar reports yet. The pre-market scan runs at 8:15 AM AST on trading days.
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {total > 20 && (
        <div className="flex justify-center gap-2 mt-6">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="px-4 py-2 rounded-lg text-sm text-spike-text-dim hover:text-spike-text disabled:opacity-30"
            title="Go to the previous page of reports"
          >
            ← Previous
          </button>
          <span className="px-4 py-2 text-sm text-spike-text-dim">
            Page {page} of {Math.ceil(total / 20)}
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={page >= Math.ceil(total / 20)}
            className="px-4 py-2 rounded-lg text-sm text-spike-text-dim hover:text-spike-text disabled:opacity-30"
            title="Go to the next page of reports"
          >
            Next →
          </button>
        </div>
      )}

      <div className="legal-footer">
        <p>For educational and informational purposes only. Not financial advice. Past performance is no guarantee of future results.</p>
        <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca &middot; Ver 5.0</p>
      </div>
    </ResponsiveLayout>
  );
}
