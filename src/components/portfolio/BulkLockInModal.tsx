'use client';

import { useState } from 'react';
import { cn, formatCurrency } from '@/lib/utils';
import type { SizingMode } from './PortfolioSettings';
import { configFromPortfolio, getLocalConfig } from './PortfolioSettings';
import PortfolioSelector from './PortfolioSelector';
import type { PortfolioInfo } from './usePortfolios';

interface SpikeInfo {
  id: string;
  ticker: string;
  name: string;
  price: number;
  predicted3Day: number;
  atr?: number;
}

interface Props {
  spikes: SpikeInfo[];
  portfolios: PortfolioInfo[];
  activePortfolioId: string | null;
  onConfirm: (params: {
    spikeIds: string[];
    portfolioId: string;
    mode: SizingMode;
    portfolioSize?: number;
    fixedAmount?: number;
    perSpikeShares?: Record<string, number>;
    kellyMaxPct?: number;
    kellyWinRate?: number;
  }) => Promise<void>;
  onCancel: () => void;
}

export default function BulkLockInModal({ spikes, portfolios, activePortfolioId, onConfirm, onCancel }: Props) {
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(activePortfolioId || portfolios[0]?.id || '');
  const selectedPortfolio = portfolios.find((p) => p.id === selectedPortfolioId) || null;
  const config = selectedPortfolio ? configFromPortfolio(selectedPortfolio) : getLocalConfig();
  const mode = config.mode;

  const [fixedPerSpike, setFixedPerSpike] = useState(
    Math.floor(config.fixedAmount / spikes.length).toString()
  );
  const [manualInputs, setManualInputs] = useState<Record<string, string>>(
    () => Object.fromEntries(spikes.map((s) => [s.id, '']))
  );
  const [inputType, setInputType] = useState<'shares' | 'dollars'>('shares');
  const [confirming, setConfirming] = useState(false);

  const getSharesForSpike = (spike: SpikeInfo): number => {
    if (mode === 'auto') {
      const atrPct = spike.atr ? (spike.atr / spike.price) * 100 : 2;
      const winRate = config.kellyWinRate || 0.6;
      const maxPct = (config.kellyMaxPct || 2) / 100;
      const kellyRaw = (winRate / (atrPct * 0.5)) - ((1 - winRate) / atrPct);
      const kelly = Math.min(Math.max(kellyRaw * 0.5, 0), maxPct);
      const posSize = config.portfolioSize * kelly;
      return Math.floor(posSize / spike.price);
    } else if (mode === 'fixed') {
      const amount = Number(fixedPerSpike) || 0;
      return Math.floor(amount / spike.price);
    } else {
      const val = Number(manualInputs[spike.id]) || 0;
      if (inputType === 'shares') return Math.floor(val);
      return Math.floor(val / spike.price);
    }
  };

  const spikeRows = spikes.map((spike) => {
    const shares = getSharesForSpike(spike);
    const value = shares * spike.price;
    return { spike, shares, value };
  });

  const totalShares = spikeRows.reduce((s, r) => s + r.shares, 0);
  const totalValue = spikeRows.reduce((s, r) => s + r.value, 0);
  const allValid = spikeRows.every((r) => r.shares > 0);

  const handleManualInput = (spikeId: string, val: string) => {
    setManualInputs((prev) => ({ ...prev, [spikeId]: val }));
  };

  const handleConfirm = async () => {
    if (!allValid || !selectedPortfolioId) return;
    setConfirming(true);
    try {
      if (mode === 'manual') {
        const perSpikeShares: Record<string, number> = {};
        for (const row of spikeRows) {
          perSpikeShares[row.spike.id] = row.shares;
        }
        await onConfirm({
          spikeIds: spikes.map((s) => s.id),
          portfolioId: selectedPortfolioId,
          mode,
          perSpikeShares,
        });
      } else if (mode === 'fixed') {
        await onConfirm({
          spikeIds: spikes.map((s) => s.id),
          portfolioId: selectedPortfolioId,
          mode,
          fixedAmount: Number(fixedPerSpike) || 0,
        });
      } else {
        await onConfirm({
          spikeIds: spikes.map((s) => s.id),
          portfolioId: selectedPortfolioId,
          mode,
          portfolioSize: config.portfolioSize,
          kellyMaxPct: config.kellyMaxPct,
          kellyWinRate: config.kellyWinRate,
        });
      }
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={onCancel}>
      <div className="glass-card p-6 w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-spike-text">Bulk Lock-In — {spikes.length} Spikes</h2>
            <p className="text-xs text-spike-text-dim mt-0.5">
              Mode: {mode === 'auto' ? `Auto Kelly ($${config.portfolioSize.toLocaleString()} portfolio)` : mode === 'fixed' ? 'Fixed Dollar' : 'Manual Entry'}
            </p>
          </div>
          <button onClick={onCancel} className="text-spike-text-dim hover:text-spike-text text-xl">&times;</button>
        </div>

        {/* Portfolio selector */}
        {portfolios.length > 1 && (
          <div className="mb-4">
            <PortfolioSelector
              portfolios={portfolios}
              activeId={selectedPortfolioId}
              onSelect={setSelectedPortfolioId}
              compact
            />
          </div>
        )}

        {/* Fixed mode: amount per spike input */}
        {mode === 'fixed' && (
          <div className="mb-4 p-3 bg-spike-bg/50 rounded-xl border border-spike-border/30">
            <label className="text-xs text-spike-text-muted uppercase tracking-wider block mb-2">Amount Per Spike</label>
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-spike-text-dim">$</span>
                <input
                  type="number"
                  value={fixedPerSpike}
                  onChange={(e) => setFixedPerSpike(e.target.value)}
                  className="w-full bg-spike-bg/50 border border-spike-border rounded-lg px-3 py-2 pl-7 text-spike-text mono focus:border-spike-cyan/50 focus:outline-none"
                  min={0}
                  step={100}
                  autoFocus
                />
              </div>
              <span className="text-xs text-spike-text-dim">
                × {spikes.length} spikes = {formatCurrency((Number(fixedPerSpike) || 0) * spikes.length)} total
              </span>
            </div>
          </div>
        )}

        {/* Manual mode: input type toggle */}
        {mode === 'manual' && (
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setInputType('shares')}
              className={cn(
                'flex-1 py-2 rounded-lg text-sm font-medium transition-all border',
                inputType === 'shares'
                  ? 'bg-spike-cyan/10 text-spike-cyan border-spike-cyan/30'
                  : 'text-spike-text-dim border-spike-border hover:border-spike-cyan/20'
              )}
            >
              By Shares
            </button>
            <button
              onClick={() => setInputType('dollars')}
              className={cn(
                'flex-1 py-2 rounded-lg text-sm font-medium transition-all border',
                inputType === 'dollars'
                  ? 'bg-spike-cyan/10 text-spike-cyan border-spike-cyan/30'
                  : 'text-spike-text-dim border-spike-border hover:border-spike-cyan/20'
              )}
            >
              By Dollar Amount
            </button>
          </div>
        )}

        {/* Spike list */}
        <div className="flex-1 overflow-y-auto space-y-2 mb-4">
          {spikeRows.map(({ spike, shares, value }) => (
            <div key={spike.id} className="flex items-center gap-3 p-3 bg-spike-bg/30 rounded-lg border border-spike-border/20">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-spike-text text-sm">{spike.ticker}</span>
                  <span className="text-xs text-spike-text-muted mono">{formatCurrency(spike.price)}</span>
                </div>
                <p className="text-xs text-spike-text-dim truncate">{spike.name}</p>
              </div>

              {mode === 'manual' && (
                <div className="w-32">
                  <div className="relative">
                    {inputType === 'dollars' && (
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-spike-text-dim text-xs">$</span>
                    )}
                    <input
                      type="number"
                      value={manualInputs[spike.id]}
                      onChange={(e) => handleManualInput(spike.id, e.target.value)}
                      placeholder={inputType === 'shares' ? 'Shares' : 'Amount'}
                      className={cn(
                        'w-full bg-spike-bg/50 border border-spike-border rounded-lg px-2 py-1.5 text-sm text-spike-text mono focus:border-spike-cyan/50 focus:outline-none',
                        inputType === 'dollars' && 'pl-5'
                      )}
                      min={0}
                    />
                  </div>
                </div>
              )}

              <div className="text-right w-28 flex-shrink-0">
                <p className={cn('text-sm font-bold mono', shares > 0 ? 'text-spike-text' : 'text-spike-text-muted')}>
                  {shares > 0 ? `${shares} shares` : '—'}
                </p>
                {shares > 0 && (
                  <p className="text-xs text-spike-text-dim mono">{formatCurrency(value)}</p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Totals */}
        <div className="flex justify-between items-center p-3 bg-spike-bg/50 rounded-xl border border-spike-border/30 mb-4">
          <span className="text-sm text-spike-text-dim">Total Investment</span>
          <div className="text-right">
            <p className="text-lg font-bold mono text-spike-text">{formatCurrency(totalValue)}</p>
            <p className="text-xs text-spike-text-dim">{totalShares} shares across {spikes.length} positions</p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium text-spike-text-dim border border-spike-border hover:border-spike-cyan/20 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!allValid || confirming || !selectedPortfolioId}
            className="flex-1 btn-lock-in py-2.5 disabled:opacity-50"
          >
            {confirming ? 'Locking...' : `Lock In ${spikes.length} Spikes`}
          </button>
        </div>
      </div>
    </div>
  );
}
