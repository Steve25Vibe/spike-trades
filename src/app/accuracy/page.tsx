'use client';

import { useState, useEffect } from 'react';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import { cn } from '@/lib/utils';
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell, Legend
} from 'recharts';

// ---- Types ----

interface CandlestickPoint {
  date: string;
  avg3: number | null; min3: number | null; max3: number | null; index3: number;
  avg5: number | null; min5: number | null; max5: number | null; index5: number;
  avg8: number | null; min8: number | null; max8: number | null; index8: number;
}

interface Scorecard {
  horizon: number;
  wins: number;
  losses: number;
  total: number;
  winRate: number | null;
  avgReturn: number | null;
  indexValue: number;
  hasData: boolean;
}

interface RecentPick {
  date: string;
  ticker: string;
  name: string;
  rank: number;
  score: number;
  predicted3: number;
  predicted5: number;
  predicted8: number;
  actual3: number | null;
  actual5: number | null;
  actual8: number | null;
}

interface IndexValues {
  day3: number;
  day5: number;
  day8: number;
}

// ---- Constants ----

const HORIZON_COLORS = {
  3: { main: '#00F0FF', dim: '#00F0FF80', label: '3-Day' },
  5: { main: '#00FF88', dim: '#00FF8880', label: '5-Day' },
  8: { main: '#A855F7', dim: '#A855F780', label: '8-Day' },
};

const CHART_TOOLTIP_STYLE = {
  background: '#111E33',
  border: '1px solid #1E3A5F',
  borderRadius: 8,
  fontSize: 12,
  color: '#E2E8F0',
};

const formatDate = (d: string) =>
  new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });

// ---- Custom Candlestick Shape ----
// Renders a candle: body from 0 to avg, wicks from min to max

interface CandleProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Record<string, unknown>;
  avgKey: string;
  minKey: string;
  maxKey: string;
  color: string;
  yScale: (val: number) => number;
}

function CandlestickShape({ x = 0, width = 0, payload, avgKey, minKey, maxKey, color, yScale }: CandleProps) {
  if (!payload) return null;
  const avg = payload[avgKey] as number | null;
  const min = payload[minKey] as number | null;
  const max = payload[maxKey] as number | null;

  if (avg === null || avg === undefined) return null;

  const zeroY = yScale(0);
  const avgY = yScale(avg);
  const minY = min !== null ? yScale(min) : avgY;
  const maxY = max !== null ? yScale(max) : avgY;

  const bodyTop = Math.min(zeroY, avgY);
  const bodyHeight = Math.abs(avgY - zeroY);
  const isPositive = avg >= 0;
  const fillColor = isPositive ? '#00FF88' : '#FF3366';
  const wickX = x + width / 2;

  return (
    <g>
      {/* Wick — thin line from min to max */}
      <line
        x1={wickX}
        y1={maxY}
        x2={wickX}
        y2={minY}
        stroke={color}
        strokeWidth={1.5}
        strokeOpacity={0.6}
      />
      {/* Wick caps */}
      <line x1={wickX - 3} y1={maxY} x2={wickX + 3} y2={maxY} stroke={color} strokeWidth={1} strokeOpacity={0.5} />
      <line x1={wickX - 3} y1={minY} x2={wickX + 3} y2={minY} stroke={color} strokeWidth={1} strokeOpacity={0.5} />
      {/* Body — filled rect from 0 to avg */}
      <rect
        x={x + 1}
        y={bodyTop}
        width={Math.max(width - 2, 4)}
        height={Math.max(bodyHeight, 2)}
        fill={fillColor}
        fillOpacity={0.75}
        stroke={color}
        strokeWidth={1.5}
        rx={2}
      />
    </g>
  );
}

// ---- Custom Tooltip ----

function CandlestickTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload[0]) return null;
  const data = payload[0].payload;
  const dateStr = new Date(label).toLocaleDateString('en-CA', { weekday: 'short', month: 'long', day: 'numeric' });

  return (
    <div style={CHART_TOOLTIP_STYLE} className="p-3 shadow-lg">
      <p className="text-spike-text-dim text-xs mb-2">{dateStr}</p>
      {([3, 5, 8] as const).map((h) => {
        const avg = data[`avg${h}`];
        if (avg === null || avg === undefined) return null;
        const min = data[`min${h}`];
        const max = data[`max${h}`];
        const { main, label: hLabel } = HORIZON_COLORS[h];
        return (
          <div key={h} className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: main }} />
            <span className="text-xs text-spike-text-dim w-12">{hLabel}</span>
            <span className={cn('text-xs mono font-medium', avg >= 0 ? 'text-spike-green' : 'text-spike-red')}>
              Avg: {avg >= 0 ? '+' : ''}{avg.toFixed(2)}%
            </span>
            <span className="text-xs text-spike-text-muted mono">
              ({min !== null ? `${min >= 0 ? '+' : ''}${min.toFixed(1)}` : '?'} to {max !== null ? `${max >= 0 ? '+' : ''}${max.toFixed(1)}` : '?'}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---- Page ----

export default function AccuracyPage() {
  const [candlestickData, setCandlestickData] = useState<CandlestickPoint[]>([]);
  const [scorecards, setScorecards] = useState<Scorecard[]>([]);
  const [recentPicks, setRecentPicks] = useState<RecentPick[]>([]);
  const [indexValues, setIndexValues] = useState<IndexValues>({ day3: 100, day5: 100, day8: 100 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAccuracy();
  }, []);

  const fetchAccuracy = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/accuracy?days=90');
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (json.success) {
        setCandlestickData(json.data.candlestickData || []);
        setScorecards(json.data.scorecards || []);
        setRecentPicks(json.data.recentPicks || []);
        setIndexValues(json.data.indexValues || { day3: 100, day5: 100, day8: 100 });
      }
    } catch { /* handle */ }
    finally { setLoading(false); }
  };

  // Compute Y-axis domain from candlestick data
  const allValues = candlestickData.flatMap((d) => [
    d.min3, d.max3, d.min5, d.max5, d.min8, d.max8,
  ]).filter((v): v is number => v !== null && v !== undefined);
  const yMin = allValues.length > 0 ? Math.floor(Math.min(...allValues) - 1) : -10;
  const yMax = allValues.length > 0 ? Math.ceil(Math.max(...allValues) + 1) : 10;

  // We need the Y scale function for candlestick shapes.
  // We'll pass it via a ref approach: store chart dimensions after render.
  // But recharts custom shapes don't get the scale directly.
  // Instead, we use the ErrorBar approach OR render candlesticks via <Customized>.
  // Simplest: use a Customized component with access to the chart's yAxis scale.

  return (
    <ResponsiveLayout>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <h2 className="text-xl sm:text-2xl font-display font-bold text-spike-cyan tracking-wide">
            ACCURACY ENGINE
          </h2>
          <div className="flex items-center gap-2">
            {([3, 5, 8] as const).map((h) => {
              const idx = indexValues[`day${h}` as keyof IndexValues];
              const hasData = scorecards.find((s) => s.horizon === h)?.hasData;
              const { main, label } = HORIZON_COLORS[h];
              return (
                <div key={h} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-spike-bg-card border border-spike-border">
                  <span className="w-2 h-2 rounded-full" style={{ background: main }} />
                  <span className="text-xs text-spike-text-dim">{label}</span>
                  <span className={cn('text-xs mono font-bold', hasData ? (idx >= 100 ? 'text-spike-green' : 'text-spike-red') : 'text-spike-text-muted')}>
                    {hasData ? idx.toFixed(1) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ============================================================ */}
        {/* SECTION 1: Candlestick Performance Chart */}
        {/* ============================================================ */}
        <div className="glass-card p-6 mb-6">
          <div className="mb-2">
            <h3 className="text-lg font-bold text-spike-text">
              Spike Trades Performance Index
            </h3>
            <p className="text-sm text-spike-text-dim">
              Each candle shows the average return (body) and range from worst to best pick (wicks) per report date
            </p>
          </div>
          {candlestickData.length > 0 && allValues.length > 0 ? (
            <ResponsiveContainer width="100%" height={420}>
              <ComposedChart data={candlestickData} barGap={2} barCategoryGap="20%">
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
                  domain={[yMin, yMax]}
                  tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`}
                />
                <Tooltip content={<CandlestickTooltip />} />
                <ReferenceLine y={0} stroke="#475569" strokeWidth={1.5} strokeDasharray="6 3" />
                <Legend
                  wrapperStyle={{ fontSize: 12, color: '#94A3B8', paddingTop: 8 }}
                  payload={[
                    { value: '3-Day', type: 'square', color: HORIZON_COLORS[3].main },
                    { value: '5-Day', type: 'square', color: HORIZON_COLORS[5].main },
                    { value: '8-Day', type: 'square', color: HORIZON_COLORS[8].main },
                  ]}
                />
                {/* 3-Day candles */}
                <Bar dataKey="avg3" name="3-Day" barSize={16}
                  shape={(props: any) => {
                    const { y: chartY, height: chartH, ...rest } = props;
                    // recharts Bar gives us x, y, width, height based on the avg value
                    // We need to compute yScale from the chart's coordinate system
                    const yAxisHeight = 420 - 30 - 30; // approx chart area (minus margins)
                    const yRange = yMax - yMin;
                    const yScale = (val: number) => 30 + ((yMax - val) / yRange) * yAxisHeight;
                    return <CandlestickShape {...rest} y={chartY} height={chartH} avgKey="avg3" minKey="min3" maxKey="max3" color={HORIZON_COLORS[3].main} yScale={yScale} />;
                  }}
                >
                  {candlestickData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.avg3 !== null && entry.avg3 >= 0 ? '#00FF88' : '#FF3366'} fillOpacity={entry.avg3 !== null ? 0.75 : 0} />
                  ))}
                </Bar>
                {/* 5-Day candles */}
                <Bar dataKey="avg5" name="5-Day" barSize={16}
                  shape={(props: any) => {
                    const { y: chartY, height: chartH, ...rest } = props;
                    const yAxisHeight = 420 - 30 - 30;
                    const yRange = yMax - yMin;
                    const yScale = (val: number) => 30 + ((yMax - val) / yRange) * yAxisHeight;
                    return <CandlestickShape {...rest} y={chartY} height={chartH} avgKey="avg5" minKey="min5" maxKey="max5" color={HORIZON_COLORS[5].main} yScale={yScale} />;
                  }}
                >
                  {candlestickData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.avg5 !== null && entry.avg5 >= 0 ? '#00FF88' : '#FF3366'} fillOpacity={entry.avg5 !== null ? 0.75 : 0} />
                  ))}
                </Bar>
                {/* 8-Day candles */}
                <Bar dataKey="avg8" name="8-Day" barSize={16}
                  shape={(props: any) => {
                    const { y: chartY, height: chartH, ...rest } = props;
                    const yAxisHeight = 420 - 30 - 30;
                    const yRange = yMax - yMin;
                    const yScale = (val: number) => 30 + ((yMax - val) / yRange) * yAxisHeight;
                    return <CandlestickShape {...rest} y={chartY} height={chartH} avgKey="avg8" minKey="min8" maxKey="max8" color={HORIZON_COLORS[8].main} yScale={yScale} />;
                  }}
                >
                  {candlestickData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.avg8 !== null && entry.avg8 >= 0 ? '#00FF88' : '#FF3366'} fillOpacity={entry.avg8 !== null ? 0.75 : 0} />
                  ))}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[420px] flex items-center justify-center text-spike-text-muted text-sm">
              {loading ? 'Loading performance data...' : 'No accuracy data yet. Results appear after the daily 4:30 PM backfill runs.'}
            </div>
          )}
        </div>

        {/* ============================================================ */}
        {/* SECTION 2: Horizon Scorecards */}
        {/* ============================================================ */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {([3, 5, 8] as const).map((h) => {
            const card = scorecards.find((s) => s.horizon === h);
            const { main, label } = HORIZON_COLORS[h];

            if (!card || !card.hasData) {
              return (
                <div key={h} className="glass-card p-5 text-center">
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <span className="w-3 h-3 rounded-full" style={{ background: main }} />
                    <span className="text-sm font-bold text-spike-text uppercase tracking-wider">{label}</span>
                  </div>
                  <p className="text-spike-text-muted text-sm">Awaiting Data</p>
                  <p className="text-spike-text-dim text-xs mt-1">
                    Results appear {h} trading days after picks are made
                  </p>
                </div>
              );
            }

            const winPct = card.winRate || 0;
            const winBarWidth = card.total > 0 ? (card.wins / card.total) * 100 : 0;

            return (
              <div key={h} className="glass-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ background: main }} />
                    <span className="text-sm font-bold text-spike-text uppercase tracking-wider">{label}</span>
                  </div>
                  <span className="text-xs text-spike-text-dim mono">
                    Index: {card.indexValue.toFixed(1)}
                  </span>
                </div>

                {/* Big win rate number */}
                <div className="text-center mb-3">
                  <p className={cn(
                    'text-3xl font-bold mono',
                    winPct >= 55 ? 'text-spike-green' : winPct >= 50 ? 'text-spike-amber' : 'text-spike-red'
                  )}>
                    {winPct.toFixed(1)}%
                  </p>
                  <p className="text-xs text-spike-text-dim">Win Rate</p>
                </div>

                {/* W-L record */}
                <div className="flex items-center justify-center gap-3 mb-3">
                  <span className="text-sm font-medium text-spike-green mono">{card.wins}W</span>
                  <span className="text-spike-text-muted">—</span>
                  <span className="text-sm font-medium text-spike-red mono">{card.losses}L</span>
                </div>

                {/* Win/Loss bar */}
                <div className="w-full h-3 rounded-full bg-spike-red/30 overflow-hidden mb-2">
                  <div
                    className="h-full rounded-full bg-spike-green/80 transition-all"
                    style={{ width: `${winBarWidth}%` }}
                  />
                </div>

                {/* Avg return */}
                <p className="text-center text-xs text-spike-text-dim">
                  Avg Return:{' '}
                  <span className={cn('mono font-medium', (card.avgReturn || 0) >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                    {(card.avgReturn || 0) >= 0 ? '+' : ''}{(card.avgReturn || 0).toFixed(2)}%
                  </span>
                  {' '}per pick
                </p>
              </div>
            );
          })}
        </div>

        {/* ============================================================ */}
        {/* SECTION 3: Recent Picks Table — All Horizons, Alphabetical */}
        {/* ============================================================ */}
        <div className="glass-card p-6">
          <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-1">
            Pick Results
          </h3>
          <p className="text-xs text-spike-text-muted mb-4">
            All picks sorted alphabetically — predicted vs actual across all three horizons
          </p>
          {recentPicks.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-spike-border text-spike-text-dim text-[10px] uppercase tracking-wider">
                    <th className="py-2 px-2 text-left">Ticker</th>
                    <th className="py-2 px-2 text-left">Date</th>
                    <th className="py-2 px-2 text-center">#</th>
                    <th className="py-2 px-1 text-right" title="3-Day Predicted">
                      <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: HORIZON_COLORS[3].main }} />3D Pred
                    </th>
                    <th className="py-2 px-1 text-right" title="3-Day Actual">3D Act</th>
                    <th className="py-2 px-1 text-right" title="5-Day Predicted">
                      <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: HORIZON_COLORS[5].main }} />5D Pred
                    </th>
                    <th className="py-2 px-1 text-right" title="5-Day Actual">5D Act</th>
                    <th className="py-2 px-1 text-right" title="8-Day Predicted">
                      <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: HORIZON_COLORS[8].main }} />8D Pred
                    </th>
                    <th className="py-2 px-1 text-right" title="8-Day Actual">8D Act</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPicks.map((pick, idx) => {
                    // Overall row color: green if any actual is positive, red if all are negative
                    const anyPositive = [pick.actual3, pick.actual5, pick.actual8].some((v) => v !== null && v >= 0);
                    const anyActual = [pick.actual3, pick.actual5, pick.actual8].some((v) => v !== null);

                    return (
                      <tr
                        key={`${pick.ticker}-${pick.date}-${idx}`}
                        className={cn(
                          'border-b border-spike-border/30 transition-colors hover:bg-spike-bg-hover',
                          anyActual && anyPositive ? 'bg-spike-green/[0.02]' : anyActual ? 'bg-spike-red/[0.02]' : ''
                        )}
                      >
                        <td className="py-2 px-2">
                          <a
                            href={`https://finance.yahoo.com/quote/${pick.ticker}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-spike-cyan hover:underline font-medium text-xs"
                            title={pick.name}
                          >
                            {pick.ticker.replace('.TO', '')}
                          </a>
                        </td>
                        <td className="py-2 px-2 text-spike-text-dim text-xs mono">
                          {new Date(pick.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="py-2 px-2 text-center text-spike-text-dim text-xs">
                          #{pick.rank}
                        </td>
                        {/* 3-Day */}
                        <ActualCell predicted={pick.predicted3} actual={null} isPred />
                        <ActualCell predicted={pick.predicted3} actual={pick.actual3} />
                        {/* 5-Day */}
                        <ActualCell predicted={pick.predicted5} actual={null} isPred />
                        <ActualCell predicted={pick.predicted5} actual={pick.actual5} />
                        {/* 8-Day */}
                        <ActualCell predicted={pick.predicted8} actual={null} isPred />
                        <ActualCell predicted={pick.predicted8} actual={pick.actual8} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-12 text-center text-spike-text-muted text-sm">
              {loading ? 'Loading...' : 'No picks data yet.'}
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

// ---- Helper Component: Predicted/Actual table cell ----

function ActualCell({ predicted, actual, isPred }: { predicted: number; actual: number | null; isPred?: boolean }) {
  if (isPred) {
    return (
      <td className="py-2 px-1 text-right mono text-xs text-spike-text-dim">
        {predicted >= 0 ? '+' : ''}{predicted.toFixed(1)}%
      </td>
    );
  }

  if (actual === null) {
    return (
      <td className="py-2 px-1 text-right mono text-xs text-spike-text-muted">
        —
      </td>
    );
  }

  const hit = (predicted >= 0 && actual >= 0) || (predicted < 0 && actual < 0);

  return (
    <td className={cn(
      'py-2 px-1 text-right mono text-xs font-medium',
      actual >= 0 ? 'text-spike-green' : 'text-spike-red'
    )}>
      {actual >= 0 ? '+' : ''}{actual.toFixed(1)}%
      <span className="ml-0.5 text-[9px]">{hit ? '✓' : '✗'}</span>
    </td>
  );
}
