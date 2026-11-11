import seed from "../data/diskDramHoldings.json";

export type BasketHolding = {
  symbol: string;
  name: string;
  currency: string;
  weight: number;
  quantity?: number;
  proxy?: boolean;
};
export type FundHoldings = {
  asOf: string;
  source: string;
  holdings: BasketHolding[];
  cashWeight: number;
  warning?: string;
};
type HoldingsPair = { DISK: FundHoldings; DRAM: FundHoldings };

const DAY = 86_400_000;
const TEMA_PAGE = "https://temaetfs.com/disk";
const ROUNDHILL_BASE = "https://www.roundhillinvestments.com/assets/data/FilepointRoundhill.40RU.RU_Holdings_";
const slots = new Map<string, { value?: HoldingsPair; retryAt: number; pending?: Promise<HoldingsPair> }>();

function csv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      row.push(cell); cell = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else cell += char;
  }
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  if (quoted) throw new Error("Holdings CSV is incomplete");
  const header = rows.shift()?.map((value) => value.replace(/^\uFEFF/, "").trim());
  if (!header?.length || header[0].startsWith("<")) throw new Error("Holdings CSV unavailable");
  return rows.map((values) => Object.fromEntries(header.map((key, i) => [key, values[i] ?? ""])));
}

const number = (value: string | undefined) => Number(value?.replaceAll(",", "").replace(/%$/, ""));

function instrument(ticker: string, name: string) {
  if (/CHANGXIN|CXMT/i.test(name)) return { symbol: "688825.SS", currency: "CNY", proxy: true };
  const code = ticker.split(" ")[0];
  if (/^\d{6} KS$/.test(ticker)) return { symbol: `${code}.KS`, currency: "KRW" };
  if (/^[A-Z0-9]{4} JP$/.test(ticker)) return { symbol: `${code}.T`, currency: "JPY" };
  if (/^\d{4} TT$/.test(ticker)) return { symbol: `${code}.${code === "5289" ? "TWO" : "TW"}`, currency: "TWD" };
  if (/^\d{6} C[12]$/.test(ticker)) return { symbol: `${code}.${ticker.endsWith("C1") ? "SS" : "SZ"}`, currency: "CNY" };
  if (/^[A-Z][A-Z0-9.-]{0,12}$/.test(ticker)) return { symbol: ticker, currency: "USD" };
  if (/MICRON/i.test(name)) return { symbol: "MU", currency: "USD" };
  if (/SK HYNIX/i.test(name)) return { symbol: "000660.KS", currency: "KRW" };
  if (/SAMSUNG/i.test(name)) return { symbol: "005930.KS", currency: "KRW" };
  return null;
}

function validate(fund: FundHoldings, anchorDate: string) {
  const age = Date.parse(anchorDate) - Date.parse(fund.asOf);
  const exposure = fund.holdings.reduce((sum, holding) => sum + holding.weight, 0);
  if (!Number.isFinite(age) || age < 0 || age > 7 * DAY || fund.holdings.length < 5 ||
      !Number.isFinite(exposure) || exposure < .85 || exposure > 1.1 ||
      !Number.isFinite(fund.cashWeight) || Math.abs(exposure + fund.cashWeight - 1) > .02 ||
      fund.holdings.some((holding) => !Number.isFinite(holding.weight) || holding.weight <= 0)) {
    throw new Error("Holdings date or exposure is not comparable with the cash anchor");
  }
  return fund;
}

export function parseDiskHoldings(text: string, source: string, anchorDate: string): FundHoldings {
  const rows = csv(text);
  const date = rows[0]?.holdings_date;
  const holdings: BasketHolding[] = [];
  let cashWeight = 0;
  for (const row of rows) {
    if (row.holdings_date !== date) throw new Error("DISK holdings dates disagree");
    const weight = number(row.percent_of_nav);
    if (row.is_cash === "1") { cashWeight += weight; continue; }
    const item = instrument(row.ticker, row.proper_name);
    if (!item) throw new Error("Unmapped DISK constituent");
    holdings.push({ ...item, name: row.proper_name, weight, quantity: number(row.shares) });
  }
  return validate({
    asOf: date, source, holdings, cashWeight,
    // The currently published file has date/valuation inconsistencies. Returns
    // use independent cash prices, rather than the file's per-share values.
    warning: "Published holdings date may differ from valuation time; independent cash-price anchors are used.",
  }, anchorDate);
}

