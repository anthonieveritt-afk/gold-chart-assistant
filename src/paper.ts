import './style.css';
import { CandlestickSeries, ColorType, LineSeries, LineStyle, createChart, createSeriesMarkers, type IPriceLine, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts';

/** PAPER TRADING – NOT REAL MONEY. Live mode reads the bot snapshot; replay mode plays a precomputed week. */
const q = new URLSearchParams(location.search);
const SNAP = q.get('snap') ?? 'https://raw.githubusercontent.com/anthonieveritt-afk/gold-chart-assistant/paper-data/snapshot.json';
const REPLAY_URL = q.get('replaydata') ?? './replay.json';

interface Fill { name: string; time: number; price: number; qty: number; pnl: number }
/** normalised trade used for all P&L rendering */
interface VTrade { id: number | string; dir: 1 | -1; openTime: number; closeTime?: number; entry: number; stop: number; curStop: number; tps: number[]; riskUsd: number; fills: Fill[]; qtyLeft: number; qtyTotal: number; unreal?: number; result?: string }

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const usd = (n: number, sign = false) => `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}$${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rr = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}R`;
const cls = (n: number) => (n > 0.005 ? 'pos' : n < -0.005 ? 'neg' : '');
const px = (n: number) => n.toFixed(2);
const uk = (t: number) => new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ukDay = (t: number) => new Date(t * 1000).toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
const offCache = new Map<number, number>();
const off = (t: number) => { const h = Math.floor(t / 3600); if (!offCache.has(h)) { const v = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(new Date(t * 1000)).find((x) => x.type === 'timeZoneName')?.value ?? ''; const m = v.match(/GMT([+-]\d+)/); offCache.set(h, (m ? +m[1] : 0) * 3600); } return offCache.get(h)!; };
const local = (t: number) => (t + off(t)) as UTCTimestamp;
/** Monday 00:00 UK of the week containing t */
const weekKey = (t: number) => { const d = new Date((t + off(t)) * 1000); const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow); };

const opts = { layout: { background: { type: ColorType.Solid, color: '#161a22' }, textColor: '#d1d4dc' }, grid: { vertLines: { color: '#202532' }, horzLines: { color: '#202532' } }, timeScale: { timeVisible: true, secondsVisible: false }, autoSize: true };
const chart = createChart($('pbChart'), opts);
const candles: ISeriesApi<'Candlestick'> = chart.addSeries(CandlestickSeries, { upColor: '#26a69a', downColor: '#ef5350', wickUpColor: '#26a69a', wickDownColor: '#ef5350', borderVisible: false });
const markers = createSeriesMarkers(candles, []);
const eqChart = createChart($('pbEquity'), opts);
const eqLine = eqChart.addSeries(LineSeries, { color: '#ffd54f', lineWidth: 2 });
let lines: IPriceLine[] = [];

const realised = (t: VTrade) => t.fills.reduce((a, f) => a + f.pnl, 0);

