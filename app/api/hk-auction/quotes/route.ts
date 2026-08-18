const BINANCE_FUTURES_APIS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];
const DEFAULT_USD_HKD = 7.83;
const MAX_PAIRS = 24;
const FETCH_TIMEOUT_MS = 5_000;
const FUTU_STALE_MS = 20_000;

type FutuPushStore = typeof globalThis & {
  __FUTU_PUSH_SNAPSHOT__?: { payload: unknown; receivedAt: number };
};

type PairConfig = {
  stockSymbol: string;
  perpSymbol: string;
  sharesPerContract: number;
};

type Level = { price: number; size: number };

type FutuQuote = {
  symbol: string;
  name: string | null;
  marketState: string | null;
  auctionPrice: number | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  bids: Level[];
  asks: Level[];
  marketTimestamp: number | null;
  receivedAt: number;
  stale: boolean | null;
};

type BinanceBookTicker = {
  symbol?: string;
  bidPrice?: string;
  bidQty?: string;
  askPrice?: string;
  askQty?: string;
  time?: number;
};

const DEFAULT_PAIRS: PairConfig[] = [
  { stockSymbol: "HK.00700", perpSymbol: "HK0700USDT", sharesPerContract: 7.83 },
  { stockSymbol: "HK.01810", perpSymbol: "HK1810USDT", sharesPerContract: 7.83 },
];

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const timestamp = (value: unknown) => {
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      const trimmed = value.trim();
      // Futu's svr_recv_time fields are Hong Kong wall-clock strings without a
      // zone. Parse them as UTC+08 instead of the Worker's host timezone.
      const zoned = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
        ? `${trimmed.replace(" ", "T")}+08:00`
        : trimmed;
      const parsed = Date.parse(zoned);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric < 10_000_000_000) return numeric * 1_000;
  return numeric;
};

const stale = (marketTimestamp: number | null, now: number, limit: number) =>
  marketTimestamp === null ? null : now - marketTimestamp > limit;

const parseUsdHkd = (raw: string | null) => {
  if (raw === null || raw.trim() === "") return DEFAULT_USD_HKD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 20) {
    throw new Error("usdhkd must be a number between 1 and 20.");
  }
  return value;
};

const normalizeStockSymbol = (value: string) => {
  const symbol = value.trim().toUpperCase();
  if (!/^HK\.\d{5}$/.test(symbol)) throw new Error(`Invalid Futu stock symbol: ${value}`);
  return symbol;
};

const normalizePerpSymbol = (value: string) => {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]{3,32}USDT$/.test(symbol)) throw new Error(`Invalid Binance perp symbol: ${value}`);
  return symbol;
};

const defaultShares = (perpSymbol: string) =>
  perpSymbol === "HK0700USDT" || perpSymbol === "HK1810USDT"
    ? 7.83
    : 1;

const parsePair = (raw: string): PairConfig => {
  const parts = raw.split("|").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) {
    throw new Error("Each pair must use STOCK|PERP or STOCK|PERP|SHARES format.");
  }
  const stockSymbol = normalizeStockSymbol(parts[0]);
  const perpSymbol = normalizePerpSymbol(parts[1]);
  const sharesPerContract = parts[2] === undefined || parts[2] === ""
    ? defaultShares(perpSymbol)
    : Number(parts[2]);
  if (!Number.isFinite(sharesPerContract) || sharesPerContract <= 0 || sharesPerContract > 100_000) {
    throw new Error(`Invalid sharesPerContract for ${stockSymbol}.`);
  }
  return { stockSymbol, perpSymbol, sharesPerContract };
};

const parsePairs = (params: URLSearchParams) => {
  const repeated = params.getAll("pair");
  const compact = params.get("pairs");
  const raw = repeated.length ? repeated : compact?.split(",").filter(Boolean) ?? [];
  if (!raw.length) return DEFAULT_PAIRS;
  if (raw.length > MAX_PAIRS) throw new Error(`At most ${MAX_PAIRS} pairs may be requested.`);
  const unique = new Map<string, PairConfig>();
  raw.map(parsePair).forEach((pair) => unique.set(`${pair.stockSymbol}:${pair.perpSymbol}`, pair));
  return [...unique.values()];
};

