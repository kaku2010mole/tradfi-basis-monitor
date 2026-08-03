const BINANCE_FUTURES_API = "https://fapi.binance.com";
const SYMBOLS = ["HK1810USDT", "HK0700USDT", "TENCENTUSDT"] as const;

type BookTicker = {
  symbol: string;
  bidPrice: string;
  askPrice: string;
  time?: number;
};

type PremiumIndex = {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  time?: number;
};

async function getQuote(symbol: typeof SYMBOLS[number]) {
  const [bookResponse, premiumResponse] = await Promise.all([
    fetch(`${BINANCE_FUTURES_API}/fapi/v1/ticker/bookTicker?symbol=${symbol}`, { cache: "no-store" }),
    fetch(`${BINANCE_FUTURES_API}/fapi/v1/premiumIndex?symbol=${symbol}`, { cache: "no-store" }),
  ]);

  if (!bookResponse.ok || !premiumResponse.ok) {
    throw new Error(`${symbol} live or oracle price request failed.`);
  }

  const book = await bookResponse.json() as BookTicker;
  const premium = await premiumResponse.json() as PremiumIndex;
  const bid = Number(book.bidPrice);
  const ask = Number(book.askPrice);
  const oracle = Number(premium.indexPrice);
  const mark = Number(premium.markPrice);

  if (![bid, ask, oracle, mark].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(`${symbol} returned an incomplete price response.`);
  }

  const live = (bid + ask) / 2;
  return {
    symbol,
    bid,
    ask,
    live,
    oracle,
    mark,
    deviation: (live / oracle - 1) * 100,
    updatedAt: Math.max(book.time ?? 0, premium.time ?? 0, Date.now()),
  };
}

export async function GET() {
  try {
    const quotes = await Promise.all(SYMBOLS.map(getQuote));
    return Response.json(
      { quotes, timestamp: Math.max(...quotes.map((quote) => quote.updatedAt)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to load live and oracle prices." },
      { status: 502 },
    );
  }
}
