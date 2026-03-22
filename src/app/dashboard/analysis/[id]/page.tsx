'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import LockInModal from '@/components/portfolio/LockInModal';
import PortfolioChoiceModal from '@/components/portfolio/PortfolioChoiceModal';
import { type SizingMode } from '@/components/portfolio/PortfolioSettings';
import { usePortfolios } from '@/components/portfolio/usePortfolios';
import { cn, formatCurrency, formatPercent, formatVolume, formatMarketCap } from '@/lib/utils';
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip
} from 'recharts';

// Plain-language labels for each scoring factor
// Max weight contribution per factor (weight × 100), shown as "Max X" in the UI
// Uses bull regime as reference; actual weights vary by market regime
// Council rubric factors with their max weighted contributions
// The council scores 5 categories (total 100): technical_momentum(30), sentiment_catalysts(25),
// options_volatility(20), risk_reward(15), conviction(10). Conviction is not stored in DB.
// Only show the 4 stored rubric factors. Others (volumeSurge, volatilityAdj, technical) are excluded.
const COUNCIL_FACTORS: Record<string, number> = {
  momentum: 30,         // technical_momentum (0-30)
  sentiment: 25,        // sentiment_catalysts (0-25)
  macroSensitivity: 20, // options_volatility (0-20)
  patternMatch: 15,     // risk_reward (0-15)
  conviction: 10,       // conviction (0-10)
};

const FACTOR_EXPLANATIONS: Record<string, { label: string; plain: string }> = {
  momentum: {
    label: 'Momentum',
    plain: 'How strongly the price has been rising over the last 3, 5, and 8 days compared to the overall TSX market.',
  },
  volumeSurge: {
    label: 'Volume Surge',
    plain: 'Whether significantly more shares are being traded than usual — a sign that big buyers may be moving in.',
  },
  technical: {
    label: 'Technical Signals',
    plain: 'A bundle of chart-based indicators (RSI, MACD, Bollinger Bands, etc.) that together suggest the stock is set up for a short-term move higher.',
  },
  macroSensitivity: {
    label: 'Canadian Macro',
    plain: 'How well this stock benefits from today\'s oil prices, gold prices, Canadian dollar strength, and overall TSX direction.',
  },
  sentiment: {
    label: 'News Sentiment',
    plain: 'Whether recent news articles and media coverage about this company have been positive, negative, or neutral.',
  },
  shortInterest: {
    label: 'Short Squeeze Potential',
    plain: 'The percentage of shares being "shorted" (bet against). Moderate short interest can fuel sharp upward moves when shorts are forced to buy back.',
  },
  volatilityAdj: {
    label: 'Volatility Sweet Spot',
    plain: 'Whether the stock moves enough to profit from (not too quiet) but isn\'t so wild that it\'s unpredictable (not too volatile).',
  },
  sectorRotation: {
    label: 'Sector Diversification',
    plain: 'Prevents too many picks from the same industry. Stocks in under-represented sectors score higher to keep the portfolio balanced.',
  },
  patternMatch: {
    label: 'Historical Pattern',
    plain: 'How similar setups (same technical indicators, volume, etc.) have performed in the past. Higher means past patterns like this often led to gains.',
  },
  liquidityDepth: {
    label: 'Liquidity & Spread',
    plain: 'How easy it is to buy and sell this stock quickly at fair prices. Higher dollar volume and tighter bid-ask spreads mean better execution for you.',
  },
  insiderSignal: {
    label: 'Insider Buying',
    plain: 'Whether company insiders (executives, directors) have been buying shares recently — a signal they believe the stock will go up.',
  },
  gapPotential: {
    label: 'Overnight Gap Potential',
    plain: 'The likelihood of a significant price jump when the market opens tomorrow, based on the stock\'s history of overnight gaps and current compression patterns.',
  },
  conviction: {
    label: 'Conviction',
    plain: 'The AI council\'s overall confidence in this pick — how strongly the combined analysis supports a short-term move in the predicted direction.',
  },
};

