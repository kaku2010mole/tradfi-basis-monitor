export type DiskSyntheticNavBase = {
  nav: number;
  date: string;
  at: number;
  source: string;
  holdingsAsOf: string;
  holdingsSource: string;
};

export type DiskSyntheticNavRowInput = {
  symbol: string;
  name: string;
  currency: string;
  weight: number;
  baseNative: number | null;
  baseUsd: number | null;
  baseAt: number | null;
  baseFxPrice: number | null;
  baseFxAt: number | null;
  baseFxReference?: string | null;
  currentNative: number | null;
  currentUsd: number | null;
  fxPrice: number | null;
  fxAt: number | null;
  quoteAt: number | null;
  source: string | null;
  sourceKind: "perp" | "cash";
  perpSymbol: string | null;
  /** Only a verified completed local session/lunch reference may bypass quote age. */
  reference: string | null;
  reason: string | null;
};

export type DiskSyntheticNavRow = DiskSyntheticNavRowInput & {
  grossRatio: number | null;
  /** Raw weight times (grossRatio - 1), before normalizing the weight sum. */
  contribution: number | null;
};

export type DiskSyntheticNavSnapshot = {
  status: "loading" | "ready" | "partial" | "unavailable";
  calculatedAt: number | null;
  base: DiskSyntheticNavBase | null;
  nav: number | null;
  coverage: { total: number; perp: number; cash: number; cashBalance: number };
  oldestQuoteAt: number | null;
  rows: DiskSyntheticNavRow[];
  reasons: string[];
};

export type DiskSyntheticNavInput = {
  now: number;
  calculatedAt: number | null;
  base: DiskSyntheticNavBase | null;
  rows: DiskSyntheticNavRowInput[];
  cashBalanceWeight: number;
  reasons?: string[];
};

export const DISK_SYNTHETIC_NAV_MAX_QUOTE_AGE = 35 * 60_000;
export const DISK_SYNTHETIC_NAV_MAX_SNAPSHOT_AGE = 120_000;
export const DISK_SYNTHETIC_NAV_PERP_MAX_AGE = 45_000;
const MAX_BASE_AGE = 7 * 86_400_000;
const MAX_BASE_FX_LAG = 90 * 60_000;
const CLOCK_SKEW = 5_000;
const isPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const isTime = isPrice;
const isDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
};
const samePrice = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-8);

/** CFETS onshore CNY closes at 03:00 Beijing time, before the U.S. NAV close.
 * Recognize only a completed quote from the final 15 minutes of that exact
 * session. This is a dated closing reference, never a freshly stamped quote.
 * https://www.chinamoney.com.cn/english/rarfmrrudrgl/20221230/2526819.html
 */
export function navDateFxReference(currency: string, quoteAt: number, navAt: number): string | null {
  if (currency !== "CNY" || !isTime(quoteAt) || !isTime(navAt) || quoteAt > navAt) return null;
  const localNav = new Date(navAt + 8 * 3_600_000);
  if (![4, 5].includes(localNav.getUTCHours()) || localNav.getUTCMinutes() !== 0
    || localNav.getUTCSeconds() !== 0 || localNav.getUTCMilliseconds() !== 0) return null;
  const midnight = Date.UTC(localNav.getUTCFullYear(), localNav.getUTCMonth(), localNav.getUTCDate());
  const tradingDay = new Date(midnight - 86_400_000).getUTCDay();
  if (tradingDay === 0 || tradingDay === 6) return null;
  const closeAt = midnight - 5 * 3_600_000;
  return quoteAt <= closeAt && closeAt - quoteAt <= 15 * 60_000
    ? "Onshore CNY closed-session FX · original quote time retained" : null;
}

export function validNavDateFxTime(currency: string, quoteAt: number, navAt: number) {
  return isTime(quoteAt) && isTime(navAt) && quoteAt <= navAt
    && (navAt - quoteAt <= MAX_BASE_FX_LAG || navDateFxReference(currency, quoteAt, navAt) !== null);
}

function verifiedClosedCashReference(row: DiskSyntheticNavRowInput) {
  return row.sourceKind === "cash" && (
    row.reference === "Local market closed · verified completed-session reference"
    || row.reference === "Local lunch break · last actual trade"
  );
}

function rowIssue(row: DiskSyntheticNavRowInput, base: DiskSyntheticNavBase, now: number) {
  if (row.reason) return row.reason;
  if (!row.symbol.trim() || !row.name.trim() || !row.currency.trim()) return "Holding identity unavailable";
  if (!isPrice(row.weight)) return "Holding weight must be positive";
  if (!isPrice(row.baseNative) || !isPrice(row.baseUsd) || !isPrice(row.baseFxPrice)) return "NAV-date native cash valuation or FX unavailable";
  if (!isTime(row.baseAt) || row.baseAt > base.at + CLOCK_SKEW || base.at - row.baseAt > MAX_BASE_AGE) return "NAV-date cash valuation timestamp is invalid";
  if (row.currency !== "USD") {
    if (!isTime(row.baseFxAt) || !validNavDateFxTime(row.currency, row.baseFxAt, base.at)) return "NAV-date FX timestamp is invalid";
  } else if (row.baseFxPrice !== 1) return "USD NAV-date cash valuation must not be converted again";
  if (!samePrice(row.baseUsd, row.baseNative / row.baseFxPrice)) return "NAV-date USD valuation disagrees with native cash price and FX";
  if (!isPrice(row.currentUsd) || !row.source?.trim()) return "Current USD price level or source unavailable";
  if (!isTime(row.quoteAt) || row.quoteAt > now + CLOCK_SKEW || row.quoteAt < row.baseAt) return "Current quote timestamp is invalid";
  if (row.sourceKind === "perp") {
    if (!row.perpSymbol?.trim()) return "Perpetual mapping unavailable";
    if (now - row.quoteAt > DISK_SYNTHETIC_NAV_PERP_MAX_AGE) return "Perpetual quote exceeds the 45-second window";
  } else if (row.sourceKind === "cash") {
    if (now - row.quoteAt > DISK_SYNTHETIC_NAV_MAX_QUOTE_AGE
      && (!verifiedClosedCashReference(row) || now - row.quoteAt > MAX_BASE_AGE)) return "Cash quote exceeds the 35-minute reference window";
    if (!isPrice(row.currentNative) || !isPrice(row.fxPrice)) return "Current native cash price or FX unavailable";
    if (row.currency !== "USD") {
      if (!isTime(row.fxAt) || row.fxAt > now + CLOCK_SKEW || row.fxAt < base.at
        || now - row.fxAt > DISK_SYNTHETIC_NAV_MAX_QUOTE_AGE) return "Current cash FX timestamp is invalid or stale";
    } else if (row.fxPrice !== 1) return "USD cash quote must not be converted again";
    if (!samePrice(row.currentUsd, row.currentNative / row.fxPrice)) return "Current USD cash price disagrees with native price and FX";
  } else return "Current quote source kind is invalid";
  return null;
}

