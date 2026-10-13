import { futuLivePrice, futuPriceSeries } from "../../../lib/futuMarket";
import type { MarketLeg } from "../../../lib/relativeValue";

const SYMBOL = /^HK\.\d{5}$/;
const INTERVALS = new Set(["1m", "5m", "15m", "1h"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
  const interval = url.searchParams.get("interval") ?? "1m";
  const start = Number(url.searchParams.get("start") ?? Date.now() - 24 * 60 * 60_000);
  const end = Math.min(Number(url.searchParams.get("end") ?? Date.now()), Date.now());
  const usdHkd = Number(url.searchParams.get("usdHkd") ?? 7.84);
  if (!SYMBOL.test(symbol) || !INTERVALS.has(interval) || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isFinite(usdHkd) || usdHkd < 1 || usdHkd > 20) {
    return Response.json({ error: "Invalid Futu series request." }, { status: 400 });
  }
  const leg: MarketLeg = { venue: "futu", symbol, label: symbol, usdHkd };
  try {
    const points = futuPriceSeries(leg, start, end, interval);
    let live: number | null = null;
    try { live = futuLivePrice(leg); } catch { /* Historical cash prices remain readable after the HK session closes. */ }
    if (!points.length && live === null) throw new Error(`${symbol} Futu price history is unavailable.`);
    return Response.json({ symbol, usdHkd, interval, live, points: url.searchParams.get("latestOnly") === "1" ? points.slice(-1) : points, generatedAt: Date.now() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Futu data unavailable." }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
