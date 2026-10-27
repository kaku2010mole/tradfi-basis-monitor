import { equityBasis, equitySpreads, preferCashLast } from "../../../lib/equityBasis";
import { posleyAdrSnapshot } from "../../../lib/posleyAdr";
import { bitgetBooksWithin } from "../../../lib/bitgetRelativeMarket";
import { publicBinanceJson } from "../../../lib/publicBinanceJson";
import { koreanLatestClose } from "../../../lib/koreanLatestClose";

export const dynamic = "force-dynamic";

const BINANCE_BOOKS = "https://fapi.binance.com/fapi/v1/ticker/bookTicker";
const EXISTING_KOREAN_STOCKS = [
  { code: "034020", name: "Doosan Enerbility", bitgetSymbol: "DOOSENERUSDT", binanceSymbol: null },
  { code: "035420", name: "NAVER", bitgetSymbol: "NAVERUSDT", binanceSymbol: "NAVERUSDT" },
  { code: "042700", name: "Hanmi Semiconductor", bitgetSymbol: null, binanceSymbol: "HANMIUSDT" },
  { code: "066570", name: "LG Electronics", bitgetSymbol: "LGELECTRONICSUSDT", binanceSymbol: "LGELECTRONICSUSDT" },
  { code: "454910", name: "Doosan Robotics", bitgetSymbol: "DOOSBOTUSDT", binanceSymbol: null },
  { code: "0158S0", name: "Elice", chineseName: "Elice（엘리스）", bitgetSymbol: "ELICEUSDT", binanceSymbol: null, strictCashBook: true },
] as const;
// Posley publishes these cash books through Futu Web API, not IBKR.
// These names stay in the normal Korean group even during a cash-feed outage.
const FUTU_KOREAN_STOCKS = [
  { code: "207940", name: "Samsung Biologics", chineseName: "三星生物制剂", symbol: "SSBIOLOGICSUSDT" },
  { code: "000270", name: "Kia", chineseName: "起亚汽车", symbol: "KIAUSDT" },
  { code: "373220", name: "LG Energy Solution", chineseName: "LG新能源", symbol: "LGENERGYUSDT" },
  { code: "035720", name: "Kakao", chineseName: "卡考", symbol: "KAKAOUSDT" },
  { code: "105560", name: "KB Financial Group", chineseName: "KB金融集团", symbol: "KBFGUSDT" },
] as const;
const KOREAN_STOCKS = [...EXISTING_KOREAN_STOCKS, ...FUTU_KOREAN_STOCKS.map((stock) => ({ ...stock, bitgetSymbol: stock.symbol, binanceSymbol: null }))];
// ADR shares/ADS: TYOYY 0.25 (SEC F-6, Aug 2026), MRAAY 0.5 (Citi/BNY),
// TM 10 (Toyota SEC filing). The four additional OTC ratios below were checked
// against issuer/depositary records on 2026-10-23, including 2026 corporate actions.
// New Bitget perp/share units are inferred from
// contemporaneous contract index prices versus TSE and remain indicative.
const JAPANESE_STOCKS = [
  { code: "285A", name: "Kioxia", bitgetSymbol: "KIOXIAUSDT", sharesPerPerp: 1, adrSymbol: null, sharesPerAdr: null },
  { code: "5802", name: "Sumitomo Electric", bitgetSymbol: "SUMIELECUSDT", sharesPerPerp: 1, adrSymbol: "SMTOY", sharesPerAdr: 0.5, adrRatioSource: "Citi · current ORD:DR 1:2", adrRatioUrl: "https://depositaryreceipts.citi.com/adr/notices/pgm_dispCA.aspx?cusip=865617203&pageid=15&subpageID=113" },
  { code: "6758", name: "Sony Group", bitgetSymbol: "JPSONYUSDT", sharesPerPerp: 1, additionalBitgetSymbol: "SONYUSDT", additionalSharesPerPerp: 1, comparePerps: true, adrSymbol: "SONY", sharesPerAdr: 1 },
  { code: "6857", name: "Advantest", bitgetSymbol: "ADVANTESTUSDT", sharesPerPerp: 1, adrSymbol: "ATEYY", sharesPerAdr: 1, adrRatioSource: "Citi · ORD:DR 1:1", adrRatioUrl: "https://depositaryreceipts.citi.com/adr/guides/pgm_dispabook.aspx?cusip=00762U200&pageId=15&subpageID=111" },
  { code: "6920", name: "Lasertec", bitgetSymbol: "LASERTECUSDT", sharesPerPerp: 1, adrSymbol: "LSRCY", sharesPerAdr: 0.2, adrRatioSource: "Deutsche Bank · ORD:DR 1:5", adrRatioUrl: "https://adr.db.com/drwebrebrand/dr-universe/dr_details.html?identifier=11720" },
  { code: "6976", name: "Taiyo Yuden", bitgetSymbol: "TAIYOYUDENUSDT", sharesPerPerp: 1, adrSymbol: "TYOYY", sharesPerAdr: 0.25 },
  { code: "6981", name: "Murata Manufacturing", bitgetSymbol: "MURATAUSDT", sharesPerPerp: 1, adrSymbol: "MRAAY", sharesPerAdr: 0.5 },
  { code: "7203", name: "Toyota Motor", bitgetSymbol: "TOYOTAUSDT", sharesPerPerp: 1, additionalBitgetSymbol: "TMUSDT", additionalSharesPerPerp: 10, adrSymbol: "TM", sharesPerAdr: 10 },
  { code: "8035", name: "Tokyo Electron", bitgetSymbol: "TOKYOELUSDT", sharesPerPerp: 1, adrSymbol: "TELWY", sharesPerAdr: 0.5, adrRatioSource: "Tokyo Electron IR · current ticker TELWY · ADR:ORD 2:1", adrRatioUrl: "https://www.tel.com/ir/stocks/info/" },
  { code: "8306", name: "MUFG", bitgetSymbol: "JPMUFGUSDT", sharesPerPerp: 1, additionalBitgetSymbol: "MUFGUSDT", additionalSharesPerPerp: 1, comparePerps: true, adrSymbol: "MUFG", sharesPerAdr: 1 },
  { code: "9983", name: "Fast Retailing", chineseName: "迅销（优衣库母公司）", bitgetSymbol: "FASTRETAILINGUSDT", sharesPerPerp: 1, showPerpQuote: true, cashFeedPending: true, adrSymbol: null, sharesPerAdr: null },
  { code: "9984", name: "SoftBank Group", bitgetSymbol: "SOFTBANKUSDT", sharesPerPerp: 1, adrSymbol: null, sharesPerAdr: null },
] as const;
// Only request U.S. books actually carried by the office feed. Other mapped
// ADRs still get a contract-derived equivalent, without claiming a live ADR
// spread or creating new subscriptions / missing-feed warnings.
const ADR_SYMBOLS = ["SONY", "TM", "MUFG"];

