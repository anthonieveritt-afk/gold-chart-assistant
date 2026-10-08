import type { Candle, Direction } from './types';

export function sign(d: Direction): 1 | -1 {
  return d === 'bullish' ? 1 : -1;
}
export function opposite(d: Direction): Direction {
  return d === 'bullish' ? 'bearish' : 'bullish';
}

/** Wilder ATR. Values before `period` bars use a running mean of true range. */
export function atr(c: Candle[], period = 14): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].high - c[i].low
      : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    if (i < period) prev = (prev * i + tr) / (i + 1);
    else prev = (prev * (period - 1) + tr) / period;
    out.push(prev);
  }
  return out;
}

/** EMA; returns NaN until `period` values are available (seeded with SMA). */
export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let s = 0;
  for (let i = 0; i < period; i++) s += values[i];
  let e = s / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

const londonFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** London wall-clock parts for a unix-seconds timestamp (handles BST/GMT). */
export function londonParts(timeSec: number): { dateKey: string; hour: number; minute: number } {
  const parts = londonFmt.formatToParts(new Date(timeSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

export function fmtPrice(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return '–';
  return p.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