// Implementation is kept pure: market adapters supply native cash NAV-date
// marks and current USD price levels, with their original source timestamps.
export function calculateDiskSyntheticNav(input: DiskSyntheticNavInput): DiskSyntheticNavSnapshot {
  const { now, calculatedAt, base, cashBalanceWeight } = input;
  const reasons = [...(input.reasons ?? [])];
  const coverage = { total: 0, perp: 0, cash: 0, cashBalance: 0 };
  const validBase = base && isPrice(base.nav) && isTime(base.at) && isTime(now)
    && base.at <= now + CLOCK_SKEW && now - base.at <= MAX_BASE_AGE
    && isDate(base.date) && isDate(base.holdingsAsOf) && Boolean(base.source.trim())
    && Boolean(base.holdingsSource.trim());
  if (!validBase) reasons.push("Official NAV baseline or its dated source is unavailable or stale");
  const validCashWeight = typeof cashBalanceWeight === "number" && Number.isFinite(cashBalanceWeight) && cashBalanceWeight >= 0;
  if (validCashWeight) coverage.cashBalance = cashBalanceWeight;
  else reasons.push("Cash balance weight is invalid");
  const validCalculationTime = isTime(now) && isTime(calculatedAt) && calculatedAt <= now + CLOCK_SKEW
    && now - calculatedAt <= DISK_SYNTHETIC_NAV_MAX_SNAPSHOT_AGE
    && (!base || calculatedAt >= base.at);
  if (!validCalculationTime && calculatedAt !== null) reasons.push("Synthetic NAV calculation is stale or has an invalid timestamp");

  let invalidRows = false;
  const symbols = new Set<string>();
  const rows = input.rows.map((row): DiskSyntheticNavRow => {
    let reason = validBase ? rowIssue(row, base, now) : row.reason;
    if (symbols.has(row.symbol)) reason = "Duplicate constituent symbol";
    symbols.add(row.symbol);
    if (!validBase || reason) {
      invalidRows = true;
      if (reason) reasons.push(`${row.symbol}: ${reason}`);
      return { ...row, reason, grossRatio: null, contribution: null };
    }
    const grossRatio = row.currentUsd! / row.baseUsd!;
    const contribution = row.weight * (grossRatio - 1);
    if (!isPrice(grossRatio) || !Number.isFinite(contribution)) {
      invalidRows = true;
      reason = "Constituent revaluation is invalid";
      reasons.push(`${row.symbol}: ${reason}`);
      return { ...row, reason, grossRatio: null, contribution: null };
    }
    coverage[row.sourceKind] += row.weight;
    return { ...row, reason: null, grossRatio, contribution };
  });
  if (!rows.length) reasons.push("Constituent holdings are unavailable");
  coverage.total = coverage.perp + coverage.cash + coverage.cashBalance;
  const totalWeight = input.rows.reduce((sum, row) => sum + row.weight, cashBalanceWeight);
  const validWeightTotal = isPrice(totalWeight) && Math.abs(totalWeight - 1) <= .02;
  if (!validWeightTotal) reasons.push("Disclosed constituent and cash weights do not form a complete NAV basket");
  const hasAllInputs = Boolean(validBase && validCashWeight && validCalculationTime && rows.length && !invalidRows
    && validWeightTotal);
  const rawNav = hasAllInputs ? base!.nav * (1 + rows.reduce((sum, row) => sum + row.contribution!, 0) / totalWeight) : null;
  const nav = isPrice(rawNav) ? rawNav : null;
  const observedTimes = rows.filter((row) => row.grossRatio !== null).flatMap((row) =>
    [row.quoteAt, row.sourceKind === "cash" && row.currency !== "USD" ? row.fxAt : null]
  ).filter((at): at is number => isTime(at));
  return {
    status: nav !== null ? "ready" : calculatedAt === null ? "loading" : !validBase || !rows.length ? "unavailable" : "partial",
    calculatedAt, base, nav, coverage,
    oldestQuoteAt: observedTimes.length ? Math.min(...observedTimes) : null,
    rows, reasons: [...new Set(reasons)],
  };
}

/** Positive percentage means DISK is below the synthetic NAV. */
export function diskSyntheticNavDiscount(price: number | null | undefined, nav: number | null | undefined) {
  return isPrice(price) && isPrice(nav) ? (1 - price / nav) * 100 : null;
}
