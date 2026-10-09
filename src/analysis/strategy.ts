import type { AnalysisConfig, Candle, Direction, Fvg, LiquidityLevel, StructureEvent, StructureResult } from './types';
import { buildRiskPlan, type RiskPlan, type TargetCandidate } from './risk';
import { fmtPrice, sign } from './util';

export type SetupState = 'choch' | 'bos_no_fvg' | 'waiting_retest' | 'triggered' | 'tp1_hit' | 'stopped' | 'invalidated';

export interface StrategySetup {
  id: string;
  direction: Direction;
  state: SetupState;
  label: string;
  /** CHoCH -> BOS -> FVG all present, in that order */
  trioComplete: boolean;
  choch: StructureEvent;
  bos: StructureEvent | null;
  fvg: Fvg | null;
  fvgIsIfvg: boolean;
  originIndex: number;
  originTime: number;
  originPrice: number;
  legExtreme: number;
  legExtremeIndex: number;
  triggerIndex: number | null;
  triggerTime: number | null;
  outcomeIndex: number | null;
  invalidatedIndex: number | null;
  invalidReason: string | null;
  sweep: LiquidityLevel | null;
  risk: RiskPlan | null;
  /** bar index of the most recent state change (c.length = live candle) */
  lastChangeIndex: number;
  /** extra caution shown with the setup (e.g. price ran away from an untested FVG) */
  note: string | null;
}

export interface StrategyContext {
  cfg: AnalysisConfig;
  atr: number[];
  /** same-TF swing/equal liquidity + key levels (PDH/PDL/PWH/PWL/Asian) */
  liquidity: LiquidityLevel[];
  /** next higher timeframe liquidity (for TP2/TP3) */
  htfLiquidity: LiquidityLevel[];
  /** the still-forming candle: used only for wick touches (entry trigger / SL / TP), never for closes */
  live?: Candle | null;
}

const KEY_KINDS = new Set(['PDH', 'PDL', 'PWH', 'PWL', 'ASH', 'ASL', 'equal']);

export const STATE_TEXT: Record<SetupState, string> = {
  choch: 'CHoCH formed – waiting for BOS',
  bos_no_fvg: 'CHoCH + BOS confirmed – no FVG inside the leg (trio incomplete)',
  waiting_retest: 'Strategy setup: CHoCH + BOS + FVG – waiting for FVG retest',
  triggered: 'Strategy setup: CHoCH + BOS + FVG – ENTRY: price is in the FVG',
  tp1_hit: 'Played out – TP1 reached',
  stopped: 'Stopped out',
  invalidated: 'Invalidated',
};

/**
 * Anthoni's strategy as a per-timeframe state machine, one candidate per CHoCH:
 *  1. CHoCH: close through the opposite-side swing against the prevailing structure.
 *  2. BOS: the next structure event is a close beyond the next swing in the same (new) direction.
 *  3. FVG: a same-direction FVG whose middle candle lies inside the displacement leg (origin -> BOS bar),
 *     or an opposite FVG that was inverted (IFVG) during that leg.
 *  4. Entry trigger: after the BOS, price wicks back into that zone while structure is intact.
 * Invalidation: an opposite structure event, or a close beyond the leg origin; before entry also a close
 * through the far side of the FVG.
 */