// A known-unavailable new cash feed must not force healthy office books through
// remote OAuth or report a login failure. Monitor it once a real quote exists.
const expectedJapaneseCodes = (observed: ReadonlySet<string>) => JAPANESE_STOCKS
  .filter((stock) => !("cashFeedPending" in stock) || !stock.cashFeedPending || observed.has(stock.code))
  .map((stock) => stock.code);

type BinanceBook = { symbol?: string; bidPrice?: string; askPrice?: string; bidQty?: string; askQty?: string; time?: number };

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

type PushedQuote = { symbol?: string; bid?: number | null; ask?: number | null; last?: number | null; previousClose?: number | null; bidSize?: number | null; askSize?: number | null; marketTimestamp?: number; marketState?: string; source?: string };
type PushStore = typeof globalThis & { __FUTU_PUSH_SNAPSHOT__?: { payload: { quotes?: PushedQuote[] }; receivedAt: number } };
const QUOTE_MAX_AGE_MS = 60_000;
const DISPLAY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DAILY_FX_URL = "https://api.frankfurter.dev/v2/rate/usd/krw";
type DailyFx = { rate: number; date: string; fetchedAt: number };
let dailyFxCache: DailyFx | null = null;
let dailyFxRequest: Promise<DailyFx | null> | null = null;
let dailyFxFailedAt = 0;

