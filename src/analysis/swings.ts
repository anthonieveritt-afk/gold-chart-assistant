import type { Candle, Swing } from './types';

/**
 * Pivot swings: a swing high at i has a strictly higher high than the `lookback` bars on the left
 * and a high >= every bar on the right (first bar of a flat top wins). Mirror for lows.
 * A swing is only known `lookback` bars later (confirmedIndex) – no look-ahead in structure logic.
 */
export function findSwings(c: Candle[], lookback: number): Swing[] {
  const L = Math.max(1, Math.floor(lookback));
  const out: Swing[] = [];
  for (let i = L; i < c.length - L; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - L; j <= i + L && (isHigh || isLow); j++) {
      if (j === i) continue;
      if (j < i ? c[j].high >= c[i].high : c[j].high > c[i].high) isHigh = false;
      if (j < i ? c[j].low <= c[i].low : c[j].low < c[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, time: c[i].time, price: c[i].high, kind: 'high', confirmedIndex: i + L });
    if (isLow) out.push({ index: i, time: c[i].time, price: c[i].low, kind: 'low', confirmedIndex: i + L });
  }
  return out;
}
