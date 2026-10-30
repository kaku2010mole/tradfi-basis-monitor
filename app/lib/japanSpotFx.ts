import type { RealQuote } from "./japanEstimate";

export function parseJapanSpotFx(payload: unknown, now: number): RealQuote | null {
  const meta = (payload as { chart?: { result?: Array<{ meta?: { symbol?: string; currency?: string; instrumentType?: string; regularMarketPrice?: number; regularMarketTime?: number } }> } })?.chart?.result?.[0]?.meta;
  if (meta?.symbol !== "JPY=X" || meta.currency !== "JPY" || meta.instrumentType !== "CURRENCY") return null;
  const price = Number(meta.regularMarketPrice), timestamp = Number(meta.regularMarketTime) * 1000;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 5000 || now - timestamp > 7 * 86_400_000) return null;
  return { price, timestamp, kind: "last", source: "Yahoo USD/JPY · 现货汇率参考" };
}
type Cache = { quote: RealQuote | null; refreshAt: number; pending?: Promise<void> };
const root = globalThis as typeof globalThis & { __JAPAN_SPOT_FX__?: Cache };
export function japanSpotFx(now: number): RealQuote | null {
  const cache = root.__JAPAN_SPOT_FX__ ??= { quote: null, refreshAt: 0 };
  if (!cache.pending && now >= cache.refreshAt) {
    cache.pending = (async () => {
      try {
        const response = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/JPY=X?range=1d&interval=1m", { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error("Spot FX unavailable");
        const quote = parseJapanSpotFx(await response.json(), Date.now());
        if (quote && (!cache.quote || quote.timestamp >= cache.quote.timestamp)) cache.quote = quote;
      } catch { /* Retain the original market timestamp; never use a contract index. */ }
      finally { cache.refreshAt = Date.now() + 60_000; cache.pending = undefined; }
    })();
  }
  return cache.quote && cache.quote.timestamp <= now + 5000 && now - cache.quote.timestamp <= 7 * 86_400_000 ? cache.quote : null;
}
