'use client';

import { useState, useEffect, useCallback } from 'react';

interface SpikeItResult {
  ticker: string;
  timestamp: string;
  cached: boolean;
  cache_age_seconds?: number;
  signal: {
    continuation_probability: number;
    light: 'green' | 'yellow' | 'red';
    summary: string;
  };
  expected_move: {
    direction: 'up' | 'down' | 'flat';
    dollar_amount: number;
    target_price: number;
  };
  levels: {
    support: { price: number; label: string };
    stop_loss: { price: number; label: string };
    rsi: { value: number; label: string };
  };
  risk_warning: string;
  relative_volume: number | null;
  chart: {
    bars: { time: string; close: number }[];
    vwap: { time: string; value: number }[];
  };
  data_limitations: string[];
}

interface Props {
  ticker: string;
  companyName: string;
  entryPrice: number;
  onClose: () => void;
}

const SIGNAL_COLORS = {
  green: { bg: 'rgba(76,175,80,0.08)', border: 'rgba(76,175,80,0.2)', text: '#4caf50', emoji: '🟢' },
  yellow: { bg: 'rgba(255,193,7,0.08)', border: 'rgba(255,193,7,0.2)', text: '#ffc107', emoji: '🟡' },
  red: { bg: 'rgba(255,82,82,0.08)', border: 'rgba(255,82,82,0.2)', text: '#ff5252', emoji: '🔴' },
};

