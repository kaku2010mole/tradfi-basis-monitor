import type { PricePoint } from "./relativeValue";

type FxQuote = { symbol?: string; bid?: number | null; ask?: number | null; last?: number | null; marketTimestamp?: number | null };
type PushPayload = { quotes?: FxQuote[]; history?: Record<string, Array<[number, number]>> };
type PushStore = typeof globalThis & { __FUTU_PUSH_SNAPSHOT__?: { payload: PushPayload; receivedAt: number } };
type FxRatesPayload = {
  success?: boolean;
  rates?: Record<string, Record<string, number>>;
};

const SYMBOL = "FX.USDKRW";
const LIVE_MAX_AGE_MS = 60_000;
const day = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

async function dailyFallback(start: number, end: number) {
  const params = new URLSearchParams({ start_date: day(start - 72 * 60 * 60_000), end_date: day(end), base: "USD", currencies: "KRW" });
  const response = await fetch(`https://api.fxratesapi.com/timeseries?${params}`, { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`USD/KRW fallback HTTP ${response.status}`);
  const payload = await response.json() as FxRatesPayload;
  if (!payload.success || !payload.rates) throw new Error("USD/KRW fallback returned no prices.");
  return Object.entries(payload.rates).flatMap(([date, rates]) => {
    const t = Date.parse(date);
    const value = Number(rates.KRW);
    return Number.isFinite(t) && Number.isFinite(value) && value > 0 ? [{ t, value }] : [];
  });
}

export async function usdKrwSeries(start: number, end: number, interval: string): Promise<PricePoint[]> {
  void interval;
  const stored = (globalThis as PushStore).__FUTU_PUSH_SNAPSHOT__;
  const history = (stored?.payload.history?.[SYMBOL] ?? []).flatMap((point) => {
    const t = Number(point?.[0]); const value = Number(point?.[1]);
    return Number.isFinite(t) && Number.isFinite(value) && value > 0 && t >= start - 72 * 60 * 60_000 && t <= end + 60_000 ? [{ t, value }] : [];
  });
  const needsLive = end >= Date.now() - 10 * 60_000;
  const quote = stored?.payload.quotes?.find((item) => item.symbol === SYMBOL);
  const bid = Number(quote?.bid); const ask = Number(quote?.ask); const last = Number(quote?.last);
  const liveValue = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : Number.isFinite(last) && last > 0 ? last : null;
  const liveTime = Number(quote?.marketTimestamp);
  const liveFresh = stored && Date.now() - stored.receivedAt <= LIVE_MAX_AGE_MS && Number.isFinite(liveTime) && Date.now() - liveTime <= LIVE_MAX_AGE_MS;
  if (needsLive && (!liveFresh || liveValue === null)) throw new Error("Fresh Posley IBKR USD/KRW is unavailable; prediction error is paused.");
  const fallback = await dailyFallback(start, end).catch(() => []);
  const rows = [...fallback, ...history];
  if (liveFresh && liveValue !== null) rows.push({ t: liveTime, value: liveValue });
  rows.sort((left, right) => left.t - right.t);
  if (!rows.length) throw new Error("USD/KRW history is unavailable.");
  return rows;
}

export async function usdKrwAt(timestamp: number) {
  const rows = await usdKrwSeries(timestamp - 72 * 60 * 60_000, timestamp + 60_000, "1m");
  const row = rows.filter((item) => item.t <= timestamp + 60_000).at(-1);
  if (!row || timestamp - row.t > 72 * 60 * 60_000) throw new Error("Fresh USD/KRW data unavailable.");
  return row;
}
