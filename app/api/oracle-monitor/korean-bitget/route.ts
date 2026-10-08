import { equityBasis, equitySpreads, preferCashLast } from "../../../lib/equityBasis";
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
  { code: "285A", name: "Kioxia", bitgetSymbol: "KIOXIAUSDT", sharesPerPerp: 1, adrSymbol: null, sharesPerAdr: null },
  { code: "5802", name: "Sumitomo Electric", bitgetSymbol: "SUMIELECUSDT", sharesPerPerp: 1, adrSymbol: null, sharesPerAdr: null },
  { code: "6758", name: "Sony Group", bitgetSymbol: "SONYUSDT", sharesPerPerp: 1, adrSymbol: "SONY", sharesPerAdr: 1 },
  { code: "6857", name: "Advantest", bitgetSymbol: "ADVANTESTUSDT", sharesPerPerp: 1, adrSymbol: null, sharesPerAdr: null },
  { code: "6920", name: "Lasertec", bitgetSymbol: "LASERTECUSDT", sharesPerPerp: 1, adrSymbol: null, sharesPerAdr: null },
  { code: "7203", name: "Toyota Motor", bitgetSymbol: "TMUSDT", sharesPerPerp: 10, adrSymbol: "TM", sharesPerAdr: 10 },
  { code: "8035", name: "Tokyo Electron", bitgetSymbol: "TOKYOELUSDT", sharesPerPerp: 1, adrSymbol: null, sharesPerAdr: null },
  { code: "8306", name: "MUFG", bitgetSymbol: "MUFGUSDT", sharesPerPerp: 1, adrSymbol: "MUFG", sharesPerAdr: 1 },
  { code: "9984", name: "SoftBank Group", bitgetSymbol: "SOFTBANKUSDT", sharesPerPerp: 1, adrSymbol: null, sharesPerAdr: null },
] as const;
const ADR_SYMBOLS = JAPANESE_STOCKS.flatMap((stock) => stock.adrSymbol ? [stock.adrSymbol] : []);

type BitgetTicker = {
  symbol?: string; bidPr?: string; askPr?: string; bidSz?: string; askSz?: string; lastPr?: string; indexPrice?: string; ts?: string;
};
type BinanceBook = { symbol?: string; bidPrice?: string; askPrice?: string; bidQty?: string; askQty?: string; time?: number };

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

type PushedQuote = { symbol?: string; bid?: number | null; ask?: number | null; last?: number | null; bidSize?: number | null; askSize?: number | null; marketTimestamp?: number; marketState?: string; source?: string };
type PushStore = typeof globalThis & { __FUTU_PUSH_SNAPSHOT__?: { payload: { quotes?: PushedQuote[] }; receivedAt: number } };
const QUOTE_MAX_AGE_MS = 60_000;
const DISPLAY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function marketSession(market: "KRX" | "TSE", now: number) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const clock = hour * 60 + minute;
  if (weekday === "Sat" || weekday === "Sun") return "CLOSED";
  if (market === "KRX") {
    if (clock >= 7 * 60 && clock < 8 * 60) return "PRE-MARKET";
    if (clock >= 8 * 60 && clock < 14 * 60 + 30) return "REGULAR";
    if (clock >= 14 * 60 + 30 && clock < 14 * 60 + 40) return "AFTER-HOURS OPENING";
    if (clock >= 14 * 60 + 40 && clock < 19 * 60) return "AFTER-HOURS";
    return "CLOSED";
  }
  if (clock >= 7 * 60 && clock < 8 * 60) return "OPENING AUCTION";
  if (clock >= 8 * 60 && clock < 10 * 60 + 30 || clock >= 11 * 60 + 30 && clock < 14 * 60 + 30) return "REGULAR";
  if (clock >= 10 * 60 + 30 && clock < 11 * 60 + 30) return "LUNCH";
  return "CLOSED";
}

