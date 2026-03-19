'use client';

import { useState, useEffect } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import ParticleBackground from '@/components/layout/ParticleBackground';
import { cn, formatPercent } from '@/lib/utils';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ScatterChart, Scatter, ZAxis, Area, AreaChart,
  ReferenceLine
} from 'recharts';

interface AccuracySummary {
  horizon: number;
  totalPredictions: number;
  hitRate: number;
  mae: number;
  bias: number;
  correlation: number;
}

interface RollingData {
  date: string;
  hitRate: number;
  mae: number;
  predictions: number;
}

interface ScatterPoint {
  ticker: string;
  score: number;
  predicted: number;
  actual: number;
  date: string;
}

interface PerformancePoint {
  date: string;
  tsx: number;
  allPicks: number;
  top5Picks: number;
}

interface PortfolioReturn {
  date: string;
  ticker: string;
  returnPct: number;
  cumulative: number;
  pnl: number;
}

interface PredVsActualPoint {
  date: string;
  predicted: number;
  actual: number;
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
  const [scatter, setScatter] = useState<ScatterPoint[]>([]);
  const [perfComparison, setPerfComparison] = useState<PerformancePoint[]>([]);
  const [portfolioReturns, setPortfolioReturns] = useState<PortfolioReturn[]>([]);
  const [predVsActual, setPredVsActual] = useState<PredVsActualPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAccuracy();
  }, [horizon]);

  const fetchAccuracy = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/accuracy?horizon=${horizon}&days=90`);
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (json.success) {
        setSummary(json.data.summary);
        setRolling(json.data.rolling);
        setScatter(json.data.scatterData);
        setPerfComparison(json.data.performanceComparison || []);
        setPortfolioReturns(json.data.portfolioReturns || []);
        setPredVsActual(json.data.dailyPredVsActual || []);
      }
    } catch { /* handle */ }
    finally { setLoading(false); }
  };

  // Determine outperformance
  const latestPerf = perfComparison.length > 0 ? perfComparison[perfComparison.length - 1] : null;
  const outperformance = latestPerf ? latestPerf.allPicks - latestPerf.tsx : 0;

  return (
    <div className="min-h-screen bg-spike-bg">
      <ParticleBackground />
      <Sidebar />

      <main className="ml-64 p-8 relative z-10">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-display font-bold text-spike-cyan tracking-wide">
            ACCURACY ENGINE
          </h2>
          <div className="flex gap-2">
            {([3, 5, 8] as const).map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
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

        {/* Summary metrics */}
        {summary && (
          <div className="grid grid-cols-6 gap-3 mb-6">
            {[
              { label: 'Hit Rate', value: `${summary.hitRate.toFixed(1)}%`, color: summary.hitRate >= 55 ? 'text-spike-green' : 'text-spike-amber' },
              { label: 'MAE', value: `${summary.mae.toFixed(2)}%`, color: 'text-spike-cyan' },
              { label: 'Bias', value: formatPercent(summary.bias), color: summary.bias >= 0 ? 'text-spike-green' : 'text-spike-red' },
              { label: 'Correlation', value: summary.correlation.toFixed(3), color: summary.correlation > 0.3 ? 'text-spike-green' : 'text-spike-amber' },
              { label: 'Predictions', value: summary.totalPredictions.toString(), color: 'text-spike-violet' },
              { label: 'vs TSX', value: `${outperformance >= 0 ? '+' : ''}${outperformance.toFixed(1)}%`, color: outperformance >= 0 ? 'text-spike-green' : 'text-spike-red' },
            ].map((stat) => (
              <div key={stat.label} className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">{stat.label}</p>
                <p className={`text-xl font-bold mono ${stat.color}`}>{stat.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ============================================================ */}
        {/* HERO CHART: Portfolio Performance vs TSX Composite (Line Graph) */}
        {/* ============================================================ */}
        <div className="glass-card p-6 mb-6">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-lg font-bold text-spike-text">
                Spike Picks vs TSX Composite
              </h3>
              <p className="text-sm text-spike-text-dim">
                Cumulative {horizon}-day returns — our picks vs the overall Canadian market
              </p>
            </div>
            {latestPerf && (
              <div className={cn(
                'px-4 py-2 rounded-xl text-sm font-bold mono',
                outperformance >= 0 ? 'bg-spike-green/10 text-spike-green' : 'bg-spike-red/10 text-spike-red'
              )}>
                {outperformance >= 0 ? '+' : ''}{outperformance.toFixed(2)}% vs TSX
              </div>
            )}
          </div>
          <ResponsiveContainer width="100%" height={380}>
            <LineChart data={perfComparison}>
              <defs>
                <linearGradient id="cyanGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00F0FF" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#00F0FF" stopOpacity={0} />
                </linearGradient>
              </defs>
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
              <Legend
                wrapperStyle={{ fontSize: 12, color: '#94A3B8' }}
              />
              <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
              {/* TSX Composite baseline */}
              <Line
                type="monotone"
                dataKey="tsx"
                name="TSX Composite"
                stroke="#64748B"
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                activeDot={{ r: 4, fill: '#64748B' }}
              />
              {/* All 20 picks */}
              <Line
                type="monotone"
                dataKey="allPicks"
                name="All 20 Spike Picks"
                stroke="#00F0FF"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 5, fill: '#00F0FF', stroke: '#0A1428', strokeWidth: 2 }}
              />
              {/* Top 5 picks */}
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
        </div>

        {/* ============================================================ */}
        {/* PREDICTED vs ACTUAL LINE CHART (Daily averages over time) */}
        {/* ============================================================ */}
        <div className="glass-card p-6 mb-6">
          <div className="mb-2">
            <h3 className="text-lg font-bold text-spike-text">
              Daily Predicted vs Actual Returns
            </h3>
            <p className="text-sm text-spike-text-dim">
              Average {horizon}-day predicted return vs what actually happened each day
            </p>
          </div>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={predVsActual}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F" />
              <XAxis dataKey="date" tickFormatter={formatDate} stroke="#64748B" fontSize={11} />
              <YAxis stroke="#64748B" fontSize={11} tickFormatter={(v) => `${v}%`} />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                labelFormatter={(d) => new Date(d).toLocaleDateString('en-CA')}
                formatter={(value: number, name: string) => [`${value.toFixed(2)}%`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: '#94A3B8' }} />
              <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
              <Line
                type="monotone"
                dataKey="predicted"
                name="Predicted Return"
                stroke="#A855F7"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: '#A855F7' }}
              />
              <Line
                type="monotone"
                dataKey="actual"
                name="Actual Return"
                stroke="#00FF88"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: '#00FF88' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Second row: Your Portfolio + Rolling Hit Rate */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
          {/* Your Portfolio Cumulative Returns (closed trades) */}
          <div className="glass-card p-6">
            <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-1">
              Your Portfolio — Closed Trades
            </h3>
            <p className="text-xs text-spike-text-muted mb-4">
              Cumulative realized returns from your locked-in positions
            </p>
            {portfolioReturns.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={portfolioReturns}>
                  <defs>
                    <linearGradient id="portfolioGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00FF88" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#00FF88" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F" />
                  <XAxis dataKey="date" tickFormatter={formatDate} stroke="#64748B" fontSize={11} />
                  <YAxis stroke="#64748B" fontSize={11} tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`} />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(d) => new Date(d).toLocaleDateString('en-CA')}
                    formatter={(value: number, name: string) => {
                      if (name === 'cumulative') return [`${value > 0 ? '+' : ''}${value.toFixed(2)}%`, 'Cumulative Return'];
                      return [`${value.toFixed(2)}%`, name];
                    }}
                  />
                  <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
                  <Area
                    type="monotone"
                    dataKey="cumulative"
                    stroke="#00FF88"
                    fill="url(#portfolioGrad)"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: '#00FF88', stroke: '#0A1428', strokeWidth: 1 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[280px] flex items-center justify-center text-spike-text-muted text-sm">
                No closed trades yet. Lock in spikes and close them to see your performance here.
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
          </div>
        </div>

        {/* Third row: Scatter + MAE */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Predicted vs Actual Scatter */}
          <div className="glass-card p-6">
            <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-1">
              Prediction Accuracy Scatter
            </h3>
            <p className="text-xs text-spike-text-muted mb-4">
              Each dot is one spike pick. Points near the diagonal line = accurate predictions.
            </p>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F" />
                <XAxis
                  type="number" dataKey="predicted" name="Predicted" stroke="#64748B" fontSize={11}
                  label={{ value: 'Predicted %', position: 'insideBottom', offset: -5, style: { fill: '#64748B', fontSize: 11 } }}
                />
                <YAxis
                  type="number" dataKey="actual" name="Actual" stroke="#64748B" fontSize={11}
                  label={{ value: 'Actual %', angle: -90, position: 'insideLeft', style: { fill: '#64748B', fontSize: 11 } }}
                />
                <ZAxis type="number" dataKey="score" range={[20, 200]} name="Score" />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  formatter={(value: number, name: string) => [`${value.toFixed(2)}%`, name]}
                />
                <Scatter name="Predictions" data={scatter} fill="#00F0FF" fillOpacity={0.6} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          {/* Mean Absolute Error Trend */}
          <div className="glass-card p-6">
            <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-1">
              Prediction Error Over Time
            </h3>
            <p className="text-xs text-spike-text-muted mb-4">
              Mean Absolute Error — lower is better. Shows how the model is improving over time.
            </p>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={rolling}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F" />
                <XAxis dataKey="date" tickFormatter={formatDate} stroke="#64748B" fontSize={11} />
                <YAxis stroke="#64748B" fontSize={11} tickFormatter={(v) => `${v.toFixed(1)}%`} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelFormatter={(d) => new Date(d).toLocaleDateString('en-CA')}
                  formatter={(value: number) => [`${value.toFixed(2)}%`, 'MAE']}
                />
                <Line type="monotone" dataKey="mae" stroke="#A855F7" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="legal-footer">
          <p>
            For educational and informational purposes only. Not financial advice.
            Past performance is no guarantee of future results.
            Trading stocks involves risk. You may lose your entire investment.
          </p>
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca</p>
        </div>
      </main>
    </div>
  );
}
