import type { AnalysisConfig, Bias, Candle, Fvg, LiquidityLevel, StructureResult, Swing, Timeframe } from './types';
import { higherTimeframes, isLowTf, TF_LABEL, TIMEFRAMES } from './types';
import { atr } from './util';
import { findSwings } from './swings';
import { analyseStructure } from './structure';
import { activeZones, detectFvgs, polarityAt } from './fvg';
import { keyLevels, swingLiquidity } from './liquidity';
import { computeBias, type BiasResult } from './bias';
import { detectSetups, type StrategySetup } from './strategy';
import { scoreConfluence, type Confluence, type Zone } from './confluence';

export interface TfData { tf: Timeframe; candles: Candle[]; live: Candle | null }

export interface SetupView {
  tf: Timeframe;
  setup: StrategySetup;
  confluence: Confluence;
  htfAligned: boolean;
  alignNote: string;
  ageBars: number;
  fresh: boolean;
}

export interface TfAnalysis {
  tf: Timeframe;
  candles: Candle[];
  live: Candle | null;
  atr: number[];
  swings: Swing[];
  structure: StructureResult;
  fvgs: Fvg[];
  liquidity: LiquidityLevel[];
  bias: BiasResult;
  setups: SetupView[];
}

export interface MarketAnalysis {
  byTf: Partial<Record<Timeframe, TfAnalysis>>;
  keyLevels: LiquidityLevel[];
  overall: { bias: Bias; score: number; reasons: string[] };
  active: SetupView[];
  developing: SetupView[];
  price: number;
}

/** 3M/1M are shown but don't move the overall direction score */
export const TF_WEIGHT: Record<Timeframe, number> = { '1w': 3, '1d': 3, '4h': 2, '1h': 2, '15m': 1, '5m': 0.5, '3m': 0, '1m': 0 };

