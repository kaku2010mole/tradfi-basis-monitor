const SYMBOLS = new Set(["para:OTHERS", "para:TOTAL2", "para:BTCD"]);
const DEFAULT_WINDOW_MS = 60 * 60_000;
const MAX_WINDOW_MS = 24 * 60 * 60_000;

type CompactLevel = [number, number, 0 | 1];
type Snapshot = {
  id: string;
  apiSymbol: string;
  symbol: string;
  t: number;
  oracle: number | null;
  mark: number | null;
  levels: CompactLevel[];
};

const validSnapshot = (value: unknown): value is Snapshot => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Snapshot>;
  return typeof record.id === "string"
    && typeof record.apiSymbol === "string"
    && SYMBOLS.has(record.apiSymbol)
    && Number.isFinite(record.t)
    && Array.isArray(record.levels)
    && record.levels.length > 0;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "para:OTHERS";
  if (!SYMBOLS.has(symbol)) return Response.json({ error: "Unsupported Para symbol." }, { status: 400 });
  const endValue = url.searchParams.get("end");
  const requestedEnd = endValue === null ? null : Number(endValue);
  const end = requestedEnd !== null && Number.isFinite(requestedEnd) ? Math.min(requestedEnd, Date.now()) : Date.now();
  const startValue = url.searchParams.get("start");
  const requestedStart = startValue === null ? null : Number(startValue);
  const start = requestedStart !== null && Number.isFinite(requestedStart) ? Math.max(requestedStart, end - MAX_WINDOW_MS) : end - DEFAULT_WINDOW_MS;

  try {
    const [{ readdir, readFile }, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    const dataDirectory = process.env.PARA_DATA_DIR || "/var/data/para-orderbooks";
    const files = (await readdir(dataDirectory)).filter((name) => name.endsWith(".ndjson")).sort();
    const snapshots: Snapshot[] = [];
    for (const name of files) {
      const content = await readFile(path.join(dataDirectory, name), "utf8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const snapshot = JSON.parse(line) as unknown;
          if (validSnapshot(snapshot) && snapshot.apiSymbol === symbol && snapshot.t >= start && snapshot.t <= end) snapshots.push(snapshot);
        } catch { /* Ignore an incomplete final line while the recorder is appending. */ }
      }
    }
    return Response.json({ snapshots, source: "render-disk", start, end }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return Response.json({ snapshots: [], source: "render-disk", start, end }, { headers: { "Cache-Control": "no-store" } });
    return Response.json({ error: "Server history is available on the Render deployment only." }, { status: 501 });
  }
}
