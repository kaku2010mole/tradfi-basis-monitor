import { bitgetBooks } from "./bitgetRelativeMarket";
import { taiwanCashSnapshot } from "./fugleTaiwanMarket";
import { taiwanFxSnapshot } from "./taiwanFxMarket";
import { taiwanLatestCloses } from "./taiwanLatestClose";
import { ADR_FALLBACK_OFFSET_MS, DAY_MS, TAIPEI_OFFSET_MS, TAIWAN_STOCKS, TWSE_2026, adrModelAnchor, fresh, indexAnchorFromCandles, lastReferenceAtOrBefore, latestTaiwanAnchor, latestTaiwanCashClose, parseTaiwanCalendar, positive, previousTaiwanAnchor, taiwanOpeningCutoff } from "./taiwanStockBasis";
import type { AdrReference, Calendar, ReferencePrice, TaiwanPayload, TaiwanRow } from "./taiwanStockBasis";

const memo = new Map<string, { expires: number; pending: Promise<unknown> }>();
function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const prior = memo.get(key);
  if (prior && prior.expires > Date.now()) return prior.pending as Promise<T>;
  const item = { expires: Date.now() + ttl, pending: load() };
  if (memo.size >= 128) memo.delete(memo.keys().next().value!);
  memo.set(key, item);
  // Retry failures after 30s, not every browser's 2s quote refresh.
  void item.pending.catch(() => { item.expires = Date.now() + 30_000; });
  return item.pending;
}

async function calendar(year: number): Promise<Calendar | null> {
  try {
    return await cached(`calendar:${year}`, 12 * 3_600_000, async () => {
      const response = await fetch(`https://www.twse.com.tw/holidaySchedule/holidaySchedule?response=json&queryYear=${year - 1911}`, {
        cache: "no-store", signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`TWSE calendar HTTP ${response.status}`);
      const result = parseTaiwanCalendar(await response.json(), year);
      if (!result) throw new Error("TWSE calendar year or data unavailable");
      return result;
    });
  } catch { return year === TWSE_2026.year ? TWSE_2026 : null; }
}

async function indexAnchor(symbol: string, target: number) {
  return cached(`index:${symbol}:${target}`, 7 * DAY_MS, async () => {
    const params = new URLSearchParams({ symbol, productType: "usdt-futures", granularity: "1m", startTime: String(target - 60_000), endTime: String(target + 60_000), limit: "3" });
    const response = await fetch(`https://api.bitget.com/api/v2/mix/market/history-index-candles?${params}`, { cache: "no-store", signal: AbortSignal.timeout(7_000) });
    if (!response.ok) throw new Error(`Bitget index history HTTP ${response.status}`);
    const payload = await response.json() as { code?: string; data?: unknown[][] };
    const anchor = payload.code === "00000" && Array.isArray(payload.data) ? indexAnchorFromCandles(payload.data, target) : null;
    if (!anchor) throw new Error("Latest trading-day 14:00 index is not available yet (or predates listing). Retrying; no older or substitute anchor used.");
    return anchor;
  });
}

type PushedQuote = { symbol?: string; bid?: number | null; ask?: number | null; last?: number | null; marketTimestamp?: number; source?: string };
type PushStore = typeof globalThis & { __FUTU_PUSH_SNAPSHOT__?: { receivedAt: number; payload: { quotes?: PushedQuote[]; history?: Record<string, Array<[number, number]>>; umcAdrAnchors?: Array<{ price: number; timestamp: number; volume: number }> } } };

function officeUmcAnchors(symbol: string, now: number): ReferencePrice[] {
  if (symbol !== "UMC") return [];
  return ((globalThis as PushStore).__FUTU_PUSH_SNAPSHOT__?.payload.umcAdrAnchors ?? [])
    .filter((point) => point.timestamp + 60_000 <= now && point.timestamp % DAY_MS === 9 * 3_600_000 && positive(point.price) !== null)
    .map((point) => ({ ...point, source: "Futu UMC 1m open · indicative reference" }));
}

function officeAdr(symbol: string, now: number) {
  const payload = (globalThis as PushStore).__FUTU_PUSH_SNAPSHOT__?.payload;
  const points: ReferencePrice[] = (payload?.history?.[`US.${symbol}`] ?? []).flatMap(([t, value]) => {
    const price = positive(value), timestamp = Number(t) + 60_000;
    return price !== null && Number.isFinite(timestamp) && timestamp <= now ? [{ price, timestamp, source: `Futu ${symbol} 1m close` }] : [];
  });
  const quote = payload?.quotes?.find((item) => item.symbol === `US.${symbol}`);
  const bid = positive(quote?.bid), ask = positive(quote?.ask), last = positive(quote?.last);
  const price = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : last;
  const timestamp = Number(quote?.marketTimestamp);
  if (price !== null && timestamp > 0 && timestamp <= now) points.push({ price, timestamp, source: quote?.source || `Futu / office ${symbol} ADR` });
  return points;
}

async function yahooAdr(symbol: string, target: number, openingTarget: number): Promise<ReferencePrice[]> {
  return cached(`adr:${symbol}:${target}:${openingTarget}`, 30_000, async () => {
    // One history request supports both the rolling model and the frozen opening study.
    const params = new URLSearchParams({ interval: "5m", period1: String(Math.floor((Math.min(target, openingTarget) - 4 * DAY_MS) / 1000)), period2: String(Math.floor(Date.now() / 1000)), includePrePost: "true" });
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, cache: "no-store", signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error(`${symbol} ADR history HTTP ${response.status}`);
    const payload = await response.json() as { chart?: { result?: Array<{ meta?: { symbol?: string; currency?: string }; timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; close?: Array<number | null> }> } }> } };
    const series = payload.chart?.result?.[0];
    if (series?.meta?.symbol !== symbol || series.meta.currency !== "USD") throw new Error(`${symbol} ADR history identity invalid`);
    const quote = series.indicators?.quote?.[0];
    const closes = quote?.close ?? [];
    // A 17:00 candle CLOSE belongs to 17:05, not 17:00. Its OPEN is the
    // available boundary observation. Never read a future/incomplete close.
    const boundaryOpens: ReferencePrice[] = (series.timestamp ?? []).flatMap((seconds, i) => {
      const timestamp = seconds * 1000, price = positive(quote?.open?.[i]);
      return price !== null && timestamp <= Date.now() && (timestamp === target || timestamp === target + ADR_FALLBACK_OFFSET_MS)
        ? [{ price, timestamp, source: `Yahoo ${symbol} extended-hours 5m open · indicative` }] : [];
    });
    const points = [...boundaryOpens, ...(series.timestamp ?? []).flatMap((seconds, i) => {
      const price = positive(closes[i]), timestamp = seconds * 1000 + 300_000;
      // Only completed 5m bars, timestamped at their end. Never look past the anchor.
      return price !== null && seconds % 300 === 0 && timestamp <= Date.now()
        ? [{ price, timestamp, source: `Yahoo ${symbol} extended-hours 5m close · indicative` }] : [];
    })];
    if (!points.length) throw new Error(`${symbol} ADR history is empty`);
    return points;
  });
}

