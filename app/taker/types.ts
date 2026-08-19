export type TakerDirection = "shortA" | "longA";

export type HyperliquidBbo = {
  coin: string;
  bid: number;
  ask: number;
  bidSize: number | null;
  askSize: number | null;
  timestamp: number;
};

export type TakerQuote = {
  legA: HyperliquidBbo;
  legB: HyperliquidBbo;
  fairRatio: number;
  spreads: { shortALongB: number; longAShortB: number };
  liquidityUsd: { shortALongB: number | null; longAShortB: number | null };
  timestamp: number;
};

export type SelectedTakerDirection = {
  direction: TakerDirection;
  spread: number | null;
  shortLeg: string;
  longLeg: string;
  liquidityUsd: number | null;
};
