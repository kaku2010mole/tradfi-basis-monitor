type NewsArticle = {
  id: string;
  title: string;
  url: string;
  source: string;
  feed: "Yahoo Finance" | "Google News · US" | "Google News · HK" | "Bing News";
  publishedAt: number;
};

type YahooNews = {
  uuid?: string;
  title?: string;
  publisher?: string;
  link?: string;
  providerPublishTime?: number | string;
};

const RECENT_WINDOW_MS = 48 * 60 * 60_000;
const MAX_ARTICLES = 12;
const FETCH_TIMEOUT_MS = 7_000;
const RESPONSE_CACHE_MS = 45_000;
const responseCache = new Map<string, { expiresAt: number; payload: NewsResponse }>();

type NewsResponse = {
  symbol: string;
  venue: "Hyperliquid" | "Binance";
  query: string;
  generatedAt: number;
  windowHours: number;
  refreshAfterMs: number;
  sources: Array<{ name: string; ok: boolean; count: number }>;
  articles: NewsArticle[];
};

const SEARCH_ALIASES: Record<string, { yahoo: string; google: string }> = {
  AAPL: { yahoo: "AAPL", google: "Apple AAPL stock" },
  QQQ: { yahoo: "QQQ", google: "Invesco QQQ Nasdaq 100" },
  SKHYNIX: { yahoo: "SK Hynix", google: "SK Hynix 000660 Korea" },
  CSOPSKHYNIX2L: { yahoo: "SK Hynix", google: "CSOP SK Hynix 2x leveraged 07205" },
  SAMSUNG: { yahoo: "Samsung Electronics", google: "Samsung Electronics 005930 Korea" },
  CSOPSAMSUNG2L: { yahoo: "Samsung Electronics", google: "CSOP Samsung Electronics 2x leveraged" },
  POPMART: { yahoo: "Pop Mart", google: "Pop Mart 9992 Hong Kong" },
  KUAISHOU: { yahoo: "Kuaishou", google: "Kuaishou 1024 Hong Kong" },
  MEITUAN: { yahoo: "Meituan", google: "Meituan 3690 Hong Kong" },
  LGELECTRONICS: { yahoo: "LG Electronics", google: "LG Electronics 066570 Korea" },
  KODEX200: { yahoo: "KODEX 200", google: "KODEX 200 ETF Korea" },
  ZHONGJI: { yahoo: "Zhongji Innolight", google: "Zhongji Innolight 300308" },
  HK0700: { yahoo: "0700.HK", google: "Tencent 0700.HK" },
  TENCENT: { yahoo: "0700.HK", google: "Tencent 0700.HK" },
  HK1810: { yahoo: "1810.HK", google: "Xiaomi 1810.HK" },
  USTECH: { yahoo: "QQQ", google: "Nasdaq 100 technology index" },
  US500: { yahoo: "SPY", google: "S&P 500 index" },
  GOLD: { yahoo: "GC=F", google: "gold price futures" },
  XAU: { yahoo: "GC=F", google: "gold price futures" },
  SILVER: { yahoo: "SI=F", google: "silver price futures" },
  XAG: { yahoo: "SI=F", google: "silver price futures" },
  OIL: { yahoo: "CL=F", google: "WTI crude oil futures" },
  CL: { yahoo: "CL=F", google: "WTI crude oil futures" },
  BZ: { yahoo: "BZ=F", google: "Brent crude oil futures" },
  BTCD: { yahoo: "BTC-USD", google: "Bitcoin dominance crypto market" },
};

const decodeXml = (value: string) => value
  .replace(/^<!\[CDATA\[|\]\]>$/g, "")
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&quot;/g, "\"")
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, "")
  .trim();

const tagValue = (xml: string, tag: string) => {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
};

const safeHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

const normalizedSymbol = (value: string) => value.trim().toUpperCase()
  .replace(/^(XYZ|MKTS|PARA):/, "")
  .replace(/BTC\.D$/, "BTCD")
  .replace(/USDT$/, "");