export function analyseMarket(data: Partial<Record<Timeframe, TfData>>, cfg: AnalysisConfig, nowSec: number): MarketAnalysis {
  const byTf: Partial<Record<Timeframe, TfAnalysis>> = {};
  const lowest = [...TIMEFRAMES].reverse().find((t) => data[t]?.candles.length);
  const lowestData = lowest ? data[lowest]! : null;
  const price = lowestData ? (lowestData.live ?? lowestData.candles[lowestData.candles.length - 1])?.close ?? NaN : NaN;

  for (const tf of TIMEFRAMES) {
    const d = data[tf];
    if (!d || d.candles.length < 20) continue;
    const c = d.candles;
    const a = atr(c);
    const swings = findSwings(c, isLowTf(tf) ? cfg.ltfSwingLookback : cfg.swingLookback);
    const structure = analyseStructure(c, swings);
    const fvgs = detectFvgs(c, a, cfg.fvgMinAtr);
    const liquidity = swingLiquidity(c, swings, a[a.length - 1], cfg.eqTolAtr).map((l) => ({ ...l, tf }));
    const bias = computeBias(c, structure, d.live?.close ?? undefined);
    byTf[tf] = { tf, candles: c, live: d.live, atr: a, swings, structure, fvgs, liquidity, bias, setups: [] };
  }

  const intraday = data['15m']?.candles ?? data['1h']?.candles ?? data['5m']?.candles ?? [];
  const kl = keyLevels(data['1d']?.candles ?? [], data['1w']?.candles ?? [], intraday, nowSec);

  const biases: Partial<Record<Timeframe, Bias>> = {};
  for (const tf of TIMEFRAMES) if (byTf[tf]) biases[tf] = byTf[tf]!.bias.bias;

  const zonesFor = (tf: Timeframe): Zone[] => {
    const tfs = [tf, ...higherTimeframes(tf)];
    const z: Zone[] = [];
    for (const t of tfs) {
      const A = byTf[t];
      if (!A) continue;
      for (const f of activeZones(A.fvgs)) {
        const p = polarityAt(f);
        if (p) z.push({ top: f.top, bottom: f.bottom, polarity: p, id: f.id, tf: t });
      }
    }
    return z;
  };

  for (const tf of TIMEFRAMES) {
    const A = byTf[tf];
    if (!A) continue;
    const htf = higherTimeframes(tf).find((t) => byTf[t]);
    const ownLiq = [...A.liquidity.map((l) => ({ ...l, tf: undefined })), ...kl];
    const htfLiq = htf ? byTf[htf]!.liquidity : [];
    const setups = detectSetups(A.candles, A.structure, A.fvgs, { cfg, atr: A.atr, liquidity: ownLiq, htfLiquidity: htfLiq, live: A.live });
    const zones = zonesFor(tf);
    const n = A.candles.length;
    const htfs = higherTimeframes(tf).slice(0, 2).filter((t) => biases[t]);
    A.setups = setups.map((setup) => {
      const confluence = scoreConfluence({ setup, tf, biases, price, ema50: A.bias.ema50, ema200: A.bias.ema200, zones });
      const aligned = htfs.length > 0 && htfs.every((t) => biases[t] === setup.direction);
      const alignNote = htfs.length === 0 ? 'Top timeframe'
        : aligned ? `Aligned with ${htfs.map((t) => TF_LABEL[t]).join(' & ')} bias`
        : `Against/mixed HTF: ${htfs.map((t) => `${TF_LABEL[t]} ${biases[t]}`).join(', ')}`;
      const ageBars = n - setup.lastChangeIndex;
      return { tf, setup, confluence, htfAligned: aligned, alignNote, ageBars, fresh: ageBars <= cfg.setupMaxAgeBars };
    });
  }

  const active: SetupView[] = [];
  const developing: SetupView[] = [];
  for (const tf of TIMEFRAMES) {
    const A = byTf[tf];
    if (!A) continue;
    for (const dir of ['bullish', 'bearish'] as const) {
      const latest = [...A.setups].reverse().find((v) => v.setup.direction === dir);
      if (!latest || !latest.fresh) continue;
      if (latest.setup.state === 'triggered') active.push(latest);
      else if (['choch', 'bos_no_fvg', 'waiting_retest'].includes(latest.setup.state)) developing.push(latest);
    }
  }
  const order = (a: SetupView, b: SetupView) =>
    (a.setup.direction === 'bullish' ? 0 : 1) - (b.setup.direction === 'bullish' ? 0 : 1) || b.confluence.score - a.confluence.score;
  active.sort((a, b) => Number(!!a.setup.risk?.lowRR) - Number(!!b.setup.risk?.lowRR) || order(a, b));
  developing.sort((a, b) => Number(b.setup.trioComplete) - Number(a.setup.trioComplete) || order(a, b));

  // overall direction
  let num = 0;
  let den = 0;
  const reasons: string[] = [];
  for (const tf of TIMEFRAMES) {
    const A = byTf[tf];
    if (!A || !TF_WEIGHT[tf]) continue;
    const v = A.bias.bias === 'bullish' ? 1 : A.bias.bias === 'bearish' ? -1 : 0;
    num += v * TF_WEIGHT[tf];
    den += TF_WEIGHT[tf];
  }
  const score = den ? num / den : 0;
  const overallBias: Bias = score >= 0.3 ? 'bullish' : score <= -0.3 ? 'bearish' : 'ranging';
  const htfList = (['1w', '1d', '4h'] as Timeframe[]).filter((t) => byTf[t]);
  reasons.push(`Weighted MTF score ${(score * 100).toFixed(0)} (−100 bearish … +100 bullish); HTF: ${htfList.map((t) => `${TF_LABEL[t]} ${byTf[t]!.bias.bias}`).join(', ')}`);
  for (const t of ['1d', '4h'] as Timeframe[]) {
    const A = byTf[t];
    if (A) reasons.push(`${TF_LABEL[t]}: ${A.bias.reasons.join('; ')}`);
  }
  const ltf = (['1h', '15m'] as Timeframe[]).filter((t) => byTf[t]);
  if (ltf.length) reasons.push(`LTF: ${ltf.map((t) => `${TF_LABEL[t]} ${byTf[t]!.bias.bias}`).join(', ')}`);

  return { byTf, keyLevels: kl, overall: { bias: overallBias, score, reasons }, active, developing, price };
}
