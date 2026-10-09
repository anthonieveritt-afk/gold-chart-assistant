import type { Candle, Timeframe } from '../analysis/types';
import { TF_SECONDS } from '../analysis/types';

export interface FetchResult {
  candles: Candle[];
  live: Candle | null;
  /** set when the preferred feed failed and a fallback was used for this timeframe */
  fallback?: string;
  /** extra info about how this series was built (shown in the footer) */
  note?: string;
}
export type SourceId = 'xau' | 'binance' | 'twelvedata';

export interface DataSource {
  id: SourceId;
  /** short label for the header */
  label: string;
  /** longer description for the footer */
  detail: string;
  fetchTf(tf: Timeframe): Promise<FetchResult>;
  /** minimum seconds between refreshes of a timeframe */
  refreshSec(tf: Timeframe, selected: boolean): number;
}

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = (...a) => fetch(...a);
/** test hook */
export function setFetch(f: FetchFn) { fetchImpl = f; }

/** fetch JSON with a timeout so a stalled request (common on mobile networks) can never freeze the app */
export async function getJson<T = unknown>(url: string, timeoutMs = 12_000): Promise<T> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(url, ctl ? { signal: ctl.signal } : undefined);
    if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
    return (await r.json()) as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error(`${new URL(url).host} timed out`);
    if (e instanceof TypeError) throw new Error(`can't reach ${new URL(url).host} (connection or network block)`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ market hours */

const nyOffsetCache = new Map<number, number>();
/** offset (seconds) of America/New_York from UTC at the given instant (cached per UTC hour) */
export function nyOffsetSec(t: number): number {
  const key = Math.floor(t / 3600);
  const hit = nyOffsetCache.get(key);
  if (hit !== undefined) return hit;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(key * 3600 * 1000));
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) / 1000;
  const off = asUtc - key * 3600;
  nyOffsetCache.set(key, off);
  return off;
}

/** Spot gold (XAU/USD) OTC hours: Sun 18:00 – Fri 17:00 New York time, with a daily break 17:00–18:00 NY. */
export function goldOpenAt(t: number): boolean {
  const d = new Date((t + nyOffsetSec(t)) * 1000);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  if (day === 6) return false;
  if (day === 0) return h >= 18;
  if (day === 5) return h < 17;
  return h !== 17;
}

/** true if any part of [t, t + dur) falls inside gold trading hours */
export function barOverlapsSession(t: number, dur: number): boolean {
  const step = Math.min(dur, 900);
  for (let s = t; s < t + dur; s += step) if (goldOpenAt(s)) return true;
  return false;
}

/** Drop candles that lie entirely inside the weekend close / daily break (weekly bars are kept). */
export function dropClosedBars<T extends Candle>(candles: T[], tf: Timeframe): T[] {
  if (tf === '1w') return candles;
  return candles.filter((c) => barOverlapsSession(c.time, TF_SECONDS[tf]));
}

/* ------------------------------------------------------------------ Binance PAXG (spot token) */

/** Binance public market data: PAXG/USDT (PAX Gold, 1 token = 1 troy oz, tracks spot gold). No key, CORS enabled. */
const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
type Kline = (string | number)[];

