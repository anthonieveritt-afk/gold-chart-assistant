import { describe, expect, it } from 'vitest';
import { findSwings } from '../src/analysis/swings';
import { analyseStructure } from '../src/analysis/structure';
import { detectFvgs } from '../src/analysis/fvg';
import { swingLiquidity } from '../src/analysis/liquidity';
import { detectSetups } from '../src/analysis/strategy';
import { atr } from '../src/analysis/util';
import { DEFAULT_CONFIG, type Candle } from '../src/analysis/types';
import { BOS_LEG, CHOCH_LEG, DOWNTREND, fromPath, fullSequence, PULLBACK, RALLY, RETEST } from './helpers';

const cfg = { ...DEFAULT_CONFIG, swingLookback: 2, fvgMinAtr: 0 };

function run(c: Candle[], live: Candle | null = null) {
  const a = atr(c);
  const swings = findSwings(c, cfg.swingLookback);
  const st = analyseStructure(c, swings);
  const fvgs = detectFvgs(c, a, cfg.fvgMinAtr);
  const liq = swingLiquidity(c, swings, a[a.length - 1], cfg.eqTolAtr);
  const setups = detectSetups(c, st, fvgs, { cfg, atr: a, liquidity: liq, htfLiquidity: [], live });
  return { a, swings, st, fvgs, liq, setups };
}

describe('structure: CHoCH vs BOS (closes only)', () => {
  it('labels the first break against a downtrend as CHoCH and the continuation as BOS', () => {
    const { st } = run(fullSequence());
    const seq = st.events.map((e) => `${e.type}:${e.direction}`);
    const ci = seq.indexOf('CHoCH:bullish');
    expect(ci).toBeGreaterThan(0);
    expect(seq.slice(0, ci).every((s) => s.endsWith('bearish'))).toBe(true);
    expect(seq[ci + 1]).toBe('BOS:bullish');
    const choch = st.events[ci];
    expect(choch.level).toBeCloseTo(104.1, 5); // last lower-high
    expect(choch.originPrice).toBeCloseTo(100.5, 5); // sweep low starts the leg
  });

  it('a wick through a level without a close is not a break', () => {
    const { st } = run(fromPath(110, DOWNTREND));
    // the final leg wicks below the 100.7 swing low but closes above it
    expect(st.events.some((e) => e.direction === 'bearish' && Math.abs(e.level - 100.7) < 1e-6)).toBe(false);
  });
});

describe('strategy state machine: CHoCH -> BOS -> FVG -> retest', () => {
  it('detects the full sequence and triggers on the FVG retest', () => {
    const { setups } = run(fullSequence());
    const s = setups.find((x) => x.direction === 'bullish')!;
    expect(s.trioComplete).toBe(true);
    expect(s.state).toBe('triggered');
    expect(s.label).toContain('Strategy setup: CHoCH + BOS + FVG');
    expect(s.bos!.breakIndex).toBeGreaterThan(s.choch.breakIndex);
    // the strategy FVG sits inside the displacement leg (origin -> BOS bar)
    expect(s.fvg!.index).toBeGreaterThan(s.originIndex);
    expect(s.fvg!.index).toBeLessThanOrEqual(s.bos!.breakIndex);
    expect(s.fvg!.bottom).toBeCloseTo(107.9, 5);
    expect(s.fvg!.top).toBeCloseTo(108.9, 5);
    expect(s.triggerIndex).toBeGreaterThan(s.bos!.breakIndex);
    expect(s.sweep).not.toBeNull();
    expect(s.sweep!.price).toBeCloseTo(100.7, 5);
    // risk plan
    const r = s.risk!;
    expect(r.entry).toBeCloseTo(108.4, 5); // 50% CE
    expect(r.stop).toBeLessThan(100.5);
    expect(r.targets[0].name).toBe('TP1');
    expect(r.targets[0].price).toBeCloseTo(118.5, 5); // leg high = nearest buy-side liquidity
    expect(r.targets[0].rr).toBeGreaterThan(1);
    expect(r.lowRR).toBe(false);
  });

  it('shows partial states while the setup develops', () => {
    const chochOnly = run(fromPath(110, [...DOWNTREND, ...CHOCH_LEG, ...PULLBACK])).setups.find((x) => x.direction === 'bullish')!;
    expect(chochOnly.state).toBe('choch');
    expect(chochOnly.label).toBe('CHoCH formed – waiting for BOS');
    expect(chochOnly.trioComplete).toBe(false);

    const waiting = run(fromPath(110, [...DOWNTREND, ...CHOCH_LEG, ...PULLBACK, ...BOS_LEG, ...RALLY])).setups.find((x) => x.direction === 'bullish')!;
    expect(waiting.state).toBe('waiting_retest');
    expect(waiting.trioComplete).toBe(true);
    expect(waiting.label).toContain('waiting for FVG retest');
    expect(waiting.risk).not.toBeNull();
  });

  it('uses the live candle wick for the trigger', () => {
    const c = fromPath(110, [...DOWNTREND, ...CHOCH_LEG, ...PULLBACK, ...BOS_LEG, ...RALLY, [112, 6]]);
    const last = c[c.length - 1];
    const live: Candle = { time: last.time + 3600, open: 112, high: 112.3, low: 108.6, close: 109 };
    const s = run(c, live).setups.find((x) => x.direction === 'bullish')!;
    expect(s.state).toBe('triggered');
    expect(s.triggerIndex).toBe(c.length);
  });

  it('records TP1 hit and stop-outs after the trigger', () => {
    const win = run(fullSequence([[120, 8]])).setups.find((x) => x.direction === 'bullish')!;
    expect(win.state).toBe('tp1_hit');
    const loss = run(fullSequence([[96, 10]])).setups.find((x) => x.direction === 'bullish')!;
    expect(loss.state).toBe('stopped');
  });
});

