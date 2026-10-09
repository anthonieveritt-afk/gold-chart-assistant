# Gold Chart Assistant

Static, client-side gold (XAUUSD) chart-analysis tool built around one strategy: **CHoCH → BOS → FVG**.

**Analysis aid, not financial advice.**

## What it does

| Feature | How |
|---|---|
| Strategy entries | Per timeframe, a state machine for every Change of Character: CHoCH → BOS in the same direction → FVG (or IFVG of the same polarity) created inside the displacement leg → entry when price retraces into that FVG while structure holds. Partial states are shown (`CHoCH formed – waiting for BOS`, `…waiting for FVG retest`). |
| Entry / SL / TP | Entry = FVG 50% (consequent encroachment). SL = beyond the swing that started the leg (or the swept liquidity level if further) ± ATR(14) × buffer. TP1 = nearest opposing liquidity (swing high/EQH/PDH/PWH/Asian high/leg high for longs), TP2 = next opposing FVG or higher-TF liquidity, TP3 = next major swing. Distance and R:R for each; setups with TP1 R:R below the minimum are flagged *skip*. |
| Direction | Weighted multi-timeframe score (1W, 1D, 4H, 1H, 15M, 5M). Each TF bias = structure (BOS/CHoCH from closes) + price vs EMA50 + EMA50 vs EMA200. |
| Liquidity | Buy/sell-side swing liquidity, equal highs/lows, previous day/week high & low, Asian session high/low (00:00–07:00 London time), swept vs unswept. |
| FVG / IFVG | Bullish/bearish 3-candle gaps; unfilled / partial / mitigated; inverted when a candle closes through (polarity flips). |
| Confluence | 0–100 score + grade: strategy trio 30, HTF bias 15, liquidity sweep 15, FVG/IFVG overlap 10, discount/premium 10, EMA context 10, MTF agreement 10. |

## Data

* **Default (no key): real XAU/USD spot gold** – the Binance `XAUUSDT` *index price* (`fapi.binance.com/fapi/v1/indexPriceKlines`), a weighted composite of spot gold feeds (dxFeed, Kaiko, Pyth Pro, Massive). It is quoted in USDT, so it is converted to USD with the live USDT/USD rate (Coinbase, Kraken backup). Weekend-close and daily-break bars (NY 17:00–18:00) are removed so candles look like a normal XAU/USD chart. Backup: Bybit's XAUUSDT index. The index only starts in Dec 2025, so 1W/1D history before that is extended with PAXG. If every XAU feed fails, the app falls back to PAXG automatically and shows a warning.
* The data source is switched with the **Data:** buttons above the timeframes and is remembered in the browser.
* Alternative (no key): Binance public klines **PAXG/USDT** – PAX Gold, a gold-backed token (1 token = 1 troy oz) that tracks spot gold. Served from `data-api.binance.vision` (fallback `api.binance.com`), CORS enabled.
* Optional: Twelve Data **XAU/USD** with your own free API key (Settings ⚙, stored only in your browser's localStorage). Refreshes are throttled to fit the free plan (8/min, 800/day).

## Development

```bash
npm install
npm test        # vitest – analysis modules on synthetic candles
npm run dev
npm run build   # static site in dist/
```

Code layout: `src/analysis/*` are pure, unit-tested modules (swings, structure, fvg, liquidity, bias, strategy, risk, confluence, engine); `src/ui/*` renders the TradingView lightweight-charts chart and dashboard; `src/data/*` fetches candles.

Deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main` (tests must pass).
