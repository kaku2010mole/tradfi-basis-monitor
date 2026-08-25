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
