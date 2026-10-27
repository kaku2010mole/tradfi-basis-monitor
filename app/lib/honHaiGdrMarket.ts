import { parseHonHaiGdr } from "./honHaiGdr";
import type { HonHaiGdrFeed, HonHaiGdrQuote } from "./honHaiGdr";

type PushedQuote = { symbol?: string; bid?: number | null; ask?: number | null; last?: number | null; marketTimestamp?: number; source?: string };
type PushStore = typeof globalThis & { __FUTU_PUSH_SNAPSHOT__?: { payload: { quotes?: PushedQuote[] } } };
export function pushedHonHaiGdr(now: number): HonHaiGdrQuote | null {
  // Only consume a genuine existing push; no OAuth, new socket or guessed key.
  const q = (globalThis as PushStore).__FUTU_PUSH_SNAPSHOT__?.payload.quotes?.find(item => item.symbol === "US.HNHPF");
  const timestamp = Number(q?.marketTimestamp);
  if (!q || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 5_000 || now - timestamp > 7 * 86_400_000) return null;
  const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
  const bid = positive(q.bid), ask = positive(q.ask), last = positive(q.last);
  const bbo = bid !== null && ask !== null && ask >= bid;
  if (!bbo && last === null) return null;
  return { symbol: "HNHPF", bid: bbo ? bid : null, ask: bbo ? ask : null, last, timestamp, source: q.source || "Office / Futu HNHPF" };
}

export function createHonHaiGdrClient(options: { fetcher?: typeof fetch; clock?: () => number; pushed?: (now: number) => HonHaiGdrQuote | null } = {}) {
  const clock = options.clock ?? (() => Date.now());
  let quote: HonHaiGdrQuote | null = null, error: string | null = null;
  let nextAt = 0, pending: Promise<void> | null = null;
  async function refresh() {
    let delay = 60_000;
    try {
      const response = await (options.fetcher ?? fetch)("https://query1.finance.yahoo.com/v8/finance/chart/HNHPF?interval=5m&range=5d&includePrePost=true", {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, cache: "no-store", signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) {
        if (response.status === 429) {
          const raw = response.headers.get("retry-after"), seconds = raw === null ? NaN : Number(raw);
          const requested = Number.isFinite(seconds) ? seconds * 1000 : raw ? Date.parse(raw) - clock() : 0;
          delay = Math.max(300_000, Number.isFinite(requested) ? requested : 0);
        }
        throw new Error(`HNHPF HTTP ${response.status}`);
      }
      const next = parseHonHaiGdr(await response.json(), clock());
      if (!next) throw new Error("HNHPF invalid / unavailable observation");
      if (!quote || next.timestamp > quote.timestamp) quote = next;
      error = null;
    } catch {
      // Never expose upstream bodies or change the clock of a retained price.
      error = "HNHPF quote unavailable; last observation retained";
    } finally { nextAt = clock() + delay; }
  }
  return (): HonHaiGdrFeed => {
    const now = clock(), pushed = (options.pushed ?? pushedHonHaiGdr)(now);
    if (pushed && (!quote || pushed.timestamp >= quote.timestamp)) quote = pushed;
    if (pushed && now - pushed.timestamp <= 60_000) error = null;
    else if (!pending && now >= nextAt) pending = refresh().finally(() => { pending = null; });
    // Never block the 2s perp poll on OTC latency, even on a cold cache.
    return { quote, error, refreshing: pending !== null };
  };
}

export const honHaiGdrSnapshot = createHonHaiGdrClient();