const normalizeLevels = (value: unknown): Level[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((raw) => {
    const record = Array.isArray(raw)
      ? { price: raw[0], size: raw[1] }
      : raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const price = positive(record.price ?? record[0]);
    const size = positive(record.size ?? record.volume ?? record.qty ?? record[1]);
    return price !== null && size !== null ? [{ price, size }] : [];
  });
};

const relayCollections = (payload: unknown) => {
  if (Array.isArray(payload)) return { quotes: payload, orderbooks: [] as unknown[] };
  if (!payload || typeof payload !== "object") return { quotes: [] as unknown[], orderbooks: [] as unknown[] };
  const root = payload as Record<string, unknown>;
  const body = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : root;
  return {
    quotes: Array.isArray(body.quotes) ? body.quotes : [],
    orderbooks: Array.isArray(body.orderbooks) ? body.orderbooks : [],
  };
};

const mergeRelayRecords = (payload: unknown) => {
  const { quotes, orderbooks } = relayCollections(payload);
  const booksBySymbol = new Map<string, Record<string, unknown>>();
  orderbooks.forEach((raw) => {
    if (!raw || typeof raw !== "object") return;
    const book = raw as Record<string, unknown>;
    const symbol = book.symbol ?? book.code;
    if (typeof symbol === "string") booksBySymbol.set(symbol.toUpperCase(), book);
  });
  const records = quotes.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const quote = raw as Record<string, unknown>;
    const symbol = quote.symbol ?? quote.code;
    const orderbook = typeof symbol === "string" ? booksBySymbol.get(symbol.toUpperCase()) : undefined;
    return [{ ...quote, orderbook: orderbook ?? quote.orderbook }];
  });
  // A relay may provide only order books. Keep those real quotes usable without
  // inventing snapshot fields such as last or auction price.
  const quotedSymbols = new Set(records.flatMap((record) => {
    const symbol = record.symbol ?? record.code;
    return typeof symbol === "string" ? [symbol.toUpperCase()] : [];
  }));
  orderbooks.forEach((raw) => {
    if (!raw || typeof raw !== "object") return;
    const book = raw as Record<string, unknown>;
    const symbol = book.symbol ?? book.code;
    if (typeof symbol === "string" && !quotedSymbols.has(symbol.toUpperCase())) {
      records.push({ symbol, orderbook: book });
    }
  });
  return records;
};

const normalizeFutuQuote = (raw: unknown, receivedAt: number): FutuQuote | null => {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const symbolRaw = item.symbol ?? item.code;
  if (typeof symbolRaw !== "string") return null;
  let symbol: string;
  try {
    symbol = normalizeStockSymbol(symbolRaw);
  } catch {
    return null;
  }
  const nestedBook = item.orderbook && typeof item.orderbook === "object"
    ? item.orderbook as Record<string, unknown>
    : {};
  const bids = normalizeLevels(item.bids ?? nestedBook.bids ?? nestedBook.Bid);
  const asks = normalizeLevels(item.asks ?? nestedBook.asks ?? nestedBook.Ask);
  const bid = positive(item.bid ?? item.bidPrice ?? item.bid_price) ?? bids[0]?.price ?? null;
  const ask = positive(item.ask ?? item.askPrice ?? item.ask_price) ?? asks[0]?.price ?? null;
  const bidSize = positive(item.bidSize ?? item.bidVol ?? item.bid_volume) ?? bids[0]?.size ?? null;
  const askSize = positive(item.askSize ?? item.askVol ?? item.ask_volume) ?? asks[0]?.size ?? null;
  const marketTimestamp = timestamp(
    item.marketTimestamp ?? item.timestamp ?? item.updateTime ?? item.update_time ??
    nestedBook.marketTimestamp ?? nestedBook.timestamp,
  );
  return {
    symbol,
    name: typeof item.name === "string" ? item.name : null,
    marketState: typeof (item.marketState ?? item.market_state) === "string"
      ? String(item.marketState ?? item.market_state)
      : null,
    auctionPrice: positive(item.auctionPrice ?? item.indicativePrice ?? item.iep),
    last: positive(item.last ?? item.lastPrice ?? item.last_price ?? item.curPrice),
    bid,
    ask,
    bidSize,
    askSize,
    bids,
    asks,
    marketTimestamp,
    receivedAt,
    stale: stale(marketTimestamp, receivedAt, FUTU_STALE_MS),
  };
};

