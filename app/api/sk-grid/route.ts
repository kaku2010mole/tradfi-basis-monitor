import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const BINANCE_URL = "https://fapi.binance.com";
const CACHE_MS = 60_000;

type PairDefinition = {
  id: string;
  label: string;
  shortLabel: string;
  venue: "hyperliquid" | "binance";
  x: string;
  y: string;
  interval: "15m" | "1h";
  intervalMs: number;
  historyDays: number;
  makerFeeBps: number;
  takerFeeBps: number;
  conversionRatio: number;
  premiumLabel: string;
  conversionNote: string;
};

const PAIRS: Record<string, PairDefinition> = {
  "skhx-skhy": { id: "skhx-skhy", label: "SKHX / SKHY", shortLabel: "Korea / ADR", venue: "hyperliquid", x: "xyz:SKHX", y: "xyz:SKHY", interval: "15m", intervalMs: 900_000, historyDays: 90, makerFeeBps: 0.3, takerFeeBps: 0.9, conversionRatio: 10, premiumLabel: "SKHY ADR premium", conversionNote: "10 SKHY ADR = 1 SKHX Korean share" },
  "xau-xaut": { id: "xau-xaut", label: "XAU / XAUT", shortLabel: "Gold · primary", venue: "binance", x: "XAUUSDT", y: "XAUTUSDT", interval: "1h", intervalMs: 3_600_000, historyDays: 360, makerFeeBps: 2, takerFeeBps: 5, conversionRatio: 1, premiumLabel: "XAUT premium to XAU", conversionNote: "1 XAUT = 1 troy ounce reference" },
  "xau-paxg": { id: "xau-paxg", label: "XAU / PAXG", shortLabel: "Gold · alternate", venue: "binance", x: "XAUUSDT", y: "PAXGUSDT", interval: "1h", intervalMs: 3_600_000, historyDays: 360, makerFeeBps: 2, takerFeeBps: 5, conversionRatio: 1, premiumLabel: "PAXG premium to XAU", conversionNote: "1 PAXG = 1 troy ounce reference" },
  "xaut-paxg": { id: "xaut-paxg", label: "XAUT / PAXG", shortLabel: "Tokenized gold", venue: "binance", x: "XAUTUSDT", y: "PAXGUSDT", interval: "1h", intervalMs: 3_600_000, historyDays: 360, makerFeeBps: 2, takerFeeBps: 5, conversionRatio: 1, premiumLabel: "PAXG premium to XAUT", conversionNote: "1 PAXG versus 1 XAUT" },
};

type Point = { time: number; x: number; y: number; fundingX: number; fundingY: number; volumeX: number; volumeY: number };
type CacheValue = { expiresAt: number; promise: Promise<unknown> };
const runtime = globalThis as typeof globalThis & { __PAIR_GRID_CACHE__?: Map<string, CacheValue> };
runtime.__PAIR_GRID_CACHE__ ??= new Map();

async function hyperliquid(body: unknown) {
  const response = await fetch(HL_INFO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Hyperliquid returned ${response.status}`);
  return response.json();
}

async function binance(path: string, params: Record<string, string | number> = {}) {
  const url = new URL(path, BINANCE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Binance returned ${response.status}`);
  return response.json();
}

function summarizeBook(levels: [string, string][][], time: number) {
  const bids = levels[0] ?? [], asks = levels[1] ?? [];
  const bid = Number(bids[0]?.[0]), ask = Number(asks[0]?.[0]);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const depth = (rows: [string, string][], side: "bid" | "ask", bps: number) => !mid ? 0 : rows.reduce((sum, row) => {
    const price = Number(row[0]);
    const inside = side === "bid" ? price >= mid * (1 - bps / 10_000) : price <= mid * (1 + bps / 10_000);
    return inside ? sum + price * Number(row[1]) : sum;
  }, 0);
  return { time, bid: bid || null, ask: ask || null, spreadBps: mid ? (ask / bid - 1) * 10_000 : null, depth10Bps: depth(bids, "bid", 10) + depth(asks, "ask", 10), depth25Bps: depth(bids, "bid", 25) + depth(asks, "ask", 25) };
}

