import { dayKey, shiftDay, tradingDay, usClose } from "./smicOpening";
import { DISK_DRAM_BETA } from "./relativeValue";
import type { DiskConstituentSnapshot } from "./diskConstituentMarket";
import type { DiskSyntheticNavSnapshot } from "./diskSyntheticNav";

const US_ZONE = "America/New_York";
const MINUTE = 60_000;

export type DiskCashAnchor = { date: string; at: number; disk: number; dram: number };
export type DiskBook = { bid: number; ask: number; mid: number; at: number };
export type DramReference = {
  source: "futu" | "yahoo" | "bitget";
  price: number;
  base: number;
  at: number;
};
export type DiskCashSnapshot = {
  at: number;
  anchor: DiskCashAnchor | null;
  book: DiskBook | null;
  reference: DramReference | null;
  fair: number | null;
  deviation: number | null;
  bidDeviation: number | null;
  askDeviation: number | null;
  syntheticNav?: DiskSyntheticNavSnapshot;
  constituents?: DiskConstituentSnapshot;
  constituentFair: number | null;
  constituentDeviation: number | null;
  constituentBidDeviation: number | null;
  constituentAskDeviation: number | null;
};

type YahooEtfChart = {
  meta?: {
    symbol?: string;
    currency?: string;
    regularMarketTime?: number;
    regularMarketPrice?: number;
    currentTradingPeriod?: { regular?: { end?: number } };
  };
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: Array<number | null> }> };
};

export function latestDiskCashClose(now: number) {
  const today = dayKey(now, US_ZONE);
  for (let i = 0; i < 8; i++) {
    const date = shiftDay(today, -i);
    const session = tradingDay(date, "US");
    if (session === null) return null;
    if (session) {
      const at = usClose(date);
      if (at <= now) return { date, at };
    }
  }
  return null;
}

export function readEtfChart(payload: unknown, symbol: "DISK" | "DRAM") {
  const chart = (payload as { chart?: { result?: YahooEtfChart[] } })?.chart?.result?.[0];
  return chart?.meta?.symbol === symbol && chart.meta.currency === "USD" ? chart : null;
}

const isPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export function regularEtfClose(chart: YahooEtfChart, date: string, at: number) {
  const meta = chart.meta;
  // The daily candle can arrive after the official regular-close snapshot.
  if (Number(meta?.regularMarketTime) * 1000 === at &&
      Number(meta?.currentTradingPeriod?.regular?.end) * 1000 === at &&
      isPrice(meta?.regularMarketPrice)) return meta.regularMarketPrice;
  const index = (chart.timestamp ?? []).findLastIndex((stamp) =>
    Number.isFinite(stamp) && dayKey(stamp * 1000, US_ZONE) === date);
  const close = chart.indicators?.quote?.[0]?.close?.[index];
  return isPrice(close) ? close : null;
}

export function latestDramMinute(chart: YahooEtfChart, now: number, anchorAt: number) {
  let latest: { price: number; at: number } | null = null;
  for (const [i, stamp] of (chart.timestamp ?? []).entries()) {
    const start = stamp * 1000, at = start + MINUTE;
    const price = chart.indicators?.quote?.[0]?.close?.[i];
    if (!isPrice(price) || start % MINUTE !== 0 || at < anchorAt || at > now || now - at > 3 * MINUTE) continue;
    if (!latest || at > latest.at) latest = { price, at };
  }
  return latest;
}

export function diskFairValue(anchor: DiskCashAnchor, reference: DramReference) {
  if (![anchor.disk, reference.price, reference.base].every(isPrice) || reference.at < anchor.at) return null;
  const fair = anchor.disk * (1 + DISK_DRAM_BETA * (reference.price / reference.base - 1));
  return isPrice(fair) ? fair : null;
}

export function diskCashSnapshot(
  at: number, anchor: DiskCashAnchor | null, book: DiskBook | null, reference: DramReference | null,
  constituents?: DiskConstituentSnapshot,
): DiskCashSnapshot {
  const fair = anchor && reference ? diskFairValue(anchor, reference) : null;
  const deviation = (price: number | undefined) => fair && isPrice(price) ? (price / fair - 1) * 100 : null;
  const currentBasket = anchor && reference && constituents?.status === "ready"
    && constituents.anchorAt === anchor.at && typeof constituents.calculatedAt === "number" && constituents.calculatedAt <= at + 5_000
    && at - constituents.calculatedAt <= 120_000
    && Number.isFinite(constituents.diskReturn) && Number.isFinite(constituents.dramReturn)
    && reference.at >= anchor.at && isPrice(reference.price) && isPrice(reference.base);
  // This compares actual return differences with the constituent return difference.
  // It is an independent fair-price scenario, so the fitted beta is not applied twice.
  const adjusted = currentBasket
    ? anchor.disk * (reference.price / reference.base + constituents.diskReturn! - constituents.dramReturn!) : null;
  const constituentFair = isPrice(adjusted) ? adjusted : null;
  const adjustedDeviation = (price: number | undefined) => constituentFair && isPrice(price) ? (price / constituentFair - 1) * 100 : null;
  return {
    at, anchor, book, reference, fair, deviation: deviation(book?.mid), bidDeviation: deviation(book?.bid), askDeviation: deviation(book?.ask),
    constituents, constituentFair, constituentDeviation: adjustedDeviation(book?.mid),
    constituentBidDeviation: adjustedDeviation(book?.bid), constituentAskDeviation: adjustedDeviation(book?.ask),
  };
}
