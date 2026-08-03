import { resolvePair } from "../pairs";

const BINANCE_FUTURES_API = "https://fapi.binance.com";

type DepthBook = {
  E?: number;
  T?: number;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
};

type PremiumIndex = {
  indexPrice: string;
  markPrice: string;
  time?: number;
};

async function getBook(symbol: string) {
  const response = await fetch(
    `${BINANCE_FUTURES_API}/fapi/v1/depth?symbol=${symbol}&limit=5`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`${symbol} quote request failed (${response.status})`);
  return (await response.json()) as DepthBook;
}

async function getOracle(symbol: string) {
  const response = await fetch(`${BINANCE_FUTURES_API}/fapi/v1/premiumIndex?symbol=${symbol}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${symbol} oracle request failed (${response.status})`);
  return (await response.json()) as PremiumIndex;
}

const normalizeBook = (book: DepthBook) => {
  const bids = book.bids.slice(0, 5).map(([levelPrice, size]) => ({ price: Number(levelPrice), size: Number(size) }));
  const asks = book.asks.slice(0, 5).map(([levelPrice, size]) => ({ price: Number(levelPrice), size: Number(size) }));
  const bid = bids[0]?.price;
  const ask = asks[0]?.price;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) throw new Error("Incomplete depth response.");
  return { bid, ask, mid: (bid + ask) / 2, bids, asks, ts: book.T || book.E || Date.now() };
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pair = resolvePair(url);
  if (!pair) {
    return Response.json({ error: "Unsupported monitoring pair." }, { status: 400 });
  }

  try {
    if (pair.mode === "oracle") {
      const [book, oracle] = await Promise.all([getBook(pair.base), getOracle(pair.base)]);
      const live = normalizeBook(book);
      const indexPrice = Number(oracle.indexPrice);
      const markPrice = Number(oracle.markPrice);
      if (!Number.isFinite(indexPrice) || !Number.isFinite(markPrice)) throw new Error("Incomplete oracle response.");
      const oracleTs = oracle.time || Date.now();
      return Response.json(
        {
          pairId: pair.id,
          ...pair,
          t: Math.max(live.ts, oracleTs),
          ewy: { bid: indexPrice, ask: indexPrice, mid: indexPrice, bids: [], asks: [], ts: oracleTs },
          koru: live,
          mark: markPrice,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const [ewy, koru] = await Promise.all([getBook(pair.base), getBook(pair.leveraged)]);
    const normalizedEwy = normalizeBook(ewy);
    const normalizedKoru = normalizeBook(koru);
    return Response.json(
      {
        pairId: pair.id,
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
