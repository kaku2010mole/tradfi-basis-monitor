import type { RealQuote } from "./japanEstimate";

// Public PTS last trade, NOT a perpetual. Parse only the explicitly dated
// current-price row, never the page header, daily high/low or fetch time.
export function parseKioxiaPts(html: string, now: number): RealQuote | null {
  if (!/<link\b[^>]*rel="canonical"[^>]*href="https:\/\/kabutan\.jp\/stock\/\?code=285A"/i.test(html)) return null;
  const section = html.match(/<div\b[^>]*class="stock_pts_div"[^>]*>([\s\S]*?)<!--stock_pts_div-->/i)?.[1];
  if (!section || !section.includes("https://www.japannext.co.jp/")) return null;
  const row = section.match(/<tr>\s*<th\b[^>]*>現在値<\/th>\s*<td>\s*([\d,]+(?:\.\d+)?)\s*<\/td>\s*<td>\s*\(<time\s+datetime="(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})"/i);
  if (!row) return null;
  const price = Number(row[1].replaceAll(",", "")), timestamp = Date.parse(`${row[2]}T${row[3]}:00+09:00`);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp) || timestamp > now + 5000 || now - timestamp > 7 * 86_400_000) return null;
  return { price, timestamp, kind: "last", delayMinutes: 15, source: "Japannext PTS · Kabutan cash (15-minute delay)" };
}
type Cache = { quote: RealQuote | null; refreshAt: number; pending?: Promise<void> };
const root = globalThis as typeof globalThis & { __JAPAN_PTS_CASH__?: Cache };
export function kioxiaPtsCash(now: number): RealQuote | null {
  const cache = root.__JAPAN_PTS_CASH__ ??= { quote: null, refreshAt: 0 };
  if (!cache.pending && now >= cache.refreshAt) {
    cache.pending = (async () => {
      try {
        const response = await fetch("https://kabutan.jp/stock/?code=285A", { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error("PTS cash unavailable");
        const quote = parseKioxiaPts(await response.text(), Date.now());
        if (quote && (!cache.quote || quote.timestamp >= cache.quote.timestamp)) cache.quote = quote;
      } catch { /* Failed refresh cannot change a quote's date or timestamp. */ }
      finally { cache.refreshAt = Date.now() + 60_000; cache.pending = undefined; }
    })();
  }
  return cache.quote && cache.quote.timestamp <= now + 5000 && now - cache.quote.timestamp <= 7 * 86_400_000 ? cache.quote : null;
}
