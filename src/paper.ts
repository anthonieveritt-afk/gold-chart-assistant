import './style.css';
import { CandlestickSeries, ColorType, LineSeries, LineStyle, createChart, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';

/** Snapshot published by the paper bot to the `paper-data` branch (PAPER TRADING – NOT REAL MONEY). */
const SNAP = new URLSearchParams(location.search).get('snap')
  ?? 'https://raw.githubusercontent.com/anthonieveritt-afk/gold-chart-assistant/paper-data/snapshot.json';

interface Target { name: string; price: number; label: string; rr: number }
interface Fill { name: string; time: number; price: number; qty: number; pnl: number }
interface Trade { id: number; direction: 'bullish' | 'bearish'; entry: number; fillPrice: number; stop: number; currentStop: number; targets: Target[]; openTime: number; closeTime?: number; result?: string; pnl?: number; r?: number; qtyInitial: number; qty: number; riskUsd: number; fills: Fill[]; confluence: number; reasons: string[] }
interface Pending { direction: 'bullish' | 'bearish'; entry: number; stop: number; targets: Target[]; placedAt: number; expiresAt: number; confluence: number; reasons: string[] }
interface Snap {
  generatedAt: string; status: string; feed: string; price: number; lastCandle: string | null; balance: number; equity: number; lastError: string | null;
  config: Record<string, unknown> & { startBalance: number; riskPct: number; spread: number; slippage: number };
  stats: { trades: number; wins: number; losses: number; winRatePct: number; profitFactor: number | null; avgR: number; netPnl: number; returnPct: number; maxDrawdownPct: number };
  open: Trade | null; pending: Pending | null; closed: Trade[]; journal: { time: number; kind: string; text: string }[];
  equityCurve: { time: number; equity: number }[]; candles: [number, number, number, number, number][];
}

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const px = (n: number) => n.toFixed(2);
const uk = (t: number) => new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const LONDON_OFF = (t: number) => { // show chart times in UK time
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(new Date(t * 1000)).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT';
  const m = p.match(/GMT([+-]\d+)?/); return (m?.[1] ? +m[1] : 0) * 3600;
};
const local = (t: number) => (t + LONDON_OFF(t)) as UTCTimestamp;

const opts = { layout: { background: { type: ColorType.Solid, color: '#161a22' }, textColor: '#d1d4dc' }, grid: { vertLines: { color: '#202532' }, horzLines: { color: '#202532' } }, timeScale: { timeVisible: true, secondsVisible: false }, autoSize: true };
const chart = createChart($('pbChart'), opts);
const candles: ISeriesApi<'Candlestick'> = chart.addSeries(CandlestickSeries, { upColor: '#26a69a', downColor: '#ef5350', wickUpColor: '#26a69a', wickDownColor: '#ef5350', borderVisible: false });
const eqChart = createChart($('pbEquity'), opts);
const eqLine = eqChart.addSeries(LineSeries, { color: '#ffd54f', lineWidth: 2 });
let lines: IPriceLine[] = [];

function draw(s: Snap) {
  const stale = Date.now() - Date.parse(s.generatedAt) > 15 * 60_000;
  $('pbStatus').innerHTML = `${stale ? '<b class="err-t">Bot snapshot is old</b> · ' : ''}Status: ${esc(s.status)} · ${esc(s.feed || '')} · updated ${new Date(s.generatedAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })} UK`;
  const st = s.stats;
  const k = (l: string, v: string, cls = '') => `<div class="kpi"><small>${l}</small><b class="${cls}">${v}</b></div>`;
  $('kpis').innerHTML = k('Virtual equity', usd(s.equity), s.equity >= s.config.startBalance ? 'pos' : 'neg') + k('Balance', usd(s.balance)) + k('Net P&L', `${usd(st.netPnl)} (${st.returnPct}%)`, st.netPnl >= 0 ? 'pos' : 'neg')
    + k('Trades', String(st.trades)) + k('Win rate', `${st.winRatePct}%`) + k('Profit factor', st.profitFactor == null ? '–' : String(st.profitFactor)) + k('Avg R', String(st.avgR)) + k('Max drawdown', `${st.maxDrawdownPct}%`);

  candles.setData(s.candles.map(([t, o, h, l, c]) => ({ time: local(t), open: o, high: h, low: l, close: c })));
  for (const l of lines) candles.removePriceLine(l);
  lines = [];
  const add = (price: number, color: string, title: string, style = LineStyle.Solid) => lines.push(candles.createPriceLine({ price, color, title, lineWidth: 2, lineStyle: style, axisLabelVisible: true }));
  const t = s.open ?? s.pending;
  if (t) {
    const isOpen = !!s.open;
    add(isOpen ? s.open!.fillPrice : t.entry, '#42a5f5', isOpen ? 'Entry' : 'Limit', isOpen ? LineStyle.Solid : LineStyle.Dashed);
    add(isOpen ? s.open!.currentStop : t.stop, '#ff1744', 'SL');
    t.targets.forEach((g) => add(g.price, '#00e676', g.name, LineStyle.Dashed));
    const dir = t.direction === 'bullish' ? 'LONG' : 'SHORT';
    $('tradeBox').innerHTML = isOpen
      ? `<b>Open ${dir} #${s.open!.id}</b> since ${uk(s.open!.openTime)} · ${s.open!.qty.toFixed(2)} oz left of ${s.open!.qtyInitial.toFixed(2)} · entry ${px(s.open!.fillPrice)} · SL ${px(s.open!.currentStop)} · ${t.targets.map((g) => `${g.name} ${px(g.price)} (${g.rr.toFixed(1)}R)`).join(' · ')} · risk ${usd(s.open!.riskUsd)}<br>${esc(t.reasons.join(' · '))}`
      : `<b>Pending ${dir} limit</b> @ ${px(t.entry)} (until ${uk((t as Pending).expiresAt)}) · SL ${px(t.stop)} · ${t.targets.map((g) => `${g.name} ${px(g.price)} (${g.rr.toFixed(1)}R)`).join(' · ')}<br>${esc(t.reasons.join(' · '))}`;
  } else $('tradeBox').textContent = 'No open or pending trade – waiting for CHoCH + BOS + FVG with HTF and liquidity confluence.';

  eqLine.setData(dedupe(s.equityCurve.map((p) => ({ time: local(p.time), value: p.equity }))));
  eqChart.timeScale().fitContent();

  $('closed').innerHTML = s.closed.length ? `<table><tr><th>#</th><th>Side</th><th>Opened</th><th>Entry</th><th>SL</th><th>Exits</th><th>Result</th><th>P&L</th><th>R</th></tr>${s.closed.map((c) => `<tr><td>${c.id}</td><td class="${c.direction === 'bullish' ? 'pos' : 'neg'}">${c.direction === 'bullish' ? 'Long' : 'Short'}</td><td>${uk(c.openTime)}</td><td>${px(c.fillPrice)}</td><td>${px(c.stop)}</td><td>${c.fills.map((f) => `${f.name} ${px(f.price)}`).join(', ')}</td><td>${esc(c.result ?? '')}</td><td class="${(c.pnl ?? 0) >= 0 ? 'pos' : 'neg'}">${usd(c.pnl ?? 0)}</td><td>${(c.r ?? 0).toFixed(2)}</td></tr>`).join('')}</table>` : '<p class="muted">No closed trades yet.</p>';
  $('journal').innerHTML = s.journal.length ? `<table>${s.journal.map((j) => `<tr><td class="nowrap">${uk(j.time)}</td><td>${esc(j.kind)}</td><td>${esc(j.text)}</td></tr>`).join('')}</table>` : '<p class="muted">Journal is empty.</p>';
  const c = s.config;
  $('cfg').innerHTML = `Settings: start ${usd(c.startBalance)} virtual · risk ${c.riskPct}% per trade · entry TF ${String(c.entryTf).toUpperCase()} · spread $${c.spread} · slippage $${c.slippage} · HTF alignment ${c.requireHtfAlign ? 'required' : 'off'} · counter-trend ${c.allowCounterTrend ? 'allowed' : 'off'} · liquidity sweep ${c.requireLiquidity ? 'required' : 'off'} · exits 1/3 at TP1/TP2/TP3, SL to breakeven after TP1 · max one trade.`;
}
function dedupe<T extends { time: UTCTimestamp }>(a: T[]): T[] { const out: T[] = []; for (const p of a) { if (out.length && out[out.length - 1].time >= p.time) out[out.length - 1] = p; else out.push(p); } return out; }

let first = true;
async function load() {
  try {
    const r = await fetch(`${SNAP}${SNAP.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    draw(await r.json());
    if (first) { chart.timeScale().fitContent(); first = false; }
  } catch (e) { $('pbStatus').innerHTML = `<span class="err-t">Couldn't load the bot snapshot (${esc((e as Error).message)})</span>`; }
}
load();
setInterval(load, 60_000);
