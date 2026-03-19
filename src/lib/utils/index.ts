import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number, decimals = 2): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatNumber(value: number, decimals = 0): string {
  return new Intl.NumberFormat('en-CA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value: number, decimals = 2): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatVolume(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toString();
}

export function formatMarketCap(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return formatCurrency(value);
}

export function getScoreColor(score: number): string {
  if (score >= 80) return 'text-spike-green';
  if (score >= 60) return 'text-spike-cyan';
  if (score >= 40) return 'text-spike-amber';
  return 'text-spike-red';
}

export function getScoreBgColor(score: number): string {
  if (score >= 80) return 'bg-spike-green/20';
  if (score >= 60) return 'bg-spike-cyan/20';
  if (score >= 40) return 'bg-spike-amber/20';
  return 'bg-spike-red/20';
}

export function getReturnColor(value: number): string {
  if (value > 0) return 'text-spike-green';
  if (value < 0) return 'text-spike-red';
  return 'text-spike-text-dim';
}

export function isMarketOpen(): boolean {
  const now = new Date();
  const estHour = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  ).getHours();
  const day = now.getDay();
  return day >= 1 && day <= 5 && estHour >= 9 && estHour < 16;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk<T>(arr: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );
}

export function calculateKellyFraction(
  winRate: number,
  avgWin: number,
  avgLoss: number
): number {
  if (avgLoss === 0) return 0;
  const b = avgWin / Math.abs(avgLoss);
  const kelly = winRate - (1 - winRate) / b;
  // Half-Kelly for safety, capped at 2% per position
  return Math.min(Math.max(kelly * 0.5, 0), 0.02);
}
