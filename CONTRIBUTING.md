# Contributing to Spike Trades

## Getting Started

1. Clone the repo
2. Copy `.env.example` to `.env` and fill in your API keys
3. `npm install`
4. `npx prisma db push`
5. `npm run dev`

## Architecture

- `src/lib/api/` — Data source clients (FMP, Polygon, Finnhub)
- `src/lib/scoring/` — Spike Score engine
- `src/lib/council/` — LLM Council protocol
- `src/lib/email/` — Resend email + .ics calendar
- `src/lib/scheduling/` — Analysis orchestrator
- `src/app/api/` — Next.js API routes
- `src/app/` — Pages (dashboard, portfolio, accuracy, reports)
- `src/components/` — React components

## Key Decisions

- **No stale data**: All market data must be real-time (< 60 seconds old)
- **Fail gracefully**: If any API fails, use fallbacks, never hallucinate
- **Max 2% risk per position**: Kelly-inspired fractional sizing
- **Legal compliance**: Every page includes the legal disclaimer footer
