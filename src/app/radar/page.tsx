'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import RadarCard from '@/components/radar/RadarCard';
import MarketHeader from '@/components/layout/MarketHeader';

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
    return <div className="flex items-center justify-center min-h-[50vh] text-gray-500">Loading Radar data...</div>;
  }

  const report = data?.report;
  const picks = data?.picks || [];

  if (!report) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-gray-500">
        <p className="text-lg">No Radar report yet.</p>
        <p className="text-sm mt-1">The pre-market scan runs at 8:15 AM AST on trading days.</p>
      </div>
    );
  }

  const avgScore = picks.length > 0
    ? Math.round(picks.reduce((s: number, p: any) => s + p.smartMoneyScore, 0) / picks.length)
    : 0;
  const topScore = picks.length > 0 ? Math.max(...picks.map((p: any) => p.smartMoneyScore)) : 0;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <MarketHeader />

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

      {/* Legal */}
      <div className="mt-8 text-center text-[10px] text-gray-600">
        For informational purposes only. Not financial advice.
      </div>
    </div>
  );
}

export default function RadarPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[50vh] text-gray-500">Loading...</div>}>
      <RadarContent />
    </Suspense>
  );
}
