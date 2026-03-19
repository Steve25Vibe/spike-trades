// ============================================
// Technical Indicator Calculations
// Pure functions — no API calls
// ============================================

import { HistoricalBar, TechnicalIndicators } from '@/types';

/** Exponential Moving Average */
function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/** Simple Moving Average */
function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      const slice = data.slice(i - period + 1, i + 1);
      result.push(slice.reduce((a, b) => a + b, 0) / period);
    }
  }
  return result;
}

/** RSI (Relative Strength Index) */
function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const recent = changes.slice(-period);

  let avgGain = 0;
  let avgLoss = 0;
  for (const change of recent) {
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD */
function computeMACD(closes: number[]): { macd: number; signal: number; histogram: number } {
  if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine.slice(-9), 9);
  const macdVal = macdLine[macdLine.length - 1];
  const signalVal = signalLine[signalLine.length - 1];
  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal,
  };
}

/** ADX (Average Directional Index) */
function computeADX(bars: HistoricalBar[], period = 14): number {
  if (bars.length < period + 1) return 25;

  const trueRanges: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const prevHigh = bars[i - 1].high;
    const prevLow = bars[i - 1].low;

    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smoothTR = ema(trueRanges, period);
  const smoothPlusDM = ema(plusDM, period);
  const smoothMinusDM = ema(minusDM, period);

  const dx: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    if (smoothTR[i] === 0) { dx.push(0); continue; }
    const plusDI = (smoothPlusDM[i] / smoothTR[i]) * 100;
    const minusDI = (smoothMinusDM[i] / smoothTR[i]) * 100;
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  }

  const adxValues = ema(dx, period);
  return adxValues[adxValues.length - 1] || 25;
}

/** Bollinger Bands */
function computeBollinger(closes: number[], period = 20, stdDev = 2): {
  upper: number; middle: number; lower: number;
} {
  if (closes.length < period) {
    const last = closes[closes.length - 1];
    return { upper: last, middle: last, lower: last };
  }
  const recent = closes.slice(-period);
  const middle = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((a, b) => a + Math.pow(b - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: middle + stdDev * std,
    middle,
    lower: middle - stdDev * std,
  };
}

/** ATR (Average True Range) */
function computeATR(bars: HistoricalBar[], period = 14): number {
  if (bars.length < 2) return 0;
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trueRanges.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      )
    );
  }
  const atrValues = ema(trueRanges, period);
  return atrValues[atrValues.length - 1] || 0;
}

/** OBV (On-Balance Volume) */
function computeOBV(bars: HistoricalBar[]): number {
  let obv = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].close > bars[i - 1].close) obv += bars[i].volume;
    else if (bars[i].close < bars[i - 1].close) obv -= bars[i].volume;
  }
  return obv;
}

/** Calculate all technical indicators for a stock */
export function calculateTechnicals(bars: HistoricalBar[]): TechnicalIndicators {
  const closes = bars.map((b) => b.close);

  const macdResult = computeMACD(closes);
  const bollinger = computeBollinger(closes);

  const ema3Values = ema(closes, 3);
  const ema8Values = ema(closes, 8);
  const ema21Values = ema(closes, 21);
  const sma50Values = sma(closes, 50);
  const sma200Values = sma(closes, 200);

  return {
    rsi: computeRSI(closes),
    macd: macdResult.macd,
    macdSignal: macdResult.signal,
    macdHistogram: macdResult.histogram,
    adx: computeADX(bars),
    bollingerUpper: bollinger.upper,
    bollingerMiddle: bollinger.middle,
    bollingerLower: bollinger.lower,
    ema3: ema3Values[ema3Values.length - 1],
    ema8: ema8Values[ema8Values.length - 1],
    ema21: ema21Values[ema21Values.length - 1],
    sma50: sma50Values[sma50Values.length - 1] || closes[closes.length - 1],
    sma200: sma200Values[sma200Values.length - 1] || closes[closes.length - 1],
    atr: computeATR(bars),
    obv: computeOBV(bars),
  };
}

/** Detect breakout patterns */
export function detectBreakout(bars: HistoricalBar[], technicals: TechnicalIndicators): {
  isBreakout: boolean;
  type: 'resistance' | 'support' | 'channel' | 'none';
  strength: number; // 0-100
} {
  if (bars.length < 20) return { isBreakout: false, type: 'none', strength: 0 };

  const lastPrice = bars[bars.length - 1].close;
  const recent20Highs = bars.slice(-20).map((b) => b.high);
  const recent20Lows = bars.slice(-20).map((b) => b.low);
  const resistance = Math.max(...recent20Highs.slice(0, -1)); // Exclude today
  const support = Math.min(...recent20Lows.slice(0, -1));

  // Resistance breakout
  if (lastPrice > resistance) {
    const volumeRatio = bars[bars.length - 1].volume / (bars.slice(-20, -1).reduce((a, b) => a + b.volume, 0) / 19);
    return {
      isBreakout: true,
      type: 'resistance',
      strength: Math.min(volumeRatio * 30 + (technicals.adx > 25 ? 30 : 10) + (technicals.rsi > 50 ? 20 : 0), 100),
    };
  }

  // EMA crossover breakout
  if (technicals.ema3 > technicals.ema8 && technicals.macdHistogram > 0) {
    return {
      isBreakout: true,
      type: 'channel',
      strength: Math.min(40 + (technicals.adx > 20 ? 20 : 0) + (technicals.rsi > 50 ? 20 : 0), 100),
    };
  }

  return { isBreakout: false, type: 'none', strength: 0 };
}
