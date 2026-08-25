import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

type StoredPoint = {
  poolId?: unknown;
  t?: unknown;
  pool?: unknown;
  stockHkd?: unknown;
};

type HistoryGlobals = typeof globalThis & {
  __ONCHAIN_LAST_CAPTURE_MINUTE__?: number;
  __ONCHAIN_LAST_CLEANUP__?: number;
};

const FUTU_PAIRS = [
  ["HK.00388", "TENCENTUSDT"],
  ["HK.00700", "TENCENTUSDT"],
  ["HK.01024", "KUAISHOUUSDT"],
  ["HK.01810", "HK1810USDT"],
  ["HK.02097", "TENCENTUSDT"],
  ["HK.03690", "MEITUANUSDT"],
  ["HK.09992", "POPMARTUSDT"],
] as const;
const RETENTION_MS = 90 * 24 * 60 * 60_000;

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const historyDirectory = async (create = false) => {
  const candidates = process.env.ONCHAIN_BASIS_DATA_DIR
    ? [process.env.ONCHAIN_BASIS_DATA_DIR]
    : ["/var/data/onchain-basis", "/tmp/onchain-basis"];
  for (const candidate of candidates) {
    try {
      if (create) await mkdir(candidate, { recursive: true });
      else await readdir(candidate);
      return candidate;
    } catch { /* Try the next supported location. */ }
  }
  return null;
};

const inCaptureWindow = (timestamp: number) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp).map((part) => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return parts.weekday !== "Sat" && parts.weekday !== "Sun" && minute >= 10 * 60 && minute <= 15 * 60;
};

const cleanup = async (directory: string) => {
  const globals = globalThis as HistoryGlobals;
  if (Date.now() - (globals.__ONCHAIN_LAST_CLEANUP__ ?? 0) < 60 * 60_000) return;
  globals.__ONCHAIN_LAST_CLEANUP__ = Date.now();
  const cutoff = Date.now() - RETENTION_MS;
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson")).map(async (entry) => {
    const file = path.join(directory, entry.name);
    if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
  }));
};

