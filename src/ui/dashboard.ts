import type { MarketAnalysis, SetupView, TfAnalysis } from '../analysis/engine';
import type { Confluence } from '../analysis/confluence';
import { TF_LABEL, TIMEFRAMES, type Bias, type LiquidityLevel } from '../analysis/types';
import { activeZones, polarityAt } from '../analysis/fvg';
import { esc, fmtDateTime, fmtPct, fmtPrice } from './format';

const biasBadge = (b: Bias | 'none') => `<span class="badge ${b}">${b === 'bullish' ? '▲ Bullish' : b === 'bearish' ? '▼ Bearish' : b === 'ranging' ? '◆ Ranging' : '–'}</span>`;

export function directionCard(m: MarketAnalysis): string {
  return `<section class="card dir">
    <div class="dir-head"><h2>Gold direction</h2>${biasBadge(m.overall.bias)}<span class="price">${fmtPrice(m.price)}</span></div>
    <ul class="reasons">${m.overall.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
  </section>`;
}

function step(done: boolean, label: string, detail: string) {
  return `<div class="step ${done ? 'done' : ''}"><span class="dot">${done ? '✓' : '…'}</span><b>${label}</b><small>${esc(detail)}</small></div>`;
}

export function setupCard(v: SetupView, selectedId: string | null, slAtrMult: number, atrNow: number): string {
  const s = v.setup;
  const up = s.direction === 'bullish';
  const r = s.risk;
  const lowRR = !!r?.lowRR;
  const stateCls = s.state === 'triggered' ? (lowRR ? 'warn' : 'entry') : s.trioComplete ? 'trio' : 'dev';
  const flag = s.trioComplete ? `<div class="flag ${up ? 'bull' : 'bear'}">Strategy setup: CHoCH + BOS + FVG${s.fvgIsIfvg ? ' (IFVG)' : ''}</div>` : '';
  const steps = `<div class="steps">
    ${step(true, 'CHoCH', `${fmtPrice(s.choch.level)} · ${fmtDateTime(s.choch.breakTime)}`)}
    ${step(!!s.bos, 'BOS', s.bos ? `${fmtPrice(s.bos.level)} · ${fmtDateTime(s.bos.breakTime)}` : 'waiting')}
    ${step(!!s.fvg, s.fvgIsIfvg ? 'IFVG' : 'FVG', s.fvg ? `${fmtPrice(s.fvg.bottom)}–${fmtPrice(s.fvg.top)}` : s.bos ? 'none in leg' : 'waiting')}
    ${step(s.triggerTime !== null, 'Retest', s.triggerTime ? fmtDateTime(s.triggerTime) : 'waiting')}
  </div>`;
  let plan = '';
  if (r) {
    const rows = r.targets.map((t) => `<tr class="tp ${t.name === 'TP1' && lowRR ? 'bad' : ''}"><th>${t.name}</th><td class="num">${fmtPrice(t.price)}</td><td class="num">${up ? '+' : '−'}${fmtPrice(t.distance)} <small>(${fmtPct(t.distancePct)})</small></td><td class="num rr">${t.rr.toFixed(2)}R</td><td class="src">${esc(t.label)}</td></tr>`).join('');
    plan = `<table class="plan">
      <tr class="entry"><th>Entry</th><td class="num">${fmtPrice(r.entry)}</td><td colspan="3">CE (50%) of zone ${fmtPrice(r.zoneBottom)}–${fmtPrice(r.zoneTop)}</td></tr>
      <tr class="sl"><th>SL</th><td class="num">${fmtPrice(r.stop)}</td><td class="num">${up ? '−' : '+'}${fmtPrice(r.risk)} <small>(${fmtPct(r.riskPct)})</small></td><td class="num">1R</td><td class="src">${esc(r.stopReason)} ${fmtPrice(r.stopBase)} ${up ? '−' : '+'} ${fmtPrice(r.buffer)} buffer</td></tr>
      ${rows}
    </table>${s.note ? `<div class="warning">⚠ ${esc(s.note)}</div>` : ''}${r.warning ? `<div class="warning">⚠ ${esc(r.warning)}</div>` : ''}`;
  } else {
    const buf = atrNow * slAtrMult;
    const inv = up ? s.originPrice - buf : s.originPrice + buf;
    plan = `<div class="muted">Entry/TP need the BOS + FVG. Invalidation (provisional SL): <b class="slc">${fmtPrice(inv)}</b> (${up ? 'below' : 'above'} leg origin ${fmtPrice(s.originPrice)})</div>`;
  }
  const extra = [
    s.sweep ? `${up ? 'Sell' : 'Buy'}-side sweep: ${esc(s.sweep.label)} ${fmtPrice(s.sweep.price)}` : null,
    esc(v.alignNote),
  ].filter(Boolean).join(' · ');
  return `<article class="setup ${stateCls} ${selectedId === s.id ? 'selected' : ''}" data-setup="${s.id}" data-tf="${v.tf}">
    <header><span class="tf">${TF_LABEL[v.tf]}</span>${biasBadge(s.direction)}<span class="score g${v.confluence.grade.replace('+', 'p')}">${v.confluence.score} · ${v.confluence.grade}</span></header>
    ${flag}<div class="state">${esc(s.label)}${lowRR && s.state === 'triggered' ? ' – <b>low R:R, skip</b>' : ''}</div>
    ${steps}${plan}<div class="extra">${extra}</div>
    <button class="show" data-setup="${s.id}" data-tf="${v.tf}">Show on chart</button>
  </article>`;
}

