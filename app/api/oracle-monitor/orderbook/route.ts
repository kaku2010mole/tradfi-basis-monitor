const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const PARA_SYMBOLS = ["para:OTHERS", "para:TOTAL2", "para:BTCD"] as const;
const FETCH_TIMEOUT_MS = 6_000;
const RETRY_DELAYS_MS = [0, 180, 520];

type HyperMeta = { universe?: Array<{ name?: string }> };
type HyperContext = { oraclePx?: string; markPx?: string };
type HyperLevel = { px?: string; sz?: string; n?: number };
type HyperBook = { coin?: string; time?: number; levels?: [HyperLevel[], HyperLevel[]] };

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchHyper<T>(body: Record<string, unknown>) {
  let lastError: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await wait(delay);
    try {
      const response = await fetch(HYPERLIQUID_INFO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Hyperliquid orderbook request failed.");
}

export async function GET() {
  const [contextResult, bookResults] = await Promise.all([
    Promise.resolve(fetchHyper<[HyperMeta, HyperContext[]]>({ type: "metaAndAssetCtxs", dex: "para" })).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    ),
    Promise.allSettled(PARA_SYMBOLS.map((coin) => fetchHyper<HyperBook>({ type: "l2Book", coin }))),
  ]);

  const contextBySymbol = new Map<string, HyperContext>();
  if (contextResult.status === "fulfilled") {
    const [meta, contexts] = contextResult.value;
    meta.universe?.forEach((asset, index) => {
      if (asset.name && contexts[index]) contextBySymbol.set(asset.name, contexts[index]);
    });
  }

  const books = PARA_SYMBOLS.flatMap((apiSymbol, index) => {
    const result = bookResults[index];
    if (result?.status !== "fulfilled") return [];
    const book = result.value;
    const context = contextBySymbol.get(apiSymbol);
    const oracle = positive(context?.oraclePx);
    const mark = positive(context?.markPx);
    const levels = [
      ...(book.levels?.[0] ?? []).flatMap((level) => {
        const price = positive(level.px);
        const size = positive(level.sz);
        return price === null || size === null ? [] : [{ side: "bid" as const, price, size, orders: level.n ?? null }];
      }),
      ...(book.levels?.[1] ?? []).flatMap((level) => {
        const price = positive(level.px);
        const size = positive(level.sz);
        return price === null || size === null ? [] : [{ side: "ask" as const, price, size, orders: level.n ?? null }];
      }),
    ];
    if (!levels.length) return [];
    return [{
      apiSymbol,
      symbol: apiSymbol === "para:BTCD" ? "para:BTC.D" : apiSymbol,
      time: Number.isFinite(Number(book.time)) ? Number(book.time) : Date.now(),
      oracle,
      mark,
      levels,
    }];
  });

  if (!books.length) {
    return Response.json({ error: "Para orderbooks are temporarily unavailable." }, { status: 502 });
  }

  return Response.json({
    books,
    requested: PARA_SYMBOLS.length,
    timestamp: Math.max(...books.map((book) => book.time)),
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
