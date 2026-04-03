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

  const report = await prisma.openingBellReport.findUnique({
    where: { id },
    include: {
      picks: { orderBy: { rank: 'asc' } },
    },
  });

  if (!report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  }

  const reportDate = report.date.toISOString().split('T')[0];
  const durationSec = (report.scanDurationMs / 1000).toFixed(1);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Opening Bell Report');

  const colCount = 17;
  const lastCol = String.fromCharCode(64 + colCount); // 'Q'

  // Title row
  sheet.mergeCells(`A1:${lastCol}1`);
  const titleCell = sheet.getCell('A1');
  titleCell.value = `Opening Bell — ${reportDate}`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFB800' } };
  titleCell.alignment = { horizontal: 'center' };

  // Subtitle row
  sheet.mergeCells(`A2:${lastCol}2`);
  const subtitleCell = sheet.getCell('A2');
  subtitleCell.value = `Tickers Scanned: ${report.tickersScanned} | Duration: ${durationSec}s`;
  subtitleCell.font = { size: 11, italic: true };
  subtitleCell.alignment = { horizontal: 'center' };

  // Empty spacer row
  sheet.addRow([]);

  // Headers
  const headers = [
    'Rank', 'Ticker', 'Name', 'Exchange', 'Sector',
    'Price', 'Prev Close', 'Change %', 'Rel. Volume',
    'Score', 'Conviction', 'Intraday Target', 'Key Level',
    'Actual High', 'Actual Close', 'Target Hit?',
  ];

  sheet.addRow(headers);
  const hRow = sheet.getRow(4);
  hRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } };
  hRow.alignment = { horizontal: 'center' };

  // Data rows
  for (const pick of report.picks) {
    sheet.addRow([
      pick.rank,
      pick.ticker,
      pick.name,
      pick.exchange,
      pick.sector || '',
      pick.priceAtScan,
      pick.previousClose,
      pick.changePercent,
      pick.relativeVolume,
      pick.momentumScore,
      pick.conviction,
      pick.intradayTarget,
      pick.keyLevel,
      pick.actualHigh ?? '',
      pick.actualClose ?? '',
      pick.targetHit === null ? '' : pick.targetHit ? 'Yes' : 'No',
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
      'Content-Disposition': `attachment; filename="opening-bell-${reportDate}.xlsx"`,
    },
  });
}
