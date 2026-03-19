// ============================================
// FMP (Financial Modeling Prep) API Client
// Primary data source for Canadian market data
// ============================================

import { StockQuote, HistoricalBar } from '@/types';
import { sleep } from '@/lib/utils';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';
const FMP_KEY = process.env.FMP_API_KEY!;

interface FMPQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changesPercentage: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  dayHigh: number;
  dayLow: number;
  open: number;
  previousClose: number;
  exchange: string;
  timestamp: number;
}

interface FMPHistorical {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
}

interface FMPProfile {
  symbol: string;
  companyName: string;
  sector: string;
  industry: string;
  exchange: string;
  marketCap: number;
}

async function fmpFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${FMP_BASE}${endpoint}`);
  url.searchParams.set('apikey', FMP_KEY);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    next: { revalidate: 0 }, // Never cache
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`FMP API error: ${response.status} ${response.statusText} for ${endpoint}`);
  }

  return response.json();
}

/** Get all TSX/TSXV listed symbols */
export async function getTSXSymbols(): Promise<string[]> {
  const [tsx, tsxv] = await Promise.all([
    fmpFetch<FMPProfile[]>('/stock-screener', {
      exchange: 'TSX',
      marketCapMoreThan: '50000000',   // Min $50M cap
      volumeMoreThan: '100000',         // Min 100K daily volume
      limit: '1000',
    }),
    fmpFetch<FMPProfile[]>('/stock-screener', {
      exchange: 'TSX',                 // TSXV stocks often come through TSX endpoint
      marketCapMoreThan: '20000000',
      volumeMoreThan: '50000',
      limit: '500',
    }),
  ]);

  const symbols = new Set<string>();
  [...tsx, ...tsxv].forEach((s) => symbols.add(s.symbol));
  return Array.from(symbols);
}

/** Get real-time quotes for a batch of symbols */
export async function getBatchQuotes(symbols: string[]): Promise<StockQuote[]> {
  const quotes: StockQuote[] = [];
  // FMP supports comma-separated batch quotes
  const batchSize = 50;

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const symbolStr = batch.join(',');

    try {
      const raw = await fmpFetch<FMPQuote[]>(`/quote/${symbolStr}`);
      for (const q of raw) {
        if (!q.price || q.price <= 0) continue;
        quotes.push({
          ticker: q.symbol,
          name: q.name || q.symbol,
          price: q.price,
          change: q.change,
          changePercent: q.changesPercentage,
          volume: q.volume,
          avgVolume: q.avgVolume,
          marketCap: q.marketCap,
          high: q.dayHigh,
          low: q.dayLow,
          open: q.open,
          previousClose: q.previousClose,
          exchange: q.exchange?.includes('Venture') ? 'TSXV' : 'TSX',
          timestamp: q.timestamp || Date.now(),
        });
      }
    } catch (err) {
      console.error(`FMP batch quote error for ${symbolStr}:`, err);
    }

    // Rate limiting: FMP Professional allows ~300 req/min
    if (i + batchSize < symbols.length) {
      await sleep(250);
    }
  }

  return quotes;
}

/** Get historical daily bars for a symbol */
export async function getHistoricalPrices(
  symbol: string,
  days = 90
): Promise<HistoricalBar[]> {
  try {
    const raw = await fmpFetch<{ historical: FMPHistorical[] }>(
      `/historical-price-full/${symbol}`,
      { serietype: 'line' }
    );

    if (!raw?.historical) return [];

    return raw.historical
      .slice(0, days)
      .map((h) => ({
        date: h.date,
        open: h.open,
        high: h.high,
        low: h.low,
        close: h.close,
        volume: h.volume,
        adjClose: h.adjClose,
      }))
      .reverse(); // Oldest first
  } catch (err) {
    console.error(`FMP historical error for ${symbol}:`, err);
    return [];
  }
}

/** Get company profiles for sector data */
export async function getCompanyProfiles(
  symbols: string[]
): Promise<Map<string, { sector: string; industry: string }>> {
  const profiles = new Map<string, { sector: string; industry: string }>();
  const batchSize = 50;

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    try {
      const raw = await fmpFetch<FMPProfile[]>(`/profile/${batch.join(',')}`);
      for (const p of raw) {
        profiles.set(p.symbol, {
          sector: p.sector || 'Unknown',
          industry: p.industry || 'Unknown',
        });
      }
    } catch (err) {
      console.error(`FMP profile batch error:`, err);
    }
    if (i + batchSize < symbols.length) await sleep(250);
  }

  return profiles;
}

/** Get TSX index data for relative strength */
export async function getTSXIndex(): Promise<{ level: number; change: number; changePct: number } | null> {
  try {
    const raw = await fmpFetch<FMPQuote[]>('/quote/%5EGSPTSE');
    if (raw.length > 0) {
      return {
        level: raw[0].price,
        change: raw[0].change,
        changePct: raw[0].changesPercentage,
      };
    }
  } catch (err) {
    console.error('FMP TSX index error:', err);
  }
  return null;
}

/** Get commodity prices (oil, gold) */
export async function getCommodityPrices(): Promise<{
  oil: number | null;
  gold: number | null;
  cadUsd: number | null;
}> {
  try {
    const [oilData, goldData, fxData] = await Promise.all([
      fmpFetch<FMPQuote[]>('/quote/CLUSD').catch(() => []),
      fmpFetch<FMPQuote[]>('/quote/GCUSD').catch(() => []),
      fmpFetch<{ ticker: string; bid: number }[]>('/fx').catch(() => []),
    ]);

    const cadUsd = Array.isArray(fxData)
      ? fxData.find((f) => f.ticker === 'USD/CAD')?.bid ?? null
      : null;

    return {
      oil: oilData[0]?.price ?? null,
      gold: goldData[0]?.price ?? null,
      cadUsd: cadUsd ? 1 / cadUsd : null, // Convert to CAD/USD
    };
  } catch {
    return { oil: null, gold: null, cadUsd: null };
  }
}

/** Get news for sentiment analysis */
export async function getStockNews(
  symbol: string,
  limit = 10
): Promise<{ title: string; text: string; publishedDate: string; sentiment: string }[]> {
  try {
    const raw = await fmpFetch<any[]>(`/stock_news`, {
      tickers: symbol,
      limit: limit.toString(),
    });
    return (raw || []).map((n) => ({
      title: n.title || '',
      text: n.text || '',
      publishedDate: n.publishedDate || '',
      sentiment: n.sentiment || 'neutral',
    }));
  } catch {
    return [];
  }
}
