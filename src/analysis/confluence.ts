import type { Bias, Timeframe } from './types';
import { higherTimeframes, TF_LABEL, TIMEFRAMES } from './types';
import type { StrategySetup } from './strategy';
import { fmtPrice } from './util';

export interface ConfluenceItem {
  key: 'trio' | 'htf' | 'sweep' | 'overlap' | 'discount' | 'ema' | 'mtf';
  label: string;
  weight: number;
  score: number;
  met: 'yes' | 'partial' | 'no';
  detail: string;
}
export interface Confluence {
  score: number; // 0..100
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';
  items: ConfluenceItem[];
}
export interface Zone { top: number; bottom: number; polarity: 'bullish' | 'bearish'; id: string; tf: Timeframe }
export interface ConfluenceInput {
  setup: StrategySetup;
  tf: Timeframe;
  biases: Partial<Record<Timeframe, Bias>>;
  price: number;
  ema50: number;
  ema200: number;
  /** active FVG/IFVG zones on this TF and higher TFs, with current polarity */
  zones: Zone[];
}

export const WEIGHTS = { trio: 30, htf: 15, sweep: 15, overlap: 10, discount: 10, ema: 10, mtf: 10 } as const;

export function gradeFor(score: number): Confluence['grade'] {
  return score >= 85 ? 'A+' : score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 40 ? 'C' : 'D';
}

export function scoreConfluence(inp: ConfluenceInput): Confluence {
  const { setup, tf } = inp;
  const d = setup.direction;
  const bull = d === 'bullish';
  const items: ConfluenceItem[] = [];
  const met = (score: number, w: number): ConfluenceItem['met'] => (score >= w - 1e-9 ? 'yes' : score > 0 ? 'partial' : 'no');
  const push = (key: ConfluenceItem['key'], label: string, score: number, detail: string) =>
    items.push({ key, label, weight: WEIGHTS[key], score, met: met(score, WEIGHTS[key]), detail });

  // 1. Strategy trio (heaviest)
  const trioScore = setup.trioComplete ? WEIGHTS.trio : setup.bos ? 15 : 8;
  push('trio', 'Strategy trio CHoCH → BOS → FVG', trioScore,
    setup.trioComplete ? `All three in order${setup.fvgIsIfvg ? ' (FVG leg uses an IFVG)' : ''}` : setup.bos ? 'CHoCH + BOS, no FVG in leg' : 'CHoCH only, waiting for BOS');

  // 2. HTF bias alignment (next two higher TFs)
  const htfs = higherTimeframes(tf).slice(0, 2).filter((t) => inp.biases[t]);
  const ref = htfs.length ? htfs : [tf];
  const agree = ref.filter((t) => inp.biases[t] === d).length;
  push('htf', 'Higher-timeframe bias aligned', (agree / ref.length) * WEIGHTS.htf,
    ref.map((t) => `${TF_LABEL[t]} ${inp.biases[t] ?? 'n/a'}`).join(', '));

  // 3. Liquidity sweep before the CHoCH
  push('sweep', `${bull ? 'Sell' : 'Buy'}-side liquidity swept before CHoCH`, setup.sweep ? WEIGHTS.sweep : 0,
    setup.sweep ? `${setup.sweep.label} ${fmtPrice(setup.sweep.price)} taken` : 'No sweep detected');

  // 4. FVG / IFVG overlap
  let overlapDetail = 'No other zone overlaps the strategy FVG';
  let overlap = 0;
  if (setup.fvg) {
    const f = setup.fvg;
    const hit = inp.zones.find((z) => z.id !== f.id && z.polarity === d && z.bottom < f.top && z.top > f.bottom);
    if (hit) { overlap = WEIGHTS.overlap; overlapDetail = `Overlaps ${TF_LABEL[hit.tf]} ${hit.polarity} zone ${fmtPrice(hit.bottom)}–${fmtPrice(hit.top)}`; }
  } else overlapDetail = 'No strategy FVG yet';
  push('overlap', 'FVG / IFVG overlap', overlap, overlapDetail);

  // 5. Discount (longs) / premium (shorts) of the leg's dealing range
  let disc = 0;
  let discDetail = 'No entry zone yet';
  if (setup.risk && isFinite(setup.legExtreme)) {
    const eq = (setup.originPrice + setup.legExtreme) / 2;
    const ok = bull ? setup.risk.entry <= eq : setup.risk.entry >= eq;
    disc = ok ? WEIGHTS.discount : 0;
    discDetail = `Entry ${fmtPrice(setup.risk.entry)} vs equilibrium ${fmtPrice(eq)} – ${ok ? (bull ? 'in discount' : 'in premium') : (bull ? 'in premium' : 'in discount')}`;
  }
  push('discount', bull ? 'Entry in discount (< 50% of leg)' : 'Entry in premium (> 50% of leg)', disc, discDetail);

  // 6. EMA context
  let emaScore = 0;
  const parts: string[] = [];
  if (isFinite(inp.ema50)) {
    const ok = bull ? inp.price > inp.ema50 : inp.price < inp.ema50;
    if (ok) emaScore += WEIGHTS.ema / 2;
    parts.push(`price ${inp.price > inp.ema50 ? '>' : '<'} EMA50`);
  }
  if (isFinite(inp.ema50) && isFinite(inp.ema200)) {
    const ok = bull ? inp.ema50 > inp.ema200 : inp.ema50 < inp.ema200;
    if (ok) emaScore += WEIGHTS.ema / 2;
    parts.push(`EMA50 ${inp.ema50 > inp.ema200 ? '>' : '<'} EMA200`);
  }
  push('ema', 'EMA 50/200 context', emaScore, parts.join(', ') || 'Not enough data');

  // 7. Multi-timeframe agreement
  const all = TIMEFRAMES.filter((t) => inp.biases[t]);
  const agreeAll = all.filter((t) => inp.biases[t] === d).length;
  push('mtf', 'Multi-timeframe agreement', all.length ? (agreeAll / all.length) * WEIGHTS.mtf : 0, `${agreeAll}/${all.length} timeframes ${d}`);

  const score = Math.round(items.reduce((a, b) => a + b.score, 0));
  return { score, grade: gradeFor(score), items };
}
