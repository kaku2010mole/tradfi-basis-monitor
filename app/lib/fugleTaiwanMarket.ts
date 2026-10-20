import { parseTaiwanCash } from "./taiwanCash";
import type { TaiwanCashFeed } from "./taiwanCash";
import { TAIWAN_STOCKS } from "./taiwanStockBasis";

const REFRESH_MS = 60_000;
// One cache and one in-flight batch per server, shared by every browser. The
// free plan allows 60 intraday requests/minute; this uses eight, without WS churn.
export function createTaiwanCashClient(options: {
  getKey: () => string | undefined; fetcher?: typeof fetch; clock?: () => number;
}) {
  const clock = options.clock ?? (() => Date.now());
  let snapshot: TaiwanCashFeed = { configured: false, quotes: {}, errors: {}, checkedAt: null, refreshMs: REFRESH_MS };
  let pending: Promise<TaiwanCashFeed> | null = null;
  let retryAt = 0;
  async function refresh(key: string): Promise<TaiwanCashFeed> {
    let cooldown = REFRESH_MS;
    const errors: Record<string, string> = {};
    const quotes = { ...snapshot.quotes };
    await Promise.all(TAIWAN_STOCKS.map(async ({ code }) => {
      try {
        const response = await (options.fetcher ?? fetch)(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${code}`, {
          headers: { "X-API-KEY": key, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) {
          errors[code] = `Fugle HTTP ${response.status}`;
          if (response.status === 401 || response.status === 403) cooldown = Math.max(cooldown, 300_000);
          if (response.status === 429) {
            const retry = response.headers.get("retry-after");
            const seconds = retry !== null ? Number(retry) : NaN;
            const delay = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - clock() : REFRESH_MS;
            cooldown = Math.max(cooldown, Math.min(3_600_000, Number.isFinite(delay) ? delay : REFRESH_MS));
          }
          return;
        }
        const quote = parseTaiwanCash(await response.json(), code, clock());
        if (!quote) { errors[code] = "Fugle quote identity / timestamp invalid"; return; }
        if (quotes[code] && quotes[code].timestamp > quote.timestamp) { errors[code] = "Out-of-order cash quote retained"; return; }
        quotes[code] = quote;
      } catch {
        // Never forward upstream exception bodies, request headers or the key.
        errors[code] = "Fugle quote temporarily unavailable";
      }
    }));
    const checkedAt = clock();
    retryAt = checkedAt + cooldown;
    snapshot = { configured: true, quotes, errors, checkedAt, refreshMs: REFRESH_MS };
    return snapshot;
  }
  return async function get(): Promise<TaiwanCashFeed> {
    const key = options.getKey()?.trim();
    if (!key) return { configured: false, quotes: {}, errors: {}, checkedAt: null, refreshMs: REFRESH_MS };
    if (!pending && clock() >= retryAt) {
      pending = refresh(key).finally(() => { pending = null; });
    }
    // Once hydrated, keep Bitget's 2s refresh independent of slow cash requests.
    return snapshot.checkedAt === null && pending ? pending : snapshot;
  };
}

export const taiwanCashSnapshot = createTaiwanCashClient({ getKey: () => process.env.FUGLE_API_KEY });
