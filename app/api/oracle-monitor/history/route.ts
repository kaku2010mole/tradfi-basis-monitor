const BINANCE_API = "https://fapi.binance.com";
const HYPERLIQUID_INFO_API = "https://api.hyperliquid.xyz/info";
const SYMBOL_PATTERN = /^[A-Z0-9_]{2,32}$/;
const PARA_PATTERN = /^para:[A-Z0-9._-]{1,28}$/i;

type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string];
type HyperliquidCandle = { t?: number; c?: string };

const intervalForRange = (durationMs: number) => {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (durationMs <= day) return "1m";
  if (durationMs <= 5 * day) return "5m";
  if (durationMs <= 15 * day) return "15m";
  if (durationMs <= 60 * day) return "1h";
  return "4h";
};

async function getKlines(path: "klines" | "indexPriceKlines", symbol: string, start: number, end: number, interval: string) {
  const params = new URLSearchParams({
    [path === "klines" ? "symbol" : "pair"]: symbol,
    interval,
    startTime: String(start),
    endTime: String(end),
    limit: "1500",
  });
  const response = await fetch(`${BINANCE_API}/fapi/v1/${path}?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${symbol} ${path === "klines" ? "market" : "oracle"} history unavailable.`);
  return (await response.json()) as BinanceKline[];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const venue = url.searchParams.get("venue") === "Hyperliquid" ? "Hyperliquid" : "Binance";
  const rawSymbol = url.searchParams.get("symbol") || "";
  const symbol = venue === "Binance" ? rawSymbol.toUpperCase() : rawSymbol.replace(/^para:/i, "para:");
  const start = Number(url.searchParams.get("start"));
  const end = Math.min(Number(url.searchParams.get("end") || Date.now()), Date.now());
  if (venue === "Binance" && !SYMBOL_PATTERN.test(symbol)) return Response.json({ error: "Unsupported Binance oracle symbol." }, { status: 400 });
  if (venue === "Hyperliquid" && !PARA_PATTERN.test(symbol)) return Response.json({ error: "Unsupported Hyperliquid para symbol." }, { status: 400 });
  if (!Number.isFinite(start) || start <= 0 || start >= end) {
    return Response.json({ error: "A valid start time is required." }, { status: 400 });
  }

  if (venue === "Hyperliquid") {
    const interval = "5m";
    const earliest = Math.max(start, end - 5_000 * 5 * 60_000);
    try {
      const response = await fetch(HYPERLIQUID_INFO_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "candleSnapshot", req: { coin: symbol, interval, startTime: earliest, endTime: end } }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`${symbol} market history unavailable.`);
      const rows = await response.json() as HyperliquidCandle[];
      const points = rows.flatMap((row) => {
        const t = Number(row.t);
        const live = Number(row.c);
        return Number.isFinite(t) && Number.isFinite(live) && live > 0
          ? [{ t, live, oracle: null, deviation: null, source: "exchange-candle" as const }]
          : [];
      });
      if (!points.length) throw new Error(`${symbol} has no 5-minute candles in this window.`);
      return Response.json({ symbol, venue, interval, mode: "price", oracleHistory: false, points }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "History unavailable." }, { status: 502 });
    }
  }

  const interval = intervalForRange(end - start);
  try {
    const [marketRows, oracleRows] = await Promise.all([
      getKlines("klines", symbol, start, end, interval),
      getKlines("indexPriceKlines", symbol, start, end, interval),
    ]);
    const oracleByTime = new Map(oracleRows.map((row) => [row[0], Number(row[4])]));
    const points = marketRows.flatMap((row) => {
      const oracle = oracleByTime.get(row[0]);
      const live = Number(row[4]);
      if (!Number.isFinite(live) || !Number.isFinite(oracle)) return [];
      return [{ t: row[0], live, oracle: oracle as number, deviation: (live / (oracle as number) - 1) * 100, source: "binance-history" as const }];
    });
    return Response.json({ symbol, venue, interval, mode: "deviation", oracleHistory: true, points }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "History unavailable." }, { status: 502 });
  }
}
