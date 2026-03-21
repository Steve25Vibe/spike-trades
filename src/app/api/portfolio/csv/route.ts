import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// POST /api/portfolio/csv — Import positions from Wealthsimple CSV
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const portfolioId = formData.get('portfolioId') as string | null;

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No CSV file provided' },
        { status: 400 }
      );
    }

    const text = await file.text();
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    if (lines.length < 2) {
      return NextResponse.json(
        { success: false, error: 'CSV file is empty or has no data rows' },
        { status: 400 }
      );
    }

    // Parse header to find column indices (flexible — handles different column orders)
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const colIndex = {
      date: header.findIndex((h) => h === 'date'),
      type: header.findIndex((h) => h === 'type' || h === 'transaction type'),
      symbol: header.findIndex((h) => h === 'symbol' || h === 'ticker'),
      quantity: header.findIndex((h) => h === 'quantity' || h === 'qty' || h === 'shares'),
      price: header.findIndex((h) => h === 'price'),
      description: header.findIndex((h) => h === 'description' || h === 'desc'),
      account: header.findIndex((h) => h === 'account'),
      amount: header.findIndex((h) => h === 'amount' || h === 'total'),
    };

    // Require at minimum: type, symbol, quantity, price
    if (colIndex.symbol === -1 || colIndex.quantity === -1 || colIndex.price === -1) {
      return NextResponse.json(
        { success: false, error: 'CSV missing required columns. Expected: Symbol, Quantity, Price (and optionally Date, Type, Description, Account, Amount)' },
        { status: 400 }
      );
    }

    const imported: { ticker: string; shares: number; entryPrice: number }[] = [];
    const skipped: { ticker: string; reason: string }[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());

      // Filter to Buy rows only (if Type column exists)
      if (colIndex.type !== -1) {
        const txType = cols[colIndex.type]?.toLowerCase() || '';
        if (txType !== 'buy' && txType !== 'bought') continue;
      }

      const rawSymbol = cols[colIndex.symbol] || '';
      const quantity = Math.floor(parseFloat(cols[colIndex.quantity]) || 0);
      const price = parseFloat(cols[colIndex.price]) || 0;
      const dateStr = colIndex.date !== -1 ? cols[colIndex.date] : '';

      if (!rawSymbol || quantity <= 0 || price <= 0) {
        if (rawSymbol) skipped.push({ ticker: rawSymbol, reason: 'Invalid quantity or price' });
        continue;
      }

      // Normalize ticker — add .TO suffix if missing (TSX convention)
      const ticker = rawSymbol.includes('.') ? rawSymbol.toUpperCase() : `${rawSymbol.toUpperCase()}.TO`;

      // Look up matching spike (most recent)
      const spike = await prisma.spike.findFirst({
        where: { ticker },
        orderBy: { createdAt: 'desc' },
      });

      if (!spike) {
        skipped.push({ ticker, reason: 'Not tracked by Spike Trades' });
        continue;
      }

      // Check for existing active position
      const existing = await prisma.portfolioEntry.findFirst({
        where: { ticker, status: 'active' },
      });
      if (existing) {
        skipped.push({ ticker, reason: 'Already an active position' });
        continue;
      }

      // Calculate targets from spike data, but use CSV's price/date/shares
      const atrPct = spike.atr ? (spike.atr / spike.price) * 100 : 2;
      const entryDate = dateStr ? new Date(dateStr) : new Date();
      const positionSize = quantity * price;

      const entry = await prisma.portfolioEntry.create({
        data: {
          portfolioId: portfolioId || null,
          spikeId: spike.id,
          ticker: spike.ticker,
          name: spike.name,
          entryPrice: price,
          entryDate,
          shares: quantity,
          positionSize,
          positionPct: 0, // Unknown without total portfolio size
          target3Day: spike.price * (1 + spike.predicted3Day / 100),
          target5Day: spike.price * (1 + spike.predicted5Day / 100),
          target8Day: spike.price * (1 + spike.predicted8Day / 100),
          stopLoss: spike.price * (1 - (atrPct * 2) / 100),
          status: 'active',
        },
      });

      imported.push({ ticker: entry.ticker, shares: entry.shares, entryPrice: entry.entryPrice });
    }

    return NextResponse.json({
      success: true,
      imported,
      skipped,
      summary: `${imported.length} position${imported.length !== 1 ? 's' : ''} imported, ${skipped.length} skipped`,
    });
  } catch (error) {
    console.error('CSV import error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to process CSV file' },
      { status: 500 }
    );
  }
}

// GET /api/portfolio/csv — Export portfolio as Wealthsimple-compatible CSV
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const portfolioId = request.nextUrl.searchParams.get('portfolioId');
    const where: Record<string, unknown> = {};
    if (portfolioId) where.portfolioId = portfolioId;

    const positions = await prisma.portfolioEntry.findMany({
      where,
      orderBy: { entryDate: 'desc' },
    });

    const rows: string[] = ['Date,Account,Type,Description,Symbol,Quantity,Price,Amount'];

    for (const pos of positions) {
      // Buy row for every position
      const buyDate = new Date(pos.entryDate).toISOString().split('T')[0];
      const buyAmount = -(pos.shares * pos.entryPrice);
      rows.push(
        `${buyDate},Spike Trades,Buy,Bought ${pos.shares} shares of ${pos.ticker},${pos.ticker},${pos.shares},${pos.entryPrice.toFixed(2)},${buyAmount.toFixed(2)}`
      );

      // Sell row for closed positions
      if ((pos.status === 'closed' || pos.status === 'stopped') && pos.exitPrice && pos.exitDate) {
        const sellDate = new Date(pos.exitDate).toISOString().split('T')[0];
        const sellAmount = pos.shares * pos.exitPrice;
        rows.push(
          `${sellDate},Spike Trades,Sell,Sold ${pos.shares} shares of ${pos.ticker},${pos.ticker},${pos.shares},${pos.exitPrice.toFixed(2)},${sellAmount.toFixed(2)}`
        );
      }
    }

    const csv = rows.join('\n');
    const today = new Date().toISOString().split('T')[0];

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="spike-trades-portfolio-${today}.csv"`,
      },
    });
  } catch (error) {
    console.error('CSV export error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to export portfolio' },
      { status: 500 }
    );
  }
}
