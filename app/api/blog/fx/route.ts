import { usdKrwSeries } from "../../../lib/fxMarket";

const INTERVALS = new Set(["1m", "5m", "15m", "1h"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const interval = url.searchParams.get("interval") ?? "1m";
  const end = Math.min(Number(url.searchParams.get("end") ?? Date.now()), Date.now());
  const start = Number(url.searchParams.get("start") ?? end - 60 * 60_000);
  if (!INTERVALS.has(interval) || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 50 * 24 * 60 * 60_000) {
    return Response.json({ error: "Invalid USD/KRW request." }, { status: 400 });
  }
  try {
    const points = await usdKrwSeries(start, end, interval);
    return Response.json({ symbol: "KRW=X", points, live: points.at(-1)?.value ?? null, generatedAt: Date.now() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "USD/KRW unavailable." }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
