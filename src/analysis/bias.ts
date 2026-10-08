import type { Bias, Candle, StructureEvent, StructureResult } from './types';
import { ema, fmtPrice } from './util';

export interface BiasResult {
  bias: Bias;
  score: number; // -4..4
  trend: StructureResult['trend'];
  lastEvent: StructureEvent | null;
  ema50: number;
  ema200: number;
  price: number;
  reasons: string[];
}

/**
 * Per-timeframe bias = market structure (±2, or ±1 if the latest event is a fresh CHoCH)
 * + price vs EMA50 (±1) + EMA50 vs EMA200 (±1). >= +2 bullish, <= -2 bearish, otherwise ranging.
 */
export function computeBias(c: Candle[], st: StructureResult, price?: number): BiasResult {
  const closes = c.map((k) => k.close);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const ema50 = e50[e50.length - 1];
  const ema200 = e200[e200.length - 1];
  const px = price ?? closes[closes.length - 1];
  const lastEvent = st.events[st.events.length - 1] ?? null;
  const reasons: string[] = [];
  let score = 0;
  if (lastEvent) {
    const s = lastEvent.direction === 'bullish' ? 1 : -1;
    const w = lastEvent.type === 'CHoCH' ? 1 : 2;
    score += s * w;
    const arrow = s > 0 ? '↑' : '↓';
    reasons.push(lastEvent.type === 'CHoCH'
      ? `Fresh CHoCH ${arrow} (close ${s > 0 ? 'above' : 'below'} ${fmtPrice(lastEvent.level)}) – possible reversal, not yet confirmed`
      : `Structure ${lastEvent.direction}: BOS ${arrow} through ${fmtPrice(lastEvent.level)}`);
  } else {
    reasons.push('No structure break yet');
  }
  if (isFinite(ema50)) {
    score += px > ema50 ? 1 : -1;
    reasons.push(`Price ${px > ema50 ? 'above' : 'below'} EMA50 (${fmtPrice(ema50)})`);
  }
  if (isFinite(ema50) && isFinite(ema200)) {
    score += ema50 > ema200 ? 1 : -1;
    reasons.push(`EMA50 ${ema50 > ema200 ? 'above' : 'below'} EMA200 (${fmtPrice(ema200)})`);
  } else {
    reasons.push('Not enough history for EMA200');
  }
  const bias: Bias = score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'ranging';
  return { bias, score, trend: st.trend, lastEvent, ema50, ema200, price: px, reasons };
}
