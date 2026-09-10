import { posleyAdrSnapshot } from "../../../lib/posleyAdr";

const BINANCE_FUTURES_APIS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];
const HKT_OFFSET_MS = 8 * 60 * 60_000;
const NIGHT_START_HOUR = 21;
const NIGHT_END_HOUR = 4;
const NIGHT_LENGTH_MS = 7 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 7_000;
const MAX_ADR_CARRY_MS = 5 * 60_000;

type FutuPushStore = typeof globalThis & {
  __FUTU_PUSH_SNAPSHOT__?: {
    payload: {
      quotes?: Array<Record<string, unknown>>;
      history?: Record<string, Array<[number, number]>>;
    };
    receivedAt: number;
  };
  __ADR_PERP_NIGHT_CACHE__?: Map<string, { value: NightPayload; receivedAt: number }>;
};

type BinanceKline = [number, string, string, string, string, ...unknown[]];
type PricePoint = { timestamp: number; price: number; source: "Futu OpenD" | "Yahoo extended hours" };
type BasisPoint = { t: number; value: number; adrPrice: number; perpPrice: number; adrAgeMinutes: number };
type NightPayload = {
  active: boolean;
  adrSymbol: string;
  perpSymbol: string;
  window: { start: number; end: number; label: string };
  points: BasisPoint[];
  latest: BasisPoint | null;
  stats: { open: number; latest: number; low: number; high: number; change: number } | null;
  sources: string[];
  timestamp: number;
};

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const hktParts = (value: number) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

const requestedNight = (now: number) => {
  const parts = hktParts(now);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const totalMinutes = hour * 60 + minute;
  const localMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - HKT_OFFSET_MS;
  const active = totalMinutes >= NIGHT_START_HOUR * 60 || totalMinutes < NIGHT_END_HOUR * 60;
  const start = totalMinutes >= NIGHT_START_HOUR * 60
    ? localMidnight + NIGHT_START_HOUR * 60 * 60_000
    : localMidnight - 3 * 60 * 60_000;
  return { active, start, end: start + NIGHT_LENGTH_MS };
};

const dateLabel = (start: number, end: number) => {
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${format.format(start)} – ${format.format(end)} HKT`;
};

async function yahooHistory(symbol: string) {
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=7d&includePrePost=true&events=div%2Csplits`, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ADR history HTTP ${response.status}`);
  const payload = await response.json() as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
  };
  const series = payload.chart?.result?.[0];
  const timestamps = series?.timestamp ?? [];
  const closes = series?.indicators?.quote?.[0]?.close ?? [];
  return timestamps.flatMap((seconds, index): PricePoint[] => {
    const price = positive(closes[index]);
    return price === null ? [] : [{ timestamp: seconds * 1_000, price, source: "Yahoo extended hours" }];
  });
}

const openDHistory = (symbol: string): PricePoint[] => {
  const pushed = (globalThis as FutuPushStore).__FUTU_PUSH_SNAPSHOT__;
  return (pushed?.payload.history?.[`US.${symbol}`] ?? []).flatMap((point): PricePoint[] => {
    const timestamp = Number(point?.[0]);
    const price = positive(point?.[1]);
    return Number.isFinite(timestamp) && price !== null ? [{ timestamp, price, source: "Futu OpenD" }] : [];
  });
};

async function binanceKlines(symbol: string, start: number, end: number) {
  const query = new URLSearchParams({
    symbol,
    interval: "1m",
    startTime: String(start),
    endTime: String(end),
    limit: "500",
  });
  let message = `${symbol}: Binance history unavailable.`;
  for (const host of BINANCE_FUTURES_APIS) {
    try {
      const response = await fetch(`${host}/fapi/v1/klines?${query}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as BinanceKline[];
      if (!Array.isArray(payload)) throw new Error("invalid response");
      return payload.flatMap((bar) => {
        const timestamp = Number(bar[0]);
        const price = positive(bar[4]);
        return Number.isFinite(timestamp) && price !== null ? [{ timestamp, price }] : [];
      });
    } catch (error) {
      message = `${symbol}: ${error instanceof Error ? error.message : "Binance history unavailable."}`;
    }
  }
  throw new Error(message);
}

