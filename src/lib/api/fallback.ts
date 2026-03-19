// ============================================
// Fallback Data Sources: Polygon, Finnhub, yfinance
// Automatic failover when FMP is unavailable
// ============================================

import { StockQuote, HistoricalBar } from '@/types';
import { sleep } from '@/lib/utils';

// ---- Polygon.io ----
const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY = process.env.POLYGON_API_KEY;

export async function polygonQuote(symbol: string): Promise<StockQuote | null> {
  if (!POLYGON_KEY) return null;
  try {
    const res = await fetch(
      `${POLYGON_BASE}/v2/last/trade/${symbol}?apiKey=${POLYGON_KEY}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results) return null;

    const snapRes = await fetch(
      `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${POLYGON_KEY}`,
      { cache: 'no-store' }
    );
    const snap = await snapRes.json();
    const ticker = snap?.ticker;

    return {
      ticker: symbol,
      name: symbol,
      price: data.results.p || 0,
      change: ticker?.todaysChange || 0,
      changePercent: ticker?.todaysChangePerc || 0,
      volume: ticker?.day?.v || 0,
      avgVolume: 0,
      marketCap: 0,
      high: ticker?.day?.h || 0,
      low: ticker?.day?.l || 0,
      open: ticker?.day?.o || 0,
      previousClose: ticker?.prevDay?.c || 0,
      exchange: 'TSX',
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function polygonHistorical(
  symbol: string,
  days = 90
): Promise<HistoricalBar[]> {
  if (!POLYGON_KEY) return [];
  try {
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const res = await fetch(
      `${POLYGON_BASE}/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?apiKey=${POLYGON_KEY}&sort=asc`,
      { cache: 'no-store' }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((bar: any) => ({
      date: new Date(bar.t).toISOString().split('T')[0],
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    }));
  } catch {
    return [];
  }
}

// ---- Finnhub ----
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

export interface FinnhubSentiment {
  buzz: number;
  sentiment: number; // -1 to 1
  articlesInLastWeek: number;
  positiveCount: number;
  negativeCount: number;
}

export async function finnhubSentiment(symbol: string): Promise<FinnhubSentiment | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const res = await fetch(
      `${FINNHUB_BASE}/news-sentiment?symbol=${symbol}&token=${FINNHUB_KEY}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      buzz: data.buzz?.buzz || 0,
      sentiment: data.sentiment?.score || 0,
      articlesInLastWeek: data.buzz?.articlesInLastWeek || 0,
      positiveCount: data.sentiment?.bullishPercent || 0,
      negativeCount: data.sentiment?.bearishPercent || 0,
    };
  } catch {
    return null;
  }
}

export async function finnhubShortInterest(symbol: string): Promise<number | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const res = await fetch(
      `${FINNHUB_BASE}/stock/short-interest?symbol=${symbol}&token=${FINNHUB_KEY}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.data && data.data.length > 0) {
      return data.data[0].shortInterest || null;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Data Source Orchestrator ----
export type DataSource = 'fmp' | 'polygon' | 'finnhub' | 'yfinance';

interface FetchResult<T> {
  data: T | null;
  source: DataSource;
  latencyMs: number;
  error?: string;
}

export async function fetchWithFailover<T>(
  fmpFn: () => Promise<T>,
  fallbacks: { source: DataSource; fn: () => Promise<T | null> }[]
): Promise<FetchResult<T>> {
  // Try primary (FMP) first
  const start = Date.now();
  try {
    const data = await fmpFn();
    return {
      data,
      source: 'fmp',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    console.warn('FMP primary failed, trying fallbacks:', err);
  }

  // Try fallbacks in order
  for (const fallback of fallbacks) {
    const fbStart = Date.now();
    try {
      const data = await fallback.fn();
      if (data !== null) {
        return {
          data: data as T,
          source: fallback.source,
          latencyMs: Date.now() - fbStart,
        };
      }
    } catch (err) {
      console.warn(`Fallback ${fallback.source} failed:`, err);
    }
  }

  return {
    data: null,
    source: 'fmp',
    latencyMs: Date.now() - start,
    error: 'All data sources failed',
  };
}