const searchTerms = (symbol: string) => {
  const base = normalizedSymbol(symbol);
  const alias = SEARCH_ALIASES[base];
  if (alias) return alias;
  if (/^HK\d{4}$/.test(base)) {
    const number = base.slice(2);
    return { yahoo: `${number}.HK`, google: `${number}.HK Hong Kong stock` };
  }
  return { yahoo: base, google: `${base} stock ETF market` };
};

async function fetchText(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; TradFiBasisMonitor/1.0)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`News source returned HTTP ${response.status}.`);
  return response.text();
}

async function getYahooNews(query: string): Promise<NewsArticle[]> {
  const params = new URLSearchParams({ q: query, quotesCount: "1", newsCount: "12", enableFuzzyQuery: "false" });
  const payload = JSON.parse(await fetchText(`https://query2.finance.yahoo.com/v1/finance/search?${params}`)) as { news?: YahooNews[] };
  return (payload.news ?? []).flatMap((item) => {
    const title = String(item.title ?? "").trim();
    const source = String(item.publisher ?? "").trim() || "Unknown source";
    const url = safeHttpUrl(String(item.link ?? ""));
    const rawTime = item.providerPublishTime;
    const publishedAt = typeof rawTime === "number" ? rawTime * 1000 : Date.parse(String(rawTime ?? ""));
    if (!title || !url || !Number.isFinite(publishedAt)) return [];
    return [{
      id: `yahoo:${item.uuid || `${publishedAt}:${title}`}`,
      title,
      url,
      source,
      feed: "Yahoo Finance" as const,
      publishedAt,
    }];
  });
}

async function getGoogleNews(query: string, edition: "US" | "HK"): Promise<NewsArticle[]> {
  const locale = edition === "HK" ? { hl: "en-HK", gl: "HK", ceid: "HK:en" } : { hl: "en-US", gl: "US", ceid: "US:en" };
  const feed = `Google News · ${edition}` as const;
  const params = new URLSearchParams({ q: `${query} when:2d`, ...locale });
  const xml = await fetchText(`https://news.google.com/rss/search?${params}`);
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return items.flatMap((item) => {
    const rawTitle = tagValue(item, "title");
    const source = tagValue(item, "source") || "Unknown source";
    const title = rawTitle.endsWith(` - ${source}`) ? rawTitle.slice(0, -(source.length + 3)).trim() : rawTitle;
    const url = safeHttpUrl(tagValue(item, "link"));
    const publishedAt = Date.parse(tagValue(item, "pubDate"));
    if (!title || !url || !Number.isFinite(publishedAt)) return [];
    return [{
      id: `google:${tagValue(item, "guid") || `${publishedAt}:${title}`}`,
      title,
      url,
      source,
      feed,
      publishedAt,
    }];
  });
}

const bingDestination = (value: string) => {
  const redirect = safeHttpUrl(value);
  if (!redirect) return null;
  try {
    const original = new URL(redirect).searchParams.get("url");
    return original ? safeHttpUrl(original) ?? redirect : redirect;
  } catch {
    return redirect;
  }
};

async function getBingNews(query: string): Promise<NewsArticle[]> {
  const params = new URLSearchParams({ q: query, format: "rss", setlang: "en-US", cc: "us" });
  const xml = await fetchText(`https://www.bing.com/news/search?${params}`);
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return items.flatMap((item) => {
    const title = tagValue(item, "title");
    const source = tagValue(item, "News:Source") || tagValue(item, "source") || "Unknown source";
    const url = bingDestination(tagValue(item, "link"));
    const publishedAt = Date.parse(tagValue(item, "pubDate"));
    if (!title || !url || !Number.isFinite(publishedAt)) return [];
    return [{
      id: `bing:${publishedAt}:${title}`,
      title,
      url,
      source,
      feed: "Bing News" as const,
      publishedAt,
    }];
  });
}