const alignBasis = (adr: PricePoint[], perp: Array<{ timestamp: number; price: number }>, perpsPerAdr: number, start: number, end: number) => {
  const adrPoints = adr.filter((point) => point.timestamp >= start - MAX_ADR_CARRY_MS && point.timestamp <= end).sort((a, b) => a.timestamp - b.timestamp);
  const points: BasisPoint[] = [];
  let adrIndex = 0;
  let latestAdr: PricePoint | null = null;
  for (const bar of perp) {
    if (bar.timestamp < start || bar.timestamp > end) continue;
    while (adrIndex < adrPoints.length && adrPoints[adrIndex].timestamp <= bar.timestamp) {
      latestAdr = adrPoints[adrIndex];
      adrIndex += 1;
    }
    if (!latestAdr || bar.timestamp - latestAdr.timestamp > MAX_ADR_CARRY_MS) continue;
    const impliedAdr = bar.price * perpsPerAdr;
    points.push({
      t: bar.timestamp,
      value: (latestAdr.price / impliedAdr - 1) * 100,
      adrPrice: latestAdr.price,
      perpPrice: bar.price,
      adrAgeMinutes: Math.max(0, (bar.timestamp - latestAdr.timestamp) / 60_000),
    });
  }
  return points;
};

const openDLive = (symbol: string) => {
  const pushed = (globalThis as FutuPushStore).__FUTU_PUSH_SNAPSHOT__;
  if (!pushed || Date.now() - pushed.receivedAt > 30_000) return null;
  const quote = pushed.payload.quotes?.find((item) => String(item.symbol ?? item.code).toUpperCase() === `US.${symbol}`);
  if (!quote) return null;
  const bid = positive(quote.bid ?? quote.bidPrice ?? quote.bid_price);
  const ask = positive(quote.ask ?? quote.askPrice ?? quote.ask_price);
  const last = positive(quote.last ?? quote.lastPrice ?? quote.last_price ?? quote.curPrice);
  const price = bid !== null && ask !== null ? (bid + ask) / 2 : last;
  return price === null ? null : { price, timestamp: pushed.receivedAt, source: "Futu OpenD live" };
};

