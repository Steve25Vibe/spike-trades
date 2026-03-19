// ============================================
// SPIKE SCORE ENGINE
// Proprietary multi-factor composite scoring
// Optimized for 3/5/8-day Canadian market returns
// ============================================

import { StockQuote, HistoricalBar, TechnicalIndicators, SpikeScoreBreakdown, MarketRegime } from '@/types';
import { calculateTechnicals, detectBreakout } from './technicals';

// Dynamic weight profiles by market regime
// IMPORTANT: All regimes MUST sum to exactly 1.00
// Weights are initial heuristics — to be refined via backtesting walk-forward optimization
const REGIME_WEIGHTS_RAW: Record<string, Record<keyof SpikeScoreBreakdown, number>> = {
  bull: {
    momentum: 0.15, volumeSurge: 0.11, technical: 0.11, macroSensitivity: 0.08,
    sentiment: 0.07, shortInterest: 0.05, volatilityAdj: 0.08, sectorRotation: 0.07,
    patternMatch: 0.08, liquidityDepth: 0.07, insiderSignal: 0.07, gapPotential: 0.06,
  },
  bear: {
    momentum: 0.07, volumeSurge: 0.09, technical: 0.14, macroSensitivity: 0.10,
    sentiment: 0.09, shortInterest: 0.09, volatilityAdj: 0.12, sectorRotation: 0.06,
    patternMatch: 0.08, liquidityDepth: 0.05, insiderSignal: 0.05, gapPotential: 0.06,
  },
  neutral: {
    momentum: 0.11, volumeSurge: 0.09, technical: 0.11, macroSensitivity: 0.08,
    sentiment: 0.08, shortInterest: 0.07, volatilityAdj: 0.09, sectorRotation: 0.08,
    patternMatch: 0.08, liquidityDepth: 0.07, insiderSignal: 0.07, gapPotential: 0.07,
  },
  volatile: {
    momentum: 0.07, volumeSurge: 0.07, technical: 0.10, macroSensitivity: 0.09,
    sentiment: 0.09, shortInterest: 0.07, volatilityAdj: 0.14, sectorRotation: 0.06,
    patternMatch: 0.10, liquidityDepth: 0.07, insiderSignal: 0.07, gapPotential: 0.07,
  },
};

// Auto-normalize weights to sum to exactly 1.0 (prevents silent inflation/deflation)
function normalizeWeights(
  weights: Record<keyof SpikeScoreBreakdown, number>
): Record<keyof SpikeScoreBreakdown, number> {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1.0) < 0.001) return weights; // Already normalized
  const normalized = {} as Record<keyof SpikeScoreBreakdown, number>;
  for (const [key, value] of Object.entries(weights)) {
    normalized[key as keyof SpikeScoreBreakdown] = value / sum;
  }
  return normalized;
}

const REGIME_WEIGHTS: Record<string, Record<keyof SpikeScoreBreakdown, number>> = {
  bull: normalizeWeights(REGIME_WEIGHTS_RAW.bull),
  bear: normalizeWeights(REGIME_WEIGHTS_RAW.bear),
  neutral: normalizeWeights(REGIME_WEIGHTS_RAW.neutral),
  volatile: normalizeWeights(REGIME_WEIGHTS_RAW.volatile),
};