async function hyperliquidFunding(coin: string, startTime: number, endTime: number) {
  const windows: Array<Promise<Array<{ time: number; fundingRate: string }>>> = [];
  const step = 14 * 86_400_000;
  for (let start = startTime; start < endTime; start += step) windows.push(hyperliquid({ type: "fundingHistory", coin, startTime: start, endTime: Math.min(endTime, start + step - 1) }));
  try { return (await Promise.all(windows)).flat(); } catch { return []; }
}

async function buildHyperliquidPair(definition: PairDefinition) {
  const now = Date.now();
  const start = now - definition.historyDays * 86_400_000;
  type Candle = { t: number; c: string; v: string };
  type Meta = { name: string; szDecimals: number; maxLeverage: number; growthMode?: string; deployerFeeScale?: string };
  type Context = { markPx: string; oraclePx: string; midPx: string | null; funding: string; openInterest: string; dayNtlVlm: string; premium: string; impactPxs?: string[] };
  type Book = { time: number; levels: Array<Array<{ px: string; sz: string }>> };
  const [market, barsX, barsY, bookX, bookY] = await Promise.all([
    hyperliquid({ type: "metaAndAssetCtxs", dex: "xyz" }) as Promise<[{ universe: Meta[] }, Context[]]>,
    hyperliquid({ type: "candleSnapshot", req: { coin: definition.x, interval: definition.interval, startTime: start, endTime: now } }) as Promise<Candle[]>,
    hyperliquid({ type: "candleSnapshot", req: { coin: definition.y, interval: definition.interval, startTime: start, endTime: now } }) as Promise<Candle[]>,
    hyperliquid({ type: "l2Book", coin: definition.x }) as Promise<Book>,
    hyperliquid({ type: "l2Book", coin: definition.y }) as Promise<Book>,
  ]);
  const [meta, contexts] = market;
  const indexX = meta.universe.findIndex((asset) => asset.name === definition.x);
  const indexY = meta.universe.findIndex((asset) => asset.name === definition.y);
  if (indexX < 0 || indexY < 0 || !barsX.length || !barsY.length) throw new Error("Selected Hyperliquid pair is unavailable");
  const commonStart = Math.max(barsX[0].t, barsY[0].t);
  const [fundingX, fundingY] = await Promise.all([hyperliquidFunding(definition.x, commonStart, now), hyperliquidFunding(definition.y, commonStart, now)]);
  const fundingMap = (rows: Array<{ time: number; fundingRate: string }>) => new Map(rows.map((row) => [Math.floor(row.time / definition.intervalMs) * definition.intervalMs, Number(row.fundingRate)]));
  const fx = fundingMap(fundingX), fy = fundingMap(fundingY), yByTime = new Map(barsY.map((bar) => [bar.t, bar]));
  const points: Point[] = barsX.flatMap((bar) => { const y = yByTime.get(bar.t); return y ? [{ time: bar.t, x: Number(bar.c), y: Number(y.c), fundingX: fx.get(bar.t) ?? 0, fundingY: fy.get(bar.t) ?? 0, volumeX: Number(bar.v), volumeY: Number(y.v) }] : []; });
  const leg = (index: number) => ({ venue: "Hyperliquid", symbol: meta.universe[index].name, mark: Number(contexts[index].markPx), oracle: Number(contexts[index].oraclePx), mid: contexts[index].midPx ? Number(contexts[index].midPx) : null, funding: Number(contexts[index].funding), fundingIntervalHours: 1, openInterest: Number(contexts[index].openInterest), dayVolume: Number(contexts[index].dayNtlVlm), premium: Number(contexts[index].premium), impactBid: Number(contexts[index].impactPxs?.[0]) || null, impactAsk: Number(contexts[index].impactPxs?.[1]) || null, szDecimals: meta.universe[index].szDecimals, maxLeverage: meta.universe[index].maxLeverage });
  const book = (value: Book) => summarizeBook(value.levels.map((side) => side.map((row) => [row.px, row.sz] as [string, string])) as [[string, string][], [string, string][]], value.time);
  return { now, points, fundingRowsX: fundingX.length, fundingRowsY: fundingY.length, pair: { x: leg(indexX), y: leg(indexY) }, books: { x: book(bookX), y: book(bookY) } };
}