const futuRelayUrl = () => {
  const raw = process.env.FUTU_RELAY_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("FUTU_RELAY_URL must use HTTPS (HTTP is allowed only for localhost).");
  }
  return url.toString();
};

async function getFutuQuotes(symbols: string[]) {
  const url = futuRelayUrl();
  if (!url) {
    const pushed = (globalThis as FutuPushStore).__FUTU_PUSH_SNAPSHOT__;
    if (!pushed || Date.now() - pushed.receivedAt > FUTU_STALE_MS) {
      throw new Error("Waiting for a fresh Futu OpenD push.");
    }
    const receivedAt = pushed.receivedAt;
    const requested = new Set(symbols);
    const quotes = mergeRelayRecords(pushed.payload).flatMap((item) => {
      const quote = normalizeFutuQuote(item, receivedAt);
      return quote && requested.has(quote.symbol) ? [quote] : [];
    });
    if (!quotes.length) throw new Error("Futu push has no requested symbols.");
    return quotes;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  const relayToken = process.env.FUTU_RELAY_TOKEN?.trim();
  if (relayToken) headers.Authorization = `Bearer ${relayToken}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ symbols, depth: 10 }),
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Futu relay HTTP ${response.status}.`);
  const payload = await response.json() as unknown;
  const receivedAt = Date.now();
  const quotes = mergeRelayRecords(payload).flatMap((item) => {
    const quote = normalizeFutuQuote(item, receivedAt);
    return quote ? [quote] : [];
  });
  if (!quotes.length) throw new Error("Futu relay returned no valid real-time quotes.");
  return quotes;
}

