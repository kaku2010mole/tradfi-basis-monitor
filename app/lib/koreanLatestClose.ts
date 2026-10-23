import { koreanDate, type KoreanCloseReference } from "./koreanPerpKrw";

const ALLOWED = new Set(["034020", "035420", "042700", "066570", "454910", "0158S0", "207940", "000270", "373220", "035720", "105560"]);
const DAY = 86_400_000;
const numeric = (x: unknown) => typeof x === "number" ? x : typeof x === "string" && /^[\d,]+(?:\.\d+)?$/.test(x) ? Number(x.replaceAll(",", "")) : NaN;
const date = (x: unknown) => typeof x === "string" && /^\d{8}$/.test(x) ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}` : null;
const afterClose = (now: number) => (now + 9 * 3_600_000) % DAY >= (15 * 60 + 30) * 60_000;
const phase = (now: number) => `${koreanDate(now)}:${afterClose(now)}`;

// The day chart includes after-hours trades. Only a standard-session 15:30
// closing-auction print may replace the explicitly dated prior-session close.
// Neither currentPrice/basic.closePrice nor the chart's 20:00 end time is a close.
export function parseKoreanLatestClose(payload: unknown, code: string, now: number): KoreanCloseReference | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  if (data.code !== code || data.stockExchangeType !== "KRX" || data.periodType !== "day") return null;
  const today = koreanDate(now), tradeDate = date(data.tradeBaseAt), priorDate = date(data.lastTradeBaseAt);
  let reference: KoreanCloseReference | null = null;
  const prior = numeric(data.lastClosePrice);
  if (priorDate && tradeDate && priorDate < tradeDate && tradeDate <= today && prior > 0 && Number.isFinite(prior)) {
    const observedAt = Date.parse(`${priorDate}T00:00:00+09:00`);
    if (now - observedAt <= 10 * DAY) reference = { price: prior, closeDate: priorDate, sessionDate: priorDate, observedAt, source: "KRX prior-session close · Naver" };
  }
  const standardOpen = typeof data.openTime === "string" && data.openTime === `${data.tradeBaseAt}090000`;
  if (standardOpen && tradeDate && tradeDate <= today && Array.isArray(data.priceInfos)) {
    const closing = data.priceInfos.find((bar: Record<string, unknown>) => bar.localDateTime === `${data.tradeBaseAt}153000`);
    const price = numeric(closing?.currentPrice), observedAt = Date.parse(`${tradeDate}T15:30:00+09:00`);
    if (price > 0 && Number.isFinite(price) && observedAt <= now && now - observedAt <= 10 * DAY) {
      reference = { price, closeDate: tradeDate, sessionDate: tradeDate, observedAt, source: "KRX 15:30 closing print · Naver" };
    }
  }
  if (reference && tradeDate) reference.tradingDate = tradeDate;
  if (reference && tradeDate === today && afterClose(now) && reference.closeDate !== today) reference.pendingCloseDate = today;
  return reference;
}

type Entry = { reference: KoreanCloseReference | null; checkedPhase: string; refreshAt: number; pending?: Promise<void> };
const cache = new Map<string, Entry>();
let active = 0;
const queue: (() => void)[] = [];
async function limited(load: () => Promise<void>) {
  if (active >= 3) await new Promise<void>(resolve => queue.push(resolve));
  else active++;
  try { await load(); } finally { const next = queue.shift(); if (next) next(); else active--; }
}

export function koreanLatestClose(code: string, now: number): KoreanCloseReference | null {
  if (!ALLOWED.has(code)) return null;
  let entry = cache.get(code);
  if (!entry) { entry = { reference: null, checkedPhase: "", refreshAt: 0 }; cache.set(code, entry); }
  if (!entry.pending && (entry.checkedPhase !== phase(now) || now >= entry.refreshAt)) {
    const target = entry;
    target.checkedPhase = phase(now);
    // Non-blocking, shared across viewers, max three simultaneous requests.
    // Retain only one small close record per stock, never the full chart arrays.
    target.pending = Promise.resolve().then(() => limited(async () => {
      let retry = true;
      try {
        const response = await fetch(`https://api.stock.naver.com/chart/domestic/item/${code}?periodType=day`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error("KRX closing print unavailable");
        const next = parseKoreanLatestClose(await response.json(), code, Date.now());
        if (!next) throw new Error("Invalid closing record");
        if (!target.reference || next.closeDate! >= target.reference.closeDate!) target.reference = next;
        retry = Boolean(next.pendingCloseDate) || afterClose(Date.now()) && next.closeDate !== koreanDate(Date.now());
      } catch { /* Keep the actual close date; never promote an old price to today. */ }
      finally { target.refreshAt = Date.now() + (retry ? 60_000 : 10 * 60_000); target.pending = undefined; }
    }));
  }
  const ref = entry.reference;
  if (!ref || now - ref.observedAt > 10 * DAY) return null;
  // The closing boundary must also be visible while an asynchronous refresh is
  // pending or fails; yesterday's price is never silently called today's close.
  return { ...ref, pendingCloseDate: afterClose(now) && ref.tradingDate === koreanDate(now) && ref.closeDate !== koreanDate(now) ? koreanDate(now) : undefined };
}
