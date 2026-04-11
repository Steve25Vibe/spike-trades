#!/usr/bin/env tsx
// ============================================
// VAULT RESTORE — Disaster recovery from vault snapshots
// Usage:
//   tsx scripts/restore.ts vault/2026-04-10/morning-2026-04-10T15-15-32Z.json.gz
//   tsx scripts/restore.ts vault/2026-04-07/ vault/2026-04-08/
// ============================================

import { readFileSync, readdirSync, statSync } from 'fs';
import { gunzipSync } from 'zlib';
import { PrismaClient } from '@prisma/client';
import { join } from 'path';

const prisma = new PrismaClient();

interface VaultSnapshot {
  meta: {
    scanType: 'MORNING' | 'EVENING';
    scanDate: string;
    generatedAt: string;
    version: string;
  };
  report: {
    id: string;
    date: string;
    scanType: string;
    marketRegime?: string | null;
    tsxLevel?: number | null;
    tsxChange?: number | null;
    oilPrice?: number | null;
    goldPrice?: number | null;
    btcPrice?: number | null;
    cadUsd?: number | null;
    councilLog?: unknown;
  };
  spikes: Array<Record<string, unknown>>;
  councilLog: Record<string, unknown> | null;
}

async function restoreSnapshot(filePath: string): Promise<void> {
  console.log(`\n[Restore] Processing: ${filePath}`);

  // Read and decompress
  const compressed = readFileSync(filePath);
  const json = gunzipSync(compressed).toString('utf-8');
  const snapshot: VaultSnapshot = JSON.parse(json);

  const { meta, report, spikes, councilLog } = snapshot;
  const { scanType, scanDate } = meta;

  console.log(`[Restore] Scan: ${scanType} | Date: ${scanDate} | Spikes: ${spikes.length}`);

  // Parse date as local noon to avoid timezone shift
  const reportDate = new Date(scanDate + 'T12:00:00');

  // Upsert DailyReport
  const existingReport = await prisma.dailyReport.findUnique({
    where: { date_scanType: { date: reportDate, scanType } },
    select: { id: true },
  });

  // Delete old spikes if re-restoring (scoped DELETE with WHERE)
  if (existingReport) {
    console.log(`[Restore] Existing ${scanType} report found — replacing spikes...`);
    await prisma.portfolioEntry.deleteMany({
      where: { spike: { reportId: existingReport.id } },
    });
    await prisma.spike.deleteMany({
      where: { reportId: existingReport.id },
    });
  }

  const reportFields = {
    scanType,
    marketRegime: report.marketRegime ?? null,
    tsxLevel: report.tsxLevel ?? null,
    tsxChange: report.tsxChange ?? null,
    oilPrice: report.oilPrice ?? null,
    goldPrice: report.goldPrice ?? null,
    btcPrice: report.btcPrice ?? null,
    cadUsd: report.cadUsd ?? null,
    councilLog: (report.councilLog as object) ?? undefined,
  };

  // Build spike data from snapshot
  const spikeData = spikes.map((s: Record<string, unknown>) => {
    // Remove fields that Prisma manages
    const { id, reportId, createdAt, updatedAt, ...rest } = s;
    return rest;
  });

  const upsertedReport = await prisma.dailyReport.upsert({
    where: { date_scanType: { date: reportDate, scanType } },
    create: {
      date: reportDate,
      ...reportFields,
      spikes: { create: spikeData as any[] },
    },
    update: {
      ...reportFields,
      spikes: { create: spikeData as any[] },
    },
  });

  console.log(`[Restore] Report upserted: ${upsertedReport.id}`);

  // Upsert CouncilLog if present
  if (councilLog) {
    await prisma.councilLog.upsert({
      where: { date_scanType: { date: reportDate, scanType } },
      create: {
        date: reportDate,
        scanType,
        claudeAnalysis: (councilLog as any).claudeAnalysis ?? null,
        grokAnalysis: (councilLog as any).grokAnalysis ?? null,
        finalVerdict: (councilLog as any).finalVerdict ?? null,
        consensusScore: (councilLog as any).consensusScore ?? null,
        processingTime: (councilLog as any).processingTime ?? null,
      },
      update: {
        claudeAnalysis: (councilLog as any).claudeAnalysis ?? null,
        grokAnalysis: (councilLog as any).grokAnalysis ?? null,
        finalVerdict: (councilLog as any).finalVerdict ?? null,
        consensusScore: (councilLog as any).consensusScore ?? null,
        processingTime: (councilLog as any).processingTime ?? null,
      },
    });
    console.log(`[Restore] CouncilLog upserted for ${scanDate} ${scanType}`);
  }

  console.log(`[Restore] Done: ${scanType} ${scanDate} — ${spikes.length} spikes restored`);
}

function collectSnapshotFiles(paths: string[]): string[] {
  const files: string[] = [];

  for (const p of paths) {
    const stat = statSync(p);
    if (stat.isDirectory()) {
      // Process all .json.gz files in the directory, sorted
      const dirFiles = readdirSync(p)
        .filter((f) => f.endsWith('.json.gz'))
        .sort()
        .map((f) => join(p, f));
      files.push(...dirFiles);
    } else if (p.endsWith('.json.gz')) {
      files.push(p);
    } else {
      console.warn(`[Restore] Skipping non-snapshot file: ${p}`);
    }
  }

  return files;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: tsx scripts/restore.ts <snapshot.json.gz | directory> [...]');
    console.log('');
    console.log('Examples:');
    console.log('  tsx scripts/restore.ts vault/2026-04-10/morning-*.json.gz');
    console.log('  tsx scripts/restore.ts vault/2026-04-07/ vault/2026-04-08/');
    process.exit(1);
  }

  const files = collectSnapshotFiles(args);
  if (files.length === 0) {
    console.log('[Restore] No snapshot files found');
    process.exit(1);
  }

  console.log(`[Restore] Found ${files.length} snapshot(s) to restore`);

  let restored = 0;
  let failed = 0;

  for (const file of files) {
    try {
      await restoreSnapshot(file);
      restored++;
    } catch (err) {
      console.error(`[Restore] FAILED: ${file}:`, (err as Error).message);
      failed++;
    }
  }

  console.log(`\n[Restore] Complete: ${restored} restored, ${failed} failed`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[Restore] Fatal error:', err);
  process.exit(1);
});