async function binanceKlines(symbol: string, definition: PairDefinition, startTime: number, endTime: number) {
  const step = definition.intervalMs * 1_500;
  const requests: Array<Promise<Array<[number, string, string, string, string, string]>>> = [];
  for (let start = startTime; start < endTime; start += step) requests.push(binance("/fapi/v1/klines", { symbol, interval: definition.interval, startTime: start, endTime: Math.min(endTime, start + step - 1), limit: 1500 }));
  const rows = (await Promise.all(requests)).flat();
  return [...new Map(rows.map((row) => [row[0], row])).values()].sort((a, b) => a[0] - b[0]);
}

async function binanceFunding(symbol: string, startTime: number, endTime: number) {
  const step = 120 * 86_400_000;
  const requests: Array<Promise<Array<{ fundingTime: number; fundingRate: string }>>> = [];
  for (let start = startTime; start < endTime; start += step) requests.push(binance("/fapi/v1/fundingRate", { symbol, startTime: start, endTime: Math.min(endTime, start + step - 1), limit: 1000 }));
  try { return (await Promise.all(requests)).flat(); } catch { return []; }
}

async function buildBinancePair(definition: PairDefinition) {
  const now = Date.now();
  const start = now - definition.historyDays * 86_400_000;
  type Premium = { markPrice: string; indexPrice: string; lastFundingRate: string };
  type Ticker = { quoteVolume: string };
  type OpenInterest = { openInterest: string };
  type Depth = { E?: number; T?: number; bids: [string, string][]; asks: [string, string][] };
  type SymbolMeta = { symbol: string; quantityPrecision: number; filters: Array<{ filterType: string; stepSize?: string }> };
  const [barsX, barsY, fundingX, fundingY, premiumX, premiumY, tickerX, tickerY, oiX, oiY, depthX, depthY, exchange, fundingInfo] = await Promise.all([
    binanceKlines(definition.x, definition, start, now), binanceKlines(definition.y, definition, start, now),
    binanceFunding(definition.x, start, now), binanceFunding(definition.y, start, now),
    binance("/fapi/v1/premiumIndex", { symbol: definition.x }) as Promise<Premium>, binance("/fapi/v1/premiumIndex", { symbol: definition.y }) as Promise<Premium>,
    binance("/fapi/v1/ticker/24hr", { symbol: definition.x }) as Promise<Ticker>, binance("/fapi/v1/ticker/24hr", { symbol: definition.y }) as Promise<Ticker>,
    binance("/fapi/v1/openInterest", { symbol: definition.x }) as Promise<OpenInterest>, binance("/fapi/v1/openInterest", { symbol: definition.y }) as Promise<OpenInterest>,
    binance("/fapi/v1/depth", { symbol: definition.x, limit: 20 }) as Promise<Depth>, binance("/fapi/v1/depth", { symbol: definition.y, limit: 20 }) as Promise<Depth>,
    binance("/fapi/v1/exchangeInfo") as Promise<{ symbols: SymbolMeta[] }>,
    binance("/fapi/v1/fundingInfo") as Promise<Array<{ symbol: string; fundingIntervalHours: number }>>,
  ]);
  const yByTime = new Map(barsY.map((row) => [row[0], row]));
  const fundingMap = (rows: Array<{ fundingTime: number; fundingRate: string }>) => new Map(rows.map((row) => [Math.floor(row.fundingTime / definition.intervalMs) * definition.intervalMs, Number(row.fundingRate)]));
  const fx = fundingMap(fundingX), fy = fundingMap(fundingY);
  const points: Point[] = barsX.flatMap((row) => { const y = yByTime.get(row[0]); return y ? [{ time: row[0], x: Number(row[4]), y: Number(y[4]), fundingX: fx.get(row[0]) ?? 0, fundingY: fy.get(row[0]) ?? 0, volumeX: Number(row[5]), volumeY: Number(y[5]) }] : []; });
  const metaBySymbol = new Map(exchange.symbols.map((symbol) => [symbol.symbol, symbol]));
  const hoursBySymbol = new Map(fundingInfo.map((row) => [row.symbol, row.fundingIntervalHours]));
  const leg = (symbol: string, premium: Premium, ticker: Ticker, oi: OpenInterest) => { const interval = hoursBySymbol.get(symbol) ?? 8; return { venue: "Binance", symbol, mark: Number(premium.markPrice), oracle: Number(premium.indexPrice), mid: null, funding: Number(premium.lastFundingRate) / interval, fundingIntervalHours: interval, openInterest: Number(oi.openInterest), dayVolume: Number(ticker.quoteVolume), premium: Number(premium.markPrice) / Number(premium.indexPrice) - 1, impactBid: null, impactAsk: null, szDecimals: metaBySymbol.get(symbol)?.quantityPrecision ?? 3, maxLeverage: 10 }; };
  return { now, points, fundingRowsX: fundingX.length, fundingRowsY: fundingY.length, pair: { x: leg(definition.x, premiumX, tickerX, oiX), y: leg(definition.y, premiumY, tickerY, oiY) }, books: { x: summarizeBook([depthX.bids, depthX.asks], depthX.E ?? depthX.T ?? now), y: summarizeBook([depthY.bids, depthY.asks], depthY.E ?? depthY.T ?? now) } };
}