async function dailyUsdKrw() {
  if (dailyFxCache && Date.now() - dailyFxCache.fetchedAt < 10 * 60_000) return dailyFxCache;
  if (Date.now() - dailyFxFailedAt < 60_000) return dailyFxCache;
  if (!dailyFxRequest) {
    dailyFxRequest = (async () => {
      const response = await fetch(DAILY_FX_URL, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
      if (!response.ok) throw new Error(`Daily USD/KRW HTTP ${response.status}`);
      const data = await response.json() as { date?: string; rate?: number };
      const rate = positive(data.rate);
      if (rate === null || !/^\d{4}-\d{2}-\d{2}$/.test(data.date ?? "")) throw new Error("Daily USD/KRW payload invalid");
      dailyFxCache = { rate, date: data.date!, fetchedAt: Date.now() };
      return dailyFxCache;
    })().catch(() => { dailyFxFailedAt = Date.now(); return dailyFxCache; }).finally(() => { dailyFxRequest = null; });
  }
  return dailyFxRequest;
}

const marketSessionFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const usSessionFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
function marketSession(market: "KRX" | "TSE", now: number) {
  const parts = marketSessionFormat.formatToParts(now);
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
  const parts = usSessionFormat.formatToParts(now);
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
    return [{ symbol: code, streamKey: `office:${quote.symbol}`, bid: positive(quote.bid), ask: positive(quote.ask), last: positive(quote.last), previousClose: positive(quote.previousClose), bidSize: positive(quote.bidSize), askSize: positive(quote.askSize), timestamp, marketState: quote.marketState ?? null, source: quote.source ?? (quote.symbol?.startsWith("US.") ? "Futu OpenD" : "Posley office relay") }];
  });
  if (!books.length) return null;
  const found = new Set(books.map((book) => book.symbol));
  const wanted = [...KOREAN_STOCKS.map((stock) => stock.code), ...expectedJapaneseCodes(found), ...(usSession(Date.now()) === "REGULAR" ? ADR_SYMBOLS : []), "USDKRW", "USDJPY"];
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
      ...(["OPENING AUCTION", "REGULAR"].includes(tseSession) ? [...expectedJapaneseCodes(new Set(office?.books.map((book) => book.symbol))), "USDJPY"] : []),
      ...(usSession(nowForSession) === "REGULAR" ? ADR_SYMBOLS : []),
    ];
    const officeFreshSymbols = new Set(office?.books.filter((book) => nowForSession - book.timestamp <= QUOTE_MAX_AGE_MS && book.timestamp - nowForSession < 5_000).map((book) => book.symbol));
    const officeCoversActiveMarkets = activeOfficeSymbols.every((symbol) => officeFreshSymbols.has(symbol));
    const remoteRequest = office && !suppliedIdToken && officeCoversActiveMarkets
      ? Promise.resolve({ configured: false, state: "idle", error: "", books: [], missing: [], timestamp: Date.now() })
      : posleyAdrSnapshot([...KOREAN_STOCKS.map((stock) => stock.code), ...JAPANESE_STOCKS.map((stock) => stock.code), ...ADR_SYMBOLS, "USDKRW", "USDJPY"], suppliedIdToken);
    const [remote, bitgetTickers, binancePayload] = await Promise.all([
      remoteRequest,
      bitgetBooksWithin(7_000),
      publicBinanceJson<BinanceBook[]>(BINANCE_BOOKS, 7_000),
    ]);

    const mergedBooks = new Map(remote.books.map((book) => [book.symbol, book]));
    office?.books.forEach((book) => {
      if ((mergedBooks.get(book.symbol)?.timestamp ?? 0) < book.timestamp) mergedBooks.set(book.symbol, book);
    });
    const wantedSymbols = [...KOREAN_STOCKS.map((stock) => stock.code), ...expectedJapaneseCodes(new Set(mergedBooks.keys())), ...(usSession(Date.now()) === "REGULAR" ? ADR_SYMBOLS : []), "USDKRW", "USDJPY"];
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
    const tickers = new Map(bitgetTickers.flatMap((ticker) => ticker.symbol ? [[ticker.symbol, ticker] as const] : []));
    const binanceBooks = new Map(binancePayload.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
    const fx = books.get("USDKRW");
    const fxBid = positive(fx?.bid);
    const fxAsk = positive(fx?.ask);
    const yenFx = books.get("USDJPY");
    const yenFxBid = positive(yenFx?.bid);
    const yenFxAsk = positive(yenFx?.ask);
    const now = Date.now();
    const fresh = (timestamp: number | null | undefined) => timestamp !== null && timestamp !== undefined && timestamp > 0 && now - timestamp <= QUOTE_MAX_AGE_MS && timestamp - now < 5_000;
    const liveKrwRate = fresh(fx?.timestamp) ? (fxBid !== null && fxAsk !== null ? (fxBid + fxAsk) / 2 : positive(fx?.last)) : null;
    const dailyKrwRate = liveKrwRate === null ? await dailyUsdKrw() : null;
    const krwRate = liveKrwRate ?? dailyKrwRate?.rate ?? null;
    const krwConversion = { rate: krwRate, source: liveKrwRate !== null ? "Posley USD/KRW live" : dailyKrwRate ? "Frankfurter daily reference" : "Unavailable", date: dailyKrwRate?.date ?? null, updatedAt: liveKrwRate !== null ? fx?.timestamp ?? null : dailyKrwRate?.fetchedAt ?? null, live: liveKrwRate !== null };
    const bitgetFx = tickers.get("USDJPYUSDT");
    const bitgetFxTime = positive(bitgetFx?.ts);
    const bitgetFxIndex = positive(bitgetFx?.indexPrice);
    const useBitgetFx = !fresh(yenFx?.timestamp) && fresh(bitgetFxTime) && bitgetFxIndex !== null;

    const rows = KOREAN_STOCKS.map((stock) => {
      const cash = books.get(stock.code);
      const cashSource = cash && "source" in cash ? String(cash.source) : cash?.streamKey?.includes("futu:web_api") ? "Posley Futu Web API" : "Posley IBKR";
      const cashBidKrw = positive(cash?.bid);
      const cashAskKrw = positive(cash?.ask);
      const cashSessionActive = sessions.KRX === "REGULAR" || sessions.KRX === "AFTER-HOURS";
      const strictCashBook = "strictCashBook" in stock && stock.strictCashBook;
      const { cashBidUsd, cashAskUsd } = equityBasis(cash ?? {}, fx ?? {}, 1, !cashSessionActive, strictCashBook);
      const venues = [
        stock.bitgetSymbol ? (() => { const quote = tickers.get(stock.bitgetSymbol); return { venue: "Bitget", symbol: stock.bitgetSymbol, bid: positive(quote?.bidPr), ask: positive(quote?.askPr), bidQty: positive(quote?.bidSz), askQty: positive(quote?.askSz), updatedAt: positive(quote?.ts) }; })() : null,
        stock.binanceSymbol ? (() => { const quote = binanceBooks.get(stock.binanceSymbol); return { venue: "Binance", symbol: stock.binanceSymbol, bid: positive(quote?.bidPrice), ask: positive(quote?.askPrice), bidQty: positive(quote?.bidQty), askQty: positive(quote?.askQty), updatedAt: positive(quote?.time) }; })() : null,
      ].flatMap((venue) => venue ? [{
        ...venue,
        ...equitySpreads(cashBidUsd, cashAskUsd, venue),
      }] : []);
      return {
        code: stock.code, name: stock.name, chineseName: "chineseName" in stock ? stock.chineseName : null,
        cashSource,
        cashFeedSession: cash?.marketState ?? null,
        previousClose: koreanLatestClose(stock.code, now),
        market: "KRX", session: sessions.KRX, currency: "KRW", sharesPerPerp: 1, venues, strictCashBook,
        mappingNote: stock.code === "0158S0" ? "Elice · KOSDAQ 0158S0 · Posley IBKR orderbook. Missing bid/ask sides stay unavailable; last trades never substitute for a missing side. Cash/perp unit assumes one ordinary share."
          : stock.code === "042700" ? "Binance HANMIUSDT is the exact 042700 contract. Bitget HANMIUSDT is Hanmi Pharm, so it is deliberately excluded." : null,
        cashBidKrw, cashAskKrw, cashBidQty: positive(cash?.bidSize), cashAskQty: positive(cash?.askSize), cashUpdatedAt: cash?.timestamp ?? null,
        cashLast: positive(cash?.last),
        cashBidUsd, cashAskUsd,
      };
    });

    // Keep the response field for older clients; no separate conversion-only area.
    const bitgetOnlyKorean: never[] = [];

    const japanRows = JAPANESE_STOCKS.map((stock) => {
      const cash = books.get(stock.code);
      const cashBidKrw = positive(cash?.bid);
      const cashAskKrw = positive(cash?.ask);
      const basisFx = useBitgetFx ? { last: bitgetFxIndex } : yenFx ?? {};
      const { cashBidUsd, cashAskUsd } = equityBasis(cash ?? {}, basisFx, stock.sharesPerPerp,
        preferCashLast("TSE", sessions.TSE, cash?.timestamp, now));
      const contracts = [{ symbol: stock.bitgetSymbol, sharesPerPerp: stock.sharesPerPerp },
        ...("additionalBitgetSymbol" in stock ? [{ symbol: stock.additionalBitgetSymbol, sharesPerPerp: stock.additionalSharesPerPerp }] : [])];
      const adr = stock.adrSymbol ? books.get(stock.adrSymbol) : null;
      return {
        code: stock.code, name: stock.name, chineseName: "chineseName" in stock ? stock.chineseName : null,
        showPerpQuote: "showPerpQuote" in stock && stock.showPerpQuote,
        market: "TSE", session: sessions.TSE, currency: "JPY", sharesPerPerp: stock.sharesPerPerp,
        perpPair: "comparePerps" in stock ? { leftSymbol: stock.bitgetSymbol, rightSymbol: stock.additionalBitgetSymbol } : null,
        mappingNote: stock.code === "7203" ? "Comparison assumes TOYOTAUSDT is priced per ordinary share and TMUSDT per ADR-equivalent (10 ordinary shares), consistent with their quoted prices. Confirm Bitget contract specifications before trading."
          : "comparePerps" in stock ? "Bitget JP and ADR-linked perps are compared in USDT using a 1:1 contract-unit mapping, consistent with current index prices and the 1:1 ADR/share ratio. This is perp/perp basis, not a live ADR quote; funding and dividend adjustments may differ."
          : stock.code === "9983" ? `${cash ? "" : "Waiting for the Posley TSE 9983 cash feed; Bitget prices are not cash-stock quotes. "}Cash comparison assumes one ordinary share per Bitget contract unit. Confirm contract specifications before trading.`
          : stock.code === "6976" || stock.code === "6981" || "adrRatioUrl" in stock ? "Comparison assumes one Bitget contract unit tracks one TSE ordinary share, consistent with the current index price. Confirm Bitget contract specifications before trading." : null,
        cashBidKrw, cashAskKrw, cashBidQty: positive(cash?.bidSize), cashAskQty: positive(cash?.askSize), cashUpdatedAt: cash?.timestamp ?? null,
        cashLast: positive(cash?.last),
        cashBidUsd, cashAskUsd,
        adr: stock.adrSymbol ? { symbol: stock.adrSymbol, sharesPerAdr: stock.sharesPerAdr, source: !adr ? "No live ADR feed" : "source" in adr ? String(adr.source) : "Posley IBKR", marketState: adr && "marketState" in adr ? adr.marketState : null,
          ratioSource: "adrRatioSource" in stock ? stock.adrRatioSource : null, ratioSourceUrl: "adrRatioUrl" in stock ? stock.adrRatioUrl : null, ratioVerifiedOn: "adrRatioUrl" in stock ? "2026-10-23" : null,
          bid: positive(adr?.bid), ask: positive(adr?.ask), last: positive(adr?.last), bidQty: positive(adr?.bidSize), askQty: positive(adr?.askSize), updatedAt: adr?.timestamp ?? null,
        } : null,
        venues: contracts.map(({ symbol, sharesPerPerp }) => {
          const quote = tickers.get(symbol);
          const bid = positive(quote?.bidPr); const ask = positive(quote?.askPr);
          const contractBasis = equityBasis(cash ?? {}, basisFx, sharesPerPerp,
            preferCashLast("TSE", sessions.TSE, cash?.timestamp, now));
          return { venue: "Bitget", symbol, sharesPerPerp, bid, ask, bidQty: positive(quote?.bidSz), askQty: positive(quote?.askSz), updatedAt: positive(quote?.ts),
            ...equitySpreads(contractBasis.cashBidUsd, contractBasis.cashAskUsd, { bid, ask }) };
        }),
      };
    });

    return Response.json({
      rows: [...rows, ...japanRows],
      bitgetOnlyKorean,
      krwConversion,
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