export function setupsCard(m: MarketAnalysis, selectedId: string | null, slAtrMult: number): string {
  const atrOf = (v: SetupView) => { const a = m.byTf[v.tf]!.atr; return a[a.length - 1] ?? 0; };
  const act = m.active.map((v) => setupCard(v, selectedId, slAtrMult, atrOf(v))).join('');
  const dev = m.developing.map((v) => setupCard(v, selectedId, slAtrMult, atrOf(v))).join('');
  return `<section class="card setups">
    <h2>Active entries <small>(price retesting the strategy FVG)</small></h2>
    ${act || '<p class="muted">No live CHoCH + BOS + FVG retest right now.</p>'}
    <h2>Developing setups</h2>
    ${dev || '<p class="muted">Nothing developing on any timeframe.</p>'}
  </section>`;
}

export function confluenceCard(v: SetupView | null): string {
  if (!v) return `<section class="card conf"><h2>Confluence</h2><p class="muted">Select a setup to see its checklist.</p></section>`;
  const c: Confluence = v.confluence;
  return `<section class="card conf">
    <h2>Confluence <small>${TF_LABEL[v.tf]} ${v.setup.direction}</small></h2>
    <div class="meter"><div style="width:${c.score}%"></div><span>${c.score}/100 · Grade ${c.grade}</span></div>
    <ul class="check">${c.items.map((i) => `<li class="${i.met}"><span>${i.met === 'yes' ? '✓' : i.met === 'partial' ? '◐' : '✗'}</span><b>${esc(i.label)}</b><em>${Math.round(i.score)}/${i.weight}</em><small>${esc(i.detail)}</small></li>`).join('')}</ul>
  </section>`;
}

