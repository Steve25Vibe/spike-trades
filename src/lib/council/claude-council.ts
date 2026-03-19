// ============================================
// LLM COUNCIL PROTOCOL — 3-Stage Pipeline
// ============================================
// Stage 1: Claude Sonnet — Grunt work. Screens all candidates, filters
//          noise, identifies setups, flags risks, produces initial
//          ranked shortlist with quantitative reasoning.
//
// Stage 2: Claude Opus  — Deep review. Challenges Sonnet's picks,
//          stress-tests theses, identifies what Sonnet missed,
//          produces a second independent ranking with dissenting
//          opinions where it disagrees.
//
// Stage 3: SuperGrok Heavy (xAI) — Final authority. Receives both
//          analyses plus the raw data. Makes the BINDING decision
//          on the Top 20, resolves all disagreements, assigns final
//          conviction levels, writes plain-English narratives,
//          and produces the official predicted returns.
//
// SuperGrok's verdict is LAW. Logged in full for audit.
// ============================================

import Anthropic from '@anthropic-ai/sdk';
import { SpikeCandidate, MarketRegime, CouncilVerdict } from '@/types';
import prisma from '@/lib/db/prisma';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_BASE_URL = 'https://api.x.ai/v1';

// ============================================
// DATA FORMATTING — Shared across all stages
// ============================================

interface CouncilInput {
  candidates: SpikeCandidate[];
  regime: MarketRegime;
  date: string;
}

function formatCandidateData(candidates: SpikeCandidate[], limit = 40) {
  return candidates.slice(0, limit).map((c) => ({
    ticker: c.quote.ticker,
    name: c.quote.name,
    price: c.quote.price,
    sector: c.quote.sector || 'Unknown',
    exchange: c.quote.exchange,
    marketCap: c.quote.marketCap,
    spikeScore: c.spikeScore,
    volume: c.quote.volume,
    avgVolume: c.quote.avgVolume,
    volumeRatio: c.quote.avgVolume ? +(c.quote.volume / c.quote.avgVolume).toFixed(2) : null,
    dollarVolume: Math.round(c.quote.price * c.quote.volume),
    // Technicals
    rsi: +c.technicals.rsi.toFixed(1),
    macd: +c.technicals.macd.toFixed(4),
    macdSignal: +c.technicals.macdSignal.toFixed(4),
    macdHistogram: +c.technicals.macdHistogram.toFixed(4),
    adx: +c.technicals.adx.toFixed(1),
    atr: +c.technicals.atr.toFixed(4),
    atrPct: +((c.technicals.atr / c.quote.price) * 100).toFixed(2),
    ema3: +c.technicals.ema3.toFixed(2),
    ema8: +c.technicals.ema8.toFixed(2),
    ema3AboveEma8: c.technicals.ema3 > c.technicals.ema8,
    bollingerPosition: c.technicals.bollingerUpper > 0
      ? +((c.quote.price - c.technicals.bollingerLower) / (c.technicals.bollingerUpper - c.technicals.bollingerLower) * 100).toFixed(1)
      : null,
    sma50: +c.technicals.sma50.toFixed(2),
    sma200: +c.technicals.sma200.toFixed(2),
    aboveSma50: c.quote.price > c.technicals.sma50,
    aboveSma200: c.quote.price > c.technicals.sma200,
    // Score breakdown (all 12 factors)
    scoreBreakdown: c.scoreBreakdown,
  }));
}

function formatMarketContext(regime: MarketRegime, date: string): string {
  return `DATE: ${date}
MARKET REGIME: ${regime.regime.toUpperCase()}
TSX COMPOSITE: ${regime.tsxLevel.toFixed(0)} (${regime.tsxChange >= 0 ? '+' : ''}${regime.tsxChange.toFixed(2)}%)
WTI CRUDE OIL: $${regime.oilPrice.toFixed(2)} USD/barrel
GOLD: $${regime.goldPrice.toFixed(0)} CAD
BTC: $${regime.btcPrice?.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) || 'N/A'} CAD
CAD/USD: ${regime.cadUsd?.toFixed(4) || 'N/A'}`;
}

