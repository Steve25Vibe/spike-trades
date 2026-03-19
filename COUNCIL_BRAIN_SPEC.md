# LLM Council Brain — Build Specification

## Instructions for Claude Code

You are Claude 4.6 Opus, an elite full-stack Python architect specializing in modular,
API-first financial AI systems.

### BUILD APPROACH: SESSION-BASED, LOCAL FIRST, TESTED BY EXECUTION

This module is built across **Sessions 1–4** (see `CLAUDE_CODE_BRIEF.md`):
- **Session 1**: Data layer + Pydantic models (no LLM calls)
- **Session 2**: All 4 LLM stage callers (tested individually)
- **Session 3**: Pipeline assembly + fact-checker + consensus (end-to-end test)
- **Session 4**: Persistence + risk engine + roadmap (full output)

Do NOT write the entire file at once. Build class by class within each session,
testing against live APIs before moving to the next class. Write a checkpoint
to `SESSION_TRANSITIONS.md` at the end of each session.

An existing draft file `canadian_llm_council_brain.py` exists in this repo.
**DISCARD IT.** It was written without a runtime. Build fresh from this spec,
validating every class by running it.

### What to Build

A **single, completely isolated, reusable skill module** named
`canadian_llm_council_brain.py`. This module must function as the primary logic brain
for an automated LLM Council and be importable into any larger application (FastAPI,
Airflow, cron, etc.) without affecting or depending on any other code.

The public interface must remain exactly:

```python
class CanadianStockCouncilBrain:
    def __init__(self, anthropic_api_key=None, google_api_key=None, xai_api_key=None,
                 fmp_api_key=None, finnhub_api_key=None)
    async def run_council(self, starting_universe: list[str] | None = None,
                          max_workers: int = 8) -> dict
```

### Testing Protocol

For EVERY class you build:
1. Write the class.
2. Write a small test that calls it with real API data (or real SQLite for persistence classes).
3. Run the test. Read the output.
4. Fix any issues. Re-run until it passes cleanly.
5. Only then move to the next class.

For the LLM stages specifically:
- Start with a SMALL universe (5-10 tickers like "RY.TO", "CNQ.TO", "SHOP.TO", "TD.TO", "ABX.TO").
- Verify the JSON response from each LLM can be parsed into the expected shape.
- Each LLM provider returns a different response format — test and handle each one.
- Only after all 4 stages work individually, chain them together.
- Only after the chain works on 5-10 tickers, test with the full auto-fetched TSX universe.

---

## Additional Requirements (MANDATORY)

- EVERY data fetch from FMP or Finnhub MUST include a precise UTC `as_of` timestamp.
- Add a dedicated `LiveDataFetcher` class that enforces strict freshness thresholds
  (quotes/IV < 5 min, news < 60 min, OHLCV < 24h). Reject stale tickers with `STALE_DATA`.
- All LLM stages receive data ONLY through the LiveDataFetcher.
- Every internal LLM prompt MUST contain the exact grounding instructions +
  Chain-of-Verification mandate.
- Add a final `CouncilFactChecker` stage.
- All outputs use strict Pydantic v2 models with timestamp validators.
- Comprehensive logging of timestamps and rejections.

---

## New High-Impact Improvements (MANDATORY)

- **Canadian Macro Regime Filter** using FMP commodity/economic calendar/forex data
  (oil, gold, CAD, BoC expectations). Apply regime adjustment to scores.
- **Early Liquidity & Tradability Filter** (min ADV $5M CAD, price > $1).
- **RiskPortfolioEngine** class for dynamic volatility-adjusted position sizing
  (IV/ATR based, 1-2% risk per name, total heat cap) + suggested allocation table.
- **Minimum cross-council consensus threshold** (≥3 LLMs) + conviction tiering
  (High/Medium/Low).
- **Historical Noise Reduction**: Add `HistoricalPerformanceAnalyzer` class using
  built-in SQLite. Auto-track past picks + realized returns, apply Historical Edge
  Multiplier, hard noise filter (<53% directional accuracy dropped).
