export const dynamic = "force-dynamic";

const BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1";
const BINANCE_CMS = "https://www.binance.com/bapi";
const BITGET_FUTURES = "https://api.bitget.com/api/v2/mix/market";
const NASDAQ_CALENDAR = "https://api.nasdaq.com/api/calendar/dividends";
const HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36", Accept: "application/json, text/plain, */*" };

type Instrument = { symbol: string; status?: string; contractType?: string; underlyingType?: string; underlyingSubType?: string[] };
type Premium = { symbol: string; markPrice?: string; indexPrice?: string };
type BitgetInstrument = { symbol: string; baseCoin: string; symbolStatus?: string; symbolType?: string; isRwa?: string };
type BitgetTicker = { symbol: string; markPrice?: string; indexPrice?: string; lastPr?: string };
type Funding = { fundingTime?: number; fundingRate?: string; rateType?: string };
type NasdaqRow = { companyName: string; symbol: string; dividend_Ex_Date: string; payment_Date?: string; record_Date?: string; dividend_Rate: number | string; announcement_Date?: string };
type Article = { code: string; title: string; releaseDate: number };
type Exchange = "Binance" | "Bitget";
type RuleType = "special_funding" | "no_adjustment";
type Event = { id: string; exchange: Exchange; contract: string; underlying: string; company: string; exDate: string; paymentDate: string | null; amount: number; currency: string; markPrice: number | null; percent: number | null; status: "announced" | "calendar"; eligible: boolean; ruleType: RuleType; ruleUrl: string; sourceUrl: string; sourceLabel: string; announcedAt: number | null };
type Cache = typeof globalThis & { __DIVIDEND_MONTH_CACHE__?: Map<string, { expires: number; value: unknown }> };

const ALIASES: Record<string, string> = { BRKB: "BRK-B", GOOGL: "GOOGL", FBTC: "FBTC", SAMSUNG: "005930", SKHYNIX: "000660", HYUNDAI: "005380" };
const UNDERLYING_QUOTES: Record<string, string> = { SAMSUNG: "005930.KS", SKHYNIX: "000660.KS", HYUNDAI: "005380.KS" };
const EXCLUDED_LEVERAGED_ETFS = new Set(["MUUUSDT", "TSLLUSDT", "SOXLUSDT", "KORUUSDT", "TMFUSDT", "TQQQUSDT", "SOXSUSDT", "TZAUSDT", "SQQQUSDT", "TBTUSDT"]);
const finite = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const pad = (value: number) => String(value).padStart(2, "0");
const isoDate = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;
const parseUsDate = (value: string) => { const [month, day, year] = value.split("/").map(Number); return year && month && day ? isoDate(year, month, day) : null; };
const kstDate = (timestamp: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
const normalizedUnderlying = (symbol: string) => {
  const base = symbol.replace(/USDT$/, "");
  return ALIASES[base] ?? base.replace(/STOCK$/, "");
};

async function json<T>(url: string, headers: Record<string, string> = HEADERS) {
  const response = await fetch(url, { cache: "no-store", headers, signal: AbortSignal.timeout(9_000) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`);
  return await response.json() as T;
}

async function binanceSnapshot() {
  const [exchange, premiums] = await Promise.all([
    json<{ symbols: Instrument[] }>(`${BINANCE_FUTURES}/exchangeInfo`),
    json<Premium[]>(`${BINANCE_FUTURES}/premiumIndex`),
  ]);
  const instruments = exchange.symbols.filter((item) => item.status === "TRADING" && item.contractType === "TRADIFI_PERPETUAL");
  const equities = instruments.filter((item) => /EQUITY/.test(item.underlyingType ?? ""));
  return { instruments, equities, prices: new Map(premiums.map((item) => [item.symbol, finite(item.markPrice) ?? finite(item.indexPrice)])) };
}

async function bitgetSnapshot() {
  const [contracts, tickers] = await Promise.all([
    json<{ data?: BitgetInstrument[] }>(`${BITGET_FUTURES}/contracts?productType=usdt-futures`),
    json<{ data?: BitgetTicker[] }>(`${BITGET_FUTURES}/tickers?productType=usdt-futures`),
  ]);
  const instruments = (contracts.data ?? []).filter((item) => item.symbolStatus === "normal" && item.symbolType === "perpetual" && item.isRwa === "YES");
  const prices = new Map((tickers.data ?? []).map((item) => [item.symbol, finite(item.markPrice) ?? finite(item.indexPrice) ?? finite(item.lastPr)]));
  return { instruments, prices };
}

async function nasdaqMonth(year: number, month: number) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows: NasdaqRow[] = [];
  for (let start = 1; start <= days; start += 8) {
    const batch = Array.from({ length: Math.min(8, days - start + 1) }, (_, offset) => start + offset);
    const payloads = await Promise.all(batch.map((day) => json<{ data?: { calendar?: { rows?: NasdaqRow[] } } }>(`${NASDAQ_CALENDAR}?date=${isoDate(year, month, day)}`, { ...HEADERS, Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" }).catch(() => null)));
    payloads.forEach((payload) => rows.push(...(payload?.data?.calendar?.rows ?? [])));
  }
  return rows;
}

function bodyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return Object.values(value as Record<string, unknown>).map(bodyText).join(" ");
}

async function foreignUnderlyingPrices() {
  const rows = await Promise.all(Object.entries(UNDERLYING_QUOTES).map(async ([underlying, quoteSymbol]) => {
    const quote = await json<{ chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } }>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(quoteSymbol)}?range=5d&interval=1d`, HEADERS).catch(() => null);
    return [underlying, finite(quote?.chart?.result?.[0]?.meta?.regularMarketPrice)] as const;
  }));
  return new Map(rows);
}

async function officialAdjustments(prices: Map<string, number | null>, underlyingPrices: Map<string, number | null>) {
  const headers = { ...HEADERS, "Accept-Language": "en", lang: "en", Referer: "https://www.binance.com/en/messages/v2/group/announcement" };
  const list = await json<{ data?: { catalogs?: Array<{ articles?: Article[] }> } }>(`${BINANCE_CMS}/apex/v1/public/apex/cms/article/list/query?type=1&pageNo=1&pageSize=50`, headers).catch(() => null);
  const articles = (list?.data?.catalogs ?? []).flatMap((catalog) => catalog.articles ?? []).filter((article) => /dividend adjustment process/i.test(article.title)).slice(0, 12);
  const details = await Promise.all(articles.map(async (article) => {
    const detail = await json<{ data?: { body?: string } }>(`${BINANCE_CMS}/composite/v1/public/cms/article/detail/query?articleCode=${article.code}`, { ...headers, Referer: `https://www.binance.com/en/support/announcement/${article.code}` }).catch(() => null);
    let parsed: unknown = detail?.data?.body ?? "";
    try { parsed = JSON.parse(String(parsed)); } catch { /* Plain body fallback. */ }
    const text = bodyText(parsed).replace(/\s+/g, " ");
    const contract = text.match(/\b([A-Z0-9]{2,24}USDT)\b/)?.[1];
    const date = text.match(/\b(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2})/)?.[1];
    const amountMatch = text.match(/(?:estimated dividend adjustment amount[^.]{0,100}?|estimated dividend[^.]{0,100}?)([\d,]+(?:\.\d+)?)\s*(KRW|won|USD|HKD|CNY|EUR)\s+per share/i);
    if (!contract || !date || !amountMatch) return null;
    const amount = Number(amountMatch[1].replaceAll(",", ""));
    const currency = amountMatch[2].toUpperCase() === "WON" ? "KRW" : amountMatch[2].toUpperCase();
    const underlying = contract.replace(/USDT$/, "");
    let markPrice = currency === "USD" ? prices.get(contract) ?? null : null;
    markPrice = underlyingPrices.get(underlying) ?? markPrice;
    let percent = markPrice && markPrice > 0 ? amount / markPrice * 100 : null;
    const funding = await json<Funding[]>(`${BINANCE_FUTURES}/fundingRate?symbol=${encodeURIComponent(contract)}&limit=100`, HEADERS).catch(() => []);
    const special = funding.filter((row) => row.rateType === "Special" && kstDate(row.fundingTime ?? 0) === date).at(-1);
    const specialRate = Math.abs(finite(special?.fundingRate) ?? 0);
    if (specialRate > 0) { percent = specialRate * 100; markPrice = amount / specialRate; }
    const eligible = !EXCLUDED_LEVERAGED_ETFS.has(contract);
    return { id: `binance-${article.code}`, exchange: "Binance", contract, underlying, company: underlying, exDate: date, paymentDate: null, amount, currency, markPrice, percent, status: "announced", eligible, ruleType: eligible ? "special_funding" : "no_adjustment", ruleUrl: "https://www.binance.com/en-PH/support/faq/detail/7ced719b5e9a4859a1864c2fe657309f", sourceUrl: `https://www.binance.com/en/support/announcement/${article.code}`, sourceLabel: specialRate > 0 ? "Binance special funding" : "Binance announcement", announcedAt: article.releaseDate } satisfies Event;
  }));
  return details.filter((event): event is Event => event !== null);
}

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  const match = requested.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (!match) return Response.json({ error: "month must use YYYY-MM." }, { status: 400 });
  const year = Number(match[1]); const month = Number(match[2]);
  const store = globalThis as Cache; store.__DIVIDEND_MONTH_CACHE__ ??= new Map();
  const cached = store.__DIVIDEND_MONTH_CACHE__.get(requested);
  if (cached && cached.expires > Date.now()) return Response.json(cached.value, { headers: { "Cache-Control": "no-store" } });
  try {
    const [{ instruments, equities, prices }, bitget] = await Promise.all([binanceSnapshot(), bitgetSnapshot()]);
    const underlyingPrices = await foreignUnderlyingPrices();
    const [rows, official] = await Promise.all([nasdaqMonth(year, month), officialAdjustments(prices, underlyingPrices)]);
    const byUnderlying = new Map<string, Instrument[]>();
    equities.forEach((instrument) => {
      const underlying = normalizedUnderlying(instrument.symbol);
      byUnderlying.set(underlying, [...(byUnderlying.get(underlying) ?? []), { ...instrument, exchange: "Binance" }]);
    });
    bitget.instruments.forEach((instrument) => {
      const underlying = normalizedUnderlying(instrument.symbol);
      byUnderlying.set(underlying, [...(byUnderlying.get(underlying) ?? []), { ...instrument, exchange: "Bitget" }]);
    });
    const calendarEvents = rows.flatMap((row) => (byUnderlying.get(row.symbol.toUpperCase()) ?? []).flatMap((instrument) => {
      const exchange = (instrument as Instrument & { exchange: Exchange }).exchange;
      const exDate = parseUsDate(row.dividend_Ex_Date); const amount = finite(row.dividend_Rate); const markPrice = (exchange === "Binance" ? prices : bitget.prices).get(instrument.symbol) ?? null;
      if (!exDate || amount === null || amount <= 0) return [];
      const noAdjustment = exchange === "Bitget" ? instrument.symbol === "STRCUSDT" : EXCLUDED_LEVERAGED_ETFS.has(instrument.symbol);
      const calendarUrl = `https://www.nasdaq.com/market-activity/${/ETF/i.test(row.companyName) ? "etf" : "stocks"}/${row.symbol.toLowerCase()}/dividend-history`;
      const ruleUrl = exchange === "Bitget" ? (instrument.symbol === "STRCUSDT" ? "https://www.bitget.com/support/articles/12560603887627" : "https://www.bitget.com/support/articles/12560603884782") : "https://www.binance.com/en-PH/support/faq/detail/7ced719b5e9a4859a1864c2fe657309f";
      return [{ id: `nasdaq-${exchange.toLowerCase()}-${instrument.symbol}-${exDate}`, exchange, contract: instrument.symbol, underlying: row.symbol, company: row.companyName, exDate, paymentDate: row.payment_Date && row.payment_Date !== "N/A" ? parseUsDate(row.payment_Date) : null, amount, currency: "USD", markPrice, percent: markPrice && markPrice > 0 ? amount / markPrice * 100 : null, status: "calendar", eligible: !noAdjustment, ruleType: noAdjustment ? "no_adjustment" : "special_funding", ruleUrl, sourceUrl: calendarUrl, sourceLabel: noAdjustment ? `${exchange}: no dividend adjustment` : `${exchange} pair · Nasdaq calendar`, announcedAt: row.announcement_Date ? Date.parse(row.announcement_Date) : null } satisfies Event];
    }));
    const eventMap = new Map(calendarEvents.map((event) => [`${event.exchange}:${event.contract}:${event.exDate}`, event]));
    official.forEach((event) => { if (event.exDate.startsWith(requested)) eventMap.set(`${event.exchange}:${event.contract}:${event.exDate}`, event); });
    const events = [...eventMap.values()].sort((left, right) => left.exDate.localeCompare(right.exDate) || (right.percent ?? -1) - (left.percent ?? -1));
    const value = { month: requested, generatedAt: Date.now(), scannedContracts: instruments.length + bitget.instruments.length, equityContracts: equities.length + bitget.instruments.length, coveredContracts: new Set(events.map((event) => `${event.exchange}:${event.contract}`)).size, exchangeCounts: { Binance: { scanned: instruments.length, candidates: equities.length }, Bitget: { scanned: bitget.instruments.length, candidates: bitget.instruments.length } }, events };
    store.__DIVIDEND_MONTH_CACHE__.set(requested, { expires: Date.now() + 60 * 60_000, value });
    return Response.json(value, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Dividend calendar scan failed." }, { status: 502 });
  }
}
