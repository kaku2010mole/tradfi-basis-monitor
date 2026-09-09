export const dynamic = "force-dynamic";

const OKX_API = "https://www.okx.com/api/v5";
const BINANCE_API = "https://fapi.binance.com/fapi/v1";
const PRIORITY = new Map<string, { perp: string; ratio: number }>([
  ["XSHEIN-USDT", { perp: "SHEINUSDT", ratio: 1 }],
  ["XPOPMART-USDT", { perp: "POPMARTUSDT", ratio: 1 }],
  ["XXIAOMI-USDT", { perp: "HK1810USDT", ratio: 7.84 }],
]);

type OkxInstrument = { instId: string; instType: string; instCategory?: string; baseCcy: string; quoteCcy: string; state: string };
type OkxTicker = { instId: string; bidPx?: string; bidSz?: string; askPx?: string; askSz?: string; last?: string; volCcy24h?: string; ts?: string };
type BinanceBook = { symbol: string; bidPrice?: string; bidQty?: string; askPrice?: string; askQty?: string; time?: number };
type BinancePremium = { symbol: string; markPrice?: string; indexPrice?: string; lastFundingRate?: string; nextFundingTime?: number; time?: number };
type BinanceTicker = { symbol: string; quoteVolume?: string };
type CustomPair = { okx: string; perp: string; ratio: number };

let instrumentCache: { expires: number; items: OkxInstrument[] } | null = null;
let snapshotCache: { expires: number; value: ReturnType<typeof buildSnapshot> } | null = null;

const number = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const positive = (value: unknown) => { const parsed = number(value); return parsed !== null && parsed > 0 ? parsed : null; };

async function json<T>(url: string) {
  let lastError: unknown;
  for (const delay of [0, 150, 450]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6_500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("Market request failed.");
}

async function instruments() {
  if (instrumentCache && instrumentCache.expires > Date.now()) return instrumentCache.items;
  const payload = await json<{ code: string; data: OkxInstrument[] }>(`${OKX_API}/public/instruments?instType=SPOT`);
  const items = payload.data.filter((item) => item.instCategory === "3" && item.quoteCcy === "USDT" && item.state === "live");
  instrumentCache = { expires: Date.now() + 5 * 60_000, items };
  return items;
}

const parseCustom = (value: string | null): CustomPair[] => (value ?? "").split(",").flatMap((entry) => {
  const [okxRaw, perpRaw, ratioRaw] = entry.split("|");
  const okx = (okxRaw ?? "").trim().toUpperCase(); const perp = (perpRaw ?? "").trim().toUpperCase(); const ratio = Number(ratioRaw ?? 1);
  return /^[A-Z0-9]+-USDT$/.test(okx) && /^[A-Z0-9_]{2,32}$/.test(perp) && Number.isFinite(ratio) && ratio > 0 && ratio <= 1_000 ? [{ okx, perp, ratio }] : [];
}).slice(0, 12);

async function buildSnapshot() {
  const [instrumentItems, okxPayload, books, premiums, tickers] = await Promise.all([
    instruments(),
    json<{ code: string; data: OkxTicker[] }>(`${OKX_API}/market/tickers?instType=SPOT`),
    json<BinanceBook[]>(`${BINANCE_API}/ticker/bookTicker`),
    json<BinancePremium[]>(`${BINANCE_API}/premiumIndex`),
    json<BinanceTicker[]>(`${BINANCE_API}/ticker/24hr`),
  ]);
  return {
    instrumentItems,
    okx: new Map(okxPayload.data.map((item) => [item.instId, item])),
    books: new Map(books.map((item) => [item.symbol, item])),
    premiums: new Map(premiums.map((item) => [item.symbol, item])),
    tickers: new Map(tickers.map((item) => [item.symbol, item])),
  };
}

async function snapshot() {
  if (snapshotCache && snapshotCache.expires > Date.now()) return snapshotCache.value;
  const value = buildSnapshot(); snapshotCache = { expires: Date.now() + 2_000, value };
  try { return await value; } catch (error) { snapshotCache = null; throw error; }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const custom = parseCustom(url.searchParams.get("pairs"));
    const data = await snapshot();
    const customByOkx = new Map(custom.map((item) => [item.okx, { perp: item.perp, ratio: item.ratio }]));
    const configs = data.instrumentItems.map((instrument) => {
      const base = instrument.baseCcy.toUpperCase(); const inferred = base.startsWith("X") ? `${base.slice(1)}USDT` : "";
      const mapping = customByOkx.get(instrument.instId) ?? PRIORITY.get(instrument.instId) ?? { perp: inferred, ratio: 1 };
      return { instrument, ...mapping, priority: PRIORITY.has(instrument.instId) };
    });
    custom.forEach((item) => { if (!configs.some((config) => config.instrument.instId === item.okx)) configs.push({ instrument: { instId: item.okx, instType: "SPOT", baseCcy: item.okx.split("-")[0], quoteCcy: "USDT", state: "live" }, perp: item.perp, ratio: item.ratio, priority: false }); });

    const rows = configs.flatMap((config) => {
      const spot = data.okx.get(config.instrument.instId); const book = data.books.get(config.perp); const premium = data.premiums.get(config.perp); const ticker = data.tickers.get(config.perp);
      const spotBid = positive(spot?.bidPx); const spotAsk = positive(spot?.askPx); const perpBidRaw = positive(book?.bidPrice); const perpAskRaw = positive(book?.askPrice);
      if ((spotBid === null || spotAsk === null) && !config.priority) return [];
      if ((!book || !premium) && !config.priority && !customByOkx.has(config.instrument.instId)) return [];
      const perpBid = perpBidRaw === null ? null : perpBidRaw / config.ratio; const perpAsk = perpAskRaw === null ? null : perpAskRaw / config.ratio;
      const longSpotEdge = spotAsk !== null && perpBid !== null ? (perpBid / spotAsk - 1) * 100 : null;
      const shortSpotEdge = spotBid !== null && perpAsk !== null ? (spotBid / perpAsk - 1) * 100 : null;
      const bestEdge = longSpotEdge === null ? shortSpotEdge : shortSpotEdge === null ? longSpotEdge : Math.max(longSpotEdge, shortSpotEdge);
      const direction = bestEdge === null ? "WAITING FOR MATCH" : longSpotEdge !== null && longSpotEdge >= (shortSpotEdge ?? -Infinity) ? "LONG OKX · SHORT BINANCE" : "SHORT OKX · LONG BINANCE";
      return [{
        id: config.instrument.instId, okxSymbol: config.instrument.instId, perpSymbol: config.perp, ratio: config.ratio,
        priority: config.priority, spotBid, spotAsk, spotBidQty: positive(spot?.bidSz), spotAskQty: positive(spot?.askSz),
        okxVolume24h: number(spot?.volCcy24h), okxUpdatedAt: number(spot?.ts),
        perpBid, perpAsk, perpBidRaw, perpAskRaw, perpBidQty: positive(book?.bidQty), perpAskQty: positive(book?.askQty),
        binanceVolume24h: number(ticker?.quoteVolume), funding: number(premium?.lastFundingRate), fundingHours: 8,
        nextFundingTime: number(premium?.nextFundingTime), bestEdge, longSpotEdge, shortSpotEdge, direction,
      }];
    }).sort((a, b) => Number(b.priority) - Number(a.priority) || (b.bestEdge ?? -Infinity) - (a.bestEdge ?? -Infinity));
    return Response.json({ rows, scanned: data.instrumentItems.length, timestamp: Date.now() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OKX / Binance scanner unavailable." }, { status: 502 });
  }
}