export function detectSetups(c: Candle[], st: StructureResult, fvgs: Fvg[], ctx: StrategyContext): StrategySetup[] {
  const out: StrategySetup[] = [];
  const n = c.length;
  const live = ctx.live ?? null;
  const bars: Candle[] = live ? [...c, live] : c;
  const events = st.events;

  events.forEach((e, ei) => {
    if (e.type !== 'CHoCH') return;
    const d = e.direction;
    const s = sign(d);
    const next = events[ei + 1];
    const bos = next && next.direction === d ? next : null;
    const oppEvent = events.slice(ei + 1).find((x) => x.direction !== d) ?? null;
    let originBreak: number | null = null;
    for (let j = e.breakIndex + 1; j < n; j++) {
      if (s * (c[j].close - e.originPrice) < 0) { originBreak = j; break; }
    }
    const structInvalid = minIdx(oppEvent?.breakIndex ?? null, originBreak);
    const structReason = structInvalid !== null && oppEvent && oppEvent.breakIndex === structInvalid
      ? `opposite ${oppEvent.type} at ${fmtPrice(oppEvent.level)}`
      : `close ${d === 'bullish' ? 'below' : 'above'} the leg origin ${fmtPrice(e.originPrice)}`;

    const setup: StrategySetup = {
      id: `setup-${e.breakTime}-${d}`, direction: d, state: 'choch', label: STATE_TEXT.choch, trioComplete: false,
      choch: e, bos: null, fvg: null, fvgIsIfvg: false, originIndex: e.originIndex, originTime: c[e.originIndex].time,
      originPrice: e.originPrice, legExtreme: NaN, legExtremeIndex: e.breakIndex, triggerIndex: null, triggerTime: null,
      outcomeIndex: null, invalidatedIndex: null, invalidReason: null, sweep: findSweep(c, e, ctx.liquidity), risk: null,
      lastChangeIndex: e.breakIndex, note: null,
    };

    const invalidate = (idx: number, reason: string) => {
      setup.state = 'invalidated';
      setup.invalidatedIndex = idx;
      setup.invalidReason = reason;
      setup.label = `Invalidated – ${reason}`;
      setup.lastChangeIndex = idx;
    };

    if (!bos || (structInvalid !== null && structInvalid < bos.breakIndex)) {
      setLegExtreme(setup, c, structInvalid ?? n - 1);
      if (structInvalid !== null) invalidate(structInvalid, structReason);
      out.push(setup);
      return;
    }
    setup.bos = bos;
    setup.lastChangeIndex = bos.breakIndex;

    // FVG inside the displacement leg
    const lo = e.originIndex;
    const hi = bos.breakIndex;
    const fvgCands = fvgs.filter((f) => f.direction === d && f.index > lo && f.index <= hi && !(f.invertedIndex !== null && f.invertedIndex <= hi));
    const ifvgCands = fvgs.filter((f) => f.direction !== d && f.invertedIndex !== null && f.invertedIndex >= lo && f.invertedIndex <= hi
      && !(f.ifvgInvalidatedIndex !== null && f.ifvgInvalidatedIndex <= hi));
    let fvg: Fvg | null = fvgCands.sort((a, b) => b.index - a.index)[0] ?? null;
    let isIfvg = false;
    if (!fvg) {
      fvg = ifvgCands.sort((a, b) => (b.invertedIndex ?? 0) - (a.invertedIndex ?? 0))[0] ?? null;
      isIfvg = !!fvg;
    }
    if (!fvg) {
      setup.state = 'bos_no_fvg';
      setup.label = STATE_TEXT.bos_no_fvg;
      setLegExtreme(setup, c, structInvalid ?? n - 1);
      if (structInvalid !== null) invalidate(structInvalid, structReason);
      out.push(setup);
      return;
    }
    setup.fvg = fvg;
    setup.fvgIsIfvg = isIfvg;
    setup.trioComplete = true;
    setup.state = 'waiting_retest';
    setup.label = STATE_TEXT.waiting_retest;

    const far = d === 'bullish' ? fvg.bottom : fvg.top;
    const start = Math.max(bos.breakIndex + 1, fvg.index + 2, isIfvg ? (fvg.invertedIndex ?? 0) + 1 : 0);

    // find trigger bar first (to freeze the leg extreme used for targets)
    let trig: number | null = null;
    let preInvalid: { idx: number; reason: string } | null = null;
    for (let j = start; j < bars.length; j++) {
      const k = bars[j];
      const isLive = j >= n;
      if (!isLive && structInvalid !== null && j >= structInvalid) { preInvalid = { idx: structInvalid, reason: structReason }; break; }
      // retest = the bar actually trades inside the zone (a bar gapping entirely past it is not a fill)
      if (k.low <= fvg.top && k.high >= fvg.bottom) { trig = j; break; }
      if (!isLive && s * (k.close - far) < 0) { preInvalid = { idx: j, reason: 'FVG closed through before entry' }; break; }
    }
    setLegExtreme(setup, c, Math.min(n - 1, (trig ?? preInvalid?.idx ?? n) - 1));
    // untested setup: the still-forming candle can extend the leg too (targets must lie beyond what price already traded)
    if (trig === null && !preInvalid && live && (d === 'bullish' ? live.high > setup.legExtreme : live.low < setup.legExtreme)) {
      setup.legExtreme = d === 'bullish' ? live.high : live.low;
      setup.legExtremeIndex = n;
    }
    // targets are judged at the moment of entry (or now, if the FVG has not been retested yet)
    const evalIdx = trig ?? (preInvalid ? preInvalid.idx : bars.length - 1);
    setup.risk = planRisk(setup, c, fvgs, ctx, Math.min(evalIdx, n - 1), bars[evalIdx]?.time ?? c[n - 1].time);

    if (trig === null && !preInvalid && setup.risk) {
      const r = setup.risk;
      const px = bars[bars.length - 1].close;
      const tp1 = r.targets[0]?.price;
      if (tp1 !== undefined && s * (tp1 - r.entry) > 0) {
        const done = (s * (px - r.entry)) / (s * (tp1 - r.entry));
        if (done >= 0.5) setup.note = `Price has already run ${fmtPrice(Math.abs(px - r.entry))} away from the entry (${Math.round(Math.min(done, 1) * 100)}% of the way to TP1) without retesting the FVG. Don't chase it – only valid if price comes back to ${fmtPrice(r.entry)}.`;
      }
    }

    if (preInvalid && trig === null) {
      invalidate(preInvalid.idx, preInvalid.reason);
      out.push(setup);
      return;
    }
    if (trig === null) { out.push(setup); return; }

    setup.state = 'triggered';
    setup.label = STATE_TEXT.triggered;
    setup.triggerIndex = trig;
    setup.triggerTime = bars[trig].time;
    setup.lastChangeIndex = trig;
    const risk = setup.risk!;
    const tp1 = risk.targets[0]?.price;
    for (let j = trig; j < bars.length; j++) {
      const k = bars[j];
      const isLive = j >= n;
      if (s * ((d === 'bullish' ? k.low : k.high) - risk.stop) <= 0) {
        setup.state = 'stopped'; setup.label = STATE_TEXT.stopped; setup.outcomeIndex = j; setup.lastChangeIndex = j; break;
      }
      if (tp1 !== undefined && s * ((d === 'bullish' ? k.high : k.low) - tp1) >= 0 && j > trig) {
        setup.state = 'tp1_hit'; setup.label = STATE_TEXT.tp1_hit; setup.outcomeIndex = j; setup.lastChangeIndex = j; break;
      }
      if (!isLive && structInvalid !== null && j >= structInvalid) { invalidate(structInvalid, structReason); break; }
    }
    out.push(setup);
  });
  return out;
}