async function buildPayload(definition: PairDefinition) {
  const loaded = definition.venue === "hyperliquid" ? await buildHyperliquidPair(definition) : await buildBinancePair(definition);
  if (loaded.points.length < 500) throw new Error("Not enough aligned history for this pair");
  return { ok: true, serverTime: loaded.now, definition: { id: definition.id, label: definition.label, shortLabel: definition.shortLabel, venue: definition.venue, conversionRatio: definition.conversionRatio, premiumLabel: definition.premiumLabel, conversionNote: definition.conversionNote }, availablePairs: Object.values(PAIRS).map(({ id, label, shortLabel, venue, interval }) => ({ id, label, shortLabel, venue, interval })), interval: definition.interval, pair: loaded.pair, books: loaded.books, points: loaded.points, coverage: { first: loaded.points[0].time, last: loaded.points.at(-1)!.time, bars: loaded.points.length, days: (loaded.points.at(-1)!.time - loaded.points[0].time) / 86_400_000, fundingRowsX: loaded.fundingRowsX, fundingRowsY: loaded.fundingRowsY }, assumptions: { makerFeeBps: definition.makerFeeBps, takerFeeBps: definition.takerFeeBps, feeNote: definition.venue === "hyperliquid" ? "Tier-0 HIP-3 growth-mode estimate before account-specific discounts or rebates" : "Binance USDⓈ-M VIP-0 assumption; replace with your account rate" } };
}

export async function GET(request: NextRequest) {
  const pairId = request.nextUrl.searchParams.get("pair") ?? "skhx-skhy";
  const definition = PAIRS[pairId];
  if (!definition) return NextResponse.json({ ok: false, error: "Unsupported pair" }, { status: 400 });
  try {
    const now = Date.now();
    const cached = runtime.__PAIR_GRID_CACHE__!.get(pairId);
    if (!cached || cached.expiresAt <= now) runtime.__PAIR_GRID_CACHE__!.set(pairId, { expiresAt: now + CACHE_MS, promise: buildPayload(definition) });
    return NextResponse.json(await runtime.__PAIR_GRID_CACHE__!.get(pairId)!.promise, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    runtime.__PAIR_GRID_CACHE__!.delete(pairId);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown upstream error" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
