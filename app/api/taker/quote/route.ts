const TIMEOUT_MS = 5_000;

type HyperLevel = { px?: string; sz?: string };
type HyperBook = { coin?: string; time?: number; levels?: [HyperLevel[], HyperLevel[]] };
type MarketType = "perp" | "spot";
type SpotMeta = {
  tokens?: Array<{ name?: string; index?: number; szDecimals?: number }>;
  universe?: Array<{ name?: string; index?: number; tokens?: [number, number] }>;
};

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const validCoin = (value: string | null) => {
  const coin = value?.trim();
  return coin && /^[A-Za-z0-9_.:-]{1,40}$/.test(coin) ? coin : null;
};

const validMarketType = (value: string | null): MarketType | null => value === "spot" ? "spot" : value === "perp" || value === null ? "perp" : null;

async function resolveSpotCoin(symbol: string) {
  const metaResponse = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!metaResponse.ok) throw new Error(`Spot metadata HTTP ${metaResponse.status}`);
  const meta = await metaResponse.json() as SpotMeta;
  const tokenByIndex = new Map((meta.tokens ?? []).flatMap((token) => Number.isInteger(token.index) ? [[Number(token.index), token] as const] : []));
  const requested = symbol.toUpperCase();
  const market = (meta.universe ?? []).find((item) => {
    const base = tokenByIndex.get(Number(item.tokens?.[0]))?.name ?? "";
    const quote = tokenByIndex.get(Number(item.tokens?.[1]))?.name ?? "";
    return item.name?.toUpperCase() === requested || `@${item.index}`.toUpperCase() === requested
      || `${base}/${quote}`.toUpperCase() === requested
      || (!requested.includes("/") && base.toUpperCase() === requested && quote.toUpperCase() === "USDC");
  });
  const base = tokenByIndex.get(Number(market?.tokens?.[0]));
  const quote = tokenByIndex.get(Number(market?.tokens?.[1]));
  if (!market || !Number.isInteger(market.index) || !base?.name || !quote?.name) throw new Error(`${symbol}: Hyperliquid spot market was not found.`);
  if (quote.name.toUpperCase() !== "USDC") throw new Error(`${symbol}: only USDC-quoted spot markets are supported for USD-neutral DCA.`);
  return market.name || `@${market.index}`;
}

async function fetchBook(coin: string, marketType: MarketType) {
  const bookCoin = marketType === "spot" ? await resolveSpotCoin(coin) : coin;
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin: bookCoin }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${coin}: Hyperliquid HTTP ${response.status}`);
  const book = await response.json() as HyperBook;
  const bid = positive(book.levels?.[0]?.[0]?.px);
  const ask = positive(book.levels?.[1]?.[0]?.px);
  if (bid === null || ask === null) throw new Error(`${coin}: Hyperliquid BBO unavailable.`);
  return {
    coin,
    bookCoin: book.coin ?? bookCoin,
    marketType,
    bid,
    ask,
    bidSize: positive(book.levels?.[0]?.[0]?.sz),
    askSize: positive(book.levels?.[1]?.[0]?.sz),
    timestamp: Number.isFinite(Number(book.time)) ? Number(book.time) : Date.now(),
  };
}

const minLiquidity = (left: number | null, right: number | null) => left === null || right === null ? null : Math.min(left, right);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const coinA = validCoin(url.searchParams.get("coinA"));
  const coinB = validCoin(url.searchParams.get("coinB"));
  const typeA = validMarketType(url.searchParams.get("typeA"));
  const typeB = validMarketType(url.searchParams.get("typeB"));
  const requestedRatio = url.searchParams.get("fairRatio");
  const suppliedRatio = requestedRatio && requestedRatio !== "auto" ? positive(requestedRatio) : null;
  if (!coinA || !coinB || !typeA || !typeB || (coinA === coinB && typeA === typeB) || (requestedRatio !== "auto" && requestedRatio !== null && suppliedRatio === null)) {
    return Response.json({ error: "Choose two different Hyperliquid markets and a positive fair ratio." }, { status: 400 });
  }

  const settled = await Promise.allSettled([fetchBook(coinA, typeA), fetchBook(coinB, typeB)]);
  if (settled[0].status === "rejected" || settled[1].status === "rejected") {
    const errors = settled.flatMap((result) => result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : "Hyperliquid market data unavailable."]
      : []);
    return Response.json({ error: errors.join(" · ") }, { status: 502 });
  }

  const legA = settled[0].value;
  const legB = settled[1].value;
  const midA = (legA.bid + legA.ask) / 2;
  const midB = (legB.bid + legB.ask) / 2;
  const fairRatio = suppliedRatio ?? midA / midB;
  const shortALongB = (legA.bid / (legB.ask * fairRatio) - 1) * 100;
  const longAShortB = (legB.bid * fairRatio / legA.ask - 1) * 100;

  return Response.json({
    legA,
    legB,
    fairRatio,
    spreads: { shortALongB, longAShortB },
    liquidityUsd: {
      shortALongB: minLiquidity(legA.bidSize === null ? null : legA.bidSize * legA.bid, legB.askSize === null ? null : legB.askSize * legB.ask),
      longAShortB: minLiquidity(legA.askSize === null ? null : legA.askSize * legA.ask, legB.bidSize === null ? null : legB.bidSize * legB.bid),
    },
    timestamp: Date.now(),
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
