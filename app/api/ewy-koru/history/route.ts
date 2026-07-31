const BINANCE_FUTURES_API = "https://fapi.binance.com";

const PAIRS = {
  "ewy-koru": { base: "EWYUSDT", leveraged: "KORUUSDT", factor: 3 },
  "sndk-snxx": { base: "SNDKUSDT", leveraged: "SNXXUSDT", factor: 2 },
  "mrvl-mvll": { base: "MRVLUSDT", leveraged: "MVLLUSDT", factor: 2 },
  "qqq-tqqq": { base: "QQQUSDT", leveraged: "TQQQUSDT", factor: 3 },
  "tencent-hk0700": { base: "TENCENTUSDT", leveraged: "HK0700USDT", factor: 1, priceRatio: 7.84 },
} as const;

const intervalForRange = (durationMs: number) => {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (durationMs <= day) return "1m";
  if (durationMs <= 5 * day) return "5m";
  if (durationMs <= 15 * day) return "15m";
  if (durationMs <= 60 * day) return "1h";
  return "4h";
};

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

async function getKlines(symbol: string, start: number, end: number, interval: string) {
  const params = new URLSearchParams({
    symbol,
    interval,
    startTime: String(start),
    endTime: String(end),
    limit: "1500",
  });
  const response = await fetch(`${BINANCE_FUTURES_API}/fapi/v1/klines?${params}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${symbol} history request failed (${response.status})`);
  }
  return (await response.json()) as BinanceKline[];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pairId = url.searchParams.get("pair") || "ewy-koru";
  const pair = PAIRS[pairId as keyof typeof PAIRS];
  const now = Date.now();
  const start = Number(url.searchParams.get("start"));
  const requestedEnd = Number(url.searchParams.get("end") || now);
  const end = Math.min(requestedEnd, now);

  if (!pair) {
    return Response.json({ error: "Unsupported monitoring pair." }, { status: 400 });
  }

  if (!Number.isFinite(start) || start <= 0 || start >= end) {
    return Response.json({ error: "A valid start time before the end time is required." }, { status: 400 });
  }

  const interval = intervalForRange(end - start);

  try {
    const [ewy, koru] = await Promise.all([
      getKlines(pair.base, start, end, interval),
      getKlines(pair.leveraged, start, end, interval),
    ]);
    const koruByTime = new Map(koru.map((row) => [row[0], Number(row[4])]));
    const points = ewy.flatMap((row) => {
      const koruClose = koruByTime.get(row[0]);
      if (!Number.isFinite(koruClose)) return [];
      return [{
        t: row[0],
        ewy: Number(row[4]),
        koru: koruClose as number,
      }];
    });

    return Response.json(
      { interval, pairId, ...pair, points },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to load market history." },
      { status: 502 },
    );
  }
}

