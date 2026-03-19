# Spike Trades — Deployment Configuration

## DigitalOcean Droplet

- **IP**: 147.182.150.30
- **SSH Key**: ~/.ssh/digitalocean_saa
- **Domain**: spiketrades.ca
- **Deploy Path**: /opt/spike-trades
- **SSL**: Let's Encrypt certs may exist from previous project (check /etc/letsencrypt)
- **Nginx**: May still be configured from previous project (check /etc/nginx/sites-enabled)

## SSH Access

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30
```

## Deploy Path Structure

```
/opt/spike-trades/
├── .env                          # Real API keys (never committed)
├── canadian_llm_council_brain.py # The LLM Council Brain module
├── docker-compose.yml            # Orchestrates all services
├── Dockerfile                    # Next.js app container
├── src/                          # Next.js application source
├── prisma/                       # Database schema
├── scripts/                      # Cron scheduler, deploy script
└── spike_trades_council.db       # SQLite for council history/roadmap
```

## Required Environment Variables

See .env.example for the full list. Critical keys:
- FMP_API_KEY (Financial Modeling Prep Professional)
- ANTHROPIC_API_KEY (Claude Sonnet + Opus)
- GOOGLE_API_KEY (Gemini 3.1 Pro)
- XAI_API_KEY (SuperGrok Heavy)
- FINNHUB_API_KEY
- RESEND_API_KEY (email alerts)
- DATABASE_URL (PostgreSQL)
- SESSION_SECRET (generate: openssl rand -hex 32)

## Quick Deploy

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30
cd /opt/spike-trades
git pull origin main
docker compose build --no-cache
docker compose up -d
docker compose exec app npx prisma db push
```
