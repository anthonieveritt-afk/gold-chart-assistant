import type { Candle, Direction, StructureEvent, StructureResult, Swing } from './types';

/**
 * Market structure from candle CLOSES (wicks never count as a break).
 * - The most recent confirmed swing high / low are the "active" levels.
 * - A close beyond an active level in the direction of the current trend = BOS.
 * - A close beyond the opposite-side level against the current trend = CHoCH
 *   (e.g. downtrend + close above the last lower-high).
 * - The very first break (no trend yet) is labelled BOS and sets the trend.
 */
export function analyseStructure(c: Candle[], swings: Swing[]): StructureResult {
  const byConfirm = new Map<number, Swing[]>();
  for (const s of swings) {
    const arr = byConfirm.get(s.confirmedIndex) ?? [];
    arr.push(s);
    byConfirm.set(s.confirmedIndex, arr);
  }
  let trend: Direction | 'none' = 'none';
  let activeHigh: Swing | null = null;
  let activeLow: Swing | null = null;
  let lastSwingHigh: Swing | null = null;
  let lastSwingLow: Swing | null = null;
  const events: StructureEvent[] = [];

  for (let i = 0; i < c.length; i++) {
    for (const s of byConfirm.get(i) ?? []) {
      if (s.kind === 'high') { activeHigh = s; lastSwingHigh = s; } else { activeLow = s; lastSwingLow = s; }
    }
    const close = c[i].close;
    if (activeHigh && i > activeHigh.index && close > activeHigh.price) {
      let oi = activeHigh.index;
      for (let j = activeHigh.index; j <= i; j++) if (c[j].low < c[oi].low) oi = j;
      events.push({
        type: trend === 'bearish' ? 'CHoCH' : 'BOS', direction: 'bullish', level: activeHigh.price,
        swingIndex: activeHigh.index, swingTime: activeHigh.time, breakIndex: i, breakTime: c[i].time,
        originIndex: oi, originPrice: c[oi].low,
      });
      trend = 'bullish';
      activeHigh = null;
    } else if (activeLow && i > activeLow.index && close < activeLow.price) {
      let oi = activeLow.index;
      for (let j = activeLow.index; j <= i; j++) if (c[j].high > c[oi].high) oi = j;
      events.push({
        type: trend === 'bullish' ? 'CHoCH' : 'BOS', direction: 'bearish', level: activeLow.price,
        swingIndex: activeLow.index, swingTime: activeLow.time, breakIndex: i, breakTime: c[i].time,
        originIndex: oi, originPrice: c[oi].high,
      });
      trend = 'bearish';
      activeLow = null;
    }
  }
  return { swings, events, trend, lastSwingHigh, lastSwingLow };
}