const lastAdrPoints = new Map<string, ReferencePrice[]>();
const savedModelAnchors = new Map<string, ReferencePrice>();

async function adrReference(symbol: string, target: number, now: number, cutoffTimestamp: number | null = null, openingTarget: number | null = null): Promise<AdrReference> {
  const key = `${symbol}:${target}`;
  const saved = savedModelAnchors.get(key);
  const office = officeAdr(symbol, now);
  // Anchor-only observations must never be reused as the latest ADR quote or
  // leak into the separate opening study. Prefer Futu over cached ties.
  const anchorOnly = [...officeUmcAnchors(symbol, now), ...(saved ? [saved] : [])];
  let points = office, error: string | null = null;
  const currentOffice = lastReferenceAtOrBefore(office, now);
  if (!adrModelAnchor([...anchorOnly, ...office], target, now).anchor || !fresh(currentOffice?.timestamp, now)
    || openingTarget !== null && !lastReferenceAtOrBefore(office, openingTarget)
    || cutoffTimestamp !== null && !lastReferenceAtOrBefore(office, Math.min(now, cutoffTimestamp))) {
    try {
      const history = await yahooAdr(symbol, target, openingTarget ?? target);
      lastAdrPoints.set(symbol, history);
      points = [...office, ...history];
    } catch (reason) {
      // Keep actual observations, never retimestamp them as a new/live quote.
      points = [...office, ...(lastAdrPoints.get(symbol) ?? [])];
      error = reason instanceof Error ? reason.message : `${symbol} ADR unavailable`;
    }
  }
  const selected = adrModelAnchor([...anchorOnly, ...points], target, now);
  const { anchor } = selected;
  if (anchor) {
    if (savedModelAnchors.size >= 32 && !savedModelAnchors.has(key)) savedModelAnchors.delete(savedModelAnchors.keys().next().value!);
    savedModelAnchors.set(key, anchor);
  }
  const current = lastReferenceAtOrBefore(points, now);
  if (!anchor) error = [error, now < target + ADR_FALLBACK_OFFSET_MS
    ? `${symbol}: 14:00 ADR unavailable; waiting for same-date 17:00 HKT fallback. No old close is used.`
    : `${symbol}: neither 14:00 nor same-date 17:00 HKT ADR is available. No old close is used.`].filter(Boolean).join(" ");
  else if (!current) error = error || `${symbol} ADR current quote unavailable; no other ADR or perpetual substitution.`;
  const preOpen = cutoffTimestamp === null ? null : lastReferenceAtOrBefore(points, Math.min(now, cutoffTimestamp));
  const openingAnchor = openingTarget === null ? null : lastReferenceAtOrBefore(points, openingTarget);
  return { symbol, ...selected, current, preOpen, cutoffTimestamp, openingAnchor, openingAnchorTimestamp: openingTarget, error };
}

