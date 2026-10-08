export type Timeframe = '1w' | '1d' | '4h' | '1h' | '15m' | '5m';
export const TIMEFRAMES: Timeframe[] = ['1w', '1d', '4h', '1h', '15m', '5m'];
export const TF_SECONDS: Record<Timeframe, number> = {
  '1w': 604800, '1d': 86400, '4h': 14400, '1h': 3600, '15m': 900, '5m': 300,
};
export const TF_LABEL: Record<Timeframe, string> = {
  '1w': '1W', '1d': '1D', '4h': '4H', '1h': '1H', '15m': '15M', '5m': '5M',
};
/** Timeframes strictly higher than tf, nearest first. */
export function higherTimeframes(tf: Timeframe): Timeframe[] {
  const i = TIMEFRAMES.indexOf(tf);
  return TIMEFRAMES.slice(0, i).reverse();
}

export type Direction = 'bullish' | 'bearish';
export type Bias = Direction | 'ranging';

export interface Candle {
  time: number; // unix seconds (UTC), bar open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Swing {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
  /** index of the bar on which the swing becomes known (index + lookback) */
  confirmedIndex: number;
}

export interface StructureEvent {
  type: 'BOS' | 'CHoCH';
  direction: Direction;
  /** price of the swing that was broken */
  level: number;
  swingIndex: number;
  swingTime: number;
  /** bar whose CLOSE broke the level */
  breakIndex: number;
  breakTime: number;
  /** extreme (lowest low for bullish, highest high for bearish) between swing and break: start of the displacement leg */
  originIndex: number;
  originPrice: number;
}

export interface StructureResult {
  swings: Swing[];
  events: StructureEvent[];
  trend: Direction | 'none';
  lastSwingHigh: Swing | null;
  lastSwingLow: Swing | null;
}

export type FvgStatus = 'unfilled' | 'partial' | 'mitigated';

export interface Fvg {
  id: string;
  direction: Direction; // original polarity
  top: number;
  bottom: number;
  /** middle candle of the 3-candle pattern */
  index: number;
  /** time of the first candle of the pattern (box start) */
  time: number;
  status: FvgStatus;
  /** 0..1 how much of the gap has been traded into */
  fillPct: number;
  mitigatedIndex: number | null;
  /** bar that CLOSED through the gap: from then on it is an inverted FVG of opposite polarity */
  invertedIndex: number | null;
  /** bar that closed back through an IFVG, invalidating it */
  ifvgInvalidatedIndex: number | null;
}

export type LiquidityKind = 'swing' | 'equal' | 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'ASH' | 'ASL';

export interface LiquidityLevel {
  id: string;
  /** buy-side = resting above highs; sell-side = resting below lows */
  side: 'buy' | 'sell';
  kind: LiquidityKind;
  label: string;
  price: number;
  /** time from which the level exists */
  time: number;
  sweptTime: number | null;
  /** optional: higher-timeframe origin */
  tf?: Timeframe;
}

export interface AnalysisConfig {
  swingLookback: number;
  /** stop buffer as multiple of ATR(14) */
  slAtrMult: number;
  /** minimum TP1 reward:risk to count as a valid entry */
  minRR: number;
  /** ignore FVGs smaller than this multiple of ATR */
  fvgMinAtr: number;
  /** equal highs/lows tolerance as multiple of ATR */
  eqTolAtr: number;
  /** setups whose last state change is older than this many bars are treated as history */
  setupMaxAgeBars: number;
}

export const DEFAULT_CONFIG: AnalysisConfig = {
  swingLookback: 5,
  slAtrMult: 0.25,
  minRR: 1,
  fvgMinAtr: 0.05,
  eqTolAtr: 0.1,
  setupMaxAgeBars: 60,
};
