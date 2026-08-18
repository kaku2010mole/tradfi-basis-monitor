const BINANCE_FUTURES_APIS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];
const FETCH_TIMEOUT_MS = 6_000;

type FutuPushStore = typeof globalThis & {
  __FUTU_PUSH_SNAPSHOT__?: {
    payload: { history?: Record<string, Array<[number, number]>> };
    receivedAt: number;
  };
};

type BinanceKline = [number, string, string, string, string, ...unknown[]];

const validStock = (value: string | null) => value?.trim().toUpperCase().match(/^HK\.\d{5}$/)?.[0] ?? null;
const validPerp = (value: string | null) => value?.trim().toUpperCase().match(/^[A-Z0-9_]{3,32}USDT$/)?.[0] ?? null;

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

async function getBinanceKlines(symbol: string, startTime: number, endTime: number) {
  const query = new URLSearchParams({
    symbol,
    interval: "1m",
    startTime: String(startTime),
    endTime: String(endTime),
    limit: "1500",
  });
  let message = `${symbol}: Binance history unavailable.`;
  for (const host of BINANCE_FUTURES_APIS) {
    try {
      const response = await fetch(`${host}/fapi/v1/klines?${query}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as BinanceKline[];
      if (!Array.isArray(payload)) throw new Error("invalid response");
      return payload;
    } catch (error) {
      message = `${symbol}: ${error instanceof Error ? error.message : "Binance history unavailable."}`;
    }
  }
  throw new Error(message);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stockSymbol = validStock(url.searchParams.get("stock"));
  const perpSymbol = validPerp(url.searchParams.get("perp"));
  const sharesPerContract = positive(url.searchParams.get("shares"));
  const usdHkd = positive(url.searchParams.get("usdhkd"));
  if (!stockSymbol || !perpSymbol || sharesPerContract === null || usdHkd === null || usdHkd > 20) {
    return Response.json({ error: "Invalid stock, perp, shares, or USD/HKD mapping." }, { status: 400 });
  }

  const pushed = (globalThis as FutuPushStore).__FUTU_PUSH_SNAPSHOT__;
  const stockHistory = pushed?.payload.history?.[stockSymbol]
    ?.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && positive(point[1]) !== null)
    .slice(-720) ?? [];
  if (!stockHistory.length) {
    return Response.json({ error: "Futu one-minute history is not available from the OpenD relay yet." }, { status: 503 });
  }

  try {
    // Fetch each Hong Kong trading day separately. A single continuous Binance
    // request would spend its 1,500-bar limit on overnight/weekend minutes and
    // miss later stock-session bars.
    const stockDays = new Map<string, number[]>();
    stockHistory.forEach(([timestamp]) => {
      const hktDay = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      stockDays.set(hktDay, [...(stockDays.get(hktDay) ?? []), timestamp]);
    });
    const klines = (await Promise.all([...stockDays.values()].map((timestamps) =>
      getBinanceKlines(perpSymbol, Math.min(...timestamps), Math.max(...timestamps) + 59_999)
    ))).flat();
    const perpByMinute = new Map(klines.flatMap((bar) => {
      const timestamp = Number(bar[0]);
      const close = positive(bar[4]);
      return Number.isFinite(timestamp) && close !== null ? [[timestamp, close] as const] : [];
    }));
    const points = stockHistory.flatMap(([timestamp, stockCloseHkd]) => {
      const perpClose = perpByMinute.get(timestamp);
      if (perpClose === undefined) return [];
      const fairUsdt = stockCloseHkd * sharesPerContract / usdHkd;
      return [{
        t: timestamp,
        value: (perpClose / fairUsdt - 1) * 100,
        stockCloseHkd,
        perpClose,
      }];
    });
    if (!points.length) {
      return Response.json({ error: "No overlapping one-minute Futu and Binance history was found." }, { status: 404 });
    }
    return Response.json({
      stockSymbol,
      perpSymbol,
      interval: "1m",
      points,
      source: "Futu OpenD + Binance USD-M klines",
      timestamp: Date.now(),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Historical basis is unavailable." }, { status: 502 });
  }
}
