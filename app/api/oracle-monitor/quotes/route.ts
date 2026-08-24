const BINANCE_API = "https://fapi.binance.com";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

const DEFAULT_BINANCE_SYMBOLS = [
  "HK1810USDT",
  "HK0700USDT",
  "TENCENTUSDT",
  "POPMARTUSDT",
  "KUAISHOUUSDT",
  "MEITUANUSDT",
  "CSOPSKHYNIX2LUSDT",
  "LGELECTRONICSUSDT",
  "KODEX200USDT",
  "ZHONGJIUSDT",
];
const DEFAULT_PARA_SYMBOLS = ["para:OTHERS", "para:TOTAL2", "para:BTCD", "para:CIEN", "para:VST", "para:NET"];
const MAX_SYMBOLS_PER_VENUE = 24;
const FETCH_TIMEOUT_MS = 6_000;
const RETRY_DELAYS_MS = [0, 180, 520];

type BinanceBook = {
  symbol: string;
  bidPrice: string;
  bidQty?: string;
  askPrice: string;
  askQty?: string;
  time?: number;
};
type BinancePremium = {
  symbol: string;
  indexPrice: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime?: number;
  time?: number;
};
type HyperMeta = { universe: Array<{ name: string }> };
type HyperContext = { oraclePx?: string; markPx?: string; midPx?: string; funding?: string };
type HyperLevel = { px?: string; sz?: string };
type HyperBook = { time?: number; levels?: [HyperLevel[], HyperLevel[]] };

const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseSymbols = (value: string | null, venue: "binance" | "para") => {
  if (!value) return venue === "binance" ? DEFAULT_BINANCE_SYMBOLS : DEFAULT_PARA_SYMBOLS;
  const pattern = venue === "binance" ? /^[A-Z0-9_]{2,32}$/ : /^para:[A-Z0-9._-]{1,28}$/i;
  return Array.from(new Set(value.split(",")
    .map((symbol) => symbol.trim())
    .filter((symbol) => pattern.test(symbol))
    .map((symbol) => venue === "binance" ? symbol.toUpperCase() : symbol.replace(/^para:/i, "para:").replace(/BTC\.D$/i, "BTCD"))))
    .slice(0, MAX_SYMBOLS_PER_VENUE);
};

