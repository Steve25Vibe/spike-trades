// ============================================
// SPIKE TRADES — Core Type Definitions
// ============================================

export interface StockQuote {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  exchange: 'TSX' | 'TSXV';
  sector?: string;
  industry?: string;
  timestamp: number;
}

export interface HistoricalBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number;
}

export interface TechnicalIndicators {
  rsi: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  adx: number;
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  ema3: number;
  ema8: number;
  ema21: number;
  sma50: number;
  sma200: number;
  atr: number;
  obv: number;
  vwap?: number;
}

export interface SpikeScoreBreakdown {
  momentum: number;       // 0-100
  volumeSurge: number;    // 0-100
  technical: number;      // 0-100
  macroSensitivity: number; // 0-100
  sentiment: number;      // 0-100
  shortInterest: number;  // 0-100
  volatilityAdj: number;  // 0-100
  sectorRotation: number; // 0-100
  patternMatch: number;   // 0-100
  liquidityDepth: number; // Creative #1: order book depth & spread quality
  insiderSignal: number;  // Creative #2: insider buying patterns
  gapPotential: number;   // Creative #3: overnight gap probability scoring
}

export interface SpikeCandidate {
  quote: StockQuote;
  history: HistoricalBar[];
  technicals: TechnicalIndicators;
  scoreBreakdown: SpikeScoreBreakdown;
  spikeScore: number;     // Weighted composite 0-100
  predicted3Day: number;  // % return
  predicted5Day: number;
  predicted8Day: number;
  confidence: number;     // 0-100%
  narrative?: string;
}

export interface SpikeCard {
  id: string;
  rank: number;
  ticker: string;
  name: string;
  sector: string;
  exchange: 'TSX' | 'TSXV';
  price: number;
  spikeScore: number;
  confidence: number;
  predicted3Day: number;
  predicted5Day: number;
  predicted8Day: number;
  narrative: string;
  technicals: TechnicalIndicators;
  scoreBreakdown: SpikeScoreBreakdown;
  historicalConfidence?: number;   // 0-100, from calibration engine
  calibrationSamples?: number;     // sample count
  overconfidenceFlag?: boolean;    // council >> history
  isOpeningBellPick?: boolean;     // also detected by Opening Bell scanner
  isRadarPick?: boolean;           // flagged by pre-market Radar scanner
  radarScore?: number | null;      // Smart Money Conviction Score (0-100)
}

export interface MarketRegime {
  regime: 'bull' | 'bear' | 'neutral' | 'volatile';
  tsxLevel: number;
  tsxChange: number;
  oilPrice: number;
  goldPrice: number;
  btcPrice: number;
  cadUsd: number;
  vix?: number;
  sectorLeader?: string;
}

export interface PortfolioPosition {
  id: string;
  ticker: string;
  name: string;
  entryPrice: number;
  currentPrice: number;
  shares: number;
  positionSize: number;
  positionPct: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  target3Day: number;
  target5Day: number;
  target8Day: number;
  stopLoss: number;
  entryDate: string;
  daysHeld: number;
  status: 'active' | 'closed' | 'stopped';
  alerts: {
    sent3Day: boolean;
    sent5Day: boolean;
    sent8Day: boolean;
    deviationAlert: boolean;
  };
}

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  totalPnl: number;
  totalPnlPct: number;
  activePositions: number;
  winRate: number;
  avgReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  compoundedReturn: number;
}

export interface AccuracyMetrics {
  horizon: 3 | 5 | 8;
  hitRate: number;
  mae: number;
  bias: number;
  correlation: number;
  totalPredictions: number;
  rollingAccuracy: { date: string; hitRate: number; mae: number }[];
}

export interface CouncilVerdict {
  topSpikes: SpikeCandidate[];
  marketOutlook: string;
  riskWarnings: string[];
  sectorAllocations: { sector: string; weight: number }[];
  confidenceLevel: number;
  timestamp: string;
}

export interface DailyReportSummary {
  id: string;
  date: string;
  topSpike: { ticker: string; score: number };
  avgScore: number;
  marketRegime: string;
  csvUrl?: string;
}

// API Response wrappers
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  page: number;
  pageSize: number;
  total: number;
}
