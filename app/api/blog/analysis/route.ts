import {
  fixedTrainingWindow,
  MAX_OBSERVATION_MS,
  PricePoint,
  projectRelationship,
  RELATIONSHIPS,
  Relationship,
  TRAINING_INTERVAL,
  trainRelationshipModel,
  TrainedModel,
} from "../../../lib/relativeValue";

const BINANCE_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string];
type HyperCandle = { t?: number; c?: string };
type ExchangeInfo = { symbols?: Array<{ symbol?: string; status?: string; underlyingType?: string; underlyingSubType?: string[] }> };

const modelCache = new Map<string, Promise<TrainedModel>>();
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchBinance<T>(path: string) {
  let lastError: unknown;
  for (const host of BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      await wait(80);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Binance market data unavailable.");
}

const observationInterval = (durationMs: number) => durationMs <= 6 * 60 * 60_000 ? "1m"
  : durationMs <= 24 * 60 * 60_000 ? "5m"
    : "15m";

async function getSeries(leg: Relationship["asset1"], start: number, end: number, interval: string): Promise<PricePoint[]> {
  if (leg.venue === "binance") {
    const params = new URLSearchParams({ symbol: leg.symbol, interval, startTime: String(start), endTime: String(end), limit: "1500" });
    const rows = await fetchBinance<BinanceKline[]>(`/fapi/v1/klines?${params}`);
    return rows.flatMap((row) => {
      const value = Number(row[4]);
      return Number.isFinite(value) && value > 0 ? [{ t: row[0], value }] : [];
    });
  }
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: leg.symbol, interval, startTime: start, endTime: end } }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  const rows = await response.json() as HyperCandle[];
  return rows.flatMap((row) => {
    const time = Number(row.t);
    const value = Number(row.c);
    return Number.isFinite(time) && Number.isFinite(value) && value > 0 ? [{ t: time, value }] : [];
  });
}

async function getFixedModel(relationship: Relationship, now: number) {
  const { trainingStart, trainingEnd } = fixedTrainingWindow(now);
  const key = `${relationship.id}:${trainingEnd}`;
  const cached = modelCache.get(key);
  if (cached) return cached;
  const model = Promise.all([
    getSeries(relationship.asset1, trainingStart, trainingEnd, TRAINING_INTERVAL),
    getSeries(relationship.asset2, trainingStart, trainingEnd, TRAINING_INTERVAL),
  ]).then(([asset1Rows, asset2Rows]) => trainRelationshipModel(asset1Rows, asset2Rows, relationship, trainingStart, trainingEnd));
  for (const cachedKey of modelCache.keys()) {
    if (!cachedKey.endsWith(`:${trainingEnd}`)) modelCache.delete(cachedKey);
  }
  modelCache.set(key, model);
  model.catch(() => modelCache.delete(key));
  return model;
}

async function scanUniverse() {
  const payload = await fetchBinance<ExchangeInfo>("/fapi/v1/exchangeInfo");
  const symbols = (payload.symbols ?? []).filter((item) => item.status === "TRADING" && item.underlyingSubType?.some((tag) => tag.toLowerCase() === "tradfi"));
  const active = new Set(symbols.map((item) => item.symbol).filter(Boolean) as string[]);
  const typeCounts = symbols.reduce<Record<string, number>>((counts, item) => {
    const type = item.underlyingType || "OTHER";
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
  return {
    count: symbols.length,
    symbols: [...active].sort(),
    typeCounts,
    candidates: RELATIONSHIPS.map((relationship) => ({
      id: relationship.id,
      available: [relationship.asset1, relationship.asset2].every((leg) => leg.venue === "hyperliquid" || active.has(leg.symbol)),
    })),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const now = Date.now();
  const relationship = RELATIONSHIPS.find((item) => item.id === (url.searchParams.get("relationship") || "qqq-ustech"));
  const end = Math.min(Number(url.searchParams.get("end") || now), now);
  const start = Number(url.searchParams.get("start") || end - 24 * 60 * 60_000);
  if (!relationship) return Response.json({ error: "Unknown relationship." }, { status: 400 });
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || start >= end || end - start > MAX_OBSERVATION_MS + 60_000 || start < now - MAX_OBSERVATION_MS - 5 * 60_000) {
    return Response.json({ error: "Choose an observation window within the most recent three days." }, { status: 400 });
  }
  const interval = observationInterval(end - start);
  try {
    const [model, asset1Rows, asset2Rows, universe] = await Promise.all([
      getFixedModel(relationship, now),
      getSeries(relationship.asset1, start, end, interval),
      getSeries(relationship.asset2, start, end, interval),
      scanUniverse().catch(() => null),
    ]);
    const projection = projectRelationship(asset1Rows, asset2Rows, model);
    return Response.json({
      generatedAt: Date.now(),
      interval,
      observation: { start, end, maxDurationMs: MAX_OBSERVATION_MS },
      relationship,
      relationships: RELATIONSHIPS,
      universe,
      model,
      ...projection,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Relative-value prediction is temporarily unavailable.",
      relationships: RELATIONSHIPS,
    }, { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