async function getBinanceQuote(symbol: string) {
  const path = `/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`;
  let book: BinanceBookTicker | null = null;
  let lastError = `${symbol}: Binance unavailable.`;
  for (const host of BINANCE_FUTURES_APIS) {
    try {
      const response = await fetch(`${host}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      book = await response.json() as BinanceBookTicker;
      break;
    } catch (error) {
      lastError = `${symbol}: ${errorMessage(error)}`;
    }
  }
  if (!book) throw new Error(lastError);
  const bid = positive(book.bidPrice);
  const ask = positive(book.askPrice);
  if (bid === null || ask === null) throw new Error(`${symbol}: incomplete Binance book ticker.`);
  const receivedAt = Date.now();
  return {
    symbol,
    bid,
    ask,
    mid: (bid + ask) / 2,
    bidSize: positive(book.bidQty),
    askSize: positive(book.askQty),
    // A successful REST bookTicker response is a current BBO snapshot even if
    // its exchange event time is old because neither side has changed.
    marketTimestamp: receivedAt,
    receivedAt,
    stale: false,
  };
}

const midpoint = (bid: number | null, ask: number | null) =>
  bid !== null && ask !== null ? (bid + ask) / 2 : null;

const basis = (perpPrice: number | null, stockPriceHkd: number | null, shares: number, usdHkd: number) => {
  if (perpPrice === null || stockPriceHkd === null) return null;
  const fair = stockPriceHkd * shares / usdHkd;
  return fair > 0 ? (perpPrice / fair - 1) * 100 : null;
};

const capacity = (
  perpPrice: number | null,
  perpQuantity: number | null,
  stockQuantity: number | null,
  sharesPerContract: number,
) => {
  if (perpPrice === null || perpQuantity === null || stockQuantity === null) {
    return { capacityContracts: null, capacityUsdt: null };
  }
  const stockContracts = stockQuantity / sharesPerContract;
  const capacityContracts = Math.min(perpQuantity, stockContracts);
  return {
    capacityContracts,
    capacityUsdt: capacityContracts === null ? null : capacityContracts * perpPrice,
  };
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unknown market-data error.";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  let pairConfigs: PairConfig[];
  let usdHkd: number;
  try {
    pairConfigs = parsePairs(requestUrl.searchParams);
    usdHkd = parseUsdHkd(requestUrl.searchParams.get("usdhkd"));
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 400 });
  }

  const [futuResult, ...binanceResults] = await Promise.allSettled([
    getFutuQuotes(pairConfigs.map((pair) => pair.stockSymbol)),
    ...pairConfigs.map((pair) => getBinanceQuote(pair.perpSymbol)),
  ]);
  const futuBySymbol = new Map(
    futuResult.status === "fulfilled" ? futuResult.value.map((quote) => [quote.symbol, quote] as const) : [],
  );
  const errors: string[] = [];
  if (futuResult.status === "rejected") errors.push(errorMessage(futuResult.reason));

  const now = Date.now();
  const quotes = pairConfigs.map((pair, index) => {
    const futu = futuBySymbol.get(pair.stockSymbol) ?? null;
    const binanceResult = binanceResults[index];
    const binance = binanceResult?.status === "fulfilled" ? binanceResult.value : null;
    if (binanceResult?.status === "rejected") errors.push(errorMessage(binanceResult.reason));

    // A missing exchange timestamp is not proof of freshness. Keep the raw
    // record for link diagnostics, but exclude it from every trading metric.
    const activeFutu = futu?.stale === false ? futu : null;
    const activeBinance = binance?.stale === false ? binance : null;

    // During the HK auction, an explicit IEP is preferred. If the relay has no IEP,
    // the visible Futu best-bid/ask midpoint is used. A previous close is never substituted.
    const stockReferenceHkd = activeFutu?.auctionPrice ?? (activeFutu ? midpoint(activeFutu.bid, activeFutu.ask) : null);
    const stockReferenceSource = activeFutu?.auctionPrice !== null && activeFutu?.auctionPrice !== undefined
      ? "auction-price"
      : stockReferenceHkd !== null ? "book-mid" : null;
    const fairUsdt = stockReferenceHkd === null
      ? null
      : stockReferenceHkd * pair.sharesPerContract / usdHkd;
    const binanceMid = activeBinance?.mid ?? null;
    const midBasisPct = fairUsdt !== null && binanceMid !== null
      ? (binanceMid / fairUsdt - 1) * 100
      : null;
    const sellCapacity = capacity(
      activeBinance?.bid ?? null,
      activeBinance?.bidSize ?? null,
      activeFutu?.askSize ?? null,
      pair.sharesPerContract,
    );
    const buyCapacity = capacity(
      activeBinance?.ask ?? null,
      activeBinance?.askSize ?? null,
      activeFutu?.bidSize ?? null,
      pair.sharesPerContract,
    );

    return {
      id: `${pair.stockSymbol}:${pair.perpSymbol}`,
      ...pair,
      usdHkd,
      futu,
      binance,
      metrics: {
        stockReferenceHkd,
        stockReferenceSource,
        fairUsdt,
        binanceMid,
        midBasisPct,
        depthUsdt: {
          stockBid: activeFutu?.bid !== null && activeFutu?.bid !== undefined && activeFutu.bidSize !== null
            ? activeFutu.bid * activeFutu.bidSize / usdHkd : null,
          stockAsk: activeFutu?.ask !== null && activeFutu?.ask !== undefined && activeFutu.askSize !== null
            ? activeFutu.ask * activeFutu.askSize / usdHkd : null,
          binanceBid: activeBinance?.bid !== undefined && activeBinance.bidSize !== null
            ? activeBinance.bid * activeBinance.bidSize : null,
          binanceAsk: activeBinance?.ask !== undefined && activeBinance.askSize !== null
            ? activeBinance.ask * activeBinance.askSize : null,
        },
        sellPerpBuyStock: {
          basisPct: basis(activeBinance?.bid ?? null, activeFutu?.ask ?? null, pair.sharesPerContract, usdHkd),
          ...sellCapacity,
        },
        buyPerpSellStock: {
          basisPct: basis(activeBinance?.ask ?? null, activeFutu?.bid ?? null, pair.sharesPerContract, usdHkd),
          ...buyCapacity,
        },
      },
      status: !futu || !binance
        ? "partial"
        : !activeFutu || !activeBinance ? "stale" : "live",
    };
  });

  return Response.json({
    quotes,
    usdHkd,
    timestamp: now,
    sources: {
      futu: futuResult.status === "fulfilled",
      binance: binanceResults.some((result) => result.status === "fulfilled"),
    },
    errors: [...new Set(errors)],
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
