const HYPERTRACKER_BASE = "https://ht-api.coinmarketman.com";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const REQUEST_TIMEOUT_MS = 12_000;

type HyperMeta = { universe?: Array<{ name?: string }> };
type HyperContext = { oraclePx?: string; markPx?: string };
type HypertrackerBin = {
  coin?: string;
  priceBinStart?: number;
  priceBinEnd?: number;
  liquidationValue?: number;
  positionsCount?: number;
  mostImpactedSegment?: number;
};
type HypertrackerPayload = { coin?: string; heatmap?: HypertrackerBin[] };

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const normalizeSymbol = (value: string | null) => {
  const clean = (value || "para:OTHERS").trim();
  const normalized = clean.toLowerCase() === "para:btc.d" ? "para:BTCD" : clean;
  return /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(normalized) && normalized.length <= 64
    ? normalized
    : null;
};

async function fetchCurrentPrice(symbol: string) {
  const separator = symbol.indexOf(":");
  const dex = separator > 0 ? symbol.slice(0, separator) : null;
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" }),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  const [meta, contexts] = await response.json() as [HyperMeta, HyperContext[]];
  const index = meta.universe?.findIndex((asset) => asset.name === symbol) ?? -1;
  const context = index >= 0 ? contexts[index] : undefined;
  return { oracle: positive(context?.oraclePx), mark: positive(context?.markPx) };
}

export async function GET(request: Request) {
  const symbol = normalizeSymbol(new URL(request.url).searchParams.get("symbol"));
  if (!symbol) return Response.json({ error: "Invalid Hyperliquid symbol." }, { status: 400 });
  const token = process.env.HYPERTRACKER_API_KEY;
  if (!token) return Response.json({ error: "HyperTracker is not configured on this deployment." }, { status: 503 });

  try {
    const [heatmapResponse, priceResult] = await Promise.all([
      fetch(`${HYPERTRACKER_BASE}/api/external/exports/coins/${encodeURIComponent(symbol)}/liquidation-heatmap`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      fetchCurrentPrice(symbol).then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const }),
      ),
    ]);
    if (!heatmapResponse.ok) {
      const unavailable = heatmapResponse.status === 404 ? `No HyperTracker liquidation map exists for ${symbol}.` : "HyperTracker liquidation data is temporarily unavailable.";
      return Response.json({ error: unavailable }, { status: heatmapResponse.status === 404 ? 404 : 502 });
    }
    const payload = await heatmapResponse.json() as HypertrackerPayload;
    const price = priceResult.status === "fulfilled" ? priceResult.value : { oracle: null, mark: null };
    const reference = price.oracle ?? price.mark;
    const levels = (payload.heatmap ?? []).flatMap((bin) => {
      const start = positive(bin.priceBinStart);
      const end = positive(bin.priceBinEnd);
      const valueUsd = positive(bin.liquidationValue);
      if (start === null || end === null || valueUsd === null || end <= start) return [];
      const levelPrice = (start + end) / 2;
      return [{
        priceStart: start,
        priceEnd: end,
        price: levelPrice,
        valueUsd,
        positions: Math.max(0, Number(bin.positionsCount) || 0),
        side: reference === null ? "unknown" as const : levelPrice < reference ? "long" as const : "short" as const,
        segment: Number.isFinite(Number(bin.mostImpactedSegment)) ? Number(bin.mostImpactedSegment) : null,
      }];
    });
    if (!levels.length) return Response.json({ error: `No active liquidation levels are available for ${symbol}.` }, { status: 404 });

    return Response.json({
      symbol,
      displaySymbol: symbol === "para:BTCD" ? "para:BTC.D" : symbol,
      t: Date.now(),
      oracle: price.oracle,
      mark: price.mark,
      levels,
      source: "HyperTracker",
      exact: true,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch {
    return Response.json({ error: "HyperTracker liquidation data is temporarily unavailable." }, { status: 502 });
  }
}
