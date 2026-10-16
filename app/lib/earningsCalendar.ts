import { unzipSync, strFromU8 } from "fflate";

export type EarningsMarket = "US" | "JP" | "KR";
export type EarningsContract = { exchange: "Binance" | "Bitget"; symbol: string; listingMarket: EarningsMarket };
type Listing = { exchange: EarningsContract["exchange"]; symbol: string; base: string; underlyingType?: string };
export type EarningsIssuer = { id: string; company: string; market: EarningsMarket; code: string; contracts: EarningsContract[] };
export type EarningsEvent = EarningsIssuer & {
  eventId: string; reportDate: string; calendarDate: string; timeLocal: string | null;
  timeZone: string; timeHkt: string | null; startsAt: number | null;
  session: "before_open" | "after_close" | "unknown" | "exact";
  kind: "results" | "earnings_call"; status: "confirmed" | "estimated";
  period: string | null; sourceUrl: string; sourceLabel: string; checkedAt: number; stale?: boolean;
};
export type EarningsPayload = {
  month: string; generatedAt: number; events: EarningsEvent[]; warnings: string[];
  scannedContracts: number; trackedContracts: number; issuers: number;
  exchangeCounts: Record<"Binance" | "Bitget", number>;
  markets: Record<EarningsMarket, { issuers: number; events: number; withoutDate: number }>;
  missing: Array<EarningsIssuer & { reason: string }>;
  excluded: Array<{ exchange: string; symbol: string; reason: string }>;
  unresolved: Array<{ exchange: string; symbol: string; reason: string }>;
  sourceStatus: Array<{ name: string; url: string; ok: boolean; checkedAt: number; detail: string }>;
};

const HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json, text/plain, */*" };
export const JPX_URL = "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/";
export const KIND_URL = "https://kind.krx.co.kr/corpgeneral/irschedule.do";
const NASDAQ_URL = "https://api.nasdaq.com/api/calendar/earnings";
const SONY_URL = "https://www.sony.com/en/SonyInfo/IR/library/presen/er/";
const BIO_URL = "https://samsungbiologics.com/ir/overview";
type AsianMapping = { market: "JP" | "KR"; code: string; company: string; bases: string[] };
export const EARNINGS_ASIAN_ISSUERS: AsianMapping[] = [
  { market: "KR", code: "005930", company: "Samsung Electronics", bases: ["SAMSUNG"] },
  { market: "KR", code: "000660", company: "SK hynix", bases: ["SKHYNIX", "SKHY"] },
  { market: "KR", code: "005380", company: "Hyundai Motor", bases: ["HYUNDAI"] },
  { market: "KR", code: "034020", company: "Doosan Enerbility", bases: ["DOOSENER"] },
  { market: "KR", code: "454910", company: "Doosan Robotics", bases: ["DOOSBOT"] },
  { market: "KR", code: "035420", company: "NAVER", bases: ["NAVER"] },
  { market: "KR", code: "066570", company: "LG Electronics", bases: ["LGELECTRONICS"] },
  { market: "KR", code: "009150", company: "Samsung Electro-Mechanics", bases: ["SAMSUNGEM"] },
  { market: "KR", code: "207940", company: "Samsung Biologics", bases: ["SSBIOLOGICS"] },
  { market: "KR", code: "000270", company: "Kia", bases: ["KIA"] },
  { market: "KR", code: "373220", company: "LG Energy Solution", bases: ["LGENERGY"] },
  { market: "KR", code: "035720", company: "Kakao", bases: ["KAKAO"] },
  { market: "KR", code: "105560", company: "KB Financial Group", bases: ["KBFG"] },
  { market: "JP", code: "285A", company: "Kioxia", bases: ["KIOXIA"] },
  { market: "JP", code: "5802", company: "Sumitomo Electric", bases: ["SUMIELEC"] },
  { market: "JP", code: "6758", company: "Sony Group", bases: ["SONY", "JPSONY"] },
  { market: "JP", code: "6857", company: "Advantest", bases: ["ADVANTEST"] },
  { market: "JP", code: "6920", company: "Lasertec", bases: ["LASERTEC"] },
  { market: "JP", code: "6976", company: "Taiyo Yuden", bases: ["TAIYOYUDEN"] },
  { market: "JP", code: "6981", company: "Murata Manufacturing", bases: ["MURATA"] },
  { market: "JP", code: "7203", company: "Toyota Motor", bases: ["TOYOTA", "TM"] },
  { market: "JP", code: "8035", company: "Tokyo Electron", bases: ["TOKYOEL"] },
  { market: "JP", code: "8306", company: "Mitsubishi UFJ Financial Group", bases: ["MUFG", "JPMUFG"] },
  { market: "JP", code: "9983", company: "Fast Retailing", bases: ["FASTRETAILING"] },
  { market: "JP", code: "9984", company: "SoftBank Group", bases: ["SOFTBANK"] },
];
const OUTSIDE_SCOPE = new Set("MINIMAX ZHIPU TENCENT HK0700 HK1810 POPMART KUAISHOU MEITUAN BYD HK0992 GIGADEV GIGADEVICE SMIC XIAOMI NETEASE MINIMAXHKD XIAOMIHKD TENCENTHKD ZHIPUHKD LENOVOHKD ZHONGJI HK0625 CXMT UNITREE SHEINHKD JIO".split(" "));
const NON_COMPANY = new Set("XAU XAG XPT XPD COPPER CL BZ NATGAS PAXG XAUT NDX100 SP500 HSI JP225 KR200 KODEX200 H100 B200 EURUSD USDJPY GBPUSD USDBRL OPENAI ANTHROPIC MOONSHOT OURA SHEIN POLYMARKET CSOPSKHYNIX2L CSOPSAMSUNG2L CSOPSK2LHKD CSOPSS2LHKD".split(" "));
const normalizeTicker = (s: string) => s.toUpperCase().replace(/[./]/g, "-");
// Exchange-announced aliases, verified against the current U.S. listing directory.
// Binance announcements: 3bdaff694bde45ccb443709336c8686d (QNTX),
// 73769d872a644d7082bc79cde6c12d98 (BBX), ea19450f515843098a5d5e55fc6e3589 (USDEX).
const US_ALIASES: Record<string, string> = { BRKB: "BRK-B", QNTX: "QNT", BBX: "BB", USDEX: "USDE" };
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, "> ");
const plain = (s: string) => decode(s.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")).replace(/\s+/g, " ").trim();
export const validDate = (s: string) => /^20\d{2}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const pad = (n: number) => String(n).padStart(2, "0");
export function monthDates(month: string) {
  const [y, m] = month.split("-").map(Number);
  return Array.from({ length: new Date(Date.UTC(y, m, 0)).getUTCDate() }, (_, i) => `${month}-${pad(i + 1)}`);
}
export function localTimestamp(date: string, time: string, zone: string) {
  if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const local = Date.parse(`${date}T${time}:00Z`);
  // Resolve IANA timezone offsets, including U.S. daylight-saving transitions.
  let utc = local;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(utc);
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    utc = local - (represented - utc);
  }
  return utc;
}
export function hktParts(stamp: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(stamp).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

type Security = { symbol: string; company: string; etf: boolean };
export function parseUsDirectory(text: string): Security[] {
  const lines = text.trim().split(/\r?\n/); const headers = lines.shift()?.split("|") ?? [];
  if (!headers.includes("ETF") || !headers.includes("Security Name")) throw new Error("U.S. symbol directory format changed");
  return lines.flatMap(line => {
    const cells = line.split("|"); const row = Object.fromEntries(headers.map((key, i) => [key, cells[i]]));
    const symbol = row.Symbol || row["ACT Symbol"];
    if (!symbol || !row["Security Name"] || row["Test Issue"] !== "N") return [];
    return [{ symbol: normalizeTicker(symbol), company: row["Security Name"], etf: row.ETF === "Y" }];
  });
}
export function mapEarningsUniverse(listings: Listing[], securities: Security[]) {
  const directory = new Map(securities.map(s => [s.symbol, s]));
  const issuers = new Map<string, EarningsIssuer>();
  const excluded: EarningsPayload["excluded"] = [], unresolved: EarningsPayload["unresolved"] = [];
  for (const listing of listings) {
    const { exchange, symbol, base } = listing;
    let asian = EARNINGS_ASIAN_ISSUERS.find(i => i.bases.includes(base));
    // These identical exchange symbols refer to two different Korean companies.
    if (base === "HANMI") asian = { market: "KR", code: exchange === "Binance" ? "042700" : "128940", company: exchange === "Binance" ? "Hanmi Semiconductor" : "Hanmi Pharm", bases: [base] };
    if (asian) {
      const id = `${asian.market}:${asian.code}`;
      const item = issuers.get(id) ?? { id, company: asian.company, market: asian.market, code: asian.code, contracts: [] };
      item.contracts.push({ exchange, symbol, listingMarket: ["SONY", "MUFG", "TM", "SKHY"].includes(base) ? "US" : asian.market });
      issuers.set(id, item); continue;
    }
    if (OUTSIDE_SCOPE.has(base) || /^(HK|CN)_/.test(listing.underlyingType ?? "")) { excluded.push({ exchange, symbol, reason: "Listing outside US / Japan / Korea" }); continue; }
    if (NON_COMPANY.has(base) || /COMMODITY|PREMARKET|^FX$/.test(listing.underlyingType ?? "")) { excluded.push({ exchange, symbol, reason: "Fund, index, commodity, FX or pre-IPO; no corporate earnings calendar" }); continue; }
    const ticker = normalizeTicker(US_ALIASES[base] ?? base.replace(/STOCK$/, ""));
    const security = directory.get(ticker);
    if (!security) { unresolved.push({ exchange, symbol, reason: "No verified US / Japan / Korea issuer mapping; not treated as no earnings" }); continue; }
    if (security.etf) { excluded.push({ exchange, symbol, reason: "ETF / fund: no company quarterly earnings release" }); continue; }
    const code = ticker === "STRC" ? "MSTR" : ticker;
    const id = `US:${code}`;
    const item = issuers.get(id) ?? { id, company: code === "MSTR" ? "Strategy (MSTR / STRC issuer)" : security.company, market: "US" as const, code, contracts: [] };
    item.contracts.push({ exchange, symbol, listingMarket: "US" }); issuers.set(id, item);
  }
  return { issuers: [...issuers.values()], excluded, unresolved };
}

function event(issuer: EarningsIssuer, date: string, sourceUrl: string, sourceLabel: string, options: Partial<EarningsEvent> = {}): EarningsEvent {
  const timeZone = issuer.market === "US" ? "America/New_York" : issuer.market === "JP" ? "Asia/Tokyo" : "Asia/Seoul";
  const timeLocal = options.timeLocal ?? null;
  const startsAt = timeLocal ? localTimestamp(date, timeLocal, timeZone) : null;
  const hkt = startsAt === null ? null : hktParts(startsAt);
  // A date-only disclosure is NOT midnight and cannot be assigned a fictitious HKT time.
  return { ...issuer, eventId: `${issuer.id}:${date}:${options.kind ?? "results"}`, reportDate: date, calendarDate: hkt?.date ?? date, timeLocal, timeZone, startsAt, timeHkt: hkt?.time ?? null, session: startsAt === null ? "unknown" : "exact", kind: "results", status: "confirmed", period: null, sourceUrl, sourceLabel, checkedAt: Date.now(), ...options };
}

// Read only the cells needed from the exchange's XLSX; no macros or formulas execute.
export function xlsxRows(bytes: Uint8Array): string[][] {
  if (bytes.length > 8_000_000) throw new Error("JPX workbook too large");
  const zip = unzipSync(bytes, { filter: f => f.originalSize < 20_000_000 && /^(xl\/sharedStrings.xml|xl\/worksheets\/sheet\d+.xml)$/.test(f.name) });
  const strings = [...strFromU8(zip["xl/sharedStrings.xml"] ?? new Uint8Array()).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => decode(t[1])).join(""));
  return Object.entries(zip).filter(([name]) => /worksheets\//.test(name)).flatMap(([, bytes]) => [...strFromU8(bytes).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => {
    const values: string[] = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const col = cell[1].match(/\br="([A-Z]+)\d+"/)?.[1]; if (!col) continue;
      const index = [...col].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1;
      const value = cell[2].match(/<v\b[^>]*>([^<]*)<\/v>/)?.[1] ?? "";
      values[index] = /\bt="s"/.test(cell[1]) ? strings[Number(value)] ?? "" : /\bt="inlineStr"/.test(cell[1]) ? plain(cell[2]) : decode(value);
    }
    return values;
  }));
}
export function parseJpxRows(rows: string[][], issuers: EarningsIssuer[], sourceUrl: string) {
  const header = rows.findIndex(r => r.some(v => /Scheduled Dates for Earnings Announcements/.test(v)) && r.some(v => /Code/.test(v)));
  if (header < 0) throw new Error("JPX earnings table format changed");
  const h = rows[header]; const dateCol = h.findIndex(v => /Scheduled Dates/.test(v)); const codeCol = h.findIndex(v => /Code/.test(v)); const periodCol = h.findIndex(v => /Fiscal Year\/Quarter/.test(v));
  return rows.slice(header + 1).flatMap(row => {
    const issuer = issuers.find(i => i.market === "JP" && i.code === row[codeCol]?.trim());
    const raw = row[dateCol] ?? "";
    const date = /^\d{5}(?:\.0+)?$/.test(raw) ? new Date(Date.UTC(1899, 11, 30) + Number(raw) * 86400000).toISOString().slice(0, 10) : raw.replaceAll("/", "-");
    if (!issuer || !validDate(date)) return [];
    return [event(issuer, date, sourceUrl, "JPX · issuer-submitted earnings schedule", { period: row[periodCol] ?? null })];
  });
}
export function parseKind(html: string, issuers: EarningsIssuer[], sourceUrl: string) {
  if (!/IRSchedule|fnDetailView|조회된|조회 결과|목록/.test(html)) throw new Error("KIND schedule response unavailable");
  const found = new Map<string, EarningsEvent>();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const code = row[1].match(/companysummary_open\(['"]([^'"]+)/)?.[1];
    const issuer = issuers.find(i => i.market === "KR" && i.code.slice(0, 5) === code); if (!issuer) continue;
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(c => plain(c[1]));
    const title = cells[2] ?? ""; const date = cells[4] ?? "";
    // Do not turn NDRs, corporate days or general investor meetings into earnings releases.
    if (!validDate(date) || !/(실적\s*발표|earnings\s*(release|announcement)|financial results|announc\w*.*results)/i.test(title) || /NDR|non-deal|corporate day/i.test(title)) continue;
    const time = cells[5]?.match(/^([01]\d|2[0-3]):([0-5]\d)$/)?.[0] ?? null;
    const item = event(issuer, date, sourceUrl, "KRX KIND · company results / IR call schedule", { timeLocal: time, kind: "earnings_call", period: title });
    const prev = found.get(item.eventId);
    if (!prev || (!prev.timeLocal && time) || (!!time === !!prev.timeLocal && /earnings|financial|results/i.test(title))) found.set(item.eventId, item);
  }
  return [...found.values()];
}
export function parseNasdaq(rows: Array<{ symbol: string; name?: string; time?: string; fiscalQuarterEnding?: string }>, date: string, issuers: EarningsIssuer[], sourceUrl: string) {
  return rows.flatMap(row => {
    const issuer = issuers.find(i => i.market === "US" && i.code === normalizeTicker(row.symbol)); if (!issuer) return [];
    const session = row.time === "time-pre-market" ? "before_open" : row.time === "time-after-hours" ? "after_close" : "unknown";
    // The Nasdaq calendar includes algorithmic estimates; it is not issuer confirmation.
    const calendarDate = session === "after_close" ? hktParts(localTimestamp(date, "16:00", "America/New_York")!).date : date;
    return [event(issuer, date, sourceUrl, "Nasdaq earnings calendar · estimated, verify with issuer", { session, calendarDate, status: "estimated", period: row.fiscalQuarterEnding ?? null })];
  });
}

export function parseBiologics(html: string, issuer: EarningsIssuer) {
  const text = plain(html);
  const result = [...text.matchAll(/(Q[1-4]\s+Earnings Release)\s*(20\d{2})\.(\d{2})\.(\d{2})/g)].flatMap(m => {
    const date = `${m[2]}-${m[3]}-${m[4]}`;
    return validDate(date) ? [event(issuer, date, BIO_URL, "Samsung Biologics · company IR schedule", { period: m[1] })] : [];
  });
  if (!result.length) throw new Error("IR earnings schedule not readable; date coverage incomplete");
  return result;
}

// Public-source observations verified on 2026-10-16 before deployment. Some issuer/
// exchange sites reject data-centre requests. Retain these observations, never bypass
// that rejection and never imply a successful live recheck. A successful source
// response takes precedence, including corrections/removals from that response.
export function verifiedScheduleFallback(issuers: EarningsIssuer[], failedSources: string[]) {
  const observations: Array<{ id: string; date: string; time: string | null; source: string; kind: EarningsEvent["kind"] }> = [
    { id: "KR:000660", date: "2026-10-28", time: "09:00", source: "KRX KIND earnings", kind: "earnings_call" },
    { id: "KR:009150", date: "2026-10-28", time: "13:00", source: "KRX KIND earnings", kind: "earnings_call" },
    { id: "KR:066570", date: "2026-10-28", time: "16:00", source: "KRX KIND earnings", kind: "earnings_call" },
    { id: "KR:005930", date: "2026-10-29", time: "10:00", source: "KRX KIND earnings", kind: "earnings_call" },
    { id: "KR:105560", date: "2026-10-29", time: "16:00", source: "KRX KIND earnings", kind: "earnings_call" },
    { id: "KR:000270", date: "2026-10-30", time: null, source: "KRX KIND earnings", kind: "earnings_call" },
    { id: "KR:373220", date: "2026-11-03", time: "10:00", source: "KRX KIND earnings", kind: "earnings_call" },
    { id: "KR:035720", date: "2026-11-05", time: "09:00", source: "KRX KIND earnings", kind: "earnings_call" },
    { id: "JP:6758", date: "2026-11-05", time: "15:30", source: "Sony IR", kind: "results" },
    { id: "JP:6758", date: "2026-11-05", time: "16:30", source: "Sony IR", kind: "earnings_call" },
  ];
  return observations.flatMap(row => {
    const issuer = issuers.find(i => i.id === row.id);
    if (!issuer || !failedSources.includes(row.source)) return [];
    const sourceUrl = row.source === "Sony IR" ? SONY_URL : `${KIND_URL}?method=searchIRScheduleMain&gubun=iRSchedule`;
    return [event(issuer, row.date, sourceUrl, `${row.source} · verified snapshot 16 Oct 2026; live refresh unavailable`, {
      timeLocal: row.time, kind: row.kind, stale: true, checkedAt: Date.parse("2026-10-16T03:47:35Z"),
    })];
  });
}

type Cached = { value: unknown; expires: number; checkedAt: number };
type Store = typeof globalThis & { __EARNINGS_SOURCE_CACHE__?: Map<string, Cached>; __EARNINGS_INFLIGHT__?: Map<string, Promise<unknown>> };
async function memo<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const store = globalThis as Store; store.__EARNINGS_SOURCE_CACHE__ ??= new Map(); store.__EARNINGS_INFLIGHT__ ??= new Map();
  const cached = store.__EARNINGS_SOURCE_CACHE__.get(key); if (cached && cached.expires > Date.now()) return cached.value as T;
  const pending = store.__EARNINGS_INFLIGHT__.get(key); if (pending) return pending as Promise<T>;
  const task = fn().then(value => { store.__EARNINGS_SOURCE_CACHE__!.set(key, { value, expires: Date.now() + ttl, checkedAt: Date.now() }); if (store.__EARNINGS_SOURCE_CACHE__!.size > 180) store.__EARNINGS_SOURCE_CACHE__!.delete(store.__EARNINGS_SOURCE_CACHE__!.keys().next().value!); return value; }).finally(() => store.__EARNINGS_INFLIGHT__!.delete(key));
  store.__EARNINGS_INFLIGHT__.set(key, task); return task;
}
async function get(url: string, timeout = 7000, accept = HEADERS.Accept) { const r = await fetch(url, { headers: { ...HEADERS, Accept: accept }, cache: "no-store", signal: AbortSignal.timeout(timeout) }); if (!r.ok) throw new Error(`${new URL(url).hostname} HTTP ${r.status}`); return r; }
async function listings(exchange: "Binance" | "Bitget"): Promise<Listing[]> {
  return memo(`listings:${exchange}`, 60 * 60_000, async () => {
    if (exchange === "Binance") {
      const data = await (await get("https://fapi.binance.com/fapi/v1/exchangeInfo")).json() as { symbols: Array<{ symbol: string; baseAsset?: string; status: string; contractType: string; underlyingType: string }> };
      if (!Array.isArray(data.symbols) || !data.symbols.length) throw new Error("Binance listing response incomplete");
      return data.symbols.filter(s => s.status === "TRADING" && s.contractType === "TRADIFI_PERPETUAL").map(s => ({ exchange, symbol: s.symbol, base: s.baseAsset ?? s.symbol.replace(/(?:USDT|USDC|USD1)$/, ""), underlyingType: s.underlyingType }));
    }
    const data = await (await get("https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures")).json() as { code?: string; data: Array<{ symbol: string; baseCoin: string; symbolStatus: string; symbolType: string; isRwa: string }> };
    if (data.code !== "00000" || !Array.isArray(data.data) || !data.data.length) throw new Error("Bitget listing response incomplete");
    return data.data.filter(s => s.symbolStatus === "normal" && s.symbolType === "perpetual" && s.isRwa === "YES").map(s => ({ exchange, symbol: s.symbol, base: s.baseCoin }));
  });
}

export async function scanEarnings(month: string, previous?: EarningsPayload): Promise<EarningsPayload> {
  const warnings: string[] = [], sourceStatus: EarningsPayload["sourceStatus"] = [];
  async function source<T>(name: string, url: string, fn: () => Promise<T>, empty: T) {
    try { const value = await fn(); sourceStatus.push({ name, url, ok: true, checkedAt: Date.now(), detail: "Source checked; absence is not confirmation of no earnings" }); return value; }
    catch (e) { const detail = e instanceof Error ? e.message : "Source unavailable"; warnings.push(`${name}: ${detail}`); sourceStatus.push({ name, url, ok: false, checkedAt: Date.now(), detail }); return empty; }
  }
  const [bn, bg, directories] = await Promise.all([
    source("Binance listings", "https://fapi.binance.com/fapi/v1/exchangeInfo", () => listings("Binance"), []),
    source("Bitget listings", "https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures", () => listings("Bitget"), []),
    Promise.all(["nasdaqlisted.txt", "otherlisted.txt"].map(file => source(`US directory ${file}`, `https://www.nasdaqtrader.com/dynamic/SymDir/${file}`, () => memo(`directory:${file}`, 6 * 3600_000, async () => parseUsDirectory(await (await get(`https://www.nasdaqtrader.com/dynamic/SymDir/${file}`)).text())), []))),
  ]);
  const universe = mapEarningsUniverse([...bn, ...bg], directories.flat());
  const { issuers } = universe;
  const failedUsDates: string[] = [];
  const kindParams = new URLSearchParams({ method: "searchIRScheduleSub", forward: "searchirschedule_sub", fromDate: `${month}-01`, toDate: monthDates(month).at(-1)!, currentPageSize: "3000", pageIndex: "1", orderMode: "4", orderStat: "D", gubun: "iRSchedule", tabIndex: "1" });
  const kindLink = `${KIND_URL}?${kindParams}`;
  const [us, jp, kr, sony, bio] = await Promise.all([
    source("Nasdaq earnings", `https://www.nasdaq.com/market-activity/earnings?date=${month}-01`, async () => {
      const priorDay = new Date(Date.parse(`${month}-01T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const dates = [priorDay, ...monthDates(month)]; const events: EarningsEvent[] = [];
      for (let n = 0; n < dates.length; n += 6) {
        const batch = await Promise.all(dates.slice(n, n + 6).map(async date => {
          try {
            const rows = await memo(`nasdaq:${date}`, 30 * 60_000, async () => {
              const data = await (await get(`${NASDAQ_URL}?date=${date}`, 4500)).json() as { status?: { rCode: number }; data?: { rows?: Parameters<typeof parseNasdaq>[0] | null } };
              if (data.status?.rCode !== 200 || !data.data || !("rows" in data.data) || (data.data.rows !== null && !Array.isArray(data.data.rows))) throw new Error("Incomplete Nasdaq response");
              return data.data.rows ?? [];
            });
            return parseNasdaq(rows, date, issuers, `https://www.nasdaq.com/market-activity/earnings?date=${date}`);
          } catch { failedUsDates.push(date); return []; }
        }));
        events.push(...batch.flat());
      }
      return events;
    }, []),
    source("JPX earnings", JPX_URL, async () => {
      const workbooks = await memo("jpx:workbooks", 2 * 3600_000, async () => {
        const html = await (await get(JPX_URL)).text();
        const links = [...new Set([...html.matchAll(/href="([^"]+\.xlsx)"/gi)].map(m => new URL(m[1], JPX_URL).href))].filter(url => new URL(url).origin === "https://www.jpx.co.jp");
        if (!links.length) throw new Error("JPX workbook links unavailable");
        return Promise.all(links.slice(0, 6).map(async url => ({ url, rows: xlsxRows(new Uint8Array(await (await get(url)).arrayBuffer())) })));
      });
      return workbooks.flatMap(({ rows, url }) => parseJpxRows(rows, issuers, url));
    }, []),
    source("KRX KIND earnings", kindLink, async () => parseKind(await (await get(kindLink, 10000)).text(), issuers, kindLink), []),
    source("Sony IR", SONY_URL, async () => {
      const issuer = issuers.find(i => i.id === "JP:6758"); if (!issuer) return [];
      const text = plain(await (await get(SONY_URL)).text());
      const d = text.match(/Date:\s*(20\d{2})\.(\d{1,2})\.(\d{1,2})\s*\[[^\]]*\]\s*(\d{2}:\d{2})\s*\(JST\)/);
      if (!d || !/Earnings Announcement/.test(text)) throw new Error("IR earnings schedule not readable; date coverage incomplete");
      const date = `${d[1]}-${pad(Number(d[2]))}-${pad(Number(d[3]))}`; if (!validDate(date)) return [];
      const result = [event(issuer, date, SONY_URL, "Sony IR · earnings briefing", { timeLocal: d[4], kind: "earnings_call" })];
      const release = text.match(/available from ([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{2}:\d{2})\s*JST/i);
      const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
      if (release && Number(release[2]) === Number(d[3]) && months.indexOf(release[1].toLowerCase()) + 1 === Number(d[2])) result.push(event(issuer, date, SONY_URL, "Sony IR · financial results available", { timeLocal: release[3] }));
      return result;
    }, []),
    source("Samsung Biologics IR", BIO_URL, async () => {
      const issuer = issuers.find(i => i.id === "KR:207940"); if (!issuer) return [];
      // This site content-negotiates: Accept: application/json returns a different data model.
      return parseBiologics(await (await get(BIO_URL, 7000, "text/html")).text(), issuer);
    }, []),
  ]);
  if (failedUsDates.length) { warnings.push(`Nasdaq unavailable for ${failedUsDates.length} dates: ${failedUsDates.sort().join(", ")}`); const s = sourceStatus.find(s => s.name === "Nasdaq earnings")!; s.ok = false; s.detail = "Partial month; unavailable dates are not empty dates"; }
  const events = new Map<string, EarningsEvent>();
  [...jp, ...kr, ...us, ...sony, ...bio].filter(e => e.calendarDate.startsWith(month)).forEach(e => events.set(e.eventId, e));
  // Retain only failed sources/dates, not events removed by a successful correction.
  for (const old of previous?.events ?? []) {
    const failed = (old.sourceLabel.startsWith("Nasdaq") && failedUsDates.includes(old.reportDate)) || sourceStatus.some(s => !s.ok && s.url === old.sourceUrl) || (old.sourceLabel.startsWith("JPX") && sourceStatus.some(s => s.name === "JPX earnings" && !s.ok));
    if (failed && !events.has(old.eventId)) events.set(old.eventId, { ...old, stale: true });
  }
  const snapshots = verifiedScheduleFallback(issuers, sourceStatus.filter(s => !s.ok).map(s => s.name));
  let retainedSnapshots = 0;
  for (const snapshot of snapshots) {
    if (snapshot.calendarDate.startsWith(month) && !events.has(snapshot.eventId)) { events.set(snapshot.eventId, snapshot); retainedSnapshots++; }
  }
  if (retainedSnapshots) warnings.push(`${retainedSnapshots} earnings events retained from the verified 16 Oct 2026 snapshot. Live source refresh unavailable; marked STALE with verification time in details.`);
  if (!bn.length || !bg.length) warnings.push("Exchange listing scan incomplete; only successfully verified listings are counted.");
  const result = [...events.values()].sort((a, b) => a.calendarDate.localeCompare(b.calendarDate) || (a.timeHkt ?? "99:99").localeCompare(b.timeHkt ?? "99:99") || a.company.localeCompare(b.company));
  const missing = issuers.filter(i => !result.some(e => e.id === i.id)).map(i => ({ ...i, reason: "No exact earnings date found for this month in the checked sources; not confirmation of no earnings" }));
  return { month, generatedAt: Date.now(), events: result, warnings, scannedContracts: bn.length + bg.length, trackedContracts: issuers.reduce((n, i) => n + i.contracts.length, 0), issuers: issuers.length,
    exchangeCounts: { Binance: bn.length, Bitget: bg.length }, excluded: universe.excluded, unresolved: universe.unresolved, missing,
    markets: Object.fromEntries((["US", "JP", "KR"] as const).map(m => [m, { issuers: issuers.filter(i => i.market === m).length, events: result.filter(e => e.market === m).length, withoutDate: missing.filter(i => i.market === m).length }])) as EarningsPayload["markets"], sourceStatus };
}
