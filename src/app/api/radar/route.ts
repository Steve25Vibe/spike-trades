import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dateParam = request.nextUrl.searchParams.get('date');

  try {
    let dateFilter: Date;
    if (dateParam) {
      dateFilter = new Date(dateParam + 'T12:00:00');
    } else {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Halifax' });
      dateFilter = new Date(todayStr + 'T12:00:00');
    }

    const report = await prisma.radarReport.findUnique({
      where: { date: dateFilter },
      include: {
        picks: { orderBy: { rank: 'asc' } },
      },
    });

    if (!report) {
      // Fallback: get most recent report
      const latest = await prisma.radarReport.findFirst({
        orderBy: { date: 'desc' },
        include: {
          picks: { orderBy: { rank: 'asc' } },
        },
      });

      if (!latest) {
        return NextResponse.json({ report: null, picks: [] });
      }
      return NextResponse.json({ report: latest, picks: latest.picks });
    }

    return NextResponse.json({ report, picks: report.picks });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
