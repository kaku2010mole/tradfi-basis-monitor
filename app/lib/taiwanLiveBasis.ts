import type { TaiwanCashQuote } from "./taiwanCash";
import { taiwanCashView } from "./taiwanCash";
import type { TaiwanBook } from "./taiwanStockBasis";

export type TaiwanFx = { price: number; timestamp: number; fetchedAt: number; source: string };
export type TaiwanFxFeed = { quote: TaiwanFx | null; error: string | null };
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const recent = (t: number | null | undefined, now: number, age: number) => t != null && t > 0 && now - t <= age && t - now <= 5_000;

export function parseTaiwanFx(data: unknown, now: number): TaiwanFx | null {
  const result = (data as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } })?.chart?.result?.[0];
  const meta = result?.meta;
  if (meta?.symbol !== "TWD=X" || meta.currency !== "TWD" || meta.instrumentType !== "CURRENCY"
    || !positive(meta.regularMarketPrice) || !positive(meta.regularMarketTime)) return null;
  const timestamp = meta.regularMarketTime * 1000;
  if (!recent(timestamp, now, 7 * 86_400_000)) return null;
  return { price: meta.regularMarketPrice, timestamp, fetchedAt: now, source: "Yahoo USD/TWD · indicative" };
}

// Direct price conversion, independent of yesterday's oracle and TSM ADR returns.
// One Taiwan share per quoted perp unit is an explicit, unverified display assumption.
// FX is a mid/last observation, not executable BBO; therefore all edges are indicative.
export function taiwanLiveComparison(quote: TaiwanCashQuote | null | undefined,
  book: TaiwanBook, fx: TaiwanFx | null | undefined, now: number) {
  const view = taiwanCashView(quote, now);
  const validPerp = positive(book.bid) && positive(book.ask) && book.ask >= book.bid;
  const cashBid = quote?.bids[0]?.price, cashAsk = quote?.asks[0]?.price;
  const validCashBook = positive(cashBid) && positive(cashAsk) && cashAsk >= cashBid;
  const isTrial = Boolean(quote?.isTrial);
  const cashPrice = isTrial ? quote?.trial?.price ?? null : validCashBook ? (cashBid + cashAsk) / 2 : quote?.last?.price ?? null;
  const cashTimestamp = isTrial ? quote?.trial?.timestamp : validCashBook ? quote?.timestamp : quote?.last?.timestamp;
  const kind = isTrial ? "TRIAL PRICE" : validCashBook ? "CASH BBO MID" : "LAST CASH TRADE";
  const currentCash = view.fresh && recent(cashTimestamp, now, 120_000);
  const currentPerp = validPerp && recent(book.timestamp, now, 60_000);
  const currentFx = Boolean(fx && positive(fx.price) && recent(fx.timestamp, now, 15 * 60_000) && recent(fx.fetchedAt, now, 120_000));
  const reason = !quote ? "Waiting for cash quote" : quote.isHalted ? "Cash trading halted"
    : !currentCash ? "Cash quote stale / unavailable" : !validPerp ? "Perpetual book incomplete / crossed"
    : !currentPerp ? "Perpetual book stale" : !currentFx ? "USD/TWD stale / unavailable" : null;
  const reference = reason === null && positive(cashPrice) ? cashPrice / fx!.price : null;
  const perpMid = validPerp ? (book.bid! + book.ask!) / 2 : null;
  const deviation = reference !== null && perpMid !== null ? (perpMid / reference - 1) * 100 : null;
  const minute = Math.floor((now + 8 * 3_600_000) % 86_400_000 / 60_000);
  const regular = !isTrial && !quote?.isClose && view.sameDay && minute >= 540 && minute < 810;
  const sides = reference !== null && regular && validCashBook;
  return { kind, isTrial, cashPrice, cashTimestamp, cashBid: validCashBook ? cashBid : null, cashAsk: validCashBook ? cashAsk : null,
    reference, perpMid, deviation, reason, currentFx, currentCash, currentPerp,
    perpTwd: reference !== null ? perpMid! * fx!.price : null,
    buyCashSellPerp: sides ? (book.bid! * fx!.price / cashAsk - 1) * 100 : null,
    buyPerpSellCash: sides ? (cashBid / (book.ask! * fx!.price) - 1) * 100 : null,
    direction: deviation === null ? "COMPARISON UNAVAILABLE" : deviation > 0 ? "PERP RICH" : deviation < 0 ? "PERP CHEAP" : "AT CASH REFERENCE",
    status: reason ? "UNAVAILABLE" : isTrial ? "TRIAL · INDICATIVE" : regular ? "CASH · INDICATIVE" : "CLOSED · INDICATIVE",
  };
}
