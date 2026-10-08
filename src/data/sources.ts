import type { Candle, Timeframe } from '../analysis/types';
import { TF_SECONDS } from '../analysis/types';

export interface FetchResult { candles: Candle[]; live: Candle | null }
export type SourceId = 'binance' | 'twelvedata';

export interface DataSource {
  id: SourceId;
  label: string;
  fetchTf(tf: Timeframe): Promise<FetchResult>;
  /** minimum seconds between refreshes of a timeframe */
  refreshSec(tf: Timeframe, selected: boolean): number;
}

/** Binance public market data: PAXG/USDT (PAX Gold, 1 token = 1 troy oz, tracks spot gold). No key, CORS enabled. */
const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

export function binanceSource(): DataSource {
  let hostIdx = 0;
  return {
    id: 'binance',
    label: 'PAXG/USDT (tracks spot gold) · Binance public API',
    async fetchTf(tf) {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < BINANCE_HOSTS.length; attempt++) {
        const host = BINANCE_HOSTS[(hostIdx + attempt) % BINANCE_HOSTS.length];
        try {
          const r = await fetch(`${host}/api/v3/klines?symbol=PAXGUSDT&interval=${tf}&limit=1000`);
          if (!r.ok) throw new Error(`Binance ${r.status}`);
          const rows = (await r.json()) as unknown[][];
          hostIdx = (hostIdx + attempt) % BINANCE_HOSTS.length;
          const now = Date.now();
          const all = rows.map((k) => ({
            time: Math.floor(Number(k[0]) / 1000), open: +String(k[1]), high: +String(k[2]), low: +String(k[3]), close: +String(k[4]),
            volume: +String(k[5]), closeTime: Number(k[6]),
          }));
          const last = all[all.length - 1];
          const live = last && last.closeTime >= now ? last : null;
          const strip = ({ closeTime: _c, ...rest }: (typeof all)[number]): Candle => rest;
          return { candles: (live ? all.slice(0, -1) : all).map(strip), live: live ? strip(live) : null };
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('Binance request failed');
    },
    refreshSec: () => 55,
  };
}

const TD_INTERVAL: Record<Timeframe, string> = { '1w': '1week', '1d': '1day', '4h': '4h', '1h': '1h', '15m': '15min', '5m': '5min' };

/** Twelve Data XAU/USD. Free plan: 8 requests/min, 800/day – refreshes are throttled per timeframe. */
export function twelveDataSource(apiKey: string): DataSource {
  return {
    id: 'twelvedata',
    label: 'XAU/USD spot · Twelve Data',
    async fetchTf(tf) {
      const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${TD_INTERVAL[tf]}&outputsize=1000&timezone=UTC&order=ASC&apikey=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (j.status === 'error' || !Array.isArray(j.values)) throw new Error(`Twelve Data: ${j.message ?? r.status}`);
      const all: Candle[] = (j.values as Record<string, string>[]).map((v) => ({
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
