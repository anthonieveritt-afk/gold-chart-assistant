import { describe, expect, it } from 'vitest';
import { analyseMarket } from '../src/analysis/engine';
import { computeBias } from '../src/analysis/bias';
import { analyseStructure } from '../src/analysis/structure';
import { findSwings } from '../src/analysis/swings';
import { scoreConfluence, WEIGHTS } from '../src/analysis/confluence';
import { DEFAULT_CONFIG, type Candle } from '../src/analysis/types';
import { fromPath, fullSequence } from './helpers';

const cfg = { ...DEFAULT_CONFIG, swingLookback: 2, fvgMinAtr: 0 };

function uptrend(n: number): Candle[] {
  const legs: [number, number][] = [];
  let p = 100;
  for (let i = 0; i < n; i++) { p += 6; legs.push([p, 6]); p -= 3; legs.push([p, 3]); }
  return fromPath(100, legs);
}

describe('bias', () => {
  it('uptrend with price above rising EMAs is bullish', () => {
    const c = uptrend(30);
    const b = computeBias(c, analyseStructure(c, findSwings(c, 2)));
    expect(b.bias).toBe('bullish');
    expect(b.score).toBe(4);
  });
});

describe('confluence', () => {
  it('weights sum to 100 and the trio carries the heaviest weight', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(Math.max(...Object.values(WEIGHTS))).toBe(WEIGHTS.trio);
  });
});

describe('analyseMarket end-to-end', () => {
  it('produces an active bullish strategy entry with confluence on the scenario timeframe', () => {
    const scenario = fullSequence();
    const up = uptrend(40);
    const m = analyseMarket({
      '1d': { tf: '1d', candles: up, live: null },
      '4h': { tf: '4h', candles: up, live: null },
      '1h': { tf: '1h', candles: scenario, live: null },
    }, cfg, scenario[scenario.length - 1].time + 3600);
    expect(m.byTf['1d']!.bias.bias).toBe('bullish');
    const a = m.active.find((v) => v.tf === '1h' && v.setup.direction === 'bullish');
    expect(a).toBeDefined();
    expect(a!.htfAligned).toBe(true);
    const items = Object.fromEntries(a!.confluence.items.map((i) => [i.key, i]));
    expect(items.trio.met).toBe('yes');
    expect(items.htf.met).toBe('yes');
    expect(items.sweep.met).toBe('yes');
    expect(a!.confluence.score).toBeGreaterThanOrEqual(60);
    const direct = scoreConfluence({ setup: a!.setup, tf: '1h', biases: {}, price: NaN, ema50: NaN, ema200: NaN, zones: [] });
    expect(direct.items[0].score).toBe(WEIGHTS.trio);
  });
});