/* ---------------------------------------------------------------- shared rendering */
function renderPnl(trades: VTrade[], equity: number, startBalance: number, now: number, open: VTrade | null) {
  const closed = trades.filter((t) => t.closeTime !== undefined);
  const wins = closed.filter((t) => realised(t) > 0.005).length, losses = closed.filter((t) => realised(t) < -0.005).length;
  const total = closed.reduce((a, t) => a + realised(t), 0) + (open ? realised(open) : 0);
  const unreal = open?.unreal ?? 0;
  const sumR = closed.reduce((a, t) => a + realised(t) / t.riskUsd, 0);
  // today / this week: realised P&L from fills that happened in that UK day/week, plus open unrealised
  const fillsIn = (pred: (t: number) => boolean) => trades.reduce((a, t) => a + t.fills.filter((f) => pred(f.time)).reduce((b, f) => b + f.pnl, 0), 0) + unreal;
  const today = fillsIn((t) => ukDay(t) === ukDay(now)), week = fillsIn((t) => weekKey(t) === weekKey(now));
  const k = (l: string, v: string, c = '', big = false) => `<div class="kpi${big ? ' big' : ''}"><small>${l}</small><b class="${c}">${v}</b></div>`;
  $('kpis').innerHTML =
    k('Today P&L', usd(today, true), cls(today), true) + k('This week P&L', usd(week, true), cls(week), true)
    + k('Total P&L', `${usd(total + unreal, true)} <span class="sub">(${(((equity - startBalance) / startBalance) * 100).toFixed(2)}%)</span>`, cls(total + unreal), true)
    + k('Virtual equity', usd(equity), cls(equity - startBalance))
    + k('Wins / losses', `<span class="pos">${wins}</span> / <span class="neg">${losses}</span>`)
    + k('Win rate', closed.length ? `${((wins / closed.length) * 100).toFixed(0)}%` : '–')
    + k('Closed trades', `${closed.length} · ${rr(sumR)}`)
    + k('Open P&L', open ? usd(unreal, true) : '–', cls(unreal));

  // trade cards (newest first) with running total
  let run = 0;
  const running = new Map<VTrade, number>();
  for (const t of [...closed].sort((a, b) => a.closeTime! - b.closeTime!)) { run += realised(t); running.set(t, run); }
  const list = [...(open ? [open] : []), ...[...closed].sort((a, b) => b.closeTime! - a.closeTime!)];
  $('closed').innerHTML = list.length ? list.map((t) => {
    const isOpen = t === open;
    const p = isOpen ? realised(t) + (t.unreal ?? 0) : realised(t);
    const r = p / t.riskUsd;
    return `<div class="trade ${isOpen ? 'open' : p > 0.005 ? 'win' : p < -0.005 ? 'loss' : 'flat'}">
      <div class="tr-head"><span class="side ${t.dir > 0 ? 'pos' : 'neg'}">${t.dir > 0 ? '▲ LONG' : '▼ SHORT'}</span> <span class="muted">#${esc(String(t.id))} · ${uk(t.openTime)}</span>
        <span class="tr-pnl ${cls(p)}">${isOpen ? '<em>OPEN</em> ' : ''}${usd(p, true)} <small>${rr(r)}</small></span></div>
      <div class="tr-sub muted">Entry ${px(t.entry)} · SL ${px(t.stop)}${t.curStop !== t.stop ? ` → ${px(t.curStop)}` : ''} · ${t.tps.map((x, i) => `TP${i + 1} ${px(x)}`).join(' · ')} · risk ${usd(t.riskUsd)}</div>
      <div class="fills">${t.fills.map((f) => `<span class="fill ${cls(f.pnl)}">${esc(f.name)} ${Math.round((f.qty / t.qtyTotal) * 100)}% @ ${px(f.price)} <b>${usd(f.pnl, true)}</b></span>`).join('')}
        ${isOpen ? `<span class="fill ${cls(t.unreal ?? 0)}">Unrealised ${Math.round((t.qtyLeft / t.qtyTotal) * 100)}% <b>${usd(t.unreal ?? 0, true)}</b></span>` : ''}</div>
      ${isOpen ? '' : `<div class="tr-foot muted">${esc(t.result ?? '')} · closed ${uk(t.closeTime!)} · running total <b class="${cls(running.get(t) ?? 0)}">${usd(running.get(t) ?? 0, true)}</b></div>`}
    </div>`;
  }).join('') : '<p class="muted">No trades yet.</p>';
}

function drawLevels(t: { dir: number; entry: number; stop: number; curStop?: number; tps: number[] } | null, pending: boolean, label: string) {
  for (const l of lines) candles.removePriceLine(l);
  lines = [];
  const add = (price: number, color: string, title: string, style = LineStyle.Solid) => lines.push(candles.createPriceLine({ price, color, title, lineWidth: 2, lineStyle: style, axisLabelVisible: true }));
  if (!t) return;
  add(t.entry, '#42a5f5', pending ? 'Limit' : label || 'Entry', pending ? LineStyle.Dashed : LineStyle.Solid);
  add(t.curStop ?? t.stop, '#ff1744', 'SL');
  t.tps.forEach((g, i) => add(g, '#00e676', `TP${i + 1}`, LineStyle.Dashed));
}
const dedupe = <T extends { time: UTCTimestamp }>(a: T[]) => { const o: T[] = []; for (const p of a) { if (o.length && o[o.length - 1].time >= p.time) o[o.length - 1] = p; else o.push(p); } return o; };

/* ---------------------------------------------------------------- live mode */
interface STrade { id: number; direction: 'bullish' | 'bearish'; entry: number; fillPrice: number; stop: number; currentStop: number; targets: { name: string; price: number; rr: number }[]; openTime: number; closeTime?: number; result?: string; qtyInitial: number; qty: number; riskUsd: number; fills: Fill[]; reasons: string[] }
interface Snap { generatedAt: string; status: string; feed: string; price: number; balance: number; equity: number; config: Record<string, unknown> & { startBalance: number }; open: STrade | null; pending: (STrade & { expiresAt: number }) | null; closed: STrade[]; journal: { time: number; kind: string; text: string }[]; equityCurve: { time: number; equity: number }[]; candles: [number, number, number, number, number][] }
const norm = (s: STrade, unreal?: number): VTrade => ({ id: s.id, dir: s.direction === 'bullish' ? 1 : -1, openTime: s.openTime, closeTime: s.closeTime, entry: s.fillPrice, stop: s.stop, curStop: s.currentStop, tps: s.targets.map((t) => t.price), riskUsd: s.riskUsd, fills: s.fills, qtyLeft: s.qty, qtyTotal: s.qtyInitial, unreal, result: s.result });

