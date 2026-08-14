import {
  fixedTrainingWindow,
  MAX_STATISTICAL_OBSERVATION_MS,
  maxObservationMs,
  PricePoint,
  Relationship,
  TRAINING_INTERVAL,
  trainRelationshipModel,
} from "../../../lib/relativeValue";

const BINANCE_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"];
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const BINANCE_SYMBOL = /^[A-Z0-9_]{2,32}$/;
const HYPERLIQUID_SYMBOL = /^[A-Z0-9._:-]{2,40}$/i;
type BinanceKline = [number, string, string, string, string];
type BinanceBook = { symbol?: string; bidPrice?: string; askPrice?: string };
type HyperCandle = { t?: number; c?: string };
type RankingModel = { alphaHourly: number; beta: number };
type RankingRow = { id: string; predictionError: number; actual: number; theoretical: number; beta: number; updatedAt: number };

const modelCache = new Map<string, Promise<RankingModel>>();
const baselineCache = new Map<string, Promise<number>>();

async function fetchBinance<T>(path: string) {
  let lastError: unknown;
  for (const host of BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("Binance data unavailable.");
}

function validRelationship(value: unknown): value is Relationship {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Relationship>;
  const validLeg = (leg: Relationship["asset1"] | undefined) => Boolean(leg && (leg.venue === "binance" ? BINANCE_SYMBOL : leg.venue === "hyperliquid" ? HYPERLIQUID_SYMBOL : /$a/).test(leg.symbol));
  return typeof item.id === "string" && item.id.length <= 48 && validLeg(item.asset1) && validLeg(item.asset2)
    && (item.referenceBeta === null || (Number.isFinite(item.referenceBeta) && Math.abs(item.referenceBeta!) <= 20));
}

async function trainingSeries(leg: Relationship["asset1"], start: number, end: number): Promise<PricePoint[]> {
  if (leg.venue === "binance") {
    const params = new URLSearchParams({ symbol: leg.symbol, interval: TRAINING_INTERVAL, startTime: String(start), endTime: String(end), limit: "1500" });
    const rows = await fetchBinance<BinanceKline[]>(`/fapi/v1/klines?${params}`);
    return rows.flatMap((row) => Number(row[4]) > 0 ? [{ t: row[0], value: Number(row[4]) }] : []);
  }
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: leg.symbol, interval: TRAINING_INTERVAL, startTime: start, endTime: end } }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  const rows = await response.json() as HyperCandle[];
  return rows.flatMap((row) => Number(row.c) > 0 ? [{ t: Number(row.t), value: Number(row.c) }] : []);
}

function rankingModel(relationship: Relationship, start: number): Promise<RankingModel> {
  if (relationship.referenceBeta !== null) return Promise.resolve({ alphaHourly: 0, beta: relationship.referenceBeta });
  const { trainingStart, trainingEnd } = fixedTrainingWindow(start);
  const key = `${relationship.id}:${trainingEnd}`;
  const cached = modelCache.get(key);
  if (cached) return cached;
  const promise = Promise.all([
    trainingSeries(relationship.asset1, trainingStart, trainingEnd),
    trainingSeries(relationship.asset2, trainingStart, trainingEnd),
  ]).then(([first, second]) => {
    const model = trainRelationshipModel(first, second, relationship, trainingStart, trainingEnd);
    return { alphaHourly: model.alphaHourly, beta: model.beta };
  });
  modelCache.set(key, promise);
  promise.catch(() => modelCache.delete(key));
  return promise;
}

function baseline(leg: Relationship["asset1"], start: number) {
  const roundedStart = Math.floor(start / 60_000) * 60_000;
  const key = `${leg.venue}:${leg.symbol}:${roundedStart}`;
  const cached = baselineCache.get(key);
  if (cached) return cached;
  if (baselineCache.size > 240) baselineCache.clear();
  const promise = leg.venue === "binance" ? (async () => {
    const params = new URLSearchParams({ symbol: leg.symbol, interval: "1m", startTime: String(roundedStart), limit: "1" });
    const rows = await fetchBinance<BinanceKline[]>(`/fapi/v1/klines?${params}`);
    const value = Number(rows[0]?.[4]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${leg.symbol} baseline unavailable.`);
    return value;
  })() : (async () => {
    const response = await fetch(HYPERLIQUID_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: leg.symbol, interval: "1m", startTime: roundedStart, endTime: roundedStart + 5 * 60_000 } }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
    const rows = await response.json() as HyperCandle[];
    const value = Number(rows[0]?.c);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${leg.symbol} baseline unavailable.`);
    return value;
  })();
  baselineCache.set(key, promise);
  promise.catch(() => baselineCache.delete(key));
  return promise;
}

async function limitedMap<T, R>(values: T[], limit: number, task: (value: T) => Promise<R>) {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await task(values[index]);
    }
  }));
  return output;
}

export async function POST(request: Request) {
  const now = Date.now();
  const payload = await request.json().catch(() => ({})) as { start?: unknown; end?: unknown; relationships?: unknown };
  const start = Number(payload.start);
  const end = Math.min(Number(payload.end), now);
  const relationships = Array.isArray(payload.relationships) ? payload.relationships.filter(validRelationship).slice(0, 30) : [];
  if (!relationships.length || !Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || start >= end || end - start > MAX_STATISTICAL_OBSERVATION_MS + 60_000) {
    return Response.json({ error: "Invalid ranking window or relationships." }, { status: 400 });
  }
  try {
    const books = await fetchBinance<BinanceBook[]>("/fapi/v1/ticker/bookTicker");
    const bookBySymbol = new Map(books.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
    const dexNames = [...new Set(relationships.flatMap((item) => [item.asset1, item.asset2]).filter((leg) => leg.venue === "hyperliquid").map((leg) => leg.symbol.includes(":") ? leg.symbol.split(":", 1)[0] : ""))];
    const dexMids = new Map(await Promise.all(dexNames.map(async (dex) => {
      const response = await fetch(HYPERLIQUID_INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dex ? { type: "allMids", dex } : { type: "allMids" }), cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
      return [dex, await response.json() as Record<string, string>] as const;
    })));
    const live = (leg: Relationship["asset1"]) => {
      if (leg.venue === "binance") {
        const book = bookBySymbol.get(leg.symbol);
        const bid = Number(book?.bidPrice); const ask = Number(book?.askPrice);
        return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
      }
      const dex = leg.symbol.includes(":") ? leg.symbol.split(":", 1)[0] : "";
      const value = Number(dexMids.get(dex)?.[leg.symbol]);
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    const results = await limitedMap(relationships, 5, async (relationship): Promise<RankingRow | null> => {
      try {
        const relationshipStart = Math.max(start, end - maxObservationMs(relationship));
        const current1 = live(relationship.asset1); const current2 = live(relationship.asset2);
        if (!current1 || !current2) return null;
        const [base1, base2, model] = await Promise.all([baseline(relationship.asset1, relationshipStart), baseline(relationship.asset2, relationshipStart), rankingModel(relationship, relationshipStart)]);
        const elapsedHours = Math.max(0, (end - relationshipStart) / 60 / 60_000);
        const theoretical = Math.expm1(model.alphaHourly * elapsedHours + model.beta * Math.log(current1 / base1)) * 100;
        const actual = (current2 / base2 - 1) * 100;
        return { id: relationship.id, predictionError: actual - theoretical, actual, theoretical, beta: model.beta, updatedAt: now };
      } catch { return null; }
    });
    return Response.json({ generatedAt: now, rankings: results.filter((row): row is RankingRow => row !== null) }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Prediction ranking unavailable." }, { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
