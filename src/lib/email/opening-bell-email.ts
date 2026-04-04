// ============================================
// Opening Bell Email — Early momentum picks
// ============================================

import prisma from '@/lib/db/prisma';

const FROM_ALERTS = 'no-reply@spiketrades.ca';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://spiketrades.ca';

const UNSUBSCRIBE_FOOTER = `
  <p style="color:#475569;font-size:11px;text-align:center;margin-top:32px;border-top:1px solid #1E3A5F;padding-top:16px">
    <a href="${APP_URL}/settings" style="color:#64748B;text-decoration:underline">Manage email preferences</a>
  </p>`;

export interface Pick {
  rank: number;
  ticker: string;
  name: string;
  priceAtScan: number;
  changePercent: number;
  relativeVolume: number;
  intradayTarget: number;
  conviction: string;
}

/** Send Opening Bell email to all opted-in users */
export async function sendOpeningBellEmail(picks: Pick[], sectorSnapshot?: unknown) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[Email] Opening Bell: RESEND_API_KEY not set, skipping');
    return;
  }

  const users = await prisma.user.findMany({
    where: { emailOpeningBell: true },
    select: { email: true },
  });

  if (users.length === 0) {
    console.log('[Email] Opening Bell: no opted-in users, skipping');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  // Check which picks were flagged by Radar
  const radarTickers = new Set<string>();
  try {
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const radarPicks = await prisma.radarPick.findMany({
      where: { report: { date: todayDate } },
      select: { ticker: true },
    });
    for (const rp of radarPicks) radarTickers.add(rp.ticker);
  } catch { /* radar table may not exist yet */ }

  // Top 3 sectors by average change
  const hotSectors = buildHotSectors(picks, sectorSnapshot);

  const radarBadge = `<span style="display:inline-block;background:#00FF4122;color:#00FF41;border:1px solid #00FF4144;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:bold;margin-left:4px;vertical-align:middle">RADAR</span>`;

  const pickRows = picks.slice(0, 10).map((p) => {
    const changeColor = p.changePercent >= 0 ? '#00FF88' : '#FF3366';
    const convColor = p.conviction === 'high' ? '#00FF88' : p.conviction === 'medium' ? '#FFB800' : '#94A3B8';
    const isRadar = radarTickers.has(p.ticker);
    return `<tr style="border-bottom:1px solid #1E3A5F">
      <td style="padding:10px 12px;color:#FFB800;font-weight:bold">#${p.rank}</td>
      <td style="padding:10px 12px">
        <strong style="color:#E2E8F0">${p.ticker}</strong>${isRadar ? radarBadge : ''}<br>
        <span style="color:#94A3B8;font-size:11px">${p.name}</span>
      </td>
      <td style="padding:10px 12px;color:#E2E8F0;text-align:right">$${p.priceAtScan.toFixed(2)}</td>
      <td style="padding:10px 12px;color:${changeColor};text-align:right;font-weight:bold">${p.changePercent >= 0 ? '+' : ''}${p.changePercent.toFixed(2)}%</td>
      <td style="padding:10px 12px;color:#94A3B8;text-align:right">${p.relativeVolume.toFixed(1)}x</td>
      <td style="padding:10px 12px;color:#00F0FF;text-align:right">$${p.intradayTarget.toFixed(2)}</td>
      <td style="padding:10px 12px;text-align:center">
        <span style="background:${convColor}22;color:${convColor};padding:3px 10px;border-radius:10px;font-size:12px;font-weight:bold;text-transform:uppercase">${p.conviction}</span>
      </td>
    </tr>`;
  }).join('');

  const sectorsHtml = hotSectors.length > 0
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px">
        ${hotSectors.map(({ sector, change }) => {
          const col = change >= 1 ? '#00FF88' : change >= 0 ? '#FFB800' : '#FF3366';
          return `<span style="background:${col}22;color:${col};border:1px solid ${col}44;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:bold">${sector} ${change >= 0 ? '+' : ''}${change.toFixed(1)}%</span>`;
        }).join('')}
      </div>`
    : '';

  const html = `
  <div style="background:#0A1428;padding:40px 20px;font-family:'Inter',system-ui,sans-serif">
    <div style="max-width:700px;margin:0 auto">

      <div style="text-align:center;margin-bottom:32px">
        <h1 style="color:#00F0FF;font-size:26px;margin:0;letter-spacing:2px">SPIKE TRADES</h1>
        <h2 style="color:#FFB800;font-size:20px;margin:8px 0 4px;letter-spacing:1px">Opening Bell — ${today}</h2>
        <p style="color:#94A3B8;margin:0;font-size:13px">${picks.length} momentum picks detected at 9:35 AM EST</p>
      </div>

      ${sectorsHtml}

      <table style="width:100%;border-collapse:collapse;background:#111E33;border:1px solid #1E3A5F;border-radius:12px;overflow:hidden;margin-bottom:24px">
        <thead>
          <tr style="background:#0F1D35">
            <th style="padding:10px 12px;color:#94A3B8;text-align:left;font-size:11px;text-transform:uppercase">Rank</th>
            <th style="padding:10px 12px;color:#94A3B8;text-align:left;font-size:11px;text-transform:uppercase">Ticker</th>
            <th style="padding:10px 12px;color:#94A3B8;text-align:right;font-size:11px;text-transform:uppercase">Price</th>
            <th style="padding:10px 12px;color:#94A3B8;text-align:right;font-size:11px;text-transform:uppercase">Change</th>
            <th style="padding:10px 12px;color:#94A3B8;text-align:right;font-size:11px;text-transform:uppercase">Vol</th>
            <th style="padding:10px 12px;color:#94A3B8;text-align:right;font-size:11px;text-transform:uppercase">Target</th>
            <th style="padding:10px 12px;color:#94A3B8;text-align:center;font-size:11px;text-transform:uppercase">Conv.</th>
          </tr>
        </thead>
        <tbody>
          ${pickRows}
        </tbody>
      </table>

      <div style="text-align:center;margin-top:32px">
        <a href="${APP_URL}/opening-bell" style="display:inline-block;background:linear-gradient(135deg,#FFB800,#FF6B00);color:#0A1428;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px">
          View Full Analysis
        </a>
      </div>

      <p style="color:#64748B;font-size:11px;text-align:center;margin-top:32px;line-height:1.5">
        For educational and informational purposes only. Not financial advice.<br>
        Past performance is no guarantee of future results.<br>
        &copy; ${new Date().getFullYear()} Spike Trades — spiketrades.ca
      </p>
      ${UNSUBSCRIBE_FOOTER}
    </div>
  </div>`;

  const subject = `Opening Bell ${today} — #1: ${picks[0]?.ticker} (+${picks[0]?.changePercent.toFixed(1)}%)`;

  let sent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_ALERTS,
          to: user.email,
          subject,
          html,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[Email] Opening Bell failed for ${user.email}: ${err}`);
        failed++;
      } else {
        sent++;
      }
    } catch (error) {
      console.error(`[Email] Opening Bell error for ${user.email}:`, error);
      failed++;
    }
  }

  console.log(`[Email] Opening Bell: sent=${sent} failed=${failed} date=${today}`);
}

/** Extract top 3 hot sectors from picks or sectorSnapshot */
function buildHotSectors(picks: Pick[], sectorSnapshot?: unknown): { sector: string; change: number }[] {
  // If a sector snapshot is provided and usable, prefer it
  if (sectorSnapshot && typeof sectorSnapshot === 'object' && !Array.isArray(sectorSnapshot)) {
    const snap = sectorSnapshot as Record<string, { changePercent?: number; change?: number }>;
    return Object.entries(snap)
      .map(([sector, v]) => ({ sector, change: v?.changePercent ?? v?.change ?? 0 }))
      .sort((a, b) => b.change - a.change)
      .slice(0, 3);
  }

  // Fall back: aggregate average change by first word of ticker (rough sector proxy)
  // In practice the caller should pass a real sectorSnapshot
  const topPicks = picks.slice(0, 5);
  if (topPicks.length === 0) return [];

  const avg = topPicks.reduce((sum, p) => sum + p.changePercent, 0) / topPicks.length;
  return [{ sector: 'Leaders', change: avg }];
}