function minIdx(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function setLegExtreme(setup: StrategySetup, c: Candle[], until: number) {
  const bull = setup.direction === 'bullish';
  let best = setup.originIndex;
  let val = bull ? -Infinity : Infinity;
  for (let j = setup.originIndex; j <= Math.max(setup.originIndex, Math.min(until, c.length - 1)); j++) {
    const v = bull ? c[j].high : c[j].low;
    if (bull ? v > val : v < val) { val = v; best = j; }
  }
  setup.legExtreme = val;
  setup.legExtremeIndex = best;
}

/** Opposite-side liquidity taken by the move into the leg origin (e.g. sell-side sweep before a bullish CHoCH). */
function findSweep(c: Candle[], e: StructureEvent, liq: LiquidityLevel[]): LiquidityLevel | null {
  const side = e.direction === 'bullish' ? 'sell' : 'buy';
  const from = c[e.swingIndex].time;
  const originTime = c[e.originIndex].time;
  const s = sign(e.direction);
  const cands = liq.filter((l) => l.side === side && l.sweptTime !== null && l.sweptTime >= from && l.sweptTime <= originTime
    && l.time < l.sweptTime && s * (l.price - e.originPrice) >= 0);
  cands.sort((a, b) => {
    const ka = KEY_KINDS.has(a.kind) ? 0 : 1;
    const kb = KEY_KINDS.has(b.kind) ? 0 : 1;
    return ka - kb || s * (a.price - b.price);
  });
  return cands[0] ?? null;
}

/**
 * Targets are evaluated at `evalTime` (entry bar, or now for an untested setup): only opposing liquidity that
 * exists and is still unswept at that moment, and nothing inside the leg price has already traded (minTarget = leg extreme).
 */
function planRisk(setup: StrategySetup, c: Candle[], fvgs: Fvg[], ctx: StrategyContext, evalIdx: number, evalTime: number): RiskPlan {
  const d = setup.direction;
  const bos = setup.bos!;
  const fvg = setup.fvg!;
  const at = bos.breakIndex;
  const oppSide = d === 'bullish' ? 'buy' : 'sell';
  const known = (l: LiquidityLevel) => l.side === oppSide && l.time <= evalTime && (l.sweptTime === null || l.sweptTime > evalTime);
  const toCand = (l: LiquidityLevel): TargetCandidate => ({ price: l.price, label: l.tf ? `${l.tf.toUpperCase()} ${l.label}` : l.label });
  const legLabel = d === 'bullish' ? 'Leg high (BOS swing – buy-side liquidity)' : 'Leg low (BOS swing – sell-side liquidity)';
  const tp1Candidates: TargetCandidate[] = [
    ...ctx.liquidity.filter(known).map(toCand),
    ...(isFinite(setup.legExtreme) ? [{ price: setup.legExtreme, label: legLabel }] : []),
  ];
  const oppFvgs = fvgs.filter((f) => f.direction !== d && f.index + 1 <= evalIdx
    && (f.invertedIndex === null || f.invertedIndex > evalIdx) && (f.mitigatedIndex === null || f.mitigatedIndex > evalIdx));
  const tp2Candidates: TargetCandidate[] = [
    ...oppFvgs.map((f) => ({ price: d === 'bullish' ? f.bottom : f.top, label: `${d === 'bullish' ? 'Bearish' : 'Bullish'} FVG ${fmtPrice(f.bottom)}–${fmtPrice(f.top)}` })),
    ...ctx.htfLiquidity.filter(known).map(toCand),
  ];
  const tp3Candidates: TargetCandidate[] = [
    ...ctx.htfLiquidity.filter((l) => known(l) && l.kind === 'swing').map((l) => ({ ...toCand(l), label: `Major swing ${d === 'bullish' ? 'high' : 'low'}${l.tf ? ` (${l.tf.toUpperCase()})` : ''}` })),
    ...ctx.liquidity.filter((l) => known(l) && l.kind === 'swing').map((l) => ({ ...toCand(l), label: `Swing ${d === 'bullish' ? 'high' : 'low'}` })),
  ];
  return buildRiskPlan({
    direction: d, zoneTop: fvg.top, zoneBottom: fvg.bottom, originPrice: setup.originPrice, sweepPrice: setup.sweep?.price ?? null,
    atr: ctx.atr[at] ?? ctx.atr[ctx.atr.length - 1] ?? 0, slAtrMult: ctx.cfg.slAtrMult, minRR: ctx.cfg.minRR,
    tp1Candidates, tp2Candidates, tp3Candidates, minTarget: isFinite(setup.legExtreme) ? setup.legExtreme : null,
  });
}
