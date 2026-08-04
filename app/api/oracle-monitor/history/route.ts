const BINANCE_API = "https://fapi.binance.com";
const SYMBOL_PATTERN = /^[A-Z0-9_]{2,32}$/;

type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string];

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
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const start = Number(url.searchParams.get("start"));
  const end = Math.min(Number(url.searchParams.get("end") || Date.now()), Date.now());
  if (!SYMBOL_PATTERN.test(symbol)) return Response.json({ error: "Unsupported Binance oracle symbol." }, { status: 400 });
  if (!Number.isFinite(start) || start <= 0 || start >= end) {
    return Response.json({ error: "A valid start time is required." }, { status: 400 });
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
      return [{ t: row[0], live, oracle: oracle as number, deviation: (live / (oracle as number) - 1) * 100 }];
    });
    return Response.json({ symbol, interval, points }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "History unavailable." }, { status: 502 });
  }
}
