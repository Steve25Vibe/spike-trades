import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';
import { getHistoricalPrices } from '@/lib/api/fmp';

// GET /api/spikes/[id]/chart — Historical price bars for portfolio performance chart
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const spike = await prisma.spike.findUnique({
      where: { id },
      select: { ticker: true, id: true },
    });

    if (!spike) {
      return NextResponse.json({ success: false, error: 'Spike not found' }, { status: 404 });
    }

    // Find active portfolio entry for this spike
    const position = await prisma.portfolioEntry.findFirst({
      where: { spikeId: spike.id, status: 'active' },
      select: {
        entryPrice: true,
        entryDate: true,
        target3Day: true,
        target5Day: true,
        target8Day: true,
        stopLoss: true,
      },
    });

    if (!position) {
      return NextResponse.json({ success: false, error: 'No active position' }, { status: 404 });
    }

    // Calculate days from entry to today, plus 5 days of pre-entry context
    const entryMs = new Date(position.entryDate).getTime();
    const daysSinceEntry = Math.ceil((Date.now() - entryMs) / 86_400_000);
    const fetchDays = Math.min(daysSinceEntry + 10, 90); // buffer for weekends + pre-entry

    const bars = await getHistoricalPrices(spike.ticker, fetchDays);

    // Filter to only close prices, include ~5 trading days before entry
    const entryDateStr = new Date(position.entryDate).toISOString().split('T')[0];
    const chartBars = bars.map((b) => ({ date: b.date, close: b.close }));

    // Find the entry date index to include some pre-entry context
    const entryIdx = chartBars.findIndex((b) => b.date >= entryDateStr);
    const startIdx = Math.max(0, entryIdx - 5);
    const trimmedBars = entryIdx >= 0 ? chartBars.slice(startIdx) : chartBars;

    const latestClose = trimmedBars.length > 0 ? trimmedBars[trimmedBars.length - 1].close : position.entryPrice;
    const pnlPercent = ((latestClose - position.entryPrice) / position.entryPrice) * 100;

    return NextResponse.json({
      success: true,
      data: {
        bars: trimmedBars,
        entryPrice: position.entryPrice,
        entryDate: entryDateStr,
        target3Day: position.target3Day,
        target5Day: position.target5Day,
        target8Day: position.target8Day,
        stopLoss: position.stopLoss,
        currentPrice: latestClose,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
      },
    });
  } catch (error) {
    console.error('Chart data fetch error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch chart data' }, { status: 500 });
  }
}
