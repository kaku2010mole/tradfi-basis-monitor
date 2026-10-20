// Bitget listing: https://www.bitget.com/support/articles/12560603897858
// TWSE codes identify the underlying, not a verified contract/share conversion.
export const TAIWAN_STOCKS = [
  { code: "2330", name: "TSMC", chineseName: "台積電", symbol: "TWTSMUSDT", adrSymbol: "TSM" },
  { code: "2308", name: "Delta Electronics", chineseName: "台達電", symbol: "TWDELTAUSDT" },
  { code: "3711", name: "ASE Technology Holding", chineseName: "日月光投控", symbol: "TWASXUSDT" },
  { code: "2303", name: "United Microelectronics", chineseName: "聯電", symbol: "TWUMCUSDT" },
  { code: "2408", name: "Nanya Technology", chineseName: "南亞科", symbol: "NANYAUSDT" },
  { code: "2344", name: "Winbond Electronics", chineseName: "華邦電", symbol: "WINBONDUSDT" },
  { code: "2327", name: "Yageo", chineseName: "國巨", symbol: "YAGEOUSDT" },
  { code: "2492", name: "Walsin Technology", chineseName: "華新科", symbol: "WALSINUSDT" },
] as const;

export const DAY_MS = 86_400_000;
export const TAIPEI_OFFSET_MS = 8 * 3_600_000;
export const QUOTE_MAX_AGE_MS = 60_000;
export type Calendar = { year: number; holidays: string[]; source: string };
export type ReferencePrice = { price: number; timestamp: number; source: string };
export type TaiwanBook = { bid: number | null; ask: number | null; last: number | null; index: number | null; timestamp: number | null };
export type TsmReference = { anchor: ReferencePrice | null; current: ReferencePrice | null; error: string | null; preOpen?: ReferencePrice | null; cutoffTimestamp?: number | null };
export type TaiwanRow = {
  code: string; name: string; chineseName: string; symbol: string; adrSymbol: string | null;
  book: TaiwanBook; anchor: ReferencePrice | null; anchorError: string | null;
};
export type TaiwanPayload = { rows: TaiwanRow[]; anchorTimestamp: number | null; calendarSource: string; tsm: TsmReference; error: string | null; timestamp: number };

// Verified against the TWSE 115-year holiday schedule. Used only if that year's
// official endpoint is unavailable; never silently use weekdays for an unknown year.
export const TWSE_2026: Calendar = { year: 2026, source: "TWSE 2026 published calendar (bundled)", holidays: [
  "2026-01-01", "2026-02-12", "2026-02-13", "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
  "2026-02-27", "2026-02-28", "2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06", "2026-05-01", "2026-06-19",
  "2026-09-25", "2026-09-28", "2026-10-09", "2026-10-10", "2026-10-25", "2026-10-26", "2026-12-25",
] };

export const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const fresh = (timestamp: number | null | undefined, now: number) =>
  timestamp != null && Number.isFinite(timestamp) && timestamp > 0 && now - timestamp <= QUOTE_MAX_AGE_MS && timestamp - now <= 5_000;

export function parseTaiwanCalendar(data: unknown, year: number): Calendar | null {
  const payload = data as { stat?: string; queryYear?: number; data?: unknown[][] } | null;
  if (payload?.stat !== "ok" || Number(payload.queryYear) !== year || !Array.isArray(payload.data) || !payload.data.length) return null;
  const holidays: string[] = [];
  for (const row of payload.data) {
    const date = String(row[0]);
    if (!new RegExp(`^${year}-\\d{2}-\\d{2}$`).test(date)) return null;
    // The holiday endpoint also contains positive trading-day notices.
    if (/開始交易|最後交易/.test(String(row[1]))) continue;
    holidays.push(date);
  }
  return holidays.length ? { year, holidays, source: "TWSE official holiday schedule" } : null;
}

