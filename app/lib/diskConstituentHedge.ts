import {
  DISK_SYNTHETIC_NAV_MAX_SNAPSHOT_AGE, DISK_SYNTHETIC_NAV_PERP_MAX_AGE,
  type DiskSyntheticNavBase, type DiskSyntheticNavRow, type DiskSyntheticNavSnapshot,
} from "./diskSyntheticNav";

export type DiskConstituentHedgeRow = {
  symbol: string;
  name: string;
  perpSymbol: string;
  weight: number;
  quantity: number | null;
  price: number | null;
  notional: number | null;
  quoteAt: number | null;
};
export type DiskConstituentHedgePlan = {
  status: "empty" | "ready" | "partial" | "unavailable";
  rows: DiskConstituentHedgeRow[];
  mappedWeight: number;
  hedgedWeight: number;
  unmappedWeight: number;
  notional: number | null;
  baseDate: string | null;
};

const DAY = 86_400_000;
const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
  && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

function usableBaseline(row: DiskSyntheticNavRow, base: DiskSyntheticNavBase) {
  if (!positive(row.weight) || !positive(row.baseUsd) || !positive(row.baseNative) || !positive(row.baseFxPrice)
    || !positive(row.baseAt) || row.baseAt > base.at + 5_000 || base.at - row.baseAt > 7 * DAY) return false;
  if (Math.abs(row.baseUsd - row.baseNative / row.baseFxPrice) > Math.max(1e-8, row.baseUsd * 1e-8)) return false;
  if (row.currency === "USD") return row.baseFxPrice === 1;
  return positive(row.baseFxAt) && row.baseFxAt <= base.at + 5_000 && base.at - row.baseFxAt <= 90 * 60_000;
}

/** Fixed base-asset targets for a long DISK holding; preserve raw weights. */
export function calculateDiskConstituentHedge(
  units: number | null,
  snapshot: DiskSyntheticNavSnapshot | null | undefined,
  now = Date.now(),
): DiskConstituentHedgePlan {
  const holdings = snapshot?.rows ?? [];
  const mapped = holdings.filter(row => row.sourceKind === "perp" && Boolean(row.perpSymbol?.trim()));
  const mappedWeight = mapped.reduce((sum, row) => sum + (positive(row.weight) ? row.weight : 0), 0);
  const unmappedWeight = holdings.filter(row => !mapped.includes(row)).reduce((sum, row) => sum + (positive(row.weight) ? row.weight : 0), 0)
    + (positive(snapshot?.coverage.cashBalance) ? snapshot.coverage.cashBalance : 0);
  const base = snapshot?.base;
  const validBase = base && positive(base.nav) && positive(base.at) && positive(now)
    && base.at <= now + 5_000 && now - base.at <= 7 * DAY
    && validDate(base.date) && validDate(base.holdingsAsOf)
    && Boolean(base.source.trim()) && Boolean(base.holdingsSource.trim());
  const validUnits = typeof units === "number" && Number.isFinite(units) && units >= 0;
  const calculationCurrent = positive(snapshot?.calculatedAt) && snapshot.calculatedAt <= now + 5_000
    && now - snapshot.calculatedAt <= DISK_SYNTHETIC_NAV_MAX_SNAPSHOT_AGE;
  const counts = new Map<string, number>();
  mapped.forEach(row => counts.set(row.perpSymbol!, (counts.get(row.perpSymbol!) ?? 0) + 1));
  const rows = mapped.map((row): DiskConstituentHedgeRow => {
    // Current prices revalue the target; they must not resize its share count.
    const target = validUnits && validBase && usableBaseline(row, base) && counts.get(row.perpSymbol!) === 1
      ? units * base.nav * row.weight / row.baseUsd! : null;
    const quantity = target !== null && Number.isFinite(target) ? target : null;
    const current = calculationCurrent && positive(row.currentUsd) && positive(row.quoteAt)
      && row.quoteAt <= now + 5_000 && now - row.quoteAt <= DISK_SYNTHETIC_NAV_PERP_MAX_AGE;
    const price = current ? row.currentUsd : null;
    const value = quantity !== null && price !== null ? quantity * price : null;
    return {
      symbol: row.symbol, name: row.name, perpSymbol: row.perpSymbol!, weight: row.weight,
      quantity, price, notional: value !== null && Number.isFinite(value) ? value : null, quoteAt: row.quoteAt,
    };
  });
  const available = rows.filter(row => row.quantity !== null);
  return {
    status: units === null ? "empty" : !validUnits || !validBase || !rows.length ? "unavailable"
      : available.length === rows.length ? "ready" : available.length ? "partial" : "unavailable",
    rows, mappedWeight,
    hedgedWeight: available.reduce((sum, row) => sum + row.weight, 0),
    unmappedWeight,
    notional: rows.length && rows.every(row => row.notional !== null)
      ? rows.reduce((sum, row) => sum + row.notional!, 0) : null,
    baseDate: base?.date ?? null,
  };
}