function usSession(now: number) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const clock = Number(parts.find((part) => part.type === "hour")?.value) * 60 + Number(parts.find((part) => part.type === "minute")?.value);
  if (weekday === "Sat" || weekday === "Sun") return "CLOSED";
  if (clock >= 9 * 60 + 30 && clock < 16 * 60) return "REGULAR";
  if (clock >= 4 * 60 && clock < 9 * 60 + 30) return "PRE-MARKET";
  if (clock >= 16 * 60 && clock < 20 * 60) return "AFTER-HOURS";
  return "CLOSED";
}

function officeRelaySnapshot() {
  const stored = (globalThis as PushStore).__FUTU_PUSH_SNAPSHOT__;
  if (!stored) return null;
  const books = (stored.payload.quotes ?? []).flatMap((quote) => {
    const code = quote.symbol?.startsWith("KRX.") || quote.symbol?.startsWith("TSE.") ? quote.symbol.slice(4) : quote.symbol?.startsWith("US.") ? quote.symbol.slice(3) : quote.symbol === "FX.USDKRW" ? "USDKRW" : quote.symbol === "FX.USDJPY" ? "USDJPY" : null;
    const timestamp = Number(quote.marketTimestamp);
    if (!code || !Number.isFinite(timestamp) || timestamp > Date.now() + 5_000 || Date.now() - timestamp > DISPLAY_MAX_AGE_MS) return [];
    return [{ symbol: code, streamKey: `office:${quote.symbol}`, bid: positive(quote.bid), ask: positive(quote.ask), last: positive(quote.last), bidSize: positive(quote.bidSize), askSize: positive(quote.askSize), timestamp, marketState: quote.marketState ?? null, source: quote.source ?? (quote.symbol?.startsWith("US.") ? "Futu OpenD" : "Posley office relay") }];
  });
  if (!books.length) return null;
  const wanted = [...KOREAN_STOCKS.map((stock) => stock.code), ...JAPANESE_STOCKS.map((stock) => stock.code), ...(usSession(Date.now()) === "REGULAR" ? ADR_SYMBOLS : []), "USDKRW", "USDJPY"];
  const found = new Set(books.map((book) => book.symbol));
  return { configured: true, state: wanted.every((symbol) => found.has(symbol)) ? "live" : "partial", error: "", books, missing: wanted.filter((symbol) => !found.has(symbol)), timestamp: Date.now(), source: "office relay" };
}

