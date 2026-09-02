export const dynamic = "force-dynamic";

type RawQuote = {
  symbol?: string;
  name?: string;
  marketState?: string | null;
  last?: number | null;
  previousClose?: number | null;
  bid?: number | null;
  ask?: number | null;
  marketTimestamp?: number | null;
  exchangeTimestamp?: number | null;
};

type PushPayload = {
  generatedAt?: number;
  quotes?: RawQuote[];
  history?: Record<string, Array<[number, number]>>;
};

type PushStore = typeof globalThis & {
  __FUTU_PUSH_SNAPSHOT__?: { payload: PushPayload; receivedAt: number };
};

const INDEX = "HK.800000";
const FUTURES = "HK.HSImain";
const MAX_PUSH_AGE_MS = 30_000;

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const hktParts = (timestamp: number) => Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp).map((part) => [part.type, part.value]),
);

const inCashSession = (timestamp: number) => {
  const parts = hktParts(timestamp);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return (minute >= 9 * 60 + 30 && minute <= 12 * 60) || (minute >= 13 * 60 && minute <= 16 * 60 + 8);
};

const hktClock = (timestamp: number) => {
  const parts = hktParts(timestamp);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
};

const quoteTime = (quote: RawQuote, fallback: number) =>
  positive(quote.exchangeTimestamp) ?? positive(quote.marketTimestamp) ?? fallback;

const quotePrice = (quote: RawQuote) => {
  const bid = positive(quote.bid);
  const ask = positive(quote.ask);
  return bid !== null && ask !== null ? (bid + ask) / 2 : positive(quote.last);
};

const findFuturesAnchor = (history: Array<[number, number]>, now: number) =>
  [...history].reverse().find(([timestamp, price]) => {
    const clock = hktClock(timestamp);
    return timestamp < now && clock.hour === 16 && clock.minute === 8 && positive(price) !== null;
  }) ?? null;

function snapshot(view: string | null) {
  const now = Date.now();
  const pushed = (globalThis as PushStore).__FUTU_PUSH_SNAPSHOT__;
  if (!pushed || now - pushed.receivedAt > MAX_PUSH_AGE_MS) {
    return Response.json({ error: "Waiting for a fresh Futu OpenD push." }, { status: 503 });
  }
  const quotes = new Map((pushed.payload.quotes ?? []).flatMap((quote) =>
    quote.symbol ? [[quote.symbol, quote] as const] : []
  ));
  const index = quotes.get(INDEX);
  const futures = quotes.get(FUTURES);
  if (!index || !futures) {
    return Response.json({ error: "The Futu relay has not published HSI index and active-futures quotes yet." }, { status: 503 });
  }
  const indexPrice = quotePrice(index);
  const futuresPrice = quotePrice(futures);
  if (indexPrice === null || futuresPrice === null) {
    return Response.json({ error: "HSI index or active-futures price is unavailable." }, { status: 503 });
  }
  const indexTimestamp = quoteTime(index, pushed.receivedAt);
  const futuresTimestamp = quoteTime(futures, pushed.receivedAt);
  const indexClock = hktClock(indexTimestamp);
  const today = hktClock(now).date;
  const indexFresh = indexClock.date === today && Math.abs(now - indexTimestamp) <= 120_000;
  const useIndex = inCashSession(now) && indexFresh;
  const source = useIndex ? "INDEX" as const : "FUTURES" as const;
  const selected = useIndex ? index : futures;
  const selectedPrice = useIndex ? indexPrice : futuresPrice;
  const selectedTime = useIndex ? indexTimestamp : futuresTimestamp;
  const selectedHistory = pushed.payload.history?.[useIndex ? INDEX : FUTURES] ?? [];
  const futuresHistory = pushed.payload.history?.[FUTURES] ?? [];
  const anchor = findFuturesAnchor(futuresHistory, now);
  const referencePrice = useIndex
    ? positive(index.previousClose)
    : anchor ? positive(anchor[1]) : positive(futures.previousClose);
  if (referencePrice === null) {
    return Response.json({ error: "The previous HSI reference close is unavailable." }, { status: 503 });
  }
  const referenceTimestamp = useIndex ? null : anchor?.[0] ?? null;
  const referenceTime = useIndex
    ? "Previous official cash close"
    : referenceTimestamp ? `${new Date(referenceTimestamp).toISOString()} · 16:08 HKT` : "Previous futures close";
  const changePct = (selectedPrice / referencePrice - 1) * 100;
  const sourceLabel = useIndex ? "Hang Seng Index" : "Active HSI Futures";

  if (view === "history") {
    const start = useIndex
      ? Date.parse(`${today}T09:30:00+08:00`)
      : referenceTimestamp ?? now - 36 * 60 * 60 * 1_000;
    const points = selectedHistory
      .filter(([timestamp, price]) => timestamp >= start && timestamp <= now && positive(price) !== null)
      .map(([timestamp, price]) => ({
        time: new Date(timestamp).toISOString(),
        price,
        changePct: (price / referencePrice - 1) * 100,
        source,
      }));
    if (!points.length || selectedTime > Date.parse(points[points.length - 1].time)) {
      points.push({ time: new Date(selectedTime).toISOString(), price: selectedPrice, changePct, source });
    }
    return Response.json({
      ok: true,
      source,
      sourceLabel,
      referencePrice,
      referenceTime,
      points,
    }, { headers: { "cache-control": "no-store" } });
  }

  return Response.json({
    ok: true,
    source,
    sourceLabel,
    symbol: useIndex ? INDEX : FUTURES,
    price: selectedPrice,
    referencePrice,
    referenceTime,
    referenceTimestamp: referenceTimestamp ? new Date(referenceTimestamp).toISOString() : null,
    changePct,
    asOf: new Date(selectedTime).toISOString(),
    serverTime: new Date(now).toISOString(),
    sessionLabel: useIndex ? "Cash session" : "Outside cash session",
    stale: Math.abs(now - selectedTime) > 120_000,
    ageSeconds: Math.max(0, (now - selectedTime) / 1_000),
    nightFutures: {
      symbol: FUTURES,
      price: futuresPrice,
      asOf: new Date(futuresTimestamp).toISOString(),
      ageSeconds: Math.max(0, (now - futuresTimestamp) / 1_000),
      ready: true,
      live: Math.abs(now - futuresTimestamp) <= 120_000,
    },
  }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    return snapshot(new URL(request.url).searchParams.get("view"));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "HSI feed unavailable." }, { status: 502 });
  }
}