export function mtfCard(m: MarketAnalysis): string {
  const rows = TIMEFRAMES.map((tf) => {
    const A = m.byTf[tf];
    if (!A) return `<tr><th>${TF_LABEL[tf]}</th><td colspan="5" class="muted">no data</td></tr>`;
    const e = A.bias.lastEvent;
    const latest = [...A.setups].reverse().find((s) => s.fresh && !['invalidated'].includes(s.setup.state));
    const emaTxt = isFinite(A.bias.ema200) ? `${A.bias.price > A.bias.ema50 ? '>' : '<'}50 · 50${A.bias.ema50 > A.bias.ema200 ? '>' : '<'}200` : isFinite(A.bias.ema50) ? `${A.bias.price > A.bias.ema50 ? '>' : '<'}50` : '–';
    const strat = latest ? `<span class="${latest.setup.direction}">${latest.setup.direction === 'bullish' ? '▲' : '▼'} ${shortState(latest.setup.state)}</span>${latest.htfAligned ? ' <span class="aligned" title="Aligned with higher-TF bias">HTF✓</span>' : ''}` : '<span class="muted">–</span>';
    return `<tr><th>${TF_LABEL[tf]}</th><td>${biasBadge(A.bias.bias)}</td><td>${e ? `${e.type} ${e.direction === 'bullish' ? '↑' : '↓'} ${fmtPrice(e.level)}` : '–'}</td><td>${emaTxt}</td><td>${strat}</td></tr>`;
  }).join('');
  return `<section class="card mtf"><h2>Top-down (multi-timeframe)</h2>
    <table><thead><tr><th>TF</th><th>Bias</th><th>Last break</th><th>EMA</th><th>Strategy</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function shortState(s: string): string {
  return ({ choch: 'CHoCH → wait BOS', bos_no_fvg: 'BOS, no FVG', waiting_retest: 'Trio ✓ wait retest', triggered: 'ENTRY', tp1_hit: 'TP1 hit', stopped: 'Stopped', invalidated: 'Invalid' } as Record<string, string>)[s] ?? s;
}

export function liquidityCard(A: TfAnalysis, m: MarketAnalysis): string {
  const price = m.price;
  const n = A.candles.length;
  const recent = A.candles[Math.max(0, n - 300)]?.time ?? 0;
  const swing = A.liquidity.filter((l) => l.time >= recent && (l.sweptTime === null || l.sweptTime >= recent));
  const unsAbove = swing.filter((l) => !l.sweptTime && l.price > price).sort((a, b) => a.price - b.price).slice(0, 5);
  const unsBelow = swing.filter((l) => !l.sweptTime && l.price < price).sort((a, b) => b.price - a.price).slice(0, 5);
  const swept = swing.filter((l) => l.sweptTime).sort((a, b) => (b.sweptTime ?? 0) - (a.sweptTime ?? 0)).slice(0, 4);
  const all: LiquidityLevel[] = [...m.keyLevels, ...unsAbove, ...unsBelow, ...swept].sort((a, b) => b.price - a.price);
  const rows = all.map((l) => `<tr class="${l.side}"><td>${esc(l.label)}</td><td class="num">${fmtPrice(l.price)}</td><td class="num">${l.price > price ? '+' : ''}${fmtPrice(l.price - price)}</td><td>${l.sweptTime ? `<span class="swept">swept ${fmtDateTime(l.sweptTime)}</span>` : '<span class="unswept">unswept</span>'}</td></tr>`).join('');
  return `<section class="card liq"><h2>Liquidity <small>${TF_LABEL[A.tf]} swings + key levels (Asia = 00:00–07:00 UK)</small></h2>
    <table><thead><tr><th>Level</th><th>Price</th><th>From price</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function fvgCard(A: TfAnalysis, m: MarketAnalysis): string {
  const zones = activeZones(A.fvgs).slice(-40).map((f) => ({ f, pol: polarityAt(f)! })).filter((z) => z.pol)
    .sort((a, b) => Math.abs((a.f.top + a.f.bottom) / 2 - m.price) - Math.abs((b.f.top + b.f.bottom) / 2 - m.price)).slice(0, 10);
  const rows = zones.map(({ f, pol }) => `<tr><td><span class="${pol}">${pol === 'bullish' ? '▲' : '▼'} ${f.invertedIndex !== null ? 'IFVG' : 'FVG'}</span></td><td class="num">${fmtPrice(f.bottom)}–${fmtPrice(f.top)}</td><td>${f.invertedIndex !== null ? 'inverted' : f.status}${f.status === 'partial' && f.invertedIndex === null ? ` ${Math.round(f.fillPct * 100)}%` : ''}</td><td>${fmtDateTime(f.time)}</td></tr>`).join('');
  return `<section class="card fvgs"><h2>Open FVGs / IFVGs <small>${TF_LABEL[A.tf]}, nearest first</small></h2>
    <table><thead><tr><th>Type</th><th>Zone</th><th>Status</th><th>Formed</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">None open</td></tr>'}</tbody></table></section>`;
}
