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
export function equityBasis(cash: Book, fx: Book, sharesPerPerp = 1, preferLast = false, bookOnly = false) {
  // Limit-up/down books may legitimately have just one side. Opt-in cash
  // instruments retain that side, without synthesizing the other from a print.
  const last = bookOnly ? null : valid(cash.last);
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

// A synthetic ADR quote from a perp is a unit conversion, never an ADR book.
export function impliedAdrBook(perp: Book, sharesPerPerp: number, sharesPerAdr: number) {
  const ratio = valid(sharesPerPerp) !== null && valid(sharesPerAdr) !== null ? sharesPerAdr / sharesPerPerp : null;
  return {
    bid: ratio !== null && valid(perp.bid) !== null ? Number(perp.bid) * ratio : null,
    ask: ratio !== null && valid(perp.ask) !== null ? Number(perp.ask) * ratio : null,
  };
}

type PerpBook = Book & { sharesPerPerp: number; bidQty: number | null; askQty: number | null; updatedAt: number | null };

// Compare two USDT perps on the same ordinary-share unit. No cash/ADR/FX
// feed or stock-market session is needed. A last trade is never a BBO.
export function perpetualPairBasis(left: PerpBook, right: PerpBook, now: number, maxAgeMs = 60_000) {
  const leftBook = impliedAdrBook(left, left.sharesPerPerp, 1);
  const rightBook = impliedAdrBook(right, right.sharesPerPerp, 1);
  const spreads = equitySpreads(leftBook.bid, leftBook.ask, rightBook);
  const freshBook = (book: PerpBook) => valid(book.sharesPerPerp) !== null && valid(book.bid) !== null && valid(book.ask) !== null && Number(book.bid) <= Number(book.ask)
    && valid(book.bidQty) !== null && valid(book.askQty) !== null && book.updatedAt !== null && book.updatedAt > 0
    && now - book.updatedAt <= maxAgeMs && book.updatedAt - now < 5_000;
  return {
    leftBook, rightBook,
    buyLeftSellRight: spreads.buyKoreaSellPerp,
    buyRightSellLeft: spreads.buyPerpSellKorea,
    live: freshBook(left) && freshBook(right),
  };
}
