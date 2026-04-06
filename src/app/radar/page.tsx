'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import RadarCard from '@/components/radar/RadarCard';
import RadarIcon from '@/components/radar/RadarIcon';

function RadarContent() {
  const searchParams = useSearchParams();
  const dateParam = searchParams.get('date');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const url = dateParam ? `/api/radar?date=${dateParam}` : '/api/radar';
    fetch(url)
      .then(r => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [dateParam]);

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
        {/* Radar header — no market indicators (pre-market, market is closed) */}
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

        {/* RadarCard grid */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {picks.map((pick: any) => (
            <RadarCard key={pick.id} pick={pick} />
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
