import { parseTaiwanFx } from "./taiwanLiveBasis";
import type { TaiwanFxFeed } from "./taiwanLiveBasis";

export function createTaiwanFxClient(options: { fetcher?: typeof fetch; clock?: () => number } = {}) {
  const clock = options.clock ?? (() => Date.now());
  let state: TaiwanFxFeed = { quote: null, error: null };
  let nextAt = 0, pending: Promise<void> | null = null;
  return async (): Promise<TaiwanFxFeed> => {
    if (!pending && clock() >= nextAt) {
      pending = (async () => {
        let delay = 60_000;
        try {
          const response = await (options.fetcher ?? fetch)("https://query1.finance.yahoo.com/v8/finance/chart/TWD%3DX?interval=1m&range=1d", {
            headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, cache: "no-store", signal: AbortSignal.timeout(6_000),
          });
          if (response.status === 429) delay = 300_000;
          if (!response.ok) throw new Error("FX unavailable");
          const quote = parseTaiwanFx(await response.json(), clock());
          if (!quote || state.quote && quote.timestamp < state.quote.timestamp) throw new Error("Invalid FX observation");
          state = { quote, error: null };
        } catch { state = { ...state, error: "USD/TWD temporarily unavailable; last observation retained" }; }
        finally { nextAt = clock() + delay; pending = null; }
      })();
    }
    if (!state.quote && pending) await pending;
    return state;
  };
}

export const taiwanFxSnapshot = createTaiwanFxClient();