async function binanceLive(symbol: string) {
  const query = new URLSearchParams({ symbol });
  for (const host of BINANCE_FUTURES_APIS) {
    try {
      const response = await fetch(`${host}/fapi/v1/ticker/bookTicker?${query}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const payload = await response.json() as { bidPrice?: string; askPrice?: string };
      const bid = positive(payload.bidPrice);
      const ask = positive(payload.askPrice);
      if (bid !== null && ask !== null) return (bid + ask) / 2;
    } catch { /* Try the next Binance host. */ }
  }
  return null;
}

async function appendLivePoint(points: BasisPoint[], adrSymbol: string, perpSymbol: string, perpsPerAdr: number, start: number, end: number) {
  const now = Date.now();
  if (now < start || now >= end) return { points, source: null as string | null };
  let adr = openDLive(adrSymbol);
  if (!adr) {
    const snapshot = await posleyAdrSnapshot([adrSymbol]);
    const book = snapshot.books[0];
    if (book && now - book.timestamp < 60_000) {
      const price = book.bid !== null && book.ask !== null ? (book.bid + book.ask) / 2 : book.last;
      if (price !== null) adr = { price, timestamp: book.timestamp, source: "Posley ADR live" };
    }
  }
  const perpPrice = await binanceLive(perpSymbol);
  if (!adr || perpPrice === null) return { points, source: null };
  const point = {
    t: now,
    value: (adr.price / (perpPrice * perpsPerAdr) - 1) * 100,
    adrPrice: adr.price,
    perpPrice,
    adrAgeMinutes: Math.max(0, (now - adr.timestamp) / 60_000),
  };
  return { points: [...points.filter((item) => item.t < now - 10_000), point], source: adr.source };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const adrSymbol = url.searchParams.get("adr")?.trim().toUpperCase() ?? "";
  const perpSymbol = url.searchParams.get("perp")?.trim().toUpperCase() ?? "";
  const sharesPerContract = positive(url.searchParams.get("shares"));
  const hkSharesPerAdr = positive(url.searchParams.get("hkshares"));
  if (!/^[A-Z0-9.]{1,16}$/.test(adrSymbol) || !/^[A-Z0-9_]{3,32}USDT$/.test(perpSymbol) || sharesPerContract === null || hkSharesPerAdr === null) {
    return Response.json({ error: "Invalid ADR, perp, or conversion mapping." }, { status: 400 });
  }

  const session = requestedNight(Date.now());
  const cacheKey = `${adrSymbol}:${perpSymbol}:${sharesPerContract}:${hkSharesPerAdr}:${session.start}`;
  const store = globalThis as FutuPushStore;
  const cached = store.__ADR_PERP_NIGHT_CACHE__?.get(cacheKey);
  const cacheMs = session.active ? 30_000 : 5 * 60_000;
  if (cached && Date.now() - cached.receivedAt < cacheMs) return Response.json(cached.value, { headers: { "Cache-Control": "no-store" } });

  try {
    const openD = openDHistory(adrSymbol);
    let fallback: PricePoint[] = [];
    try { fallback = await yahooHistory(adrSymbol); } catch { /* OpenD history may be sufficient. */ }
    const merged = new Map<number, PricePoint>();
    fallback.forEach((point) => merged.set(point.timestamp, point));
    openD.forEach((point) => merged.set(point.timestamp, point));
    const adrHistory = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
    if (!adrHistory.length) throw new Error(`No extended-hours history is available for ${adrSymbol}.`);

    const perpsPerAdr = hkSharesPerAdr / sharesPerContract;
    let selected: { start: number; end: number; points: BasisPoint[] } | null = null;
    for (let offset = 0; offset < 7; offset += 1) {
      const start = session.start - offset * 86_400_000;
      const end = start + NIGHT_LENGTH_MS;
      const perp = await binanceKlines(perpSymbol, start, Math.min(end, Date.now()));
      const points = alignBasis(adrHistory, perp, perpsPerAdr, start, end);
      if (points.length) {
        selected = { start, end, points };
        break;
      }
    }
    if (!selected) throw new Error("No aligned ADR and Binance one-minute prices were found in the latest seven night windows.");

    const isRequestedActiveWindow = session.active && selected.start === session.start;
    const live = isRequestedActiveWindow
      ? await appendLivePoint(selected.points, adrSymbol, perpSymbol, perpsPerAdr, selected.start, selected.end)
      : { points: selected.points, source: null };
    const values = live.points.map((point) => point.value);
    const latest = live.points.at(-1) ?? null;
    const stats = latest ? {
      open: values[0],
      latest: latest.value,
      low: Math.min(...values),
      high: Math.max(...values),
      change: latest.value - values[0],
    } : null;
    const sources = [...new Set([
      ...adrHistory.filter((point) => point.timestamp >= selected!.start && point.timestamp <= selected!.end).map((point) => point.source),
      live.source,
      "Binance USD-M 1m",
    ].filter((source): source is string => Boolean(source)))];
    const value: NightPayload = {
      active: isRequestedActiveWindow,
      adrSymbol,
      perpSymbol,
      window: { start: selected.start, end: selected.end, label: dateLabel(selected.start, selected.end) },
      points: live.points,
      latest,
      stats,
      sources,
      timestamp: Date.now(),
    };
    (store.__ADR_PERP_NIGHT_CACHE__ ??= new Map()).set(cacheKey, { value, receivedAt: Date.now() });
    return Response.json(value, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Night ADR/perp basis is unavailable." }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
