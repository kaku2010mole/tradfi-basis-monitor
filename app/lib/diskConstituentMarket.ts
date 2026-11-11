import { dayKey, zonedTime } from "./smicOpening";
import { getDiskDramHoldings } from "./diskDramHoldings";
import type { BasketHolding, FundHoldings } from "./diskDramHoldings";

const MINUTE = 60_000;
const MAX_AGE = 35 * MINUTE;
const REFRESH_MS = MINUTE;
const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const raw = (value: unknown) => typeof value === "number" ? value : (value as { raw?: number } | null)?.raw;
const agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";

type Anchor = { date: string; at: number };
type Observation = { price: number; at: number; source: string };
type Chart = {
  meta?: { symbol?: string; currency?: string; regularMarketPrice?: number; regularMarketTime?: number;
    currentTradingPeriod?: { regular?: { start?: number; end?: number } } };
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: Array<number | null> }> };
};
export type DiskConstituentRow = {
  symbol: string; name: string; currency: string; diskWeight: number; dramWeight: number;
  basePrice: number | null; baseAt: number | null; price: number | null; at: number | null;
  fxAt: number | null; baseFxAt: number | null; usdReturn: number | null; source: string | null;
  proxy: boolean; reason: string | null;
  reference: string | null;
};
export type DiskConstituentSnapshot = {
  anchorAt: number; calculatedAt: number | null;
  status: "ready" | "partial" | "loading" | "unavailable";
  diskReturn: number | null; dramReturn: number | null;
  coverage: { DISK: number; DRAM: number };
  oldestQuoteAt: number | null;
  holdings: { DISK: { asOf: string; source: string }; DRAM: { asOf: string; source: string } } | null;
  rows: DiskConstituentRow[]; reasons: string[];
};

function venue(symbol: string) {
  if (symbol.endsWith(".KS")) return { zone: "Asia/Seoul", hour: 15, minute: 30 };
  if (symbol.endsWith(".T")) return { zone: "Asia/Tokyo", hour: 15, minute: 30 };
  if (/\.(TW|TWO)$/.test(symbol)) return { zone: "Asia/Taipei", hour: 13, minute: 30 };
  if (/\.(SS|SZ)$/.test(symbol)) return { zone: "Asia/Shanghai", hour: 15, minute: 0 };
  return { zone: "America/New_York", hour: 16, minute: 0 };
}

function parseDailyBase(chart: Chart, symbol: string, currency: string, anchor: Anchor): Observation | null {
  if (chart.meta?.symbol !== symbol || chart.meta.currency !== currency) return null;
  const market = venue(symbol);
  let latest: Observation | null = null;
  for (const [index, stamp] of (chart.timestamp ?? []).entries()) {
    const date = dayKey(stamp * 1000, market.zone);
    if (currency === "USD" && date !== anchor.date) continue;
    const at = zonedTime(date, market.hour, market.minute, market.zone);
    const price = chart.indicators?.quote?.[0]?.close?.[index];
    if (isPrice(price) && at <= anchor.at && anchor.at - at <= 7 * 86_400_000 && (!latest || at > latest.at)) {
      latest = { price, at, source: "Yahoo prior completed local close" };
    }
  }
  return latest;
}

type LocalSession = { start: number; end: number; close: Observation | null };
export function closedConstituentReference(symbol: string, quote: Observation, session: LocalSession | undefined, now: number): string | null {
  if (!session || !Number.isFinite(session.start) || !Number.isFinite(session.end)) return null;
  const market = venue(symbol), today = dayKey(now, market.zone);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (dayKey(session.start, market.zone) < today && weekday !== 0 && weekday !== 6) {
    // Old provider session metadata cannot claim a new trading day is closed.
    const open = zonedTime(today, 9, /\.(SS|SZ)$/.test(symbol) ? 30 : 0, market.zone);
    const close = zonedTime(today, market.hour, market.minute, market.zone);
    if (now >= open && now < close || now >= close && (!session.close || session.close.at < close - MINUTE)) return null;
  }
  if (symbol.endsWith(".T") || /\.(SS|SZ)$/.test(symbol)) {
    const lunchStart = zonedTime(today, 11, 30, market.zone);
    const lunchEnd = zonedTime(today, symbol.endsWith(".T") ? 12 : 13, symbol.endsWith(".T") ? 30 : 0, market.zone);
    if (now >= lunchStart && now < lunchEnd && quote.at >= lunchStart - 35 * MINUTE && quote.at <= now) return "Local lunch break · last actual trade";
  }
  if (now >= session.start && now < session.end) return null;
  const close = session.close;
  if (!close || Math.abs(close.price - quote.price) > Math.max(1e-7, close.price * 1e-8) || quote.at > now || now - close.at > 7 * 86_400_000) return null;
  if (now >= session.end && close.at < session.end - MINUTE) return null;
  return "Local market closed · verified completed-session reference";
}

