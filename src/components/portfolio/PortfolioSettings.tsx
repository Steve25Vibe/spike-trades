'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { PortfolioInfo } from './usePortfolios';

export type SizingMode = 'auto' | 'fixed' | 'manual';

export interface PortfolioConfig {
  mode: SizingMode;
  portfolioSize: number;
  fixedAmount: number;
  kellyMaxPct: number;
  kellyWinRate: number;
}

const DEFAULT_CONFIG: PortfolioConfig = {
  mode: 'manual',
  portfolioSize: 100000,
  fixedAmount: 2500,
  kellyMaxPct: 2,
  kellyWinRate: 0.6,
};

const LOCAL_CONFIG_KEY = 'spike-sizing-config';

/** Read saved config from localStorage (fallback when no portfolio) */
function getLocalConfig(): PortfolioConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG;
  try {
    const stored = localStorage.getItem(LOCAL_CONFIG_KEY);
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

/** Save config to localStorage */
function setLocalConfig(config: PortfolioConfig) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(config));
}

/** Build a PortfolioConfig from a DB portfolio record */
export function configFromPortfolio(p: PortfolioInfo | null): PortfolioConfig {
  if (!p) return getLocalConfig();
  return {
    mode: (p.sizingMode as SizingMode) || 'manual',
    portfolioSize: p.portfolioSize ?? 100000,
    fixedAmount: p.fixedAmount ?? 2500,
    kellyMaxPct: p.kellyMaxPct ?? 2,
    kellyWinRate: p.kellyWinRate ?? 0.6,
  };
}

interface Props {
  portfolio: PortfolioInfo | null;
  onClose: () => void;
  onUpdated?: () => void;
}

