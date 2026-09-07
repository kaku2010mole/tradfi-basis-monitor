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
    return Response.json({ symbol, usdHkd, interval, live: futuLivePrice(leg), points: futuPriceSeries(leg, start, end, interval), generatedAt: Date.now() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Futu data unavailable." }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
