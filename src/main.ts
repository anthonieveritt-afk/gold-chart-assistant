import './style.css';
import { analyseMarket, type MarketAnalysis, type SetupView, type TfData } from './analysis/engine';
import { DEFAULT_CONFIG, TF_LABEL, TIMEFRAMES, type AnalysisConfig, type Timeframe } from './analysis/types';
import { binanceSource, twelveDataSource, xauSource, type DataSource, type SourceId } from './data/sources';
import { DEFAULT_TOGGLES, GoldChart, type Toggles } from './ui/chart';
import { confluenceCard, directionCard, fvgCard, liquidityCard, mtfCard, setupsCard } from './ui/dashboard';
import { fmtDateTime } from './ui/format';

interface Settings { source: SourceId; srcV?: number; apiKey: string; cfg: AnalysisConfig; tf: Timeframe; toggles: Toggles }
const KEY = 'gold-chart-assistant:v1';

function loadSettings(): Settings {
  const d: Settings = { source: 'xau', srcV: 2, apiKey: '', cfg: { ...DEFAULT_CONFIG }, tf: '1h', toggles: { ...DEFAULT_TOGGLES } };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const out: Settings = { ...d, ...s, cfg: { ...d.cfg, ...(s.cfg ?? {}) }, toggles: { ...d.toggles, ...(s.toggles ?? {}) } };
    // v1 saved 'binance' (PAXG) as the default for everyone – move to real XAU/USD unless a Twelve Data key was set up
    if (s.srcV !== 2) { if (!(out.source === 'twelvedata' && out.apiKey)) out.source = 'xau'; out.srcV = 2; }
    if (!['xau', 'binance', 'twelvedata'].includes(out.source)) out.source = 'xau';
    return out;
  } catch { return d; }
}
const settings = loadSettings();
const save = () => localStorage.setItem(KEY, JSON.stringify(settings));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const chart = new GoldChart($('chart'));
let source: DataSource = makeSource();
let data: Partial<Record<Timeframe, TfData>> = {};
const fetchedAt: Partial<Record<Timeframe, number>> = {};
const errors: Partial<Record<Timeframe, string>> = {};
let market: MarketAnalysis | null = null;
let selectedId: string | null = null;
let lastUpdate = 0;
let busySrc: DataSource | null = null;

function makeSource(): DataSource {
  if (settings.source === 'twelvedata' && settings.apiKey) return twelveDataSource(settings.apiKey);
  if (settings.source === 'binance') return binanceSource();
  return xauSource();
}

const SRC_BUTTONS: { id: SourceId; label: string }[] = [
  { id: 'xau', label: 'XAU/USD (real gold)' },
  { id: 'binance', label: 'PAXG token' },
  { id: 'twelvedata', label: 'Twelve Data' },
];
const fallbacks: Partial<Record<Timeframe, string>> = {};
const notes: Partial<Record<Timeframe, string>> = {};

function setSource(id: SourceId) {
  if (id === 'twelvedata' && !settings.apiKey) { openSettings(); return; }
  if (id === settings.source && source.id === id) return;
  settings.source = id; save();
  switchSource();
}
function switchSource() {
  source = makeSource(); data = {}; market = null;
  for (const tf of TIMEFRAMES) { delete fetchedAt[tf]; delete errors[tf]; delete fallbacks[tf]; delete notes[tf]; }
  renderControls();
  $('chartMsg').textContent = 'Loading…';
  $('status').innerHTML = '';
  $('source').textContent = source.label;
  refresh(true);
}

const TOGGLE_LABELS: Record<keyof Toggles, string> = { plan: 'Entry/SL/TP', structure: 'CHoCH/BOS', fvg: 'FVG', ifvg: 'IFVG', liquidity: 'Liquidity', swings: 'Swings', ema: 'EMA 50/200' };

