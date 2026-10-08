import { describe, expect, it } from 'vitest';
import { detectFvgs, isIfvg, polarityAt } from '../src/analysis/fvg';
import { keyLevels, swingLiquidity } from '../src/analysis/liquidity';
import { findSwings } from '../src/analysis/swings';
import { atr, ema, londonParts } from '../src/analysis/util';
import type { Candle } from '../src/analysis/types';
import { fromPath } from './helpers';

const k = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close });

describe('FVG / IFVG', () => {
  const base = [k(0, 100, 101, 99, 100.5), k(1, 100.5, 105, 100.4, 104.8), k(2, 104.8, 106, 103, 105.5)]; // bullish gap 101..103
  it('detects a bullish FVG and its lifecycle unfilled -> partial -> mitigated -> inverted', () => {
    let f = detectFvgs(base, [1, 1, 1])[0];
    expect(f).toMatchObject({ direction: 'bullish', bottom: 101, top: 103, status: 'unfilled' });
    f = detectFvgs([...base, k(3, 105.5, 106, 102, 105)], [1, 1, 1, 1])[0];
    expect(f.status).toBe('partial');
    expect(f.fillPct).toBeCloseTo(0.5);
    f = detectFvgs([...base, k(3, 105.5, 106, 100.8, 101.5)], [1, 1, 1, 1])[0];
    expect(f.status).toBe('mitigated');
    expect(f.invertedIndex).toBeNull();
    const inv = [...base, k(3, 105.5, 106, 100, 100.5)];
    f = detectFvgs(inv, [1, 1, 1, 1])[0];
    expect(f.invertedIndex).toBe(3);
    expect(isIfvg(f)).toBe(true);
    expect(polarityAt(f)).toBe('bearish');
    // IFVG invalidated when price closes back above the top
    f = detectFvgs([...inv, k(4, 100.5, 104, 100.4, 103.5)], [1, 1, 1, 1, 1])[0];
    expect(f.ifvgInvalidatedIndex).toBe(4);
    expect(polarityAt(f)).toBeNull();
  });
  it('detects bearish FVGs and filters tiny gaps by ATR', () => {
    const bear = [k(0, 106, 107, 105, 105.5), k(1, 105.5, 105.6, 101, 101.2), k(2, 101.2, 103, 100, 100.5)];
    expect(detectFvgs(bear, [1, 1, 1])[0]).toMatchObject({ direction: 'bearish', top: 105, bottom: 103 });
    expect(detectFvgs(bear, [10, 10, 10], 0.5).length).toBe(0);
  });
});

describe('liquidity', () => {
  it('marks swing liquidity swept by later wicks and finds equal highs', () => {
    const c = fromPath(100, [[105, 5], [102, 3], [105.05, 3], [101, 4], [108, 4]]);
    const swings = findSwings(c, 2);
    const liq = swingLiquidity(c, swings, 1, 0.2);
    const eqh = liq.find((l) => l.kind === 'equal' && l.side === 'buy');
    expect(eqh).toBeDefined();
    expect(eqh!.price).toBeCloseTo(105.55, 5);
    expect(eqh!.sweptTime).not.toBeNull();
    const lastLow = liq.filter((l) => l.kind === 'swing' && l.side === 'sell').pop()!;
    expect(lastLow.sweptTime).toBeNull();
  });

  it('computes PDH/PDL, PWH/PWL and the Asian session in London time (BST aware)', () => {
    // 2026-07-15 is BST: London 00:00-07:00 = 23:00 (14th) - 06:00 UTC
    const day = Date.UTC(2026, 6, 15) / 1000;
    const intraday: Candle[] = [];
    for (let t = day - 2 * 3600; t < day + 10 * 3600; t += 900) {
      const h = (t - day) / 3600;
      const inAsia = h >= -1 && h < 6;
      const hi = inAsia ? 2005 + (h === 2 ? 3 : 0) : 2000;
      intraday.push(k(t, 2000, h === 8 ? 2010 : hi, inAsia ? 1995 : 1999, 2000));
    }
    expect(londonParts(day - 3600).hour).toBe(0);
    const daily = [k(day - 86400, 1990, 2020, 1980, 2000), k(day, 2000, 2010, 1995, 2005)];
    const weekly = [k(day - 9 * 86400, 1950, 2050, 1900, 1990)];
    const lv = keyLevels(daily, weekly, intraday, day + 10 * 3600);
    const get = (kind: string) => lv.find((l) => l.kind === kind)!;
    expect(get('PDH').price).toBe(2020);
    expect(get('PDL').price).toBe(1980);
    expect(get('PWH').price).toBe(2050);
    expect(get('ASH').price).toBe(2008);
    expect(get('ASL').price).toBe(1995);
    expect(get('ASH').sweptTime).toBe(day + 8 * 3600); // 2010 wick at 09:00 London
    expect(get('ASL').sweptTime).toBeNull();
    expect(get('PDH').sweptTime).toBeNull();
  });
});

describe('indicators', () => {
  it('EMA seeds with SMA and ATR is positive', () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e[1]).toBeNaN();
    expect(e[2]).toBe(2);
    expect(e[3]).toBe(3);
    expect(atr(fromPath(100, [[110, 10]]))[9]).toBeGreaterThan(0);
  });
});