let mode: 'live' | 'replay' = 'live';
let firstLive = true;
async function loadLive() {
  if (mode !== 'live') return;
  try {
    const r = await fetch(`${SNAP}${SNAP.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s: Snap = await r.json();
    if (mode !== 'live') return;
    const stale = Date.now() - Date.parse(s.generatedAt) > 15 * 60_000;
    $('pbStatus').innerHTML = `${stale ? '<b class="err-t">Bot snapshot is old</b> · ' : ''}LIVE PAPER · ${esc(s.status)} · updated ${new Date(s.generatedAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })} UK`;
    const open = s.open ? norm(s.open, s.equity - s.balance) : null;
    renderPnl([...s.closed.map((c) => norm(c)), ...(open ? [open] : [])], s.equity, s.config.startBalance, Date.now() / 1000, open);
    candles.setData(s.candles.map(([t, o, h, l, c]) => ({ time: local(t), open: o, high: h, low: l, close: c })));
    markers.setMarkers([]);
    const t = s.open ?? s.pending;
    drawLevels(t ? { dir: t.direction === 'bullish' ? 1 : -1, entry: s.open ? s.open.fillPrice : t.entry, stop: t.stop, curStop: s.open?.currentStop, tps: t.targets.map((g) => g.price) } : null, !s.open && !!s.pending,
      open ? `Entry · ${usd(open.unreal ?? 0, true)}` : '');
    $('tradeBox').innerHTML = s.open ? `<b>Open ${open!.dir > 0 ? 'LONG' : 'SHORT'}</b> · unrealised <b class="${cls(open!.unreal ?? 0)}">${usd(open!.unreal ?? 0, true)}</b> (${rr((open!.unreal ?? 0) / open!.riskUsd)}) · ${esc(s.open.reasons.join(' · '))}`
      : s.pending ? `<b>Pending ${s.pending.direction === 'bullish' ? 'BUY' : 'SELL'} limit</b> @ ${px(s.pending.entry)} until ${uk(s.pending.expiresAt)}` : 'No open or pending trade – waiting for CHoCH + BOS + FVG with HTF and liquidity confluence.';
    eqLine.setData(dedupe(s.equityCurve.map((p) => ({ time: local(p.time), value: p.equity }))));
    eqChart.timeScale().fitContent();
    $('journal').innerHTML = s.journal.length ? `<table>${s.journal.map((j) => `<tr><td class="nowrap">${uk(j.time)}</td><td>${esc(j.kind)}</td><td>${esc(j.text)}</td></tr>`).join('')}</table>` : '<p class="muted">Journal is empty.</p>';
    const c = s.config;
    $('cfg').innerHTML = `Live settings: start ${usd(c.startBalance)} virtual · risk ${c.riskPct}% per trade · entry TF ${String(c.entryTf).toUpperCase()} · spread $${c.spread} · slippage $${c.slippage} · exits 1/3 at TP1/TP2/TP3, SL to breakeven after TP1 · max one trade.`;
    if (firstLive) { chart.timeScale().fitContent(); firstLive = false; }
  } catch (e) { $('pbStatus').innerHTML = `<span class="err-t">Couldn't load the bot snapshot (${esc((e as Error).message)})</span>`; }
}

/* ---------------------------------------------------------------- replay mode */
interface RFill { name: string; price: number; time: number; qty: number; r: number }
interface RTrade { openT: number; closeT: number; dir: 1 | -1; entry: number; stop: number; tps: number[]; r: number; fills: RFill[] }
interface RData { from: number; to: number; startBalance: number; riskPct: number; candles: number[][]; configs: Record<string, { label: string; params: Record<string, unknown>; trades: RTrade[] }> }
let rd: RData | null = null;
let rIdx = 0, rSpeed = 1, rTimer: number | null = null, rCfg = 'live';

async function enterReplay() {
  mode = 'replay';
  document.body.classList.add('replay');
  $('replayBanner').hidden = false; $('replayCtl').hidden = false;
  $('modeReplay').classList.add('on'); $('modeLive').classList.remove('on');
  if (!rd) {
    $('pbStatus').textContent = 'loading replay…';
    rd = await (await fetch(REPLAY_URL, { cache: 'no-store' })).json();
    const sel = $('rpCfg') as HTMLSelectElement;
    sel.innerHTML = Object.entries(rd!.configs).map(([id, c]) => `<option value="${id}">${esc(c.label)} – ${c.trades.length} trade${c.trades.length === 1 ? '' : 's'}</option>`).join('');
    const want = q.get('config'); if (want && rd!.configs[want]) sel.value = want;
    rCfg = sel.value;
    ($('rpSeek') as HTMLInputElement).max = String(rd!.candles.length - 1);
  }
  history.replaceState(null, '', `?replay=1&config=${rCfg}`);
  $('pbStatus').innerHTML = `<b class="warn-t">REPLAY – PAPER, NOT REAL MONEY</b> · ${uk(rd!.from)} → ${uk(rd!.to)} UK`;
  $('journal').innerHTML = '<p class="muted">Journal is shown in live mode.</p>';
  const p = rd!.configs[rCfg].params;
  $('cfg').innerHTML = `Replay settings (${esc(rd!.configs[rCfg].label)}): ${esc(Object.entries(p).map(([k, v]) => `${k} ${v}`).join(' · '))} · $${rd!.startBalance.toLocaleString()} virtual, ${rd!.riskPct}% risk, $0.30 spread + $0.10 slippage. Same rules as the walk-forward backtest.`;
  renderReplay(true);
}
function leaveReplay() {
  stopPlay(); mode = 'live'; document.body.classList.remove('replay');
  $('replayBanner').hidden = true; $('replayCtl').hidden = true;
  $('modeLive').classList.add('on'); $('modeReplay').classList.remove('on');
  history.replaceState(null, '', location.pathname); firstLive = true; loadLive();
}

function replayState(T: number) {
  // T = close time of the current candle; everything up to and including it is known
  const cfg = rd!.configs[rCfg];
  let bal = rd!.startBalance;
  const vts: VTrade[] = [];
  let open: VTrade | null = null;
  const eq: { time: UTCTimestamp; value: number }[] = [{ time: local(rd!.from), value: bal }];
  const close = curClose();
  for (const [i, t] of cfg.trades.entries()) {
    if (t.openT >= T) break;
    const riskUsd = bal * rd!.riskPct / 100;
    const fills: Fill[] = t.fills.filter((f) => f.time <= T).map((f) => ({ name: f.name === 'WKD' ? 'Weekend close' : f.name === 'BE' ? 'BE stop' : f.name, time: f.time, price: f.price, qty: f.qty, pnl: f.r * riskUsd }));
    const qtyLeft = 1 - fills.reduce((a, f) => a + f.qty, 0);
    const done = t.closeT <= T;
    const tp1Hit = fills.some((f) => f.name === 'TP1');
    const be = tp1Hit && (rd!.configs[rCfg].params.be === 'tp1');
    const vt: VTrade = { id: i + 1, dir: t.dir, openTime: t.openT, closeTime: done ? t.closeT : undefined, entry: t.entry, stop: t.stop, curStop: be ? t.entry : t.stop, tps: t.tps, riskUsd, fills, qtyLeft, qtyTotal: 1,
      result: done ? (fills.some((f) => f.name === 'SL') ? 'Stopped out' : fills.some((f) => f.name === 'BE stop') ? 'Stopped at breakeven after TP1' : fills.some((f) => f.name === 'Weekend close') ? 'Closed before weekend' : 'All targets hit') : undefined };
    for (const f of fills) { bal += f.pnl; eq.push({ time: local(f.time), value: +bal.toFixed(2) }); }
    if (!done) { vt.unreal = (t.dir * (close - t.dir * 0.15 - t.entry) / Math.abs(t.entry - t.stop)) * qtyLeft * riskUsd; open = vt; }
    vts.push(vt);
  }
  const equity = bal + (open?.unreal ?? 0);
  eq.push({ time: local(T), value: +equity.toFixed(2) });
  return { vts, open, equity, eq };
}
const curClose = () => rd!.candles[rIdx][4];

function renderReplay(full = false) {
  if (!rd) return;
  const c = rd.candles;
  const T = c[rIdx][0] + 180;
  if (full) { candles.setData(c.slice(0, rIdx + 1).map(([t, o, h, l, cl]) => ({ time: local(t), open: o, high: h, low: l, close: cl }))); }
  else { const [t, o, h, l, cl] = c[rIdx]; candles.update({ time: local(t), open: o, high: h, low: l, close: cl }); }
  const st = replayState(T);
  renderPnl(st.vts, st.equity, rd.startBalance, T, st.open);
  // markers: entries + every fill
  const mk: SeriesMarker<Time>[] = [];
  for (const t of st.vts) {
    mk.push({ time: local(t.openTime - (t.openTime % 180)), position: t.dir > 0 ? 'belowBar' : 'aboveBar', color: '#42a5f5', shape: t.dir > 0 ? 'arrowUp' : 'arrowDown', text: `#${t.id} ${t.dir > 0 ? 'BUY' : 'SELL'}` });
    for (const f of t.fills) mk.push({ time: local(f.time - 60 - ((f.time - 60) % 180)), position: t.dir > 0 ? 'aboveBar' : 'belowBar', color: f.pnl >= 0 ? '#00e676' : '#ff5252', shape: 'circle', text: `${f.name} ${usd(f.pnl, true)}` });
  }
  mk.sort((a, b) => (a.time as number) - (b.time as number));
  markers.setMarkers(mk);
  const o = st.open;
  drawLevels(o ? { dir: o.dir, entry: o.entry, stop: o.stop, curStop: o.curStop, tps: o.tps.slice(o.fills.filter((f) => f.name.startsWith('TP')).length) } : null, false, o ? `Entry · ${usd(o.unreal ?? 0, true)}` : '');
  $('tradeBox').innerHTML = o ? `<b>Open ${o.dir > 0 ? 'LONG' : 'SHORT'} #${o.id}</b> · unrealised <b class="${cls(o.unreal ?? 0)}">${usd(o.unreal ?? 0, true)}</b> (${rr((o.unreal ?? 0) / o.riskUsd)}) · ${Math.round(o.qtyLeft * 100)}% of position still open`
    : `No open trade at this point · price ${px(curClose())}`;
  eqLine.setData(dedupe(st.eq));
  eqChart.timeScale().fitContent();
  ($('rpSeek') as HTMLInputElement).value = String(rIdx);
  $('rpTime').textContent = `${uk(T)} UK · candle ${rIdx + 1} / ${c.length} (3-minute)`;
  if (full) chart.timeScale().fitContent();
  else if (rIdx % 20 === 0) chart.timeScale().scrollToRealTime();
}
function stopPlay() { if (rTimer !== null) clearInterval(rTimer); rTimer = null; $('rpPlay').textContent = '▶ Play'; }
function startPlay() {
  stopPlay();
  if (rIdx >= rd!.candles.length - 1) { rIdx = 0; renderReplay(true); }
  $('rpPlay').textContent = '❚❚ Pause';
  // 1x = 1 candle/second, 10x = 10/s, 60x = 60/s (batched so the page stays smooth)
  const fps = Math.min(rSpeed, 20), per = Math.max(1, Math.round(rSpeed / fps));
  rTimer = window.setInterval(() => {
    for (let i = 0; i < per && rIdx < rd!.candles.length - 1; i++) { rIdx++; if (i < per - 1) { const [t, o, h, l, cl] = rd!.candles[rIdx]; candles.update({ time: local(t), open: o, high: h, low: l, close: cl }); } }
    renderReplay();
    if (rIdx >= rd!.candles.length - 1) stopPlay();
  }, 1000 / fps);
}

$('modeLive').onclick = leaveReplay;
$('modeReplay').onclick = () => { enterReplay(); };
$('rpPlay').onclick = () => (rTimer === null ? startPlay() : stopPlay());
$('rpRestart').onclick = () => { stopPlay(); rIdx = 0; renderReplay(true); };
($('rpSeek') as HTMLInputElement).oninput = (e) => { stopPlay(); rIdx = +(e.target as HTMLInputElement).value; renderReplay(true); };
($('rpCfg') as HTMLSelectElement).onchange = (e) => { rCfg = (e.target as HTMLSelectElement).value; history.replaceState(null, '', `?replay=1&config=${rCfg}`); enterReplay(); };
document.querySelectorAll<HTMLButtonElement>('.speeds button').forEach((b) => (b.onclick = () => {
  rSpeed = +b.dataset.s!; document.querySelectorAll('.speeds button').forEach((x) => x.classList.toggle('on', x === b)); if (rTimer !== null) startPlay();
}));

if (q.get('replay')) { enterReplay().then(() => { if (q.get('at')) { rIdx = Math.min(+q.get('at')!, rd!.candles.length - 1); renderReplay(true); } if (q.get('autoplay')) startPlay(); }); }
else loadLive();
setInterval(loadLive, 60_000);