// ============================================
// STAGE 1: CLAUDE SONNET — The Screener
// ============================================

const SONNET_SYSTEM = `You are a quantitative equity screener for Canadian markets (TSX/TSXV).

YOUR JOB: Given raw scored candidates with technical indicators, perform rigorous quantitative screening.

For each candidate you must evaluate:
1. SETUP QUALITY: Is there a genuine technical setup (breakout, reversal, continuation) or just noise?
2. VOLUME CONFIRMATION: Does volume support the move, or is this thin/manipulated action?
3. RISK FLAGS: Identify stocks that could be pump-and-dumps, have abnormally wide spreads, or show distribution patterns (rising price + falling volume, or volume spikes without follow-through).
4. CATALYST CHECK: Based on the technical pattern and sector context, is there a plausible reason for the move?
5. CORRELATION: Flag if multiple candidates are essentially the same trade (e.g., 5 oil stocks all riding the same crude move).

CRITICAL RULES:
- Do NOT invent catalysts you don't see in the data. Say "no visible catalyst" if there isn't one.
- A high spike score does NOT mean a stock is a good pick. Challenge the score.
- If RSI > 70 and ADX > 40, that's potentially OVERBOUGHT, not "strong momentum."
- If volume is 3x average but price is flat or down, that's DISTRIBUTION, not accumulation.
- Penny stocks (<$2) with sudden volume spikes should be flagged as potential manipulation.
- Do not assume the scoring model's predictions are correct. Evaluate independently.

OUTPUT FORMAT (JSON):
{
  "shortlist": [
    {
      "ticker": "CNQ.TO",
      "setupType": "breakout|reversal|continuation|mean_reversion|none",
      "setupQuality": 1-10,
      "volumeVerdict": "confirmed|unconfirmed|suspicious|distribution",
      "riskFlags": ["flag1", "flag2"],
      "catalystVisible": true|false,
      "catalystNote": "Oil above $78 driving sector",
      "correlationGroup": "energy_oil" | null,
      "screenVerdict": "pass|marginal|fail",
      "reasoning": "2-3 sentences of quantitative reasoning"
    }
  ],
  "marketNotes": "Brief observation about today's market conditions",
  "flaggedManipulation": ["TICKER1.TO"],
  "correlationWarnings": ["5 energy names all riding same oil move — choose best 2"]
}`;