function renderControls() {
  $('srcbar').innerHTML = `<span class="muted">Data:</span>${SRC_BUTTONS.map((b) => `<button data-src="${b.id}" class="${b.id === source.id ? 'on' : ''}">${b.label}${b.id === 'twelvedata' && !settings.apiKey ? ' 🔑' : ''}</button>`).join('')}`;
  $('tfs').innerHTML = TIMEFRAMES.map((tf) => `<button data-tf="${tf}" class="${tf === settings.tf ? 'on' : ''}">${TF_LABEL[tf]}</button>`).join('');
  $('toggles').innerHTML = (Object.keys(TOGGLE_LABELS) as (keyof Toggles)[]).map((k) => `<label class="chip ${settings.toggles[k] ? 'on' : ''}"><input type="checkbox" data-toggle="${k}" ${settings.toggles[k] ? 'checked' : ''}/>${TOGGLE_LABELS[k]}</label>`).join('');
}

function allViews(): SetupView[] {
  if (!market) return [];
  return TIMEFRAMES.flatMap((tf) => market!.byTf[tf]?.setups ?? []);
}

/** Setup drawn on the chart: the user's pick if on this TF, else the most relevant fresh setup on this TF (bullish first). */
function chartSetup(): SetupView | null {
  if (!market) return null;
  const picked = allViews().find((v) => v.setup.id === selectedId && v.tf === settings.tf);
  if (picked) return picked;
  const onTf = [...market.active, ...market.developing].filter((v) => v.tf === settings.tf);
  if (onTf.length) return onTf[0];
  const A = market.byTf[settings.tf];
  return A ? [...A.setups].reverse().find((v) => v.setup.trioComplete) ?? null : null;
}

