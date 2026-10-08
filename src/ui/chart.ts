import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { MarketAnalysis, SetupView, TfAnalysis } from '../analysis/engine';
import { activeZones, polarityAt } from '../analysis/fvg';
import { ema } from '../analysis/util';
import { OverlayPrimitive, type LineShape, type RectShape } from './overlay';
import { fmtDate, fmtPrice, fmtTime } from './format';

export interface Toggles { fvg: boolean; ifvg: boolean; liquidity: boolean; swings: boolean; structure: boolean; plan: boolean; ema: boolean }
export const DEFAULT_TOGGLES: Toggles = { fvg: true, ifvg: true, liquidity: true, swings: false, structure: true, plan: true, ema: true };

const C = {
  bull: '#26a69a', bear: '#ef5350', bullFill: 'rgba(38,166,154,0.13)', bearFill: 'rgba(239,83,80,0.13)',
  strat: '#ffd54f', stratFill: 'rgba(255,213,79,0.22)', liqBuy: '#4fc3f7', liqSell: '#ba68c8', key: '#ffb74d',
  entry: '#42a5f5', sl: '#ff1744', tp: '#00e676', text: '#d1d4dc',
};

export class GoldChart {
  readonly chart: IChartApi;
  private series: ISeriesApi<'Candlestick'>;
  private ema50: ISeriesApi<'Line'>;
  private ema200: ISeriesApi<'Line'>;
  private overlay = new OverlayPrimitive();
  private markers: ISeriesMarkersPluginApi<Time>;
  private priceLines: IPriceLine[] = [];
  private lastKey = '';
  slAtrMult = 0.25;

  constructor(el: HTMLElement) {
    this.chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0f1115' }, textColor: C.text, fontSize: 11 },
      grid: { vertLines: { color: '#1c2030' }, horzLines: { color: '#1c2030' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: {
        borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 8,
        tickMarkFormatter: (t: Time, type: number) => (type <= 2 ? fmtDate(t as number) : fmtTime(t as number)),
      },
      localization: { timeFormatter: (t: Time) => `${fmtDate(t as number)} ${fmtTime(t as number)} UK`, priceFormatter: (p: number) => fmtPrice(p) },
    });
    this.series = this.chart.addSeries(CandlestickSeries, {
      upColor: C.bull, downColor: C.bear, borderUpColor: C.bull, borderDownColor: C.bear, wickUpColor: C.bull, wickDownColor: C.bear,
    });
    this.ema50 = this.chart.addSeries(LineSeries, { color: '#90caf9', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: 'EMA50' });
    this.ema200 = this.chart.addSeries(LineSeries, { color: '#f48fb1', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: 'EMA200' });
    this.series.attachPrimitive(this.overlay);
    this.markers = createSeriesMarkers(this.series, []);
  }

