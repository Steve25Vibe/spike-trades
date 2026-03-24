'use client';

import { useState, useEffect } from 'react';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import { cn, formatPercent } from '@/lib/utils';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Area, AreaChart, BarChart, Bar, Cell,
  ReferenceLine
} from 'recharts';

interface AccuracySummary {
  horizon: number;
  totalPredictions: number;
  hitRate: number;
  mae: number;
  bias: number;
  avgReturn: number;
  avgPredicted: number;
  alpha: number;
  bestPick: { ticker: string; return: number } | null;
}

interface RollingData {
  date: string;
  hitRate: number;
  mae: number;
  predictions: number;
}

interface PerformancePoint {
  date: string;
  tsx: number;
  allPicks: number;
  top5Picks: number;
}

interface DistributionBucket {
  label: string;
  count: number;
  color: string;
}

interface RecentPick {
  date: string;
  ticker: string;
  name: string;
  rank: number;
  score: number;
  predicted: number;
  actual: number;
  hit: boolean;
}

const CHART_TOOLTIP_STYLE = {
  background: '#111E33',
  border: '1px solid #1E3A5F',
  borderRadius: 8,
  fontSize: 12,
  color: '#E2E8F0',
};

const formatDate = (d: string) =>
  new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });

export default function AccuracyPage() {
  const [horizon, setHorizon] = useState<3 | 5 | 8>(3);
  const [summary, setSummary] = useState<AccuracySummary | null>(null);
  const [rolling, setRolling] = useState<RollingData[]>([]);
  const [perfComparison, setPerfComparison] = useState<PerformancePoint[]>([]);
  const [distribution, setDistribution] = useState<DistributionBucket[]>([]);
  const [recentPicks, setRecentPicks] = useState<RecentPick[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAccuracy();
  }, [horizon]);

  const fetchAccuracy = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ horizon: String(horizon), days: '90' });
      const res = await fetch(`/api/accuracy?${params}`);
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (json.success) {
        setSummary(json.data.summary);
        setRolling(json.data.rolling);
        setPerfComparison(json.data.performanceComparison || []);
        setDistribution(json.data.returnDistribution || []);
        setRecentPicks(json.data.recentPicks || []);
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
          <div className="flex items-center gap-4">
          <div className="flex gap-2">
            {([3, 5, 8] as const).map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                title={`Check prediction accuracy after ${h} trading days`}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-all',
                  horizon === h
                    ? 'bg-spike-cyan/10 text-spike-cyan border border-spike-cyan/20'
                    : 'text-spike-text-dim hover:text-spike-text hover:bg-spike-bg-hover'
                )}
              >
                {h}-Day
              </button>
            ))}
          </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* SECTION 1: Summary Cards */}
        {/* ============================================================ */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            {[
              {
                label: 'Win Rate',
                value: `${summary.hitRate.toFixed(1)}%`,
                sub: 'correct direction',
                color: summary.hitRate >= 55 ? 'text-spike-green' : summary.hitRate >= 50 ? 'text-spike-amber' : 'text-spike-red',
              },
              {
                label: 'Avg Return',
                value: `${summary.avgReturn >= 0 ? '+' : ''}${summary.avgReturn.toFixed(2)}%`,
                sub: `per ${horizon}-day pick`,
                color: summary.avgReturn >= 0 ? 'text-spike-green' : 'text-spike-red',
              },
              {
                label: 'Alpha vs TSX',
                value: `${summary.alpha >= 0 ? '+' : ''}${summary.alpha.toFixed(2)}%`,
                sub: 'outperformance',
                color: summary.alpha >= 0 ? 'text-spike-green' : 'text-spike-red',
              },
              {
                label: 'Avg Predicted',
                value: `${summary.avgPredicted >= 0 ? '+' : ''}${summary.avgPredicted.toFixed(2)}%`,
                sub: 'forecast avg',
                color: 'text-spike-cyan',
              },
              {
                label: 'Total Picks',
                value: summary.totalPredictions.toString(),
                sub: 'tracked',
                color: 'text-spike-violet',
              },
              {
                label: 'Best Pick',
                value: summary.bestPick ? summary.bestPick.ticker.replace('.TO', '') : '—',
                sub: summary.bestPick ? `+${summary.bestPick.return.toFixed(1)}%` : '',
                color: 'text-spike-green',
              },
            ].map((stat) => (
              <div key={stat.label} className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">{stat.label}</p>
                <p className={`text-xl font-bold mono ${stat.color}`}>{stat.value}</p>
                {stat.sub && <p className="text-[10px] text-spike-text-dim mt-0.5">{stat.sub}</p>}
              </div>
            ))}
          </div>
        )}

        {/* ============================================================ */}
        {/* SECTION 2: Hero Chart — Spike Picks vs TSX (same N-day windows) */}
        {/* ============================================================ */}
        <div className="glass-card p-6 mb-6">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-lg font-bold text-spike-text">
                Spike Picks vs TSX
              </h3>
              <p className="text-sm text-spike-text-dim">
                Cumulative {horizon}-day returns — picks vs TSX over same windows
              </p>
            </div>
            {summary && (
              <div className={cn(
                'px-4 py-2 rounded-xl text-sm font-bold mono',
                summary.alpha >= 0 ? 'bg-spike-green/10 text-spike-green' : 'bg-spike-red/10 text-spike-red'
              )}>
                {summary.alpha >= 0 ? '+' : ''}{summary.alpha.toFixed(2)}% vs TSX
              </div>
            )}
          </div>
          {perfComparison.length > 0 ? (
            <ResponsiveContainer width="100%" height={380}>
              <LineChart data={perfComparison}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="#64748B"
                  fontSize={11}
                />
                <YAxis
                  stroke="#64748B"
                  fontSize={11}
                  tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`}
                />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelFormatter={(d) => new Date(d).toLocaleDateString('en-CA', { weekday: 'short', month: 'long', day: 'numeric' })}
                  formatter={(value: number, name: string) => [`${value > 0 ? '+' : ''}${value.toFixed(2)}%`, name]}
                />
                <Legend wrapperStyle={{ fontSize: 12, color: '#94A3B8' }} />
                <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="tsx"
                  name="TSX (XIU)"
                  stroke="#64748B"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  activeDot={{ r: 4, fill: '#64748B' }}
                />
                <Line
                  type="monotone"
                  dataKey="allPicks"
                  name="All Spike Picks"
                  stroke="#00F0FF"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5, fill: '#00F0FF', stroke: '#0A1428', strokeWidth: 2 }}
                />
                <Line
                  type="monotone"
                  dataKey="top5Picks"
                  name="Top 5 Picks"
                  stroke="#00FF88"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5, fill: '#00FF88', stroke: '#0A1428', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[380px] flex items-center justify-center text-spike-text-muted text-sm">
              Not enough data yet. Performance comparison will appear after accuracy checks run.
            </div>
          )}
        </div>

        {/* ============================================================ */}
        {/* SECTION 3: Win/Loss Distribution + Rolling Accuracy */}
        {/* ============================================================ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
          {/* Win/Loss Distribution */}
          <div className="glass-card p-6">
            <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-1">
              Return Distribution
            </h3>
            <p className="text-xs text-spike-text-muted mb-4">
              How {horizon}-day actual returns are distributed across all picks
            </p>
            {distribution.length > 0 && distribution.some(d => d.count > 0) ? (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={distribution} layout="vertical" margin={{ left: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F" horizontal={false} />
                  <XAxis type="number" stroke="#64748B" fontSize={11} />
                  <YAxis
                    type="category"
                    dataKey="label"
                    stroke="#64748B"
                    fontSize={11}
                    width={65}
                  />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value: number) => [`${value} picks`, 'Count']}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {distribution.map((entry, idx) => (
                      <Cell
                        key={idx}
                        fill={entry.color === 'green' ? '#00FF88' : '#FF3366'}
                        fillOpacity={0.7}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[280px] flex items-center justify-center text-spike-text-muted text-sm">
                No return data available yet.
              </div>
            )}
          </div>

          {/* Rolling Hit Rate */}
          <div className="glass-card p-6">
            <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-1">
              Rolling Directional Accuracy
            </h3>
            <p className="text-xs text-spike-text-muted mb-4">
              What % of predictions correctly predicted the direction of the move
            </p>
            {rolling.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={rolling}>
                  <defs>
                    <linearGradient id="hitRateGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00F0FF" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#00F0FF" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F" />
                  <XAxis dataKey="date" tickFormatter={formatDate} stroke="#64748B" fontSize={11} />
                  <YAxis stroke="#64748B" fontSize={11} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(d) => new Date(d).toLocaleDateString('en-CA')}
                    formatter={(value: number) => [`${value.toFixed(1)}%`, 'Hit Rate']}
                  />
                  <ReferenceLine y={50} stroke="#FF3366" strokeDasharray="5 5" label={{ value: '50% (random)', fill: '#FF3366', fontSize: 10, position: 'right' }} />
                  <Area type="monotone" dataKey="hitRate" stroke="#00F0FF" fill="url(#hitRateGrad)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[280px] flex items-center justify-center text-spike-text-muted text-sm">
                Not enough data for rolling accuracy yet.
              </div>
            )}
          </div>
        </div>

        {/* ============================================================ */}
        {/* SECTION 4: Recent Picks Performance Table */}
        {/* ============================================================ */}
        <div className="glass-card p-6">
          <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-1">
            Recent Pick Results
          </h3>
          <p className="text-xs text-spike-text-muted mb-4">
            Last 30 picks with {horizon}-day actual returns — did we call it right?
          </p>
          {recentPicks.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-spike-border text-spike-text-dim text-xs uppercase tracking-wider">
                    <th className="py-2 px-3 text-left">Date</th>
                    <th className="py-2 px-3 text-left">Ticker</th>
                    <th className="py-2 px-3 text-center">Rank</th>
                    <th className="py-2 px-3 text-right">Predicted</th>
                    <th className="py-2 px-3 text-right">Actual</th>
                    <th className="py-2 px-3 text-center">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPicks.map((pick, idx) => {
                    const isWin = pick.actual >= 0;
                    return (
                      <tr
                        key={`${pick.ticker}-${pick.date}-${idx}`}
                        className={cn(
                          'border-b border-spike-border/30 transition-colors',
                          isWin ? 'bg-spike-green/[0.03]' : 'bg-spike-red/[0.03]',
                          'hover:bg-spike-bg-hover'
                        )}
                      >
                        <td className="py-2.5 px-3 text-spike-text-dim text-xs mono">
                          {new Date(pick.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="py-2.5 px-3">
                          <a
                            href={`https://finance.yahoo.com/quote/${pick.ticker}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-spike-cyan hover:underline font-medium"
                            title={pick.name}
                          >
                            {pick.ticker.replace('.TO', '')}
                          </a>
                        </td>
                        <td className="py-2.5 px-3 text-center text-spike-text-dim text-xs">
                          #{pick.rank}
                        </td>
                        <td className="py-2.5 px-3 text-right mono text-spike-text-dim">
                          {pick.predicted >= 0 ? '+' : ''}{pick.predicted.toFixed(2)}%
                        </td>
                        <td className={cn(
                          'py-2.5 px-3 text-right mono font-medium',
                          pick.actual >= 0 ? 'text-spike-green' : 'text-spike-red'
                        )}>
                          {pick.actual >= 0 ? '+' : ''}{pick.actual.toFixed(2)}%
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {pick.hit ? (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-spike-green/10 text-spike-green text-xs" title="Correct direction">
                              &#10003;
                            </span>
                          ) : (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-spike-red/10 text-spike-red text-xs" title="Wrong direction">
                              &#10007;
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-12 text-center text-spike-text-muted text-sm">
              No picks with {horizon}-day results yet. Results appear after the accuracy backfill runs.
            </div>
          )}
        </div>

        <div className="legal-footer">
          <p>
            For educational and informational purposes only. Not financial advice.
            Past performance is no guarantee of future results.
            Trading stocks involves risk. You may lose your entire investment.
          </p>
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca &middot; Ver 2.5</p>
        </div>
    </ResponsiveLayout>
  );
}
