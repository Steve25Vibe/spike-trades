import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Parse a date string (e.g. "2026-03-20") as a local date without UTC shift.
 * new Date("2026-03-20") treats it as UTC midnight, which shifts to previous day
 * in timezones west of UTC. This adds T12:00:00 to keep it on the correct day.
 */
export function parseLocalDate(dateStr: string | Date): Date {
  if (dateStr instanceof Date) {
    // If already a Date, extract the ISO date part and re-parse as local noon
    const iso = dateStr.toISOString().split('T')[0];
    return new Date(iso + 'T12:00:00');
  }
  // For ISO date strings like "2026-03-20" or "2026-03-20T..."
  const datePart = String(dateStr).split('T')[0];
  return new Date(datePart + 'T12:00:00');
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
  if (!isTradingDay(now)) return false;
  const estHour = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  ).getHours();
  return estHour >= 9 && estHour < 16;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk<T>(arr: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );
}

// TSX holiday computation — covers all 10 statutory TSX closures
function computeEaster(year: number): Date {
  // Anonymous Gregorian algorithm
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  const firstDay = first.getDay();
  let date = 1 + ((weekday - firstDay + 7) % 7) + (n - 1) * 7;
  return new Date(year, month, date);
}

function formatMMDD(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTsxHolidays(year: number): Set<string> {
  const holidays = new Set<string>();

  // New Year's Day — Jan 1
  holidays.add('01-01');

  // Family Day — 3rd Monday in February
  holidays.add(formatMMDD(nthWeekday(year, 1, 1, 3)));

  // Good Friday — Friday before Easter Sunday
  const easter = computeEaster(year);
  const goodFriday = new Date(easter);
  goodFriday.setDate(easter.getDate() - 2);
  holidays.add(formatMMDD(goodFriday));

  // Victoria Day — last Monday on or before May 24
  const may24 = new Date(year, 4, 24);
  const vicDow = may24.getDay();
  const victoriaDay = new Date(year, 4, 24 - ((vicDow + 6) % 7));
  holidays.add(formatMMDD(victoriaDay));

  // Canada Day — Jul 1 (observed Monday if falls on Sunday)
  const jul1 = new Date(year, 6, 1);
  if (jul1.getDay() === 0) {
    holidays.add('07-02'); // Observed Monday
  } else {
    holidays.add('07-01');
  }

  // Civic Holiday — 1st Monday in August (TSX closes)
  holidays.add(formatMMDD(nthWeekday(year, 7, 1, 1)));

  // Labour Day — 1st Monday in September
  holidays.add(formatMMDD(nthWeekday(year, 8, 1, 1)));

  // Thanksgiving — 2nd Monday in October
  holidays.add(formatMMDD(nthWeekday(year, 9, 1, 2)));

  // Christmas Day & Boxing Day — with weekend observation
  const dec25 = new Date(year, 11, 25);
  const dec25dow = dec25.getDay();
  if (dec25dow === 0) {
    // Christmas Sunday → observed Mon Dec 26, Boxing → Tue Dec 27
    holidays.add('12-26');
    holidays.add('12-27');
  } else if (dec25dow === 6) {
    // Christmas Saturday → observed Mon Dec 27, Boxing → Tue Dec 28
    holidays.add('12-27');
    holidays.add('12-28');
  } else {
    holidays.add('12-25');
    const dec26dow = (dec25dow + 1) % 7;
    if (dec26dow === 6) {
      // Boxing Day Saturday → observed Mon Dec 28
      holidays.add('12-28');
    } else {
      holidays.add('12-26');
    }
  }

  return holidays;
}

const _holidayCache = new Map<number, Set<string>>();
function getCachedHolidays(year: number): Set<string> {
  if (!_holidayCache.has(year)) {
    _holidayCache.set(year, getTsxHolidays(year));
  }
  return _holidayCache.get(year)!;
}

export function isTradingDay(d: Date): boolean {
  const day = d.getDay();
  if (day === 0 || day === 6) return false; // Weekend
  const mmdd = formatMMDD(d);
  return !getCachedHolidays(d.getFullYear()).has(mmdd);
}

// Subtract N trading days from a date (skips weekends and TSX holidays)
export function subtractTradingDays(from: Date, tradingDays: number): Date {
  const result = new Date(from);
  let remaining = tradingDays;
  while (remaining > 0) {
    result.setDate(result.getDate() - 1);
    if (isTradingDay(result)) remaining--;
  }
  return result;
}

// Add N trading days to a date (skips weekends and TSX holidays)
export function addTradingDays(from: Date, tradingDays: number): Date {
  const result = new Date(from);
  let remaining = tradingDays;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    if (isTradingDay(result)) remaining--;
  }
  return result;
}

// Count trading days between two dates
export function countTradingDays(from: Date, to: Date): number {
  let count = 0;
  const current = new Date(from);
  while (current < to) {
    current.setDate(current.getDate() + 1);
    if (isTradingDay(current)) count++;
  }
  return count;
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
