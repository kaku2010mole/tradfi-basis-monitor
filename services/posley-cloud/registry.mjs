// Exact public market-data keys only. No account, balance or position streams.
export const registry = new Map([
  ...["TCEHY", "XIACY", "KSHTY", "MPNGY", "PMRTY", "MMXGY", "LNVGY", "BYDDY", "SONY", "TM", "MUFG"]
    .map(symbol => [`orderbook:ibkr:STK:${symbol}:SMART:USD`, symbol]),
  ...["034020", "035420", "042700", "066570", "454910"]
    .map(code => [`orderbook:ibkr:STK:${code}:KRX:KRW`, code]),
  ...["207940", "000270", "373220", "035720", "105560"]
    .map(code => [`orderbook:futu:web_api:KR.${code}`, code]),
  ...["285A", "5802", "6758", "6857", "6920", "6976", "6981", "7203", "8035", "8306", "9983", "9984"]
    .map(code => [`orderbook:ibkr:STK:${code}:TSEJ:JPY`, code]),
  ["orderbook:ibkr:FX:USD:KRW", "USDKRW"],
  ["orderbook:ibkr:FX:USD:JPY", "USDJPY"],
  ["index_price:hyperliquid:xyz:KRW", "USDKRW"],
]);
export const symbols = [...new Set(registry.values())];
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
function level(value) {
  const first = typeof value === "string" ? value.split("|")[0]?.split(",") : Array.isArray(value) ? value[0] : null;
  return { price: positive(first?.price ?? first?.[0]), size: positive(first?.size ?? first?.qty ?? first?.[1]) };
}
const time = value => { const n = positive(value); return n && n < 10_000_000_000 ? n * 1000 : n; };
export function decode(streamKey, data, now = Date.now()) {
  const symbol = registry.get(streamKey);
  if (!symbol || !data || typeof data !== "object") return null;
  const bid = level(data.bids ?? data.bid), ask = level(data.asks ?? data.ask);
  let details = data.specific_data;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { details = {}; } }
  const stale = details?.stale === true || details?.stale === "true";
  const bookTimes = [data.bids_receive_ts_ms, data.asks_receive_ts_ms].map(time).filter(Boolean);
  const candidates = [data.last_tick_ts_ms, data.local_receive_ts_ms, ...(!stale ? [data.timestamp, data.ts, data.updated_at, data.marketTimestamp] : []), ...bookTimes].map(time).filter(Boolean);
  const isIndex = streamKey.startsWith("index_price:");
  // Never retimestamp a cached/stale stock book from its publication heartbeat.
  if (isIndex) candidates.push(...[data.event_emit_ts_ms].map(time).filter(Boolean));
  const timestamp = !stale && bid.size && ask.size && bookTimes.length ? Math.max(...bookTimes) : Math.max(0, ...candidates);
  const last = positive(data.index_price ?? data.last_price ?? data.mark_price ?? data.last ?? data.price);
  if (!timestamp || timestamp > now + 5_000 || timestamp < now - 7 * 86_400_000) return null;
  if (last === null && (stale || bid.price === null && ask.price === null)) return null;
  return { symbol, streamKey, bid: !stale && bid.size ? bid.price : null, ask: !stale && ask.size ? ask.price : null,
    bidSize: stale ? null : bid.size, askSize: stale ? null : ask.size, last, timestamp,
    source: isIndex ? "Posley cloud · KRW index (indicative)" : "Posley cloud gateway" };
}
