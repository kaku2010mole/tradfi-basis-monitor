export type AdrDirection = "up" | "down" | "either";
export type AdrStudy = {
  asOf: string; start: string; dates: string[]; adrReturns: number[];
  returns0930: Record<string, (number | null)[]>;
};

export function adrCohort(study: AdrStudy, direction: AdrDirection | null, threshold: number) {
  if (!direction || !Number.isFinite(threshold) || threshold <= 0) return [];
  return study.dates.flatMap((_, i) => {
    const x = study.adrReturns[i];
    return Number.isFinite(x) && (direction === "up" ? x >= threshold : direction === "down" ? x <= -threshold : Math.abs(x) >= threshold) ? [i] : [];
  });
}

export function adrStudyStats(study: AdrStudy, code: string, indices: number[]) {
  const values = study.returns0930[code];
  const valid = indices.flatMap((i) => {
    const value = values?.[i], adr = study.adrReturns[i];
    return typeof value === "number" && Number.isFinite(value) && Number.isFinite(adr) ? [{ value, adr }] : [];
  });
  const n = valid.length;
  if (!n) return { n: 0, hits: 0, flat: 0, meanPct: null, hitPct: null, interval: null };
  const hits = valid.filter(({ value, adr }) => Math.abs(value) > 1e-12 && value * adr > 0).length;
  const flat = valid.filter(({ value }) => Math.abs(value) <= 1e-12).length;
  const p = hits / n, z = 1.96, divisor = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / divisor;
  const radius = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / divisor;
  return {
    n, hits, flat,
    meanPct: valid.reduce((sum, { value }) => sum + value, 0) / n * 100,
    hitPct: p * 100,
    interval: [(center - radius) * 100, (center + radius) * 100],
  };
}

export function adrStudyCoverage(study: AdrStudy, code: string) {
  const dates = study.dates.filter((_, i) => Number.isFinite(study.returns0930[code]?.[i]));
  return { n: dates.length, total: study.dates.length, start: dates[0] ?? null, end: dates.at(-1) ?? null };
}

type Observation = { price: number; timestamp: number };
export function adrReturn(anchor: Observation | null | undefined, current: Observation | null | undefined, target: number | null, cutoff: number) {
  if (!anchor || !current || target === null || !Number.isFinite(cutoff)
    || ![anchor.price, current.price, anchor.timestamp, current.timestamp, target].every(Number.isFinite)
    || anchor.price <= 0 || current.price <= 0 || anchor.timestamp <= 0 || current.timestamp <= 0
    || anchor.timestamp > target || current.timestamp < anchor.timestamp || current.timestamp > cutoff
    || target - anchor.timestamp > 4 * 86_400_000 || cutoff - current.timestamp > 4 * 86_400_000) return null;
  return (current.price / anchor.price - 1) * 100;
}

export function matchingAdrDirection(value: number | null): "up" | "down" | null {
  return value === null || !Number.isFinite(value) || Math.abs(value) < 1e-10 ? null : value > 0 ? "up" : "down";
}

export function matchesAdrThreshold(value: number | null, direction: AdrDirection | null, thresholdPct: number) {
  return value !== null && Number.isFinite(value) && direction !== null &&
    (direction === "up" ? value >= thresholdPct : direction === "down" ? value <= -thresholdPct : Math.abs(value) >= thresholdPct);
}
