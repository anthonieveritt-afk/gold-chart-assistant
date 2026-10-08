import type { Candle } from '../src/analysis/types';

/** Build candles that walk linearly between waypoints. Each leg = [target, bars].
 *  With wick w, consecutive same-direction steps > 2w create FVGs; steps <= 2w do not. */
export function fromPath(start: number, legs: [number, number][], wick = 0.5, t0 = 1_700_000_000, step = 3600): Candle[] {
  const out: Candle[] = [];
  let p = start;
  let t = t0;
  for (const [target, bars] of legs) {
    const inc = (target - p) / bars;
    for (let k = 0; k < bars; k++) {
      const o = p;
      const cl = +(p + inc).toFixed(6);
      out.push({ time: t, open: o, high: Math.max(o, cl) + wick, low: Math.min(o, cl) - wick, close: cl });
      p = cl;
      t += step;
    }
  }
  return out;
}

/** Downtrend -> sell-side sweep -> displacement CHoCH (FVG) -> pullback -> displacement BOS (FVG) -> rally */
export const DOWNTREND: [number, number][] = [
  [106, 5], [108.4, 3], [103.6, 6], [106, 3], [101.2, 6], [103.6, 3],
  [101.0, 3], // wick sweeps the prior swing low (100.7) without closing below it
];
export const CHOCH_LEG: [number, number][] = [[107, 3]]; // +2 per bar: displacement, closes above LH 104.1
export const PULLBACK: [number, number][] = [[105.4, 2]];
export const BOS_LEG: [number, number][] = [[111.4, 3]]; // +2 per bar: BOS through 107.5, FVG [107.9,108.9]
export const RALLY: [number, number][] = [[118, 8]];
export const RETEST: [number, number][] = [[108.4, 12]]; // wicks into the BOS-leg FVG

export function fullSequence(extra: [number, number][] = []): Candle[] {
  return fromPath(110, [...DOWNTREND, ...CHOCH_LEG, ...PULLBACK, ...BOS_LEG, ...RALLY, ...RETEST, ...extra]);
}
