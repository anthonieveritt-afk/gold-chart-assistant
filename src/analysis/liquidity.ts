import type { Candle, LiquidityLevel, Swing } from './types';
import { londonParts } from './util';

function firstSweep(c: Candle[], from: number, price: number, side: 'buy' | 'sell'): number | null {
  for (let j = from; j < c.length; j++) {
    if (side === 'buy' ? c[j].high > price : c[j].low < price) return c[j].time;
  }
  return null;
}

/**
 * Swing liquidity (buy-side above swing highs, sell-side below swing lows) and equal highs/lows.
 * A level is "swept" once any later candle trades beyond it (a wick is enough).
 */
export function swingLiquidity(c: Candle[], swings: Swing[], atrNow: number, eqTolAtr: number): LiquidityLevel[] {
  const out: LiquidityLevel[] = [];
  for (const s of swings) {
    const side = s.kind === 'high' ? 'buy' : 'sell';
    out.push({
      id: `liq-${s.kind}-${s.time}`, side, kind: 'swing', label: s.kind === 'high' ? 'Swing high (BSL)' : 'Swing low (SSL)',
      price: s.price, time: s.time, sweptTime: firstSweep(c, s.index + 1, s.price, side),
    });
  }
  const tol = eqTolAtr * atrNow;
  for (const kind of ['high', 'low'] as const) {
    const list = swings.filter((s) => s.kind === kind);
    for (let b = 1; b < list.length; b++) {
      for (let a = Math.max(0, b - 4); a < b; a++) {
        const s1 = list[a];
        const s2 = list[b];
        if (Math.abs(s1.price - s2.price) > tol) continue;
        const level = kind === 'high' ? Math.max(s1.price, s2.price) : Math.min(s1.price, s2.price);
        // the first swing must not have been taken out between the two touches
        let clean = true;
        for (let j = s1.index + 1; j < s2.index; j++) {
          if (kind === 'high' ? c[j].high > level : c[j].low < level) { clean = false; break; }
        }
        if (!clean) continue;
        const side = kind === 'high' ? 'buy' : 'sell';
        out.push({
          id: `eq-${kind}-${s1.time}-${s2.time}`, side, kind: 'equal', label: kind === 'high' ? 'Equal highs (BSL)' : 'Equal lows (SSL)',
          price: level, time: s1.time, sweptTime: firstSweep(c, s2.index + 1, level, side),
        });
        break;
      }
    }
  }
  return out;
}

export const ASIA_START_HOUR = 0; // London time
export const ASIA_END_HOUR = 7; // London time (exclusive)

/**
 * Key levels: previous day / week high & low (from completed daily/weekly candles) and the latest
 * Asian session range (00:00–07:00 London time, BST/GMT aware) from intraday candles.
 * Swept status is evaluated on intraday candles after the period ends.
 */
export function keyLevels(daily: Candle[], weekly: Candle[], intraday: Candle[], nowSec: number): LiquidityLevel[] {
  const out: LiquidityLevel[] = [];
  const add = (prev: Candle | undefined, span: number, hi: 'PDH' | 'PWH', lo: 'PDL' | 'PWL', name: string) => {
    if (!prev) return;
    const start = prev.time + span;
    const after = intraday.findIndex((k) => k.time >= start);
    const from = after < 0 ? intraday.length : after;
    out.push({ id: `${hi}-${prev.time}`, side: 'buy', kind: hi, label: `Prev ${name} high`, price: prev.high, time: start, sweptTime: firstSweep(intraday, from, prev.high, 'buy') });
    out.push({ id: `${lo}-${prev.time}`, side: 'sell', kind: lo, label: `Prev ${name} low`, price: prev.low, time: start, sweptTime: firstSweep(intraday, from, prev.low, 'sell') });
  };
  add([...daily].reverse().find((d) => d.time + 86400 <= nowSec), 86400, 'PDH', 'PDL', 'day');
  add([...weekly].reverse().find((w) => w.time + 604800 <= nowSec), 604800, 'PWH', 'PWL', 'week');

  // Asian session: latest London date that has candles between 00:00 and 07:00
  let key: string | null = null;
  let hi = -Infinity;
  let lo = Infinity;
  let first = -1;
  let last = -1;
  for (let i = intraday.length - 1; i >= 0; i--) {
    const p = londonParts(intraday[i].time);
    const inSession = p.hour >= ASIA_START_HOUR && p.hour < ASIA_END_HOUR;
    if (!inSession) { if (key) break; continue; }
    if (key && p.dateKey !== key) break;
    key = p.dateKey;
    hi = Math.max(hi, intraday[i].high);
    lo = Math.min(lo, intraday[i].low);
    first = i;
    if (last < 0) last = i;
  }
  if (key && first >= 0) {
    const nowP = londonParts(nowSec);
    const ended = nowP.dateKey !== key || nowP.hour >= ASIA_END_HOUR;
    const suffix = ended ? '' : ' (developing)';
    const from = ended ? last + 1 : intraday.length;
    out.push({ id: `ASH-${key}`, side: 'buy', kind: 'ASH', label: `Asian high${suffix}`, price: hi, time: intraday[first].time, sweptTime: firstSweep(intraday, from, hi, 'buy') });
    out.push({ id: `ASL-${key}`, side: 'sell', kind: 'ASL', label: `Asian low${suffix}`, price: lo, time: intraday[first].time, sweptTime: firstSweep(intraday, from, lo, 'sell') });
  }
  return out;
}