export function previousTaiwanAnchor(now: number, calendars: Calendar[]): number | null {
  if (!Number.isFinite(now)) return null;
  const localMidnight = Math.floor((now + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS;
  for (let days = 1; days <= 40; days++) {
    const date = new Date(localMidnight - days * DAY_MS);
    if ([0, 6].includes(date.getUTCDay())) continue;
    const calendar = calendars.find((item) => item.year === date.getUTCFullYear());
    if (!calendar) return null;
    if (!calendar.holidays.includes(date.toISOString().slice(0, 10))) {
      // Always the prior trading DATE, even after today's 14:00. HKT = Taipei.
      return date.getTime() - TAIPEI_OFFSET_MS + 14 * 3_600_000;
    }
  }
  return null;
}

export function indexAnchorFromCandles(rows: unknown[][], target: number): ReferencePrice | null {
  const row = rows.find((item) => Number(item[0]) === target);
  const price = positive(row?.[1]);
  // Use the 14:00 candle OPEN, not its close or another minute's trade/mark price.
  return price === null ? null : { price, timestamp: target, source: "Bitget index · 14:00 1m open" };
}

// Today's 09:00 on trading days, otherwise the next verified trading day.
// The overnight-study observation is frozen here even if later ADR quotes arrive.
export function taiwanOpeningCutoff(now: number, calendars: Calendar[]): number | null {
  if (!Number.isFinite(now)) return null;
  const midnight = Math.floor((now + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS;
  for (let days = 0; days <= 40; days++) {
    const date = new Date(midnight + days * DAY_MS);
    if ([0, 6].includes(date.getUTCDay())) continue;
    const calendar = calendars.find((item) => item.year === date.getUTCFullYear());
    if (!calendar) return null;
    if (!calendar.holidays.includes(date.toISOString().slice(0, 10))) return date.getTime() - TAIPEI_OFFSET_MS + 9 * 3_600_000;
  }
  return null;
}

export function lastReferenceAtOrBefore(points: ReferencePrice[], target: number, maxAgeMs = 4 * DAY_MS) {
  let latest: ReferencePrice | null = null;
  for (const point of points) {
    if (positive(point.price) !== null && Number.isFinite(point.timestamp) && point.timestamp <= target
      && target - point.timestamp <= maxAgeMs && (!latest || point.timestamp > latest.timestamp)) latest = point;
  }
  return latest;
}

export function taiwanComparison(row: TaiwanRow, tsm: TsmReference, now: number) {
  const bid = positive(row.book.bid), ask = positive(row.book.ask);
  const validBook = bid !== null && ask !== null && ask >= bid;
  const mid = validBook ? (bid + ask) / 2 : positive(row.book.last);
  const anchor = positive(row.anchor?.price);
  const tsmAnchor = positive(tsm.anchor?.price), tsmNow = positive(tsm.current?.price);
  const tsmUsable = tsm.anchor && tsm.current && row.anchor && tsm.anchor.timestamp <= row.anchor.timestamp
    && tsm.current.timestamp >= tsm.anchor.timestamp && tsm.current.timestamp <= now + 5_000
    && now - tsm.current.timestamp <= 4 * DAY_MS;
  const tsmRatio = tsmUsable && tsmAnchor !== null && tsmNow !== null ? tsmNow / tsmAnchor : null;
  const reference = anchor === null ? null : row.adrSymbol ? tsmRatio === null ? null : anchor * tsmRatio : anchor;
  const rawDeviation = reference !== null && mid !== null ? (mid / reference - 1) * 100 : null;
  const deviation = rawDeviation !== null && Math.abs(rawDeviation) < 1e-10 ? 0 : rawDeviation;
  return {
    mid, reference, deviation,
    perpReturn: anchor !== null && mid !== null ? (mid / anchor - 1) * 100 : null,
    tsmReturn: tsmRatio === null ? null : (tsmRatio - 1) * 100,
    sellVsReference: validBook && reference !== null ? (bid / reference - 1) * 100 : null,
    buyVsReference: validBook && reference !== null ? (reference / ask - 1) * 100 : null,
    freshBook: Boolean(validBook && fresh(row.book.timestamp, now)),
    direction: deviation === null ? "Reference unavailable" : deviation > 0 ? "PERP RICH" : deviation < 0 ? "PERP CHEAP" : "AT REFERENCE",
  };
}
