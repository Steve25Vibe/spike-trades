'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/layout/Sidebar';
import ParticleBackground from '@/components/layout/ParticleBackground';
import { cn } from '@/lib/utils';

interface Report {
  id: string;
  date: string;
  marketRegime: string;
  tsxLevel: number;
  tsxChange: number;
  csvUrl: string;
  topSpikes: { ticker: string; spikeScore: number; predicted3Day: number; actual3Day: number | null }[];
}

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchReports();
  }, [page]);

  const fetchReports = async () => {
    try {
      const res = await fetch(`/api/reports?page=${page}&pageSize=20`);
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (json.success) {
        setReports(json.data);
        setTotal(json.total);
      }
    } catch {
      // handle
    } finally {
      setLoading(false);
    }
  };

  const regimeColors: Record<string, string> = {
    bull: 'text-spike-green bg-spike-green/10',
    bear: 'text-spike-red bg-spike-red/10',
    neutral: 'text-spike-amber bg-spike-amber/10',
    volatile: 'text-spike-violet bg-spike-violet/10',
  };

  return (
    <div className="min-h-screen bg-spike-bg">
      <ParticleBackground />
      <Sidebar />

      <main className="ml-64 p-8 relative z-10">
        <h2 className="text-2xl font-display font-bold text-spike-cyan tracking-wide mb-6">
          REPORT ARCHIVES
        </h2>

        <div className="space-y-3">
          {reports.map((report) => (
            <div
              key={report.id}
              className="glass-card p-4 flex items-center justify-between gap-4 hover:border-spike-cyan/30"
            >
              <div className="flex items-center gap-4">
                <div>
                  <p className="font-bold text-spike-text">
                    {new Date(report.date).toLocaleDateString('en-CA', {
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
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Link
                  href={`/dashboard?date=${report.date}`}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-spike-cyan border border-spike-cyan/30 hover:bg-spike-cyan/10 transition-colors"
                >
                  View
                </Link>
                <a
                  href={`/api/reports/${report.id}/xlsx`}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide text-spike-green border border-spike-green/30 hover:bg-spike-green/10 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  XLSX
                </a>
              </div>
            </div>
          ))}

          {reports.length === 0 && !loading && (
            <div className="glass-card p-12 text-center text-spike-text-dim">
              No reports yet. The first analysis runs at 10:45 AM AST.
            </div>
          )}
        </div>

        {/* Pagination */}
        {total > 20 && (
          <div className="flex justify-center gap-2 mt-6">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="px-4 py-2 rounded-lg text-sm text-spike-text-dim hover:text-spike-text disabled:opacity-30"
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
            >
              Next →
            </button>
          </div>
        )}

        <div className="legal-footer">
          <p>For educational and informational purposes only. Not financial advice. Past performance is no guarantee of future results.</p>
        </div>
      </main>
    </div>
  );
}
