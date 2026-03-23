import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

// GET /api/admin/analytics — Stage performance + accuracy data
export async function GET(request: NextRequest) {
  const isExport = request.nextUrl.searchParams.get('export') === 'xlsx';

  try {
    // Fetch stage analytics from Python FastAPI
    const res = await fetch(`${COUNCIL_API_URL}/stage-analytics`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `Python API returned ${res.status}` },
        { status: 502 }
      );
    }

    const analytics = await res.json();

    // If XLSX export requested, generate spreadsheet
    if (isExport) {
      return generateXlsx(analytics);
    }

    return NextResponse.json({ success: true, data: analytics });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

async function generateXlsx(analytics: {
  summary: Record<string, unknown>;
  stages: Record<string, unknown>[];
  score_buckets: Record<string, unknown>[];
  daily: Record<string, unknown>[];
  pick_detail: Record<string, unknown>[];
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Spike Trades Analytics';

  // ── Sheet 1: Stage Performance ──
  const stageSheet = workbook.addWorksheet('Stage Performance');
  stageSheet.mergeCells('A1:H1');
  const title1 = stageSheet.getCell('A1');
  title1.value = 'LLM Stage Performance';
  title1.font = { bold: true, size: 14 };

  stageSheet.addRow([]);
  stageSheet.addRow([
    'Stage', 'Model', 'Picks Scored', 'Avg Score', 'Min Score', 'Max Score',
    'In Top 20', '3d Hit Rate', '5d Hit Rate', '8d Hit Rate', 'Bias',
  ]);
  const headerRow1 = stageSheet.getRow(3);
  headerRow1.font = { bold: true };
  headerRow1.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
    cell.font = { bold: true, color: { argb: 'FF00CCFF' } };
  });

  for (const s of analytics.stages) {
    const stage = s as Record<string, unknown>;
    stageSheet.addRow([
      stage.stage, stage.model, stage.total_picks_scored, stage.avg_score,
      stage.min_score, stage.max_score, stage.picks_in_top20,
      stage.hit_rate_3d != null ? `${((stage.hit_rate_3d as number) * 100).toFixed(1)}%` : '—',
      stage.hit_rate_5d != null ? `${((stage.hit_rate_5d as number) * 100).toFixed(1)}%` : '—',
      stage.hit_rate_8d != null ? `${((stage.hit_rate_8d as number) * 100).toFixed(1)}%` : '—',
      stage.bias != null ? `${(stage.bias as number).toFixed(2)}%` : '—',
    ]);
  }

  // Score buckets section
  stageSheet.addRow([]);
  stageSheet.addRow([]);
  const bucketTitleRow = stageSheet.addRow(['Score vs Outcome']);
  bucketTitleRow.font = { bold: true, size: 12 };
  stageSheet.addRow(['Score Bucket', 'Picks', 'Avg Actual Return', 'Hit Rate']);
  const bucketHeader = stageSheet.getRow(stageSheet.rowCount);
  bucketHeader.font = { bold: true };

  for (const b of analytics.score_buckets) {
    const bucket = b as Record<string, unknown>;
    stageSheet.addRow([
      bucket.bucket, bucket.picks,
      bucket.avg_actual_return != null ? `${(bucket.avg_actual_return as number).toFixed(2)}%` : '—',
      bucket.hit_rate != null ? `${((bucket.hit_rate as number) * 100).toFixed(1)}%` : '—',
    ]);
  }

  stageSheet.columns.forEach((col) => { col.width = 16; });

  // ── Sheet 2: Pick Detail ──
  const pickSheet = workbook.addWorksheet('Pick Detail');
  pickSheet.mergeCells('A1:S1');
  const title2 = pickSheet.getCell('A1');
  title2.value = 'All Picks — Per-Stage Scores + Outcomes';
  title2.font = { bold: true, size: 14 };

  pickSheet.addRow([]);
  pickSheet.addRow([
    'Date', 'Ticker', 'Consensus', 'Conviction', 'Entry Price', 'Direction',
    'S1 (Sonnet)', 'S2 (Gemini)', 'S3 (Opus)', 'S4 (Grok)',
    'Pred 3d%', 'Pred 5d%', 'Pred 8d%',
    'Actual 3d%', 'Correct 3d', 'Actual 5d%', 'Correct 5d', 'Actual 8d%', 'Correct 8d',
  ]);
  const headerRow2 = pickSheet.getRow(3);
  headerRow2.font = { bold: true };
  headerRow2.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
    cell.font = { bold: true, color: { argb: 'FF00CCFF' } };
  });

  for (const p of analytics.pick_detail) {
    const pick = p as Record<string, unknown>;
    pickSheet.addRow([
      pick.date, pick.ticker, pick.consensus_score, pick.conviction,
      pick.entry_price, pick.direction,
      pick.s1_score, pick.s2_score, pick.s3_score, pick.s4_score,
      pick.pred_3d, pick.pred_5d, pick.pred_8d,
      pick.actual_3d, pick.accurate_3d === 1 ? 'YES' : pick.accurate_3d === 0 ? 'NO' : '—',
      pick.actual_5d, pick.accurate_5d === 1 ? 'YES' : pick.accurate_5d === 0 ? 'NO' : '—',
      pick.actual_8d, pick.accurate_8d === 1 ? 'YES' : pick.accurate_8d === 0 ? 'NO' : '—',
    ]);
  }

  pickSheet.columns.forEach((col) => { col.width = 14; });

  // ── Sheet 3: Calibration (placeholder for future) ──
  const calSheet = workbook.addWorksheet('Calibration');
  calSheet.mergeCells('A1:D1');
  const title3 = calSheet.getCell('A1');
  title3.value = 'Historical Calibration Data';
  title3.font = { bold: true, size: 14 };
  calSheet.addRow([]);
  calSheet.addRow(['Calibration data will populate as historical backtest runs accumulate.']);
  calSheet.addRow(['This sheet will contain: base rates by technical profile, council calibration curves.']);

  // ── Sheet 4: Daily Summary ──
  const dailySheet = workbook.addWorksheet('Daily Summary');
  dailySheet.mergeCells('A1:I1');
  const title4 = dailySheet.getCell('A1');
  title4.value = 'Daily Accuracy Summary';
  title4.font = { bold: true, size: 14 };

  dailySheet.addRow([]);
  dailySheet.addRow([
    'Date', 'Picks', '3d Checked', '3d Correct', '3d Hit Rate',
    '5d Checked', '5d Correct', '5d Hit Rate',
    '8d Checked', '8d Correct', '8d Hit Rate',
  ]);
  const headerRow4 = dailySheet.getRow(3);
  headerRow4.font = { bold: true };
  headerRow4.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
    cell.font = { bold: true, color: { argb: 'FF00CCFF' } };
  });

  for (const d of analytics.daily) {
    const day = d as Record<string, unknown>;
    dailySheet.addRow([
      day.date, day.picks,
      day.checked_3d, day.correct_3d,
      day.hit_rate_3d != null ? `${((day.hit_rate_3d as number) * 100).toFixed(1)}%` : '—',
      day.checked_5d, day.correct_5d,
      day.hit_rate_5d != null ? `${((day.hit_rate_5d as number) * 100).toFixed(1)}%` : '—',
      day.checked_8d, day.correct_8d,
      day.hit_rate_8d != null ? `${((day.hit_rate_8d as number) * 100).toFixed(1)}%` : '—',
    ]);
  }

  dailySheet.columns.forEach((col) => { col.width = 14; });

  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer();

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="spike-trades-analytics-${new Date().toISOString().split('T')[0]}.xlsx"`,
    },
  });
}
