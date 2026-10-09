import { afterEach, describe, expect, it } from 'vitest';
import { barOverlapsSession, binanceSource, dropClosedBars, goldOpenAt, resetUsdtCache, setFetch, twelveDataSource, xauSource } from '../src/data/sources';

const utc = (s: string) => Date.parse(s) / 1000;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function kline(tSec: number, durSec: number, o: number, h: number, l: number, c: number) {
  return [tSec * 1000, String(o), String(h), String(l), String(c), '0', (tSec + durSec) * 1000 - 1];
}

afterEach(() => { setFetch((...a) => fetch(...a)); resetUsdtCache(); });

describe('gold market hours', () => {
  it('is closed at the weekend and in the daily break (summer time, NY = UTC-4)', () => {
    expect(goldOpenAt(utc('2026-10-09T09:00:00Z'))).toBe(true); // Fri morning
    expect(goldOpenAt(utc('2026-10-09T21:30:00Z'))).toBe(false); // Fri after 17:00 NY
    expect(goldOpenAt(utc('2026-10-10T12:00:00Z'))).toBe(false); // Saturday
    expect(goldOpenAt(utc('2026-10-11T21:30:00Z'))).toBe(false); // Sun before 18:00 NY
    expect(goldOpenAt(utc('2026-10-11T22:05:00Z'))).toBe(true); // Sun reopen
    expect(goldOpenAt(utc('2026-10-07T21:30:00Z'))).toBe(false); // Wed daily break
    expect(goldOpenAt(utc('2026-10-07T22:00:00Z'))).toBe(true);
  });
  it('shifts with US winter time (NY = UTC-5)', () => {
    expect(goldOpenAt(utc('2026-12-04T21:30:00Z'))).toBe(true); // Fri 16:30 NY
    expect(goldOpenAt(utc('2026-12-04T22:30:00Z'))).toBe(false);
    expect(goldOpenAt(utc('2026-12-06T22:30:00Z'))).toBe(false); // Sun 17:30 NY
    expect(goldOpenAt(utc('2026-12-06T23:05:00Z'))).toBe(true);
  });
  it('keeps a daily bar that only partly overlaps the session, drops Saturday', () => {
    expect(barOverlapsSession(utc('2026-10-11T00:00:00Z'), 86400)).toBe(true); // Sunday – reopens 22:00 UTC
    expect(barOverlapsSession(utc('2026-10-10T00:00:00Z'), 86400)).toBe(false);
    const bars = [utc('2026-10-09T00:00:00Z'), utc('2026-10-10T00:00:00Z'), utc('2026-10-11T00:00:00Z'), utc('2026-10-12T00:00:00Z')]
      .map((time) => ({ time, open: 1, high: 1, low: 1, close: 1 }));
    expect(dropClosedBars(bars, '1d').length).toBe(3);
    expect(dropClosedBars(bars, '1w').length).toBe(4);
  });
});

describe('XAU/USD keyless source', () => {
  it('converts the USDT index to USD, removes closed bars and detects the live bar', async () => {
    const now = Date.now();
    const t0 = Math.floor(now / 1000 / 3600) * 3600 - 3 * 3600;
    const urls: string[] = [];
    setFetch(async (u) => {
      const url = String(u); urls.push(url);
      if (url.includes('fapi.binance.com')) return ok([0, 1, 2, 3].map((i) => kline(t0 + i * 3600, 3600, 4000, 4010, 3990, 4005)));
      if (url.includes('coinbase')) return ok({ price: '0.999' });
      throw new Error('unexpected ' + url);
    });
    const r = await xauSource().fetchTf('1h');
    expect(r.fallback).toBeUndefined();
    const all = [...r.candles, ...(r.live ? [r.live] : [])];
    for (const c of all) expect(c.close).toBeCloseTo(4005 * 0.999, 6);
    expect(all.every((c) => goldOpenAt(c.time) || barOverlapsSession(c.time, 3600))).toBe(true);
    expect(urls.some((u) => u.includes('indexPriceKlines?pair=XAUUSDT'))).toBe(true);
  });

  it('uses Bybit index if Binance futures is unreachable', async () => {
    const t0 = utc('2026-10-07T10:00:00Z');
    setFetch(async (u) => {
      const url = String(u);
      if (url.includes('fapi.binance.com')) return new Response('', { status: 451 });
      if (url.includes('bybit')) return ok({ retCode: 0, retMsg: 'OK', result: { list: [[String((t0 + 3600) * 1000), '2', '3', '1', '2.5'], [String(t0 * 1000), '1', '2', '0.5', '2']] } });
      if (url.includes('coinbase')) return ok({ price: '1' });
      throw new Error('unexpected ' + url);
    });
    const r = await xauSource().fetchTf('1h');
    expect(r.fallback).toBeUndefined();
    expect(r.candles.map((c) => c.time)).toEqual([t0, t0 + 3600]);
    expect(r.note).toMatch(/Bybit/);
  });

  it('falls back to PAXG automatically and says so', async () => {
    const t0 = utc('2026-10-07T10:00:00Z');
    setFetch(async (u) => {
      const url = String(u);
      if (url.includes('PAXGUSDT')) return ok([kline(t0, 3600, 1, 2, 0.5, 1.5)]);
      return new Response('', { status: 500 });
    });
    const r = await xauSource().fetchTf('1h');
    expect(r.fallback).toMatch(/PAXG/);
    expect(r.candles.length).toBe(1);
  });

  it('a Twelve Data key error falls back to the keyless XAU/USD feed', async () => {
    const t0 = utc('2026-10-07T10:00:00Z');
    setFetch(async (u) => {
      const url = String(u);
      if (url.includes('twelvedata')) return ok({ status: 'error', message: 'Invalid API key' });
      if (url.includes('fapi.binance.com')) return ok([kline(t0, 3600, 1, 2, 0.5, 1.5)]);
      if (url.includes('coinbase')) return ok({ price: '1' });
      throw new Error('unexpected ' + url);
    });
    const r = await twelveDataSource('bad').fetchTf('1h');
    expect(r.fallback).toMatch(/Invalid API key/);
    expect(r.candles.length).toBe(1);
  });

  it('PAXG source still works', async () => {
    setFetch(async () => ok([kline(utc('2026-10-07T10:00:00Z'), 3600, 1, 2, 0.5, 1.5)]));
    const r = await binanceSource().fetchTf('1h');
    expect(r.candles[0].close).toBe(1.5);
  });
});

describe('3M aggregation (Twelve Data has no 3-minute interval)', () => {
  it('merges 1-minute candles into aligned 3-minute candles', async () => {
    const { aggregate } = await import('../src/data/sources');
    const t0 = 1_791_540_000; // divisible by 180
    const one = [0, 1, 2, 3].map((i) => ({ time: t0 + i * 60, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i }));
    const three = aggregate(one, 180);
    expect(three).toEqual([
      { time: t0, open: 10, high: 13, low: 9, close: 12.5 },
      { time: t0 + 180, open: 13, high: 14, low: 12, close: 13.5 },
    ]);
  });
});
