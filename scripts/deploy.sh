#!/bin/bash
# ============================================
# SPIKE TRADES — DigitalOcean Deployment Script
# Droplet: 147.182.150.30
# Domain:  spiketrades.ca
# Path:    /opt/spike-trades
# ============================================

set -euo pipefail

DOMAIN="spiketrades.ca"
PROJECT_DIR="/opt/spike-trades"
EMAIL="steve@boomerang.energy"

echo "⚡ Spike Trades — Deployment Script"
echo "  Server: 147.182.150.30"
echo "  Domain: $DOMAIN"
echo "  Path:   $PROJECT_DIR"
echo "==================================="

# --- System Setup ---
echo "[1/9] Updating system..."
apt-get update && apt-get upgrade -y
apt-get install -y curl git ufw software-properties-common python3 python3-pip

# --- Docker ---
echo "[2/9] Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi
if ! docker compose version &> /dev/null; then
    apt-get install -y docker-compose-plugin
fi

# --- Firewall ---
echo "[3/9] Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# --- Project Setup ---
echo "[4/9] Setting up project at $PROJECT_DIR..."
mkdir -p $PROJECT_DIR
cd $PROJECT_DIR

if [ -d ".git" ]; then
    git pull origin main
else
    echo ""
    echo "  Repository not found. Clone it first:"
    echo "  git clone https://github.com/Steve25Vibe/spike-trades.git $PROJECT_DIR"
    echo ""
    exit 1
fi

# --- Python dependencies (for council brain) ---
echo "[5/9] Installing Python dependencies..."
pip3 install --break-system-packages pydantic aiohttp python-dotenv 2>/dev/null || \
    pip3 install pydantic aiohttp python-dotenv

# --- Environment ---
echo "[6/9] Setting up environment..."
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo ""
    echo "  ⚠️  Edit .env with your API keys:"
    echo "     nano $PROJECT_DIR/.env"
    echo ""
    echo "  Required keys:"
    echo "    FMP_API_KEY          — Financial Modeling Prep Professional"
    echo "    ANTHROPIC_API_KEY    — Claude Sonnet 4.6 + Opus 4.6"
    echo "    GOOGLE_API_KEY       — Gemini 3.1 Pro"
    echo "    XAI_API_KEY          — SuperGrok Heavy"
    echo "    EODHD_API_KEY        — News + sentiment (EODHD)"
    echo "    RESEND_API_KEY       — Email alerts"
    echo "    SESSION_SECRET       — Run: openssl rand -hex 32"
    echo "    DB_PASSWORD          — Run: openssl rand -hex 16"
    echo ""
    read -p "  Press Enter after editing .env..."
fi

# --- SSL Certificates ---
echo "[7/9] Setting up SSL for $DOMAIN..."

# Check if certs exist from previous project
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "  Found existing SSL certs at /etc/letsencrypt/live/$DOMAIN"
    echo "  Symlinking to project..."
    mkdir -p docker/ssl/live
    ln -sf /etc/letsencrypt/live/$DOMAIN docker/ssl/live/$DOMAIN 2>/dev/null || true
    ln -sf /etc/letsencrypt/archive docker/ssl/archive 2>/dev/null || true
elif [ -d "docker/ssl/live/$DOMAIN" ]; then
    echo "  Found existing SSL certs in docker/ssl/"
else
    echo "  No existing certs found. Requesting new ones..."
    # Stop nginx if running (so certbot can bind to port 80)
    systemctl stop nginx 2>/dev/null || true
    docker stop spike-trades-nginx 2>/dev/null || true

    docker run --rm \
        -v $(pwd)/docker/ssl:/etc/letsencrypt \
        -v $(pwd)/docker/certbot:/var/www/certbot \
        -p 80:80 \
        certbot/certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email $EMAIL \
        -d $DOMAIN \
        -d www.$DOMAIN
fi

# --- Check existing Nginx config ---
echo "[8/9] Checking Nginx configuration..."
if [ -f "/etc/nginx/sites-enabled/$DOMAIN" ] || [ -f "/etc/nginx/sites-enabled/default" ]; then
    echo "  Found existing Nginx config from previous project."
    echo "  Docker Compose will run its own Nginx container on ports 80/443."
    echo "  Stopping system Nginx to avoid port conflicts..."
    systemctl stop nginx 2>/dev/null || true
    systemctl disable nginx 2>/dev/null || true
fi

# --- Build & Deploy ---
echo "[9/9] Building and deploying..."
docker compose build --no-cache
docker compose up -d

# Wait for database to be healthy
echo "  Waiting for database..."
sleep 8
docker compose exec app npx prisma db push

echo ""
echo "============================================"
echo "⚡ SPIKE TRADES — Deployment Complete!"
echo "============================================"
echo ""
echo "  Site:     https://$DOMAIN"
echo "  Password: godmode"
echo "  Server:   147.182.150.30"
echo ""
echo "  Services:"
docker compose ps
echo ""
echo "  Useful commands:"
echo "    docker compose logs -f          # Follow all logs"
echo "    docker compose logs -f app      # Follow app logs only"
echo "    docker compose logs -f cron     # Follow cron/scheduler logs"
echo "    docker compose restart app      # Restart app"
echo "    docker compose down             # Stop everything"
echo ""
echo "  Run council manually:"
echo "    cd $PROJECT_DIR && python3 canadian_llm_council_brain.py"
echo ""
echo "  SSH access:"
echo "    ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30"
echo "============================================"
