import type { MarketLeg, PricePoint } from "./relativeValue";

type FutuQuote = {
  symbol?: string;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  marketTimestamp?: number | null;
};

type FutuPayload = {
  generatedAt?: number;
  quotes?: FutuQuote[];
  history?: Record<string, Array<[number, number]>>;
};

type FutuStore = typeof globalThis & {
  __FUTU_PUSH_SNAPSHOT__?: { payload: FutuPayload; receivedAt: number };
};

const INTERVAL_MS: Record<string, number> = { "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000 };
const LIVE_MAX_AGE_MS = 30_000;

const fx = (leg: Pick<MarketLeg, "usdHkd">) => {
  const value = Number(leg.usdHkd ?? 7.84);
  if (!Number.isFinite(value) || value < 1 || value > 20) throw new Error("Futu USD/HKD conversion is invalid.");
  return value;
};

const snapshot = () => (globalThis as FutuStore).__FUTU_PUSH_SNAPSHOT__;

export function futuLivePrice(leg: MarketLeg) {
  const stored = snapshot();
  if (!stored || Date.now() - stored.receivedAt > LIVE_MAX_AGE_MS) throw new Error("Fresh Futu OpenD data is unavailable.");
  const quote = stored.payload.quotes?.find((item) => item.symbol?.toUpperCase() === leg.symbol.toUpperCase());
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  const last = Number(quote?.last);
  const hkd = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
    ? (bid + ask) / 2
    : Number.isFinite(last) && last > 0 ? last : null;
  if (hkd === null) throw new Error(`${leg.symbol} Futu price is unavailable.`);
  return hkd / fx(leg);
}

export function futuPriceSeries(leg: MarketLeg, start: number, end: number, interval: string): PricePoint[] {
  const stored = snapshot();
  if (!stored) throw new Error("Futu OpenD history is unavailable.");
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error("Unsupported Futu history interval.");
  const rate = fx(leg);
  const buckets = new Map<number, number>();
  for (const point of stored.payload.history?.[leg.symbol] ?? []) {
    const timestamp = Number(point?.[0]);
    const price = Number(point?.[1]);
    if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0 || timestamp < start || timestamp > end) continue;
    buckets.set(Math.floor(timestamp / step) * step, price / rate);
  }
  if (Date.now() - stored.receivedAt <= LIVE_MAX_AGE_MS) {
    try {
      const timestamp = Math.min(end, Number(stored.payload.generatedAt) || stored.receivedAt);
      if (timestamp >= start) buckets.set(Math.floor(timestamp / step) * step, futuLivePrice(leg));
    } catch { /* Historical closes remain usable when a live quote is incomplete. */ }
  }
  return [...buckets].sort((left, right) => left[0] - right[0]).map(([t, value]) => ({ t, value }));
}