const executableQuote = (oracle: number, bid: number | null, bidQty: number | null, ask: number | null, askQty: number | null) => {
  if (bid === null || ask === null) return null;
  const sellDeviation = (bid / oracle - 1) * 100;
  const buyDeviation = (ask / oracle - 1) * 100;
  const sellable = sellDeviation > 0 && (buyDeviation >= 0 || sellDeviation >= Math.abs(buyDeviation));
  const buyable = buyDeviation < 0;
  const price = sellable ? bid : buyable ? ask : null;
  const quantity = sellable ? bidQty : buyable ? askQty : null;
  return {
    live: price ?? oracle,
    deviation: sellable ? sellDeviation : buyable ? buyDeviation : 0,
    executableSide: sellable ? "SELL" as const : buyable ? "BUY" as const : "NONE" as const,
    executablePrice: price,
    executableQty: quantity,
    executableUsd: price !== null && quantity !== null ? price * quantity : null,
  };
};

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const withDeadline = <T,>(promise: Promise<T>, milliseconds: number, label: string) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
  promise.then((value) => {
    clearTimeout(timer);
    resolve(value);
  }, (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

async function fetchJson<T>(url: string, init?: RequestInit) {
  let lastError: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await wait(delay);
    try {
      const response = await fetch(url, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Market request failed.");
}

const buildBinanceQuote = (symbol: string, book?: BinanceBook, premium?: BinancePremium) => {
  const bid = finite(book?.bidPrice);
  const bidQty = finite(book?.bidQty);
  const ask = finite(book?.askPrice);
  const askQty = finite(book?.askQty);
  const oracle = finite(premium?.indexPrice);
  const mark = finite(premium?.markPrice);
  if (bid === null || ask === null || oracle === null || mark === null) return null;
  const executable = executableQuote(oracle, bid, bidQty, ask, askQty);
  if (!executable) return null;
  return {
    id: `binance:${symbol}`,
    venue: "Binance" as const,
    symbol,
    apiSymbol: symbol,
    bid,
    bidQty,
    ask,
    askQty,
    oracle,
    mark,
    funding: Number.isFinite(Number(premium?.lastFundingRate)) ? Number(premium?.lastFundingRate) : null,
    fundingHours: 8,
    nextFundingTime: premium?.nextFundingTime ?? null,
    updatedAt: Math.max(book?.time ?? 0, premium?.time ?? 0, Date.now()),
    ...executable,
  };
};

async function getBinanceSymbolQuote(symbol: string) {
  const [book, premium] = await Promise.all([
    fetchJson<BinanceBook>(`${BINANCE_API}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`),
    fetchJson<BinancePremium>(`${BINANCE_API}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`),
  ]);
  return buildBinanceQuote(symbol, book, premium);
}

async function getBinanceQuotes(symbols: string[]) {
  if (!symbols.length) return [];
  try {
    const [bookItems, premiumItems] = await Promise.all([
      fetchJson<BinanceBook[]>(`${BINANCE_API}/fapi/v1/ticker/bookTicker`),
      fetchJson<BinancePremium[]>(`${BINANCE_API}/fapi/v1/premiumIndex`),
    ]);
    const books = new Map(bookItems.map((item) => [item.symbol, item]));
    const premiums = new Map(premiumItems.map((item) => [item.symbol, item]));
    return symbols.flatMap((symbol) => {
      const quote = buildBinanceQuote(symbol, books.get(symbol), premiums.get(symbol));
      return quote ? [quote] : [];
    });
  } catch {
    const fallback = await Promise.allSettled(symbols.map(getBinanceSymbolQuote));
    const quotes = fallback.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
    if (!quotes.length) throw new Error("Binance oracle feed unavailable.");
    return quotes;
  }
}

async function getParaBook(symbol: string) {
  return fetchJson<HyperBook>(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin: symbol }),
  });
}

async function getParaQuotes(symbols: string[]) {
  if (!symbols.length) return [];
  const [contextPayload, bookResults] = await Promise.all([
    fetchJson<[HyperMeta, HyperContext[]]>(HYPERLIQUID_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "para" }),
    }),
    Promise.allSettled(symbols.map((symbol) => getParaBook(symbol))),
  ]);
  const [meta, contexts] = contextPayload;
  const byName = new Map(meta.universe.map((asset, index) => [asset.name, contexts[index]]));
  const books = new Map(symbols.flatMap((symbol, index) => bookResults[index]?.status === "fulfilled" ? [[symbol, bookResults[index].value] as const] : []));

  return symbols.flatMap((apiSymbol) => {
    const context = byName.get(apiSymbol);
    const book = books.get(apiSymbol);
    const bid = finite(book?.levels?.[0]?.[0]?.px);
    const bidQty = finite(book?.levels?.[0]?.[0]?.sz);
    const ask = finite(book?.levels?.[1]?.[0]?.px);
    const askQty = finite(book?.levels?.[1]?.[0]?.sz);
    const oracle = finite(context?.oraclePx);
    const mark = finite(context?.markPx);
    if (bid === null || ask === null || oracle === null || mark === null) return [];
    const executable = executableQuote(oracle, bid, bidQty, ask, askQty);
    if (!executable) return [];
    const display = apiSymbol === "para:BTCD" ? "para:BTC.D" : apiSymbol;
    return [{
      id: `hyperliquid:${apiSymbol}`,
      venue: "Hyperliquid" as const,
      symbol: display,
      apiSymbol,
      bid,
      bidQty,
      ask,
      askQty,
      oracle,
      mark,
      funding: Number.isFinite(Number(context?.funding)) ? Number(context?.funding) : null,
      fundingHours: 1,
      nextFundingTime: null,
      updatedAt: book?.time ?? Date.now(),
      ...executable,
    }];
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const binanceSymbols = parseSymbols(url.searchParams.get("binance"), "binance");
  const paraSymbols = parseSymbols(url.searchParams.get("para"), "para");
  const [binance, hyperliquid] = await Promise.allSettled([
    withDeadline(getBinanceQuotes(binanceSymbols), 4_500, "Binance server snapshot"),
    withDeadline(getParaQuotes(paraSymbols), 7_500, "Hyperliquid snapshot"),
  ]);
  const quotes = [
    ...(binance.status === "fulfilled" ? binance.value : []),
    ...(hyperliquid.status === "fulfilled" ? hyperliquid.value : []),
  ];
  if (!quotes.length) return Response.json({ error: "Oracle feeds are temporarily unavailable." }, { status: 502 });
  return Response.json({
    quotes,
    requested: { binance: binanceSymbols.length, hyperliquid: paraSymbols.length },
    timestamp: Math.max(...quotes.map((quote) => quote.updatedAt)),
    sources: {
      binance: binance.status === "fulfilled",
      hyperliquid: hyperliquid.status === "fulfilled",
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
