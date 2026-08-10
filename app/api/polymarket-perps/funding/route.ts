const POLYMARKET_API = "https://api.perpetuals.polymarket.com";
const MAX_RANGE_MS = 30 * 24 * 60 * 60_000;
const CHUNK_MS = 72 * 60 * 60_000;

type FundingEntry = { funding_rate?: string; timestamp?: number };
type FundingResponse = { data?: FundingEntry[]; more?: boolean };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const instrumentId = Number(url.searchParams.get("instrumentId"));
  const end = Math.min(Number(url.searchParams.get("end") || Date.now()), Date.now());
  const start = Math.max(Number(url.searchParams.get("start") || end - 7 * 24 * 60 * 60_000), end - MAX_RANGE_MS);
  if (!Number.isInteger(instrumentId) || instrumentId <= 0 || instrumentId > 100_000) return Response.json({ error: "Invalid instrument ID." }, { status: 400 });
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || start >= end) return Response.json({ error: "Invalid funding history window." }, { status: 400 });
  const windows: Array<{ start: number; end: number }> = [];
  for (let cursor = start; cursor < end; cursor += CHUNK_MS) windows.push({ start: cursor, end: Math.min(end, cursor + CHUNK_MS - 1) });
  try {
    const pages = await Promise.all(windows.map(async (window) => {
      const params = new URLSearchParams({ instrument_id: String(instrumentId), start_timestamp: String(window.start), end_timestamp: String(window.end) });
      const response = await fetch(`${POLYMARKET_API}/v1/info/funding?${params}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Polymarket funding HTTP ${response.status}`);
      return response.json() as Promise<FundingResponse>;
    }));
    const byTime = new Map<number, { t: number; rate: number }>();
    for (const page of pages) for (const entry of page.data ?? []) {
      const t = Number(entry.timestamp);
      const rate = Number(entry.funding_rate);
      if (Number.isFinite(t) && Number.isFinite(rate)) byTime.set(t, { t, rate });
    }
    const points = [...byTime.values()].sort((a, b) => a.t - b.t);
    return Response.json({ instrumentId, start, end, points }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Funding history unavailable." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
