import type { TaiwanBook } from "./taiwanStockBasis";

// HNHPF is the OTC Reg S GDR, not an ADR. 1 GDR = 2 TWSE 2317 shares.
// https://www.otcmarkets.com/stock/HNHPF/overview
// https://depositaryreceipts.citi.com/adr/guides/pgm_d.aspx?cusip=438090805
export const HON_HAI_GDR = { symbol: "HNHPF", stockCode: "2317", perpSymbol: "HONHAIUSDT", sharesPerGdr: 2 } as const;
export type HonHaiGdrQuote = { symbol: "HNHPF"; bid: number | null; ask: number | null; last: number | null; timestamp: number; source: string };
export type HonHaiGdrFeed = { quote: HonHaiGdrQuote | null; error: string | null; refreshing?: boolean };
const positive = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const validTime = (t: number, now: number) => Number.isFinite(t) && t > 0 && t <= now + 5_000;
const fresh = (t: number | null, now: number) => t !== null && validTime(t, now) && now - t <= 60_000;

export function parseHonHaiGdr(data: unknown, now: number): HonHaiGdrQuote | null {
  const meta = (data as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } })?.chart?.result?.[0]?.meta;
  if (meta?.symbol !== "HNHPF" || meta.currency !== "USD" || meta.instrumentType !== "EQUITY") return null;
  const last = positive(meta.regularMarketPrice), timestamp = Number(meta.regularMarketTime) * 1000;
  if (last === null || !validTime(timestamp, now) || now - timestamp > 7 * 86_400_000) return null;
  // The chart's last trade is NOT a bid/ask, and fetching it does not refresh it.
  return { symbol: "HNHPF", bid: null, ask: null, last, timestamp, source: "Yahoo HNHPF last · indicative / may be delayed" };
}

export function honHaiGdrComparison(symbol: string, book: TaiwanBook, quote: HonHaiGdrQuote | null | undefined, now: number) {
  if (symbol !== HON_HAI_GDR.perpSymbol) return null;
  const bid = positive(book.bid), ask = positive(book.ask);
  const validBook = bid !== null && ask !== null && ask >= bid;
  const impliedBid = validBook ? bid * HON_HAI_GDR.sharesPerGdr : null;
  const impliedAsk = validBook ? ask * HON_HAI_GDR.sharesPerGdr : null;
  const impliedMid = impliedBid !== null && impliedAsk !== null ? (impliedBid + impliedAsk) / 2 : null;
  const correctQuote = quote?.symbol === HON_HAI_GDR.symbol ? quote : null;
  const gdrBid = positive(correctQuote?.bid), gdrAsk = positive(correctQuote?.ask);
  const gdrBook = gdrBid !== null && gdrAsk !== null && gdrAsk >= gdrBid;
  const reference = gdrBook ? (gdrBid + gdrAsk) / 2 : positive(correctQuote?.last);
  const referenceValid = correctQuote && validTime(correctQuote.timestamp, now) && now - correctQuote.timestamp <= 7 * 86_400_000;
  const freshPerp = validBook && fresh(book.timestamp, now);
  const freshReference = Boolean(referenceValid && fresh(correctQuote?.timestamp ?? null, now));
  const currentBooks = Boolean(freshPerp && freshReference && gdrBook);
  const deviation = freshPerp && referenceValid && reference !== null && impliedMid !== null ? (impliedMid / reference - 1) * 100 : null;
  return {
    impliedBid, impliedAsk, reference, deviation, currentBooks,
    // Still indicative: the perp/share multiplier is an explicit assumption.
    buyGdrSellPerp: currentBooks ? (impliedBid! / gdrAsk! - 1) * 100 : null,
    buyPerpSellGdr: currentBooks ? (gdrBid! / impliedAsk! - 1) * 100 : null,
    status: !freshPerp ? "STALE PERP" : !referenceValid || reference === null ? "GDR UNAVAILABLE"
      : currentBooks ? "INDICATIVE BBO" : freshReference ? "LAST REFERENCE" : "STALE REFERENCE",
    direction: deviation === null ? "Waiting for reference" : deviation > 0 ? "PERP RICH" : deviation < 0 ? "PERP CHEAP" : "AT REFERENCE",
  };
}