const capture = async (origin: string) => {
  const now = Date.now();
  if (!inCaptureWindow(now)) return 0;
  const minute = Math.floor(now / 60_000) * 60_000;
  const globals = globalThis as HistoryGlobals;
  if (globals.__ONCHAIN_LAST_CAPTURE_MINUTE__ === minute) return 0;
  const params = new URLSearchParams({ usdhkd: "7.83" });
  FUTU_PAIRS.forEach(([stock, perp]) => params.append("pair", `${stock}|${perp}|1`));
  const [poolResponse, futuResponse] = await Promise.all([
    fetch(new URL("/api/onchain-pools/quote?group=hk", origin), { cache: "no-store", signal: AbortSignal.timeout(20_000) }),
    fetch(new URL(`/api/hk-auction/quotes?${params}`, origin), { cache: "no-store", signal: AbortSignal.timeout(20_000) }),
  ]);
  if (!poolResponse.ok || !futuResponse.ok) throw new Error("Live pool or Futu reference unavailable for capture.");
  const poolPayload = await poolResponse.json() as { quotes?: Array<Record<string, unknown>> };
  const futuPayload = await futuResponse.json() as { quotes?: Array<Record<string, unknown>> };
  const referenceByStock = new Map((futuPayload.quotes ?? []).map((quote) => [String(quote.stockSymbol ?? ""), quote]));
  const records = (poolPayload.quotes ?? []).flatMap((pool) => {
    const reference = referenceByStock.get(String(pool.stockSymbol ?? ""));
    const metrics = reference?.metrics && typeof reference.metrics === "object" ? reference.metrics as Record<string, unknown> : null;
    const poolPrice = positive(pool.spotPrice);
    const stockHkd = positive(metrics?.stockReferenceHkd);
    if (poolPrice === null || stockHkd === null || typeof pool.id !== "string") return [];
    return [{ poolId: pool.id, t: minute, pool: poolPrice, stockHkd }];
  });
  if (!records.length) return 0;
  const directory = await historyDirectory(true);
  if (!directory) throw new Error("Onchain history directory unavailable.");
  const date = new Date(minute).toISOString().slice(0, 10);
  await appendFile(path.join(directory, `${date}.ndjson`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  globals.__ONCHAIN_LAST_CAPTURE_MINUTE__ = minute;
  await cleanup(directory);
  return records.length;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const now = Date.now();
  const start = Number(url.searchParams.get("start") ?? now - 90 * 24 * 60 * 60_000);
  const end = Number(url.searchParams.get("end") ?? now);
  const usdHkd = Number(url.searchParams.get("usdhkd") ?? "7.83");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || start >= end || end - start > 366 * 24 * 60 * 60_000) {
    return Response.json({ error: "Invalid history window." }, { status: 400 });
  }
  if (!Number.isFinite(usdHkd) || usdHkd < 1 || usdHkd > 20) {
    return Response.json({ error: "Invalid USD/HKD rate." }, { status: 400 });
  }

  let captured = 0;
  let captureError = "";
  if (url.searchParams.get("capture") === "1") {
    try { captured = await capture(url.origin); }
    catch (error) { captureError = error instanceof Error ? error.message : "Capture unavailable."; }
  }

  const directory = await historyDirectory();
  if (!directory) return Response.json({ history: {}, start, end, captured, captureError, timestamp: now }, { headers: { "Cache-Control": "no-store" } });

  try {
    const entries = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).sort();
    const files = await Promise.all(entries.map((name) => readFile(path.join(directory, name), "utf8")));
    const byPool = new Map<string, Map<number, { t: number; pool: number; fair: number }>>();
    files.forEach((text) => text.split("\n").forEach((line) => {
      if (!line.trim()) return;
      try {
        const raw = JSON.parse(line) as StoredPoint;
        const poolId = typeof raw.poolId === "string" ? raw.poolId : "";
        const t = positive(raw.t);
        const pool = positive(raw.pool);
        const stockHkd = positive(raw.stockHkd);
        if (!poolId || t === null || pool === null || stockHkd === null || t < start || t > end) return;
        const points = byPool.get(poolId) ?? new Map();
        points.set(t, { t, pool, fair: stockHkd / usdHkd });
        byPool.set(poolId, points);
      } catch { /* Ignore a partial final line after an interrupted append. */ }
    }));
    const history = Object.fromEntries([...byPool].map(([poolId, points]) => [poolId, [...points.values()].sort((a, b) => a.t - b.t)]));
    return Response.json({ history, start, end, captured, captureError, timestamp: now }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Onchain basis history unavailable." }, { status: 500 });
  }
}
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

type StoredPoint = {
  poolId?: unknown;
  t?: unknown;
  pool?: unknown;
  stockHkd?: unknown;
};

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const historyDirectory = async () => {
  const candidates = process.env.ONCHAIN_BASIS_DATA_DIR
    ? [process.env.ONCHAIN_BASIS_DATA_DIR]
    : ["/var/data/onchain-basis", "/tmp/onchain-basis"];
  for (const candidate of candidates) {
    try {
      await readdir(candidate);
      return candidate;
    } catch { /* Try the next supported location. */ }
  }
  return null;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const now = Date.now();
  const start = Number(url.searchParams.get("start") ?? now - 90 * 24 * 60 * 60_000);
  const end = Number(url.searchParams.get("end") ?? now);
  const usdHkd = Number(url.searchParams.get("usdhkd") ?? "7.83");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || start >= end || end - start > 366 * 24 * 60 * 60_000) {
    return Response.json({ error: "Invalid history window." }, { status: 400 });
  }
  if (!Number.isFinite(usdHkd) || usdHkd < 1 || usdHkd > 20) {
    return Response.json({ error: "Invalid USD/HKD rate." }, { status: 400 });
  }

  const directory = await historyDirectory();
  if (!directory) return Response.json({ history: {}, start, end, timestamp: now }, { headers: { "Cache-Control": "no-store" } });

  try {
    const entries = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).sort();
    const files = await Promise.all(entries.map((name) => readFile(path.join(directory, name), "utf8")));
    const byPool = new Map<string, Map<number, { t: number; pool: number; fair: number }>>();
    files.forEach((text) => text.split("\n").forEach((line) => {
      if (!line.trim()) return;
      try {
        const raw = JSON.parse(line) as StoredPoint;
        const poolId = typeof raw.poolId === "string" ? raw.poolId : "";
        const t = positive(raw.t);
        const pool = positive(raw.pool);
        const stockHkd = positive(raw.stockHkd);
        if (!poolId || t === null || pool === null || stockHkd === null || t < start || t > end) return;
        const points = byPool.get(poolId) ?? new Map();
        points.set(t, { t, pool, fair: stockHkd / usdHkd });
        byPool.set(poolId, points);
      } catch { /* Ignore a partial final line after an interrupted append. */ }
    }));
    const history = Object.fromEntries([...byPool].map(([poolId, points]) => [poolId, [...points.values()].sort((a, b) => a.t - b.t)]));
    return Response.json({ history, start, end, timestamp: now }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Onchain basis history unavailable." }, { status: 500 });
  }
}
