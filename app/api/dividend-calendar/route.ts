export const dynamic = "force-dynamic";

const BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1";
const BINANCE_CMS = "https://www.binance.com/bapi";
const BITGET_FUTURES = "https://api.bitget.com/api/v2/mix/market";
const NASDAQ_CALENDAR = "https://api.nasdaq.com/api/calendar/dividends";
const HKEX_ENTITLEMENTS = "https://www3.hkexnews.hk/reports/doe/eent.htm";
const JPM_2026_SCHEDULE = "https://am.jpmorgan.com/content/dam/jpm-am-aem/americas/us/en/supplemental/income-distribution-rates/jpmorgan-etfs-2026-distribution-notice.pdf";
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
type Event = { id: string; exchange: Exchange; contract: string; underlying: string; company: string; exDate: string; paymentDate: string | null; amount: number | null; currency: string; markPrice: number | null; percent: number | null; status: "announced" | "calendar" | "scheduled"; eligible: boolean; ruleType: RuleType; ruleUrl: string; sourceUrl: string; sourceLabel: string; announcedAt: number | null };
type Cache = typeof globalThis & { __DIVIDEND_MONTH_CACHE__?: Map<string, { expires: number; value: unknown }> };

const ALIASES: Record<string, string> = { BRKB: "BRK-B", GOOGL: "GOOGL", FBTC: "FBTC", SAMSUNG: "005930", SKHYNIX: "000660", HYUNDAI: "005380" };
const UNDERLYING_QUOTES: Record<string, string> = { SAMSUNG: "005930.KS", SKHYNIX: "000660.KS", HYUNDAI: "005380.KS" };
const HK_CODES: Record<string, string> = { TENCENT: "0700", TENCENTHKD: "0700", HK0700: "0700", HK1810: "1810", POPMART: "9992", KUAISHOU: "1024", MEITUAN: "3690", BYD: "1211", HK0992: "0992" };
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
  const dates = Array.from({ length: days }, (_, index) => isoDate(year, month, index + 1))
    .filter((date) => { const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); return weekday !== 0 && weekday !== 6; });
  const rows: NasdaqRow[] = [];
  for (let start = 0; start < dates.length; start += 4) {
    const batch = await Promise.all(dates.slice(start, start + 4).map(async (date) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const payload = await json<{ status?: { rCode?: number }; data?: { calendar?: { rows?: NasdaqRow[] | null } } }>(`${NASDAQ_CALENDAR}?date=${date}`, { ...HEADERS, Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" });
          const dayRows = payload.data?.calendar?.rows;
          if (payload.status?.rCode !== 200 || (dayRows !== null && !Array.isArray(dayRows))) throw new Error(`Nasdaq calendar returned incomplete data for ${date}.`);
          return dayRows ?? [];
        } catch (error) {
          lastError = error;
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
      throw new Error(`Nasdaq calendar failed on ${date}: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
    }));
    batch.forEach((dayRows) => rows.push(...dayRows));
  }
  return rows;
}

const plain = (html: string) => html.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
async function hkexMonth(year: number, month: number) {
  const response = await fetch(HKEX_ENTITLEMENTS, { cache: "no-store", headers: HEADERS, signal: AbortSignal.timeout(9_000) });
  if (!response.ok) throw new Error(`HKEX entitlements HTTP ${response.status}`);
  const html = await response.text();
  if (!html.includes("Dividends & Other Entitlements")) throw new Error("HKEX entitlements response changed format");
  const results: Array<{ code: string; company: string; exDate: string; amount: number; currency: string }> = [];
  let lastCode = ""; let lastName = "";
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = row.split(/<td\b[^>]*>/i).slice(1).map(plain);
    if (cells.length < 6) continue;
    const companyMatch = cells[1].match(/^(.*?)\s*\((\d{1,5})\)/);
    if (companyMatch) { lastName = companyMatch[1]; lastCode = companyMatch[2].padStart(4, "0"); }
    const description = cells[3]; const dateMatch = cells[4].match(/^(\d{1,2})\/(\d{1,2})$/);
    const yearMatch = cells[5].match(/\b(20\d{2})\b/);
    if (!lastCode || !dateMatch || !yearMatch || Number(yearMatch[1]) !== year || Number(dateMatch[2]) !== month || /\bNIL\b|BONUS ISSUE|RIGHTS ISSUE/i.test(description)) continue;
    if (!/DIVIDEND|DISTRIBUTION/i.test(description)) continue;
    const amountMatch = description.match(/\b(HKD|RMB|USD)\s*([\d,.]+)\s+PER\s+(\d+\s+)?(?:SHARES?|UNITS?)/i);
    if (!amountMatch) continue;
    const amount = Number(amountMatch[2].replaceAll(",", "")) / Number(amountMatch[3]?.trim() || 1);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    results.push({ code: lastCode, company: lastName, exDate: isoDate(year, month, Number(dateMatch[1])), amount, currency: amountMatch[1].toUpperCase() });
  }
  return results;
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
  const details: Array<Event | null> = await Promise.all(articles.map(async (article) => {
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
    const [rows, official, hkexResult] = await Promise.all([nasdaqMonth(year, month), officialAdjustments(prices, underlyingPrices), hkexMonth(year, month).then((events) => ({ events, error: null as string | null })).catch((error) => ({ events: [], error: error instanceof Error ? error.message : "HKEX scan failed" }))]);
    const byUnderlying = new Map<string, Array<Instrument & { exchange: Exchange }>>();
    equities.forEach((instrument) => {
      const underlying = normalizedUnderlying(instrument.symbol);
      byUnderlying.set(underlying, [...(byUnderlying.get(underlying) ?? []), { ...instrument, exchange: "Binance" }]);
    });
    bitget.instruments.forEach((instrument) => {
      const underlying = normalizedUnderlying(instrument.symbol);
      byUnderlying.set(underlying, [...(byUnderlying.get(underlying) ?? []), { ...instrument, exchange: "Bitget" }]);
    });
    const calendarEvents: Event[] = rows.flatMap((row) => (byUnderlying.get(row.symbol.toUpperCase()) ?? []).flatMap((instrument) => {
      const exchange = (instrument as Instrument & { exchange: Exchange }).exchange;
      const exDate = parseUsDate(row.dividend_Ex_Date); const amount = finite(row.dividend_Rate); const markPrice = (exchange === "Binance" ? prices : bitget.prices).get(instrument.symbol) ?? null;
      if (!exDate || amount === null || amount <= 0) return [];
      const noAdjustment = exchange === "Bitget" ? instrument.symbol === "STRCUSDT" : EXCLUDED_LEVERAGED_ETFS.has(instrument.symbol);
      const calendarUrl = `https://www.nasdaq.com/market-activity/${/ETF/i.test(row.companyName) ? "etf" : "stocks"}/${row.symbol.toLowerCase()}/dividend-history`;
      const ruleUrl = exchange === "Bitget" ? (instrument.symbol === "STRCUSDT" ? "https://www.bitget.com/support/articles/12560603887627" : "https://www.bitget.com/support/articles/12560603884782") : "https://www.binance.com/en-PH/support/faq/detail/7ced719b5e9a4859a1864c2fe657309f";
      return [{ id: `nasdaq-${exchange.toLowerCase()}-${instrument.symbol}-${exDate}`, exchange, contract: instrument.symbol, underlying: row.symbol, company: row.companyName, exDate, paymentDate: row.payment_Date && row.payment_Date !== "N/A" ? parseUsDate(row.payment_Date) : null, amount, currency: "USD", markPrice, percent: markPrice && markPrice > 0 ? amount / markPrice * 100 : null, status: "calendar", eligible: !noAdjustment, ruleType: noAdjustment ? "no_adjustment" : "special_funding", ruleUrl, sourceUrl: calendarUrl, sourceLabel: noAdjustment ? `${exchange}: no dividend adjustment` : `${exchange} pair · Nasdaq calendar`, announcedAt: row.announcement_Date ? Date.parse(row.announcement_Date) : null } satisfies Event];
    }));
    const hkContracts = [...equities.map((instrument) => ({ ...instrument, exchange: "Binance" as const })), ...bitget.instruments.map((instrument) => ({ ...instrument, exchange: "Bitget" as const }))].filter((instrument) => HK_CODES[instrument.symbol.replace(/USDT$/, "")]);
    const hkEvents: Event[] = hkexResult.events.flatMap((row) => hkContracts.filter((instrument) => HK_CODES[instrument.symbol.replace(/USDT$/, "")] === row.code).map((instrument) => {
      const eligible = !EXCLUDED_LEVERAGED_ETFS.has(instrument.symbol);
      return { id: `hkex-${instrument.exchange.toLowerCase()}-${instrument.symbol}-${row.exDate}`, exchange: instrument.exchange, contract: instrument.symbol, underlying: row.code, company: row.company, exDate: row.exDate, paymentDate: null, amount: row.amount, currency: row.currency, markPrice: null, percent: null, status: "calendar", eligible, ruleType: eligible ? "special_funding" : "no_adjustment", ruleUrl: instrument.exchange === "Binance" ? "https://www.binance.com/en-PH/support/faq/detail/7ced719b5e9a4859a1864c2fe657309f" : "https://www.bitget.com/support/articles/12560603884782", sourceUrl: HKEX_ENTITLEMENTS, sourceLabel: "HKEX entitlement report", announcedAt: null } satisfies Event;
    }));
    // The issuer publishes ex-dates before the cash amount appears in Nasdaq's calendar.
    const issuerDates = year === 2026 && month === 10 ? [{ symbol: "JEPQ", exDate: "2026-10-01", paymentDate: "2026-10-05", company: "JPMorgan Nasdaq Equity Premium Income ETF" }] : [];
    const scheduled: Event[] = issuerDates.flatMap((date) => (byUnderlying.get(date.symbol) ?? []).map((instrument) => {
      const venue = (instrument as Instrument & { exchange: Exchange }).exchange;
      const price = (venue === "Binance" ? prices : bitget.prices).get(instrument.symbol) ?? null;
      return { id: `issuer-${venue.toLowerCase()}-${instrument.symbol}-${date.exDate}`, exchange: venue, contract: instrument.symbol, underlying: date.symbol, company: date.company, exDate: date.exDate, paymentDate: date.paymentDate, amount: null, currency: "USD", markPrice: price, percent: null, status: "scheduled", eligible: true, ruleType: "special_funding", ruleUrl: venue === "Binance" ? "https://www.binance.com/en-PH/support/faq/detail/7ced719b5e9a4859a1864c2fe657309f" : "https://www.bitget.com/support/articles/12560603884782", sourceUrl: JPM_2026_SCHEDULE, sourceLabel: "JPMorgan issuer schedule · amount pending", announcedAt: null } satisfies Event;
    }));
    const eventMap = new Map<string, Event>(scheduled.map((event) => [`${event.exchange}:${event.contract}:${event.exDate}`, event]));
    [...calendarEvents, ...hkEvents].forEach((event) => eventMap.set(`${event.exchange}:${event.contract}:${event.exDate}`, event));
    official.forEach((event) => { if (event.exDate.startsWith(requested)) eventMap.set(`${event.exchange}:${event.contract}:${event.exDate}`, event); });
    const events = [...eventMap.values()].sort((left, right) => left.exDate.localeCompare(right.exDate) || (right.percent ?? -1) - (left.percent ?? -1));
    const value = { month: requested, generatedAt: Date.now(), scannedContracts: instruments.length + bitget.instruments.length, equityContracts: equities.length + bitget.instruments.length, coveredContracts: new Set(events.map((event) => `${event.exchange}:${event.contract}`)).size, exchangeCounts: { Binance: { scanned: instruments.length, candidates: equities.length }, Bitget: { scanned: bitget.instruments.length, candidates: bitget.instruments.length } }, coverage: { us: "Nasdaq calendar + verified issuer dates", hk: hkexResult.error ? `HKEX scan unavailable: ${hkexResult.error}` : "HKEX announced entitlements (not exhaustive)", kr: "Binance official adjustments only; Korean issuer schedules not yet covered" }, events };
    store.__DIVIDEND_MONTH_CACHE__.set(requested, { expires: Date.now() + 60 * 60_000, value });
    return Response.json(value, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    if (cached) return Response.json({ ...(cached.value as Record<string, unknown>), warning: "The latest dividend scan was incomplete. Showing the last complete result." }, { headers: { "Cache-Control": "no-store" } });
    return Response.json({ error: error instanceof Error ? error.message : "Dividend calendar scan failed." }, { status: 502 });
  }
}
