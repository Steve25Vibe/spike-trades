'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import MarketHeader from '@/components/layout/MarketHeader';
import SpikeCard from '@/components/spikes/SpikeCard';

interface SpikeData {
  id: string;
  rank: number;
  ticker: string;
  name: string;
  sector: string;
  exchange: string;
  price: number;
  spikeScore: number;
  confidence: number;
  predicted3Day: number;
  predicted5Day: number;
  predicted8Day: number;
  narrative: string;
  rsi: number;
  macd: number;
  adx: number;
  atr: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  momentumScore: number;
  volumeScore: number;
  technicalScore: number;
  macroScore: number;
  sentimentScore: number;
  historicalConfidence?: number;
  calibrationSamples?: number;
  overconfidenceFlag?: boolean;
  setupRateCILow?: number;
  setupRateCIHigh?: number;
  setupRateRegime?: string;
  setupMedianMoveOnHits?: number;
  setupMedianMoveOnMisses?: number;
  tickerRate?: number;
  tickerRateSamples?: number;
  tickerRateCILow?: number;
  tickerRateCIHigh?: number;
  tickerMedianMoveOnHits?: number;
  tickerMedianMoveOnMisses?: number;
  calibrationReconciliation?: string;
  scanType?: string;
}

interface ReportData {
  report: {
    date: string;
    marketRegime: string;
    tsxLevel: number;
    tsxChange: number;
    oilPrice: number;
    goldPrice: number;
    btcPrice: number;
    cadUsd: number;
    csvUrl: string;
    prevOilPrice: number | null;
    prevGoldPrice: number | null;
    prevBtcPrice: number | null;
    prevCadUsd: number | null;
    stocksAnalyzed: number | null;
  };
  spikes: SpikeData[];
}

export default function TomorrowSpikesPage() {
  return (
    <Suspense fallback={null}>
      <TomorrowSpikesContent />
    </Suspense>
  );
}

function TomorrowSpikesContent() {
  const searchParams = useSearchParams();
  const dateParam = searchParams.get('date');
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchSpikes();
  }, [dateParam]);

  const fetchSpikes = async () => {
    try {
      const url = dateParam
        ? `/api/spikes?date=${dateParam}&scanType=EVENING`
        : '/api/spikes?scanType=EVENING';
      const res = await fetch(url);
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
        setError('');
      } else {
        setData(null);
        setError(json.message || 'No evening scan available yet');
      }
    } catch (e) {
      setError(String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const buildSpikeCardData = (spike: SpikeData) => ({
    ...spike,
    exchange: spike.exchange as 'TSX' | 'TSXV',
    scanType: 'EVENING' as const,
    technicals: {
      rsi: spike.rsi,
      macd: spike.macd,
      macdSignal: 0,
      macdHistogram: 0,
      adx: spike.adx,
      bollingerUpper: 0,
      bollingerMiddle: 0,
      bollingerLower: 0,
      ema3: 0,
      ema8: 0,
      ema21: 0,
      sma50: 0,
      sma200: 0,
      atr: spike.atr,
      obv: spike.volume,
    },
    scoreBreakdown: {
      momentum: spike.momentumScore || 0,
      volumeSurge: spike.volumeScore || 0,
      technical: spike.technicalScore || 0,
      macroSensitivity: spike.macroScore || 0,
      sentiment: spike.sentimentScore || 0,
      shortInterest: 0,
      volatilityAdj: 0,
      sectorRotation: 0,
      patternMatch: 0,
      liquidityDepth: 0,
      insiderSignal: 0,
      gapPotential: 0,
    },
  });

  return (
    <ResponsiveLayout>
      {/* Pre-market preview banner */}
      <div className="mb-6 p-4 rounded-lg border-2 border-amber-500/30 bg-amber-500/5">
        <div className="flex items-start gap-3">
          <div className="text-2xl">&#127769;</div>
          <div className="flex-1">
            <h2 className="text-lg font-bold text-amber-300 mb-1">
              Tomorrow&apos;s Spikes &mdash; Pre-Market Preview
            </h2>
            <p className="text-sm text-spike-text-dim leading-relaxed">
              These picks were generated from the most recent post-close council
              scan, using complete end-of-day data. They are intended for overnight
              research and pre-market planning.{' '}
              <strong className="text-spike-text">
                Lock In is disabled until the market opens at 9:30 AM ET.
              </strong>{' '}
              The morning council scan runs at 11:15 AM ADT and produces a separate
              live-intraday slate visible on the{' '}
              <a href="/dashboard" className="text-spike-cyan hover:underline">
                Today&apos;s Spikes
              </a>{' '}
              page.
            </p>
          </div>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center h-[60vh]">
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-spike-cyan/20 border-t-spike-cyan rounded-full animate-spin mx-auto mb-4" />
            <p className="text-spike-text-dim">Loading tomorrow&apos;s preview...</p>
          </div>
        </div>
      )}

      {/* Empty state — no evening scan yet today */}
      {!loading && !data && (
        <div className="text-center py-16 px-6 rounded-lg border border-spike-border bg-spike-bg-light/30">
          <div className="text-5xl mb-4">&#127769;</div>
          <h3 className="text-xl font-bold text-spike-text mb-2">
            No Tomorrow&apos;s Spikes preview yet
          </h3>
          <p className="text-sm text-spike-text-dim max-w-md mx-auto">
            The next pre-market scan runs at 7:00 PM ET tonight. Tomorrow&apos;s
            preview will appear here after the scan completes (~7:30 PM ET).
            {error && (
              <span className="block mt-3 text-xs text-spike-text-muted">
                {error}
              </span>
            )}
          </p>
        </div>
      )}

      {/* Picks list */}
      {!loading && data && (
        <>
          <MarketHeader
            date={new Date(new Date(data.report.date).toISOString().split('T')[0] + 'T12:00:00').toLocaleDateString('en-CA', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            })}
            regime={data.report.marketRegime || 'neutral'}
            tsxLevel={data.report.tsxLevel || 0}
            tsxChange={data.report.tsxChange || 0}
            oilPrice={data.report.oilPrice || 0}
            goldPrice={data.report.goldPrice || 0}
            btcPrice={data.report.btcPrice || 0}
            cadUsd={data.report.cadUsd || 0}
            prevOilPrice={data.report.prevOilPrice}
            prevGoldPrice={data.report.prevGoldPrice}
            prevBtcPrice={data.report.prevBtcPrice}
            prevCadUsd={data.report.prevCadUsd}
          />
          <div className="mb-4 text-sm text-spike-text-dim">
            Preview for{' '}
            <strong className="text-spike-text">{data.report.date}</strong> &middot;{' '}
            {data.spikes.length} picks &middot; Regime:{' '}
            <span className="capitalize">{data.report.marketRegime}</span>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {data.spikes.map((spike) => (
              <SpikeCard
                key={spike.id}
                spike={buildSpikeCardData(spike)}
              />
            ))}
          </div>

          {/* Legal footer */}
          <div className="legal-footer">
            <p>
              For educational and informational purposes only. Not financial advice.
              Past performance is no guarantee of future results.
              Trading stocks involves risk. You may lose your entire investment.
            </p>
            <p className="mt-2">
              &copy; {new Date().getFullYear()} Spike Trades &mdash; spiketrades.ca. All rights reserved. &middot; Ver 6.1
            </p>
          </div>
        </>
      )}
    </ResponsiveLayout>
  );
}