function yahooQuotes(html: string, symbol: string, anchor: Anchor, now: number) {
  let quote: Observation | null = null, base: Observation | null = null;
  for (const [, url, body] of html.matchAll(/<script\b[^>]*\bdata-sveltekit-fetched\b[^>]*\bdata-url="([^"\s]+)"[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!/^https:\/\/query[12]\.finance\.yahoo\.com\/(?:v7\/finance\/quote\?|v10\/finance\/quoteSummary\/)/.test(url)) continue;
    try {
      const payload = JSON.parse(JSON.parse(body).body);
      const candidates = payload.quoteResponse?.result ?? payload.quoteSummary?.result?.map((item: { price?: unknown }) => item.price) ?? [];
      for (const item of candidates) {
        if (item?.symbol !== symbol || item.currency !== "USD") continue;
        const regularPrice = raw(item.regularMarketPrice), regularAt = raw(item.regularMarketTime);
        if (isPrice(regularPrice) && isPrice(regularAt) && regularAt * 1000 >= anchor.at && regularAt * 1000 <= anchor.at + MINUTE) {
          base = { price: regularPrice, at: anchor.at, source: "Yahoo U.S. regular close" };
        }
        for (const session of ["regular", "pre", "post", "overnight"]) {
          if (session === "overnight" && !/\bBOATS\b/i.test(item.overnightMarketSource ?? item.quoteSourceName ?? "")) continue;
          const price = raw(item[`${session}MarketPrice`]), seconds = raw(item[`${session}MarketTime`]);
          const at = typeof seconds === "number" ? seconds * 1000 : NaN;
          if (isPrice(price) && Number.isFinite(at) && at >= anchor.at && at <= now + 5_000 && (!quote || at > quote.at)) {
            quote = { price, at, source: `Yahoo ${session === "overnight" ? "Blue Ocean ATS overnight" : session + " session"} trade` };
          }
        }
      }
    } catch { /* An unrelated embedded response can be absent. */ }
  }
  return { quote, base };
}

