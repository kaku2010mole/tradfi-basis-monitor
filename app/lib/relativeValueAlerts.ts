import type { MarketLeg } from "./relativeValue";

export const RELATIVE_VALUE_SNAPSHOT_KEY = "relative-value-alert-snapshot-v1";
export const RELATIVE_VALUE_SNAPSHOT_EVENT = "relative-value-alert-snapshot";
export const RELATIVE_VALUE_SIGNAL_EVENT = "relative-value-alert-signal";
export const RELATIVE_VALUE_ALERT_THRESHOLD = 2;

export type RelativeValueAlertSnapshot = {
  id: string;
  title: string;
  asset1: MarketLeg;
  asset2: MarketLeg;
  savedAt: number;
  start: number;
  baseAsset1: number;
  baseAsset2: number;
  alphaHourly: number;
  beta: number;
};

export type RelativeValueAlertSignal = {
  snapshot: RelativeValueAlertSnapshot;
  predictionError: number;
  asset2Actual: number;
  asset2Theoretical: number;
  updatedAt: number;
};
