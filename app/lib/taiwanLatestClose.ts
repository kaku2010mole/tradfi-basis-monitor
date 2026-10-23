import { TAIWAN_STOCKS } from "./taiwanStockBasis";
import { taiwanCashClose, type TaiwanCloseReference } from "./taiwanPerpTwd";
import type { TaiwanCashQuote } from "./taiwanCash";

const codes = new Set<string>(TAIWAN_STOCKS.map(stock => stock.code));
const retained: Record<string, TaiwanCloseReference> = {};
let pending: Promise<void> | null = null, refreshAt = 0, checkedDate: string | null = null;

export function parseTaiwanDailyCloses(payload: unknown, now: number): Record<string, TaiwanCloseReference> {
  const result: Record<string, TaiwanCloseReference> = {};
  if (!Array.isArray(payload)) return result;
  for (const row of payload) {
    if (!row || !codes.has(row.Code) || !/^\d{7}$/.test(String(row.Date))) continue;
    const raw = String(row.Date), date = `${Number(raw.slice(0, 3)) + 1911}-${raw.slice(3, 5)}-${raw.slice(5, 7)}`;
    const price = typeof row.ClosingPrice === "string" ? Number(row.ClosingPrice.replaceAll(",", "")) : NaN;
    const observedAt = Date.parse(`${date}T13:30:00+08:00`);
    if (price > 0 && Number.isFinite(price) && observedAt <= now && now - observedAt <= 10 * 86_400_000) {
      result[row.Code] = { price, date, observedAt, source: "TWSE published daily close", adjusted: false };
    }
  }
  return result;
}

export function taiwanLatestCloses(quotes: Record<string, TaiwanCashQuote>, expectedDate: string | null, priorDate: string | null, now: number) {
  const accept = (code: string, ref: TaiwanCloseReference | null) => {
    if (ref && (!retained[code] || ref.date >= retained[code].date)) retained[code] = ref;
  };
  for (const code of codes) accept(code, taiwanCashClose(quotes[code], code, priorDate, now));
  const incomplete = expectedDate && [...codes].some(code => !retained[code] || retained[code].date < expectedDate);
  if (incomplete && !pending && (checkedDate !== expectedDate || now >= refreshAt)) {
    checkedDate = expectedDate;
    // One shared bulk fallback, no extra per-stock browser polling. Never retain
    // the full exchange response or delay the live BBO endpoint for this request.
    pending = Promise.resolve().then(async () => {
      try {
        const response = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error("TWSE closing data unavailable");
        for (const [code, ref] of Object.entries(parseTaiwanDailyCloses(await response.json(), Date.now()))) accept(code, ref);
      } catch { /* Retain the original close date; do not invent today's price. */ }
      finally { refreshAt = Date.now() + 60_000; pending = null; }
    });
  }
  return Object.fromEntries(Object.entries(retained).filter(([, ref]) => ref.observedAt <= now && now - ref.observedAt <= 10 * 86_400_000 && (!expectedDate || ref.date <= expectedDate)));
}