async function runSonnetScreener(input: CouncilInput): Promise<any> {
  const candidateData = formatCandidateData(input.candidates);
  const marketContext = formatMarketContext(input.regime, input.date);

  const userMessage = `${marketContext}

CANDIDATES TO SCREEN (${candidateData.length} stocks, ranked by spike score):

${JSON.stringify(candidateData, null, 2)}

Screen every candidate. Be ruthless — flag anything suspicious.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: SONNET_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    console.warn('[Council:Sonnet] Failed to parse JSON response');
    return null;
  } catch (error) {
    console.error('[Council:Sonnet] Error:', error);
    return null;
  }
}

// ============================================
// STAGE 2: CLAUDE OPUS — The Challenger
// ============================================

const OPUS_SYSTEM = `You are a senior portfolio strategist reviewing a junior analyst's stock screening work for Canadian markets (TSX/TSXV).

You have been given:
1. The raw candidate data with technical indicators
2. A junior analyst's screening results (from Sonnet)

YOUR JOB: Challenge the screening. Be the devil's advocate.

For each stock the junior analyst passed:
- Do you AGREE or DISAGREE with the verdict? Why?
- What did the junior analyst MISS? (both upside and downside)
- Is the risk/reward actually favorable for a 3-8 day hold?
- Would you size this position normally, or reduce it due to uncertainty?

For stocks the junior analyst FAILED:
- Are there any that deserve a second look? Sometimes the model rejects good setups.

Then produce YOUR OWN independent Top 20 ranking with:
- Your conviction (1-10) — be honest, not generous
- Your predicted return RANGE (not a point estimate) — e.g., "+1.5% to +4.2%"
- Your key concern for each pick
- A "kill condition" — what would make you exit immediately

CRITICAL RULES:
- If you agree with Sonnet on a pick, say so and explain what additional evidence supports it.
- If you disagree, explain exactly why with reference to specific indicators.
- Do NOT rubber-stamp. If the screening was sloppy, say so.
- Consider position sizing — a 90-score stock with 5% ATR needs smaller size than a 75-score stock with 1.5% ATR.
- Think about what happens if this trade goes WRONG. What's the maximum loss scenario?

OUTPUT FORMAT (JSON):
{
  "agreements": ["CNQ.TO", "RY.TO"],
  "disagreements": [
    { "ticker": "SHOP.TO", "sonnetSaid": "pass", "opusSays": "marginal", "reason": "..." }
  ],
  "missedOpportunities": [
    { "ticker": "BNS.TO", "sonnetSaid": "fail", "opusSays": "pass", "reason": "..." }
  ],
  "opusTop20": [
    {
      "ticker": "CNQ.TO",
      "rank": 1,
      "conviction": 8,
      "predictedReturnLow": 1.5,
      "predictedReturnHigh": 4.2,
      "predicted3Day": 2.8,
      "predicted5Day": 3.9,
      "predicted8Day": 5.1,
      "keyRisk": "Oil reversal below $74",
      "killCondition": "Close below $86.50 (2x ATR stop)",
      "narrative": "2-3 sentence plain-English thesis",
      "positionSizeAdj": "normal|reduced|minimal"
    }
  ],
  "portfolioRisks": ["Overweight energy (3 of top 10)", "No defensive names"],
  "marketOutlook": "2-3 sentence outlook with specific levels to watch"
}`;

async function runOpusChallenger(
  input: CouncilInput,
  sonnetResult: any
): Promise<any> {
  const candidateData = formatCandidateData(input.candidates);
  const marketContext = formatMarketContext(input.regime, input.date);

  const userMessage = `${marketContext}

RAW CANDIDATE DATA (${candidateData.length} stocks):
${JSON.stringify(candidateData, null, 2)}

JUNIOR ANALYST (SONNET) SCREENING RESULTS:
${JSON.stringify(sonnetResult, null, 2)}

Review the screening. Challenge it. Produce your own Top 20.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 8192,
      system: OPUS_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    console.warn('[Council:Opus] Failed to parse JSON response');
    return null;
  } catch (error) {
    console.error('[Council:Opus] Error:', error);
    return null;
  }
}

// ============================================
// STAGE 3: SUPERGROK HEAVY — The Final Authority
// ============================================

