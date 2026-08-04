import { tradeTokenFromRequest, verifyTradeToken } from "../../../lib/tradeAuth";

const BINANCE_API = "https://fapi.binance.com";
const SYMBOL_PATTERN = /^[A-Z0-9_]{2,32}$/;

type ExchangeFilter = {
  filterType: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  notional?: string;
};
type ExchangeSymbol = {
  symbol: string;
  status: string;
  filters: ExchangeFilter[];
};

const finite = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export async function GET(request: Request) {
  if (!await verifyTradeToken(tradeTokenFromRequest(request))) return Response.json({ error: "Trading access required." }, { status: 401 });
  const symbol = (new URL(request.url).searchParams.get("symbol") ?? "").toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) return Response.json({ error: "Invalid Binance Futures symbol." }, { status: 400 });
  try {
    const [premiumResponse, bookResponse, exchangeResponse, timeResponse] = await Promise.all([
      fetch(`${BINANCE_API}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" }),
      fetch(`${BINANCE_API}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" }),
      fetch(`${BINANCE_API}/fapi/v1/exchangeInfo`, { cache: "no-store" }),
      fetch(`${BINANCE_API}/fapi/v1/time`, { cache: "no-store" }),
    ]);
    if (!premiumResponse.ok || !bookResponse.ok || !exchangeResponse.ok || !timeResponse.ok) throw new Error("Binance market metadata unavailable.");
    const premium = await premiumResponse.json() as { indexPrice?: string; markPrice?: string };
    const book = await bookResponse.json() as { bidPrice?: string; bidQty?: string; askPrice?: string; askQty?: string; time?: number };
    const exchange = await exchangeResponse.json() as { symbols?: ExchangeSymbol[] };
    const serverTime = Number((await timeResponse.json() as { serverTime?: number }).serverTime);
    const instrument = exchange.symbols?.find((item) => item.symbol === symbol);
    if (!instrument || instrument.status !== "TRADING") return Response.json({ error: `${symbol} is not currently trading.` }, { status: 400 });
    const priceFilter = instrument.filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const lotFilter = instrument.filters.find((filter) => filter.filterType === "LOT_SIZE");
    const minNotional = instrument.filters.find((filter) => filter.filterType === "MIN_NOTIONAL");
    const oracle = finite(premium.indexPrice);
    const mark = finite(premium.markPrice);
    const bid = finite(book.bidPrice);
    const bidQty = finite(book.bidQty);
    const ask = finite(book.askPrice);
    const askQty = finite(book.askQty);
    if (oracle === null || mark === null || bid === null || ask === null) throw new Error("Incomplete Binance market response.");
    return Response.json({
      symbol,
      oracle,
      mark,
      bid,
      bidQty,
      ask,
      askQty,
      serverTime: Number.isFinite(serverTime) ? serverTime : Date.now(),
      updatedAt: book.time ?? Date.now(),
      filters: {
        minPrice: finite(priceFilter?.minPrice),
        maxPrice: finite(priceFilter?.maxPrice),
        tickSize: finite(priceFilter?.tickSize),
        minQty: finite(lotFilter?.minQty),
        maxQty: finite(lotFilter?.maxQty),
        stepSize: finite(lotFilter?.stepSize),
        minNotional: finite(minNotional?.notional),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Binance market unavailable." }, { status: 502 });
  }
}