function IntradayChart({ bars, vwap }: { bars: { time: string; close: number }[]; vwap: { time: string; value: number }[] }) {
  if (bars.length < 2) return null;

  const prices = bars.map(b => b.close);
  const vwapPrices = vwap.map(v => v.value);
  const allValues = [...prices, ...vwapPrices];
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const range = maxVal - minVal || 1;
  const padding = range * 0.1;
  const yMin = minVal - padding;
  const yMax = maxVal + padding;

  const w = 400;
  const h = 80;
  const toX = (i: number) => (i / (bars.length - 1)) * w;
  const toY = (v: number) => h - ((v - yMin) / (yMax - yMin)) * h;

  const priceLine = bars.map((b, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(b.close).toFixed(1)}`).join(' ');
  const priceArea = `${priceLine} L${w},${h} L0,${h} Z`;
  const isUp = bars[bars.length - 1].close >= bars[0].close;
  const lineColor = isUp ? '#4caf50' : '#ff5252';
  const gradId = `spike-it-grad-${isUp ? 'up' : 'down'}`;

  const vwapLine = vwap.length >= 2
    ? vwap.map((v, i) => {
        const xi = (i / (vwap.length - 1)) * w;
        return `${i === 0 ? 'M' : 'L'}${xi.toFixed(1)},${toY(v.value).toFixed(1)}`;
      }).join(' ')
    : '';

  const labelCount = 5;
  const labels = [];
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round((i / (labelCount - 1)) * (bars.length - 1));
    labels.push({ x: toX(idx), text: bars[idx].time });
  }

  return (
    <div className="rounded-lg border border-spike-border/30 p-3 mb-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="text-[9px] uppercase tracking-wider text-spike-text-dim mb-2">Intraday Price Action</div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 60 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.3} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        {vwapLine && (
          <path d={vwapLine} fill="none" stroke="#ff6b35" strokeWidth="1" strokeDasharray="4,4" opacity={0.6} />
        )}
        <path d={priceArea} fill={`url(#${gradId})`} />
        <path d={priceLine} fill="none" stroke={lineColor} strokeWidth="2" />
      </svg>
      <div className="flex justify-between text-[9px] text-spike-text-dim mt-1">
        {labels.map((l, i) => (
          <span key={i}>{i === labels.length - 1 ? 'Now' : l.text}</span>
        ))}
      </div>
      {vwapLine && (
        <div className="flex items-center gap-2 mt-1">
          <div className="w-4 border-t border-dashed" style={{ borderColor: '#ff6b35' }} />
          <span className="text-[9px]" style={{ color: '#ff6b35' }}>VWAP</span>
        </div>
      )}
    </div>
  );
}

function SkeletonPulse({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-spike-border/20 ${className}`} />;
}

export default function SpikeItModal({ ticker, companyName, entryPrice, onClose }: Props) {
  const [result, setResult] = useState<SpikeItResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/portfolio/spike-it', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, entryPrice }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data: SpikeItResult = await res.json();
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ticker, entryPrice]);

  useEffect(() => {
    fetchAnalysis();
  }, [fetchAnalysis]);

  const colors = result ? SIGNAL_COLORS[result.signal.light] : SIGNAL_COLORS.yellow;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={onClose}>
      <div className="glass-card p-6 w-full max-w-[480px] mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-spike-text-dim">Live Health Check</div>
            <div className="text-xl font-bold text-spike-cyan">
              {ticker} <span className="text-sm font-normal text-spike-text-dim">{companyName}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-spike-text-dim hover:text-spike-text text-xl leading-none">&times;</button>
        </div>

        {/* Error state */}
        {error && !loading && (
          <div className="text-center py-8">
            <div className="text-spike-red text-sm mb-3">{error}</div>
            <button
              onClick={fetchAnalysis}
              className="px-4 py-2 rounded-lg text-xs font-medium text-spike-cyan bg-spike-cyan/5 border border-spike-cyan/15 hover:bg-spike-cyan/10 transition-all"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <>
            <div className="rounded-xl p-5 mb-4" style={{ background: 'rgba(255,193,7,0.05)', border: '1px solid rgba(255,193,7,0.1)' }}>
              <SkeletonPulse className="h-9 w-9 mx-auto mb-2 rounded-full" />
              <SkeletonPulse className="h-7 w-48 mx-auto mb-2" />
              <SkeletonPulse className="h-4 w-56 mx-auto" />
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg border border-spike-border/30 p-3"><SkeletonPulse className="h-5 w-20 mb-1" /><SkeletonPulse className="h-6 w-16" /></div>
              <div className="rounded-lg border border-spike-border/30 p-3"><SkeletonPulse className="h-5 w-20 mb-1" /><SkeletonPulse className="h-6 w-16" /></div>
            </div>
            <div className="rounded-lg border border-spike-border/30 p-3 mb-4"><SkeletonPulse className="h-[60px] w-full" /></div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="text-center"><SkeletonPulse className="h-4 w-12 mx-auto mb-1" /><SkeletonPulse className="h-5 w-14 mx-auto" /></div>
              <div className="text-center"><SkeletonPulse className="h-4 w-12 mx-auto mb-1" /><SkeletonPulse className="h-5 w-14 mx-auto" /></div>
              <div className="text-center"><SkeletonPulse className="h-4 w-12 mx-auto mb-1" /><SkeletonPulse className="h-5 w-14 mx-auto" /></div>
            </div>
            <SkeletonPulse className="h-16 w-full rounded-lg" />
          </>
        )}

        {/* Result */}
        {result && !loading && (
          <>
            {/* Traffic light signal */}
            <div
              className="rounded-xl p-5 mb-4 text-center"
              style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
            >
              <div className="text-4xl mb-1">{colors.emoji}</div>
              <div className="text-2xl font-bold" style={{ color: colors.text }}>
                {result.signal.continuation_probability}% Continuation
              </div>
              <div className="text-sm text-spike-text-dim mt-1">{result.signal.summary}</div>
            </div>

            {/* Expected Move + Relative Volume */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg border border-spike-border/30 p-3 text-center" style={{ background: 'rgba(255,255,255,0.03)' }}>
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">Expected Move</div>
                <div className="text-lg font-bold" style={{ color: result.expected_move.direction === 'up' ? '#4caf50' : result.expected_move.direction === 'down' ? '#ff5252' : '#ffc107' }}>
                  {result.expected_move.direction === 'up' ? '+' : result.expected_move.direction === 'down' ? '-' : ''}${result.expected_move.dollar_amount.toFixed(2)}
                </div>
                <div className="text-[10px] text-spike-text-dim">to ${result.expected_move.target_price.toFixed(2)} by close</div>
              </div>
              <div className="rounded-lg border border-spike-border/30 p-3 text-center" style={{ background: 'rgba(255,255,255,0.03)' }}>
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">Relative Volume</div>
                <div className="text-lg font-bold text-spike-cyan">
                  {result.relative_volume != null ? `${result.relative_volume}x` : 'N/A'}
                </div>
                <div className="text-[10px] text-spike-text-dim">
                  {result.relative_volume != null ? 'above 10-day avg' : 'data unavailable'}
                </div>
              </div>
            </div>

            {/* Intraday Chart */}
            <IntradayChart bars={result.chart.bars} vwap={result.chart.vwap} />

            {/* Key Levels */}
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="text-center">
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">Support</div>
                <div className="text-sm font-semibold text-spike-cyan">${result.levels.support.price.toFixed(2)}</div>
                <div className="text-[9px] text-spike-text-dim">{result.levels.support.label}</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">Stop Loss</div>
                <div className="text-sm font-semibold text-spike-red">${result.levels.stop_loss.price.toFixed(2)}</div>
                <div className="text-[9px] text-spike-text-dim">{result.levels.stop_loss.label}</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] uppercase tracking-wider text-spike-text-dim">RSI (5m)</div>
                <div className="text-sm font-semibold" style={{ color: result.levels.rsi.value > 70 ? '#ff5252' : result.levels.rsi.value > 60 ? '#ffc107' : '#4caf50' }}>
                  {result.levels.rsi.value || 'N/A'}
                </div>
                <div className="text-[9px] text-spike-text-dim">{result.levels.rsi.label}</div>
              </div>
            </div>

            {/* Risk Warning */}
            <div className="rounded-lg p-3 mb-4" style={{ background: 'rgba(255,193,7,0.08)', border: '1px solid rgba(255,193,7,0.15)' }}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-spike-gold mb-1">&#9888; Risk to Watch</div>
              <div className="text-xs text-spike-text/70 leading-relaxed">{result.risk_warning}</div>
            </div>

            {/* Data limitations */}
            {result.data_limitations.length > 0 && (
              <div className="text-[9px] text-spike-text-dim mb-3">
                Note: {result.data_limitations.join('. ')}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between">
              <div className="text-[9px] text-spike-text-dim">
                Powered by SuperGrok Heavy &middot; {new Date(result.timestamp).toLocaleTimeString('en-CA', { timeZone: 'America/Halifax', hour: 'numeric', minute: '2-digit', hour12: true })} AST
                {result.cached && result.cache_age_seconds != null && (
                  <span> &middot; Cached {Math.floor(result.cache_age_seconds / 60)}m ago</span>
                )}
              </div>
              <button
                onClick={onClose}
                className="px-4 py-1.5 rounded-lg text-xs font-medium text-spike-text-dim bg-spike-bg border border-spike-border hover:border-spike-text-dim/30 transition-all"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