describe('strategy negative cases', () => {
  it('BOS without a prior CHoCH never produces a setup', () => {
    const up = fromPath(100, [[104, 5], [102.4, 2], [108, 3], [106, 2], [112, 3], [110, 2], [116, 3], [114, 2]]);
    const { st, setups, fvgs } = run(up);
    expect(st.events.length).toBeGreaterThan(1);
    expect(st.events.every((e) => e.type === 'BOS')).toBe(true);
    expect(fvgs.some((f) => f.direction === 'bullish')).toBe(true);
    expect(setups.length).toBe(0);
  });

  it('an FVG outside the CHoCH/BOS leg does not complete the trio', () => {
    // CHoCH and BOS legs are made of small steps (no FVG); the displacement FVG appears only after the BOS
    const c = fromPath(110, [...DOWNTREND, [107, 8], [105.4, 2], [111.4, 8], [117.4, 3], [116, 2]]);
    const { setups, fvgs } = run(c);
    const s = setups.find((x) => x.direction === 'bullish')!;
    expect(fvgs.some((f) => f.direction === 'bullish' && f.index > s.bos!.breakIndex)).toBe(true);
    expect(s.bos).not.toBeNull();
    expect(s.fvg).toBeNull();
    expect(s.trioComplete).toBe(false);
    expect(s.state).toBe('bos_no_fvg');
  });

  it('a close back below the leg origin invalidates the setup', () => {
    const c = fromPath(110, [...DOWNTREND, ...CHOCH_LEG, [99, 4], [100, 2]]);
    const s = run(c).setups.find((x) => x.direction === 'bullish')!;
    expect(s.state).toBe('invalidated');
    expect(s.trioComplete).toBe(false);
    expect(s.invalidReason).toMatch(/opposite|leg origin/);
  });

  it('a candle that gaps entirely through the FVG and closes beyond it invalidates before entry', () => {
    const c = fromPath(110, [...DOWNTREND, ...CHOCH_LEG, ...PULLBACK, ...BOS_LEG, ...RALLY]);
    const last = c[c.length - 1];
    c.push({ time: last.time + 3600, open: 107.5, high: 107.7, low: 106, close: 106.2 }); // high below FVG bottom 107.9
    const s = run(c).setups.find((x) => x.direction === 'bullish')!;
    expect(s.state).toBe('invalidated');
    expect(s.invalidReason).toBe('FVG closed through before entry');
  });

  it('a wick into the FVG counts as the retest even if that candle closes through it', () => {
    const c = fromPath(110, [...DOWNTREND, ...CHOCH_LEG, ...PULLBACK, ...BOS_LEG, ...RALLY]);
    const last = c[c.length - 1];
    c.push({ time: last.time + 3600, open: 112, high: 112.2, low: 106, close: 106.2 });
    const s = run(c).setups.find((x) => x.direction === 'bullish')!;
    expect(s.state).toBe('triggered');
  });

  it('bearish mirror: CHoCH down -> BOS down -> bearish FVG retest triggers a short', () => {
    const mirror = fullSequence().map((k) => ({ time: k.time, open: 300 - k.open, close: 300 - k.close, high: 300 - k.low, low: 300 - k.high }));
    const s = run(mirror).setups.find((x) => x.direction === 'bearish')!;
    expect(s.trioComplete).toBe(true);
    expect(s.state).toBe('triggered');
    expect(s.risk!.stop).toBeGreaterThan(s.originPrice);
    expect(s.risk!.targets[0].price).toBeLessThan(s.risk!.entry);
  });
});