- **Perpetual Portfolio Compounding Roadmap**: Add `CompoundingRoadmapEngine` class
  using built-in SQLite.
  - Maintains persistent portfolio state across daily runs.
  - Generates a **daily-updated rolling 10-trading-day roadmap** (≈2 weeks).
  - SuperGrok Heavy stage MUST STILL produce the original explicit 3-day, 5-day,
    and 8-day probabilistic forecasts (these remain the core high-signal output
    and are never replaced).
  - The roadmap uses those exact 3/5/8-day forecasts as its foundation to create
    sequenced trade plans: current holdings, planned entries/pyramiding, profit-taking,
    rotations/exits.
  - Projects conservative compounded growth path (expectancy-based, with confidence bands).
  - Update final output JSON to include full roadmap section + projected portfolio
    value path.

---

## 4-Stage Council Pipeline

Canadian .TO stocks only. FMP + Finnhub data sources only.

1. **Claude Sonnet 4.6** → screens down to Top 100
2. **Gemini 3.1 Pro** → narrows to Top 80
3. **Claude Opus 4.6** → narrows to Top 40
4. **SuperGrok Heavy** (via xAI API) → final quantitative synthesis, narrows to
   Top 20 hot pick spikes with explicit probabilistic forecasts for 3-day, 5-day,
   and 8-day horizons:
   - direction probability
   - most-likely % move
   - 68% price range
   - clarity-decay note using √time

---

## 100-Point Rubric (identical for every stage)

- Technical Momentum & Confluence — 30 pts
- Sentiment & Catalysts (news + social) — 25 pts
- Options IV / Volatility Edge (or proxy if thin) — 20 pts
- Risk/Reward Clarity + Edge Decay — 15 pts
- Overall Short-Term Conviction — 10 pts

---

## API Clients (latest as of March 2026)

- **Anthropic SDK** for Sonnet 4.6 and Opus 4.6
- **Google Generative AI SDK** for Gemini 3.1 Pro (`model="gemini-3.1-pro"`)
- **OpenAI-compatible client** for xAI (`base_url="https://api.x.ai/v1"`,
  `model="grok-3"` or equivalent)
- **FMP Python package** + **Finnhub Python SDK**
- `asyncio` + `aiohttp` for parallel fetches

Include full, ready-to-use system prompts for all four stages (embedded string
constants) with the mandatory grounding + Chain-of-Verification text injected.

---

## Required Internal Classes

- `LiveDataFetcher` (async, parallel, freshness validation)
- `CouncilFactChecker` (final validation)
- `RiskPortfolioEngine`
- `HistoricalPerformanceAnalyzer`
- `CompoundingRoadmapEngine` (with SQLite persistence for perpetual portfolio state)

## Required Pydantic v2 Models

- `StockDataPayload`
- `StageOutput`
- `FinalHotPick`
- `DailyRoadmap`

---

## Integration Context

This module will be integrated into an existing Next.js 15 application.
The integration path (for Claude Code to implement after the brain works):

1. Run the brain as a FastAPI microservice OR subprocess.
2. The brain's JSON output maps to the existing Prisma schema:
   - `DailyReport` — date, regime, macro context
   - `Spike` — one row per Top 20 pick (scores, predictions, narrative, technicals)
   - `CouncilLog` — full audit trail of all 4 stages
3. The frontend already renders spikes from the database — no frontend changes needed
   once the data flows correctly.

---

## Local Development Setup

Build and test locally BEFORE deploying. See `CLAUDE_CODE_BRIEF.md` Phase 1.

```bash
# Install dependencies locally
pip3 install pydantic aiohttp python-dotenv

# Create .env with your API keys (copy from .env.example)
cp .env.example .env
# Edit .env with real keys

# Run the module
python3 canadian_llm_council_brain.py
```

## Deployment Target (Phase 3 — after local testing passes)

- **Server**: 147.182.150.30
- **SSH**: `ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30`
- **Path**: /opt/spike-trades
- **Python**: 3.10+ available on server
- **Install deps**: `pip3 install pydantic aiohttp python-dotenv`

---

## Example Usage (include at bottom of file)

```python
# Loads .env, runs daily council, outputs JSON
if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    import asyncio, json
    brain = CanadianStockCouncilBrain()
    result = asyncio.run(brain.run_council())
    print(json.dumps(result, indent=2, default=str))
```

Include cron/Airflow integration comments:
```
# Cron (10:45 AM AST weekdays):
#   45 10 * * 1-5 cd /opt/spike-trades && python3 canadian_llm_council_brain.py
```

Full type hints, docstrings, and error handling throughout.
