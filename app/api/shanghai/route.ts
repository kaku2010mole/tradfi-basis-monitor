export const dynamic = "force-dynamic";

type EastmoneyQuote = {
  f43?: number;
  f57?: string;
  f58?: string;
  f59?: number;
  f60?: number;
  f86?: number;
};

type HistoryPoint = { timestamp: number; price: number };

const INDEX_SECID = "1.000001";
const A50_SECID = "104.CN00Y";
const INDEX_SYMBOL = "SH.000001";
const A50_SYMBOL = "SG.CNmain";
const QUOTE_HOSTS = ["https://push2delay.eastmoney.com", "https://push2.eastmoney.com"];
const HISTORY_HOSTS = ["https://push2his.eastmoney.com", "https://push2his.eastmoney.com"];

const chinaParts = (timestamp: number) => Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp).map((part) => [part.type, part.value]),
);

const chinaDate = (timestamp: number) => {
  const parts = chinaParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const inShanghaiDayWindow = (timestamp: number) => {
  const parts = chinaParts(timestamp);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return minute >= 9 * 60 + 30 && minute <= 15 * 60;
};

async function fetchJson(urls: string[]) {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { "user-agent": "Mozilla/5.0", referer: "https://quote.eastmoney.com/" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Market-data request failed.");
}

async function quote(secid: string): Promise<EastmoneyQuote> {
  const query = `secid=${encodeURIComponent(secid)}&fields=f43,f57,f58,f59,f60,f86`;
  const payload = await fetchJson(QUOTE_HOSTS.map((host) => `${host}/api/qt/stock/get?${query}`));
  if (!payload?.data) throw new Error(`No quote returned for ${secid}.`);
  return payload.data as EastmoneyQuote;
}

async function history(secid: string): Promise<HistoryPoint[]> {
  const params = new URLSearchParams({
    secid,
    klt: "5",
    fqt: "1",
    lmt: "2000",
    end: "20500101",
    fields1: "f1,f2,f3,f4,f5,f6,f7,f8",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
  });
  const payload = await fetchJson(HISTORY_HOSTS.map((host) => `${host}/api/qt/stock/kline/get?${params}`));
  const lines = payload?.data?.klines as string[] | undefined;
  if (!lines?.length) throw new Error(`No five-minute history returned for ${secid}.`);
  return lines.flatMap((line) => {
    const [clock, , close] = line.split(",");
    const timestamp = Date.parse(`${clock.replace(" ", "T")}:00+08:00`);
    const price = Number(close);
    return Number.isFinite(timestamp) && Number.isFinite(price) && price > 0 ? [{ timestamp, price }] : [];
  });
}

const scaledPrice = (raw: number | undefined, decimals: number | undefined) => {
  const value = Number(raw);
  const scale = 10 ** Number(decimals ?? 2);
  return Number.isFinite(value) && value > 0 ? value / scale : null;
};

const findA50Anchor = (points: HistoryPoint[], now: number) =>
  [...points].reverse().find((point) => {
    if (point.timestamp >= now) return false;
    const parts = chinaParts(point.timestamp);
    return Number(parts.hour) === 15 && Number(parts.minute) === 0;
  }) ?? null;

async function snapshot(view: string | null) {
  const now = Date.now();
  const [indexRaw, a50Raw] = await Promise.all([quote(INDEX_SECID), quote(A50_SECID)]);
  const indexPrice = scaledPrice(indexRaw.f43, indexRaw.f59);
  const indexPrevious = scaledPrice(indexRaw.f60, indexRaw.f59);
  const a50Price = scaledPrice(a50Raw.f43, a50Raw.f59);
  const a50Previous = scaledPrice(a50Raw.f60, a50Raw.f59);
  if (indexPrice === null || indexPrevious === null || a50Price === null) {
    throw new Error("Shanghai Composite or A50 price is unavailable.");
  }
  const indexTime = Number(indexRaw.f86) * 1_000 || now;
  const a50Time = Number(a50Raw.f86) * 1_000 || now;
  const indexIsToday = chinaDate(indexTime) === chinaDate(now);
  const useIndex = inShanghaiDayWindow(now) && indexIsToday;
  const a50History = useIndex && view !== "history" ? [] : await history(A50_SECID);
  const a50Anchor = findA50Anchor(a50History, now);
  const referencePrice = useIndex ? indexPrevious : a50Anchor?.price ?? a50Previous;
  if (referencePrice === null) throw new Error("The active reference close is unavailable.");

  const source = useIndex ? "INDEX" as const : "FUTURES" as const;
  const selectedPrice = useIndex ? indexPrice : a50Price;
  const selectedTime = useIndex ? indexTime : a50Time;
  const sourceLabel = useIndex ? "Shanghai Composite" : "Active FTSE China A50 Futures";
  const referenceTime = useIndex
    ? "Previous official Shanghai close"
    : a50Anchor ? `${new Date(a50Anchor.timestamp).toISOString()} · 15:00 Beijing anchor` : "Previous A50 close fallback";
  const changePct = (selectedPrice / referencePrice - 1) * 100;

  if (view === "history") {
    const selectedHistory = useIndex ? await history(INDEX_SECID) : a50History;
    const start = useIndex
      ? Date.parse(`${chinaDate(now)}T09:30:00+08:00`)
      : a50Anchor?.timestamp ?? now - 24 * 60 * 60 * 1_000;
    const points = selectedHistory
      .filter((point) => point.timestamp >= start && point.timestamp <= now)
      .map((point) => ({
        time: new Date(point.timestamp).toISOString(),
        price: point.price,
        changePct: (point.price / referencePrice - 1) * 100,
        source,
      }));
    if (!points.length || selectedTime > Date.parse(points.at(-1)!.time)) {
      points.push({ time: new Date(selectedTime).toISOString(), price: selectedPrice, changePct, source });
    }
    return Response.json({ ok: true, source, sourceLabel, referencePrice, referenceTime, points }, {
      headers: { "cache-control": "no-store" },
    });
  }

  return Response.json({
    ok: true,
    source,
    sourceLabel,
    symbol: useIndex ? INDEX_SYMBOL : A50_SYMBOL,
    price: selectedPrice,
    referencePrice,
    referenceTime,
    referenceTimestamp: a50Anchor ? new Date(a50Anchor.timestamp).toISOString() : null,
    changePct,
    asOf: new Date(selectedTime).toISOString(),
    serverTime: new Date(now).toISOString(),
    sessionLabel: useIndex ? "Shanghai day session" : "Outside Shanghai cash hours",
    stale: Math.abs(now - selectedTime) > 20 * 60 * 1_000,
    ageSeconds: Math.max(0, (now - selectedTime) / 1_000),
    provider: "Eastmoney",
    nightFutures: {
      symbol: A50_SYMBOL,
      price: a50Price,
      asOf: new Date(a50Time).toISOString(),
      ageSeconds: Math.max(0, (now - a50Time) / 1_000),
      ready: true,
      live: Math.abs(now - a50Time) <= 20 * 60 * 1_000,
    },
  }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    return await snapshot(new URL(request.url).searchParams.get("view"));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Shanghai feed unavailable." }, {
      status: 502,
      headers: { "cache-control": "no-store" },
    });
  }
}
