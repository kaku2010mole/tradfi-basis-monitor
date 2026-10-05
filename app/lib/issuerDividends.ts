export type IssuerDate = { recordDate: string; paymentDate: string | null; amount: number | null; standing: boolean; sourceUrl: string };
type Issuer = { company: string; market: "KR" | "JP"; code: string; symbols: string[]; url: string; standing?: Array<[number, number]>; samsungNotices?: boolean };
export type IssuerScan = { company: string; market: "KR" | "JP"; code: string; symbols: string[]; sourceUrl: string; dates: IssuerDate[]; status: "dates_found" | "no_confirmed_dates" | "unavailable" | "verified_snapshot"; error?: string };

export const ASIAN_ISSUERS: Issuer[] = [
  { company: "Samsung Electronics", market: "KR", code: "005930", symbols: ["SAMSUNG"], url: "https://www.samsung.com/global/ir/reports-disclosures/notices/", samsungNotices: true },
  { company: "SK hynix", market: "KR", code: "000660", symbols: ["SKHYNIX"], url: "https://m.skhynix.com/ir/UI-FR-IR05/" },
  { company: "Hyundai Motor", market: "KR", code: "005380", symbols: ["HYUNDAI"], url: "https://www.hyundai.com/worldwide/en/company/ir/stock-information/shareholder-return-policy" },
  { company: "NAVER", market: "KR", code: "035420", symbols: ["NAVER"], url: "https://www.navercorp.com/en/investment/irNotice" },
  { company: "Hanmi Semiconductor", market: "KR", code: "042700", symbols: ["HANMI"], url: "https://www.hanmisemi.com/" },
  { company: "LG Electronics", market: "KR", code: "066570", symbols: ["LGELECTRONICS"], url: "https://www.lg.com/global/investor-relations/stock-information/" },
  { company: "Samsung Electro-Mechanics", market: "KR", code: "009150", symbols: ["SAMSUNGEM"], url: "https://www.samsungsem.com/global/about-us/investor-relations/shareholder.do" },
  { company: "Doosan Enerbility", market: "KR", code: "034020", symbols: ["DOOSENER"], url: "https://www.doosanenerbility.com/kr/investment/governance_stock" },
  { company: "Doosan Robotics", market: "KR", code: "454910", symbols: ["DOOSBOT"], url: "https://www.doosanrobotics.com/kr/investment/governance/stock/" },
  { company: "Kioxia", market: "JP", code: "285A", symbols: ["KIOXIA"], url: "https://www.kioxia-holdings.com/en-jp/ir/news.html" },
  { company: "Sumitomo Electric", market: "JP", code: "5802", symbols: ["SUMIELEC"], url: "https://sumitomoelectric.com/ir/stock-info/status", standing: [[3, 31], [9, 30]] },
  { company: "Sony Group", market: "JP", code: "6758", symbols: ["SONY"], url: "https://www.sony.com/ja/SonyInfo/IR/faq/dividend.html", standing: [[3, 31], [9, 30]] },
  { company: "Advantest", market: "JP", code: "6857", symbols: ["ADVANTEST"], url: "https://www.advantest.com/en/investors/shares-and-corporate-bonds/share-information/", standing: [[3, 31], [9, 30]] },
  { company: "Lasertec", market: "JP", code: "6920", symbols: ["LASERTEC"], url: "https://www.lasertec.co.jp/en/ir/stock/allotment.html" },
  { company: "Toyota Motor", market: "JP", code: "7203", symbols: ["TM"], url: "https://global.toyota/en/ir/stock/outline/", standing: [[3, 31], [9, 30]] },
  { company: "Tokyo Electron", market: "JP", code: "8035", symbols: ["TOKYOEL"], url: "https://www.tel.com/ir/stocks/dividend/" },
  { company: "MUFG", market: "JP", code: "8306", symbols: ["MUFG"], url: "https://www.mufg.jp/english/ir/stock/procedure/index.html", standing: [[3, 31], [9, 30]] },
  { company: "SoftBank Group", market: "JP", code: "9984", symbols: ["SOFTBANK"], url: "https://group.softbank/en/ir/calendar" },
];