const TECHNICAL_EXPLANATIONS: Record<string, { label: string; plain: string; goodRange: string }> = {
  rsi: {
    label: 'RSI (Relative Strength Index)',
    plain: 'Measures if a stock is overbought (above 70) or oversold (below 30). The ideal zone for a spike candidate is 40-65 — rising but not yet overheated.',
    goodRange: '40–65',
  },
  macd: {
    label: 'MACD (Moving Average Convergence Divergence)',
    plain: 'Tracks the relationship between two moving averages. When the MACD line crosses above the signal line, it\'s a bullish signal that momentum is turning upward.',
    goodRange: 'Positive & above signal',
  },
  adx: {
    label: 'ADX (Average Directional Index)',
    plain: 'Measures how strong a trend is, regardless of direction. Above 25 means a strong trend is in play — good for momentum trades.',
    goodRange: 'Above 25',
  },
  atr: {
    label: 'ATR (Average True Range)',
    plain: 'Measures daily price volatility in dollar terms. Used to calculate position sizes and stop-losses so no single trade risks more than 2% of your portfolio.',
    goodRange: '1–3% of price',
  },
};

interface SpikeDetail {
  spike: any;
  marketContext: any;
  councilAudit: any;
  portfolio: { locked: boolean; entryPrice?: number; shares?: number; entryDate?: string };
  tickerHistory: any[];
  dataSources: Record<string, string>;
}

