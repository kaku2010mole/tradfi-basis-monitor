const BINANCE_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];
const TIMEOUT_MS = 5_000;

type HyperLevel = { px?: string; sz?: string };
type HyperBook = { coin?: string; time?: number; levels?: [HyperLevel[], HyperLevel[]] };
type BinanceBook = { symbol?: string; bidPrice?: string; askPrice?: string; bidQty?: string; askQty?: string; time?: number };

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const validHyperCoin = (value: string | null) => {
  const coin = value?.trim();
  return coin && /^[A-Za-z0-9_.:-]{1,40}$/.test(coin) ? coin : null;
};

const validBinanceSymbol = (value: string | null) => {
  const symbol = value?.trim().toUpperCase();
  return symbol && /^[A-Z0-9_]{3,32}USDT$/.test(symbol) ? symbol : null;
};

async function fetchHyperliquid(coin: string) {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  const book = await response.json() as HyperBook;
  const bid = positive(book.levels?.[0]?.[0]?.px);
  const ask = positive(book.levels?.[1]?.[0]?.px);
  if (bid === null || ask === null) throw new Error(`${coin}: Hyperliquid BBO unavailable.`);
  return {
    coin: book.coin ?? coin,
    bid,
    ask,
    bidSize: positive(book.levels?.[0]?.[0]?.sz),
    askSize: positive(book.levels?.[1]?.[0]?.sz),
    timestamp: Number.isFinite(Number(book.time)) ? Number(book.time) : Date.now(),
  };
}

async function fetchBinance(symbol: string) {
  let lastError = `${symbol}: Binance BBO unavailable.`;
  for (const host of BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const book = await response.json() as BinanceBook;
      const bid = positive(book.bidPrice);
      const ask = positive(book.askPrice);
      if (bid === null || ask === null) throw new Error("incomplete BBO");
      return {
        symbol,
        bid,
        ask,
        bidSize: positive(book.bidQty),
        askSize: positive(book.askQty),
        timestamp: Date.now(),
      };
    } catch (error) {
      lastError = `${symbol}: ${error instanceof Error ? error.message : "Binance BBO unavailable."}`;
    }
  }
  throw new Error(lastError);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const hyperCoin = validHyperCoin(url.searchParams.get("hyper"));
  const binanceSymbol = validBinanceSymbol(url.searchParams.get("binance"));
  const multiplier = positive(url.searchParams.get("multiplier") ?? "1");
  if (!hyperCoin || !binanceSymbol || multiplier === null || multiplier > 100_000) {
    return Response.json({ error: "Invalid Hyperliquid coin, Binance symbol, or price multiplier." }, { status: 400 });
  }

  const settled = await Promise.allSettled([fetchHyperliquid(hyperCoin), fetchBinance(binanceSymbol)]);
  if (settled[0].status === "rejected" || settled[1].status === "rejected") {
    const errors = settled.flatMap((result) => result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : "Market data unavailable."]
      : []);
    return Response.json({ error: errors.join(" · ") }, { status: 502 });
  }
  const hyperliquid = settled[0].value;
  const binance = settled[1].value;
  const adjustedBinanceBid = binance.bid * multiplier;
  const adjustedBinanceAsk = binance.ask * multiplier;
  const shortHyperLongBinance = (hyperliquid.bid / adjustedBinanceAsk - 1) * 100;
  const longHyperShortBinance = (adjustedBinanceBid / hyperliquid.ask - 1) * 100;

  return Response.json({
    hyperliquid,
    binance,
    multiplier,
    spreads: { shortHyperLongBinance, longHyperShortBinance },
    timestamp: Date.now(),
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
