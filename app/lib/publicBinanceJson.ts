// Share only concurrent, identical PUBLIC reads, including JSON parsing. There
// is no settled cache/TTL: the next poll always starts a new upstream request.
// Timeout is part of the key, so callers retain their existing deadlines.
const pending = new Map<string, Promise<unknown>>();
const MAX_PENDING = 128;
const PATHS = new Set(["/fapi/v1/ticker/bookTicker", "/fapi/v1/premiumIndex", "/fapi/v1/ticker/24hr"]);

export function publicBinanceJson<T>(url: string, timeoutMs: number): Promise<T> {
  const parsed = new URL(url);
  if (parsed.origin !== "https://fapi.binance.com" || !PATHS.has(parsed.pathname)
    || parsed.username || parsed.password || parsed.hash
    || [...parsed.searchParams.keys()].some((key) => key !== "symbol")) {
    return Promise.reject(new Error("Only public Binance quote reads can be shared."));
  }
  const key = `${timeoutMs}:${url}`;
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const request = (async () => {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as T;
  })();
  // Excess distinct requests still work, but cannot grow the shared map.
  if (pending.size < MAX_PENDING) {
    pending.set(key, request);
    const release = () => { if (pending.get(key) === request) pending.delete(key); };
    request.then(release, release);
  }
  return request;
}
