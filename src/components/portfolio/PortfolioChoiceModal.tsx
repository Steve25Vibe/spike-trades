'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { PortfolioInfo } from './usePortfolios';

interface Props {
  portfolios: PortfolioInfo[];
  spikeCount: number;
  onSelect: (portfolioId: string) => void;
  onCreate: (portfolioId: string) => void;
  onCancel: () => void;
}

export default function PortfolioChoiceModal({ portfolios, spikeCount, onSelect, onCreate, onCancel }: Props) {
  const [mode, setMode] = useState<'choose' | 'create'>('choose');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/portfolios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const json = await res.json();
      if (json.success) {
        onCreate(json.data.id);
      }
    } catch { /* ignore */ }
    finally { setCreating(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={onCancel}>
      <div className="glass-card p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-spike-text">
            Lock In {spikeCount} Spike{spikeCount > 1 ? 's' : ''} — Choose Portfolio
          </h2>
          <button onClick={onCancel} className="text-spike-text-dim hover:text-spike-text text-xl">&times;</button>
        </div>

        {mode === 'choose' ? (
          <>
            <p className="text-sm text-spike-text-dim mb-4">
              Where do you want to add {spikeCount > 1 ? 'these spikes' : 'this spike'}?
            </p>

            {/* Existing portfolios */}
            <div className="space-y-2 mb-4">
              {portfolios.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onSelect(p.id)}
                  className="w-full text-left p-4 rounded-xl border border-spike-border hover:border-spike-cyan/30 bg-spike-bg/50 hover:bg-spike-cyan/5 transition-all flex items-center justify-between group"
                >
                  <div>
                    <p className="font-semibold text-spike-text text-sm group-hover:text-spike-cyan transition-colors">{p.name}</p>
                    <p className="text-xs text-spike-text-muted mt-0.5">
                      {p.activePositions} active position{p.activePositions !== 1 ? 's' : ''} · {p.sizingMode} sizing
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-spike-text-muted group-hover:text-spike-cyan transition-colors">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              ))}
            </div>

            {/* Create new */}
            <button
              onClick={() => setMode('create')}
              className="w-full text-left p-4 rounded-xl border border-dashed border-spike-cyan/30 hover:border-spike-cyan/50 bg-spike-cyan/5 hover:bg-spike-cyan/10 transition-all flex items-center gap-3"
            >
              <div className="w-8 h-8 rounded-lg bg-spike-cyan/10 flex items-center justify-center text-spike-cyan">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-spike-cyan text-sm">Create New Portfolio</p>
                <p className="text-xs text-spike-text-muted mt-0.5">Start a fresh portfolio with {spikeCount > 1 ? 'these spikes' : 'this spike'}</p>
              </div>
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-spike-text-dim mb-4">
              Name your new portfolio:
            </p>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Growth Picks, March 2026, Energy Sector"
              className="w-full bg-spike-bg/50 border border-spike-border rounded-lg px-3 py-2.5 text-spike-text focus:border-spike-cyan/50 focus:outline-none mb-4"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            />
            <div className="flex gap-3">
              <button
                onClick={() => setMode('choose')}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium text-spike-text-dim border border-spike-border hover:border-spike-cyan/20 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
                className="flex-1 btn-lock-in py-2.5 disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create & Continue'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
