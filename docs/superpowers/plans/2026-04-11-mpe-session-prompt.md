# MPE Implementation — Session Prompt

---

You are implementing the Momentum Persistence Engine (MPE) for Spike Trades — an autonomous AI stock analyst for TSX/TSXV deployed at spiketrades.ca. You handle ALL code changes AND deployment.

## Project Details

- **Working directory:** /Users/coeus/spiketrades.ca/claude-code
- **GitHub repo:** `Steve25Vibe/spike-trades` (private)
- **Framework:** Next.js 15, React 19, Prisma 6, PostgreSQL 16
- **Python council brain:** `canadian_llm_council_brain.py` (FastAPI, SQLite)
- **API server:** `api_server.py` (FastAPI, uvicorn)
- **Server:** root@147.182.150.30 via `ssh -i ~/.ssh/digitalocean_saa`
- **Repo on server:** `/opt/spike-trades`

## Operating Rules — MUST FOLLOW

1. **Always commit and push immediately** after each task
2. **Never run `DELETE FROM <table>` without a WHERE clause**
3. **AST timezone** for all user-facing text
4. Schema deploys via `prisma db push`, NOT migrations
5. No silent data policy changes without explicit user approval
6. **Always refresh server backup** after final deploy

## What You're Building

The Momentum Persistence Engine recognizes when the system has a proven winner (a stock it previously picked that delivered strong actual returns) and ensures it stays in the Top 10 recommendations instead of being rotated out for unproven fresh picks.

**Two phases:**
- **Pre-council injection:** Before the 4 LLM stages run, identify momentum candidates from pick_history, fetch live data, compute 4 signals (ROC-5, ADX, ATR trend, relative strength vs sector), run a re-qualification gate, and inject qualified runners into the universe with a Momentum Data Packet visible to all LLM stages.
- **Post-council re-rank:** After Stage 4 (Grok) produces the Top 10, compute a Momentum Score (0-100), blend it with the spike score (morning 65/35, evening 55/45), and re-rank. Proven runners can displace weak fresh picks. No reserved slots — pure meritocracy.

## Spec and Plan

- **Spec:** `docs/superpowers/specs/2026-04-11-momentum-persistence-engine-design.md`
- **Plan:** `docs/superpowers/plans/2026-04-11-momentum-persistence-engine.md`

Read BOTH files completely before starting. The spec has the full design rationale, signal thresholds, scoring tables, and gate logic. The plan has task-by-task implementation steps with code.

## Task List (9 tasks, execute in order)

| # | Task | Files | Summary |
|---|------|-------|---------|
| 1 | SQLite table + constants | Create `momentum_engine.py` | New module with momentum_candidates table and all config constants |
| 2 | Candidate identification | Modify `momentum_engine.py` | Query pick_history for tickers with strong actual returns |
| 3 | Signal computation | Modify `momentum_engine.py` | ROC-5 from FMP bars, ADX/ATR from council, relative strength vs sector |
| 4 | Gate + scoring | Modify `momentum_engine.py` | Re-qualification gate (core + confirming) and 4-signal momentum score |
| 5 | Data packet + re-rank + audit | Modify `momentum_engine.py` | LLM prompt text, composite score blending, SQLite audit logging |
| 6 | Pre-council integration | Modify `canadian_llm_council_brain.py` | Step 4a in run_council(): identify, fetch, compute, inject |
| 7 | Post-council integration | Modify `canadian_llm_council_brain.py` | Step 14b in run_council(): re-rank, audit log, update result_dict |
| 8 | API + Prisma + TypeScript | Modify `api_server.py`, `prisma/schema.prisma`, `src/lib/scheduling/analyzer.ts` | Pass momentumScore + momentumStatus through the full stack |
| 9 | Version bump v6.2.5 + deploy | Modify `package.json`, SSH deploy | Tag, push, rebuild containers, prisma db push, backup |

## Key Integration Points

**Pre-council insertion point:** In `run_council()` in `canadian_llm_council_brain.py`, between Step 4 (payloads built, ~line 4867) and Step 4b (noise filter, ~line 4872). The new Step 4a goes here.

**Post-council insertion point:** After consensus picks are built but before `record_picks()` is called (~line 5611). The new Step 14b goes here.

**StockDataPayload:** Add `momentum_data_packet: str | None = None` field to the Pydantic model (~line 214).

**LLM prompt injection:** Each stage's prompt builder needs to append `payload.momentum_data_packet` when present. Search for where payload fields are serialized into prompt text.

**_map_to_prisma():** In `api_server.py`, add `momentumScore` and `momentumStatus` to the spike field mapping.

**Prisma Spike model:** `momentumScore Float?` already exists (~line 168). Add `momentumStatus String?` after it.

**buildSpikeData():** In `src/lib/scheduling/analyzer.ts` (~line 266), add `momentumStatus` mapping.

## Scoring Reference (from spec)

**Blend weights:**
```
Morning: Final = (Spike × 0.65) + (Momentum × 0.35)
Evening: Final = (Spike × 0.55) + (Momentum × 0.45)
```

**Re-qualification gate:**
- Core (must both pass): ROC-5 > 0%, ADX > 25
- Confirming (1 can fail = degraded at 60%): ATR not contracting, relative strength vs sector > 0%
- Either core fails OR both confirming fail = disqualified (0%)

**4 signals (each 0-25, total 0-100):**
1. Realized return: +15%→25, +10%→20, +5%→15, +3%→10, >0%→5
2. ROC-5: >10%→25, >5%→20, >2%→15, >0%→10
3. ADX+ATR: >30+expanding→25, >30+flat→20, >30+contracting→12, 25-30+expanding→15, 25-30+other→8
4. Relative strength: >8%→25, >4%→20, >2%→15, >0%→10

## Deploy Steps (Task 9)

```bash
# Version bump locally
sed -i '' 's/"version": "6.1.2"/"version": "6.2.5"/' package.json
git add package.json
git commit -m "chore: bump version to v6.2.5 — Momentum Persistence Engine"
git tag v6.2.5
git push origin main --tags

# Deploy
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && git pull origin main'
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose build --no-cache app cron council 2>&1 | tail -5'
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose run --rm app node node_modules/prisma/build/index.js db push --accept-data-loss 2>&1 | tail -5'
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose up -d app cron council && sleep 10 && docker compose ps --format "{{.Name}}: {{.Status}}"'

# Backup
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'bash -s' << 'REMOTE'
BACKUP_DIR="/root/spiketrades-backup/2026-04-11"
mkdir -p "$BACKUP_DIR"
cd /opt/spike-trades
git bundle create "$BACKUP_DIR/spiketrades-repo.bundle" --all
docker exec spike-trades-db pg_dump -U spiketrades spiketrades > "$BACKUP_DIR/spiketrades-db.sql"
rm -rf "$BACKUP_DIR/council-data/"
docker cp spike-trades-council:/app/data/ "$BACKUP_DIR/council-data/"
ls -lh "$BACKUP_DIR/"
REMOTE
```

## Verification

After deploy, the next council scan (morning 11:15 AM or evening 8:00 PM AST) will run MPE automatically. Check logs:

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'docker logs spike-trades-council 2>&1 | grep "MPE:" | tail -20'
```

Expected: `MPE: Identified N momentum candidates`, `MPE: Re-ranked Top 10`, `MPE: Post-council re-rank complete`.
