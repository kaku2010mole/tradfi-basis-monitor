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
const JAPANESE_STOCKS = [
  { code: "285A", name: "Kioxia", bitgetSymbol: "KIOXIAUSDT", sharesPerPerp: 1 },
  { code: "5802", name: "Sumitomo Electric", bitgetSymbol: "SUMIELECUSDT", sharesPerPerp: 1 },
  { code: "6758", name: "Sony Group", bitgetSymbol: "SONYUSDT", sharesPerPerp: 1 },
  { code: "6857", name: "Advantest", bitgetSymbol: "ADVANTESTUSDT", sharesPerPerp: 1 },
  { code: "6920", name: "Lasertec", bitgetSymbol: "LASERTECUSDT", sharesPerPerp: 1 },
  { code: "7203", name: "Toyota Motor", bitgetSymbol: "TMUSDT", sharesPerPerp: 10 },
  { code: "8035", name: "Tokyo Electron", bitgetSymbol: "TOKYOELUSDT", sharesPerPerp: 1 },
  { code: "8306", name: "MUFG", bitgetSymbol: "MUFGUSDT", sharesPerPerp: 1 },
  { code: "9984", name: "SoftBank Group", bitgetSymbol: "SOFTBANKUSDT", sharesPerPerp: 1 },
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
    const [remote, bitgetResponse, binanceResponse] = await Promise.all([
      posleyAdrSnapshot([...KOREAN_STOCKS.map((stock) => stock.code), ...JAPANESE_STOCKS.map((stock) => stock.code), "USDKRW", "USDJPY"], suppliedIdToken),
      fetch(BITGET_TICKERS, { cache: "no-store", signal: AbortSignal.timeout(7_000) }),
      fetch(BINANCE_BOOKS, { cache: "no-store", signal: AbortSignal.timeout(7_000) }),
    ]);
    if (!bitgetResponse.ok) throw new Error(`Bitget tickers HTTP ${bitgetResponse.status}`);
    if (!binanceResponse.ok) throw new Error(`Binance books HTTP ${binanceResponse.status}`);
    const bitgetPayload = await bitgetResponse.json() as { code?: string; data?: BitgetTicker[] };
    if (bitgetPayload.code !== "00000" || !Array.isArray(bitgetPayload.data)) throw new Error("Bitget returned an invalid ticker payload.");
    const binancePayload = await binanceResponse.json() as BinanceBook[];

    const mergedBooks = new Map(remote.books.map((book) => [book.symbol, book]));
    office?.books.forEach((book) => {
      if ((mergedBooks.get(book.symbol)?.timestamp ?? 0) < book.timestamp) mergedBooks.set(book.symbol, book);
    });
    const wantedSymbols = [...KOREAN_STOCKS.map((stock) => stock.code), ...JAPANESE_STOCKS.map((stock) => stock.code), "USDKRW", "USDJPY"];
    const unavailable = wantedSymbols.filter((symbol) => {
      const book = mergedBooks.get(symbol);
      return !book || !Number.isFinite(book.timestamp) || Date.now() - book.timestamp > QUOTE_MAX_AGE_MS;
    });
    const posley = { ...remote, books: [...mergedBooks.values()], configured: remote.configured || Boolean(office), missing: unavailable,
      state: !remote.configured && !office ? "unconfigured" : unavailable.length ? "partial" : "live", error: remote.configured ? remote.error : office ? "" : remote.error,
      source: remote.configured && office ? "Posley + office relay" : remote.configured ? "remote gateway" : office ? "office relay" : "unavailable" };

    const books = new Map(posley.books.map((book) => [book.symbol, book]));
    const tickers = new Map(bitgetPayload.data.flatMap((ticker) => ticker.symbol ? [[ticker.symbol, ticker] as const] : []));
    const binanceBooks = new Map(binancePayload.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
    const fx = books.get("USDKRW");
    const fxBid = positive(fx?.bid);
    const fxAsk = positive(fx?.ask);
    const yenFx = books.get("USDJPY");
    const yenFxBid = positive(yenFx?.bid);
    const yenFxAsk = positive(yenFx?.ask);
    const now = Date.now();
    const fresh = (timestamp: number | null | undefined) => timestamp !== null && timestamp !== undefined && timestamp > 0 && now - timestamp <= QUOTE_MAX_AGE_MS && timestamp - now < 5_000;

    const rows = KOREAN_STOCKS.map((stock) => {
      const cash = books.get(stock.code);
      const cashBidKrw = positive(cash?.bid);
      const cashAskKrw = positive(cash?.ask);
      const usable = fresh(cash?.timestamp) && fresh(fx?.timestamp);
      const cashBidUsd = usable && cashBidKrw !== null && fxAsk !== null ? cashBidKrw / fxAsk : null;
      const cashAskUsd = usable && cashAskKrw !== null && fxBid !== null ? cashAskKrw / fxBid : null;
      const venues = [
        stock.bitgetSymbol ? (() => { const quote = tickers.get(stock.bitgetSymbol); return { venue: "Bitget", symbol: stock.bitgetSymbol, bid: positive(quote?.bidPr), ask: positive(quote?.askPr), bidQty: positive(quote?.bidSz), askQty: positive(quote?.askSz), updatedAt: positive(quote?.ts) }; })() : null,
        stock.binanceSymbol ? (() => { const quote = binanceBooks.get(stock.binanceSymbol); return { venue: "Binance", symbol: stock.binanceSymbol, bid: positive(quote?.bidPrice), ask: positive(quote?.askPrice), bidQty: positive(quote?.bidQty), askQty: positive(quote?.askQty), updatedAt: positive(quote?.time) }; })() : null,
      ].flatMap((venue) => venue ? [{
        ...venue,
        buyKoreaSellPerp: cashAskUsd !== null && venue.bid !== null && fresh(venue.updatedAt) ? (venue.bid / cashAskUsd - 1) * 100 : null,
        buyPerpSellKorea: cashBidUsd !== null && venue.ask !== null && fresh(venue.updatedAt) ? (cashBidUsd / venue.ask - 1) * 100 : null,
      }] : []);
      return {
        code: stock.code, name: stock.name, market: "KRX", currency: "KRW", sharesPerPerp: 1, venues,
        mappingNote: stock.code === "042700" ? "Binance HANMIUSDT is the exact 042700 contract. Bitget HANMIUSDT is Hanmi Pharm, so it is deliberately excluded." : null,
        cashBidKrw, cashAskKrw, cashBidQty: positive(cash?.bidSize), cashAskQty: positive(cash?.askSize), cashUpdatedAt: cash?.timestamp ?? null,
        cashBidUsd, cashAskUsd,
      };
    });

    const japanRows = JAPANESE_STOCKS.map((stock) => {
      const cash = books.get(stock.code);
      const cashBidKrw = positive(cash?.bid);
      const cashAskKrw = positive(cash?.ask);
      const usable = fresh(cash?.timestamp) && fresh(yenFx?.timestamp);
      const cashBidUsd = usable && cashBidKrw !== null && yenFxAsk !== null ? cashBidKrw * stock.sharesPerPerp / yenFxAsk : null;
      const cashAskUsd = usable && cashAskKrw !== null && yenFxBid !== null ? cashAskKrw * stock.sharesPerPerp / yenFxBid : null;
      const quote = tickers.get(stock.bitgetSymbol);
      const bid = positive(quote?.bidPr); const ask = positive(quote?.askPr); const updatedAt = positive(quote?.ts);
      const venueFresh = fresh(updatedAt);
      return {
        code: stock.code, name: stock.name, market: "TSE", currency: "JPY", sharesPerPerp: stock.sharesPerPerp,
        mappingNote: stock.code === "7203" ? "TM is Toyota's U.S. ADR; one ADS represents 10 ordinary shares." : null,
        cashBidKrw, cashAskKrw, cashBidQty: positive(cash?.bidSize), cashAskQty: positive(cash?.askSize), cashUpdatedAt: cash?.timestamp ?? null,
        cashBidUsd, cashAskUsd,
        venues: [{ venue: "Bitget", symbol: stock.bitgetSymbol, bid, ask, bidQty: positive(quote?.bidSz), askQty: positive(quote?.askSz), updatedAt,
          buyKoreaSellPerp: venueFresh && cashAskUsd !== null && bid !== null ? (bid / cashAskUsd - 1) * 100 : null,
          buyPerpSellKorea: venueFresh && cashBidUsd !== null && ask !== null ? (cashBidUsd / ask - 1) * 100 : null }],
      };
    });

    return Response.json({
      rows: [...rows, ...japanRows],
      fx: { symbol: "USD/KRW", bid: fxBid, ask: fxAsk, updatedAt: fx?.timestamp ?? null },
      yenFx: { symbol: "USD/JPY", bid: yenFxBid, ask: yenFxAsk, updatedAt: yenFx?.timestamp ?? null },
      posley: { configured: posley.configured, state: posley.state, error: posley.error, missing: posley.missing, source: "source" in posley ? posley.source : "remote gateway" },
      timestamp: Date.now(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Korean stock monitor unavailable." }, { status: 502 });
  }
}
