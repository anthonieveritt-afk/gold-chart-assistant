import type { Candle, Direction, Fvg } from './types';
import { opposite } from './util';

/**
 * 3-candle fair value gaps.
 * Bullish: low[i+1] > high[i-1] -> gap [high[i-1], low[i+1]].  Bearish: high[i+1] < low[i-1].
 * Lifecycle (closed candles only): unfilled -> partial (wick into gap) -> mitigated (traded fully through).
 * A CLOSE through the far side inverts it into an IFVG of the opposite polarity; a later close back
 * through the other side invalidates the IFVG.
 */
export function detectFvgs(c: Candle[], atrArr: number[], minAtr = 0): Fvg[] {
  const out: Fvg[] = [];
  for (let i = 1; i < c.length - 1; i++) {
    const a = c[i - 1];
    const b = c[i + 1];
    let dir: Direction | null = null;
    let top = 0;
    let bottom = 0;
    if (b.low > a.high) { dir = 'bullish'; bottom = a.high; top = b.low; }
    else if (b.high < a.low) { dir = 'bearish'; top = a.low; bottom = b.high; }
    if (!dir) continue;
    if (top - bottom < minAtr * (atrArr[i] ?? 0)) continue;
    const f: Fvg = {
      id: `fvg-${c[i].time}-${dir}`, direction: dir, top, bottom, index: i, time: a.time,
      status: 'unfilled', fillPct: 0, mitigatedIndex: null, invertedIndex: null, ifvgInvalidatedIndex: null,
    };
    trackFvg(f, c, i + 2);
    out.push(f);
  }
  return out;
}

function trackFvg(f: Fvg, c: Candle[], from: number) {
  const size = f.top - f.bottom;
  for (let j = from; j < c.length; j++) {
    const k = c[j];
    if (f.invertedIndex === null) {
      if (f.direction === 'bullish') {
        if (k.low < f.top) f.fillPct = Math.max(f.fillPct, Math.min(1, (f.top - k.low) / size));
        if (k.close < f.bottom) f.invertedIndex = j;
      } else {
        if (k.high > f.bottom) f.fillPct = Math.max(f.fillPct, Math.min(1, (k.high - f.bottom) / size));
        if (k.close > f.top) f.invertedIndex = j;
      }
      if (f.fillPct > 0 && f.status === 'unfilled') f.status = 'partial';
      if (f.fillPct >= 1 && f.mitigatedIndex === null) { f.status = 'mitigated'; f.mitigatedIndex = j; }
    } else if (j > f.invertedIndex) {
      // IFVG: polarity flipped
      const inv = opposite(f.direction);
      if ((inv === 'bearish' && k.close > f.top) || (inv === 'bullish' && k.close < f.bottom)) {
        f.ifvgInvalidatedIndex = j;
        return;
      }
    }
  }
}

/** Polarity of the zone at bar `at` (defaults to latest): IFVGs act with the opposite polarity. */
export function polarityAt(f: Fvg, at = Infinity): Direction | null {
  if (f.invertedIndex === null || f.invertedIndex > at) return f.direction;
  if (f.ifvgInvalidatedIndex !== null && f.ifvgInvalidatedIndex <= at) return null;
  return opposite(f.direction);
}

export function isIfvg(f: Fvg, at = Infinity): boolean {
  return f.invertedIndex !== null && f.invertedIndex <= at;
}

/** Zones still "alive" now: unmitigated FVGs and valid IFVGs. */
export function activeZones(fvgs: Fvg[]): Fvg[] {
  return fvgs.filter((f) => (f.invertedIndex === null ? f.status !== 'mitigated' : f.ifvgInvalidatedIndex === null));
}
