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

// Morning scan — weekdays at 11:15am ADT (via scan-morning endpoint)
cron.schedule(
  `${CRON_MINUTE} ${CRON_HOUR} * * 1-5`,
  async () => {
    console.log(`[Cron] Triggering morning scan at ${new Date().toISOString()}`);
    try {
      const result = await httpRequest(`${APP_URL}/api/cron/scan-morning`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CRON_SECRET}`,
          'Content-Type': 'application/json',
        },
        timeout: 3_600_000, // 1 hour timeout for full pipeline
      });
      console.log(`[Cron] Morning scan result (status ${result.status}):`, result.body);
    } catch (error) {
      console.error(`[Cron] Failed to trigger morning scan:`, error);
    }
  },
  { timezone: TIMEZONE }
);

// Evening scan — Sun-Thu at 8:00pm AST (produces next trading day's picks)
cron.schedule(
  '0 20 * * 0-4',
  async () => {
    console.log(`[Cron] Triggering evening scan at ${new Date().toISOString()}`);
    try {
      const result = await httpRequest(`${APP_URL}/api/cron/scan-evening`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CRON_SECRET}`,
          'Content-Type': 'application/json',
        },
        timeout: 3_600_000, // 1 hour timeout for full pipeline
      });
      console.log(`[Cron] Evening scan result (status ${result.status}):`, result.body);
    } catch (error) {
      console.error(`[Cron] Failed to trigger evening scan:`, error);
    }
  },
  { timezone: TIMEZONE }
);
console.log('[Cron] Evening scan: 8:00 PM ADT weekdays');

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

// ── Weekly calibration backtest refresh (Sunday 04:00 ADT / 07:00 UTC) ──
cron.schedule(
  '0 4 * * 0',
  async () => {
    const label = 'calibration-refresh';
    console.log(`[${label}] Triggering weekly calibration backtest refresh`);
    try {
      const result = await httpRequest(`${councilUrl}/calibration-refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 5_400_000, // 90 min timeout
      });
      console.log(`[${label}] Status: ${result.status}, Body: ${result.body}`);
    } catch (err) {
      console.error(`[${label}] Failed:`, err);
    }
  },
  { timezone: TIMEZONE }
);
console.log('[cron] Calibration refresh: Sunday 04:00 ADT');

console.log(`[Cron] All schedules registered. Waiting for triggers...`);

// Keep process alive
process.on('SIGINT', () => {
  console.log('[Cron] Shutting down scheduler...');
  process.exit(0);
});
