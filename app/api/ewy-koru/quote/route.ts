const BINANCE_FUTURES_API = "https://fapi.binance.com";

const PAIRS = {
  "ewy-koru": { base: "EWYUSDT", leveraged: "KORUUSDT", factor: 3 },
  "sndk-snxx": { base: "SNDKUSDT", leveraged: "SNXXUSDT", factor: 2 },
  "mrvl-mvll": { base: "MRVLUSDT", leveraged: "MVLLUSDT", factor: 2 },
  "qqq-tqqq": { base: "QQQUSDT", leveraged: "TQQQUSDT", factor: 3 },
  "tencent-hk0700": { base: "TENCENTUSDT", leveraged: "HK0700USDT", factor: 1, priceRatio: 7.84 },
} as const;

type DepthBook = {
  E?: number;
  T?: number;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
};

async function getBook(symbol: string) {
  const response = await fetch(
    `${BINANCE_FUTURES_API}/fapi/v1/depth?symbol=${symbol}&limit=5`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`${symbol} quote request failed (${response.status})`);
  return (await response.json()) as DepthBook;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pairId = url.searchParams.get("pair") || "ewy-koru";
  const pair = PAIRS[pairId as keyof typeof PAIRS];
  if (!pair) {
    return Response.json({ error: "Unsupported monitoring pair." }, { status: 400 });
  }

  try {
    const [ewy, koru] = await Promise.all([getBook(pair.base), getBook(pair.leveraged)]);
    const normalize = (book: DepthBook) => {
      const bids = book.bids.slice(0, 5).map(([levelPrice, size]) => ({ price: Number(levelPrice), size: Number(size) }));
      const asks = book.asks.slice(0, 5).map(([levelPrice, size]) => ({ price: Number(levelPrice), size: Number(size) }));
      const bid = bids[0]?.price;
      const ask = asks[0]?.price;
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) throw new Error("Incomplete depth response.");
      return { bid, ask, mid: (bid + ask) / 2, bids, asks, ts: book.T || book.E || Date.now() };
    };
    const normalizedEwy = normalize(ewy);
    const normalizedKoru = normalize(koru);
    return Response.json(
      {
        pairId,
        ...pair,
        t: Math.max(normalizedEwy.ts, normalizedKoru.ts),
        ewy: normalizedEwy,
        koru: normalizedKoru,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to load live quotes." },
      { status: 502 },
    );
  }
}