describe('targets never sit inside the move price already made (Anthoni 1H report, 9 Oct)', () => {
  /** a buy-side level that existed before the BOS and was taken by the rally afterwards (e.g. an old swing high / PDH) */
  function withTakenLevel(c: Candle[], price: number) {
    const swept = c.find((k, i) => i > 30 && k.high > price)!;
    const a = atr(c);
    const swings = findSwings(c, cfg.swingLookback);
    const st = analyseStructure(c, swings);
    const fvgs = detectFvgs(c, a, cfg.fvgMinAtr);
    const liq = [...swingLiquidity(c, swings, a[a.length - 1], cfg.eqTolAtr),
      { id: 'pdh', side: 'buy' as const, kind: 'PDH' as const, label: 'PDH', price, time: c[0].time, sweptTime: swept.time }];
    return { c, setups: detectSetups(c, st, fvgs, { cfg, atr: a, liquidity: liq, htfLiquidity: [] }) };
  }

  it('untested long: TP1 is at/above the leg high and above current price, never a level already swept', () => {
    const { c, setups } = withTakenLevel(fromPath(110, [...DOWNTREND, ...CHOCH_LEG, ...PULLBACK, ...BOS_LEG, ...RALLY, [116.5, 2]]), 112);
    const s = setups.find((x) => x.direction === 'bullish')!;
    expect(s.state).toBe('waiting_retest');
    const r = s.risk!;
    const price = c[c.length - 1].close;
    const legHigh = Math.max(...c.slice(s.originIndex).map((k) => k.high));
    for (const t of r.targets) {
      expect(t.price).toBeGreaterThan(r.entry);
      expect(t.price).toBeGreaterThanOrEqual(legHigh - 1e-9);
      expect(t.price).toBeGreaterThan(price);
      expect(t.rr).toBeGreaterThan(0);
    }
    expect(r.targets.some((t) => Math.abs(t.price - 112) < 1e-9)).toBe(false);
    // price ran most of the way to TP1 without a retest -> explicit "don't chase" note
    expect(s.note).toMatch(/Don't chase/);
  });

  it('the live candle extending the leg pushes TP1 beyond it', () => {
    const c = fromPath(110, [...DOWNTREND, ...CHOCH_LEG, ...PULLBACK, ...BOS_LEG, ...RALLY]);
    const last = c[c.length - 1];
    const live: Candle = { time: last.time + 3600, open: 118, high: 121, low: 117.8, close: 120.5 };
    const s = run(c, live).setups.find((x) => x.direction === 'bullish')!;
    expect(s.state).toBe('waiting_retest');
    expect(s.risk!.targets[0].price).toBeGreaterThanOrEqual(121);
  });

  it('triggered long: liquidity swept before the entry is not used as TP1', () => {
    const { setups } = withTakenLevel(fullSequence(), 112);
    const s = setups.find((x) => x.direction === 'bullish')!;
    expect(s.state).toBe('triggered');
    expect(s.risk!.targets[0].price).toBeCloseTo(118.5, 5);
    expect(s.note).toBeNull();
  });

  it('bearish mirror: short targets are below the leg low and below current price', () => {
    const base = fromPath(110, [...DOWNTREND, ...CHOCH_LEG, ...PULLBACK, ...BOS_LEG, ...RALLY, [116.5, 2]]);
    const mirror = base.map((k) => ({ time: k.time, open: 300 - k.open, close: 300 - k.close, high: 300 - k.low, low: 300 - k.high }));
    const { c, setups } = withTakenLevelBear(mirror, 188);
    const s = setups.find((x) => x.direction === 'bearish')!;
    const price = c[c.length - 1].close;
    for (const t of s.risk!.targets) { expect(t.price).toBeLessThan(price); expect(t.price).toBeLessThan(s.risk!.entry); }
    expect(s.risk!.targets.some((t) => Math.abs(t.price - 188) < 1e-9)).toBe(false);
  });

  function withTakenLevelBear(c: Candle[], price: number) {
    const swept = c.find((k, i) => i > 30 && k.low < price)!;
    const a = atr(c);
    const swings = findSwings(c, cfg.swingLookback);
    const st = analyseStructure(c, swings);
    const fvgs = detectFvgs(c, a, cfg.fvgMinAtr);
    const liq = [...swingLiquidity(c, swings, a[a.length - 1], cfg.eqTolAtr),
      { id: 'pdl', side: 'sell' as const, kind: 'PDL' as const, label: 'PDL', price, time: c[0].time, sweptTime: swept.time }];
    return { c, setups: detectSetups(c, st, fvgs, { cfg, atr: a, liquidity: liq, htfLiquidity: [] }) };
  }
});
