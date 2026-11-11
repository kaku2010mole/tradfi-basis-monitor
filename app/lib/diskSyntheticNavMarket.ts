import reviewed from "../data/diskSyntheticNavSeed.json";
import { parseDiskHoldings, type BasketHolding, type FundHoldings } from "./diskDramHoldings";
import { closedConstituentReference } from "./diskConstituentMarket";
import { dayKey, usClose, zonedTime } from "./smicOpening";
import { calculateDiskSyntheticNav, DISK_SYNTHETIC_NAV_PERP_MAX_AGE,
  type DiskSyntheticNavBase, type DiskSyntheticNavRowInput, type DiskSyntheticNavSnapshot } from "./diskSyntheticNav";

const DAY = 86_400_000, MINUTE = 60_000;
const PAGE = "https://temaetfs.com/disk";
const QUOTE_MAX_AGE = 35 * MINUTE;
const isPrice = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const num = (x: unknown) => Number(String(x ?? "").replaceAll(",", ""));
const future = (at: number, now: number) => !Number.isFinite(at) || at > now + 5_000;
export const DISK_SYNTHETIC_NAV_PERPS: Readonly<Record<string, string>> = {
  "000660.KS": "SKHYNIXUSDT", SNDK: "SNDKUSDT", "285A.T": "KIOXIAUSDT", MU: "MUUSDT",
  "688825.SS": "CXMTUSDT", "005930.KS": "SAMSUNGUSDT", "2408.TW": "NANYAUSDT",
  AEHR: "AEHRUSDT", "2344.TW": "WINBONDUSDT", WDC: "WDCUSDT", STX: "STXSTOCKUSDT",
  SKHY: "SKHYUSDT", "603986.SS": "GIGADEVICEUSDT",
};
type IssuerNav = { nav: number; date: string; at: number; source: string };
type Observation = { price: number; at: number; source: string };
type Session = { start: number; end: number; close: Observation | null };
type Baseline = { currency: string; native: number; at: number; fx: number; fxAt: number; source?: string };
type Seed = { nav: IssuerNav; holdings: FundHoldings; baselines: Record<string, Baseline>; warning?: string };
type Meta = { nav: IssuerNav; holdings: FundHoldings; reasons: string[] };
type Chart = { meta?: { symbol?: string; currency?: string; regularMarketPrice?: number; regularMarketTime?: number;
  currentTradingPeriod?: { regular?: { start?: number; end?: number } } };
  timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const plain = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
function dateIn(text: string) {
  const m = /\bAs of\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const date = `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return dayKey(Date.parse(`${date}T12:00:00Z`), "UTC") === date ? date : null;
}
export function parseTemaSyntheticNav(html: string, now: number): IssuerNav | null {
  const text = plain(html), index = text.search(/DISK\s+NAV\s*\/\s*Market Price/i);
  if (index < 0) return null;
  const priceBlock = text.slice(index, index + 5_000), date = dateIn(priceBlock);
  const published = num(/\bNAV\s*\$\s*([\d,]+(?:\.\d+)?)/i.exec(priceBlock)?.[1]);
  if (!date || !isPrice(published)) return null;
  const at = usClose(date);
  if (future(at, now) || now - at > 7 * DAY) return null;
  let nav = published;
  const detailsIndex = text.search(/Fund Details/i);
  if (detailsIndex >= 0) {
    const detail = text.slice(detailsIndex, Math.min(index, detailsIndex + 12_000));
    const assets = num(/\bAUM\s*\$\s*([\d,]+(?:\.\d+)?)/i.exec(detail)?.[1]);
    const shares = num(/\bShares Outstanding\s+([\d,]+(?:\.\d+)?)/i.exec(detail)?.[1]);
    // AUM and unit count are used only from the same dated issuer section and
    // only when their ratio agrees with the displayed NAV's rounding interval.
    if (dateIn(detail) === date && isPrice(assets) && isPrice(shares) && Math.abs(assets / shares - published) <= .00500001) nav = assets / shares;
  }
  return { nav, date, at, source: PAGE };
}
export function parseSyntheticNavBitgetQuotes(payload: unknown, now: number) {
  const result = payload as { code?: string; data?: Array<Record<string, unknown>> };
  const quotes = new Map<string, Observation>();
  if (result.code !== "00000" || !Array.isArray(result.data)) return quotes;
  const wanted = new Set(Object.values(DISK_SYNTHETIC_NAV_PERPS));
  for (const item of result.data) {
    const symbol = String(item.symbol), bid = num(item.bidPr), ask = num(item.askPr), at = num(item.ts);
    if (!wanted.has(symbol) || !isPrice(bid) || !isPrice(ask) || ask < bid ||
        !isPrice(num(item.bidSz)) || !isPrice(num(item.askSz)) || future(at, now) || now - at > DISK_SYNTHETIC_NAV_PERP_MAX_AGE) continue;
    quotes.set(symbol, { price: (bid + ask) / 2, at, source: "Bitget stock perpetual bid/ask midpoint · USD(T)" });
  }
  return quotes;
}
export function syntheticNavHoldingsComplete(fund: FundHoldings, html: string, reviewedStockCount = reviewed.holdings.holdings.length) {
  const declared = num(/#\s*of Holdings\s+(\d+)/i.exec(plain(html))?.[1]);
  const expected = isPrice(declared) ? declared - (fund.cashWeight > 0 ? 1 : 0) : reviewedStockCount;
  const total = fund.cashWeight + fund.holdings.reduce((sum, holding) => sum + holding.weight, 0);
  return fund.holdings.length === expected && new Set(fund.holdings.map(h => h.symbol)).size === expected &&
    Math.abs(total - 1) <= .002;
}
function market(symbol: string) {
  if (symbol.endsWith(".KS")) return { zone: "Asia/Seoul", hour: 15, minute: 30 };
  if (symbol.endsWith(".T")) return { zone: "Asia/Tokyo", hour: 15, minute: 30 };
  if (/\.(TW|TWO)$/.test(symbol)) return { zone: "Asia/Taipei", hour: 13, minute: 30 };
  if (/\.(SS|SZ)$/.test(symbol)) return { zone: "Asia/Shanghai", hour: 15, minute: 0 };
  return { zone: "America/New_York", hour: 16, minute: 0 };
}
export function syntheticNavHistoricalCash(chart: Chart, holding: BasketHolding, nav: IssuerNav): Observation | null {
  if (chart.meta?.symbol !== holding.symbol || chart.meta.currency !== holding.currency) return null;
  const venue = market(holding.symbol);
  let answer: Observation | null = null;
  for (const [i, stamp] of (chart.timestamp ?? []).entries()) {
    if (!Number.isFinite(stamp)) continue;
    const date = dayKey(stamp * 1000, venue.zone);
    const at = holding.currency === "USD" ? usClose(date) : zonedTime(date, venue.hour, venue.minute, venue.zone);
    const price = chart.indicators?.quote?.[0]?.close?.[i];
    if (holding.currency === "USD" && date !== nav.date) continue;
    if (isPrice(price) && at <= nav.at && nav.at - at <= 7 * DAY && (!answer || at > answer.at)) answer = { price, at, source: "Yahoo completed local cash close used for official NAV date" };
  }
  return answer;
}
export function syntheticNavHistoricalFx(chart: Chart, currency: string, at: number): Observation | null {
  if (chart.meta?.currency !== currency) return null;
  let answer: Observation | null = null;
  for (const [i, stamp] of (chart.timestamp ?? []).entries()) {
    const end = stamp * 1000 + 5 * MINUTE, price = chart.indicators?.quote?.[0]?.close?.[i];
    if (Number.isFinite(end) && isPrice(price) && end <= at && at - end <= 90 * MINUTE && (!answer || end > answer.at)) answer = { price, at: end, source: "Yahoo completed FX close at/before NAV calculation (up to 90 minutes)" };
  }
  return answer;
}
const signature = (fund: FundHoldings) => JSON.stringify([fund.asOf, fund.cashWeight, ...fund.holdings.map(h => [h.symbol, h.currency, h.weight, h.quantity ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
const validNav = (nav: IssuerNav, now: number) => isPrice(nav.nav) && nav.at === usClose(nav.date) && !future(nav.at, now) && now - nav.at <= 7 * DAY;

export function createDiskSyntheticNavMarketClient(options: { fetcher?: typeof fetch; clock?: () => number; seed?: Seed | null } = {}) {
  const fetcher = options.fetcher ?? fetch, clock = options.clock ?? (() => Date.now());
  const seed = options.seed === undefined ? reviewed as Seed : options.seed;
  let meta: Meta | null = null, metaNext = 0, cashNext = 0, perpNext = 0;
  let metaPending: Promise<void> | null = null, cashPending: Promise<void> | null = null, perpPending: Promise<void> | null = null;
  let calculatedAt: number | null = null, activeKey = "";
  const bases = new Map<string, Baseline>(), sessions = new Map<string, Session>();
  const cash = new Map<string, Map<string, Observation>>(), fx = new Map<string, Observation>(), perps = new Map<string, Observation>();
  const reasons = new Set<string>();
  async function request(url: string, format: "text" | "json" = "json") {
    const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(6_000), headers: { "User-Agent": "Mozilla/5.0", Accept: format === "json" ? "application/json" : "text/html,text/csv;q=0.9" } });
    if (!response.ok) throw new Error("Market reference temporarily unavailable");
    return format === "json" ? response.json() : response.text();
  }
  async function chart(symbol: string, query: string): Promise<Chart | null> {
    for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
      try {
        const data = await request(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`);
        const value = data.chart?.result?.[0] as Chart | undefined;
        if (value?.meta?.symbol === symbol || /^[A-Z]{3}=X$/.test(symbol) && value?.meta?.symbol === `USD${symbol}`) return value;
      } catch { /* Try the independent Yahoo host; retain original clocks. */ }
    }
    return null;
  }
  function retain(symbol: string, quote: Observation) {
    if (!isPrice(quote.price) || future(quote.at, clock())) return;
    const set = cash.get(symbol) ?? new Map<string, Observation>();
    const prior = set.get(quote.source);
    if (!prior || quote.at >= prior.at) set.set(quote.source, quote);
    cash.set(symbol, set);
  }
  function baseKey(nav: IssuerNav, fund: FundHoldings, symbol: string) { return `${nav.date}:${signature(fund)}:${symbol}`; }
  function adopt(next: Meta) {
    const key = `${next.nav.date}:${signature(next.holdings)}`;
    if (activeKey !== key) { activeKey = key; cashNext = 0; sessions.clear(); }
    meta = next;
    if (seed && seed.nav.date === next.nav.date && signature(seed.holdings) === signature(next.holdings)) {
      for (const holding of next.holdings.holdings) {
        const saved = seed.baselines[holding.symbol];
        if (saved && saved.currency === holding.currency) bases.set(baseKey(next.nav, next.holdings, holding.symbol), saved);
      }
    }
  }
  function loadSeed(now: number) {
    if (!meta && seed && validNav(seed.nav, now) && Date.parse(seed.holdings.asOf) <= Date.parse(dayKey(now, "America/New_York")) &&
        Math.abs(Date.parse(seed.holdings.asOf) - Date.parse(seed.nav.date)) <= 7 * DAY) {
      adopt({ nav: seed.nav, holdings: seed.holdings, reasons: ["Last verified dated issuer NAV and portfolio retained.", seed.warning ?? ""].filter(Boolean) });
    }
  }
  async function refreshMeta() {
    try {
      const now = clock(), html = await request(PAGE, "text"), nav = parseTemaSyntheticNav(html, now);
      if (!nav) throw new Error("Issuer NAV/date unavailable");
      if (meta && nav.date < meta.nav.date) throw new Error("Older issuer NAV cannot replace a newer baseline");
      const today = dayKey(now, "America/New_York");
      const links = [...html.matchAll(/https:\/\/temaetfs\.com\/hubfs\/Website\/Holdings\/DISK-holdings-(\d{2})(\d{2})(\d{4})\.csv(?:\?[^"<>\s]*)?/g)]
        .map(m => ({ url: m[0].replaceAll("&amp;", "&"), date: `${m[3]}-${m[1]}-${m[2]}` }))
        .filter(x => x.date <= today && Math.abs(Date.parse(x.date)-Date.parse(nav.date)) <= 7 * DAY).sort((a, b) => b.date.localeCompare(a.date));
      let holdings: FundHoldings;
      if (links.length) {
        holdings = parseDiskHoldings(await request(links[0].url, "text"), links[0].url, today);
        if (!syntheticNavHoldingsComplete(holdings, html)) throw new Error("Published portfolio is incomplete");
      }
      else if (meta && Math.abs(Date.parse(meta.holdings.asOf)-Date.parse(nav.date)) <= 7 * DAY) holdings = meta.holdings;
      else throw new Error("Comparable published portfolio unavailable");
      adopt({ nav, holdings, reasons: ["Published portfolio weights are an estimate; fund valuation marks can differ.",
        ...(holdings.asOf !== nav.date ? ["Portfolio date differs from official NAV date."] : [])] });
      metaNext = now + 60 * MINUTE;
      reasons.delete("Issuer NAV temporarily unavailable; last dated reference retained.");
    } catch {
      metaNext = clock() + MINUTE;
      reasons.add("Issuer NAV temporarily unavailable; last dated reference retained.");
    }
  }
  async function baseline(holding: BasketHolding, selected: Meta) {
    const key = baseKey(selected.nav, selected.holdings, holding.symbol);
    if (bases.has(key)) return;
    const [stock, rates] = await Promise.all([chart(holding.symbol, "range=1mo&interval=1d"),
      holding.currency === "USD" ? Promise.resolve(null) : chart(`${holding.currency}=X`, "range=5d&interval=5m")]);
    const native = stock ? syntheticNavHistoricalCash(stock, holding, selected.nav) : null;
    const rate = holding.currency === "USD" ? { price: 1, at: selected.nav.at } : rates ? syntheticNavHistoricalFx(rates, holding.currency, selected.nav.at) : null;
    if (native && rate) bases.set(key, { currency: holding.currency, native: native.price, at: native.at, fx: rate.price, fxAt: rate.at });
  }
  async function currentFx(currency: string) {
    const result = await chart(`${currency}=X`, "range=1d&interval=5m");
    const value = result?.meta;
    if (value?.currency === currency && isPrice(value.regularMarketPrice) && isPrice(value.regularMarketTime)) {
      const quote = { price: value.regularMarketPrice, at: value.regularMarketTime * 1000, source: "Yahoo current spot FX" };
      if (!future(quote.at, clock()) && (!fx.has(currency) || quote.at >= fx.get(currency)!.at)) fx.set(currency, quote);
    }
  }
  async function cashChart(holding: BasketHolding) {
    const value = await chart(holding.symbol, "range=1mo&interval=1d"), m = value?.meta;
    if (!value || m?.currency !== holding.currency || !isPrice(m.regularMarketPrice) || !isPrice(m.regularMarketTime)) return;
    const quote = { price: m.regularMarketPrice, at: m.regularMarketTime * 1000, source: "Yahoo local cash trade · delayed" };
    retain(holding.symbol, quote);
    const period = m.currentTradingPeriod?.regular;
    if (period && isPrice(period.start) && isPrice(period.end)) {
      const end = period.end * 1000;
      // Meta's actual final regular trade, not a newly stamped daily candle,
      // can verify a closed cash market, including the Taiwan close auction.
      const close = clock() >= end && quote.at >= end - MINUTE ? quote : null;
      sessions.set(holding.symbol, { start: period.start * 1000, end, close });
    }
  }
  async function regionalCash(holdings: BasketHolding[]) {
    const tasks: Promise<void>[] = [];
    const korean = holdings.filter(h => h.symbol.endsWith(".KS")).map(h => h.symbol.split(".")[0]);
    if (korean.length) tasks.push((async () => {
      const data = await request(`https://polling.finance.naver.com/api/realtime/domestic/stock/${korean.join(",")}`);
      for (const item of data.datas ?? []) if (korean.includes(item.itemCode)) {
        const after = item.marketSessionType === "afterMarket" && item.overMarketPriceInfo?.overMarketStatus === "OPEN";
        const point = after ? item.overMarketPriceInfo : item;
        retain(`${item.itemCode}.KS`, { price: num(after ? point.overPrice : item.closePriceRaw ?? item.closePrice), at: Date.parse(point.localTradedAt ?? item.localTradedAt),
          source: after ? "Naver Korean after-hours cash trade" : "Naver KRX cash trade" });
      }
    })());
    const chinese = holdings.filter(h => /\.(SS|SZ)$/.test(h.symbol));
    if (chinese.length) tasks.push((async () => {
      const text = await request(`https://qt.gtimg.cn/q=${chinese.map(h => `${h.symbol.endsWith(".SS") ? "sh" : "sz"}${h.symbol.split(".")[0]}`).join(",")}`, "text");
      for (const [, venue, code, body] of text.matchAll(/v_(sh|sz)(\d{6})="([^"]*)"/g)) {
        const symbol = `${code}.${venue === "sh" ? "SS" : "SZ"}`, fields = body.split("~"), stamp = fields[30];
        if (!chinese.some(h => h.symbol === symbol) || !/^\d{14}$/.test(stamp ?? "")) continue;
        retain(symbol, { price: num(fields[3]), at: Date.parse(`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}+08:00`), source: "Tencent mainland cash quote · provider clock" });
      }
    })());
    const taiwan = holdings.filter(h => /\.(TW|TWO)$/.test(h.symbol));
    if (taiwan.length) tasks.push((async () => {
      const exchange = taiwan.map(h => `${h.symbol.endsWith(".TWO") ? "otc" : "tse"}_${h.symbol.split(".")[0]}.tw`).join("|");
      const data = await request(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?${new URLSearchParams({ ex_ch: exchange, json: "1", delay: "0" })}`);
      for (const item of data.msgArray ?? []) {
        const holding = taiwan.find(h => h.symbol.split(".")[0] === item.c), point = isPrice(num(item.z)) ? item : item.trade;
        if (!holding || !/^\d{8}$/.test(item.d ?? "") || !/^\d{2}:\d{2}:\d{2}$/.test(point?.t ?? "")) continue;
        const d = item.d;
        retain(holding.symbol, { price: num(point.z), at: Date.parse(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${point.t}+08:00`), source: "TWSE / TPEx cash trade" });
      }
    })());
    await Promise.allSettled(tasks);
  }
  async function refreshCash() {
    const selected = meta;
    if (!selected) return;
    const holdings = selected.holdings.holdings, cashHoldings = holdings.filter(h => !DISK_SYNTHETIC_NAV_PERPS[h.symbol]);
    const currencies = [...new Set(cashHoldings.map(h => h.currency))].filter(c => c !== "USD");
    await Promise.allSettled([...holdings.map(h => baseline(h, selected)), ...cashHoldings.map(cashChart),
      regionalCash(cashHoldings), ...currencies.map(currentFx)]);
    calculatedAt = clock();
  }
  async function refreshPerps() {
    try {
      // Edge caches can otherwise keep a successful bulk response beyond the
      // stock-quote TTL even when Fetch's local cache is disabled.
      const data = await request(`https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures&_=${clock()}`);
      const parsed = parseSyntheticNavBitgetQuotes(data, clock());
      for (const [symbol, quote] of parsed) perps.set(symbol, quote);
      if (parsed.size) calculatedAt = clock();
    } catch { /* Expired source timestamps make the assembled value partial. */ }
  }
  function row(holding: BasketHolding, selected: Meta, now: number): DiskSyntheticNavRowInput {
    const baseline = bases.get(baseKey(selected.nav, selected.holdings, holding.symbol)), perp = DISK_SYNTHETIC_NAV_PERPS[holding.symbol] ?? null;
    let quote: Observation | null = perp ? perps.get(perp) ?? null : null, reference: string | null = null;
    if (!perp) {
      const candidates = [...(cash.get(holding.symbol)?.values() ?? [])].sort((a, b) => b.at - a.at);
      for (const candidate of candidates) {
        const closed = closedConstituentReference(holding.symbol, candidate, sessions.get(holding.symbol), now);
        if (!future(candidate.at, now) && (now - candidate.at <= QUOTE_MAX_AGE || closed)) { quote = candidate; reference = closed; break; }
      }
    }
    const rate = holding.currency === "USD" ? { price: 1, at: now } : fx.get(holding.currency);
    let reason: string | null = null;
    if (!baseline) reason = "NAV-date cash valuation reference unavailable";
    else if (!quote) reason = "Current constituent price unavailable";
    else if (perp && (future(quote.at, now) || now - quote.at > DISK_SYNTHETIC_NAV_PERP_MAX_AGE)) reason = "Stock perpetual quote expired";
    else if (!perp && (!rate || future(rate.at, now) || now - rate.at > QUOTE_MAX_AGE)) reason = "Current FX unavailable or expired";
    return { symbol: holding.symbol, name: holding.name, currency: holding.currency, weight: holding.weight,
      baseNative: baseline?.native ?? null, baseUsd: baseline ? baseline.native / baseline.fx : null,
      baseAt: baseline?.at ?? null, baseFxPrice: baseline?.fx ?? null, baseFxAt: baseline?.fxAt ?? null,
      currentNative: !perp ? quote?.price ?? null : null,
      currentUsd: perp ? quote?.price ?? null : quote && rate ? quote.price / rate.price : null,
      fxPrice: !perp ? rate?.price ?? null : null, fxAt: !perp && holding.currency !== "USD" ? rate?.at ?? null : null,
      quoteAt: quote?.at ?? null, source: quote?.source ?? null, sourceKind: perp ? "perp" : "cash", perpSymbol: perp, reference, reason };
  }
  return function getDiskSyntheticNavMarketSnapshot(now = clock()): DiskSyntheticNavSnapshot {
    loadSeed(now);
    if (!metaPending && now >= metaNext) { metaNext = now + MINUTE; metaPending = refreshMeta().finally(() => { metaPending = null; }); }
    if (!perpPending && now >= perpNext) { perpNext = now + 10_000; perpPending = refreshPerps().finally(() => { perpPending = null; }); }
    if (meta && !cashPending && now >= cashNext) { cashNext = now + MINUTE; cashPending = refreshCash().finally(() => { cashPending = null; }); }
    const selected = meta;
    const base: DiskSyntheticNavBase | null = selected ? { ...selected.nav, holdingsAsOf: selected.holdings.asOf, holdingsSource: selected.holdings.source } : null;
    return calculateDiskSyntheticNav({ now, calculatedAt, base, rows: selected ? selected.holdings.holdings.map(h => row(h, selected, now)) : [],
      cashBalanceWeight: selected?.holdings.cashWeight ?? 0,
      reasons: [...(selected?.reasons ?? []), ...reasons] });
  };
}

export const getDiskSyntheticNavSnapshot = createDiskSyntheticNavMarketClient();