  update(A: TfAnalysis, m: MarketAnalysis, tg: Toggles, selected: SetupView | null) {
    const bars = A.live ? [...A.candles, A.live] : A.candles;
    const times = bars.map((b) => b.time);
    this.series.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    const closes = bars.map((b) => b.close);
    const e50 = ema(closes, 50);
    const e200 = ema(closes, 200);
    const line = (arr: number[]) => (tg.ema ? arr.map((v, i) => ({ time: times[i] as UTCTimestamp, value: v })).filter((p) => isFinite(p.value)) : []);
    this.ema50.setData(line(e50));
    this.ema200.setData(line(e200));

    const key = `${A.tf}|${bars.length ? bars[0].time : 0}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const n = bars.length;
      const span = window.innerWidth < 760 ? 70 : 160;
      this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - span), to: n + 6 });
    }

    const rects: RectShape[] = [];
    const lines: LineShape[] = [];
    const n = A.candles.length;
    const recentFrom = A.candles[Math.max(0, n - 400)]?.time ?? 0;
    const stratFvgId = selected?.tf === A.tf ? selected.setup.fvg?.id : undefined;

    // FVG / IFVG boxes (active zones only, plus the strategy FVG)
    for (const f of A.fvgs) {
      const isStrat = f.id === stratFvgId;
      const alive = activeZones([f]).length > 0;
      if (!isStrat && (!alive || f.time < recentFrom)) continue;
      const pol = polarityAt(f);
      const inverted = f.invertedIndex !== null;
      if (!isStrat && inverted && !tg.ifvg) continue;
      if (!isStrat && !inverted && !tg.fvg) continue;
      if (isStrat && !(tg.fvg || tg.plan)) continue;
      const bull = (pol ?? f.direction) === 'bullish';
      const t1 = inverted ? A.candles[f.invertedIndex!].time : f.time;
      const status = inverted ? 'IFVG' : `FVG ${f.status === 'partial' ? `(${Math.round(f.fillPct * 100)}% filled)` : ''}`;
      rects.push({
        t1, t2: null, top: f.top, bottom: f.bottom,
        fill: isStrat ? C.stratFill : bull ? C.bullFill : C.bearFill,
        stroke: isStrat ? C.strat : bull ? C.bull : C.bear, dash: inverted && !isStrat ? [4, 3] : undefined, width: isStrat ? 2 : 1,
        label: isStrat ? `★ Strategy FVG ${fmtPrice(f.bottom)}–${fmtPrice(f.top)}` : `${bull ? '▲' : '▼'} ${status}`,
      });
    }

    // Liquidity
    if (tg.liquidity) {
      const price = m.price;
      const unswept = A.liquidity.filter((l) => l.sweptTime === null && l.time >= recentFrom);
      const above = unswept.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, 4);
      const below = unswept.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, 4);
      for (const l of [...above, ...below]) {
        lines.push({ t1: l.time, t2: null, price: l.price, color: l.side === 'buy' ? C.liqBuy : C.liqSell, dash: l.kind === 'equal' ? undefined : [6, 4], label: `${l.kind === 'equal' ? (l.side === 'buy' ? 'EQH' : 'EQL') : l.side === 'buy' ? 'BSL' : 'SSL'} ${fmtPrice(l.price)}`, labelAlign: 'right' });
      }
      const recentSwept = A.liquidity.filter((l) => l.sweptTime !== null && l.sweptTime >= (A.candles[Math.max(0, n - 120)]?.time ?? 0)).slice(-6);
      for (const l of recentSwept) {
        lines.push({ t1: l.time, t2: l.sweptTime, price: l.price, color: 'rgba(160,160,160,0.6)', dash: [2, 3], label: `${l.side === 'buy' ? 'BSL' : 'SSL'} swept ✕`, labelAlign: 'right' });
      }
      for (const l of m.keyLevels) {
        lines.push({ t1: l.time, t2: null, price: l.price, color: C.key, width: 1, dash: l.sweptTime ? [2, 4] : [8, 3], label: `${l.kind} ${fmtPrice(l.price)}${l.sweptTime ? ' (swept)' : ''}`, labelAlign: 'left' });
      }
    }

    // CHoCH / BOS
    if (tg.structure) {
      for (const e of A.structure.events.slice(-30)) {
        const col = e.direction === 'bullish' ? C.bull : C.bear;
        lines.push({ t1: e.swingTime, t2: e.breakTime, price: e.level, color: col, width: e.type === 'CHoCH' ? 2 : 1, dash: e.type === 'CHoCH' ? [5, 3] : undefined, label: e.type, labelAlign: 'center', labelAbove: e.direction === 'bullish' });
      }
    }

    // Markers: swings + entry trigger
    const mk: SeriesMarker<Time>[] = [];
    if (tg.swings) {
      for (const s of A.swings.filter((s) => s.time >= recentFrom)) {
        mk.push({ time: s.time as UTCTimestamp, position: s.kind === 'high' ? 'aboveBar' : 'belowBar', shape: 'circle', color: s.kind === 'high' ? '#9fa8da' : '#ffcc80', size: 0.4 });
      }
    }
    for (const p of this.priceLines) this.series.removePriceLine(p);
    this.priceLines = [];
    if (tg.plan && selected && selected.tf === A.tf) {
      const s = selected.setup;
      const up = s.direction === 'bullish';
      mk.push({ time: s.choch.breakTime as UTCTimestamp, position: up ? 'belowBar' : 'aboveBar', shape: up ? 'arrowUp' : 'arrowDown', color: C.strat, text: 'CHoCH', size: 1 });
      if (s.bos) mk.push({ time: s.bos.breakTime as UTCTimestamp, position: up ? 'belowBar' : 'aboveBar', shape: up ? 'arrowUp' : 'arrowDown', color: C.strat, text: 'BOS', size: 1 });
      if (s.triggerTime) mk.push({ time: s.triggerTime as UTCTimestamp, position: up ? 'belowBar' : 'aboveBar', shape: up ? 'arrowUp' : 'arrowDown', color: C.entry, text: up ? 'ENTRY (long)' : 'ENTRY (short)', size: 2 });
      const r = s.risk;
      if (r) {
        const add = (price: number, color: string, title: string, style: LineStyle = LineStyle.Solid, width: 1 | 2 | 3 = 2) =>
          this.priceLines.push(this.series.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }));
        add(r.entry, C.entry, `ENTRY (CE) ${fmtPrice(r.entry)}`);
        add(r.stop, C.sl, `SL ${fmtPrice(r.stop)} (−${fmtPrice(r.risk)})`, LineStyle.Solid, 2);
        r.targets.forEach((t) => add(t.price, C.tp, `${t.name} ${fmtPrice(t.price)} (${t.rr.toFixed(1)}R)`, t.name === 'TP1' ? LineStyle.Solid : LineStyle.Dashed, t.name === 'TP1' ? 2 : 1));
      } else {
        const buf = (A.atr[A.atr.length - 1] ?? 0) * this.slAtrMult;
        this.priceLines.push(this.series.createPriceLine({ price: up ? s.originPrice - buf : s.originPrice + buf, color: C.sl, title: 'Invalidation (provisional SL)', lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true }));
      }
    }
    mk.sort((a, b) => (a.time as number) - (b.time as number));
    this.markers.setMarkers(mk);
    this.overlay.setData(rects, lines, times);
  }
}
