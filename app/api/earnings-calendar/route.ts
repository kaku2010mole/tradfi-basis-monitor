import { scanEarnings, type EarningsPayload } from "../../lib/earningsCalendar";

export const dynamic = "force-dynamic";
type Store = typeof globalThis & { __EARNINGS_MONTH_CACHE__?: Map<string, { expires: number; value: EarningsPayload }>; __EARNINGS_MONTH_PENDING__?: Map<string, Promise<EarningsPayload>> };
export async function GET(request: Request) {
  const month = new URL(request.url).searchParams.get("month") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit" }).format(new Date());
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return Response.json({ error: "month must use YYYY-MM" }, { status: 400 });
  const store = globalThis as Store; store.__EARNINGS_MONTH_CACHE__ ??= new Map(); store.__EARNINGS_MONTH_PENDING__ ??= new Map();
  const cached = store.__EARNINGS_MONTH_CACHE__.get(month);
  try {
    if (cached && cached.expires > Date.now()) return Response.json(cached.value, { headers: { "Cache-Control": "no-store" } });
    let pending = store.__EARNINGS_MONTH_PENDING__.get(month);
    if (!pending) {
      pending = scanEarnings(month, cached?.value).then(value => {
        store.__EARNINGS_MONTH_CACHE__!.set(month, { value, expires: Date.now() + (value.warnings.length ? 5 : 15) * 60_000 });
        if (store.__EARNINGS_MONTH_CACHE__!.size > 24) store.__EARNINGS_MONTH_CACHE__!.delete(store.__EARNINGS_MONTH_CACHE__!.keys().next().value!);
        return value;
      }).finally(() => store.__EARNINGS_MONTH_PENDING__!.delete(month));
      store.__EARNINGS_MONTH_PENDING__.set(month, pending);
    }
    return Response.json(await pending, { headers: { "Cache-Control": "no-store" } });
  } catch {
    if (cached) return Response.json({ ...cached.value, events: cached.value.events.map(e => ({ ...e, stale: true })), warnings: [...cached.value.warnings, "Refresh failed; retained last successful scan"] });
    return Response.json({ error: "Earnings calendar unavailable; please retry" }, { status: 502 });
  }
}
