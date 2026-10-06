type Book = { bid?: number | null; ask?: number | null; last?: number | null };
const valid = (value: number | null | undefined) => value != null && Number.isFinite(value) && value > 0 ? value : null;

// The TSE opening auction publishes books before any new trade. Use those
// books when fresh for every Japanese pair, but retain last as the fallback
// for stale quotes, the lunch break and the closed session.
export function preferCashLast(market: "KRX" | "TSE", session: string, bookUpdatedAt: number | null | undefined, now: number) {
  if (market === "KRX") return session !== "REGULAR" && session !== "AFTER-HOURS";
  const freshBook = bookUpdatedAt != null && Number.isFinite(bookUpdatedAt) && bookUpdatedAt > 0 && now - bookUpdatedAt <= 60_000 && bookUpdatedAt - now < 5_000;
  return session === "CLOSED" || session === "LUNCH" || !freshBook;
}

// Session and freshness describe the basis; they never suppress its value.
export function equityBasis(cash: Book, fx: Book, sharesPerPerp = 1, preferLast = false) {
  const last = valid(cash.last);
  const cashBid = preferLast && last !== null ? last : valid(cash.bid) ?? last;
  const cashAsk = preferLast && last !== null ? last : valid(cash.ask) ?? last;
  const fxBid = valid(fx.bid) ?? valid(fx.last);
  const fxAsk = valid(fx.ask) ?? valid(fx.last);
  return {
    cashBidUsd: cashBid !== null && fxAsk !== null ? cashBid * sharesPerPerp / fxAsk : null,
    cashAskUsd: cashAsk !== null && fxBid !== null ? cashAsk * sharesPerPerp / fxBid : null,
    usesLast: (preferLast && last !== null) || valid(cash.bid) === null || valid(cash.ask) === null,
    usesFxLast: valid(fx.bid) === null || valid(fx.ask) === null,
  };
}

export function equitySpreads(cashBidUsd: number | null, cashAskUsd: number | null, perp: Book) {
  const bid = valid(perp.bid) ?? valid(perp.last);
  const ask = valid(perp.ask) ?? valid(perp.last);
  return {
    buyKoreaSellPerp: cashAskUsd !== null && bid !== null ? (bid / cashAskUsd - 1) * 100 : null,
    buyPerpSellKorea: cashBidUsd !== null && ask !== null ? (cashBidUsd / ask - 1) * 100 : null,
  };
}
