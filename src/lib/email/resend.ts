// ============================================
// Email System — Resend + .ics Calendar Attachments
// ============================================

import { Resend } from 'resend';
import ical, { ICalCalendarMethod, ICalAlarmType } from 'ical-generator';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM || 'alerts@spiketrades.ca';
const TO = process.env.EMAIL_TO || 'steve@boomerang.energy';

/** Send daily spike summary email */
export async function sendDailySummary(data: {
  date: string;
  topSpikes: {
    rank: number;
    ticker: string;
    name: string;
    spikeScore: number;
    predicted3Day: number;
    predicted5Day: number;
    predicted8Day: number;
    narrative: string;
  }[];
  marketRegime: string;
  tsxLevel: number;
  tsxChange: number;
}) {
  const { date, topSpikes, marketRegime, tsxLevel, tsxChange } = data;

  const spikeRows = topSpikes.slice(0, 20).map((s) =>
    `<tr style="border-bottom:1px solid #1E3A5F">
      <td style="padding:12px;color:#00F0FF;font-weight:bold">#${s.rank}</td>
      <td style="padding:12px">
        <strong style="color:#E2E8F0">${s.ticker}</strong><br>
        <span style="color:#94A3B8;font-size:12px">${s.name}</span>
      </td>
      <td style="padding:12px;text-align:center">
        <span style="background:${s.spikeScore >= 70 ? '#00FF88' : s.spikeScore >= 50 ? '#00F0FF' : '#FFB800'}22;color:${s.spikeScore >= 70 ? '#00FF88' : s.spikeScore >= 50 ? '#00F0FF' : '#FFB800'};padding:4px 12px;border-radius:12px;font-weight:bold">${s.spikeScore.toFixed(1)}</span>
      </td>
      <td style="padding:12px;color:#00FF88;text-align:center">+${s.predicted3Day.toFixed(1)}%</td>
      <td style="padding:12px;color:#00F0FF;text-align:center">+${s.predicted5Day.toFixed(1)}%</td>
      <td style="padding:12px;color:#A855F7;text-align:center">+${s.predicted8Day.toFixed(1)}%</td>
    </tr>`
  ).join('');

  const html = `
  <div style="background:#0A1428;padding:40px 20px;font-family:'Inter',system-ui,sans-serif">
    <div style="max-width:700px;margin:0 auto">
      <div style="text-align:center;margin-bottom:32px">
        <h1 style="color:#00F0FF;font-size:28px;margin:0;letter-spacing:2px">⚡ SPIKE TRADES</h1>
        <p style="color:#94A3B8;margin:8px 0 0">Today's Spikes — ${date}</p>
      </div>

      <div style="background:#111E33;border:1px solid #1E3A5F;border-radius:12px;padding:20px;margin-bottom:24px">
        <div style="display:flex;justify-content:space-between;color:#94A3B8;font-size:14px">
          <span>Market: <strong style="color:${marketRegime === 'bull' ? '#00FF88' : marketRegime === 'bear' ? '#FF3366' : '#FFB800'}">${marketRegime.toUpperCase()}</strong></span>
          <span>TSX: <strong style="color:#E2E8F0">${tsxLevel.toFixed(0)}</strong> <span style="color:${tsxChange >= 0 ? '#00FF88' : '#FF3366'}">${tsxChange >= 0 ? '+' : ''}${tsxChange.toFixed(2)}%</span></span>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;background:#111E33;border:1px solid #1E3A5F;border-radius:12px;overflow:hidden">
        <thead>
          <tr style="background:#0F1D35">
            <th style="padding:12px;color:#94A3B8;text-align:left;font-size:12px;text-transform:uppercase">#</th>
            <th style="padding:12px;color:#94A3B8;text-align:left;font-size:12px;text-transform:uppercase">Ticker</th>
            <th style="padding:12px;color:#94A3B8;text-align:center;font-size:12px;text-transform:uppercase">Score</th>
            <th style="padding:12px;color:#94A3B8;text-align:center;font-size:12px;text-transform:uppercase">3D</th>
            <th style="padding:12px;color:#94A3B8;text-align:center;font-size:12px;text-transform:uppercase">5D</th>
            <th style="padding:12px;color:#94A3B8;text-align:center;font-size:12px;text-transform:uppercase">8D</th>
          </tr>
        </thead>
        <tbody>
          ${spikeRows}
        </tbody>
      </table>

      <div style="text-align:center;margin-top:32px">
        <a href="https://spiketrades.ca/dashboard" style="display:inline-block;background:linear-gradient(135deg,#00F0FF,#A855F7);color:#0A1428;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px">
          View Full Analysis →
        </a>
      </div>

      <p style="color:#64748B;font-size:11px;text-align:center;margin-top:32px;line-height:1.5">
        For educational and informational purposes only. Not financial advice.<br>
        Past performance is no guarantee of future results.<br>
        © ${new Date().getFullYear()} Spike Trades — spiketrades.ca
      </p>
    </div>
  </div>`;

  try {
    await resend.emails.send({
      from: FROM,
      to: TO,
      subject: `⚡ Today's Spikes — ${date} | #1: ${topSpikes[0]?.ticker} (${topSpikes[0]?.spikeScore.toFixed(0)})`,
      html,
    });
    console.log(`[Email] Daily summary sent for ${date}`);
  } catch (error) {
    console.error('[Email] Failed to send daily summary:', error);
  }
}

