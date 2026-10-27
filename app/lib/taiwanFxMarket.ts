import { parseTaiwanFx } from "./taiwanLiveBasis";
import type { TaiwanFxFeed } from "./taiwanLiveBasis";
import { createMarketRefreshLease, waitForMarketRefresh } from "./marketCacheRefresh";
import type { MarketRefreshOptions } from "./marketCacheRefresh";

const REFRESH_MS = 60_000;
const RETRY_MS = [5_000, 15_000, 30_000, 60_000];

export function createTaiwanFxClient(options: { fetcher?: typeof fetch; clock?: () => number } = {}) {
  const clock = options.clock ?? (() => Date.now());
  let state: TaiwanFxFeed = { quote: null, error: null };
  let nextAt = 0, pending: Promise<void> | null = null;
  // Same Yahoo data provider, two endpoints. Each respects its own Retry-After.
  const endpoints = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"].map(host => ({ host, retryAt: 0, failures: 0 }));
  const lease = createMarketRefreshLease(ensureRefresh, clock);
  async function refresh() {
    const errors: string[] = [];
    for (const endpoint of endpoints) {
      if (clock() < endpoint.retryAt) continue;
      let succeeded = false;
      let delay = RETRY_MS[Math.min(endpoint.failures, RETRY_MS.length - 1)];
      try {
        const response = await (options.fetcher ?? fetch)(`https://${endpoint.host}/v8/finance/chart/TWD%3DX?interval=1m&range=1d`, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, cache: "no-store", signal: AbortSignal.timeout(4_000),
        });
        if (!response.ok) {
          if (response.status === 429) {
            const retry = response.headers.get("retry-after");
            const seconds = retry === null ? NaN : Number(retry);
            const requested = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - clock() : NaN;
            delay = Math.max(300_000, Number.isFinite(requested) ? requested : 0);
          }
          errors.push(`HTTP ${response.status}`);
          continue;
        }
        const quote = parseTaiwanFx(await response.json(), clock());
        if (!quote || state.quote && quote.timestamp < state.quote.timestamp) {
          errors.push("invalid / older observation"); continue;
        }
        if (clock() - quote.timestamp > 15 * 60_000) {
          // Retain an actual reference for closed-market display, but try the
          // other endpoint. Never replace its observation time with fetch time.
          if (!state.quote || quote.timestamp > state.quote.timestamp) state = { ...state, quote };
          errors.push("stale observation"); delay = REFRESH_MS; continue;
        }
        state = { quote: { ...quote, source: `Yahoo USD/TWD${endpoint === endpoints[1] ? " · secondary endpoint" : ""} · indicative` }, error: null };
        endpoint.failures = 0;
        endpoint.retryAt = 0;
        nextAt = clock() + REFRESH_MS;
        succeeded = true;
        return;
      } catch {
        errors.push("timeout / transport error");
      } finally {
        if (!succeeded) { endpoint.failures++; endpoint.retryAt = clock() + delay; }
      }
    }
    nextAt = Math.max(clock() + 1_000, Math.min(...endpoints.map(endpoint => endpoint.retryAt)));
    state = { ...state, error: `USD/TWD retrying${errors.length ? ` (${[...new Set(errors)].join("; ")})` : ""}; last observation retained` };
  }
  async function ensureRefresh() {
    if (!pending && clock() >= nextAt) {
      pending = refresh().finally(() => { pending = null; lease.schedule(nextAt); });
    }
    return pending;
  }
  return async (access: MarketRefreshOptions = {}): Promise<TaiwanFxFeed> => {
    lease.touch();
    void ensureRefresh();
    if (!pending) lease.schedule(nextAt);
    if (access.waitForRefresh) await waitForMarketRefresh(pending);
    else if (!state.quote && pending) await pending;
    return { ...state, refreshing: pending !== null, nextRefreshAt: nextAt };
  };
}

export const taiwanFxSnapshot = createTaiwanFxClient();