export default function AnalysisPage() {
  const params = useParams();
  const router = useRouter();
  const [data, setData] = useState<SpikeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [locking, setLocking] = useState(false);
  const [showLockInModal, setShowLockInModal] = useState(false);
  const [showPortfolioChoice, setShowPortfolioChoice] = useState(false);
  const [chosenPortfolioId, setChosenPortfolioId] = useState<string | null>(null);
  const { portfolios, activeId, refresh: refreshPortfolios } = usePortfolios();

  useEffect(() => {
    if (params.id) fetchDetail(params.id as string);
  }, [params.id]);

  const fetchDetail = async (id: string) => {
    try {
      const res = await fetch(`/api/spikes/${id}`);
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (json.success) setData(json.data);
    } catch {
      // handle
    } finally {
      setLoading(false);
    }
  };

  const handleLockIn = () => {
    if (!data) return;
    setShowPortfolioChoice(true);
  };

  const handlePortfolioChosen = (portfolioId: string) => {
    setChosenPortfolioId(portfolioId);
    setShowPortfolioChoice(false);
    setShowLockInModal(true);
    refreshPortfolios();
  };

  const handleConfirmLockIn = async (params: { spikeId: string; portfolioId: string; shares?: number; positionSize?: number; portfolioSize?: number; mode: SizingMode }) => {
    if (!data) return;
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (json.success) {
      setShowLockInModal(false);
      setData({
        ...data,
        portfolio: { locked: true, entryPrice: json.data.entryPrice, shares: json.data.shares, entryDate: json.data.entryDate },
      });
      refreshPortfolios();
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-spike-bg flex items-center justify-center">
        <div className="w-16 h-16 border-4 border-spike-cyan/20 border-t-spike-cyan rounded-full animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-spike-bg flex items-center justify-center">
        <div className="glass-card p-8 text-center">
          <p className="text-spike-text-dim">Analysis not found.</p>
          <Link href="/dashboard" className="text-spike-cyan text-sm mt-4 inline-block">← Back to Dashboard</Link>
        </div>
      </div>
    );
  }

  const { spike, marketContext, councilAudit, dataSources, tickerHistory } = data;

  // Build radar chart data
  const radarData = Object.entries(spike.scoreBreakdown)
    .filter(([_, v]) => v !== null && v !== undefined)
    .map(([key, value]) => ({
      factor: FACTOR_EXPLANATIONS[key]?.label || key,
      score: value as number,
      fullMark: 100,
    }));

  // Build ticker accuracy chart if available
  const historyChart = tickerHistory.map((h: any) => ({
    date: new Date(h.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }),
    predicted: h.predicted3Day,
    actual: h.actual3Day,
  }));

  return (
    <ResponsiveLayout>
      <div className="max-w-6xl">
        {/* Back link */}
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-sm text-spike-text-dim hover:text-spike-cyan transition-colors mb-6"
          title="Return to the main dashboard"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Today&apos;s Spikes
        </Link>

        {/* Header with ticker + score + lock in */}
        <div className="glass-card p-6 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-5">
              <div className={cn(
                'w-20 h-20 rounded-2xl flex items-center justify-center font-bold text-3xl mono',
                spike.spikeScore >= 80 ? 'bg-spike-green/15 text-spike-green border border-spike-green/30' :
                spike.spikeScore >= 60 ? 'bg-spike-amber/15 text-spike-amber border border-spike-amber/30' :
                'bg-spike-red/15 text-spike-red border border-spike-red/30'
              )}>
                {spike.spikeScore.toFixed(0)}
              </div>
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <a href={`https://finance.yahoo.com/quote/${spike.ticker}`} target="_blank" rel="noopener noreferrer" title={`View ${spike.ticker} on Yahoo Finance`} className="text-3xl font-bold text-spike-text hover:text-spike-cyan transition-colors">{spike.ticker}</a>
                  <span className="text-sm font-medium px-3 py-1 rounded-full bg-spike-border/50 text-spike-text-dim">#{spike.rank}</span>
                  <span className="text-sm px-3 py-1 rounded-full bg-spike-violet/10 text-spike-violet">{spike.sector}</span>
                </div>
                <p className="text-spike-text-dim">{spike.name} &middot; {spike.exchange}</p>
                <p className="text-2xl font-bold mono mt-1">{formatCurrency(spike.price)}</p>
              </div>
            </div>

            {/* Confidence badge */}
            <div className={cn(
              'px-4 py-2 rounded-xl text-center',
              spike.confidence >= 80 ? 'bg-spike-green/10 border border-spike-green/30' :
              spike.confidence >= 60 ? 'bg-spike-amber/10 border border-spike-amber/30' :
              'bg-spike-red/10 border border-spike-red/30'
            )}>
              <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-0.5">Confidence</p>
              <p className={cn(
                'text-2xl font-bold mono',
                spike.confidence >= 80 ? 'text-spike-green' :
                spike.confidence >= 60 ? 'text-spike-amber' :
                'text-spike-red'
              )}>{spike.confidence.toFixed(0)}%</p>
            </div>
          </div>

          {/* Predicted returns */}
          <div className="grid grid-cols-3 gap-4 mt-6">
            {[
              { label: '3-Day Target', value: spike.predicted3Day, actual: spike.actual3Day, color: 'spike-green' },
              { label: '5-Day Target', value: spike.predicted5Day, actual: spike.actual5Day, color: 'spike-cyan' },
              { label: '8-Day Target', value: spike.predicted8Day, actual: spike.actual8Day, color: 'spike-violet' },
            ].map((p) => (
              <div key={p.label} className="bg-spike-bg/50 rounded-xl p-4 text-center">
                <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">{p.label}</p>
                <p className={`text-2xl font-bold mono ${p.value ? `text-${p.color}` : 'text-spike-text-muted'}`}>{p.value ? formatPercent(p.value) : '--'}</p>
                {p.actual !== null && p.actual !== undefined && (
                  <p className={cn('text-xs mono mt-1', p.actual >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                    Actual: {formatPercent(p.actual)}
                  </p>
                )}
                {p.value ? (
                  <p className="text-[10px] text-spike-text-muted mt-1">{formatCurrency(spike.price * (1 + p.value / 100))} target</p>
                ) : (
                  <p className="text-[10px] text-spike-text-muted mt-1">Not available</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ===== WHY THIS STOCK? — Plain Language Reasoning ===== */}
        <div className="glass-card p-6 mb-6">
          <h2 className="text-lg font-bold text-spike-cyan flex items-center gap-2 mb-4">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Why This Stock? — In Plain English
          </h2>

          {/* AI Narrative */}
          {spike.narrative && (
            <div className="bg-spike-bg/50 rounded-xl p-5 border border-spike-border/30 mb-5">
              <p className="text-spike-text leading-relaxed text-[15px]">{spike.narrative}</p>
              <p className="text-[10px] text-spike-text-muted mt-3 italic">
                Generated by Spike Trades 4-Stage LLM Council (Sonnet, Gemini, Opus &amp; SuperGrok)
              </p>
            </div>
          )}

          {/* Weighted Analysis — council rubric scores (Max 100) */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-spike-text uppercase tracking-wider">Weighted Analysis <span className="text-spike-text-muted font-normal text-xs">(Max 100)</span></h3>
            <p className="text-xs text-spike-text-muted mb-2">Each factor is scored by the AI council and contributes to the overall Spike Score. Green = 80%+ of max, yellow = 60–79%, red = below 60%.</p>

            {Object.entries(COUNCIL_FACTORS)
              .map(([key, maxWeight]) => {
                const info = FACTOR_EXPLANATIONS[key];
                if (!info) return null;
                const score = (spike.scoreBreakdown[key] as number | null | undefined) ?? 0;

                const pctOfMax = maxWeight > 0 ? (score / maxWeight) * 100 : 0;

                let colorClass: string;
                let bgClass: string;
                if (pctOfMax >= 80) {
                  colorClass = 'text-spike-green';
                  bgClass = 'bg-spike-green/10 text-spike-green';
                } else if (pctOfMax >= 60) {
                  colorClass = 'text-spike-amber';
                  bgClass = 'bg-spike-amber/10 text-spike-amber';
                } else {
                  colorClass = 'text-spike-red';
                  bgClass = 'bg-spike-red/10 text-spike-red';
                }

                return { key, info, score, maxWeight, colorClass, bgClass };
              })
              .filter(Boolean)
              .sort((a, b) => b!.score - a!.score)
              .map((item) => {
                const { key, info, score, maxWeight, colorClass, bgClass } = item!;
                return (
                  <div key={key} className="flex gap-4 items-start">
                    <div className={cn(
                      'w-12 h-12 rounded-xl flex items-center justify-center font-bold text-sm mono flex-shrink-0',
                      bgClass
                    )}>
                      {score % 1 === 0 ? score.toFixed(0) : score.toFixed(1)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={cn('font-semibold text-sm', colorClass)}>
                        {info.label} <span className="text-spike-text-muted font-normal text-xs">(Max {maxWeight})</span>
                      </p>
                      <p className="text-spike-text-dim text-sm leading-relaxed mt-0.5">{info.plain}</p>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>

        {/* ===== SCORE BREAKDOWN RADAR + TECHNICALS ===== */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
          {/* Radar chart */}
          <div className="glass-card p-6">
            <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Score Breakdown</h3>
            <ResponsiveContainer width="100%" height={350}>
              <RadarChart cx="50%" cy="50%" outerRadius="75%" data={radarData}>
                <PolarGrid stroke="#1E3A5F" />
                <PolarAngleAxis dataKey="factor" tick={{ fill: '#94A3B8', fontSize: 10 }} />
                <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: '#64748B', fontSize: 10 }} />
                <Radar name="Score" dataKey="score" stroke="#00F0FF" fill="#00F0FF" fillOpacity={0.2} strokeWidth={2} />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          {/* Technical indicators detail */}
          <div className="glass-card p-6">
            <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Technical Indicators — Explained</h3>
            <div className="space-y-5">
              {Object.entries(spike.technicals)
                .filter(([key]) => TECHNICAL_EXPLANATIONS[key])
                .map(([key, value]) => {
                  const info = TECHNICAL_EXPLANATIONS[key];
                  const numVal = value as number | null;
                  return (
                    <div key={key} className="bg-spike-bg/40 rounded-xl p-4">
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-semibold text-spike-text text-sm">{info.label}</span>
                        <span className="mono font-bold text-spike-cyan">{numVal !== null && numVal !== undefined ? numVal.toFixed(2) : 'N/A'}</span>
                      </div>
                      <p className="text-spike-text-dim text-xs leading-relaxed">{info.plain}</p>
                      <p className="text-[10px] text-spike-text-muted mt-1">Ideal range: {info.goodRange}</p>
                    </div>
                  );
                })}

              {/* Additional non-explained technicals */}
              <div className="grid grid-cols-2 gap-3 mt-2">
                {spike.technicals.ema3 && (
                  <div className="bg-spike-bg/40 rounded-lg p-3">
                    <p className="text-[10px] text-spike-text-muted uppercase">3-Day EMA</p>
                    <p className="mono font-bold text-sm">{formatCurrency(spike.technicals.ema3)}</p>
                  </div>
                )}
                {spike.technicals.ema8 && (
                  <div className="bg-spike-bg/40 rounded-lg p-3">
                    <p className="text-[10px] text-spike-text-muted uppercase">8-Day EMA</p>
                    <p className="mono font-bold text-sm">{formatCurrency(spike.technicals.ema8)}</p>
                  </div>
                )}
                {spike.technicals.bollingerUpper && (
                  <div className="bg-spike-bg/40 rounded-lg p-3">
                    <p className="text-[10px] text-spike-text-muted uppercase">Bollinger Upper</p>
                    <p className="mono font-bold text-sm">{formatCurrency(spike.technicals.bollingerUpper)}</p>
                  </div>
                )}
                {spike.technicals.bollingerLower && (
                  <div className="bg-spike-bg/40 rounded-lg p-3">
                    <p className="text-[10px] text-spike-text-muted uppercase">Bollinger Lower</p>
                    <p className="mono font-bold text-sm">{formatCurrency(spike.technicals.bollingerLower)}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ===== MARKET CONTEXT ===== */}
        <div className="glass-card p-6 mb-6">
          <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Market Context at Time of Analysis</h3>
          <p className="text-spike-text-dim text-sm mb-4">
            This analysis was generated on {new Date(marketContext.date).toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} when the market was in a <span className={cn(
              'font-bold',
              marketContext.regime === 'bull' ? 'text-spike-green' :
              marketContext.regime === 'bear' ? 'text-spike-red' :
              'text-spike-amber'
            )}>{marketContext.regime?.toUpperCase()}</span> regime.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 lg:gap-4">
            {[
              { label: 'TSX Composite', value: marketContext.tsxLevel?.toFixed(0), sub: `${marketContext.tsxChange >= 0 ? '+' : ''}${marketContext.tsxChange?.toFixed(2)}%`, color: marketContext.tsxChange >= 0 ? 'text-spike-green' : 'text-spike-red' },
              { label: 'USO Oil', value: `$${marketContext.oilPrice?.toFixed(2)}`, sub: 'USD/barrel', color: 'text-spike-text' },
              { label: 'Gold', value: `$${marketContext.goldPrice?.toFixed(0)}`, sub: 'CAD', color: 'text-spike-text' },
              { label: 'BTC', value: `$${marketContext.btcPrice?.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`, sub: 'CAD', color: 'text-spike-text' },
              { label: 'CAD/USD', value: marketContext.cadUsd?.toFixed(4), sub: 'Exchange rate', color: 'text-spike-text' },
              { label: 'Volume', value: formatVolume(spike.volume), sub: `Avg: ${formatVolume(spike.avgVolume || 0)}`, color: spike.volume > (spike.avgVolume || 0) ? 'text-spike-green' : 'text-spike-text' },
            ].map((m) => (
              <div key={m.label} className="bg-spike-bg/40 rounded-xl p-4 text-center">
                <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">{m.label}</p>
                <p className={`text-lg font-bold mono ${m.color}`}>{m.value}</p>
                <p className={`text-xs ${m.color === 'text-spike-text' ? 'text-spike-text-muted' : m.color}`}>{m.sub}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ===== HISTORICAL ACCURACY FOR THIS TICKER ===== */}
        {historyChart.length > 0 && (
          <div className="glass-card p-6 mb-6">
            <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-2">
              Past Predictions for {spike.ticker}
            </h3>
            <p className="text-spike-text-dim text-sm mb-4">
              How accurate were our previous 3-day predictions for this specific stock?
            </p>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={historyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F" />
                <XAxis dataKey="date" stroke="#64748B" fontSize={11} />
                <YAxis stroke="#64748B" fontSize={11} tickFormatter={(v) => `${v}%`} />
                <Tooltip
                  contentStyle={{ background: '#111E33', border: '1px solid #1E3A5F', borderRadius: 8, fontSize: 12 }}
                  formatter={(value: number) => [`${value?.toFixed(2)}%`]}
                />
                <Bar dataKey="predicted" fill="#00F0FF" fillOpacity={0.6} name="Predicted" radius={[4, 4, 0, 0]} />
                <Bar dataKey="actual" fill="#00FF88" fillOpacity={0.8} name="Actual" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ===== DATA SOURCES ===== */}
        <div className="glass-card p-6 mb-6">
          <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4 flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            Data Sources & Methodology
          </h3>
          <p className="text-spike-text-dim text-sm mb-4">
            Every number on this page comes from verified, real-time data feeds. Nothing is estimated or made up.
            Here&apos;s exactly where each piece of data comes from:
          </p>
          <div className="space-y-3">
            {Object.entries(dataSources).map(([key, value]) => (
              <div key={key} className="flex gap-4 items-start">
                <div className="w-2 h-2 rounded-full bg-spike-cyan mt-2 flex-shrink-0" />
                <div>
                  <span className="font-semibold text-spike-text text-sm capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}: </span>
                  <span className="text-spike-text-dim text-sm">{value}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Council audit */}
          {councilAudit && (
            <div className="mt-5 pt-5 border-t border-spike-border/30">
              <h4 className="text-sm font-semibold text-spike-text mb-2">LLM Council Audit</h4>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="bg-spike-bg/40 rounded-lg p-3">
                  <p className="text-[10px] text-spike-text-muted uppercase">Avg Pick Quality</p>
                  <p className="font-bold mono text-spike-cyan">{councilAudit.consensusScore?.toFixed(1)}</p>
                </div>
                <div className="bg-spike-bg/40 rounded-lg p-3">
                  <p className="text-[10px] text-spike-text-muted uppercase">Processing Time</p>
                  <p className="font-bold mono text-spike-text">{((councilAudit.processingTime || 0) / 1000).toFixed(1)}s</p>
                </div>
              </div>
              <p className="text-[10px] text-spike-text-muted mt-3">
                Four independent AI models (Sonnet, Gemini, Opus &amp; SuperGrok) analyzed this stock across 4 stages.
                Picks that multiple models agreed on receive higher confidence scores.
              </p>
            </div>
          )}
        </div>

        {/* Legal footer */}
        <div className="legal-footer">
          <p>
            For educational and informational purposes only. Not financial advice.
            Past performance is no guarantee of future results.
            Trading stocks involves risk. You may lose your entire investment.
          </p>
          <p className="mt-2">
            &copy; {new Date().getFullYear()} Spike Trades &mdash; spiketrades.ca. All rights reserved. &middot; Ver 2.1
          </p>
        </div>

        {/* Portfolio Choice Modal */}
        {showPortfolioChoice && data && (
          <PortfolioChoiceModal
            portfolios={portfolios}
            spikeCount={1}
            onSelect={handlePortfolioChosen}
            onCreate={handlePortfolioChosen}
            onCancel={() => setShowPortfolioChoice(false)}
          />
        )}

        {/* Lock-In Confirmation Modal */}
        {showLockInModal && data && chosenPortfolioId && (
          <LockInModal
            spike={{
              id: spike.id,
              ticker: spike.ticker,
              name: spike.name,
              price: spike.price,
              predicted3Day: spike.predicted3Day,
              predicted5Day: spike.predicted5Day,
              predicted8Day: spike.predicted8Day,
              atr: spike.technicals?.atr,
            }}
            portfolios={portfolios}
            activePortfolioId={chosenPortfolioId}
            onConfirm={handleConfirmLockIn}
            onCancel={() => { setShowLockInModal(false); setChosenPortfolioId(null); }}
          />
        )}
      </div>
    </ResponsiveLayout>
  );
}
