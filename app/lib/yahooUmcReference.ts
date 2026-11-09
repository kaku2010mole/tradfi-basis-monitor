import { DAY_MS, positive } from "./taiwanStockBasis";
import type { YahooUmcReference, YahooUmcSession } from "./taiwanStockBasis";

type YahooNumber = number | { raw?: number };
type YahooQuote = {
  symbol?: string; currency?: string; marketState?: string; quoteSourceName?: string; overnightMarketSource?: string;
} & Partial<Record<`${YahooUmcSession}Market${"Price" | "Time"}`, YahooNumber>>;

const sessions = ["overnight", "pre", "regular", "post"] as const;
const newYorkTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const raw = (value?: YahooNumber) => typeof value === "number" ? value : value?.raw;

function sessionDate(session: YahooUmcSession, timestamp: number) {
  const parts = newYorkTime.formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  if (session === "overnight") {
    // Trades after 20:00 ET belong to the same session as the following morning.
    if (minute >= 20 * 60) return new Date(Date.parse(date) + DAY_MS).toISOString().slice(0, 10);
    return minute < 4 * 60 ? date : null;
  }
  if (session === "pre") return minute >= 4 * 60 && minute < 9 * 60 + 30 ? date : null;
  if (session === "regular") return minute >= 9 * 60 + 30 && minute < 16 * 60 ? date : null;
  // Yahoo's market state determines whether post-market opened early on a half-day.
  return minute >= 13 * 60 && minute < 20 * 60 ? date : null;
}

function belongsToCurrentSession(session: YahooUmcSession, timestamp: number, now: number) {
  const current = sessionDate(session, now);
  return current !== null && sessionDate(session, timestamp) === current;
}

export function isYahooUmcCurrent(quote: YahooUmcReference, now: number) {
  return quote.marketOpen && belongsToCurrentSession(quote.session, quote.timestamp, now);
}

function quoteFromSession(candidate: YahooQuote, session: YahooUmcSession, now: number): YahooUmcReference | null {
  if (session === "overnight" && !/\bBOATS\b/i.test(candidate.overnightMarketSource ?? candidate.quoteSourceName ?? "")) return null;
  const price = positive(raw(candidate[`${session}MarketPrice`]));
  const seconds = raw(candidate[`${session}MarketTime`]);
  if (price === null || !seconds || !Number.isSafeInteger(seconds)) return null;
  const timestamp = seconds * 1000;
  if (timestamp > now || now - timestamp > 7 * DAY_MS) return null;
  const marketOpen = candidate.marketState === session.toUpperCase() && belongsToCurrentSession(session, timestamp, now);
  return { price, timestamp, session, marketOpen, source: session === "overnight" ? "Yahoo Finance · Blue Ocean ATS overnight" : "Yahoo Finance" };
}

export function parseYahooUmcReference(html: string, now: number): YahooUmcReference | null {
  let latest: YahooUmcReference | null = null;
  // The public quote page embeds the responses for all four sessions.
  for (const [, dataUrl, json] of html.matchAll(/<script\b[^>]*\bdata-sveltekit-fetched\b[^>]*\bdata-url="([^"\s]+)"[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!/^https:\/\/query[12]\.finance\.yahoo\.com\/(?:v7\/finance\/quote\?|v10\/finance\/quoteSummary\/UMC\?)/.test(dataUrl)) continue;
    try {
      const payload = JSON.parse(JSON.parse(json).body) as {
        quoteResponse?: { result?: YahooQuote[] };
        quoteSummary?: { result?: Array<{ price?: YahooQuote }> };
      };
      const candidates = payload.quoteResponse?.result ?? payload.quoteSummary?.result?.map((item) => item.price) ?? [];
      for (const candidate of candidates) {
        if (candidate?.symbol !== "UMC" || candidate.currency !== "USD") continue;
        for (const session of sessions) {
          const quote = quoteFromSession(candidate, session, now);
          if (quote && (!latest || quote.timestamp > latest.timestamp || quote.timestamp === latest.timestamp && quote.marketOpen)) latest = quote;
        }
      }
    } catch { /* One unavailable response does not invalidate the others. */ }
  }
  return latest;
}
