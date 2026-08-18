import {
  fixedTrainingWindow,
  MAX_OBSERVATION_MS,
  maxObservationMs,
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

const observationInterval = (start: number, end: number) => end - start > MAX_OBSERVATION_MS ? "5m" : "1m";
const INTERVAL_MS: Record<string, number> = { "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000 };

async function getSeries(leg: Relationship["asset1"], start: number, end: number, interval: string): Promise<PricePoint[]> {
  if (leg.venue === "binance") {
    const rows: BinanceKline[] = [];
    const step = INTERVAL_MS[interval] ?? 60_000;
    let cursor = start;
    while (cursor <= end && rows.length < 5_000) {
      const params = new URLSearchParams({ symbol: leg.symbol, interval, startTime: String(cursor), endTime: String(end), limit: "1500" });
      const page = await fetchBinance<BinanceKline[]>(`/fapi/v1/klines?${params}`);
      if (!page.length) break;
      rows.push(...page);
      const next = page.at(-1)![0] + step;
      if (page.length < 1_500 || next <= cursor) break;
      cursor = next;
    }
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
  const trainingSeries = (leg: Relationship["asset1"]) => getSeries(leg, trainingStart, trainingEnd, TRAINING_INTERVAL).catch((error) => {
    if (relationship.referenceBeta !== null) return [];
    throw error;
  });
  const model = Promise.all([
    trainingSeries(relationship.asset1),
    trainingSeries(relationship.asset2),
  ]).then(([asset1Rows, asset2Rows]) => trainRelationshipModel(asset1Rows, asset2Rows, relationship, trainingStart, trainingEnd));
  for (const cachedKey of modelCache.keys()) {
    if (!cachedKey.endsWith(`:${trainingEnd}`)) modelCache.delete(cachedKey);
  }
  modelCache.set(key, model);
  model.catch(() => modelCache.delete(key));
  return model;
}

async function scanUniverse(relationships: Relationship[]) {
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
    candidates: relationships.map((relationship) => ({
      id: relationship.id,
      available: [relationship.asset1, relationship.asset2].every((leg) => leg.venue === "hyperliquid" || active.has(leg.symbol)),
    })),
  };
}

const BINANCE_SYMBOL = /^[A-Z0-9_]{2,32}$/;
const HYPERLIQUID_SYMBOL = /^[A-Z0-9._:-]{2,40}$/i;

function customRelationship(url: URL): Relationship | null {
  const id = url.searchParams.get("relationship") || "";
  if (!/^custom-[a-z0-9-]{4,32}$/i.test(id)) return null;
  const asset1Venue = url.searchParams.get("asset1Venue") === "hyperliquid" ? "hyperliquid" : "binance";
  const asset2Venue = url.searchParams.get("asset2Venue") === "hyperliquid" ? "hyperliquid" : "binance";
  const asset1Symbol = url.searchParams.get("asset1Symbol") || "";
  const asset2Symbol = url.searchParams.get("asset2Symbol") || "";
  const validAsset1 = (asset1Venue === "binance" ? BINANCE_SYMBOL : HYPERLIQUID_SYMBOL).test(asset1Symbol);
  const validAsset2 = (asset2Venue === "binance" ? BINANCE_SYMBOL : HYPERLIQUID_SYMBOL).test(asset2Symbol);
  if (!validAsset1 || !validAsset2) return null;
  const betaValue = url.searchParams.get("referenceBeta");
  const parsedBeta = betaValue === null || betaValue === "" ? null : Number(betaValue);
  if (parsedBeta !== null && (!Number.isFinite(parsedBeta) || Math.abs(parsedBeta) > 20)) return null;
  return {
    id,
    title: `${asset1Symbol} → ${asset2Symbol}`,
    short: "Custom relative-value relationship",
    kind: "custom",
    asset1: { venue: asset1Venue, symbol: asset1Symbol, label: `${asset1Venue === "binance" ? "Binance" : "Hyperliquid"} ${asset1Symbol}` },
    asset2: { venue: asset2Venue, symbol: asset2Symbol, label: `${asset2Venue === "binance" ? "Binance" : "Hyperliquid"} ${asset2Symbol}` },
    referenceBeta: parsedBeta,
    leveraged: parsedBeta !== null && Math.abs(parsedBeta) > 1,
    thesis: parsedBeta === null ? "Estimate Asset 2 from Asset 1 with a historical regression coefficient." : `Apply the user-defined structural beta ${parsedBeta} directly to Asset 1's move.`,
    caveat: "This custom relationship is a monitoring assumption. Validate market structure, liquidity and reference timing before acting on it.",
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const now = Date.now();
  const relationship = RELATIONSHIPS.find((item) => item.id === (url.searchParams.get("relationship") || "qqq-ustech")) ?? customRelationship(url);
  const end = Math.min(Number(url.searchParams.get("end") || now), now);
  const start = Number(url.searchParams.get("start") || end - 24 * 60 * 60_000);
  if (!relationship) return Response.json({ error: "Unknown relationship." }, { status: 400 });
  const maximumWindow = maxObservationMs(relationship);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || start >= end || end > now + 60_000 || end - start > maximumWindow + 60_000) {
    return Response.json({ error: "Choose any observation window up to seven days, ending no later than now." }, { status: 400 });
  }
  const interval = observationInterval(start, end);
  try {
    const [model, asset1Rows, asset2Rows, universe] = await Promise.all([
      getFixedModel(relationship, start),
      getSeries(relationship.asset1, start, end, interval),
      getSeries(relationship.asset2, start, end, interval),
      scanUniverse(RELATIONSHIPS.some((item) => item.id === relationship.id) ? RELATIONSHIPS : [...RELATIONSHIPS, relationship]).catch(() => null),
    ]);
    const projection = projectRelationship(asset1Rows, asset2Rows, model);
    return Response.json({
      generatedAt: Date.now(),
      interval,
      observation: { start, end, maxDurationMs: maximumWindow },
      relationship,
      relationships: RELATIONSHIPS.some((item) => item.id === relationship.id) ? RELATIONSHIPS : [...RELATIONSHIPS, relationship],
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
