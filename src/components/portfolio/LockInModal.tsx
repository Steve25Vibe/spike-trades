'use client';

import { useState, useEffect } from 'react';
import { cn, formatCurrency } from '@/lib/utils';
import { getPortfolioConfig, type SizingMode } from './PortfolioSettings';

interface SpikeInfo {
  id: string;
  ticker: string;
  name: string;
  price: number;
  predicted3Day: number;
  predicted5Day: number;
  predicted8Day: number;
  atr?: number;
}

interface Props {
  spike: SpikeInfo;
  onConfirm: (params: { spikeId: string; shares?: number; positionSize?: number; portfolioSize?: number; mode: SizingMode }) => Promise<void>;
  onCancel: () => void;
}

export default function LockInModal({ spike, onConfirm, onCancel }: Props) {
  const config = getPortfolioConfig();
  const [mode] = useState<SizingMode>(config.mode);
  const [manualInput, setManualInput] = useState('');
  const [inputType, setInputType] = useState<'shares' | 'dollars'>('shares');
  const [fixedInput, setFixedInput] = useState(config.fixedAmount.toString());
  const [confirming, setConfirming] = useState(false);

  // Calculate shares/value based on mode
  let shares = 0;
  let totalValue = 0;

  if (mode === 'auto') {
    // Kelly-based — let the API calculate, but show estimate
    const atrPct = spike.atr ? (spike.atr / spike.price) * 100 : 2;
    const kellyRaw = (0.6 / (atrPct * 0.5)) - ((1 - 0.6) / atrPct);
    const kelly = Math.min(Math.max(kellyRaw, 0), 0.02);
    const posSize = config.portfolioSize * kelly;
    shares = Math.floor(posSize / spike.price);
    totalValue = shares * spike.price;
  } else if (mode === 'fixed') {
    const amount = Number(fixedInput) || 0;
    shares = Math.floor(amount / spike.price);
    totalValue = shares * spike.price;
  } else {
    // manual
    const val = Number(manualInput) || 0;
    if (inputType === 'shares') {
      shares = Math.floor(val);
      totalValue = shares * spike.price;
    } else {
      totalValue = val;
      shares = Math.floor(val / spike.price);
      totalValue = shares * spike.price;
    }
  }

  const target3Price = spike.price * (1 + spike.predicted3Day / 100);
  const target5Price = spike.price * (1 + spike.predicted5Day / 100);
  const target8Price = spike.price * (1 + spike.predicted8Day / 100);
  const atrPct = spike.atr ? (spike.atr / spike.price) * 100 : 2;
  const stopLossPrice = spike.price * (1 - (atrPct * 2) / 100);

  const handleConfirm = async () => {
    if (shares <= 0) return;
    setConfirming(true);
    try {
      await onConfirm({
        spikeId: spike.id,
        shares: mode === 'auto' ? undefined : shares,
        positionSize: mode === 'auto' ? undefined : totalValue,
        portfolioSize: mode === 'auto' ? config.portfolioSize : undefined,
        mode,
      });
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={onCancel}>
      <div className="glass-card p-6 w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-spike-text">Confirm Lock-In</h2>
          <button onClick={onCancel} className="text-spike-text-dim hover:text-spike-text text-xl">&times;</button>
        </div>

        {/* Stock info */}
        <div className="bg-spike-bg/50 rounded-xl p-4 mb-5 border border-spike-border/30">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-bold text-spike-text">{spike.ticker}</p>
              <p className="text-sm text-spike-text-dim">{spike.name}</p>
            </div>
            <p className="text-2xl font-bold mono">{formatCurrency(spike.price)}</p>
          </div>
        </div>

        {/* Fixed dollar input (pre-filled, editable) */}
        {mode === 'fixed' && (
          <div className="mb-5">
            <label className="text-xs text-spike-text-muted uppercase tracking-wider block mb-2">Dollar Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-spike-text-dim">$</span>
              <input
                type="number"
                value={fixedInput}
                onChange={(e) => setFixedInput(e.target.value)}
                className="w-full bg-spike-bg/50 border border-spike-border rounded-lg px-3 py-2.5 pl-7 text-spike-text mono text-lg focus:border-spike-cyan/50 focus:outline-none"
                min={0}
                step={100}
                autoFocus
              />
            </div>
            {shares > 0 && (
              <p className="text-xs text-spike-text-dim mt-1 mono">= {shares} shares</p>
            )}
          </div>
        )}

        {/* Manual input */}
        {mode === 'manual' && (
          <div className="mb-5">
            <div className="flex gap-2 mb-3">
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
            <div className="relative">
              {inputType === 'dollars' && (
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-spike-text-dim">$</span>
              )}
              <input
                type="number"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder={inputType === 'shares' ? 'Number of shares' : 'Dollar amount'}
                className={cn(
                  'w-full bg-spike-bg/50 border border-spike-border rounded-lg px-3 py-2.5 text-spike-text mono text-lg focus:border-spike-cyan/50 focus:outline-none',
                  inputType === 'dollars' && 'pl-7'
                )}
                min={0}
                autoFocus
              />
            </div>
            {inputType === 'dollars' && shares > 0 && (
              <p className="text-xs text-spike-text-dim mt-1 mono">= {shares} shares</p>
            )}
            {inputType === 'shares' && totalValue > 0 && (
              <p className="text-xs text-spike-text-dim mt-1 mono">= {formatCurrency(totalValue)}</p>
            )}
          </div>
        )}

        {/* Trade summary */}
        <div className="space-y-3 mb-5">
          <div className="flex justify-between text-sm">
            <span className="text-spike-text-dim">Shares</span>
            <span className="mono font-bold text-spike-text">{shares.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-spike-text-dim">Total Value</span>
            <span className="mono font-bold text-spike-text">{formatCurrency(totalValue)}</span>
          </div>
          <div className="h-px bg-spike-border/30" />
          <div className="flex justify-between text-sm">
            <span className="text-spike-text-dim">Stop-Loss</span>
            <span className="mono text-spike-red">{formatCurrency(stopLossPrice)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-spike-text-dim">3-Day Target</span>
            <span className="mono text-spike-green">{formatCurrency(target3Price)} ({spike.predicted3Day >= 0 ? '+' : ''}{spike.predicted3Day.toFixed(2)}%)</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-spike-text-dim">5-Day Target</span>
            <span className="mono text-spike-cyan">{formatCurrency(target5Price)} ({spike.predicted5Day >= 0 ? '+' : ''}{spike.predicted5Day.toFixed(2)}%)</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-spike-text-dim">8-Day Target</span>
            <span className="mono text-spike-violet">{formatCurrency(target8Price)} ({spike.predicted8Day >= 0 ? '+' : ''}{spike.predicted8Day.toFixed(2)}%)</span>
          </div>
          <div className="h-px bg-spike-border/30" />
          <div className="flex justify-between text-sm">
            <span className="text-spike-text-dim">Sizing Mode</span>
            <span className="text-spike-text-dim capitalize">{mode === 'auto' ? 'Auto (Kelly)' : mode === 'fixed' ? `Fixed ($${config.fixedAmount.toLocaleString()})` : 'Manual'}</span>
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
            disabled={shares <= 0 || confirming}
            className="flex-1 btn-lock-in py-2.5 disabled:opacity-50"
          >
            {confirming ? 'Locking...' : `Lock In ${shares} Shares`}
          </button>
        </div>
      </div>
    </div>
  );
}
