import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/opening-bell — Get today's (or ?date=X) Opening Bell report with picks
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const dateStr = searchParams.get('date');

  // If no date param, use today in Halifax timezone
  let targetDate: Date;
  if (dateStr) {
    targetDate = new Date(dateStr);
  } else {
    const halifaxDate = new Date(
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Halifax' })
    );
    targetDate = halifaxDate;
  }

  try {
    // Try exact date first
    let report = await prisma.openingBellReport.findUnique({
      where: { date: targetDate },
      include: {
        picks: {
          orderBy: { rank: 'asc' },
        },
      },
    });

    // If no report for today and no specific date was requested, fall back to most recent
    if (!report && !dateStr) {
      report = await prisma.openingBellReport.findFirst({
        where: { date: { lte: targetDate } },
        orderBy: { date: 'desc' },
        include: {
          picks: {
            orderBy: { rank: 'asc' },
          },
        },
      });
    }

    if (!report) {
      return NextResponse.json({
        success: true,
        data: null,
        message: 'No Opening Bell report found',
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        report: {
          id: report.id,
          date: report.date.toISOString().split('T')[0],
          generatedAt: report.generatedAt.toISOString(),
          sectorSnapshot: report.sectorSnapshot,
          tickersScanned: report.tickersScanned,
          scanDurationMs: report.scanDurationMs,
        },
        picks: report.picks.map((p) => ({
          id: p.id,
          rank: p.rank,
          ticker: p.ticker,
          name: p.name,
          sector: p.sector,
          exchange: p.exchange,
          priceAtScan: p.priceAtScan,
          previousClose: p.previousClose,
          changePercent: p.changePercent,
          relativeVolume: p.relativeVolume,
          sectorMomentum: p.sectorMomentum,
          momentumScore: p.momentumScore,
          intradayTarget: p.intradayTarget,
          keyLevel: p.keyLevel,
          conviction: p.conviction,
          rationale: p.rationale,
          actualHigh: p.actualHigh,
          actualClose: p.actualClose,
          targetHit: p.targetHit,
          keyLevelBroken: p.keyLevelBroken,
          tokenUsage: p.tokenUsage,
        })),
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching Opening Bell report:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch Opening Bell report' },
      { status: 500 }
    );
  }
}