function render() {
  if (!market) return;
  const A = market.byTf[settings.tf];
  const msg = $('chartMsg');
  if (!A) { msg.textContent = errors[settings.tf] ? `Data error: ${errors[settings.tf]}` : 'Loading…'; renderStatus(); return; }
  msg.textContent = '';
  chart.slAtrMult = settings.cfg.slAtrMult;
  const sel = chartSetup();
  chart.update(A, market, settings.toggles, sel);
  const confView = sel ?? market.active[0] ?? market.developing[0] ?? null;
  $('dash').innerHTML = `
    <div class="col">${directionCard(market)}${mtfCard(market)}${confluenceCard(confView)}</div>
    <div class="col">${setupsCard(market, sel?.setup.id ?? null, settings.cfg.slAtrMult)}</div>
    <div class="col">${liquidityCard(A, market)}${fvgCard(A, market)}</div>`;
  renderStatus();
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function renderStatus() {
  const fb = Object.values(fallbacks);
  const byMsg = new Map<string, string[]>();
  for (const [tf, e] of Object.entries(errors)) byMsg.set(e!, [...(byMsg.get(e!) ?? []), TF_LABEL[tf as Timeframe]]);
  const errTxt = [...byMsg].map(([e, tfs]) => `${tfs.length === TIMEFRAMES.length ? 'All timeframes' : tfs.join(', ')}: ${e}`).join('; ');
  const usingPaxgFallback = fb.length > 0;
  $('source').textContent = usingPaxgFallback ? `${source.label} ⚠ fallback active` : source.label;
  const live = market && isFinite(market.price) ? ` · ${market.price.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
  const parts: string[] = [];
  if (lastUpdate) parts.push(`<span class="ok">● ${esc(source.id === 'binance' ? 'PAXG' : usingPaxgFallback ? 'PAXG (backup)' : 'XAU/USD')}${live} · updated ${fmtDateTime(lastUpdate / 1000)} UK</span>`);
  if (usingPaxgFallback) parts.push(`<span class="warn-t">⚠ ${esc(fb[0]!)}${fb.length > 1 ? ` (${fb.length} timeframes)` : ''}</span>`);
  if (errTxt) parts.push(`<span class="err-t">⚠ ${esc(errTxt)}</span>`);
  $('status').innerHTML = parts.join(' ');
  $('updated').textContent = lastUpdate ? `Updated ${fmtDateTime(lastUpdate / 1000)} UK` : '';
  const noteTxt = [...new Set(Object.values(notes))].join('; ');
  $('footSource').textContent = `Data: ${source.detail}${noteTxt ? ` (${noteTxt}.)` : ''}`;
}

function reanalyse() {
  market = analyseMarket(data, settings.cfg, Date.now() / 1000);
  render();
}

async function refresh(force = false) {
  if (busySrc === source) return;
  const src = source;
  busySrc = src;
  try { await doRefresh(force); } finally { if (busySrc === src) { busySrc = null; $('refresh').classList.remove('spin'); } }
  if (src === source) reanalyse();
}

async function doRefresh(force: boolean) {
  $('refresh').classList.add('spin');
  const now = Date.now();
  const due = TIMEFRAMES.filter((tf) => force || !data[tf] || now - (fetchedAt[tf] ?? 0) >= source.refreshSec(tf, tf === settings.tf) * 1000);
  // selected timeframe first so the chart appears quickly
  due.sort((a, b) => Number(b === settings.tf) - Number(a === settings.tf));
  const src = source;
  await Promise.all(due.map(async (tf) => {
    try {
      const r = await src.fetchTf(tf);
      if (src !== source) return;
      data[tf] = { tf, candles: r.candles, live: r.live };
      fetchedAt[tf] = Date.now();
      delete errors[tf];
      if (r.fallback) fallbacks[tf] = r.fallback; else delete fallbacks[tf];
      if (r.note) notes[tf] = r.note; else delete notes[tf];
    } catch (e) {
      if (src !== source) return;
      errors[tf] = e instanceof Error ? e.message : String(e);
    }
  }));
  if (due.length && src === source && due.some((tf) => !errors[tf])) lastUpdate = Date.now();
}

// events
$('tfs').addEventListener('click', (e) => {
  const tf = (e.target as HTMLElement).closest('button')?.dataset.tf as Timeframe | undefined;
  if (!tf) return;
  settings.tf = tf; save(); renderControls(); render();
});
$('toggles').addEventListener('change', (e) => {
  const k = (e.target as HTMLInputElement).dataset.toggle as keyof Toggles | undefined;
  if (!k) return;
  settings.toggles[k] = (e.target as HTMLInputElement).checked; save(); renderControls(); render();
});
$('dash').addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-setup]') as HTMLElement | null;
  if (!el) return;
  selectedId = el.dataset.setup!;
  const tf = el.dataset.tf as Timeframe;
  if (tf !== settings.tf) { settings.tf = tf; save(); renderControls(); }
  render();
  if ((e.target as HTMLElement).closest('button.show')) $('chartWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('refresh').addEventListener('click', () => refresh(true));
$('srcbar').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest('button')?.dataset.src as SourceId | undefined;
  if (id) setSource(id);
});

const dlg = $('settings') as HTMLDialogElement;
const form = $('settingsForm') as HTMLFormElement;
$('settingsBtn').addEventListener('click', () => openSettings());
function openSettings() {
  (form.elements.namedItem('source') as RadioNodeList).value = settings.source;
  (form.elements.namedItem('apiKey') as HTMLInputElement).value = settings.apiKey;
  for (const k of ['swingLookback', 'slAtrMult', 'minRR', 'fvgMinAtr', 'setupMaxAgeBars'] as const) (form.elements.namedItem(k) as HTMLInputElement).value = String(settings.cfg[k]);
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}
$('settingsCancel').addEventListener('click', () => { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); });
form.addEventListener('submit', () => {
  const prevSource = `${source.id}|${settings.apiKey}`;
  settings.source = ((form.elements.namedItem('source') as RadioNodeList).value || 'xau') as SourceId;
  settings.apiKey = (form.elements.namedItem('apiKey') as HTMLInputElement).value.trim();
  if (settings.source === 'twelvedata' && !settings.apiKey) settings.source = 'xau';
  const num = (k: string, lo: number, hi: number, d: number) => { const v = Number((form.elements.namedItem(k) as HTMLInputElement).value); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  settings.cfg.swingLookback = Math.round(num('swingLookback', 2, 15, 5));
  settings.cfg.slAtrMult = num('slAtrMult', 0, 2, 0.25);
  settings.cfg.minRR = num('minRR', 0, 10, 1);
  settings.cfg.fvgMinAtr = num('fvgMinAtr', 0, 2, 0.05);
  settings.cfg.setupMaxAgeBars = Math.round(num('setupMaxAgeBars', 5, 500, 60));
  save();
  if (`${makeSource().id}|${settings.apiKey}` !== prevSource) switchSource();
  else reanalyse();
});

renderControls();
refresh(true);
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