/** Generate .ics calendar event for sell reminder */
export function generateSellReminder(data: {
  ticker: string;
  targetDate: Date;
  targetPrice: number;
  entryPrice: number;
  horizon: '3-day' | '5-day' | '8-day';
}): string {
  const calendar = ical({
    method: ICalCalendarMethod.REQUEST,
    name: 'Spike Trades Sell Reminder',
  });

  const event = calendar.createEvent({
    start: data.targetDate,
    end: new Date(data.targetDate.getTime() + 60 * 60 * 1000), // 1 hour
    summary: `⚡ SELL ${data.ticker} — ${data.horizon} Target`,
    description: `Spike Trades ${data.horizon} sell reminder.\n\nEntry: $${data.entryPrice.toFixed(2)}\nTarget: $${data.targetPrice.toFixed(2)} (+${(((data.targetPrice - data.entryPrice) / data.entryPrice) * 100).toFixed(1)}%)\n\nReview your position and consider taking profits.\n\nspiketrades.ca/portfolio`,
    url: 'https://spiketrades.ca/portfolio',
  });

  event.createAlarm({
    type: ICalAlarmType.display,
    triggerBefore: 30 * 60, // 30 min before
    description: `Sell reminder for ${data.ticker}`,
  });

  return calendar.toString();
}