interface RawBar extends Candle { closeTime: number }
const fromKline = (k: Kline): RawBar => ({
  time: Math.floor(Number(k[0]) / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: Number(k[6]),
});

/** split a raw series into closed candles + the still-forming candle */
export function splitLive(all: RawBar[], nowMs: number): FetchResult {
  const last = all[all.length - 1];
  const live = last && last.closeTime >= nowMs ? last : null;
  const strip = ({ closeTime: _c, ...rest }: RawBar): Candle => rest;
  return { candles: (live ? all.slice(0, -1) : all).map(strip), live: live ? strip(live) : null };
}

async function paxgKlines(tf: Timeframe, endTimeMs?: number): Promise<RawBar[]> {
  let lastErr: unknown = null;
  for (const host of BINANCE_HOSTS) {
    try {
      const rows = await getJson<Kline[]>(`${host}/api/v3/klines?symbol=PAXGUSDT&interval=${tf}&limit=1000${endTimeMs ? `&endTime=${endTimeMs}` : ''}`);
      return rows.map(fromKline);
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Binance request failed');
}

export function binanceSource(): DataSource {
  return {
    id: 'binance',
    label: 'PAXG/USDT · gold token (24/7)',
    detail: 'PAXG/USDT from the Binance public API. PAXG is a gold-backed token (1 token = 1 troy oz) traded 24/7; it tracks spot XAU/USD closely but can differ by a few dollars and keeps trading at weekends, which slightly changes daily/weekly levels.',
    async fetchTf(tf) { return splitLive(await paxgKlines(tf), Date.now()); },
    refreshSec: () => 55,
  };
}

/* ------------------------------------------------------------------ XAU/USD spot index (keyless) */

const BYBIT_IV: Record<Timeframe, string> = { '1w': 'W', '1d': 'D', '4h': '240', '1h': '60', '15m': '15', '5m': '5' };

/** XAU/USD index candles (quoted in USDT). Binance XAUUSDT index price = weighted spot XAU/USD feeds; Bybit's index as backup. */
async function xauIndexKlines(tf: Timeframe): Promise<{ bars: RawBar[]; via: string }> {
  try {
    const rows = await getJson<Kline[]>(`https://fapi.binance.com/fapi/v1/indexPriceKlines?pair=XAUUSDT&interval=${tf}&limit=1000`);
    if (!rows.length) throw new Error('Binance XAU index: no data');
    return { bars: rows.map(fromKline), via: 'Binance' };
  } catch (e1) {
    try {
      const j = await getJson<{ retCode: number; retMsg: string; result?: { list?: string[][] } }>(`https://api.bybit.com/v5/market/index-price-kline?category=linear&symbol=XAUUSDT&interval=${BYBIT_IV[tf]}&limit=1000`);
      const list = j.result?.list;
      if (j.retCode !== 0 || !list?.length) throw new Error(`Bybit XAU index: ${j.retMsg}`);
      const bars = list.map((k) => {
        const time = Math.floor(Number(k[0]) / 1000);
        return { time, open: +k[1], high: +k[2], low: +k[3], close: +k[4], closeTime: (time + TF_SECONDS[tf]) * 1000 - 1 };
      }).sort((a, b) => a.time - b.time);
      return { bars, via: 'Bybit' };
    } catch (e2) {
      throw new Error(`XAU/USD feed unavailable (${(e1 as Error).message}; ${(e2 as Error).message})`);
    }
  }
}

let usdtCache: { rate: number; at: number; ok: boolean } | null = null;
let usdtPending: Promise<{ rate: number; ok: boolean }> | null = null;
/** USD value of 1 USDT (≈ 0.999). The index is quoted in USDT, so multiplying by this gives true USD prices. */
export function usdtUsd(nowMs = Date.now()): Promise<{ rate: number; ok: boolean }> {
  if (usdtCache && nowMs - usdtCache.at < 5 * 60_000) return Promise.resolve(usdtCache);
  if (usdtPending) return usdtPending;
  usdtPending = (async () => {
    let rate = NaN;
    try {
      const j = await getJson<{ price: string }>('https://api.exchange.coinbase.com/products/USDT-USD/ticker', 8000);
      rate = +j.price;
    } catch { /* try Kraken */ }
    if (!(rate > 0.9 && rate < 1.1)) {
      try {
        const j = await getJson<{ result?: Record<string, { c: string[] }> }>('https://api.kraken.com/0/public/Ticker?pair=USDTUSD', 8000);
        const v = j.result && Object.values(j.result)[0];
        rate = v ? +v.c[0] : NaN;
      } catch { /* give up */ }
    }
    const ok = rate > 0.9 && rate < 1.1;
    usdtCache = { rate: ok ? rate : (usdtCache?.rate ?? 1), at: nowMs, ok: ok || !!usdtCache?.ok };
    return usdtCache;
  })().finally(() => { usdtPending = null; });
  return usdtPending;
}
/** test hook */
export function resetUsdtCache() { usdtCache = null; usdtPending = null; }

const MIN_HISTORY: Partial<Record<Timeframe, number>> = { '1w': 260, '1d': 600 };

export function xauSource(): DataSource {
  return {
    id: 'xau',
    label: 'XAU/USD spot gold · live, no key',
    detail: 'XAU/USD spot gold: the Binance XAUUSDT index price, a weighted average of spot gold feeds (dxFeed, Kaiko, Pyth, Massive), converted from USDT to USD with the live USDT/USD rate (Coinbase). Weekend and daily-break bars are removed so candles match a normal XAU/USD chart; prices are typically within about $1 of broker spot (brokers add their own spread).',
    async fetchTf(tf) {
      const now = Date.now();
      let idx: { bars: RawBar[]; via: string };
      try {
        idx = await xauIndexKlines(tf);
      } catch (e) {
        // automatic fallback so the app keeps working
        const r = splitLive(await paxgKlines(tf), now);
        return { ...r, fallback: `${(e as Error).message} – showing PAXG (gold token) instead` };
      }
      const fx = await usdtUsd(now);
      const conv = (b: RawBar): RawBar => ({ ...b, open: b.open * fx.rate, high: b.high * fx.rate, low: b.low * fx.rate, close: b.close * fx.rate });
      let bars = idx.bars.map(conv);
      const notes: string[] = [];
      if (idx.via !== 'Binance') notes.push(`${tf}: index via ${idx.via}`);
      if (!fx.ok) notes.push('USDT/USD rate unavailable, prices shown in USDT (≈ ±$5)');
      // The index only exists since Dec 2025 – extend long timeframes with older PAXG history so EMA200/HTF swings work.
      const need = MIN_HISTORY[tf];
      if (need && bars.length < need && bars.length) {
        try {
          const older = (await paxgKlines(tf, bars[0].time * 1000 - 1)).filter((b) => b.time < bars[0].time);
          if (older.length) {
            bars = [...older, ...bars];
            notes.push(`${tf.toUpperCase()} history before ${new Date(idx.bars[0].time * 1000).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })} uses PAXG`);
          }
        } catch { /* fine without backfill */ }
      }
      const r = splitLive(bars, now);
      const candles = dropClosedBars(r.candles, tf);
      const live = r.live && (tf === '1w' || barOverlapsSession(r.live.time, TF_SECONDS[tf])) ? r.live : null;
      return { candles, live, note: notes.join('; ') || undefined };
    },
    refreshSec: () => 55,
  };
}

/* ------------------------------------------------------------------ Twelve Data (needs a free key) */

const TD_INTERVAL: Record<Timeframe, string> = { '1w': '1week', '1d': '1day', '4h': '4h', '1h': '1h', '15m': '15min', '5m': '5min' };

/** Twelve Data XAU/USD. Free plan: 8 requests/min, 800/day – refreshes are throttled per timeframe. */
export function twelveDataSource(apiKey: string): DataSource {
  return {
    id: 'twelvedata',
    label: 'XAU/USD spot · Twelve Data',
    detail: 'XAU/USD spot from Twelve Data (your API key, stored only in this browser).',
    async fetchTf(tf) {
      const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${TD_INTERVAL[tf]}&outputsize=1000&timezone=UTC&order=ASC&apikey=${encodeURIComponent(apiKey)}`;
      let j: { status?: string; message?: string; values?: Record<string, string>[] } = {};
      let err = '';
      try { j = await getJson(url); } catch (e) { err = (e as Error).message; }
      if (!err && (j.status === 'error' || !Array.isArray(j.values))) err = j.message ?? 'no data';
      if (err || !j.values) {
        const r = await xauSource().fetchTf(tf);
        return { ...r, fallback: `Twelve Data: ${err.slice(0, 120)} – showing keyless XAU/USD instead` };
      }
      const all: Candle[] = j.values.map((v) => ({
        time: Math.floor(Date.parse(v.datetime.length <= 10 ? `${v.datetime}T00:00:00Z` : `${v.datetime.replace(' ', 'T')}Z`) / 1000),
        open: +v.open, high: +v.high, low: +v.low, close: +v.close,
      })).sort((a, b) => a.time - b.time);
      const last = all[all.length - 1];
      const live = last && last.time + TF_SECONDS[tf] > Date.now() / 1000 ? last : null;
      return { candles: live ? all.slice(0, -1) : all, live };
    },
    refreshSec(tf, selected) {
      if (selected) return 115;
      return { '5m': 300, '15m': 300, '1h': 900, '4h': 1800, '1d': 3600, '1w': 3600 }[tf];
    },
  };
}
