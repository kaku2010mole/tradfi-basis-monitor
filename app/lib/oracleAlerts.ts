export const ORACLE_CUSTOM_PAIRS_KEY = "oracle-monitor-custom-pairs-v1";
export const ORACLE_THRESHOLD_KEY = "oracle-monitor-threshold-v1";
export const ORACLE_PAIRS_CHANGED_EVENT = "oracle-pairs-change";
export const ORACLE_THRESHOLD_CHANGED_EVENT = "oracle-threshold-change";

export const DEFAULT_ORACLE_BINANCE = [
  "HK1810USDT",
  "HK0700USDT",
  "TENCENTUSDT",
  "POPMARTUSDT",
  "KUAISHOUUSDT",
  "MEITUANUSDT",
  "CSOPSKHYNIX2LUSDT",
  "LGELECTRONICSUSDT",
  "KODEX200USDT",
  "ZHONGJIUSDT",
];
export const DEFAULT_ORACLE_PARA = ["para:OTHERS", "para:TOTAL2", "para:BTCD", "para:CIEN", "para:VST", "para:NET"];

export type OracleCustomPair = { venue: "Binance" | "Hyperliquid"; apiSymbol: string };