/** Send sell reminder email with .ics attachment */
export async function sendSellReminder(data: {
  ticker: string;
  name: string;
  targetDate: Date;
  targetPrice: number;
  entryPrice: number;
  currentPrice: number;
  horizon: '3-day' | '5-day' | '8-day';
}) {
  const icsContent = generateSellReminder(data);
  const pnlPct = ((data.currentPrice - data.entryPrice) / data.entryPrice * 100).toFixed(1);
  const isProfit = data.currentPrice >= data.entryPrice;

  try {
    await resend.emails.send({
      from: FROM,
      to: TO,
      subject: `⚡ ${data.horizon.toUpperCase()} Sell Reminder: ${data.ticker} (${isProfit ? '+' : ''}${pnlPct}%)`,
      html: `
        <div style="background:#0A1428;padding:40px;font-family:'Inter',sans-serif">
          <div style="max-width:500px;margin:0 auto;background:#111E33;border:1px solid #1E3A5F;border-radius:12px;padding:32px">
            <h2 style="color:#00F0FF;margin:0 0 20px">⚡ Sell Reminder</h2>
            <h3 style="color:#E2E8F0;margin:0 0 4px">${data.ticker} — ${data.name}</h3>
            <p style="color:#94A3B8;margin:0 0 20px">Your ${data.horizon} target window has arrived.</p>
            <table style="width:100%;color:#E2E8F0;font-size:14px">
              <tr><td style="padding:8px 0;color:#94A3B8">Entry Price</td><td style="text-align:right">$${data.entryPrice.toFixed(2)}</td></tr>
              <tr><td style="padding:8px 0;color:#94A3B8">Current Price</td><td style="text-align:right;color:${isProfit ? '#00FF88' : '#FF3366'}">$${data.currentPrice.toFixed(2)}</td></tr>
              <tr><td style="padding:8px 0;color:#94A3B8">Target Price</td><td style="text-align:right">$${data.targetPrice.toFixed(2)}</td></tr>
              <tr><td style="padding:8px 0;color:#94A3B8">P&L</td><td style="text-align:right;color:${isProfit ? '#00FF88' : '#FF3366'};font-weight:bold">${isProfit ? '+' : ''}${pnlPct}%</td></tr>
            </table>
            <div style="text-align:center;margin-top:24px">
              <a href="https://spiketrades.ca/portfolio" style="display:inline-block;background:linear-gradient(135deg,#00F0FF,#A855F7);color:#0A1428;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold">Review Position</a>
            </div>
          </div>
        </div>
      `,
      attachments: [{
        filename: `sell-reminder-${data.ticker}-${data.horizon}.ics`,
        content: Buffer.from(icsContent).toString('base64'),
        contentType: 'text/calendar',
      }],
    });
    console.log(`[Email] Sell reminder sent for ${data.ticker} (${data.horizon})`);
  } catch (error) {
    console.error(`[Email] Failed to send sell reminder for ${data.ticker}:`, error);
  }
}

/** Send rich council-generated HTML email (from Python renderer) */
export async function sendCouncilEmail(data: {
  date: string;
  html: string;
  topTicker: string;
  topScore: number;
}) {
  try {
    await resend.emails.send({
      from: FROM,
      to: TO,
      subject: `⚡ Today's Spikes — ${data.date} | #1: ${data.topTicker} (${data.topScore.toFixed(0)})`,
      html: data.html,
    });
    console.log(`[Email] Council email sent for ${data.date}`);
  } catch (error) {
    console.error('[Email] Failed to send council email:', error);
    throw error; // Let caller fall back to simple email
  }
}

/** Send deviation alert */
export async function sendDeviationAlert(data: {
  ticker: string;
  name: string;
  entryPrice: number;
  currentPrice: number;
  deviationPct: number;
}) {
  try {
    await resend.emails.send({
      from: FROM,
      to: TO,
      subject: `🚨 DEVIATION ALERT: ${data.ticker} — ${data.deviationPct > 0 ? '+' : ''}${data.deviationPct.toFixed(1)}% vs prediction`,
      html: `
        <div style="background:#0A1428;padding:40px;font-family:'Inter',sans-serif">
          <div style="max-width:500px;margin:0 auto;background:#1A0A2E;border:2px solid #FF3366;border-radius:12px;padding:32px">
            <h2 style="color:#FF3366;margin:0 0 16px">🚨 Deviation Alert</h2>
            <p style="color:#E2E8F0;margin:0 0 20px">${data.ticker} (${data.name}) has moved ${Math.abs(data.deviationPct).toFixed(1)}% against the predicted direction.</p>
            <table style="width:100%;color:#E2E8F0;font-size:14px">
              <tr><td style="padding:8px 0;color:#94A3B8">Entry</td><td style="text-align:right">$${data.entryPrice.toFixed(2)}</td></tr>
              <tr><td style="padding:8px 0;color:#94A3B8">Current</td><td style="text-align:right;color:#FF3366">$${data.currentPrice.toFixed(2)}</td></tr>
              <tr><td style="padding:8px 0;color:#94A3B8">Deviation</td><td style="text-align:right;color:#FF3366;font-weight:bold">${data.deviationPct > 0 ? '+' : ''}${data.deviationPct.toFixed(1)}%</td></tr>
            </table>
            <p style="color:#FFB800;font-size:13px;margin-top:20px">Consider reviewing this position and your stop-loss levels.</p>
          </div>
        </div>
      `,
    });
  } catch (error) {
    console.error(`[Email] Deviation alert failed for ${data.ticker}:`, error);
  }
}
