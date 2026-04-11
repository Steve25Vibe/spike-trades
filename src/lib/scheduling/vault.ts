// ============================================
// VAULT SNAPSHOT — Post-scan offsite backup
// Writes compressed JSON snapshots to local vault directory
// and pushes to GitHub. Fire-and-forget: failures never affect scan success.
// ============================================

import { gzipSync } from 'zlib';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import prisma from '@/lib/db/prisma';

const VAULT_BASE = '/opt/spike-trades/spiketrades-vault';
const VERSION = '6.1.2';

type ScanType = 'MORNING' | 'EVENING';

interface VaultData {
  scanDate: string;
  archiveRow: {
    id: string;
    scanDate: string | Date;
    regime?: string | null;
  };
  report: {
    id: string;
    date: string | Date;
    scanType: string;
    marketRegime?: string | null;
  };
  spikes: unknown[];
  councilLog: unknown;
}

export async function writeVaultSnapshot(
  scanType: ScanType,
  data: VaultData,
): Promise<void> {
  try {
    // Check if vault directory exists (it won't in dev)
    if (!existsSync(VAULT_BASE)) {
      console.log('[Vault] Vault directory not found — skipping snapshot (dev environment)');
      return;
    }

    const { scanDate, archiveRow, report, spikes, councilLog } = data;
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-');

    // Query accuracy delta (records updated in the last 2 hours)
    let accuracyDelta: unknown[] = [];
    try {
      accuracyDelta = await prisma.accuracyRecord.findMany({
        where: {
          createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        },
        take: 100,
      });
    } catch {
      // Non-fatal
    }

    // Query portfolio delta (entries created in the last 2 hours)
    let userPortfolioDelta: unknown[] = [];
    try {
      userPortfolioDelta = await prisma.portfolioEntry.findMany({
        where: {
          createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        },
        take: 100,
      });
    } catch {
      // Non-fatal
    }

    // Build snapshot
    const snapshot = {
      meta: {
        scanType,
        scanDate,
        generatedAt: now.toISOString(),
        version: VERSION,
      },
      archive: archiveRow,
      report,
      spikes,
      councilLog,
      accuracyDelta,
      userPortfolioDelta,
    };

    // Compress
    const json = JSON.stringify(snapshot, null, 0);
    const compressed = gzipSync(Buffer.from(json));

    // Write to disk
    const dateDir = `${VAULT_BASE}/vault/${scanDate}`;
    mkdirSync(dateDir, { recursive: true });
    const filename = `${scanType.toLowerCase()}-${timestamp}.json.gz`;
    const filePath = `${dateDir}/${filename}`;
    writeFileSync(filePath, compressed);
    console.log(`[Vault] Snapshot written: ${filePath} (${compressed.length} bytes)`);

    // Git add + commit + push (30s timeout)
    try {
      execSync(
        `cd "${VAULT_BASE}" && git add -A && git commit -m "vault: ${scanType} ${scanDate}" && git push origin main`,
        { timeout: 30_000, stdio: 'pipe' },
      );
      console.log('[Vault] Snapshot pushed to GitHub');
    } catch (gitErr) {
      console.warn('[Vault] Git push failed (local copy preserved):', (gitErr as Error).message);
    }
  } catch (err) {
    console.warn('[Vault] Snapshot error (non-fatal):', (err as Error).message);
  }
}
