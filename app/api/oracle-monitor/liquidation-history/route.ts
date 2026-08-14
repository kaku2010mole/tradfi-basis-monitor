const DEFAULT_SYMBOLS = new Set(["para:OTHERS", "para:TOTAL2", "para:BTCD"]);
const DEFAULT_WINDOW_MS = 60 * 60_000;
const MAX_WINDOW_MS = 24 * 60 * 60_000;

type CompactLevel = [number, number, number, number, 0 | 1];
type Snapshot = {
  id: string;
  apiSymbol: string;
  symbol: string;
  t: number;
  oracle: number | null;
  mark: number | null;
  source: "HyperTracker";
  levels: CompactLevel[];
};

const validSnapshot = (value: unknown): value is Snapshot => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Snapshot>;
  return typeof record.id === "string"
    && typeof record.apiSymbol === "string"
    && DEFAULT_SYMBOLS.has(record.apiSymbol)
    && Number.isFinite(record.t)
    && Array.isArray(record.levels)
    && record.levels.length > 0;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "para:OTHERS";
  if (!DEFAULT_SYMBOLS.has(symbol)) return Response.json({ snapshots: [], source: "render-disk" }, { headers: { "Cache-Control": "no-store" } });
  const requestedEnd = Number(url.searchParams.get("end"));
  const end = Number.isFinite(requestedEnd) && requestedEnd > 0 ? Math.min(requestedEnd, Date.now()) : Date.now();
  const requestedStart = Number(url.searchParams.get("start"));
  const start = Number.isFinite(requestedStart) && requestedStart > 0 ? Math.max(requestedStart, end - MAX_WINDOW_MS) : end - DEFAULT_WINDOW_MS;

  try {
    const [{ readdir, readFile }, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    const candidates = process.env.PARA_LIQUIDATION_DATA_DIR
      ? [process.env.PARA_LIQUIDATION_DATA_DIR]
      : ["/var/data/para-liquidations", "/tmp/para-liquidations"];
    let directory = "";
    let files: string[] = [];
    for (const candidate of candidates) {
      try {
        files = (await readdir(candidate)).filter((name) => name.endsWith(".ndjson")).sort();
        directory = candidate;
        break;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "ENOENT" && code !== "EACCES") throw error;
      }
    }
    if (!directory) return Response.json({ snapshots: [], source: "render-disk", start, end }, { headers: { "Cache-Control": "no-store" } });
    const snapshots: Snapshot[] = [];
    for (const name of files) {
      const content = await readFile(path.join(directory, name), "utf8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const snapshot = JSON.parse(line) as unknown;
          if (validSnapshot(snapshot) && snapshot.apiSymbol === symbol && snapshot.t >= start && snapshot.t <= end) snapshots.push(snapshot);
        } catch { /* The recorder may be appending the final line. */ }
      }
    }
    return Response.json({ snapshots, source: "render-disk", start, end }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ snapshots: [], source: "render-disk", start, end }, { headers: { "Cache-Control": "no-store" } });
  }
}
