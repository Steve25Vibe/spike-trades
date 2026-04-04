// ============================================
// Radar Email — Pre-market institutional signals
// ============================================

import prisma from '@/lib/db/prisma';

const FROM_ALERTS = 'no-reply@spiketrades.ca';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://spiketrades.ca';

const UNSUBSCRIBE_FOOTER = `
  <p style="color:#475569;font-size:11px;text-align:center;margin-top:32px;border-top:1px solid #1a1a1a;padding-top:16px">
    <a href="${APP_URL}/settings" style="color:#64748B;text-decoration:underline">Manage email preferences</a>
  </p>`;

interface RadarEmailPick {
  rank: number;
  ticker: string;
  name: string;
  smartMoneyScore: number;
  topCatalyst: string;
}

export function renderRadarEmail(picks: RadarEmailPick[], date: string): string {
  const pickRows = picks.map(p => `
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; color: #00FF41; font-weight: bold;">#${p.rank}</td>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; color: #00FF41; font-family: monospace;">${p.ticker}</td>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; color: #ccc;">${p.name}</td>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; text-align: center;">
        <span style="display: inline-block; padding: 2px 8px; border-radius: 12px; background: ${p.smartMoneyScore >= 80 ? '#00FF41' : p.smartMoneyScore >= 60 ? '#FFB800' : '#FF6B6B'}22; color: ${p.smartMoneyScore >= 80 ? '#00FF41' : p.smartMoneyScore >= 60 ? '#FFB800' : '#FF6B6B'}; font-weight: bold;">${p.smartMoneyScore}</span>
      </td>
      <td style="padding: 8px; border-bottom: 1px solid #1a1a1a; color: #888; font-size: 12px;">${p.topCatalyst || '\u2014'}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
  <div style="max-width: 640px; margin: 0 auto; padding: 20px;">
    <div style="text-align: center; padding: 20px 0; border-bottom: 1px solid #1a1a1a;">
      <h1 style="color: #00FF41; font-size: 24px; margin: 0;">Smart Money Radar</h1>
      <p style="color: #666; margin: 8px 0 0;">Pre-Market Signals &mdash; ${date}</p>
    </div>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <thead>
        <tr style="border-bottom: 2px solid #00FF41;">
          <th style="padding: 8px; text-align: left; color: #00FF41; font-size: 11px; text-transform: uppercase;">Rank</th>
          <th style="padding: 8px; text-align: left; color: #00FF41; font-size: 11px; text-transform: uppercase;">Ticker</th>
          <th style="padding: 8px; text-align: left; color: #00FF41; font-size: 11px; text-transform: uppercase;">Name</th>
          <th style="padding: 8px; text-align: center; color: #00FF41; font-size: 11px; text-transform: uppercase;">Score</th>
          <th style="padding: 8px; text-align: left; color: #00FF41; font-size: 11px; text-transform: uppercase;">Top Catalyst</th>
        </tr>
      </thead>
      <tbody>${pickRows}</tbody>
    </table>
    <div style="text-align: center; padding: 20px 0;">
      <a href="${APP_URL}/radar" style="display: inline-block; padding: 10px 24px; background: #00FF41; color: #000; text-decoration: none; border-radius: 6px; font-weight: bold;">View Full Radar &rarr;</a>
    </div>
    <p style="text-align: center; color: #444; font-size: 10px; margin-top: 20px;">For informational purposes only. Not financial advice.</p>
    ${UNSUBSCRIBE_FOOTER}
  </div>
</body>
</html>`;
}

/** Send Radar email to all opted-in users */
export async function sendRadarEmail(picks: RadarEmailPick[], date: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[Email] Radar: RESEND_API_KEY not set, skipping');
    return;
  }

  const optedInUsers = await prisma.user.findMany({
    where: { emailRadar: true },
    select: { email: true },
  });

  if (optedInUsers.length === 0) {
    console.log('[Email] Radar: no opted-in users');
    return;
  }

  if (picks.length === 0) {
    console.log('[Email] Radar: no picks to send');
    return;
  }

  const html = renderRadarEmail(picks, date);
  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);

  for (const user of optedInUsers) {
    try {
      await resend.emails.send({
        from: FROM_ALERTS,
        to: user.email,
        subject: `Smart Money Radar \u2014 ${date} | #1: ${picks[0].ticker} (${picks[0].smartMoneyScore})`,
        html,
      });
      console.log(`[Email] Radar sent to ${user.email}`);
    } catch (error) {
      console.error(`[Email] Radar failed for ${user.email}:`, error);
    }
  }
}
