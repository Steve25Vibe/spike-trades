// ============================================
// FMP (Financial Modeling Prep) API Client
// Primary data source for Canadian market data
// ============================================

import { StockQuote, HistoricalBar } from '@/types';
import { sleep } from '@/lib/utils';

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const FMP_KEY = process.env.FMP_API_KEY!;

interface FMPQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercentage: number;  // /stable/ uses changePercentage (not changesPercentage)
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
      exchange: 'tsx',
      marketCapMoreThan: '50000000',   // Min $50M cap
      volumeMoreThan: '100000',         // Min 100K daily volume
      limit: '1000',
    }),
    fmpFetch<FMPProfile[]>('/stock-screener', {
      exchange: 'tsx',                 // TSXV stocks often come through TSX endpoint
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
  // /stable/batch-quote accepts ?symbols=X,Y,Z
  const batchSize = 50;

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const symbolStr = batch.join(',');

    try {
      const raw = await fmpFetch<FMPQuote[]>('/batch-quote', { symbols: symbolStr });
      for (const q of raw) {
        if (!q.price || q.price <= 0) continue;
        quotes.push({
          ticker: q.symbol,
          name: q.name || q.symbol,
          price: q.price,
          change: q.change,
          changePercent: q.changePercentage,
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
    // /stable/ returns a flat list (not { historical: [...] })
    const raw = await fmpFetch<FMPHistorical[]>(
      '/historical-price-eod/full',
      { symbol, serietype: 'line' }
    );

    if (!Array.isArray(raw) || raw.length === 0) return [];

    return raw
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
      const raw = await fmpFetch<FMPProfile[]>('/profile', { symbol: batch.join(',') });
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

/** Get TSX index data for relative strength (XIU.TO proxy) */
export async function getTSXIndex(): Promise<{ level: number; change: number; changePct: number } | null> {
  try {
    // ^GSPTSE returns 402 on current plan — use XIU.TO (iShares S&P/TSX 60 ETF) as proxy
    const raw = await fmpFetch<FMPQuote[]>('/quote', { symbol: 'XIU.TO' });
    if (raw.length > 0) {
      return {
        level: raw[0].price,
        change: raw[0].change,
        changePct: raw[0].changePercentage,
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
    // CLUSD/GCUSD return 402 on current plan — use USO and GLD ETFs as proxies
    const [oilData, goldData, fxData] = await Promise.all([
      fmpFetch<FMPQuote[]>('/quote', { symbol: 'USO' }).catch(() => []),
      fmpFetch<FMPQuote[]>('/quote', { symbol: 'GLD' }).catch(() => []),
      fmpFetch<FMPQuote[]>('/quote', { symbol: 'CADUSD=X' }).catch(() => []),
    ]);

    return {
      oil: Array.isArray(oilData) && oilData[0]?.price ? oilData[0].price : null,
      gold: Array.isArray(goldData) && goldData[0]?.price ? goldData[0].price : null,
      cadUsd: Array.isArray(fxData) && fxData[0]?.price ? fxData[0].price : null,
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
    // /stable/ endpoint is /news/stock (not /stock_news)
    const raw = await fmpFetch<any[]>('/news/stock', {
      symbol,
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

export interface DividendInfo {
  exDate: string;       // "2026-04-03"
  paymentDate: string;  // "2026-04-15"
  amount: number;       // 0.52
  yield: number;        // 3.8 (percentage)
  frequency: string;    // "Quarterly"
}

export async function getDividendInfo(ticker: string): Promise<DividendInfo | null> {
  try {
    const data = await fmpFetch<any[]>(
      `/dividends?symbol=${encodeURIComponent(ticker)}`
    );
    if (!data || data.length === 0) return null;
    const now = new Date();
    const sorted = data
      .filter((d: any) => d.date)
      .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const upcoming = sorted.find((d: any) => new Date(d.date) >= now);
    const entry = upcoming || sorted[0];
    if (!entry) return null;
    return {
      exDate: entry.date,
      paymentDate: entry.paymentDate || entry.date,
      amount: entry.dividend || entry.adjDividend || 0,
      yield: entry.yield || 0,
      frequency: entry.frequency || 'Unknown',
    };
  } catch {
    return null;
  }
}
