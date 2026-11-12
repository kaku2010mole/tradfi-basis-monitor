export type FundingBasis = "settlement" | "8h";
export type TradfiAsset = "stock" | "etf" | "index" | "metal" | "energy" | "fx" | "other";
export type TradfiFundingRow = {
  symbol: string;
  name: string;
  asset: TradfiAsset;
  region: string | null;
  rate: number;
  intervalHours: number | null;
  rate8h: number | null;
  nextFundingAt: number | null;
  cashDividend: number | null;
};
export type TradfiFundingSnapshot = {
  timestamp: number;
  receivedAt: number;
  universeUpdatedAt: number;
  universeCount: number;
  missingFundingCount: number;
  invalidFundingCount: number;
  rows: TradfiFundingRow[];
  stale: boolean;
  error: string | null;
};
export type BitgetTradfiInstrument = {
  symbol: string;
  name: string;
  asset: TradfiAsset;
  region: string | null;
};
export const FUNDING_STALE_MS = 90_000;
const ASSETS = new Set<TradfiAsset>(["stock", "etf", "index", "metal", "energy", "fx"]);

function finite(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string" || value === "" || typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function responseData(payload: unknown): { rows: unknown[]; timestamp: number | null } {
  const body = record(payload);
  if (body?.code !== "00000" || !Array.isArray(body.data)) throw new Error("Bitget market data is temporarily unavailable.");
  return { rows: body.data, timestamp: finite(body.requestTime) };
}

export function parseTradfiInstruments(payload: unknown): BitgetTradfiInstrument[] {
  const result = new Map<string, BitgetTradfiInstrument>();
  for (const value of responseData(payload).rows) {
    const row = record(value);
    if (!row || row.isRwa !== "YES" || row.status !== "online" || row.type !== "perpetual" || typeof row.symbol !== "string" || !/^[A-Z0-9_]{2,64}$/.test(row.symbol)) continue;
    const instrumentType = row.instrumentType as TradfiAsset;
    const legacy = row.symbolType === "stock" ? "stock" : row.symbolType === "commodity" ? "energy" : "other";
    result.set(row.symbol, {
      symbol: row.symbol,
      name: typeof row.fullName === "string" && row.fullName.trim() ? row.fullName.trim() : row.symbol.replace(/USDT$/, ""),
      asset: ASSETS.has(instrumentType) ? instrumentType : legacy,
      region: typeof row.marketRegion === "string" && row.marketRegion ? row.marketRegion : null,
    });
  }
  if (!result.size) throw new Error("Bitget TradFi contract coverage is temporarily unavailable.");
  return [...result.values()];
}

export function parseTradfiFunding(
  instruments: BitgetTradfiInstrument[], payload: unknown, receivedAt: number, universeUpdatedAt: number,
): TradfiFundingSnapshot {
  const data = responseData(payload);
  if (data.timestamp === null || data.timestamp <= 0 || data.timestamp > receivedAt + 5_000 || receivedAt - data.timestamp > FUNDING_STALE_MS) {
    throw new Error("Bitget returned an outdated funding snapshot.");
  }
  const observed = new Map<string, Record<string, unknown>>();
  for (const value of data.rows) {
    const row = record(value);
    if (row && typeof row.symbol === "string") observed.set(row.symbol, row);
  }
  const rows: TradfiFundingRow[] = [];
  let missingFundingCount = 0, invalidFundingCount = 0;
  for (const instrument of instruments) {
    const row = observed.get(instrument.symbol);
    if (!row) { missingFundingCount++; continue; }
    const rate = finite(row.fundingRate);
    if (rate === null || Math.abs(rate) > 1) { invalidFundingCount++; continue; }
    const hours = finite(row.fundingRateInterval);
    const intervalHours = hours !== null && hours > 0 && hours <= 24 ? hours : null;
    const next = finite(row.nextUpdate);
    const dividend = finite(row.cashDividend);
    rows.push({
      ...instrument, rate, intervalHours,
      rate8h: intervalHours === null ? null : rate * 8 / intervalHours,
      nextFundingAt: next !== null && next > 0 ? next : null,
      cashDividend: dividend !== null && dividend !== 0 ? dividend : null,
    });
  }
  if (!rows.length) throw new Error("No current Bitget TradFi funding rates are available.");
  return { timestamp: data.timestamp, receivedAt, universeUpdatedAt, universeCount: instruments.length, missingFundingCount, invalidFundingCount, rows, stale: false, error: null };
}

export function fundingSnapshotFresh(snapshot: TradfiFundingSnapshot | null, now: number) {
  return Boolean(snapshot && !snapshot.stale && snapshot.timestamp <= now + 5_000 && now - snapshot.timestamp <= FUNDING_STALE_MS);
}

export function rankTradfiFunding(rows: TradfiFundingRow[], basis: FundingBasis, search = "", asset = "all", limit = 10) {
  const needle = search.trim().toLowerCase();
  const rate = (row: TradfiFundingRow) => basis === "8h" ? row.rate8h : row.rate;
  const sorted = rows.filter(row => (asset === "all" || row.asset === asset) &&
    (!needle || `${row.symbol} ${row.name}`.toLowerCase().includes(needle)) && rate(row) !== null)
    .sort((a, b) => rate(b)! - rate(a)! || a.symbol.localeCompare(b.symbol));
  const ascending = [...sorted].sort((a, b) => rate(a)! - rate(b)! || a.symbol.localeCompare(b.symbol));
  return { count: sorted.length, highest: sorted.slice(0, limit), lowest: ascending.slice(0, limit) };
}
