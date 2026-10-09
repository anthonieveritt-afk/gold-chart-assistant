import { describe, expect, it } from 'vitest';
import { buildRiskPlan } from '../src/analysis/risk';

const base = { atr: 2, slAtrMult: 0.25, minRR: 1, tp2Candidates: [], tp3Candidates: [] };

describe('SL / TP calculation', () => {
  it('bullish: SL below leg origin minus ATR buffer, TP1 = nearest buy-side liquidity above the zone', () => {
    const r = buildRiskPlan({
      ...base, direction: 'bullish', zoneTop: 102, zoneBottom: 100, originPrice: 95, sweepPrice: 96,
      tp1Candidates: [{ price: 99, label: 'below' }, { price: 120, label: 'far' }, { price: 115, label: 'EQH' }],
    });
    expect(r.entry).toBe(101);
    expect(r.stopBase).toBe(95);
    expect(r.buffer).toBe(0.5);
    expect(r.stop).toBe(94.5);
    expect(r.risk).toBe(6.5);
    expect(r.targets[0]).toMatchObject({ name: 'TP1', price: 115, label: 'EQH' });
    expect(r.targets[0].rr).toBeCloseTo(14 / 6.5, 6);
    expect(r.targets[0].distance).toBe(14);
    expect(r.lowRR).toBe(false);
    expect(r.warning).toBeNull();
  });

  it('uses the swept liquidity level for the stop when it is further than the origin', () => {
    const r = buildRiskPlan({ ...base, direction: 'bullish', zoneTop: 102, zoneBottom: 100, originPrice: 95, sweepPrice: 94, tp1Candidates: [{ price: 130, label: 'x' }] });
    expect(r.stopBase).toBe(94);
    expect(r.stop).toBe(93.5);
    expect(r.stopReason).toMatch(/swept/);
  });

  it('TP2 = next opposing FVG / HTF liquidity beyond TP1, TP3 = next major swing beyond TP2', () => {
    const r = buildRiskPlan({
      ...base, direction: 'bullish', zoneTop: 102, zoneBottom: 100, originPrice: 95,
      tp1Candidates: [{ price: 110, label: 'PDH' }],
      tp2Candidates: [{ price: 108, label: 'too close' }, { price: 118, label: 'Bearish FVG' }, { price: 125, label: '4H BSL' }],
      tp3Candidates: [{ price: 117, label: 'not beyond TP2' }, { price: 140, label: 'Major swing high' }],
    });
    expect(r.targets.map((t) => [t.name, t.price])).toEqual([['TP1', 110], ['TP2', 118], ['TP3', 140]]);
    expect(r.targets[2].rr).toBeCloseTo(39 / 6.5, 6);
  });

  it('flags TP1 R:R below the minimum', () => {
    const r = buildRiskPlan({ ...base, direction: 'bullish', zoneTop: 102, zoneBottom: 100, originPrice: 95, tp1Candidates: [{ price: 104, label: 'near' }] });
    expect(r.tp1RR).toBeCloseTo(3 / 6.5, 6);
    expect(r.lowRR).toBe(true);
    expect(r.warning).toMatch(/below your minimum/);
  });

  it('falls back to a 2R measured target when there is no opposing liquidity', () => {
    const r = buildRiskPlan({ ...base, direction: 'bullish', zoneTop: 102, zoneBottom: 100, originPrice: 95, tp1Candidates: [] });
    expect(r.targets[0].price).toBeCloseTo(101 + 13, 6);
    expect(r.targets[0].rr).toBeCloseTo(2, 6);
    expect(r.targets.length).toBe(1);
  });

  it('bearish mirror: SL above origin plus buffer, targets below', () => {
    const r = buildRiskPlan({
      ...base, direction: 'bearish', zoneTop: 202, zoneBottom: 200, originPrice: 206, sweepPrice: 207,
      tp1Candidates: [{ price: 203, label: 'above (wrong side)' }, { price: 190, label: 'SSL' }, { price: 180, label: 'PDL' }],
      tp2Candidates: [{ price: 185, label: 'Bullish FVG' }],
    });
    expect(r.entry).toBe(201);
    expect(r.stop).toBe(207.5);
    expect(r.targets[0]).toMatchObject({ name: 'TP1', price: 190 });
    expect(r.targets[0].rr).toBeCloseTo(11 / 6.5, 6);
    expect(r.targets[1]).toMatchObject({ name: 'TP2', price: 185 });
  });
});

describe('minTarget (leg extreme already traded)', () => {
  it('ignores TP1 candidates inside the leg and falls back to the leg extreme', () => {
    const r = buildRiskPlan({ ...base, direction: 'bullish', zoneTop: 102, zoneBottom: 100, originPrice: 95, minTarget: 118,
      tp1Candidates: [{ price: 110, label: 'swept inside leg' }] });
    expect(r.targets[0].price).toBe(118);
    expect(r.targets[0].rr).toBeGreaterThan(0);
  });
  it('bearish: targets at or below the leg low only', () => {
    const r = buildRiskPlan({ ...base, direction: 'bearish', zoneTop: 100, zoneBottom: 98, originPrice: 105, minTarget: 80,
      tp1Candidates: [{ price: 90, label: 'inside' }, { price: 78, label: 'beyond' }] });
    expect(r.targets[0].price).toBe(78);
    expect(r.targets[0].rr).toBeGreaterThan(0);
  });
});