export function createDiskConstituentClient(options: { fetcher?: typeof fetch; clock?: () => number } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const clock = options.clock ?? (() => Date.now());
  const observations = new Map<string, Observation>();
  const baselines = new Map<string, Observation>();
  const localSessions = new Map<string, LocalSession>();
  let state: DiskConstituentSnapshot | null = null;
  let nextRefresh = 0;
  let pending: Promise<void> | null = null;
  let activeAnchor = 0;

  async function request(url: string, format: "json" | "text" = "json") {
    const headers = { "User-Agent": format === "json" ? "Mozilla/5.0" : agent, Accept: format === "json" ? "application/json" : "text/html,application/xhtml+xml" };
    try {
      const response = await fetcher(url, { headers, cache: "no-store", signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`Market reference HTTP ${response.status}`);
      return format === "json" ? response.json() : response.text();
    } catch (error) {
      const overflow = (error as { cause?: { code?: string } }).cause?.code === "UND_ERR_HEADERS_OVERFLOW";
      if (!overflow || format !== "text" || !/^https:\/\/(?:hk\.)?finance\.yahoo\.com\/quote\/[A-Z0-9.-]+\/$/.test(url)) throw error;
      // Yahoo can send more cookie headers than Node fetch's default limit.
      // Scope the larger limit to this public endpoint and bound its body too.
      const https = await import("node:https");
      return new Promise<string>((resolve, reject) => {
        const request = https.get(url, { headers, maxHeaderSize: 128 * 1024 }, (response) => {
          if (response.statusCode !== 200) { response.resume(); reject(new Error("Yahoo public quote unavailable")); return; }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) request.destroy(new Error("Yahoo quote body exceeds limit"));
            else chunks.push(chunk);
          });
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          response.on("error", reject);
        });
        request.setTimeout(5_000, () => request.destroy(new Error("Yahoo quote timed out")));
        request.on("error", reject);
      });
    }
  }

  async function chart(symbol: string, query: string): Promise<Chart | null> {
    for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
      try {
        const payload = await request(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`);
        const result = payload.chart?.result?.[0] as Chart | undefined;
        if (result?.meta?.symbol === symbol || /^[A-Z]{3}=X$/.test(symbol) && result?.meta?.symbol === `USD${symbol}`) return result;
      } catch { /* Try the other Yahoo host. */ }
    }
    return null;
  }

  function retain(key: string, quote: Observation | null) {
    const prior = observations.get(key);
    if (quote && (!prior || quote.at >= prior.at)) observations.set(key, quote);
  }

  async function baseline(symbol: string, currency: string, anchor: Anchor) {
    const key = `${anchor.at}:${symbol}`;
    if (baselines.has(key)) return baselines.get(key)!;
    const result = await chart(symbol, "range=1mo&interval=1d");
    const base = result ? parseDailyBase(result, symbol, currency, anchor) : null;
    if (base) baselines.set(key, base);
    return base;
  }

  async function usQuote(symbol: string, anchor: Anchor) {
    for (const host of ["finance.yahoo.com", "hk.finance.yahoo.com"]) {
      try {
        const html = await request(`https://${host}/quote/${symbol}/`, "text");
        const result = yahooQuotes(html, symbol, anchor, clock());
        if (result.base) baselines.set(`${anchor.at}:${symbol}`, result.base);
        retain(symbol, result.quote);
        if (result.quote && clock() - result.quote.at <= MAX_AGE) return;
      } catch { /* Keep only actual observations and their original clocks. */ }
    }
  }

  async function koreanQuotes(holdings: BasketHolding[]) {
    const symbols = holdings.filter((item) => item.symbol.endsWith(".KS")).map((item) => item.symbol.split(".")[0]);
    if (!symbols.length) return;
    try {
      const result = await request(`https://polling.finance.naver.com/api/realtime/domestic/stock/${symbols.join(",")}`);
      for (const item of result.datas ?? []) {
        const symbol = `${item.itemCode}.KS`, price = Number(item.closePriceRaw ?? String(item.closePrice).replaceAll(",", ""));
        const at = Date.parse(item.localTradedAt);
        if (symbols.includes(item.itemCode) && isPrice(price) && Number.isFinite(at) && at <= clock() + 5_000) retain(symbol, { price, at, source: "Naver KRX cash trade" });
      }
    } catch { /* Yahoo chart metadata remains available as a delayed fallback. */ }
  }

  async function taiwanQuotes(holdings: BasketHolding[]) {
    const targets = holdings.filter((item) => /\.(TW|TWO)$/.test(item.symbol));
    if (!targets.length) return;
    const requested = targets.map(({ symbol }) => `${symbol.endsWith(".TWO") ? "otc" : "tse"}_${symbol.split(".")[0]}.tw`).join("|");
    try {
      const result = await request(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?${new URLSearchParams({ ex_ch: requested, json: "1", delay: "0" })}`);
      for (const item of result.msgArray ?? []) {
        const found = targets.find((target) => target.symbol.split(".")[0] === item.c);
        const trade = isPrice(Number(item.z)) ? item : item.trade;
        const date = String(item.d ?? ""), time = String(trade?.t ?? "");
        const price = Number(trade?.z);
        const at = /^\d{8}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time) ? Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${time}+08:00`) : NaN;
        if (found && isPrice(price) && Number.isFinite(at) && at <= clock() + 5_000) retain(found.symbol, { price, at, source: "TWSE / TPEx MIS cash trade" });
      }
    } catch { /* Missing current trades remain missing rather than using an order quote. */ }
  }

  async function chineseQuotes(holdings: BasketHolding[]) {
    const targets = holdings.filter((item) => /\.(SS|SZ)$/.test(item.symbol));
    if (!targets.length) return;
    try {
      const query = targets.map(({ symbol }) => `${symbol.endsWith(".SS") ? "sh" : "sz"}${symbol.split(".")[0]}`).join(",");
      const text = await request(`https://qt.gtimg.cn/q=${query}`, "text");
      for (const [, market, code, contents] of text.matchAll(/v_(sh|sz)(\d{6})="([^"]*)"/g)) {
        const symbol = `${code}.${market === "sh" ? "SS" : "SZ"}`;
        const fields = contents.split("~"), stamp = fields[30], price = Number(fields[3]);
        const at = /^\d{14}$/.test(stamp ?? "") ? Date.parse(`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}+08:00`) : NaN;
        if (targets.some((target) => target.symbol === symbol) && fields[2] === code && isPrice(price) && Number.isFinite(at) && at <= clock() + 5_000) retain(symbol, { price, at, source: "Tencent A-share cash trade" });
      }
    } catch { /* A failed public quote never advances its market timestamp. */ }
  }

  async function foreignQuote(item: BasketHolding, anchor: Anchor) {
    const result = await chart(item.symbol, "range=1mo&interval=1d");
    const meta = result?.meta, at = Number(meta?.regularMarketTime) * 1000;
    if (result && meta?.currency === item.currency) {
      const base = parseDailyBase(result, item.symbol, item.currency, anchor);
      if (base) baselines.set(`${anchor.at}:${item.symbol}`, base);
      const period = meta.currentTradingPeriod?.regular;
      localSessions.set(item.symbol, { start: Number(period?.start) * 1000, end: Number(period?.end) * 1000,
        close: parseDailyBase(result, item.symbol, item.currency, { date: anchor.date, at: clock() }) });
    }
    if (meta?.currency === item.currency && isPrice(meta.regularMarketPrice) && Number.isFinite(at) && at <= clock() + 5_000) {
      retain(item.symbol, { price: meta.regularMarketPrice, at, source: "Yahoo local cash trade · delayed" });
    }
  }

  async function fx(currency: string, anchor: Anchor) {
    const symbol = `${currency}=X`, key = `${anchor.at}:${symbol}`;
    const result = await chart(symbol, "range=5d&interval=5m");
    if (!result || result.meta?.currency !== currency) return;
    const meta = result.meta, at = Number(meta?.regularMarketTime) * 1000;
    if (meta?.currency === currency && isPrice(meta.regularMarketPrice) && Number.isFinite(at) && at <= clock() + 5_000) retain(symbol, { price: meta.regularMarketPrice, at, source: "Yahoo spot FX reference" });
    if (baselines.has(key)) return;
    let base: Observation | null = null;
    for (const [index, stamp] of (result.timestamp ?? []).entries()) {
      const end = stamp * 1000 + 5 * MINUTE;
      const price = result.indicators?.quote?.[0]?.close?.[index];
      if (isPrice(price) && end <= anchor.at && anchor.at - end <= 40 * MINUTE && (!base || end > base.at)) base = { price, at: end, source: "Yahoo completed 5m FX close at/before anchor" };
    }
    if (base) baselines.set(key, base);
  }

  function build(anchor: Anchor, funds: { DISK: FundHoldings; DRAM: FundHoldings }, holdings: BasketHolding[]) {
    const now = clock();
    const weights = (fund: FundHoldings, symbol: string) => fund.holdings.filter((item) => item.symbol === symbol).reduce((sum, item) => sum + item.weight, 0);
    const rows = holdings.map((item): DiskConstituentRow => {
      const base = baselines.get(`${anchor.at}:${item.symbol}`), quote = observations.get(item.symbol);
      const fxBase = item.currency === "USD" ? { price: 1, at: anchor.at } : baselines.get(`${anchor.at}:${item.currency}=X`);
      const fxQuote = item.currency === "USD" ? { price: 1, at: now } : observations.get(`${item.currency}=X`);
      let reason: string | null = null;
      const reference = item.currency !== "USD" && quote ? closedConstituentReference(item.symbol, quote, localSessions.get(item.symbol), now) : null;
      if (!base) reason = "Anchor stock close unavailable";
      else if (!quote) reason = "Current stock trade unavailable";
      else if (!reference && (quote.at < anchor.at || now - quote.at > MAX_AGE)) reason = "Stock trade exceeds the 35-minute reference window";
      else if (!fxBase) reason = "Anchor FX unavailable";
      else if (!fxQuote || fxQuote.at < anchor.at || now - fxQuote.at > MAX_AGE) reason = "Current FX unavailable or older than 35 minutes";
      const usdReturn = !reason && base && quote && fxBase && fxQuote ? quote.price / base.price * fxBase.price / fxQuote.price - 1 : null;
      return { symbol: item.symbol, name: item.name, currency: item.currency, diskWeight: weights(funds.DISK, item.symbol), dramWeight: weights(funds.DRAM, item.symbol),
        basePrice: base?.price ?? null, baseAt: base?.at ?? null, price: quote?.price ?? null, at: quote?.at ?? null,
        fxAt: item.currency === "USD" ? null : fxQuote?.at ?? null, baseFxAt: item.currency === "USD" ? null : fxBase?.at ?? null,
        usdReturn, source: quote?.source ?? null, proxy: Boolean(item.proxy), reason, reference };
    });
    const available = rows.filter((row) => row.usdReturn !== null);
    const coverage = { DISK: funds.DISK.cashWeight + available.reduce((sum, row) => sum + row.diskWeight, 0), DRAM: funds.DRAM.cashWeight + available.reduce((sum, row) => sum + row.dramWeight, 0) };
    const complete = rows.every((row) => row.usdReturn !== null);
    const reasons = [funds.DISK.warning, funds.DRAM.warning, ...rows.filter((row) => row.reason).map((row) => `${row.symbol}: ${row.reason}`)].filter((reason): reason is string => Boolean(reason));
    const observedTimes = available.flatMap((row) => [row.at, row.fxAt]).filter((value): value is number => value !== null);
    return { anchorAt: anchor.at, calculatedAt: now, status: complete ? "ready" as const : "partial" as const,
      diskReturn: complete ? available.reduce((sum, row) => sum + row.diskWeight * row.usdReturn!, 0) : null,
      dramReturn: complete ? available.reduce((sum, row) => sum + row.dramWeight * row.usdReturn!, 0) : null,
      coverage, oldestQuoteAt: observedTimes.length ? Math.min(...observedTimes) : null,
      holdings: { DISK: { asOf: funds.DISK.asOf, source: funds.DISK.source }, DRAM: { asOf: funds.DRAM.asOf, source: funds.DRAM.source } }, rows, reasons };
  }

  async function refresh(anchor: Anchor) {
    const funds = await getDiskDramHoldings(anchor.date, clock());
    const holdings = [...new Map([...funds.DISK.holdings, ...funds.DRAM.holdings].map((item) => [item.symbol, item])).values()];
    const currencies = [...new Set(holdings.map((item) => item.currency))].filter((currency) => currency !== "USD");
    const requests = [
      koreanQuotes(holdings), taiwanQuotes(holdings), chineseQuotes(holdings),
      ...currencies.map((currency) => fx(currency, anchor)),
      ...holdings.map(async (item) => {
        if (item.currency === "USD") await usQuote(item.symbol, anchor);
        else await foreignQuote(item, anchor);
        await baseline(item.symbol, item.currency, anchor);
      }),
    ];
    await Promise.allSettled(requests);
    if (activeAnchor === anchor.at) state = build(anchor, funds, holdings);
  }

  return function get(anchor: Anchor, now = clock()): DiskConstituentSnapshot {
    if (activeAnchor !== anchor.at) {
      activeAnchor = anchor.at;
      state = null;
      nextRefresh = 0;
      // Baselines from a different U.S. close can never enter the new session.
      baselines.clear();
    }
    if (!pending && now >= nextRefresh) {
      const requestedAnchor = anchor.at;
      nextRefresh = now + REFRESH_MS;
      pending = refresh(anchor).catch(() => {
        if (activeAnchor === requestedAnchor && !state) state = { anchorAt: anchor.at, calculatedAt: clock(), status: "unavailable", diskReturn: null, dramReturn: null, coverage: { DISK: 0, DRAM: 0 }, oldestQuoteAt: null, holdings: null, rows: [], reasons: ["Constituent data temporarily unavailable"] };
      }).finally(() => { pending = null; });
    }
    if (!state) return { anchorAt: anchor.at, calculatedAt: null, status: "loading", diskReturn: null, dramReturn: null, coverage: { DISK: 0, DRAM: 0 }, oldestQuoteAt: null, holdings: null, rows: [], reasons: [] };
    const staleRows = state.rows.filter((row) => row.usdReturn !== null &&
      ((!row.reference && row.at !== null && now - row.at > MAX_AGE) || (row.fxAt !== null && now - row.fxAt > MAX_AGE) ||
        (row.reference && row.at !== null && !closedConstituentReference(row.symbol, { price: row.price!, at: row.at, source: row.source ?? "" }, localSessions.get(row.symbol), now))));
    if (staleRows.length) {
      const stale = new Set(staleRows.map((row) => row.symbol));
      return { ...state, status: "partial", diskReturn: null, dramReturn: null,
        coverage: { DISK: state.coverage.DISK - staleRows.reduce((sum, row) => sum + row.diskWeight, 0), DRAM: state.coverage.DRAM - staleRows.reduce((sum, row) => sum + row.dramWeight, 0) },
        rows: state.rows.map((row) => stale.has(row.symbol) ? { ...row, usdReturn: null, reason: "Quote session or 35-minute reference window expired" } : row),
        reasons: [...state.reasons, "A quote session or reference window expired; awaiting refresh"] };
    }
    return state;
  };
}

export const getDiskConstituentSnapshot = createDiskConstituentClient();