export async function GET(request: Request) {
  try {
    const authorization = request.headers.get("authorization") ?? "";
    const suppliedIdToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : undefined;
    const office = officeRelaySnapshot();
    const nowForSession = Date.now();
    const krxSession = marketSession("KRX", nowForSession);
    const tseSession = marketSession("TSE", nowForSession);
    const activeOfficeSymbols = [
      ...(["PRE-MARKET", "REGULAR", "AFTER-HOURS OPENING", "AFTER-HOURS"].includes(krxSession) ? [...KOREAN_STOCKS.map((stock) => stock.code), "USDKRW"] : []),
      ...(["OPENING AUCTION", "REGULAR"].includes(tseSession) ? [...JAPANESE_STOCKS.map((stock) => stock.code), "USDJPY"] : []),
      ...(usSession(nowForSession) === "REGULAR" ? ADR_SYMBOLS : []),
    ];
    const officeFreshSymbols = new Set(office?.books.filter((book) => nowForSession - book.timestamp <= QUOTE_MAX_AGE_MS && book.timestamp - nowForSession < 5_000).map((book) => book.symbol));
    const officeCoversActiveMarkets = activeOfficeSymbols.every((symbol) => officeFreshSymbols.has(symbol));
    const remoteRequest = office && !suppliedIdToken && officeCoversActiveMarkets
      ? Promise.resolve({ configured: false, state: "idle", error: "", books: [], missing: [], timestamp: Date.now() })
      : posleyAdrSnapshot([...KOREAN_STOCKS.map((stock) => stock.code), ...JAPANESE_STOCKS.map((stock) => stock.code), ...ADR_SYMBOLS, "USDKRW", "USDJPY"], suppliedIdToken);
    const [remote, bitgetResponse, binanceResponse] = await Promise.all([
      remoteRequest,
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
    const wantedSymbols = [...KOREAN_STOCKS.map((stock) => stock.code), ...JAPANESE_STOCKS.map((stock) => stock.code), ...(usSession(Date.now()) === "REGULAR" ? ADR_SYMBOLS : []), "USDKRW", "USDJPY"];
    const unavailable = wantedSymbols.filter((symbol) => {
      const book = mergedBooks.get(symbol);
      return !book || !Number.isFinite(book.timestamp) || Date.now() - book.timestamp > QUOTE_MAX_AGE_MS;
    });
    const sessions = { KRX: marketSession("KRX", Date.now()), TSE: marketSession("TSE", Date.now()), US: usSession(Date.now()) };
    const hasCashQuote = [...KOREAN_STOCKS, ...JAPANESE_STOCKS].some((stock) => mergedBooks.has(stock.code));
    const posley = { ...remote, books: [...mergedBooks.values()], configured: remote.configured || Boolean(office), missing: unavailable,
      state: !remote.configured && !office ? "unconfigured" : sessions.KRX === "CLOSED" && sessions.TSE === "CLOSED" && sessions.US === "CLOSED" && hasCashQuote ? "closed" : unavailable.length ? "partial" : "live", error: activeOfficeSymbols.some((symbol) => unavailable.includes(symbol)) ? remote.error : "",
      source: office && !remote.books.length ? "office relay" : remote.configured && office ? "Posley + office relay" : remote.configured ? "remote gateway" : office ? "office relay" : "unavailable" };

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
    const bitgetFx = tickers.get("USDJPYUSDT");
    const bitgetFxTime = positive(bitgetFx?.ts);
    const bitgetFxIndex = positive(bitgetFx?.indexPrice);
    const useBitgetFx = !fresh(yenFx?.timestamp) && fresh(bitgetFxTime) && bitgetFxIndex !== null;

    const rows = KOREAN_STOCKS.map((stock) => {
      const cash = books.get(stock.code);
      const cashBidKrw = positive(cash?.bid);
      const cashAskKrw = positive(cash?.ask);
      const cashSessionActive = sessions.KRX === "REGULAR" || sessions.KRX === "AFTER-HOURS";
      const { cashBidUsd, cashAskUsd } = equityBasis(cash ?? {}, fx ?? {}, 1, !cashSessionActive);
      const venues = [
        stock.bitgetSymbol ? (() => { const quote = tickers.get(stock.bitgetSymbol); return { venue: "Bitget", symbol: stock.bitgetSymbol, bid: positive(quote?.bidPr), ask: positive(quote?.askPr), bidQty: positive(quote?.bidSz), askQty: positive(quote?.askSz), updatedAt: positive(quote?.ts) }; })() : null,
        stock.binanceSymbol ? (() => { const quote = binanceBooks.get(stock.binanceSymbol); return { venue: "Binance", symbol: stock.binanceSymbol, bid: positive(quote?.bidPrice), ask: positive(quote?.askPrice), bidQty: positive(quote?.bidQty), askQty: positive(quote?.askQty), updatedAt: positive(quote?.time) }; })() : null,
      ].flatMap((venue) => venue ? [{
        ...venue,
        ...equitySpreads(cashBidUsd, cashAskUsd, venue),
      }] : []);
      return {
        code: stock.code, name: stock.name, market: "KRX", session: sessions.KRX, currency: "KRW", sharesPerPerp: 1, venues,
        mappingNote: stock.code === "042700" ? "Binance HANMIUSDT is the exact 042700 contract. Bitget HANMIUSDT is Hanmi Pharm, so it is deliberately excluded." : null,
        cashBidKrw, cashAskKrw, cashBidQty: positive(cash?.bidSize), cashAskQty: positive(cash?.askSize), cashUpdatedAt: cash?.timestamp ?? null,
        cashLast: positive(cash?.last),
        cashBidUsd, cashAskUsd,
      };
    });

    const japanRows = JAPANESE_STOCKS.map((stock) => {
      const cash = books.get(stock.code);
      const cashBidKrw = positive(cash?.bid);
      const cashAskKrw = positive(cash?.ask);
      const basisFx = useBitgetFx ? { last: bitgetFxIndex } : yenFx ?? {};
      const { cashBidUsd, cashAskUsd } = equityBasis(cash ?? {}, basisFx, stock.sharesPerPerp,
        preferCashLast("TSE", sessions.TSE, cash?.timestamp, now));
      const quote = tickers.get(stock.bitgetSymbol);
      const bid = positive(quote?.bidPr); const ask = positive(quote?.askPr); const updatedAt = positive(quote?.ts);
      const adr = stock.adrSymbol ? books.get(stock.adrSymbol) : null;
      const adrScale = stock.sharesPerAdr ? stock.sharesPerPerp / stock.sharesPerAdr : null;
      return {
        code: stock.code, name: stock.name, market: "TSE", session: sessions.TSE, currency: "JPY", sharesPerPerp: stock.sharesPerPerp,
        mappingNote: stock.code === "7203" ? "TM is Toyota's U.S. ADR; one ADS represents 10 ordinary shares." : null,
        cashBidKrw, cashAskKrw, cashBidQty: positive(cash?.bidSize), cashAskQty: positive(cash?.askSize), cashUpdatedAt: cash?.timestamp ?? null,
        cashLast: positive(cash?.last),
        cashBidUsd, cashAskUsd,
        adr: stock.adrSymbol ? { symbol: stock.adrSymbol, sharesPerAdr: stock.sharesPerAdr, source: !adr ? "Waiting for ADR feed" : "source" in adr ? String(adr.source) : "Posley IBKR", marketState: adr && "marketState" in adr ? adr.marketState : null,
          bid: positive(adr?.bid), ask: positive(adr?.ask), last: positive(adr?.last), bidQty: positive(adr?.bidSize), askQty: positive(adr?.askSize), updatedAt: adr?.timestamp ?? null,
          buyAdrSellPerp: adrScale && positive(adr?.ask) && bid ? (bid / (Number(adr?.ask) * adrScale) - 1) * 100 : null,
          buyPerpSellAdr: adrScale && positive(adr?.bid) && ask ? ((Number(adr?.bid) * adrScale) / ask - 1) * 100 : null,
        } : null,
        venues: [{ venue: "Bitget", symbol: stock.bitgetSymbol, bid, ask, bidQty: positive(quote?.bidSz), askQty: positive(quote?.askSz), updatedAt,
          ...equitySpreads(cashBidUsd, cashAskUsd, { bid, ask }) }],
      };
    });

    return Response.json({
      rows: [...rows, ...japanRows],
      sessions,
      fx: { symbol: "USD/KRW", source: "Posley", bid: fxBid, ask: fxAsk, last: positive(fx?.last), updatedAt: fx?.timestamp ?? null },
      yenFx: useBitgetFx
        ? { symbol: "USD/JPY", source: "Bitget FX index · indicative", bid: null, ask: null, last: bitgetFxIndex, updatedAt: bitgetFxTime }
        : { symbol: "USD/JPY", source: "Posley", bid: yenFxBid, ask: yenFxAsk, last: positive(yenFx?.last), updatedAt: yenFx?.timestamp ?? null },
      posley: { configured: posley.configured, state: posley.state, error: posley.error, missing: posley.missing, source: "source" in posley ? posley.source : "remote gateway" },
      timestamp: Date.now(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Korean stock monitor unavailable." }, { status: 502 });
  }
}
