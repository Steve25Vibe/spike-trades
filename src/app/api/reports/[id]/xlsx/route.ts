import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';
import ExcelJS from 'exceljs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const report = await prisma.dailyReport.findUnique({
    where: { id },
    include: {
      spikes: { orderBy: { rank: 'asc' } },
    },
  });

  if (!report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Spike Trades Report');

  // Header info
  const reportDate = report.date.toISOString().split('T')[0];
  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = `Spike Trades — Daily Report ${reportDate}`;
  titleCell.font = { bold: true, size: 14 };

  sheet.mergeCells('A2:F2');
  sheet.getCell('A2').value = `Market Regime: ${(report.marketRegime || 'N/A').toUpperCase()} | TSX (XIU): $${report.tsxLevel?.toFixed(2) || 'N/A'}`;
  sheet.getCell('A2').font = { size: 11, italic: true };

  // Column headers
  const headers = [
    'Rank', 'Ticker', 'Name', 'Exchange', 'Sector', 'Price',
    'Spike Score', 'Confidence',
    'Pred 3-Day %', 'Pred 5-Day %', 'Pred 8-Day %',
    'Actual 3-Day %', 'Actual 5-Day %', 'Actual 8-Day %',
    'Volume', 'Avg Volume', 'Market Cap',
    'RSI', 'MACD', 'ADX',
    'Momentum', 'Volume Score', 'Technical', 'Macro', 'Sentiment',
  ];

  const headerRow = sheet.addRow([]);
  sheet.addRow(headers);
  const hRow = sheet.getRow(4);
  hRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } };
  hRow.alignment = { horizontal: 'center' };

  // Data rows
  for (const spike of report.spikes) {
    sheet.addRow([
      spike.rank,
      spike.ticker,
      spike.name,
      spike.exchange,
      spike.sector || '',
      spike.price,
      spike.spikeScore,
      spike.confidence,
      spike.predicted3Day,
      spike.predicted5Day,
      spike.predicted8Day,
      spike.actual3Day ?? '',
      spike.actual5Day ?? '',
      spike.actual8Day ?? '',
      spike.volume,
      spike.avgVolume ?? '',
      spike.marketCap ?? '',
      spike.rsi ?? '',
      spike.macd ?? '',
      spike.adx ?? '',
      spike.momentumScore ?? '',
      spike.volumeScore ?? '',
      spike.technicalScore ?? '',
      spike.macroScore ?? '',
      spike.sentimentScore ?? '',
    ]);
  }

  // Auto-fit column widths
  sheet.columns.forEach((col) => {
    let maxLen = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = cell.value ? cell.value.toString().length : 0;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 2, 30);
  });

  const buffer = await workbook.xlsx.writeBuffer();

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="spike-trades-${reportDate}.xlsx"`,
    },
  });
}