let lastBooks: { data: Awaited<ReturnType<typeof bitgetBooks>>; receivedAt: number } | null = null;
const taiwanSymbols = new Set<string>(TAIWAN_STOCKS.map((stock) => stock.symbol));

export async function taiwanSnapshot(now = Date.now(), view: "full" | "prices" = "full", waitForRefresh = false): Promise<TaiwanPayload> {
  const today = new Date(now + TAIPEI_OFFSET_MS);
  const years = [...new Set([today.getUTCFullYear(), new Date(today.getTime() - 40 * DAY_MS).getUTCFullYear(), new Date(today.getTime() + 40 * DAY_MS).getUTCFullYear()])];
  const [calendarResults, tickerResult, cash, fx] = await Promise.all([
    Promise.all(years.map(calendar)),
    bitgetBooks().then((all) => { const data = all.filter((book) => book.symbol && taiwanSymbols.has(book.symbol)); lastBooks = { data, receivedAt: Date.now() }; return { data, error: null }; })
      .catch((reason) => ({ data: lastBooks && now - lastBooks.receivedAt <= 7 * DAY_MS ? lastBooks.data : [], error: reason instanceof Error ? reason.message : "Bitget feed unavailable" })),
    taiwanCashSnapshot({ waitForRefresh }),
    taiwanFxSnapshot({ waitForRefresh }),
  ]);
  const calendars = calendarResults.filter((item): item is Calendar => item !== null);
  const priorAnchor = previousTaiwanAnchor(now, calendars);
  const priorCloseDate = priorAnchor === null ? null : new Date(priorAnchor + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
  const latestClose = latestTaiwanCashClose(now, calendars);
  const latestCloseDate = latestClose === null ? null : new Date(latestClose + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
  const closes = taiwanLatestCloses(cash.quotes, latestCloseDate, priorCloseDate, now);
  const calendarSource = [...new Set(calendars.map((item) => item.source))].join(" + ");
  const books = new Map(tickerResult.data.map((book) => [book.symbol, book]));
  const makeRows = (anchors: Array<{ anchor: ReferencePrice | null; anchorError: string | null }>): TaiwanRow[] => TAIWAN_STOCKS.map((stock, index) => {
    const quote = books.get(stock.symbol);
    return { ...stock, adrSymbol: "adrSymbol" in stock ? stock.adrSymbol : null, ...anchors[index],
      book: { bid: positive(quote?.bidPr), ask: positive(quote?.askPr), last: positive(quote?.lastPr), index: positive(quote?.indexPrice), timestamp: positive(quote?.ts) } };
  });
  // The normal cash/return tabs do not need model candles or ADR history.
  // Keep the full response available for the separately opened historical study
  // and old clients during rolling deployments.
  if (view === "prices") return { rows: makeRows(TAIWAN_STOCKS.map(() => ({ anchor: null, anchorError: null }))),
    anchorTimestamp: null, calendarSource, latestCloseDate, closes, view, tsm: { anchor: null, current: null, error: null },
    cash, fx, error: tickerResult.error, timestamp: Date.now() };
  const anchorTimestamp = latestTaiwanAnchor(now, calendars);
  const [anchors, tsm, umc] = await Promise.all([
    Promise.all(TAIWAN_STOCKS.map(async (stock) => {
      try {
        if (anchorTimestamp === null) throw new Error("Verified Taiwan trading calendar unavailable");
        return { anchor: await indexAnchor(stock.symbol, anchorTimestamp), anchorError: null };
      } catch (reason) { return { anchor: null, anchorError: reason instanceof Error ? reason.message : "Anchor unavailable" }; }
    })),
    anchorTimestamp === null ? Promise.resolve({ symbol: "TSM", anchor: null, current: null, error: "Taiwan anchor date unavailable" }) : adrReference("TSM", anchorTimestamp, now, taiwanOpeningCutoff(now, calendars), previousTaiwanAnchor(now, calendars)),
    anchorTimestamp === null ? Promise.resolve({ symbol: "UMC", anchor: null, current: null, error: "Taiwan anchor date unavailable" }) : adrReference("UMC", anchorTimestamp, now),
  ]);
  return { rows: makeRows(anchors), anchorTimestamp, calendarSource, latestCloseDate, closes, view, tsm, adrs: { TSM: tsm, UMC: umc }, cash, fx, error: tickerResult.error, timestamp: Date.now() };
}