const text = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (year: number, month: number, day: number) => {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
};
export function parseIssuerDate(value: string) {
  const numeric = value.match(/\b(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/);
  if (numeric) return iso(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
  const english = value.match(/\b([A-Za-z]+)\.?\s*(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(20\d{2})\b/);
  if (!english) return null;
  return iso(Number(english[3]), months.indexOf(english[1].slice(0, 3).toLowerCase()) + 1, Number(english[2]));
}

export function parseIssuerDates(html: string, issuer: Issuer, year: number): IssuerDate[] {
  const dates = new Map<string, IssuerDate>();
  const add = (recordDate: string | null, paymentDate: string | null = null, amount: number | null = null, standing = false) => {
    if (recordDate) dates.set(recordDate, { recordDate, paymentDate, amount: amount !== null && amount > 0 ? amount : null, standing, sourceUrl: issuer.url });
  };
  const body = text(html);
  if (issuer.samsungNotices) {
    for (const match of body.matchAll(/inform you that ([A-Za-z]+\s+\d{1,2},?\s+20\d{2}) will be the record date[^.]{0,160}dividend/gi)) add(parseIssuerDate(match[1]));
  }
  for (const table of html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) ?? []) {
    // Only tables explicitly identifying dividend record dates qualify.
    // Financial years, AGM dates and article publication dates are not events.
    if (!/(?:dividend.{0,30}record date|record date.{0,60}dividend|effective date|基準日|배당기준일)/i.test(text(table))) continue;
    for (const row of table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => text(match[1]));
      const dated = cells.flatMap((cell, index) => { const date = parseIssuerDate(cell); return date ? [{ date, index }] : []; });
      if (dated.length < 2) continue;
      const record = dated[0]; const payment = dated.at(-1)!;
      const amountCell = cells.filter((cell, index) => index > record.index && !dated.some((item) => item.index === index)).find((cell) => /^(?:[\d,.]+)(?:\s*(?:yen|円|won|KRW|JPY))?$/i.test(cell));
      const amount = amountCell ? Number(amountCell.replace(/[^\d.]/g, "")) : null;
      add(record.date, payment.date, amount);
    }
  }
  if (issuer.standing) {
    const recordContext = body.match(/(?:Record Dates?|Dividend payout confirmation date|株主確定日)[\s\S]{0,420}/i)?.[0] ?? "";
    const datesPresent = issuer.standing.every(([month, day]) => {
      const english = new RegExp(`${months[month - 1]}[a-z]*\\.?\\s*${day}\\b`, "i");
      const japanese = new RegExp(`${month}月${day}日`);
      return english.test(recordContext) || japanese.test(recordContext);
    });
    if (datesPresent && /dividend|配当|お支払い/i.test(body)) issuer.standing.forEach(([month, day]) => add(iso(year, month, day), null, null, true));
  }
  if (issuer.symbols.includes("SOFTBANK")) {
    for (const table of html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) ?? []) {
      let rowYear: number | null = null;
      for (const row of table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
        const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => text(match[1]));
        const explicitYear = cells.find((cell) => /^20\d{2}$/.test(cell));
        if (explicitYear) rowYear = Number(explicitYear);
        if (!rowYear || !/dividend record date/i.test(cells.join(" "))) continue;
        const shortDate = cells.join(" ").match(/\b([A-Za-z]{3})\.?\s*(\d{1,2})\b/);
        if (shortDate) add(iso(rowYear, months.indexOf(shortDate[1].toLowerCase()) + 1, Number(shortDate[2])), null, null, true);
      }
    }
  }
  return [...dates.values()];
}

// Official company pages checked on 2026-10-05. Preserve these verified
// facts when an issuer temporarily blocks the live refresh. These are record
// dates only; they never imply an exchange adjustment or an ex-dividend date.
const VERIFIED_ISSUER_DATES: Record<string, Array<[string, string | null, number | null, boolean, string?]>> = {
  SAMSUNG: [["2026-03-31", null, null, false], ["2026-06-30", null, null, false], ["2026-09-30", null, null, false]],
  HYUNDAI: [["2026-02-28", "2026-04-24", 2500, false], ["2026-05-31", "2026-06-30", 2500, false], ["2026-08-31", "2026-09-30", 2500, false]],
  LASERTEC: [["2025-12-31", "2026-03-12", 132, false], ["2026-06-30", "2026-09-28", 197, false], ["2026-12-31", null, null, true, "https://www.lasertec.co.jp/en/ir/stock/outline.html"]],
  SUMIELEC: [["2026-03-31", null, null, true], ["2026-09-30", null, null, true]],
  SONY: [["2026-03-31", null, null, true], ["2026-09-30", null, null, true]],
  ADVANTEST: [["2026-03-31", null, null, true], ["2026-09-30", null, null, true], ["2027-03-31", null, null, true]],
  TM: [["2026-03-31", null, null, true], ["2026-09-30", null, null, true]],
  MUFG: [["2026-03-31", null, null, true], ["2026-09-30", null, null, true]],
  SOFTBANK: [["2026-09-30", null, null, true]],
};
const verifiedSnapshot = (issuer: Issuer): IssuerDate[] => (VERIFIED_ISSUER_DATES[issuer.symbols[0]] ?? []).map(([recordDate, paymentDate, amount, standing, sourceUrl]) => ({ recordDate, paymentDate, amount, standing, sourceUrl: sourceUrl ?? issuer.url }));

export async function scanAsianIssuers(contracts: string[], year: number): Promise<IssuerScan[]> {
  const wanted = new Set(contracts.map((symbol) => symbol.replace(/USDT$/, "")));
  return Promise.all(ASIAN_ISSUERS.filter((issuer) => issuer.symbols.some((symbol) => wanted.has(symbol))).map(async (issuer) => {
    const base = { company: issuer.company, market: issuer.market, code: issuer.code, symbols: issuer.symbols, sourceUrl: issuer.url };
    try {
      const response = await fetch(issuer.url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }, signal: AbortSignal.timeout(9_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (/captcha|access denied|just a moment/i.test(text(html).slice(0, 500))) throw new Error("Issuer website unavailable");
      const parsed = parseIssuerDates(html, issuer, year);
      const merged = new Map(verifiedSnapshot(issuer).map((date) => [date.recordDate, date]));
      parsed.forEach((date) => merged.set(date.recordDate, date));
      const dates = [...merged.values()];
      return { ...base, dates, status: parsed.length ? "dates_found" : dates.length ? "verified_snapshot" : "no_confirmed_dates" } satisfies IssuerScan;
    } catch (error) {
      const dates = verifiedSnapshot(issuer);
      return { ...base, dates, status: dates.length ? "verified_snapshot" : "unavailable", error: error instanceof Error ? error.message : "Issuer source unavailable" } satisfies IssuerScan;
    }
  }));
}
