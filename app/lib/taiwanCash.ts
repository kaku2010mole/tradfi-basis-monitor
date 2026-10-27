// Public, sanitized quote model only. Credentials and HTTP requests stay server-side.
export type CashObservation = { price: number; size: number | null; timestamp: number };
export type CashLevel = { price: number; size: number | null };
export type TaiwanCashQuote = {
  code: string; date: string; referencePrice: number | null; previousClose: number | null;
  last: CashObservation | null; trial: CashObservation | null;
  bids: CashLevel[]; asks: CashLevel[]; isTrial: boolean; isClose: boolean;
  isDelayedOpen: boolean; isDelayedClose: boolean; isHalted: boolean;
  timestamp: number; fetchedAt: number;
};
export type TaiwanCashFeed = {
  configured: boolean; quotes: Record<string, TaiwanCashQuote>;
  errors: Record<string, string>; checkedAt: number | null; refreshMs: number;
  refreshing?: boolean; nextRefreshAt?: number;
};
const positive = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null;
const quantity = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const taipeiDate = (t: number) => new Date(t + 8 * 3_600_000).toISOString().slice(0, 10);

// Fugle stock timestamps are microseconds, not seconds or milliseconds.
export function fugleTime(value: unknown, now: number): number | null {
  const n = positive(value);
  if (n === null || n < 1e14) return null;
  const timestamp = Math.floor(n / 1000);
  return timestamp <= now + 5_000 ? timestamp : null;
}

export function parseTaiwanCash(data: unknown, code: string, now: number): TaiwanCashQuote | null {
  const q = record(data), timestamp = fugleTime(q.lastUpdated, now);
  if (q.symbol !== code || q.exchange !== "TWSE" || q.type !== "EQUITY"
    || typeof q.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)
    || timestamp === null || taipeiDate(timestamp) !== q.date) return null;
  const observation = (value: unknown): CashObservation | null => {
    const item = record(value), price = positive(item.price), time = fugleTime(item.time, now);
    return price !== null && time !== null && time <= timestamp + 5_000 && taipeiDate(time) === q.date
      ? { price, timestamp: time, size: quantity(item.size) } : null;
  };
  const levels = (value: unknown): CashLevel[] => Array.isArray(value) ? value.slice(0, 5).flatMap((v) => {
    const level = record(v), price = positive(level.price);
    return price === null ? [] : [{ price, size: quantity(level.size) }];
  }) : [];
  return {
    code, date: q.date, referencePrice: positive(q.referencePrice), previousClose: positive(q.previousClose),
    last: observation(q.lastTrade), trial: observation(q.lastTrial), bids: levels(q.bids), asks: levels(q.asks),
    isTrial: q.isTrial === true, isClose: q.isClose === true,
    isDelayedOpen: q.isDelayedOpen === true, isDelayedClose: q.isDelayedClose === true,
    isHalted: record(q.tradingHalt).isHalted === true, timestamp, fetchedAt: now,
  };
}

export function taiwanCashView(quote: TaiwanCashQuote | null | undefined, now: number) {
  const recent = (timestamp: number) => timestamp > 0 && now - timestamp <= 120_000 && timestamp - now <= 5_000;
  const sameDay = Boolean(quote && quote.date === taipeiDate(now));
  const fresh = Boolean(quote && sameDay && recent(quote.timestamp) && recent(quote.fetchedAt));
  const observation = quote?.isTrial ? quote.trial : quote?.last;
  const prior = quote?.previousClose;
  const changePct = observation && prior ? (observation.price / prior - 1) * 100 : null;
  const phase = !quote ? "UNAVAILABLE" : !sameDay ? "LAST SESSION" : quote.isHalted ? "HALTED"
    : quote.isTrial ? quote.isDelayedOpen ? "DELAYED OPEN · TRIAL" : quote.isDelayedClose ? "DELAYED CLOSE · TRIAL" : "TRIAL"
    : quote.isClose ? "CLOSED" : "CASH SNAPSHOT";
  return { fresh, sameDay, price: observation?.price ?? null, priceTimestamp: observation?.timestamp ?? null, changePct, phase };
}

// Additional pre-open RETURN comparison only. Never replace the original oracle /
// TSM model, compound TSM twice, or imply an unverified USDT/TWD share conversion.
export function taiwanAuctionComparison(quote: TaiwanCashQuote | null | undefined,
  anchor: { price: number; timestamp: number } | null,
  book: { bid: number | null; ask: number | null; timestamp: number | null }, now: number) {
  const empty = (reason: string) => ({ reference: null, deviation: null, trialReturn: null, reason });
  if (!quote) return empty("Waiting for Taiwan cash quote");
  const minute = Math.floor((now + 8 * 3_600_000) % 86_400_000 / 60_000);
  const view = taiwanCashView(quote, now);
  if (minute < 510 || (minute >= 540 && !(quote.isDelayedOpen && minute < 550))) return empty("Pre-open comparison only · 08:30–09:00 HKT");
  if (!view.fresh || quote.isHalted) return empty("Cash quote stale / halted");
  if (!quote.isTrial || !quote.trial || now - quote.trial.timestamp > 120_000) return empty("Waiting for a fresh trial observation");
  if (!quote.previousClose || !quote.referencePrice) return empty("Cash reference price unavailable");
  if (Math.abs(quote.referencePrice / quote.previousClose - 1) > 0.000001) return empty("Adjusted cash reference · corporate-action alignment required");
  if (!anchor || !positive(anchor.price) || anchor.timestamp >= quote.trial.timestamp) return empty("Prior 14:00 oracle unavailable");
  if (!positive(book.bid) || !positive(book.ask) || book.ask! < book.bid! || !book.timestamp
    || now - book.timestamp > 60_000 || book.timestamp > now + 5_000) return empty("Perpetual book stale / incomplete");
  const ratio = quote.trial.price / quote.previousClose;
  const reference = anchor.price * ratio;
  return { reference, deviation: (((book.bid! + book.ask!) / 2) / reference - 1) * 100,
    trialReturn: (ratio - 1) * 100, reason: null };
}
