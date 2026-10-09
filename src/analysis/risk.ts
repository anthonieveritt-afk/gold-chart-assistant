import type { Direction } from './types';
import { fmtPrice, sign } from './util';

export interface TargetCandidate {
  price: number;
  label: string;
}
export interface RiskTarget extends TargetCandidate {
  name: 'TP1' | 'TP2' | 'TP3';
  distance: number; // absolute price distance from entry
  distancePct: number;
  rr: number;
}
export interface RiskInput {
  direction: Direction;
  zoneTop: number;
  zoneBottom: number;
  /** extreme that started the CHoCH/BOS leg */
  originPrice: number;
  /** liquidity level swept before the CHoCH, if any */
  sweepPrice?: number | null;
  atr: number;
  slAtrMult: number;
  minRR: number;
  /** TP1: nearest opposing liquidity (swing highs, equal highs, PDH/PWH, Asian high, leg high for longs) */
  tp1Candidates: TargetCandidate[];
  /** TP2: next opposing FVG or higher-timeframe liquidity */
  tp2Candidates: TargetCandidate[];
  /** TP3 (optional): next major swing */
  tp3Candidates: TargetCandidate[];
  /** every target must be at or beyond this price (the leg extreme already traded: liquidity inside the leg is gone) */
  minTarget?: number | null;
}
export interface RiskPlan {
  direction: Direction;
  entry: number; // FVG consequent encroachment (50%)
  zoneTop: number;
  zoneBottom: number;
  stop: number;
  stopBase: number;
  stopReason: string;
  buffer: number;
  risk: number;
  riskPct: number;
  targets: RiskTarget[];
  tp1RR: number | null;
  lowRR: boolean;
  warning: string | null;
}

/**
 * Entry = 50% (CE) of the strategy FVG.
 * SL = beyond the leg origin (or the swept liquidity level if further) ± ATR buffer.
 * TP1 = nearest opposing liquidity beyond the zone; TP2 = next opposing FVG / HTF liquidity beyond TP1;
 * TP3 = next major swing beyond TP2. R:R = reward / risk measured from the CE entry.
 */
export function buildRiskPlan(inp: RiskInput): RiskPlan {
  const s = sign(inp.direction);
  const entry = (inp.zoneTop + inp.zoneBottom) / 2;
  let stopBase = inp.originPrice;
  let stopReason = inp.direction === 'bullish' ? 'below the swing low that started the leg' : 'above the swing high that started the leg';
  if (inp.sweepPrice != null && s * (inp.originPrice - inp.sweepPrice) > 0) {
    stopBase = inp.sweepPrice;
    stopReason = inp.direction === 'bullish' ? 'below the swept sell-side liquidity' : 'above the swept buy-side liquidity';
  }
  const buffer = Math.max(0, inp.atr * inp.slAtrMult);
  const stop = stopBase - s * buffer;
  const risk = Math.abs(entry - stop);
  const farEdge = inp.direction === 'bullish' ? inp.zoneTop : inp.zoneBottom;
  const beyond = (p: number, ref: number) => s * (p - ref) > 1e-9;
  const nearestBeyond = (list: TargetCandidate[], ref: number) =>
    list.filter((t) => isFinite(t.price) && beyond(t.price, ref)).sort((a, b) => s * (a.price - b.price))[0] ?? null;

  const mk = (name: RiskTarget['name'], t: TargetCandidate): RiskTarget => ({
    ...t, name, distance: Math.abs(t.price - entry), distancePct: (Math.abs(t.price - entry) / entry) * 100,
    rr: risk > 0 ? (s * (t.price - entry)) / risk : 0,
  });
  const targets: RiskTarget[] = [];
  const floor = inp.minTarget != null && isFinite(inp.minTarget) && s * (inp.minTarget - farEdge) > 0 ? inp.minTarget : null;
  const tp1List = floor === null ? inp.tp1Candidates : inp.tp1Candidates.filter((t) => s * (t.price - floor) >= -1e-9);
  const measured = entry + s * 2 * risk;
  const tp1c = nearestBeyond(tp1List, farEdge)
    ?? (floor !== null && s * (floor - measured) > 0 ? { price: floor, label: 'Leg extreme (buy/sell-side liquidity)' } : { price: measured, label: '2R measured move (no opposing liquidity found)' });
  const tp1 = mk('TP1', tp1c);
  targets.push(tp1);
  const tp2c = nearestBeyond(inp.tp2Candidates, tp1.price) ?? nearestBeyond(inp.tp1Candidates, tp1.price);
  if (tp2c) {
    const tp2 = mk('TP2', tp2c);
    targets.push(tp2);
    const tp3c = nearestBeyond(inp.tp3Candidates, tp2.price);
    if (tp3c) targets.push(mk('TP3', tp3c));
  }
  const lowRR = tp1.rr < inp.minRR;
  return {
    direction: inp.direction, entry, zoneTop: inp.zoneTop, zoneBottom: inp.zoneBottom, stop, stopBase, stopReason, buffer,
    risk, riskPct: (risk / entry) * 100, targets, tp1RR: tp1.rr, lowRR,
    warning: lowRR ? `TP1 R:R ${tp1.rr.toFixed(2)} is below your minimum ${inp.minRR.toFixed(2)} – skip, or wait for a deeper entry (TP1 ${fmtPrice(tp1.price)})` : null,
  };
}
