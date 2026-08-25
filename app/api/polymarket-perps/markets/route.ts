const POLYMARKET_API = "https://api.perpetuals.polymarket.com";
const BINANCE_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"];
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

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
type BinancePremium = { symbol?: string; lastFundingRate?: string; nextFundingTime?: number; time?: number };
type BinanceFundingInfo = { symbol?: string; fundingIntervalHours?: number };
type HyperMetaAndContexts = [
  { universe?: Array<{ name?: string; isDelisted?: boolean }> },
  Array<{ midPx?: string; funding?: string }>,
];

const EXPLICIT_BINANCE_MAP: Record<string, { symbol: string; kind: "direct" | "reference" } | null> = {
  SP500: null,
  NAS100: null,
  GOLD: { symbol: "XAUUSDT", kind: "reference" },
  SILVER: { symbol: "XAGUSDT", kind: "reference" },
  WTIOIL: { symbol: "CLUSDT", kind: "reference" },
  GOOGL: { symbol: "GOOGLUSDT", kind: "direct" },
  KPEPE: { symbol: "1000PEPEUSDT", kind: "direct" },
};

const EXPLICIT_HYPER_MAP: Record<string, { symbol: string; dex: string; kind: "direct" | "reference" }> = {
  NAS100: { symbol: "xyz:XYZ100", dex: "xyz", kind: "reference" },
  WTIOIL: { symbol: "xyz:CL", dex: "xyz", kind: "reference" },
  SKHYNIX: { symbol: "xyz:SKHX", dex: "xyz", kind: "direct" },
  KPEPE: { symbol: "kPEPE", dex: "", kind: "direct" },
};
const HYPER_MAIN_BASES = new Set(["BTC", "ETH", "SOL", "HYPE", "PUMP", "ZEC", "XRP", "LIT"]);

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

async function fetchHyper(dex: string) {
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return response.json() as Promise<HyperMetaAndContexts>;
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
    let premiumBySymbol = new Map<string, BinancePremium>();
    let fundingHoursBySymbol = new Map<string, number>();
    let binanceOnline = false;
    const hyperBySymbol = new Map<string, { mid: number | null; fundingRate: number | null; dex: string }>();
    const onlineHyperDexes = new Set<string>();
    let hyperliquidOnline = false;
    try {
      const [exchange, books, premiums, fundingInfo] = await Promise.all([
        fetchBinance<BinanceExchangeInfo>("/fapi/v1/exchangeInfo"),
        fetchBinance<BinanceBook[]>("/fapi/v1/ticker/bookTicker"),
        fetchBinance<BinancePremium[]>("/fapi/v1/premiumIndex").catch(() => []),
        fetchBinance<BinanceFundingInfo[]>("/fapi/v1/fundingInfo").catch(() => []),
      ]);
      activeBinance = new Set((exchange.symbols ?? []).flatMap((item) => item.status === "TRADING" && item.symbol ? [item.symbol] : []));
      bookBySymbol = new Map(books.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
      premiumBySymbol = new Map(premiums.flatMap((premium) => premium.symbol ? [[premium.symbol, premium] as const] : []));
      fundingHoursBySymbol = new Map(fundingInfo.flatMap((item) => item.symbol && positive(item.fundingIntervalHours) ? [[item.symbol, Number(item.fundingIntervalHours)] as const] : []));
      binanceOnline = activeBinance.size > 0;
    } catch { /* Polymarket remains usable when Binance is regionally unavailable. */ }

    try {
      const snapshots = await Promise.allSettled(["", "xyz"].map(async (dex) => ({ dex, data: await fetchHyper(dex) })));
      snapshots.forEach((snapshot) => {
        if (snapshot.status !== "fulfilled") return;
        const { dex, data: [meta, contexts] } = snapshot.value;
        onlineHyperDexes.add(dex);
        (meta.universe ?? []).forEach((asset, index) => {
          if (!asset.name || asset.isDelisted) return;
          hyperBySymbol.set(asset.name, { mid: positive(contexts[index]?.midPx), fundingRate: finite(contexts[index]?.funding), dex });
        });
      });
      hyperliquidOnline = hyperBySymbol.size > 0;
    } catch { /* Polymarket and Binance remain usable when Hyperliquid is unavailable. */ }

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
      const premium = mapping ? premiumBySymbol.get(mapping.symbol) : undefined;
      const binanceFundingRate = finite(premium?.lastFundingRate);
      const binanceFundingHours = mapping ? fundingHoursBySymbol.get(mapping.symbol) ?? 8 : null;
      const midPrice = positive(ticker.mid_price);
      const explicitHyper = EXPLICIT_HYPER_MAP[instrument.base_asset];
      const defaultHyperSymbol = instrument.base_asset;
      const xyzHyperSymbol = `xyz:${instrument.base_asset}`;
      const hyperCandidate = explicitHyper
        ?? (HYPER_MAIN_BASES.has(instrument.base_asset)
          ? { symbol: defaultHyperSymbol, dex: "", kind: "direct" as const }
          : { symbol: xyzHyperSymbol, dex: "xyz", kind: "direct" as const });
      const hyperSnapshot = hyperBySymbol.get(hyperCandidate.symbol);
      const hyperMapping = onlineHyperDexes.has(hyperCandidate.dex) && !hyperSnapshot ? null : hyperCandidate;
      const hyperMid = hyperSnapshot?.mid ?? null;
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
        binanceFundingRate,
        binanceFundingHours,
        binanceFundingHourly: binanceFundingRate !== null && binanceFundingHours ? binanceFundingRate / binanceFundingHours : null,
        binanceNextFunding: finite(premium?.nextFundingTime),
        spreadPct: midPrice !== null && binanceMid !== null ? (midPrice / binanceMid - 1) * 100 : null,
        hyperSymbol: hyperMapping?.symbol ?? null,
        hyperDex: hyperMapping?.dex ?? null,
        hyperMappingKind: hyperMapping?.kind ?? null,
        hyperMappingVerified: Boolean(hyperMapping && hyperSnapshot),
        hyperMid,
        hyperUpdatedAt: hyperSnapshot ? Date.now() : null,
        hyperFundingRate: hyperSnapshot?.fundingRate ?? null,
        hyperFundingHourly: hyperSnapshot?.fundingRate ?? null,
        hyperSpreadPct: midPrice !== null && hyperMid !== null ? (midPrice / hyperMid - 1) * 100 : null,
      }];
    });
    return Response.json({ markets, timestamp: Date.now(), sources: { polymarket: true, binance: binanceOnline, hyperliquid: hyperliquidOnline } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Polymarket Perps market data unavailable." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