const GROK_SYSTEM = `You are SuperGrok Heavy, the final decision-maker for Spike Trades — a Canadian stock market prediction system for TSX/TSXV.

You have been given:
1. Raw candidate data with all technical indicators
2. A quantitative screening from Analyst A (Sonnet)
3. A strategic review from Analyst B (Opus), who challenged Analyst A

YOUR VERDICT IS FINAL. No appeals. You decide:
- The definitive Top 20 picks
- The official predicted returns (these will be shown to the user)
- The official conviction levels
- The plain-English narrative for each pick (written for a non-expert investor)

DECISION FRAMEWORK:
1. Where Sonnet and Opus AGREE: High conviction. Use the consensus.
2. Where they DISAGREE: You decide who is right, and explain why.
3. Where both MISSED something: Add it if the data supports it.
4. FINAL PREDICTIONS must be conservative — better to underpromise and overdeliver.
5. Conviction 8-10: Only for setups where multiple independent signals confirm AND risk is well-defined.
6. Conviction 5-7: Decent setup but one or more weak spots.
7. Conviction 1-4: Marginal — only included if the Top 20 needs filling.

NARRATIVE RULES:
- Write for someone who doesn't know what RSI or MACD means.
- Explain WHY this stock is expected to rise, not just THAT it scored well.
- Every narrative must include the key risk in plain English.
- Never claim certainty. Use phrases like "the data suggests", "historically similar setups have...", "the risk is..."

PREDICTION RULES:
- predicted3Day/5Day/8Day must be your honest estimate, not the scoring model's output.
- If you don't believe a stock will move significantly, predict a small or zero return — don't inflate.
- The prediction should reflect the MOST LIKELY outcome, not the best case.
- Include a lossScenario: what the return looks like if the trade goes wrong.

OUTPUT FORMAT (JSON):
{
  "finalTop20": [
    {
      "ticker": "CNQ.TO",
      "rank": 1,
      "finalConviction": 8,
      "predicted3Day": 2.5,
      "predicted5Day": 3.8,
      "predicted8Day": 5.1,
      "lossScenario3Day": -1.8,
      "narrative": "Plain-English explanation for a non-expert...",
      "keyRisk": "One-sentence risk in plain English",
      "sonnetAgreed": true,
      "opusAgreed": true,
      "grokOverride": false,
      "overrideReason": null
    }
  ],
  "removedFromConsideration": [
    { "ticker": "XYZ.TO", "reason": "Both analysts flagged distribution pattern" }
  ],
  "disagreementsResolved": [
    { "ticker": "SHOP.TO", "sonnetSaid": "pass", "opusSaid": "marginal", "grokDecision": "include at rank 12", "reason": "..." }
  ],
  "marketOutlook": "2-3 sentence outlook in plain English",
  "riskWarnings": ["Warning 1 in plain English", "Warning 2"],
  "sectorAllocations": [{"sector": "Energy", "weight": 25, "reason": "Oil above $78 supports"}],
  "overallConfidence": 1-100,
  "portfolioNote": "Brief note on portfolio balance and risk"
}`;

