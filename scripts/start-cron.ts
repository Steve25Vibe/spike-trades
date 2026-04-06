// ============================================
// CRON SCHEDULER — 10:45am AST Daily
// Run with: npx tsx scripts/start-cron.ts
// Or via PM2: pm2 start scripts/start-cron.ts --interpreter tsx
// ============================================

import cron from 'node-cron';
import http from 'node:http';

const TIMEZONE = process.env.CRON_TIMEZONE || 'America/Halifax';
const CRON_HOUR = process.env.ANALYSIS_CRON_HOUR || '10';
const CRON_MINUTE = process.env.ANALYSIS_CRON_MINUTE || '45';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const CRON_SECRET = process.env.SESSION_SECRET || '';

/**
 * Make an HTTP request using Node's http module to avoid undici header timeouts.
 * The council pipeline can take 45-60 minutes, which exceeds undici's default timeout.
 */
function httpRequest(url: string, options: { method: string; headers: Record<string, string>; timeout: number }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: options.method,
        headers: options.headers,
        timeout: options.timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

console.log(`[Cron] Spike Trades scheduler starting...`);
console.log(`[Cron] Scheduled: ${CRON_MINUTE} ${CRON_HOUR} * * 1-5 (${TIMEZONE})`);
console.log(`[Cron] App URL: ${APP_URL}`);

// ── Pre-market Radar — 10:05 AM AST weekdays ──
cron.schedule(
  '5 10 * * 1-5',
  async () => {
    console.log(`[Cron] Triggering Radar scan at ${new Date().toISOString()}`);
    try {
      const res = await httpRequest(`${APP_URL}/api/cron/radar`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CRON_SECRET}`, 'Content-Type': 'application/json' },
        timeout: 360_000, // 6 minutes
      });
      console.log(`[Cron] Radar result: ${res.status} — ${res.body.substring(0, 200)}`);
    } catch (err) {
      console.error(`[Cron] Radar failed:`, err);
    }
  },
  { timezone: TIMEZONE }
);
console.log(`[Cron] Radar: 5 10 * * 1-5 (${TIMEZONE})`);

// Main daily analysis — weekdays at 10:45am AST
cron.schedule(
  `${CRON_MINUTE} ${CRON_HOUR} * * 1-5`,
  async () => {
    console.log(`[Cron] Triggering daily analysis at ${new Date().toISOString()}`);
    try {
      const result = await httpRequest(`${APP_URL}/api/cron`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CRON_SECRET}`,
          'Content-Type': 'application/json',
        },
        timeout: 3_600_000, // 1 hour timeout for full pipeline
      });
      console.log(`[Cron] Analysis result (status ${result.status}):`, result.body);
    } catch (error) {
      console.error(`[Cron] Failed to trigger analysis:`, error);
    }
  },
  { timezone: TIMEZONE }
);

// ── Opening Bell — 10:35 AM AST weekdays ──
cron.schedule(
  '35 10 * * 1-5',
  async () => {
    console.log(`[Cron] ${new Date().toISOString()} — Triggering Opening Bell scan`);
    try {
      const result = await httpRequest(`${APP_URL}/api/cron/opening-bell`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CRON_SECRET}`,
          'Content-Type': 'application/json',
        },
        timeout: 360_000,  // 6 minutes (5 min pipeline + 1 min buffer)
      });
      console.log(`[Cron] Opening Bell result (status ${result.status}):`, result.body);
    } catch (error) {
      console.error(`[Cron] Opening Bell trigger failed:`, error);
    }
  },
  { timezone: TIMEZONE }
);
console.log(`[Cron] Opening Bell scheduled: 10:35 AM ${TIMEZONE} (weekdays)`);

// Accuracy check — weekdays at 4:30pm AST (after market close)
cron.schedule(
  '30 16 * * 1-5',
  async () => {
    console.log(`[Cron] Triggering accuracy check at ${new Date().toISOString()}`);
    try {
      const result = await httpRequest(`${APP_URL}/api/accuracy/check`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CRON_SECRET}`,
        },
        timeout: 300_000, // 5 minute timeout for batch FMP API calls
      });
      console.log(`[Cron] Accuracy check result (status ${result.status}):`, result.body);
    } catch (error) {
      console.error(`[Cron] Accuracy check failed:`, error);
    }
  },
  { timezone: TIMEZONE }
);

// SQLite backfill actuals — weekdays at 4:35pm AST (5 minutes after PostgreSQL backfill)
const councilUrl = process.env.COUNCIL_API_URL || 'http://localhost:8100';
cron.schedule(
  '35 16 * * 1-5',
  async () => {
    console.log(`[Cron] Triggering backfill-actuals at ${new Date().toISOString()}`);
    try {
      const result = await httpRequest(`${councilUrl}/backfill-actuals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 300_000, // 5 minute timeout
      });
      console.log(`[Cron] Backfill-actuals result (status ${result.status}):`, result.body);
    } catch (error) {
      console.error(`[Cron] Backfill-actuals failed:`, error);
    }
  },
  { timezone: TIMEZONE }
);

// Portfolio alerts check — every 15 minutes during market hours
cron.schedule(
  '*/15 9-16 * * 1-5',
  async () => {
    try {
      await httpRequest(`${APP_URL}/api/portfolio/alerts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CRON_SECRET}` },
        timeout: 120_000, // 2 minute timeout for batch quotes
      });
    } catch (error) {
      // Silent fail for frequent checks
    }
  },
  { timezone: TIMEZONE }
);

console.log(`[Cron] All schedules registered. Waiting for triggers...`);

// Keep process alive
process.on('SIGINT', () => {
  console.log('[Cron] Shutting down scheduler...');
  process.exit(0);
});
