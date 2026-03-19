'use client';

import { cn } from '@/lib/utils';

interface Props {
  date: string;
  regime: string;
  tsxLevel: number;
  tsxChange: number;
  oilPrice: number;
  goldPrice: number;
  cadUsd: number;
}

export default function MarketHeader({ date, regime, tsxLevel, tsxChange, oilPrice, goldPrice, cadUsd }: Props) {
  const regimeColors: Record<string, string> = {
    bull: 'text-spike-green bg-spike-green/10 border-spike-green/30',
    bear: 'text-spike-red bg-spike-red/10 border-spike-red/30',
    neutral: 'text-spike-amber bg-spike-amber/10 border-spike-amber/30',
    volatile: 'text-spike-violet bg-spike-violet/10 border-spike-violet/30',
  };

  return (
    <div className="glass-card p-4 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Date & Regime */}
        <div className="flex items-center gap-4">
          <div>
            <h2 className="text-xl font-display font-bold text-spike-cyan tracking-wide">
              TODAY&apos;S SPIKES
            </h2>
            <p className="text-sm text-spike-text-dim">{date}</p>
          </div>
          <span className={cn(
            'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border',
            regimeColors[regime] || regimeColors.neutral
          )}>
            {regime}
          </span>
        </div>

        {/* Market indicators */}
        <div className="flex items-center gap-6 text-sm">
          <div className="text-center">
            <p className="text-[10px] text-spike-text-muted uppercase tracking-wider">TSX (XIU)</p>
            <p className="font-bold mono">
              {tsxLevel.toFixed(0)}
              <span className={cn('ml-1 text-xs', tsxChange >= 0 ? 'text-spike-green' : 'text-spike-red')}>
                {tsxChange >= 0 ? '+' : ''}{tsxChange.toFixed(2)}%
              </span>
            </p>
          </div>
          <div className="w-px h-8 bg-spike-border" />
          <div className="text-center">
            <p className="text-[10px] text-spike-text-muted uppercase tracking-wider">USO Oil</p>
            <p className="font-bold mono">${oilPrice.toFixed(2)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-spike-text-muted uppercase tracking-wider">Gold</p>
            <p className="font-bold mono">${goldPrice.toFixed(0)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-spike-text-muted uppercase tracking-wider">CAD/USD</p>
            <p className="font-bold mono">{cadUsd.toFixed(4)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
