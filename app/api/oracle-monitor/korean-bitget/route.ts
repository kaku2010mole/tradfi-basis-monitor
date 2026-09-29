import { posleyAdrSnapshot } from "../../../lib/posleyAdr";

export const dynamic = "force-dynamic";

const BITGET_TICKERS = "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures";
const BINANCE_BOOKS = "https://fapi.binance.com/fapi/v1/ticker/bookTicker";
const KOREAN_STOCKS = [
  { code: "034020", name: "Doosan Enerbility", bitgetSymbol: "DOOSENERUSDT", binanceSymbol: null },
  { code: "035420", name: "NAVER", bitgetSymbol: "NAVERUSDT", binanceSymbol: "NAVERUSDT" },
  { code: "042700", name: "Hanmi Semiconductor", bitgetSymbol: null, binanceSymbol: "HANMIUSDT" },
  { code: "066570", name: "LG Electronics", bitgetSymbol: "LGELECTRONICSUSDT", binanceSymbol: "LGELECTRONICSUSDT" },
  { code: "454910", name: "Doosan Robotics", bitgetSymbol: "DOOSBOTUSDT", binanceSymbol: null },
] as const;

type BitgetTicker = {
  symbol?: string; bidPr?: string; askPr?: string; bidSz?: string; askSz?: string; lastPr?: string; ts?: string;
};
type BinanceBook = { symbol?: string; bidPrice?: string; askPrice?: string; bidQty?: string; askQty?: string; time?: number };

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

type PushedQuote = { symbol?: string; bid?: number; ask?: number; bidSize?: number; askSize?: number; marketTimestamp?: number };
type PushStore = typeof globalThis & { __FUTU_PUSH_SNAPSHOT__?: { payload: { quotes?: PushedQuote[] }; receivedAt: number } };
const PUSH_MAX_AGE_MS = 15_000;
const QUOTE_MAX_AGE_MS = 60_000;

function officeRelaySnapshot() {
  const stored = (globalThis as PushStore).__FUTU_PUSH_SNAPSHOT__;
  if (!stored || Date.now() - stored.receivedAt > PUSH_MAX_AGE_MS) return null;
  const books = (stored.payload.quotes ?? []).flatMap((quote) => {
    const code = quote.symbol?.startsWith("KRX.") ? quote.symbol.slice(4) : quote.symbol === "FX.USDKRW" ? "USDKRW" : null;
    const timestamp = Number(quote.marketTimestamp);
    if (!code || !Number.isFinite(timestamp) || Date.now() - timestamp > QUOTE_MAX_AGE_MS) return [];
    return [{ symbol: code, streamKey: `office:${quote.symbol}`, bid: positive(quote.bid), ask: positive(quote.ask), last: null, bidSize: positive(quote.bidSize), askSize: positive(quote.askSize), timestamp }];
  });
  if (!books.some((book) => book.symbol !== "USDKRW")) return null;
  const wanted = [...KOREAN_STOCKS.map((stock) => stock.code), "USDKRW"];
  const found = new Set(books.map((book) => book.symbol));
  return { configured: true, state: found.size === wanted.length ? "live" : "partial", error: "", books, missing: wanted.filter((symbol) => !found.has(symbol)), timestamp: Date.now(), source: "office relay" };
}

export async function GET(request: Request) {
  try {
    const authorization = request.headers.get("authorization") ?? "";
    const suppliedIdToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : undefined;
    const office = officeRelaySnapshot();
    const [posley, bitgetResponse, binanceResponse] = await Promise.all([
      office ?? posleyAdrSnapshot([...KOREAN_STOCKS.map((stock) => stock.code), "USDKRW"], suppliedIdToken),
      fetch(BITGET_TICKERS, { cache: "no-store", signal: AbortSignal.timeout(7_000) }),
      fetch(BINANCE_BOOKS, { cache: "no-store", signal: AbortSignal.timeout(7_000) }),
    ]);
    if (!bitgetResponse.ok) throw new Error(`Bitget tickers HTTP ${bitgetResponse.status}`);
    if (!binanceResponse.ok) throw new Error(`Binance books HTTP ${binanceResponse.status}`);
    const bitgetPayload = await bitgetResponse.json() as { code?: string; data?: BitgetTicker[] };
    if (bitgetPayload.code !== "00000" || !Array.isArray(bitgetPayload.data)) throw new Error("Bitget returned an invalid ticker payload.");
    const binancePayload = await binanceResponse.json() as BinanceBook[];

    const books = new Map(posley.books.map((book) => [book.symbol, book]));
    const tickers = new Map(bitgetPayload.data.flatMap((ticker) => ticker.symbol ? [[ticker.symbol, ticker] as const] : []));
    const binanceBooks = new Map(binancePayload.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
    const fx = books.get("USDKRW");
    const fxBid = positive(fx?.bid);
    const fxAsk = positive(fx?.ask);

    const rows = KOREAN_STOCKS.map((stock) => {
      const cash = books.get(stock.code);
      const cashBidKrw = positive(cash?.bid);
      const cashAskKrw = positive(cash?.ask);
      const cashBidUsd = cashBidKrw !== null && fxAsk !== null ? cashBidKrw / fxAsk : null;
      const cashAskUsd = cashAskKrw !== null && fxBid !== null ? cashAskKrw / fxBid : null;
      const venues = [
        stock.bitgetSymbol ? (() => { const quote = tickers.get(stock.bitgetSymbol); return { venue: "Bitget", symbol: stock.bitgetSymbol, bid: positive(quote?.bidPr), ask: positive(quote?.askPr), bidQty: positive(quote?.bidSz), askQty: positive(quote?.askSz), updatedAt: positive(quote?.ts) }; })() : null,
        stock.binanceSymbol ? (() => { const quote = binanceBooks.get(stock.binanceSymbol); return { venue: "Binance", symbol: stock.binanceSymbol, bid: positive(quote?.bidPrice), ask: positive(quote?.askPrice), bidQty: positive(quote?.bidQty), askQty: positive(quote?.askQty), updatedAt: positive(quote?.time) }; })() : null,
      ].flatMap((venue) => venue ? [{
        ...venue,
        buyKoreaSellPerp: cashAskUsd !== null && venue.bid !== null ? (venue.bid / cashAskUsd - 1) * 100 : null,
        buyPerpSellKorea: cashBidUsd !== null && venue.ask !== null ? (cashBidUsd / venue.ask - 1) * 100 : null,
      }] : []);
      return {
        code: stock.code, name: stock.name, venues,
        mappingNote: stock.code === "042700" ? "Binance HANMIUSDT is the exact 042700 contract. Bitget HANMIUSDT is Hanmi Pharm, so it is deliberately excluded." : null,
        cashBidKrw, cashAskKrw, cashBidQty: positive(cash?.bidSize), cashAskQty: positive(cash?.askSize), cashUpdatedAt: cash?.timestamp ?? null,
        cashBidUsd, cashAskUsd,
      };
    });

    return Response.json({
      rows,
      fx: { symbol: "USD/KRW", bid: fxBid, ask: fxAsk, updatedAt: fx?.timestamp ?? null },
      posley: { configured: posley.configured, state: posley.state, error: posley.error, missing: posley.missing, source: "source" in posley ? posley.source : "remote gateway" },
      timestamp: Date.now(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Korean stock monitor unavailable." }, { status: 502 });
  }
}
