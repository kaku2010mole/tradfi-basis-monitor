import type { PricePoint, Relationship } from "./relativeValue";

const BASE = "https://api.bitget.com/api/v2/mix/market";
const STEPS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
export type BitgetBook = { symbol?: string; bidPr?: string; askPr?: string; bidSz?: string; askSz?: string; lastPr?: string; indexPrice?: string; ts?: string };
let nextRequestAt = 0;

async function requestRows<T>(path: string): Promise<T[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    // Shared pacing leaves headroom for other dashboards using the same public IP.
    const delay = Math.max(0, nextRequestAt - Date.now());
    nextRequestAt = Date.now() + delay + 150;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const response = await fetch(`${BASE}/${path}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if ((response.status === 429 || response.status === 503) && attempt < 3) {
      const retry = Number(response.headers.get("retry-after"));
      await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, Math.max(1_000 * 2 ** attempt, Number.isFinite(retry) ? retry * 1_000 : 0))));
      continue;
    }
    if (!response.ok) throw new Error(`Bitget HTTP ${response.status}`);
    const payload = await response.json() as { code?: string; msg?: string; data?: T[] };
    if (payload.code !== "00000" || !Array.isArray(payload.data)) throw new Error(`Bitget: ${payload.msg || "market data unavailable"}`);
    return payload.data;
  }
  throw new Error("Bitget request retry limit reached.");
}

let tickerCache: { expires: number; pending: Promise<BitgetBook[]> } | null = null;
export function bitgetBooks() {
  if (tickerCache && tickerCache.expires > Date.now()) return tickerCache.pending;
  const pending = requestRows<BitgetBook>("tickers?productType=usdt-futures");
  tickerCache = { expires: Date.now() + 2_000, pending };
  pending.catch(() => { if (tickerCache?.pending === pending) tickerCache = null; });
  return pending;
}

export function bitgetMidpoint(book: BitgetBook | undefined, now = Date.now()) {
  const bid = Number(book?.bidPr), ask = Number(book?.askPr), time = Number(book?.ts);
  if (![bid, ask, time].every(Number.isFinite) || bid <= 0 || ask < bid || time <= 0 || now - time > 30_000 || time - now > 5_000) return null;
  return (bid + ask) / 2;
}

export async function bitgetLivePrice(symbol: string) {
  const price = bitgetMidpoint((await bitgetBooks()).find((book) => book.symbol === symbol));
  if (!price) throw new Error(`${symbol} fresh Bitget bid/ask unavailable.`);
  return price;
}

const seriesCache = new Map<string, { expires: number; pending: Promise<PricePoint[]> }>();
export function bitgetSeries(symbol: string, start: number, end: number, interval: string): Promise<PricePoint[]> {
  const step = STEPS[interval];
  if (!step || !/^[A-Z0-9_]{2,32}$/.test(symbol) || !Number.isFinite(start) || !Number.isFinite(end) || start > end) return Promise.reject(new Error("Invalid Bitget history request."));
  const key = `${symbol}:${interval}:${start}:${Math.floor(end / step)}`;
  const cached = seriesCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.pending;
  const pending = (async () => {
    const values = new Map<number, number>();
    let cursor = Math.floor(end / step) * step + step;
    for (let page = 0; page < 60; page++) {
      const params = new URLSearchParams({ symbol, productType: "usdt-futures", granularity: interval === "1h" ? "1H" : interval, endTime: String(cursor), limit: "200" });
      const rows = await requestRows<Array<string | number>>(`history-candles?${params}`);
      if (!rows.length) break;
      const times = rows.map((row) => Number(row[0])).filter((t) => Number.isFinite(t) && t > 0);
      if (!times.length) throw new Error(`${symbol} invalid Bitget history timestamps.`);
      const earliest = Math.min(...times);
      for (const row of rows) {
        const t = Number(row[0]), value = Number(row[4]);
        if (t >= start && t <= end && Number.isFinite(value) && value > 0) values.set(t, value);
      }
      if (earliest <= start || rows.length < 200) break;
      if (earliest >= cursor) throw new Error(`${symbol} Bitget history pagination did not advance.`);
      // Bitget floors endTime to a candle boundary. Subtracting 1ms here skips a candle.
      cursor = earliest;
      if (page === 59) throw new Error(`${symbol} history range exceeds the pagination limit.`);
    }
    return [...values].sort(([a], [b]) => a - b).map(([t, value]) => ({ t, value }));
  })();
  if (seriesCache.size >= 160) seriesCache.delete(seriesCache.keys().next().value!);
  seriesCache.set(key, { expires: Date.now() + (end < Date.now() - step * 2 ? 600_000 : 30_000), pending });
  pending.catch(() => { if (seriesCache.get(key)?.pending === pending) seriesCache.delete(key); });
  return pending;
}

// Only count the monitored symbols. A failed venue request is unknown, never "not listed".
export async function relativeUniverse(relationships: Relationship[], binanceInfo: () => Promise<{ symbols?: Array<{ symbol?: string; status?: string }> }>) {
  const legs = [...new Map(relationships.flatMap((r) => [r.asset1, r.asset2]).map((leg) => [`${leg.venue}:${leg.symbol}`, leg])).values()];
  const [binance, bitget] = await Promise.all([
    legs.some((leg) => leg.venue === "binance") ? binanceInfo().then((data) => new Set((data.symbols ?? []).filter((row) => row.status === "TRADING").map((row) => row.symbol))).catch(() => null) : null,
    legs.some((leg) => leg.venue === "bitget") ? bitgetBooks().then((rows) => new Set(rows.map((row) => row.symbol))).catch(() => null) : null,
  ]);
  const known = (leg: Relationship["asset1"]): boolean | null => leg.venue === "binance" ? binance?.has(leg.symbol) ?? null : leg.venue === "bitget" ? bitget?.has(leg.symbol) ?? null : null;
  const active = legs.filter((leg) => known(leg) === true);
  return {
    count: active.length, symbols: active.map((leg) => `${leg.venue.toUpperCase()}: ${leg.symbol}`).sort(),
    typeCounts: active.reduce<Record<string, number>>((counts, leg) => { counts[leg.venue.toUpperCase()] = (counts[leg.venue.toUpperCase()] ?? 0) + 1; return counts; }, {}),
    candidates: relationships.map((r) => { const states = [known(r.asset1), known(r.asset2)]; return { id: r.id, available: states.includes(false) ? false : states.includes(null) ? null : true }; }),
  };
}
