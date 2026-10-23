import { koreanDate, type KoreanCloseReference } from "./koreanPerpKrw";

const ALLOWED = new Set(["034020", "035420", "042700", "066570", "454910", "0158S0", "207940", "000270", "373220", "035720", "105560"]);
const REFRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;
type Entry = { reference: KoreanCloseReference | null; checkedAt: number; retryAt: number; pending?: Promise<void> };
const cache = new Map<string, Entry>();
const number = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && /^-?[\d,]+(?:\.\d+)?$/.test(value) ? Number(value.replaceAll(",", "")) : NaN;

// Naver's closePrice is the current cash price. The *signed absolute change*
// gives the prior session close; never substitute a perp's 24-hour reference.
export function parseKoreanPreviousClose(payload: unknown, code: string, now: number): KoreanCloseReference | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  if (data.itemCode !== code) return null;
  const direction = String((data.compareToPreviousPrice as { code?: unknown } | undefined)?.code ?? "");
  const sign = ["1", "2"].includes(direction) ? 1 : ["4", "5"].includes(direction) ? -1 : direction === "3" ? 0 : null;
  const price = number(data.closePrice), change = number(data.compareToPreviousClosePrice);
  const observedAt = typeof data.localTradedAt === "string" ? Date.parse(data.localTradedAt) : NaN;
  if (sign === null || !Number.isFinite(price) || price <= 0 || !Number.isFinite(change) || (sign === 0 && change !== 0) ||
      !Number.isFinite(observedAt) || observedAt > now + 5_000 || now - observedAt > 7 * 86400_000) return null;
  const previous = price - sign * Math.abs(change);
  if (!Number.isFinite(previous) || previous <= 0) return null;
  return { price: previous, source: "Naver cash snapshot (derived)", observedAt, sessionDate: koreanDate(observedAt) };
}

export function koreanPreviousClose(code: string, feedPrice: number | null | undefined, feedTime: number | null | undefined, feedSource: string, now: number): KoreanCloseReference | null {
  if (!ALLOWED.has(code)) return null;
  if (typeof feedPrice === "number" && Number.isFinite(feedPrice) && feedPrice > 0 && feedTime && feedTime <= now + 5_000 && now - feedTime <= 7 * 86400_000) {
    return { price: feedPrice, source: `${feedSource} previous close`, observedAt: feedTime, sessionDate: koreanDate(feedTime) };
  }
  let entry = cache.get(code);
  if (!entry) { entry = { reference: null, checkedAt: 0, retryAt: 0 }; cache.set(code, entry); }
  const dayChanged = entry.checkedAt > 0 && koreanDate(entry.checkedAt) !== koreanDate(now);
  if (!entry.pending && now >= entry.retryAt && (dayChanged || now - entry.checkedAt >= REFRESH_MS)) {
    const target = entry;
    // Do not delay the existing quote endpoint or introduce another browser poll.
    target.pending = Promise.resolve().then(async () => {
      try {
        const response = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
        if (!response.ok) throw new Error("Cash close reference unavailable");
        const reference = parseKoreanPreviousClose(await response.json(), code, Date.now());
        if (!reference) throw new Error("Invalid cash close reference");
        target.reference = reference;
        target.checkedAt = Date.now();
      } catch { target.retryAt = Date.now() + RETRY_MS; }
      finally { target.pending = undefined; }
    });
  }
  return entry.reference && now - entry.reference.observedAt <= 7 * 86400_000 ? entry.reference : null;
}
