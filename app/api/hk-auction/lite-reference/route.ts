const YAHOO_LITE_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/LITE?interval=5m&range=5d&includePrePost=true&events=div%2Csplits";
const CACHE_MS = 60_000;

type CachedAnchor = { price: number; timestamp: number; source: string };
type LiteAnchorGlobal = typeof globalThis & { __LITE_HK_CLOSE_ANCHOR__?: { value: CachedAnchor; receivedAt: number } };

const hktParts = (value: number) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

const targetHkClose = (now: number) => {
  const parts = hktParts(now);
  let cursor = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 8, 0, 0);
  const afterClose = Number(parts.hour) > 16 || (Number(parts.hour) === 16 && Number(parts.minute) >= 0);
  if (!afterClose) cursor -= 86_400_000;
  while ([0, 6].includes(new Date(cursor + 8 * 60 * 60_000).getUTCDay())) cursor -= 86_400_000;
  return cursor;
};

const validPrice = (value: unknown) => {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
};

async function readAnchor() {
  const root = globalThis as LiteAnchorGlobal;
  if (root.__LITE_HK_CLOSE_ANCHOR__ && Date.now() - root.__LITE_HK_CLOSE_ANCHOR__.receivedAt < CACHE_MS) {
    return root.__LITE_HK_CLOSE_ANCHOR__.value;
  }
  const response = await fetch(YAHOO_LITE_CHART, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`LITE history HTTP ${response.status}`);
  const payload = await response.json() as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
  };
  const series = payload.chart?.result?.[0];
  const timestamps = series?.timestamp ?? [];
  const closes = series?.indicators?.quote?.[0]?.close ?? [];
  const target = targetHkClose(Date.now());
  const points = timestamps.flatMap((seconds, index) => {
    const price = validPrice(closes[index]);
    return price === null ? [] : [{ timestamp: seconds * 1_000, price }];
  });
  const nearby = points.filter((point) => Math.abs(point.timestamp - target) <= 90 * 60_000)
    .sort((left, right) => Math.abs(left.timestamp - target) - Math.abs(right.timestamp - target));
  const fallback = points.filter((point) => point.timestamp <= target).at(-1);
  const selected = nearby[0] ?? fallback;
  if (!selected) throw new Error("No LITE trade was available around the latest 16:00 HKT close.");
  const value = { ...selected, source: "5m extended-hours bar" };
  root.__LITE_HK_CLOSE_ANCHOR__ = { value, receivedAt: Date.now() };
  return value;
}

export async function GET() {
  try {
    return Response.json({ anchor: await readAnchor(), timestamp: Date.now() }, {
      headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=90" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "LITE close-time benchmark unavailable." }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
