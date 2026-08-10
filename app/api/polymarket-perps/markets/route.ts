const POLYMARKET_API = "https://api.perpetuals.polymarket.com";
const BINANCE_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"];

type Instrument = {
  instrument_id: number;
  category: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  funding_interval: string;
  max_leverage: number;
};

type Ticker = {
  instrument_id: number;
  symbol: string;
  index_price: string;
  mark_price: string;
  last_price: string;
  mid_price: string;
  open_interest: string;
  funding_rate: string;
  next_funding: number;
  timestamp?: number;
};

type BinanceExchangeInfo = { symbols?: Array<{ symbol?: string; status?: string }> };
type BinanceBook = { symbol?: string; bidPrice?: string; askPrice?: string; time?: number };

const EXPLICIT_BINANCE_MAP: Record<string, { symbol: string; kind: "direct" | "reference" } | null> = {
  SP500: null,
  NAS100: null,
  GOLD: { symbol: "XAUUSDT", kind: "reference" },
  SILVER: { symbol: "XAGUSDT", kind: "reference" },
  WTIOIL: { symbol: "CLUSDT", kind: "reference" },
  GOOGL: { symbol: "GOOGLUSDT", kind: "direct" },
  KPEPE: { symbol: "1000PEPEUSDT", kind: "direct" },
};

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

async function fetchJson<T>(url: string, timeout = 10_000) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchBinance<T>(path: string) {
  let lastError: unknown;
  for (const host of BINANCE_HOSTS) {
    try { return await fetchJson<T>(`${host}${path}`, 8_000); }
    catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("Binance unavailable.");
}

export async function GET() {
  try {
    const [instruments, tickers] = await Promise.all([
      fetchJson<Instrument[]>(`${POLYMARKET_API}/v1/info/instruments`),
      fetchJson<Ticker[]>(`${POLYMARKET_API}/v1/info/tickers`),
    ]);
    const tickerById = new Map(tickers.map((ticker) => [ticker.instrument_id, ticker]));
    let activeBinance = new Set<string>();
    let bookBySymbol = new Map<string, BinanceBook>();
    let binanceOnline = false;
    try {
      const [exchange, books] = await Promise.all([
        fetchBinance<BinanceExchangeInfo>("/fapi/v1/exchangeInfo"),
        fetchBinance<BinanceBook[]>("/fapi/v1/ticker/bookTicker"),
      ]);
      activeBinance = new Set((exchange.symbols ?? []).flatMap((item) => item.status === "TRADING" && item.symbol ? [item.symbol] : []));
      bookBySymbol = new Map(books.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
      binanceOnline = activeBinance.size > 0;
    } catch { /* Polymarket remains usable when Binance is regionally unavailable. */ }

    const markets = instruments.flatMap((instrument) => {
      const ticker = tickerById.get(instrument.instrument_id);
      if (!ticker) return [];
      const explicit = Object.prototype.hasOwnProperty.call(EXPLICIT_BINANCE_MAP, instrument.base_asset) ? EXPLICIT_BINANCE_MAP[instrument.base_asset] : undefined;
      const candidate = explicit === null ? null : explicit ?? { symbol: `${instrument.base_asset}USDT`, kind: "direct" as const };
      const mapping = candidate && (!binanceOnline || activeBinance.has(candidate.symbol)) ? candidate : null;
      const book = mapping ? bookBySymbol.get(mapping.symbol) : undefined;
      const binanceBid = positive(book?.bidPrice);
      const binanceAsk = positive(book?.askPrice);
      const binanceMid = binanceBid !== null && binanceAsk !== null ? (binanceBid + binanceAsk) / 2 : null;
      const midPrice = positive(ticker.mid_price);
      return [{
        instrumentId: instrument.instrument_id,
        category: instrument.category,
        symbol: instrument.symbol,
        baseAsset: instrument.base_asset,
        quoteAsset: instrument.quote_asset,
        fundingInterval: instrument.funding_interval,
        maxLeverage: instrument.max_leverage,
        indexPrice: positive(ticker.index_price),
        markPrice: positive(ticker.mark_price),
        lastPrice: positive(ticker.last_price),
        midPrice,
        openInterest: positive(ticker.open_interest),
        fundingRate: finite(ticker.funding_rate),
        nextFunding: finite(ticker.next_funding),
        timestamp: finite(ticker.timestamp) ?? Date.now(),
        binanceSymbol: mapping?.symbol ?? null,
        mappingKind: mapping?.kind ?? null,
        mappingVerified: Boolean(mapping && binanceOnline && activeBinance.has(mapping.symbol)),
        binanceBid,
        binanceAsk,
        binanceMid,
        binanceUpdatedAt: finite(book?.time),
        spreadPct: midPrice !== null && binanceMid !== null ? (midPrice / binanceMid - 1) * 100 : null,
      }];
    });
    return Response.json({ markets, timestamp: Date.now(), sources: { polymarket: true, binance: binanceOnline } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Polymarket Perps market data unavailable." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