export default function PortfolioSettings({ portfolio, onClose, onUpdated }: Props) {
  const [config, setConfig] = useState<PortfolioConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [nameInput, setNameInput] = useState('');

  useEffect(() => {
    if (portfolio) {
      setConfig(configFromPortfolio(portfolio));
      setNameInput(portfolio.name);
    } else {
      setConfig(getLocalConfig());
    }
  }, [portfolio]);

  const save = async (partial: Partial<PortfolioConfig & { name: string }>) => {
    const next = { ...config, ...partial };
    setConfig(next);

    // Always persist to localStorage so config survives without a portfolio
    setLocalConfig(next);

    // If a portfolio exists, also persist to DB
    if (portfolio) {
      setSaving(true);
      try {
        await fetch(`/api/portfolios/${portfolio.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sizingMode: next.mode,
            portfolioSize: next.portfolioSize,
            fixedAmount: next.fixedAmount,
            kellyMaxPct: next.kellyMaxPct,
            kellyWinRate: next.kellyWinRate,
            ...(partial.name !== undefined ? { name: partial.name } : {}),
          }),
        });
        onUpdated?.();
      } catch { /* ignore */ }
      finally { setSaving(false); }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={onClose}>
      <div className="glass-card p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-spike-text">Portfolio Settings</h2>
          <button onClick={onClose} className="text-spike-text-dim hover:text-spike-text text-xl">&times;</button>
        </div>

        {/* Portfolio name — only show when a portfolio exists */}
        {portfolio && (
          <div className="mb-5">
            <label className="text-xs text-spike-text-muted uppercase tracking-wider block mb-2">Portfolio Name</label>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={() => { if (nameInput.trim() && nameInput !== portfolio.name) save({ name: nameInput.trim() }); }}
              className="w-full bg-spike-bg/50 border border-spike-border rounded-lg px-3 py-2.5 text-spike-text focus:border-spike-cyan/50 focus:outline-none"
            />
          </div>
        )}

        <p className="text-sm text-spike-text-dim mb-5">
          Choose how position sizes are calculated when you lock in spikes.
        </p>

        {/* Mode selection */}
        <div className="space-y-3 mb-6">
          {/* Auto-Size */}
          <button
            onClick={() => save({ mode: 'auto' })}
            className={cn(
              'w-full text-left p-4 rounded-xl border transition-all',
              config.mode === 'auto'
                ? 'bg-spike-cyan/10 border-spike-cyan/30'
                : 'bg-spike-bg/50 border-spike-border hover:border-spike-cyan/20'
            )}
          >
            <div className="flex items-center gap-3">
              <div className={cn(
                'w-5 h-5 rounded-full border-2 flex items-center justify-center',
                config.mode === 'auto' ? 'border-spike-cyan' : 'border-spike-border'
              )}>
                {config.mode === 'auto' && <div className="w-2.5 h-2.5 rounded-full bg-spike-cyan" />}
              </div>
              <div>
                <p className="font-semibold text-spike-text text-sm">Auto-Size (Kelly Criterion)</p>
                <p className="text-xs text-spike-text-dim mt-0.5">Automatically calculates optimal position size based on your total portfolio value and each stock&apos;s risk profile.</p>
              </div>
            </div>
          </button>

          {/* Fixed Dollar */}
          <button
            onClick={() => save({ mode: 'fixed' })}
            className={cn(
              'w-full text-left p-4 rounded-xl border transition-all',
              config.mode === 'fixed'
                ? 'bg-spike-cyan/10 border-spike-cyan/30'
                : 'bg-spike-bg/50 border-spike-border hover:border-spike-cyan/20'
            )}
          >
            <div className="flex items-center gap-3">
              <div className={cn(
                'w-5 h-5 rounded-full border-2 flex items-center justify-center',
                config.mode === 'fixed' ? 'border-spike-cyan' : 'border-spike-border'
              )}>
                {config.mode === 'fixed' && <div className="w-2.5 h-2.5 rounded-full bg-spike-cyan" />}
              </div>
              <div>
                <p className="font-semibold text-spike-text text-sm">Fixed Dollar Amount</p>
                <p className="text-xs text-spike-text-dim mt-0.5">Invest the same dollar amount in every trade. Shares are calculated automatically.</p>
              </div>
            </div>
          </button>

          {/* Manual Shares */}
          <button
            onClick={() => save({ mode: 'manual' })}
            className={cn(
              'w-full text-left p-4 rounded-xl border transition-all',
              config.mode === 'manual'
                ? 'bg-spike-cyan/10 border-spike-cyan/30'
                : 'bg-spike-bg/50 border-spike-border hover:border-spike-cyan/20'
            )}
          >
            <div className="flex items-center gap-3">
              <div className={cn(
                'w-5 h-5 rounded-full border-2 flex items-center justify-center',
                config.mode === 'manual' ? 'border-spike-cyan' : 'border-spike-border'
              )}>
                {config.mode === 'manual' && <div className="w-2.5 h-2.5 rounded-full bg-spike-cyan" />}
              </div>
              <div>
                <p className="font-semibold text-spike-text text-sm">Manual Entry</p>
                <p className="text-xs text-spike-text-dim mt-0.5">Enter the exact number of shares or dollar amount for each trade yourself.</p>
              </div>
            </div>
          </button>
        </div>

        {/* Mode-specific inputs */}
        {config.mode === 'auto' && (
          <div className="mb-5 space-y-4">
            <div>
              <label className="text-xs text-spike-text-muted uppercase tracking-wider block mb-2">Total Portfolio Value</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-spike-text-dim">$</span>
                <input
                  type="number"
                  value={config.portfolioSize}
                  onChange={(e) => setConfig({ ...config, portfolioSize: Number(e.target.value) || 0 })}
                  onBlur={() => save({ portfolioSize: config.portfolioSize })}
                  className="w-full bg-spike-bg/50 border border-spike-border rounded-lg px-3 py-2.5 pl-7 text-spike-text mono focus:border-spike-cyan/50 focus:outline-none"
                  min={0}
                  step={1000}
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-spike-text-muted uppercase tracking-wider">Max Risk Per Position</label>
                <span className="text-sm mono text-spike-cyan font-bold">{config.kellyMaxPct}%</span>
              </div>
              <input
                type="range"
                value={config.kellyMaxPct}
                onChange={(e) => { const v = Number(e.target.value); setConfig({ ...config, kellyMaxPct: v }); }}
                onMouseUp={() => save({ kellyMaxPct: config.kellyMaxPct })}
                onTouchEnd={() => save({ kellyMaxPct: config.kellyMaxPct })}
                min={0.5}
                max={10}
                step={0.5}
                className="w-full accent-spike-cyan"
              />
              <div className="flex justify-between text-[10px] text-spike-text-muted mt-1">
                <span>0.5% (conservative)</span>
                <span>10% (aggressive)</span>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-spike-text-muted uppercase tracking-wider">Assumed Win Rate</label>
                <span className="text-sm mono text-spike-cyan font-bold">{Math.round(config.kellyWinRate * 100)}%</span>
              </div>
              <input
                type="range"
                value={config.kellyWinRate}
                onChange={(e) => { const v = Number(e.target.value); setConfig({ ...config, kellyWinRate: v }); }}
                onMouseUp={() => save({ kellyWinRate: config.kellyWinRate })}
                onTouchEnd={() => save({ kellyWinRate: config.kellyWinRate })}
                min={0.4}
                max={0.85}
                step={0.05}
                className="w-full accent-spike-cyan"
              />
              <div className="flex justify-between text-[10px] text-spike-text-muted mt-1">
                <span>40%</span>
                <span>85%</span>
              </div>
            </div>

            <p className="text-[10px] text-spike-text-muted">Kelly sizes each position based on win rate and the stock&apos;s volatility, capped at your max risk %.</p>
          </div>
        )}

        {config.mode === 'fixed' && (
          <div className="mb-5">
            <label className="text-xs text-spike-text-muted uppercase tracking-wider block mb-2">Amount Per Trade</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-spike-text-dim">$</span>
              <input
                type="number"
                value={config.fixedAmount}
                onChange={(e) => setConfig({ ...config, fixedAmount: Number(e.target.value) || 0 })}
                onBlur={() => save({ fixedAmount: config.fixedAmount })}
                className="w-full bg-spike-bg/50 border border-spike-border rounded-lg px-3 py-2.5 pl-7 text-spike-text mono focus:border-spike-cyan/50 focus:outline-none"
                min={0}
                step={100}
              />
            </div>
          </div>
        )}

        {config.mode === 'manual' && (
          <div className="mb-5 p-3 bg-spike-bg/40 rounded-lg border border-spike-border/30">
            <p className="text-xs text-spike-text-dim">You&apos;ll enter shares or dollar amount each time you lock in a spike.</p>
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full py-2.5 rounded-lg bg-spike-cyan/10 text-spike-cyan font-medium text-sm hover:bg-spike-cyan/20 transition-colors border border-spike-cyan/20"
        >
          {saving ? 'Saving...' : 'Done'}
        </button>
      </div>
    </div>
  );
}