const articleKey = (article: NewsArticle) => article.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function diversifyArticles(candidates: NewsArticle[]) {
  const remaining = [...candidates].sort((a, b) => b.publishedAt - a.publishedAt);
  const selected: NewsArticle[] = [];
  const seen = new Set<string>();
  const feedCounts = new Map<string, number>();
  const publisherCounts = new Map<string, number>();
  while (selected.length < MAX_ARTICLES && remaining.length) {
    remaining.sort((left, right) => {
      const feedDifference = (feedCounts.get(left.feed) ?? 0) - (feedCounts.get(right.feed) ?? 0);
      if (feedDifference) return feedDifference;
      const publisherDifference = (publisherCounts.get(left.source.toLowerCase()) ?? 0) - (publisherCounts.get(right.source.toLowerCase()) ?? 0);
      return publisherDifference || right.publishedAt - left.publishedAt;
    });
    const article = remaining.shift()!;
    const key = articleKey(article);
    if (!key || seen.has(key)) continue;
    const publisherKey = article.source.toLowerCase();
    if ((publisherCounts.get(publisherKey) ?? 0) >= 3) continue;
    seen.add(key);
    selected.push(article);
    feedCounts.set(article.feed, (feedCounts.get(article.feed) ?? 0) + 1);
    publisherCounts.set(publisherKey, (publisherCounts.get(publisherKey) ?? 0) + 1);
  }
  return selected;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol")?.trim() ?? "";
  const venue = url.searchParams.get("venue") === "Hyperliquid" ? "Hyperliquid" : "Binance";
  if (!/^[A-Za-z0-9:._-]{1,40}$/.test(symbol)) {
    return Response.json({ error: "Invalid contract symbol." }, { status: 400 });
  }

  const cacheKey = `${venue}:${symbol.toUpperCase()}`;
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return Response.json(cached.payload, { headers: { "Cache-Control": "no-store, max-age=0" } });
  }

  const terms = searchTerms(symbol);
  const [yahoo, googleUs, googleHk, bing] = await Promise.allSettled([
    getYahooNews(terms.yahoo),
    getGoogleNews(terms.google, "US"),
    getGoogleNews(terms.google, "HK"),
    getBingNews(terms.google),
  ]);
  const sourceStatus = [
    { name: "Yahoo Finance", ok: yahoo.status === "fulfilled", count: yahoo.status === "fulfilled" ? yahoo.value.length : 0 },
    { name: "Google News · US", ok: googleUs.status === "fulfilled", count: googleUs.status === "fulfilled" ? googleUs.value.length : 0 },
    { name: "Google News · HK", ok: googleHk.status === "fulfilled", count: googleHk.status === "fulfilled" ? googleHk.value.length : 0 },
    { name: "Bing News", ok: bing.status === "fulfilled", count: bing.status === "fulfilled" ? bing.value.length : 0 },
  ];
  if ([yahoo, googleUs, googleHk, bing].every((result) => result.status === "rejected")) {
    return Response.json({ error: "Live news sources are temporarily unavailable.", sources: sourceStatus }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const candidates = [
    ...(yahoo.status === "fulfilled" ? yahoo.value : []),
    ...(googleUs.status === "fulfilled" ? googleUs.value : []),
    ...(googleHk.status === "fulfilled" ? googleHk.value : []),
    ...(bing.status === "fulfilled" ? bing.value : []),
  ].filter((article) => article.publishedAt >= cutoff && article.publishedAt <= Date.now() + 5 * 60_000)
    .sort((a, b) => b.publishedAt - a.publishedAt);
  const articles = diversifyArticles(candidates);

  const payload: NewsResponse = {
    symbol,
    venue,
    query: terms.google,
    generatedAt: Date.now(),
    windowHours: RECENT_WINDOW_MS / 60 / 60_000,
    refreshAfterMs: 60_000,
    sources: sourceStatus,
    articles,
  };
  if (responseCache.size > 250) responseCache.clear();
  responseCache.set(cacheKey, { expiresAt: Date.now() + RESPONSE_CACHE_MS, payload });
  return Response.json(payload, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
