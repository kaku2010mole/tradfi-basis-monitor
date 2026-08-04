const BINANCE_API = "https://fapi.binance.com";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

const BINANCE_SYMBOLS = ["HK1810USDT", "HK0700USDT", "TENCENTUSDT"] as const;
const PARA_SYMBOLS = [
  { api: "para:OTHERS", display: "para:OTHERS" },
  { api: "para:TOTAL2", display: "para:TOTAL2" },
  { api: "para:BTCD", display: "para:BTC.D" },
] as const;

type BinanceBook = { symbol: string; bidPrice: string; askPrice: string; time?: number };
type BinancePremium = {
  symbol: string;
  indexPrice: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime?: number;
  time?: number;
};

type HyperMeta = { universe: Array<{ name: string }> };
type HyperContext = {
  oraclePx?: string;
  markPx?: string;
  midPx?: string;
  funding?: string;
};

const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

async function getBinanceQuotes() {
  const [bookResponse, premiumResponse] = await Promise.all([
    fetch(`${BINANCE_API}/fapi/v1/ticker/bookTicker`, { cache: "no-store" }),
    fetch(`${BINANCE_API}/fapi/v1/premiumIndex`, { cache: "no-store" }),
  ]);
  if (!bookResponse.ok || !premiumResponse.ok) throw new Error("Binance oracle feed unavailable.");
  const books = new Map(((await bookResponse.json()) as BinanceBook[]).map((item) => [item.symbol, item]));
  const premiums = new Map(((await premiumResponse.json()) as BinancePremium[]).map((item) => [item.symbol, item]));

  return BINANCE_SYMBOLS.flatMap((symbol) => {
    const book = books.get(symbol);
    const premium = premiums.get(symbol);
    const bid = finite(book?.bidPrice);
    const ask = finite(book?.askPrice);
    const oracle = finite(premium?.indexPrice);
    const mark = finite(premium?.markPrice);
    if (bid === null || ask === null || oracle === null || mark === null) return [];
    const live = (bid + ask) / 2;
    return [{
      id: `binance:${symbol}`,
      venue: "Binance" as const,
      symbol,
      apiSymbol: symbol,
      bid,
      ask,
      live,
      oracle,
      mark,
      deviation: (live / oracle - 1) * 100,
      funding: Number.isFinite(Number(premium?.lastFundingRate)) ? Number(premium?.lastFundingRate) : null,
      fundingHours: 8,
      nextFundingTime: premium?.nextFundingTime ?? null,
      updatedAt: Math.max(book?.time ?? 0, premium?.time ?? 0, Date.now()),
    }];
  });
}

async function getParaQuotes() {
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "para" }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Hyperliquid para feed unavailable.");
  const [meta, contexts] = (await response.json()) as [HyperMeta, HyperContext[]];
  const byName = new Map(meta.universe.map((asset, index) => [asset.name, contexts[index]]));

  return PARA_SYMBOLS.flatMap(({ api, display }) => {
    const context = byName.get(api);
    const live = finite(context?.midPx) ?? finite(context?.markPx);
    const oracle = finite(context?.oraclePx);
    const mark = finite(context?.markPx);
    if (live === null || oracle === null || mark === null) return [];
    return [{
      id: `hyperliquid:${api}`,
      venue: "Hyperliquid" as const,
      symbol: display,
      apiSymbol: api,
      bid: null,
      ask: null,
      live,
      oracle,
      mark,
      deviation: (live / oracle - 1) * 100,
      funding: Number.isFinite(Number(context?.funding)) ? Number(context?.funding) : null,
      fundingHours: 1,
      nextFundingTime: null,
      updatedAt: Date.now(),
    }];
  });
}

export async function GET() {
  const [binance, hyperliquid] = await Promise.allSettled([getBinanceQuotes(), getParaQuotes()]);
  const quotes = [
    ...(binance.status === "fulfilled" ? binance.value : []),
    ...(hyperliquid.status === "fulfilled" ? hyperliquid.value : []),
  ];
  if (!quotes.length) {
    return Response.json({ error: "Oracle feeds are temporarily unavailable." }, { status: 502 });
  }
  return Response.json(
    {
      quotes,
      timestamp: Math.max(...quotes.map((quote) => quote.updatedAt)),
      sources: {
        binance: binance.status === "fulfilled",
        hyperliquid: hyperliquid.status === "fulfilled",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
