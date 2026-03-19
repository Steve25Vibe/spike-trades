// ============================================
// CRON SCHEDULER — 10:45am AST Daily
// Run with: npx tsx scripts/start-cron.ts
// Or via PM2: pm2 start scripts/start-cron.ts --interpreter tsx
// ============================================

import cron from 'node-cron';

const TIMEZONE = process.env.CRON_TIMEZONE || 'America/Halifax';
const CRON_HOUR = process.env.ANALYSIS_CRON_HOUR || '10';
const CRON_MINUTE = process.env.ANALYSIS_CRON_MINUTE || '45';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const CRON_SECRET = process.env.SESSION_SECRET || '';

console.log(`[Cron] Spike Trades scheduler starting...`);
console.log(`[Cron] Scheduled: ${CRON_MINUTE} ${CRON_HOUR} * * 1-5 (${TIMEZONE})`);
console.log(`[Cron] App URL: ${APP_URL}`);

// Main daily analysis — weekdays at 10:45am AST
cron.schedule(
  `${CRON_MINUTE} ${CRON_HOUR} * * 1-5`,
  async () => {
    console.log(`[Cron] Triggering daily analysis at ${new Date().toISOString()}`);
    try {
      const response = await fetch(`${APP_URL}/api/cron`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CRON_SECRET}`,
          'Content-Type': 'application/json',
        },
      });
      const result = await response.json();
      console.log(`[Cron] Analysis result:`, result);
    } catch (error) {
      console.error(`[Cron] Failed to trigger analysis:`, error);
    }
  },
  { timezone: TIMEZONE }
);

// Accuracy check — weekdays at 4:30pm AST (after market close)
cron.schedule(
  '30 16 * * 1-5',
  async () => {
    console.log(`[Cron] Triggering accuracy check at ${new Date().toISOString()}`);
    try {
      const response = await fetch(`${APP_URL}/api/accuracy/check`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CRON_SECRET}`,
        },
      });
      const result = await response.json();
      console.log(`[Cron] Accuracy check result:`, result);
    } catch (error) {
      console.error(`[Cron] Accuracy check failed:`, error);
    }
  },
  { timezone: TIMEZONE }
);

// Portfolio alerts check — every 15 minutes during market hours
cron.schedule(
  '*/15 9-16 * * 1-5',
  async () => {
    try {
      await fetch(`${APP_URL}/api/portfolio/alerts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CRON_SECRET}` },
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
