export type TakerDirection = "shortA" | "longA";
export type HyperliquidMarketType = "perp" | "spot";

export type HyperliquidBbo = {
  coin: string;
  bookCoin: string;
  marketType: HyperliquidMarketType;
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
  shortMarketType: HyperliquidMarketType;
  longMarketType: HyperliquidMarketType;
  liquidityUsd: number | null;
};
