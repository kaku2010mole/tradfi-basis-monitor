type Book = { bid?: number | null; ask?: number | null; last?: number | null };
const valid = (value: number | null | undefined) => value != null && Number.isFinite(value) && value > 0 ? value : null;

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
