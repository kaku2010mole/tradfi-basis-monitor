const TIMEOUT_MS = 5_000;

type HyperLevel = { px?: string; sz?: string };
type HyperBook = { coin?: string; time?: number; levels?: [HyperLevel[], HyperLevel[]] };

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const validCoin = (value: string | null) => {
  const coin = value?.trim();
  return coin && /^[A-Za-z0-9_.:-]{1,40}$/.test(coin) ? coin : null;
};

async function fetchBook(coin: string) {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${coin}: Hyperliquid HTTP ${response.status}`);
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

const minLiquidity = (left: number | null, right: number | null) => left === null || right === null ? null : Math.min(left, right);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const coinA = validCoin(url.searchParams.get("coinA"));
  const coinB = validCoin(url.searchParams.get("coinB"));
  const requestedRatio = url.searchParams.get("fairRatio");
  const suppliedRatio = requestedRatio && requestedRatio !== "auto" ? positive(requestedRatio) : null;
  if (!coinA || !coinB || coinA === coinB || (requestedRatio !== "auto" && requestedRatio !== null && suppliedRatio === null)) {
    return Response.json({ error: "Choose two different Hyperliquid perp coins and a positive fair ratio." }, { status: 400 });
  }

  const settled = await Promise.allSettled([fetchBook(coinA), fetchBook(coinB)]);
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
