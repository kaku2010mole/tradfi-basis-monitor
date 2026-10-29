type HkPerp = { perpVenue?: string; perpSymbol: string; sharesPerContract: number };

// HK-listed cash mappings verified against Bitget's USDT-M contract directory.
// SHEINHKDUSDT has no verified HKEX cash mapping and is deliberately omitted.
export const BITGET_HK_COMPARISON_PAIRS = [
  { stockSymbol: "HK.00100", perpSymbol: "MINIMAXUSDT", sharesPerContract: 1, perpVenue: "bitget" as const },
  { stockSymbol: "HK.00100", perpSymbol: "MINIMAXHKDUSDT", sharesPerContract: 1, perpVenue: "bitget" as const },
  { stockSymbol: "HK.00700", perpSymbol: "TENCENTHKDUSDT", sharesPerContract: 1, perpVenue: "bitget" as const },
  { stockSymbol: "HK.01810", perpSymbol: "XIAOMIHKDUSDT", sharesPerContract: 1, perpVenue: "bitget" as const },
  { stockSymbol: "HK.02513", perpSymbol: "ZHIPUHKDUSDT", sharesPerContract: 1, perpVenue: "bitget" as const },
  { stockSymbol: "HK.00992", perpSymbol: "LENOVOHKDUSDT", sharesPerContract: 1, perpVenue: "bitget" as const },
  { stockSymbol: "HK.07709", perpSymbol: "CSOPSK2LHKDUSDT", sharesPerContract: 1, perpVenue: "bitget" as const },
  { stockSymbol: "HK.07747", perpSymbol: "CSOPSS2LHKDUSDT", sharesPerContract: 1, perpVenue: "bitget" as const },
];

export const isBitgetHkdQuanto = (pair: Pick<HkPerp, "perpVenue" | "perpSymbol">) =>
  pair.perpVenue === "bitget" && /HKDUSDT$/.test(pair.perpSymbol.toUpperCase());

// Quanto P&L is one USDT per HKD price point. The local stock-price unit
// remains one share, but its delta hedge is USD/HKD cash shares per perp.
// Do not encode FX in the user's shares-per-price-unit setting.
export const hkPerpHedgeShares = (pair: HkPerp, usdHkd: number) => {
  if (![pair.sharesPerContract, usdHkd].every((v) => Number.isFinite(v) && v > 0)) return Number.NaN;
  return pair.sharesPerContract * (isBitgetHkdQuanto(pair) ? usdHkd : 1);
};

export function hkPerpFairPrice(stockHkd: number | null, pair: HkPerp, usdHkd: number) {
  if (stockHkd === null || ![stockHkd, pair.sharesPerContract, usdHkd].every((v) => Number.isFinite(v) && v > 0)) return null;
  return stockHkd * pair.sharesPerContract / (isBitgetHkdQuanto(pair) ? 1 : usdHkd);
}
