export type TakerDirection = "shortHyper" | "longHyper";

export type TakerQuote = {
  hyperliquid: { coin: string; bid: number; ask: number; bidSize: number | null; askSize: number | null; timestamp: number };
  binance: { symbol: string; bid: number; ask: number; bidSize: number | null; askSize: number | null; timestamp: number };
  multiplier: number;
  spreads: { shortHyperLongBinance: number; longHyperShortBinance: number };
  timestamp: number;
};

export type SelectedTakerDirection = {
  direction: TakerDirection;
  spread: number | null;
  shortLeg: string;
  longLeg: string;
};
