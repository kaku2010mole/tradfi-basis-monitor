import type { TaiwanPayload } from "./taiwanStockBasis";

// Deploy/reconnect responses may be partially hydrated. Retain real observations
// without changing their clocks; the normal freshness checks still apply.
export function mergeTaiwanFeed(prior: TaiwanPayload | null, next: TaiwanPayload): TaiwanPayload {
  const quotes = { ...prior?.cash?.quotes, ...next.cash?.quotes };
  for (const [code, old] of Object.entries(prior?.cash?.quotes ?? {})) {
    if (!quotes[code] || quotes[code].timestamp < old.timestamp) quotes[code] = old;
  }
  const oldFx = prior?.fx?.quote, newFx = next.fx?.quote;
  const oldGdr = prior?.honHaiGdr?.quote, newGdr = next.honHaiGdr?.quote;
  return { ...next,
    rows: next.rows.map(row => {
      const old = prior?.rows.find(item => item.symbol === row.symbol);
      const useful = row.book.bid !== null || row.book.ask !== null || row.book.last !== null;
      return old && (!useful || (old.book.timestamp ?? 0) > (row.book.timestamp ?? 0)) ? { ...row, book: old.book } : row;
    }),
    cash: next.cash ? { ...next.cash, quotes } : prior?.cash,
    fx: next.fx ? { ...next.fx, quote: oldFx && (!newFx || oldFx.timestamp > newFx.timestamp) ? oldFx : newFx ?? null } : prior?.fx,
    honHaiGdr: next.honHaiGdr ? { ...next.honHaiGdr, quote: oldGdr && (!newGdr || oldGdr.timestamp > newGdr.timestamp) ? oldGdr : newGdr ?? null } : prior?.honHaiGdr,
  };
}
