// Cash-only model. No derivatives data or exchange API belongs in this module.
export const JAPAN_ESTIMATE_STOCKS = [
  { code: "5802", name: "Sumitomo Electric", symbol: "SUMIELECUSDT" },
  { code: "6758", name: "Sony Group", symbol: "JPSONYUSDT" },
  { code: "6857", name: "Advantest", symbol: "ADVANTESTUSDT" },
  { code: "6920", name: "Lasertec", symbol: "LASERTECUSDT" },
  { code: "6976", name: "Taiyo Yuden", symbol: "TAIYOYUDENUSDT" },
  { code: "6981", name: "Murata Manufacturing", symbol: "MURATAUSDT" },
  { code: "7203", name: "Toyota Motor", symbol: "TOYOTAUSDT" },
  { code: "8035", name: "Tokyo Electron", symbol: "TOKYOELUSDT" },
  { code: "8306", name: "MUFG", symbol: "JPMUFGUSDT" },
  { code: "9983", name: "Fast Retailing", symbol: "FASTRETAILINGUSDT" },
  { code: "9984", name: "SoftBank Group", symbol: "SOFTBANKUSDT" },
] as const;
export type CashDay = { date: string; close: number };
export type CashHistory = { bars: CashDay[]; splits: string[]; fetchedAt: number };
export type CashModel = { beta: number; correlation: number; n: number; from: string; through: string; maePct: number | null; baselineMaePct: number | null; testN: number; improvementPct: number | null };
export type RealQuote = { price: number; timestamp: number; source: string; kind: "mid" | "last"; delayMinutes?: number };
export const QUOTE_MAX_AGE = 90_000;
const DAY = 86_400_000;
const HOLIDAYS: Record<string, Set<string>> = {
  "2026": new Set("01-01 01-02 01-03 01-12 02-11 02-23 03-20 04-29 05-03 05-04 05-05 05-06 07-20 08-11 09-21 09-22 09-23 10-12 11-03 11-23 12-31".split(" ")),
  "2027": new Set("01-01 01-02 01-03 01-11 02-11 02-23 03-21 03-22 04-29 05-03 05-04 05-05 07-19 08-11 09-20 09-23 10-11 11-03 11-23 12-31".split(" ")),
};
export const japanDate = (time: number) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);
export const japanCloseTime = (date: string) => Date.parse(`${date}T15:30:00+09:00`);
export function latestJapanClose(now: number): string | null {
  for (let i = 0; i < 15; i++) {
    const date = japanDate(now - i * DAY), year = date.slice(0, 4);
    if (!HOLIDAYS[year]) return null;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !HOLIDAYS[year].has(date.slice(5)) && japanCloseTime(date) <= now) return date;
  }
  return null;
}
const positive = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
export function parseJapanHistory(payload: unknown, code: string, now: number): CashHistory | null {
  const data = (payload as { chart?: { result?: Array<{ meta?: { symbol?: string; currency?: string; instrumentType?: string; regularMarketTime?: number }; timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> }; events?: { splits?: Record<string, { date: number }> } }> } })?.chart?.result?.[0];
  if (data?.meta?.symbol !== `${code}.T` || data.meta.currency !== "JPY" || data.meta.instrumentType !== "EQUITY") return null;
  const target = latestJapanClose(now);
  if (!target) return null;
  const marketTime = (data.meta.regularMarketTime ?? 0) * 1000;
  if (!Number.isFinite(marketTime) || marketTime <= 0 || marketTime > now + 5000) return null;
  const values = new Map<string, number>();
  for (const [i, time] of (data.timestamp ?? []).entries()) {
    if (!Number.isFinite(time)) continue;
    const date = japanDate(time * 1000), close = positive(data.indicators?.quote?.[0]?.close?.[i]);
    if (!close || date > target) continue;
    // A stale intraday response must not become a close just because the wall
    // clock passed the auction (or the weekend started).
    if (date === japanDate(marketTime) && marketTime < japanCloseTime(date)) continue;
    if (date === japanDate(now) && marketTime < japanCloseTime(date)) continue;
    values.set(date, close);
  }
  const bars = [...values].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
  if (bars.length < 65) return null;
  return { bars, fetchedAt: now, splits: Object.values(data.events?.splits ?? {}).filter(s => Number.isFinite(s.date)).map(s => japanDate(s.date * 1000)) };
}
function slope(points: Array<{ x: number; y: number }>): number | null {
  const xx = points.reduce((s, p) => s + p.x * p.x, 0);
  return xx > 1e-12 ? points.reduce((s, p) => s + p.x * p.y, 0) / xx : null;
}
export function fitCashModel(kioxia: CashDay[], target: CashDay[], through: string): CashModel | null {
  const xMap = new Map(kioxia.filter(b => b.date <= through).map(b => [b.date, b.close]));
  const yMap = new Map(target.filter(b => b.date <= through).map(b => [b.date, b.close]));
  // A return is valid only when both legs have the same consecutive dates.
  const dates = [...xMap.keys()].sort();
  const points = dates.slice(1).flatMap((date, i) => {
    const prior = dates[i], x0 = xMap.get(prior)!, x1 = xMap.get(date)!, y0 = yMap.get(prior), y1 = yMap.get(date);
    if (!y0 || !y1 || ![x0, x1, y0, y1].every(v => Number.isFinite(v) && v > 0)) return [];
    // Missing target-only sessions must not be hidden by intersecting dates.
    if (target.some(b => b.date > prior && b.date < date)) return [];
    return [{ date, x: Math.log(x1 / x0), y: Math.log(y1 / y0) }];
  });
  const training = points.slice(-126), beta = slope(training);
  if (training.length < 60 || beta === null) return null;
  const mx = training.reduce((s, p) => s + p.x, 0) / training.length, my = training.reduce((s, p) => s + p.y, 0) / training.length;
  const xx = training.reduce((s, p) => s + (p.x - mx) ** 2, 0), yy = training.reduce((s, p) => s + (p.y - my) ** 2, 0);
  const correlation = xx * yy > 0 ? training.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / Math.sqrt(xx * yy) : 0;
  const errors: number[] = [], baseline: number[] = [];
  for (let i = Math.max(60, points.length - 60); i < points.length; i++) {
    const b = slope(points.slice(Math.max(0, i - 126), i));
    if (b === null) continue;
    errors.push(Math.abs(Math.expm1(points[i].y) - Math.expm1(b * points[i].x)) * 100);
    baseline.push(Math.abs(Math.expm1(points[i].y)) * 100);
  }
  const mean = (values: number[]) => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  const maePct = mean(errors), baselineMaePct = mean(baseline);
  return { beta, correlation, n: training.length, from: training[0].date, through: training.at(-1)!.date, maePct, baselineMaePct, testN: errors.length, improvementPct: maePct !== null && baselineMaePct ? (1 - maePct / baselineMaePct) * 100 : null };
}
export function cashEstimate(anchor: number, kioxiaAnchor: number, kioxiaPrice: number, beta: number): number | null {
  if (![anchor, kioxiaAnchor, kioxiaPrice].every(v => Number.isFinite(v) && v > 0) || !Number.isFinite(beta)) return null;
  const value = anchor * Math.exp(beta * Math.log(kioxiaPrice / kioxiaAnchor));
  return Number.isFinite(value) && value > 0 ? value : null;
}
export function realQuote(record: Record<string, unknown> | undefined, source: string, now: number): RealQuote | null {
  if (!record) return null;
  const timestamp = Number(record.marketTimestamp ?? record.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 5_000) return null;
  const bid = positive(record.bid), ask = positive(record.ask), bidSize = positive(record.bidSize), askSize = positive(record.askSize);
  if (bid && ask && ask >= bid && bidSize && askSize) return { price: (bid + ask) / 2, timestamp, source, kind: "mid" };
  // A malformed/crossed book is not rescued with a potentially unrelated last.
  if (bid && ask && ask < bid) return null;
  const last = positive(record.last);
  return last ? { price: last, timestamp, source, kind: "last" } : null;
}
export const freshRealQuote = (q: RealQuote | null, now: number) => Boolean(q && !q.delayMinutes && q.timestamp <= now + 5_000 && now - q.timestamp <= QUOTE_MAX_AGE);
