'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { PortfolioInfo } from './usePortfolios';

interface Props {
  portfolios: PortfolioInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreateNew?: () => void;
  compact?: boolean;
}

export default function PortfolioSelector({ portfolios, activeId, onSelect, onCreateNew, compact }: Props) {
  const [open, setOpen] = useState(false);
  const active = portfolios.find((p) => p.id === activeId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-2 rounded-lg border transition-all',
          compact
            ? 'px-3 py-1.5 text-xs'
            : 'px-4 py-2 text-sm',
          'border-spike-border hover:border-spike-cyan/30 text-spike-text bg-spike-bg/50'
        )}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="font-medium">{active?.name || 'Select Portfolio'}</span>
        {active && !compact && (
          <span className="text-spike-text-muted">({active.activePositions} active)</span>
        )}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={cn('transition-transform', open && 'rotate-180')}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-72 z-50 bg-spike-bg border border-spike-border rounded-xl shadow-2xl overflow-hidden">
            {portfolios.map((p) => (
              <button
                key={p.id}
                onClick={() => { onSelect(p.id); setOpen(false); }}
                className={cn(
                  'w-full text-left px-4 py-3 flex items-center justify-between transition-colors',
                  p.id === activeId
                    ? 'bg-spike-cyan/10 text-spike-cyan'
                    : 'text-spike-text hover:bg-spike-bg-hover'
                )}
              >
                <div>
                  <p className="font-medium text-sm">{p.name}</p>
                  <p className="text-xs text-spike-text-muted mt-0.5">
                    {p.activePositions} active · {p.sizingMode}
                  </p>
                </div>
                {p.id === activeId && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            ))}

            {onCreateNew && (
              <button
                onClick={() => { onCreateNew(); setOpen(false); }}
                className="w-full text-left px-4 py-3 text-sm text-spike-cyan hover:bg-spike-cyan/5 border-t border-spike-border/30 flex items-center gap-2"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New Portfolio
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
