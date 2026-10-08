import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, IPrimitivePaneView, SeriesAttachedParameter, Time, UTCTimestamp } from 'lightweight-charts';

export interface RectShape { t1: number; t2: number | null; top: number; bottom: number; fill: string; stroke: string; dash?: number[]; label?: string; labelColor?: string; width?: number }
export interface LineShape { t1: number; t2: number | null; price: number; color: string; width?: number; dash?: number[]; label?: string; labelAlign?: 'left' | 'right' | 'center'; labelAbove?: boolean }

type Ctx = CanvasRenderingContext2D;

/** Draws FVG/IFVG boxes, liquidity segments and CHoCH/BOS labels in chart coordinates. */
export class OverlayPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private rects: RectShape[] = [];
  private lines: LineShape[] = [];
  private times: number[] = [];
  private readonly views: IPrimitivePaneView[];

  constructor() {
    const self = this;
    const back: IPrimitivePaneRenderer = { draw: () => {}, drawBackground: (t) => t.useMediaCoordinateSpace(({ context, mediaSize }) => self.drawRects(context as Ctx, mediaSize.width)) };
    const front: IPrimitivePaneRenderer = { draw: (t) => t.useMediaCoordinateSpace(({ context, mediaSize }) => self.drawLines(context as Ctx, mediaSize.width)) };
    this.views = [
      { zOrder: () => 'bottom', renderer: () => back },
      { zOrder: () => 'top', renderer: () => front },
    ];
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<'Candlestick'>;
    this.requestUpdate = p.requestUpdate;
  }
  detached() { this.chart = null; this.series = null; this.requestUpdate = null; }
  paneViews() { return this.views; }
  updateAllViews() {}

  setData(rects: RectShape[], lines: LineShape[], times: number[]) {
    this.rects = rects;
    this.lines = lines;
    this.times = times;
    this.requestUpdate?.();
  }

  private x(t: number | null, width: number): number | null {
    if (!this.chart) return null;
    if (t === null) return width;
    const ts = this.times;
    if (!ts.length) return null;
    let lo = 0;
    let hi = ts.length - 1;
    if (t <= ts[0]) lo = 0;
    else if (t >= ts[hi]) lo = hi;
    else {
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid - 1; }
    }
    const c = this.chart.timeScale().timeToCoordinate(ts[lo] as UTCTimestamp);
    return c === null ? null : c;
  }
  private y(p: number): number | null { return this.series ? this.series.priceToCoordinate(p) : null; }

  private label(ctx: Ctx, text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'left') {
    ctx.font = '10px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = align;
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  private drawRects(ctx: Ctx, width: number) {
    for (const r of this.rects) {
      const x1 = this.x(r.t1, width);
      const x2 = this.x(r.t2, width);
      const y1 = this.y(r.top);
      const y2 = this.y(r.bottom);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      const w = Math.max(2, x2 - x1);
      ctx.fillStyle = r.fill;
      ctx.fillRect(x1, y1, w, y2 - y1);
      ctx.strokeStyle = r.stroke;
      ctx.lineWidth = r.width ?? 1;
      ctx.setLineDash(r.dash ?? []);
      ctx.strokeRect(x1 + 0.5, y1 + 0.5, w, y2 - y1);
      ctx.setLineDash([]);
      if (r.label) this.label(ctx, r.label, Math.max(x1 + 3, 3), y1 - 1, r.labelColor ?? r.stroke);
    }
  }

  private drawLines(ctx: Ctx, width: number) {
    for (const l of this.lines) {
      const x1 = this.x(l.t1, width);
      const x2 = this.x(l.t2, width);
      const y = this.y(l.price);
      if (x1 === null || x2 === null || y === null) continue;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.width ?? 1;
      ctx.setLineDash(l.dash ?? []);
      ctx.beginPath();
      ctx.moveTo(x1, Math.round(y) + 0.5);
      ctx.lineTo(x2, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      if (l.label) {
        const align = l.labelAlign ?? 'left';
        const lx = align === 'center' ? (x1 + x2) / 2 : align === 'right' ? Math.min(x2, width - 60) - 2 : Math.max(x1 + 2, 2);
        const ly = l.labelAbove === false ? y + 12 : y - 2;
        this.label(ctx, l.label, lx, ly, l.color, align);
      }
    }
  }
}
