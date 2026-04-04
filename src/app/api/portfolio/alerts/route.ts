import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getBatchQuotes } from '@/lib/api/fmp';
import { sendSellReminder, sendDeviationAlert } from '@/lib/email/resend';
import { countTradingDays, addTradingDays } from '@/lib/utils';

// POST /api/portfolio/alerts — Polled every 15 min during market hours
// Checks every active position for target hits, sell-reminder windows, and deviations
// Sends alerts to the position owner's email
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.SESSION_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const activePositions = await prisma.portfolioEntry.findMany({
      where: { status: 'active' },
      include: {
        spike: true,
        portfolio: {
          include: {
            user: { select: { email: true, emailSellReminders: true, emailDeviationAlerts: true } },
          },
        },
      },
    });

    if (activePositions.length === 0) {
      return NextResponse.json({ success: true, checked: 0, alerts: 0 });
    }

    // Fetch live prices for all active tickers
    const tickers = Array.from(new Set(activePositions.map((p) => p.ticker)));
    const quotes = await getBatchQuotes(tickers);
    const priceMap = new Map(quotes.map((q) => [q.ticker, q.price]));

    let alertsSent = 0;

    for (const position of activePositions) {
      const currentPrice = priceMap.get(position.ticker);
      if (!currentPrice) continue;

      // Get the owner's email and preferences
      const ownerEmail = position.portfolio?.user?.email;
      const wantsSellReminders = position.portfolio?.user?.emailSellReminders ?? true;
      const wantsDeviationAlerts = position.portfolio?.user?.emailDeviationAlerts ?? true;

      if (!ownerEmail) continue;

      const tradingDaysSinceEntry = countTradingDays(
        new Date(position.entryDate), new Date()
      );
      const pricePct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

      // ---- 1. Sell Reminders (time-based + price-hit) ----

      // 3-Day sell reminder
      if (!position.alertSent3Day && position.target3Day) {
        const shouldAlert =
          tradingDaysSinceEntry >= 3 || currentPrice >= position.target3Day;

        if (shouldAlert) {
          if (wantsSellReminders) {
            await sendSellReminder({
              to: ownerEmail,
              ticker: position.ticker,
              name: position.name,
              targetDate: addTradingDays(new Date(position.entryDate), 3),
              targetPrice: position.target3Day,
              entryPrice: position.entryPrice,
              currentPrice,
              horizon: '3-day',
            });
          }
          await prisma.portfolioEntry.update({
            where: { id: position.id },
            data: { alertSent3Day: true },
          });
          alertsSent++;
        }
      }

      // 5-Day sell reminder
      if (!position.alertSent5Day && position.target5Day) {
        const shouldAlert =
          tradingDaysSinceEntry >= 5 || currentPrice >= position.target5Day;

        if (shouldAlert) {
          if (wantsSellReminders) {
            await sendSellReminder({
              to: ownerEmail,
              ticker: position.ticker,
              name: position.name,
              targetDate: addTradingDays(new Date(position.entryDate), 5),
              targetPrice: position.target5Day,
              entryPrice: position.entryPrice,
              currentPrice,
              horizon: '5-day',
            });
          }
          await prisma.portfolioEntry.update({
            where: { id: position.id },
            data: { alertSent5Day: true },
          });
          alertsSent++;
        }
      }

      // 8-Day sell reminder
      if (!position.alertSent8Day && position.target8Day) {
        const shouldAlert =
          tradingDaysSinceEntry >= 8 || currentPrice >= position.target8Day;

        if (shouldAlert) {
          if (wantsSellReminders) {
            await sendSellReminder({
              to: ownerEmail,
              ticker: position.ticker,
              name: position.name,
              targetDate: addTradingDays(new Date(position.entryDate), 8),
              targetPrice: position.target8Day,
              entryPrice: position.entryPrice,
              currentPrice,
              horizon: '8-day',
            });
          }
          await prisma.portfolioEntry.update({
            where: { id: position.id },
            data: { alertSent8Day: true },
          });
          alertsSent++;
        }
      }

      // ---- 2. Deviation Alerts ----
      if (!position.deviationAlert && pricePct <= -1) {
        if (wantsDeviationAlerts) {
          await sendDeviationAlert({
            to: ownerEmail,
            ticker: position.ticker,
            name: position.name,
            entryPrice: position.entryPrice,
            currentPrice,
            deviationPct: pricePct,
          });
        }
        await prisma.portfolioEntry.update({
          where: { id: position.id },
          data: { deviationAlert: true },
        });
        alertsSent++;
      }

      // ---- 3. Auto-close if stop-loss breached ----
      if (position.stopLoss && currentPrice <= position.stopLoss) {
        const realizedPnl = (currentPrice - position.entryPrice) * position.shares;
        const realizedPnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        await prisma.portfolioEntry.update({
          where: { id: position.id },
          data: {
            status: 'stopped',
            exitPrice: currentPrice,
            exitDate: new Date(),
            exitReason: 'stop_loss',
            realizedPnl,
            realizedPnlPct,
          },
        });

        if (!position.deviationAlert && wantsDeviationAlerts) {
          await sendDeviationAlert({
            to: ownerEmail,
            ticker: position.ticker,
            name: position.name,
            entryPrice: position.entryPrice,
            currentPrice,
            deviationPct: realizedPnlPct,
          });
        }
        alertsSent++;
      }
    }

    console.log(`[Alerts] Checked ${activePositions.length} positions, sent ${alertsSent} alerts`);

    return NextResponse.json({
      success: true,
      checked: activePositions.length,
      alerts: alertsSent,
    });
  } catch (error) {
    console.error('[Alerts] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
