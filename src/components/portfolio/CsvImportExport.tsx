'use client';

import { useState, useRef } from 'react';
import { cn } from '@/lib/utils';

interface ImportResult {
  imported: { ticker: string; shares: number; entryPrice: number }[];
  skipped: { ticker: string; reason: string }[];
  summary: string;
}

interface Props {
  onImportComplete: () => void;
}

export default function CsvImportExport({ onImportComplete }: Props) {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setError('');
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/portfolio/csv', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.error || 'Import failed');
      } else {
        setResult(json);
        if (json.imported.length > 0) {
          onImportComplete();
        }
      }
    } catch {
      setError('Failed to upload file');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Import button */}
      <label
        className={cn(
          'px-3 py-2 rounded-lg text-xs font-medium cursor-pointer transition-all border',
          'text-spike-violet border-spike-violet/30 hover:bg-spike-violet/10',
          importing && 'opacity-50 cursor-wait'
        )}
        title="Import positions from a Wealthsimple CSV — only stocks tracked by Spike Trades will be added"
      >
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          onChange={handleImport}
          disabled={importing}
          className="hidden"
        />
        {importing ? 'Importing...' : '↑ Import CSV'}
      </label>

      {/* Export button */}
      <a
        href="/api/portfolio/csv"
        className="px-3 py-2 rounded-lg text-xs font-medium transition-all border text-spike-green border-spike-green/30 hover:bg-spike-green/10"
        title="Download your portfolio as a Wealthsimple-compatible CSV file"
        download
      >
        ↓ Export CSV
      </a>

      {/* Result toast */}
      {result && (
        <div className="fixed bottom-6 right-6 z-50 max-w-md animate-fade-in">
          <div className="glass-card p-4 border-spike-cyan/30">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-spike-text">{result.summary}</p>
                {result.imported.length > 0 && (
                  <p className="text-xs text-spike-green mt-1">
                    Added: {result.imported.map((i) => `${i.ticker} (${i.shares} shares)`).join(', ')}
                  </p>
                )}
                {result.skipped.length > 0 && (
                  <p className="text-xs text-spike-amber mt-1">
                    Skipped: {result.skipped.map((s) => `${s.ticker} — ${s.reason}`).join(', ')}
                  </p>
                )}
              </div>
              <button
                onClick={() => setResult(null)}
                className="text-spike-text-muted hover:text-spike-text text-lg leading-none"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-6 right-6 z-50 max-w-md animate-fade-in">
          <div className="glass-card p-4 border-spike-red/30">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-spike-red">{error}</p>
              <button
                onClick={() => setError('')}
                className="text-spike-text-muted hover:text-spike-text text-lg leading-none"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