/** Score Factor 1: Momentum (3/5/8-day returns + relative strength) */
function scoreMomentum(bars: HistoricalBar[], tsxChangePct: number): number {
  if (bars.length < 8) return 50;
  const closes = bars.map((b) => b.close);
  const current = closes[closes.length - 1];

  const ret3 = ((current - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;
  const ret5 = ((current - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
  const ret8 = ((current - closes[closes.length - 9]) / closes[closes.length - 9]) * 100;

  // Relative strength vs TSX
  const avgRet = (ret3 + ret5 + ret8) / 3;
  const relStrength = avgRet - tsxChangePct;

  // Score: positive momentum + outperformance = high score
  let score = 50;
  score += Math.min(avgRet * 5, 25);         // Up to 25 for positive returns
  score += Math.min(relStrength * 3, 15);     // Up to 15 for outperformance
  // Bonus for accelerating momentum (3-day > 5-day > 8-day per day)
  if (ret3 / 3 > ret5 / 5 && ret5 / 5 > ret8 / 8 && ret3 > 0) score += 10;

  return Math.max(0, Math.min(100, score));
}

/** Score Factor 2: Volume Surge & Liquidity */
function scoreVolumeSurge(quote: StockQuote, bars: HistoricalBar[]): number {
  if (!quote.avgVolume || quote.avgVolume === 0) return 30;

  const volumeRatio = quote.volume / quote.avgVolume;
  const dollarVolume = quote.price * quote.volume;

  let score = 0;
  // Volume surge scoring
  if (volumeRatio >= 3.0) score += 40;
  else if (volumeRatio >= 2.0) score += 30;
  else if (volumeRatio >= 1.5) score += 20;
  else if (volumeRatio >= 1.0) score += 10;

  // Dollar volume (min $2M filter is applied upstream)
  if (dollarVolume >= 20e6) score += 30;
  else if (dollarVolume >= 10e6) score += 25;
  else if (dollarVolume >= 5e6) score += 20;
  else if (dollarVolume >= 2e6) score += 15;

  // Volume trend (rising volume over 3 days)
  if (bars.length >= 3) {
    const recentVols = bars.slice(-3).map((b) => b.volume);
    if (recentVols[2] > recentVols[1] && recentVols[1] > recentVols[0]) score += 15;
  }

  // Price-volume confirmation: price up + volume up = bullish
  if (quote.changePercent > 0 && volumeRatio > 1.2) score += 15;

  return Math.max(0, Math.min(100, score));
}

/** Score Factor 3: Technical Confluence */
function scoreTechnical(technicals: TechnicalIndicators, bars: HistoricalBar[]): number {
  let score = 50;

  // RSI: sweet spot 40-65 (not overbought, rising)
  if (technicals.rsi >= 40 && technicals.rsi <= 65) score += 15;
  else if (technicals.rsi < 30) score += 10; // Oversold bounce potential
  else if (technicals.rsi > 75) score -= 10;  // Overbought risk

  // MACD: bullish crossover
  if (technicals.macdHistogram > 0) score += 10;
  if (technicals.macd > technicals.macdSignal) score += 5;

  // ADX: strong trend
  if (technicals.adx > 25) score += 10;
  if (technicals.adx > 40) score += 5;

  // Bollinger: near lower band = opportunity
  const lastPrice = bars[bars.length - 1]?.close || 0;
  const bbRange = technicals.bollingerUpper - technicals.bollingerLower;
  if (bbRange > 0) {
    const bbPosition = (lastPrice - technicals.bollingerLower) / bbRange;
    if (bbPosition < 0.3) score += 10; // Near lower band
  }

  // EMA crossover: 3 EMA > 8 EMA (bullish short-term)
  if (technicals.ema3 > technicals.ema8) score += 10;

  // Breakout detection
  const breakout = detectBreakout(bars, technicals);
  if (breakout.isBreakout) score += breakout.strength * 0.15;

  return Math.max(0, Math.min(100, score));
}

/** Score Factor 4: Canadian Macro Sensitivity */
function scoreMacro(
  quote: StockQuote,
  sector: string,
  regime: MarketRegime
): number {
  let score = 50;
  const sectorLower = sector.toLowerCase();

  // Energy stocks: positively correlated with oil
  if (sectorLower.includes('energy') || sectorLower.includes('oil')) {
    if (regime.oilPrice > 70) score += 15;
    if (regime.oilPrice > 80) score += 10;
  }

  // Mining/Materials: correlated with gold & commodities
  if (sectorLower.includes('material') || sectorLower.includes('mining') || sectorLower.includes('gold')) {
    if (regime.goldPrice > 2000) score += 15;
    if (regime.goldPrice > 2200) score += 10;
  }

  // Financials: benefit from rising TSX
  if (sectorLower.includes('financial') || sectorLower.includes('bank')) {
    if (regime.tsxChange > 0) score += 10;
    if (regime.regime === 'bull') score += 10;
  }

  // Weak CAD benefits exporters
  if (regime.cadUsd && regime.cadUsd < 0.74) {
    if (sectorLower.includes('industrial') || sectorLower.includes('tech')) score += 10;
  }

  // Regime alignment
  if (regime.regime === 'bull') score += 5;
  if (regime.regime === 'volatile') score -= 5;

  return Math.max(0, Math.min(100, score));
}

/** Score Factor 5: Sentiment */
function scoreSentiment(
  newsCount: number,
  sentimentScore: number, // -1 to 1
  buzz: number
): number {
  let score = 50;

  // Positive sentiment
  score += sentimentScore * 25; // -25 to +25

  // News buzz (more coverage = more attention)
  if (buzz > 2) score += 10;
  if (buzz > 5) score += 5;

  // Fresh news
  if (newsCount > 5) score += 10;
  else if (newsCount > 2) score += 5;

  return Math.max(0, Math.min(100, score));
}

/** Score Factor 6: Short Interest Signal */
function scoreShortInterest(shortInterestPct: number | null): number {
  if (shortInterestPct === null) return 50; // Neutral when unknown

  // Moderate short interest = potential squeeze
  if (shortInterestPct >= 15 && shortInterestPct <= 30) return 75;
  if (shortInterestPct >= 10 && shortInterestPct <= 15) return 65;
  // Very high = risky
  if (shortInterestPct > 30) return 35;
  // Low = no squeeze catalyst
  if (shortInterestPct < 5) return 50;
  return 55;
}

/** Score Factor 7: Volatility-Adjusted Confidence */
function scoreVolatilityAdj(technicals: TechnicalIndicators, bars: HistoricalBar[]): number {
  const atr = technicals.atr;
  const lastPrice = bars[bars.length - 1]?.close || 1;
  const atrPct = (atr / lastPrice) * 100;

  // Sweet spot: moderate volatility (1-3% ATR)
  if (atrPct >= 1 && atrPct <= 3) return 80;
  if (atrPct >= 0.5 && atrPct <= 4) return 65;
  if (atrPct > 5) return 30; // Too volatile
  if (atrPct < 0.5) return 40; // Too quiet
  return 50;
}

/** Score Factor 8: Sector Rotation Penalty */
function scoreSectorRotation(
  sector: string,
  allSectors: Map<string, number>, // sector -> count in top candidates
  maxPerSector = 5
): number {
  const count = allSectors.get(sector) || 0;
  if (count <= 2) return 80;  // Under-represented = good
  if (count <= maxPerSector) return 60;
  return 30; // Over-concentrated = penalize
}

/** Score Factor 9: Historical Pattern Match */
function scorePatternMatch(bars: HistoricalBar[], technicals: TechnicalIndicators): number {
  if (bars.length < 30) return 50;

  let score = 50;

  // Look for similar RSI + MACD conditions in past 30 days
  // and check if they led to positive 3-day returns
  const closes = bars.map((b) => b.close);

  // Simple pattern: price near support + RSI < 40 historically leads to bounces
  if (technicals.rsi < 40 && technicals.ema3 < technicals.ema8) {
    // Check if previous similar setups bounced
    let bounceCount = 0;
    let totalSetups = 0;
    for (let i = 14; i < closes.length - 3; i++) {
      const localRSI = computeLocalRSI(closes.slice(0, i + 1));
      if (localRSI < 40) {
        totalSetups++;
        if (closes[i + 3] > closes[i]) bounceCount++;
      }
    }
    if (totalSetups > 0) {
      score = (bounceCount / totalSetups) * 100;
    }
  }

  // Breakout continuation pattern
  if (technicals.ema3 > technicals.ema8 && technicals.adx > 25) {
    score += 15;
  }

  return Math.max(0, Math.min(100, score));
}

/** Creative Factor 10: Liquidity Depth Score */
function scoreLiquidityDepth(quote: StockQuote): number {
  const dollarVolume = quote.price * quote.volume;
  const spread = quote.high > 0 ? ((quote.high - quote.low) / quote.price) * 100 : 5;

  let score = 50;
  // High dollar volume = deep liquidity
  if (dollarVolume >= 50e6) score += 25;
  else if (dollarVolume >= 20e6) score += 20;
  else if (dollarVolume >= 10e6) score += 15;
  else if (dollarVolume >= 5e6) score += 10;

  // Tight spread = better execution
  if (spread < 0.5) score += 20;
  else if (spread < 1.0) score += 10;
  else if (spread > 3.0) score -= 15;

  return Math.max(0, Math.min(100, score));
}

/** Creative Factor 11: Insider Signal Score */
function scoreInsiderSignal(
  insiderBuying: boolean,
  institutionalOwnership: number | null
): number {
  let score = 50;

  if (insiderBuying) score += 25;
  if (institutionalOwnership !== null) {
    if (institutionalOwnership > 50 && institutionalOwnership < 80) score += 15;
    if (institutionalOwnership > 80) score += 5; // Too crowded
  }

  return Math.max(0, Math.min(100, score));
}

/** Creative Factor 12: Gap Potential Score */
function scoreGapPotential(bars: HistoricalBar[], technicals: TechnicalIndicators): number {
  if (bars.length < 10) return 50;

  let score = 50;

  // Count recent gaps
  let gapUpCount = 0;
  for (let i = 1; i < Math.min(bars.length, 10); i++) {
    if (bars[i].open > bars[i - 1].close * 1.01) gapUpCount++;
  }

  // Stocks that gap frequently have higher overnight move potential
  if (gapUpCount >= 3) score += 20;
  else if (gapUpCount >= 2) score += 10;

  // Pre-breakout compression (low ATR relative to recent high ATR)
  const recentATR = technicals.atr;
  const prices = bars.slice(-10).map((b) => b.close);
  const priceRange = (Math.max(...prices) - Math.min(...prices)) / prices[0];
  if (priceRange < 0.03 && technicals.adx < 20) {
    // Compressed — likely to gap on breakout
    score += 15;
  }

  return Math.max(0, Math.min(100, score));
}

// Helper: compute RSI for a subset
function computeLocalRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const recent = changes.slice(-period);
  let avgGain = 0, avgLoss = 0;
  for (const c of recent) {
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ============================================
// MAIN SCORING FUNCTION
// ============================================

export interface ScoringInput {
  quote: StockQuote;
  bars: HistoricalBar[];
  sector: string;
  regime: MarketRegime;
  sentimentData?: { score: number; buzz: number; newsCount: number };
  shortInterestPct?: number | null;
  insiderBuying?: boolean;
  institutionalOwnership?: number | null;
  allSectors: Map<string, number>;
}

export interface ScoringResult {
  spikeScore: number;
  breakdown: SpikeScoreBreakdown;
  technicals: TechnicalIndicators;
  predicted3Day: number;
  predicted5Day: number;
  predicted8Day: number;
  confidence: number;
}

export function calculateSpikeScore(input: ScoringInput): ScoringResult {
  const {
    quote, bars, sector, regime,
    sentimentData, shortInterestPct,
    insiderBuying, institutionalOwnership,
    allSectors,
  } = input;

  const technicals = calculateTechnicals(bars);

  // Calculate all 12 factors
  const breakdown: SpikeScoreBreakdown = {
    momentum: scoreMomentum(bars, regime.tsxChange),
    volumeSurge: scoreVolumeSurge(quote, bars),
    technical: scoreTechnical(technicals, bars),
    macroSensitivity: scoreMacro(quote, sector, regime),
    sentiment: scoreSentiment(
      sentimentData?.newsCount || 0,
      sentimentData?.score || 0,
      sentimentData?.buzz || 0
    ),
    shortInterest: scoreShortInterest(shortInterestPct ?? null),
    volatilityAdj: scoreVolatilityAdj(technicals, bars),
    sectorRotation: scoreSectorRotation(sector, allSectors),
    patternMatch: scorePatternMatch(bars, technicals),
    liquidityDepth: scoreLiquidityDepth(quote),
    insiderSignal: scoreInsiderSignal(insiderBuying || false, institutionalOwnership ?? null),
    gapPotential: scoreGapPotential(bars, technicals),
  };

  // Get regime-specific weights
  const weights = REGIME_WEIGHTS[regime.regime] || REGIME_WEIGHTS.neutral;

  // Weighted composite score
  let spikeScore = 0;
  for (const [factor, weight] of Object.entries(weights)) {
    spikeScore += (breakdown[factor as keyof SpikeScoreBreakdown] || 0) * weight;
  }
  spikeScore = Math.round(spikeScore * 10) / 10;

  // ---- PRELIMINARY return estimates ----
  // These are DIRECTIONAL HINTS for the LLM Council, NOT final predictions.
  // The Council (Stage 3: SuperGrok Heavy) produces the official predictions.
  // These exist only so the Council has a baseline to evaluate against.
  const atrPct = (technicals.atr / quote.price) * 100;
  const momentumBias = (breakdown.momentum - 50) / 50; // -1 to 1

  // Preliminary estimate: based on ATR envelope scaled by score strength
  // EXPLICITLY LABELED as "preliminary" — will be overridden by Council
  const predicted3Day = Math.round(
    (spikeScore / 100) * atrPct * 0.6 * (1 + momentumBias * 0.2) * 100
  ) / 100;
  const predicted5Day = Math.round(predicted3Day * 1.3 * 100) / 100;
  const predicted8Day = Math.round(predicted3Day * 1.6 * 100) / 100;

  // ---- FACTOR AGREEMENT score ----
  // Measures how much the 12 scoring factors agree with each other.
  // NOT a probability. NOT prediction confidence.
  // Label: "Factor Agreement" in the UI, not "Confidence"
  const factorValues = Object.values(breakdown);
  const avgFactor = factorValues.reduce((a, b) => a + b, 0) / factorValues.length;
  const factorVariance = factorValues.reduce((a, b) => a + Math.pow(b - avgFactor, 2), 0) / factorValues.length;
  const factorStd = Math.sqrt(factorVariance);

  // High agreement (low std) → high score. Clamped 20-90.
  // This metric is SUPPLEMENTARY. The Council sets the real confidence level.
  const confidence = Math.round(Math.max(20, Math.min(90, 80 - factorStd * 0.6)));

  return {
    spikeScore,
    breakdown,
    technicals,
    predicted3Day,
    predicted5Day,
    predicted8Day,
    confidence,
  };
}

/** Filter and rank candidates into Top 20 */
export function rankTopSpikes(
  candidates: (ScoringResult & { quote: StockQuote; sector: string })[],
  maxPerSector = 4
): typeof candidates {
  // Sort by spike score descending
  const sorted = [...candidates].sort((a, b) => b.spikeScore - a.spikeScore);

  // Apply sector concentration limit
  const sectorCounts = new Map<string, number>();
  const result: typeof candidates = [];

  for (const candidate of sorted) {
    const count = sectorCounts.get(candidate.sector) || 0;
    if (count >= maxPerSector) continue;
    sectorCounts.set(candidate.sector, count + 1);
    result.push(candidate);
    if (result.length >= 20) break;
  }

  return result;
}