export function parseDramHoldings(text: string, source: string, asOf: string, anchorDate: string): FundHoldings {
  const rows = csv(text).filter((row) => row.Account === "DRAM");
  const nav = number(rows[0]?.NetAssets);
  if (!(nav > 0)) throw new Error("DRAM holdings NAV unavailable");
  const grouped = new Map<string, BasketHolding>();
  for (const row of rows) {
    if (number(row.NetAssets) !== nav) throw new Error("DRAM holdings NAVs disagree");
    if (/^(?:912[0-9A-Z]+|FGXXX|Cash&Other|USD|KRW|JPY|TWD|CNY)$/.test(row.StockTicker)) continue;
    const item = instrument(row.StockTicker, row.SecurityName);
    if (!item) throw new Error("Unmapped DRAM constituent");
    const weight = number(row.MarketValue) / nav;
    const previous = grouped.get(item.symbol);
    if (previous) {
      previous.weight += weight;
      previous.quantity = (previous.quantity ?? 0) + number(row.Shares);
    } else grouped.set(item.symbol, { ...item, name: row.SecurityName.replace(/[- ]?SWAP.*$/i, ""), weight, quantity: number(row.Shares) });
  }
  const holdings = [...grouped.values()];
  const stockExposure = holdings.reduce((sum, row) => sum + row.weight, 0);
  // Treasury/money-fund collateral and Cash&Other offset the swap accounting.
  // Combined stock + total-return-swap exposure is the economic stock weight.
  return validate({ asOf, source, holdings, cashWeight: 1 - stockExposure }, anchorDate);
}

async function text(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "text/csv,text/html;q=0.9", "User-Agent": "Mozilla/5.0" },
    cache: "no-store", signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error("Issuer holdings temporarily unavailable");
  return response.text();
}

function saved(fund: FundHoldings, anchorDate: string, previous?: FundHoldings) {
  const candidate = validate(previous ?? fund, anchorDate);
  return { ...candidate, warning: [candidate.warning, "Last verified issuer snapshot retained."].filter(Boolean).join(" ") };
}

async function disk(anchorDate: string, previous?: FundHoldings) {
  try {
    const page = await text(TEMA_PAGE);
    const links = [...page.matchAll(/https:\/\/temaetfs\.com\/hubfs\/Website\/Holdings\/DISK-holdings-(\d{2})(\d{2})(\d{4})\.csv(?:\?[^"<>\s]*)?/g)]
      .map((match) => ({ url: match[0].replaceAll("&amp;", "&"), date: `${match[3]}-${match[1]}-${match[2]}` }))
      .filter((link) => link.date <= anchorDate).sort((a, b) => b.date.localeCompare(a.date));
    if (!links.length) throw new Error("No comparable DISK holdings link");
    return parseDiskHoldings(await text(links[0].url), links[0].url, anchorDate);
  } catch { return saved(seed.DISK, anchorDate, previous); }
}

async function dram(anchorDate: string, previous?: FundHoldings) {
  const stamp = `${anchorDate.slice(5, 7)}${anchorDate.slice(8, 10)}${anchorDate.slice(0, 4)}`;
  const source = `${ROUNDHILL_BASE}${stamp}.csv`;
  try {
    // The file name is the valuation date. Its Date column is next-day delivery
    // metadata, which the issuer's own frontend shifts back by one day.
    return parseDramHoldings(await text(source), source, anchorDate, anchorDate);
  } catch { return saved(seed.DRAM, anchorDate, previous); }
}

export async function getDiskDramHoldings(anchorDate: string, now = Date.now()): Promise<HoldingsPair> {
  let slot = slots.get(anchorDate);
  if (!slot) {
    slot = { retryAt: 0 };
    if (slots.size >= 4) slots.delete(slots.keys().next().value!);
    slots.set(anchorDate, slot);
  }
  if (!slot.pending && now >= slot.retryAt) {
    const target = slot;
    target.pending = Promise.all([disk(anchorDate, target.value?.DISK), dram(anchorDate, target.value?.DRAM)])
      .then(([DISK, DRAM]) => {
        target.value = { DISK, DRAM };
        target.retryAt = Date.now() + 3_600_000;
        return target.value;
      }).catch((error) => { target.retryAt = Date.now() + 60_000; throw error; })
      .finally(() => { delete target.pending; });
  }
  if (slot.pending) return slot.pending;
  if (slot.value) return slot.value;
  throw new Error("Issuer holdings unavailable for the cash anchor");
}