async function runGrokFinalAuthority(
  input: CouncilInput,
  sonnetResult: any,
  opusResult: any
): Promise<any> {
  const candidateData = formatCandidateData(input.candidates);
  const marketContext = formatMarketContext(input.regime, input.date);

  const userMessage = `${marketContext}

RAW CANDIDATE DATA (${candidateData.length} stocks):
${JSON.stringify(candidateData, null, 2)}

=== ANALYST A (SONNET) — Quantitative Screening ===
${JSON.stringify(sonnetResult, null, 2)}

=== ANALYST B (OPUS) — Strategic Challenge ===
${JSON.stringify(opusResult, null, 2)}

You are the final authority. Produce the definitive Top 20. Your verdict is law.`;

  // Try xAI Grok first
  if (XAI_API_KEY) {
    try {
      const response = await fetch(`${XAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${XAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'grok-3',
          messages: [
            { role: 'system', content: GROK_SYSTEM },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 8192,
          temperature: 0.3, // Low temperature for consistent, careful decisions
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          console.log('[Council:Grok] SuperGrok Heavy verdict received');
          return { ...JSON.parse(jsonMatch[0]), _source: 'grok' };
        }
      } else {
        console.warn(`[Council:Grok] API returned ${response.status}, falling back to Opus`);
      }
    } catch (error) {
      console.warn('[Council:Grok] xAI API error, falling back to Opus:', error);
    }
  }

  // Fallback: Run Claude Opus as final authority if Grok unavailable
  console.log('[Council] Grok unavailable — Opus acting as final authority');
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 8192,
      system: GROK_SYSTEM.replace('SuperGrok Heavy', 'Senior Council Authority'),
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { ...JSON.parse(jsonMatch[0]), _source: 'opus_fallback' };
    return null;
  } catch (error) {
    console.error('[Council:Fallback] Error:', error);
    return null;
  }
}

// ============================================
// COUNCIL ORCHESTRATOR — Run the full pipeline
// ============================================

export async function runCouncil(input: CouncilInput): Promise<CouncilVerdict> {
  const startTime = Date.now();
  const { candidates, regime, date } = input;

  console.log(`\n[Council] ====== Starting 3-Stage Council for ${date} ======`);
  console.log(`[Council] ${candidates.length} candidates, regime: ${regime.regime}`);

  // ---------- STAGE 1: Sonnet Screening ----------
  console.log('[Council] Stage 1: Claude Sonnet screening...');
  const sonnetStart = Date.now();
  const sonnetResult = await runSonnetScreener(input);
  const sonnetTime = Date.now() - sonnetStart;
  console.log(`[Council] Stage 1 complete (${(sonnetTime / 1000).toFixed(1)}s) — ${sonnetResult?.shortlist?.length || 0} candidates screened`);

  if (!sonnetResult) {
    console.error('[Council] Sonnet failed — falling back to scoring engine rankings');
    return buildFallbackVerdict(candidates, regime, date, startTime);
  }

  // ---------- STAGE 2: Opus Challenge ----------
  console.log('[Council] Stage 2: Claude Opus challenging Sonnet...');
  const opusStart = Date.now();
  const opusResult = await runOpusChallenger(input, sonnetResult);
  const opusTime = Date.now() - opusStart;
  console.log(`[Council] Stage 2 complete (${(opusTime / 1000).toFixed(1)}s) — ${opusResult?.opusTop20?.length || 0} picks, ${opusResult?.disagreements?.length || 0} disagreements`);

  if (!opusResult) {
    console.warn('[Council] Opus failed — Sonnet results will go directly to final authority');
  }

  // ---------- STAGE 3: Grok Final Authority ----------
  console.log('[Council] Stage 3: SuperGrok Heavy final decision...');
  const grokStart = Date.now();
  const grokResult = await runGrokFinalAuthority(input, sonnetResult, opusResult);
  const grokTime = Date.now() - grokStart;
  const grokSource = grokResult?._source || 'unknown';
  console.log(`[Council] Stage 3 complete (${(grokTime / 1000).toFixed(1)}s) via ${grokSource} — ${grokResult?.finalTop20?.length || 0} final picks`);

  // ---------- BUILD VERDICT ----------
  const verdict = buildVerdict(candidates, grokResult, sonnetResult, opusResult, regime);

  // ---------- CALCULATE CONSENSUS ----------
  const consensus = calculateThreeWayConsensus(sonnetResult, opusResult, grokResult);

  // ---------- LOG EVERYTHING ----------
  const totalTime = Date.now() - startTime;
  console.log(`[Council] ====== Council complete in ${(totalTime / 1000).toFixed(1)}s | Consensus: ${consensus.toFixed(1)}% ======\n`);

  try {
    await prisma.councilLog.create({
      data: {
        date: new Date(date),
        claudeAnalysis: {
          sonnet: { result: sonnetResult, timeMs: sonnetTime },
          opus: { result: opusResult, timeMs: opusTime },
        },
        grokAnalysis: {
          result: grokResult,
          timeMs: grokTime,
          source: grokSource,
        },
        finalVerdict: verdict as any,
        consensusScore: consensus,
        processingTime: totalTime,
      },
    });
  } catch (err) {
    console.error('[Council] Failed to log council:', err);
  }

  return verdict;
}

// ============================================
// VERDICT BUILDER
// ============================================

function buildVerdict(
  originalCandidates: SpikeCandidate[],
  grokResult: any,
  sonnetResult: any,
  opusResult: any,
  regime: MarketRegime
): CouncilVerdict {
  // If Grok produced a finalTop20, that's the binding decision
  if (grokResult?.finalTop20?.length > 0) {
    const topSpikes = grokResult.finalTop20.map((pick: any) => {
      const candidate = originalCandidates.find((c) => c.quote.ticker === pick.ticker);
      if (!candidate) return null;

      // Grok's predictions OVERRIDE the scoring engine
      return {
        ...candidate,
        predicted3Day: pick.predicted3Day ?? candidate.predicted3Day,
        predicted5Day: pick.predicted5Day ?? candidate.predicted5Day,
        predicted8Day: pick.predicted8Day ?? candidate.predicted8Day,
        confidence: pick.finalConviction ? pick.finalConviction * 10 : candidate.confidence,
        narrative: pick.narrative || candidate.narrative,
      };
    }).filter(Boolean) as SpikeCandidate[];

    return {
      topSpikes,
      marketOutlook: grokResult.marketOutlook || opusResult?.marketOutlook || 'Analysis complete.',
      riskWarnings: grokResult.riskWarnings || [],
      sectorAllocations: grokResult.sectorAllocations || [],
      confidenceLevel: grokResult.overallConfidence || 50,
      timestamp: new Date().toISOString(),
    };
  }

  // Fallback: if Grok failed, use Opus Top 20
  if (opusResult?.opusTop20?.length > 0) {
    return buildFromOpus(originalCandidates, opusResult);
  }

  // Ultimate fallback: scoring engine rankings
  return buildFallbackVerdict(originalCandidates, {} as MarketRegime, '', Date.now());
}

function buildFromOpus(
  originalCandidates: SpikeCandidate[],
  opusResult: any
): CouncilVerdict {
  const topSpikes = (opusResult.opusTop20 || []).map((pick: any) => {
    const candidate = originalCandidates.find((c) => c.quote.ticker === pick.ticker);
    if (!candidate) return null;
    return {
      ...candidate,
      predicted3Day: pick.predicted3Day ?? candidate.predicted3Day,
      predicted5Day: pick.predicted5Day ?? candidate.predicted5Day,
      predicted8Day: pick.predicted8Day ?? candidate.predicted8Day,
      confidence: pick.conviction ? pick.conviction * 10 : candidate.confidence,
      narrative: pick.narrative || candidate.narrative,
    };
  }).filter(Boolean) as SpikeCandidate[];

  return {
    topSpikes,
    marketOutlook: opusResult.marketOutlook || 'Analysis complete.',
    riskWarnings: opusResult.portfolioRisks || [],
    sectorAllocations: [],
    confidenceLevel: 50,
    timestamp: new Date().toISOString(),
  };
}

function buildFallbackVerdict(
  candidates: SpikeCandidate[],
  _regime: MarketRegime,
  _date: string,
  _startTime: number
): CouncilVerdict {
  console.warn('[Council] Using fallback — scoring engine rankings only (no LLM review)');
  return {
    topSpikes: candidates.slice(0, 20),
    marketOutlook: 'LLM Council unavailable. Rankings based on scoring engine only.',
    riskWarnings: ['LLM review was not completed — predictions are unvalidated'],
    sectorAllocations: [],
    confidenceLevel: 30,
    timestamp: new Date().toISOString(),
  };
}

// ============================================
// THREE-WAY CONSENSUS MEASUREMENT
// ============================================

function calculateThreeWayConsensus(
  sonnet: any,
  opus: any,
  grok: any
): number {
  // Get ticker sets from each stage
  const sonnetPassed = new Set(
    (sonnet?.shortlist || [])
      .filter((s: any) => s.screenVerdict === 'pass')
      .map((s: any) => s.ticker)
  );

  const opusPicks = new Set(
    (opus?.opusTop20 || []).map((p: any) => p.ticker)
  );

  const grokPicks = new Set(
    (grok?.finalTop20 || []).map((p: any) => p.ticker)
  );

  if (grokPicks.size === 0) return 0;

  // Measure: what % of Grok's final picks were also in both Sonnet AND Opus?
  let threeWayAgree = 0;
  let twoWayAgree = 0;

  for (const ticker of Array.from(grokPicks)) {
    const inSonnet = sonnetPassed.has(ticker);
    const inOpus = opusPicks.has(ticker);
    if (inSonnet && inOpus) threeWayAgree++;
    else if (inSonnet || inOpus) twoWayAgree++;
  }

  // Weighted consensus: 3-way = full credit, 2-way = half credit
  const score = ((threeWayAgree * 1.0 + twoWayAgree * 0.5) / grokPicks.size) * 100;
  return Math.round(score * 10) / 10;
}
