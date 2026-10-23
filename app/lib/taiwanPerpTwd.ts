import type { TaiwanCashQuote } from "./taiwanCash";
import type { TaiwanBook } from "./taiwanStockBasis";
import type { TaiwanFx } from "./taiwanLiveBasis";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const recent = (time: number | null | undefined, now: number, age: number) => time != null && time > 0 && now - time <= age && time - now <= 5_000;
const localDate = (time: number) => new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);

export type TaiwanCloseReference = { price: number; date: string; source: string; observedAt: number; adjusted: boolean };

export function taiwanCashClose(quote: TaiwanCashQuote | null | undefined, code: string, priorDate: string | null | undefined, now: number): TaiwanCloseReference | null {
  if (!quote || quote.code !== code || !Number.isFinite(now) || !positive(quote.timestamp) || quote.timestamp > now + 5_000 || now - quote.timestamp > 10 * 86_400_000) return null;
  const today = localDate(now);
  if (localDate(quote.timestamp) !== quote.date) return null;
  const last = quote.last;
  const minutes = last ? Math.floor((last.timestamp + 8 * 3_600_000) % 86_400_000 / 60_000) : 0;
  // A completed regular closing auction, including an official delayed close.
  // After-hours fixed-price / odd-lot trades are not a new closing reference.
  if (quote.isClose && !quote.isTrial && !quote.isHalted && last && positive(last.price)
    && positive(last.timestamp) && last.timestamp <= now && last.timestamp <= quote.timestamp + 5_000
    && localDate(last.timestamp) === quote.date && minutes >= 810 && minutes <= 815) {
    return { price: last.price, date: quote.date, source: "Fugle confirmed regular-session close", observedAt: last.timestamp, adjusted: false };
  }
  // Before today's closing record arrives, the dated prior-session close remains
  // valid. Never relabel previousClose as today's close after the boundary.
  if (quote.date === today && priorDate && priorDate < today && positive(quote.previousClose)) {
    return { price: quote.previousClose, date: priorDate, source: "Fugle prior-session close", observedAt: quote.timestamp,
      adjusted: positive(quote.referencePrice) && Math.abs(quote.referencePrice / quote.previousClose - 1) > 0.000001 };
  }
  return null;
}

// Display assumption: one ordinary share per quoted perp unit, USDT ≈ USD.
// Mid/last FX is indicative, not executable BBO. Retained values stay dated.
export function taiwanPerpTwd(book: TaiwanBook, fx: TaiwanFx | null | undefined, previousClose: number | null, now: number) {
  const rate = positive(fx?.price) ? fx.price : null;
  const bidTwd = rate !== null && positive(book.bid) ? book.bid * rate : null;
  const askTwd = rate !== null && positive(book.ask) ? book.ask * rate : null;
  const midpointTwd = bidTwd !== null && askTwd !== null && bidTwd <= askTwd ? (bidTwd + askTwd) / 2 : null;
  const change = (price: number | null) => price !== null && positive(previousClose) ? (price / previousClose - 1) * 100 : null;
  return { bidTwd, askTwd, midpointTwd, bidChangePct: change(bidTwd), askChangePct: change(askTwd), midpointChangePct: change(midpointTwd),
    perpFresh: recent(book.timestamp, now, 60_000),
    fxFresh: rate !== null && recent(fx?.timestamp, now, 15 * 60_000) && recent(fx?.fetchedAt, now, 120_000) };
}
