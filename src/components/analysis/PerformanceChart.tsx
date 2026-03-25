'use client';

import { useState, useEffect } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';

interface ChartBar {
  date: string;
  close: number;
}

interface ChartData {
  bars: ChartBar[];
  entryPrice: number;
  entryDate: string;
  target3Day: number | null;
  target5Day: number | null;
  target8Day: number | null;
  stopLoss: number | null;
  currentPrice: number;
  pnlPercent: number;
}

interface Props {
  spikeId: string;
  ticker: string;
}

export default function PerformanceChart({ spikeId, ticker }: Props) {
  const [data, setData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/spikes/${spikeId}/chart`)
      .then((r) => r.json())
      .then((res) => {
        if (res.success) setData(res.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [spikeId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-spike-cyan" />
      </div>
    );
  }

  if (!data || data.bars.length < 2) {
    return (
      <p className="text-sm text-spike-text-muted text-center py-8">
        Chart available after 2+ trading days of data.
      </p>
    );
  }

  // Calculate gradient split offset: proportion of Y range where entry price sits
  const closes = data.bars.map((b) => b.close);
  const yMin = Math.min(...closes, data.entryPrice, data.stopLoss ?? Infinity);
  const yMax = Math.max(...closes, data.entryPrice, data.target8Day ?? -Infinity, data.target5Day ?? -Infinity, data.target3Day ?? -Infinity);
  const yPad = (yMax - yMin) * 0.05 || 0.5;
  const domainMin = yMin - yPad;
  const domainMax = yMax + yPad;
  const gradientOffset = (domainMax - data.entryPrice) / (domainMax - domainMin);

  const pnlColor = data.pnlPercent >= 0 ? 'text-spike-green' : 'text-spike-red';
  const pnlArrow = data.pnlPercent >= 0 ? '\u25B2' : '\u25BC';

  // Format date as "Mar 15"
  const fmtDate = (d: string) => {
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const legendItems = [
    { color: '#94A3B8', label: 'Entry' },
    ...(data.target3Day ? [{ color: '#22C55E', label: '3D Target' }] : []),
    ...(data.target5Day ? [{ color: '#00F0FF', label: '5D Target' }] : []),
    ...(data.target8Day ? [{ color: '#A78BFA', label: '8D Target' }] : []),
    ...(data.stopLoss ? [{ color: '#EF4444', label: 'Stop Loss' }] : []),
  ];

  return (
    <div>
      {/* Header with P&L */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider">
          Price Performance Since Entry
        </h3>
        <span className={`text-lg font-bold mono ${pnlColor}`}>
          {data.pnlPercent >= 0 ? '+' : ''}{data.pnlPercent.toFixed(2)}% {pnlArrow}
        </span>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data.bars} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
          <defs>
            <linearGradient id="splitColor" x1="0" y1="0" x2="0" y2="1">
              <stop offset={0} stopColor="#22C55E" stopOpacity={0.15} />
              <stop offset={gradientOffset} stopColor="#22C55E" stopOpacity={0.15} />
              <stop offset={gradientOffset} stopColor="#EF4444" stopOpacity={0.15} />
              <stop offset={1} stopColor="#EF4444" stopOpacity={0.15} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1E3A5F" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tickFormatter={fmtDate}
            tick={{ fill: '#94A3B8', fontSize: 11 }}
            axisLine={{ stroke: '#1E3A5F' }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[domainMin, domainMax]}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            tick={{ fill: '#94A3B8', fontSize: 11 }}
            axisLine={{ stroke: '#1E3A5F' }}
            tickLine={false}
            width={65}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'rgba(10, 25, 47, 0.95)',
              border: '1px solid rgba(0, 240, 255, 0.2)',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            labelFormatter={fmtDate}
            formatter={(value: number) => [`$${value.toFixed(2)}`, ticker]}
          />
          <Area
            type="monotone"
            dataKey="close"
            fill="url(#splitColor)"
            stroke="none"
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke="#00F0FF"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: '#00F0FF' }}
          />
          {/* Reference lines */}
          <ReferenceLine
            y={data.entryPrice}
            stroke="#94A3B8"
            strokeDasharray="6 4"
            label={{ value: `Entry $${data.entryPrice.toFixed(2)}`, fill: '#94A3B8', fontSize: 10, position: 'right' }}
          />
          {data.target3Day && (
            <ReferenceLine y={data.target3Day} stroke="#22C55E" strokeDasharray="4 4" />
          )}
          {data.target5Day && (
            <ReferenceLine y={data.target5Day} stroke="#00F0FF" strokeDasharray="4 4" />
          )}
          {data.target8Day && (
            <ReferenceLine y={data.target8Day} stroke="#A78BFA" strokeDasharray="4 4" />
          )}
          {data.stopLoss && (
            <ReferenceLine y={data.stopLoss} stroke="#EF4444" strokeDasharray="4 4" />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 mt-2 justify-center">
        {legendItems.map((item) => (
          <div key={item.label} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: item.color }} />
            <span className="text-[10px] text-spike-text-muted uppercase tracking-wider">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
