/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/markets") {
      return getMarkets();
    }

    if (url.pathname === "/api/anchor") {
      return getAnchor(url);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
    },
  });

async function getMarkets() {
  const markets: Array<Record<string, unknown>> = [];
  const sources = { hyperliquid: false, binance: false };
  const errors: string[] = [];

  try {
    const hyper = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
      return response.json() as Promise<[{
      universe: Array<{ name: string; isDelisted?: boolean }>;
      }, Array<{ midPx?: string; funding?: string }>]>;
    });
    const now = Date.now();
    hyper[0].universe.forEach((asset, index) => {
      if (asset.isDelisted) return;
      const context = hyper[1][index] ?? {};
      const mid = Number(context.midPx);
      markets.push({
        venue: "Hyperliquid",
        symbol: asset.name,
        displaySymbol: asset.name.replace(/^xyz:/, ""),
        category: "xyz perpetual",
        mid: Number.isFinite(mid) ? mid : null,
        bid: null,
        ask: null,
        funding: Number.isFinite(Number(context.funding)) ? Number(context.funding) : null,
        fundingHours: 1,
        updatedAt: now,
      });
    });
    sources.hyperliquid = true;
  } catch (error) {
    errors.push(String(error));
  }

  try {
    const requireJson = async <T,>(url: string): Promise<T> => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      return response.json() as Promise<T>;
    };
    const [exchangeInfo, bookTicker, premiumIndex, fundingInfo] = await Promise.all([
      requireJson<{
        symbols: Array<{ symbol: string; status: string; underlyingType?: string; underlyingSubType?: string[] }>;
      }>("https://fapi.binance.com/fapi/v1/exchangeInfo"),
      requireJson<Array<{
        symbol: string; bidPrice: string; askPrice: string; time: number;
      }>>("https://fapi.binance.com/fapi/v1/ticker/bookTicker"),
      requireJson<Array<{
        symbol: string; lastFundingRate: string; time: number;
      }>>("https://fapi.binance.com/fapi/v1/premiumIndex"),
      requireJson<Array<{
        symbol: string; fundingIntervalHours: number;
      }>>("https://fapi.binance.com/fapi/v1/fundingInfo").catch(() => []),
    ]);

    const now = Date.now();
    const books = new Map(bookTicker.map((item) => [item.symbol, item]));
    const premiums = new Map(premiumIndex.map((item) => [item.symbol, item]));
    const intervals = new Map(fundingInfo.map((item) => [item.symbol, item.fundingIntervalHours]));

    exchangeInfo.symbols
      .filter((symbol) =>
        symbol.status === "TRADING" &&
        symbol.underlyingSubType?.some((tag) => tag.toLowerCase() === "tradfi"))
      .forEach((symbol) => {
        const book = books.get(symbol.symbol);
        const premium = premiums.get(symbol.symbol);
        const bid = Number(book?.bidPrice);
        const ask = Number(book?.askPrice);
        markets.push({
          venue: "Binance",
          symbol: symbol.symbol,
          displaySymbol: symbol.symbol,
          category: `${symbol.underlyingType ?? "TradFi"} · TradFi`,
          bid: Number.isFinite(bid) && bid > 0 ? bid : null,
          ask: Number.isFinite(ask) && ask > 0 ? ask : null,
          mid: Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null,
          funding: Number.isFinite(Number(premium?.lastFundingRate)) ? Number(premium?.lastFundingRate) : null,
          fundingHours: intervals.get(symbol.symbol) ?? 8,
          updatedAt: book?.time ?? premium?.time ?? now,
        });
      });
    sources.binance = true;
  } catch (error) {
    errors.push(String(error));
  }

  if (!markets.length) return json({ error: "Market data sources unavailable", errors }, 502);
  return json({ markets, timestamp: Date.now(), sources }, 200, "public, max-age=2, s-maxage=2");
}

async function getAnchor(url: URL) {
  const venue = url.searchParams.get("venue");
  const symbol = url.searchParams.get("symbol");
  const at = Number(url.searchParams.get("at"));
  if (!symbol || !Number.isFinite(at)) return json({ error: "Invalid parameters" }, 400);

  try {
    if (venue === "Hyperliquid") {
      const response = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "candleSnapshot",
          req: { coin: symbol, interval: "1m", startTime: at - 3 * 24 * 3600_000, endTime: at + 60_000 },
        }),
      });
      const candles = await response.json() as Array<{ t: number; c: string }>;
      const candle = candles.filter((item) => item.t <= at).at(-1);
      return json({ price: candle ? Number(candle.c) : null, timestamp: candle?.t ?? null }, 200, "public, max-age=3600");
    }

    if (venue === "Binance") {
      const params = new URLSearchParams({
        symbol,
        interval: "1m",
        startTime: String(at - 3 * 24 * 3600_000),
        endTime: String(at + 60_000),
        limit: "1500",
      });
      const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${params}`);
      const candles = await response.json() as Array<[number, string, string, string, string]>;
      const candle = candles.filter((item) => item[0] <= at).at(-1);
      return json({ price: candle ? Number(candle[4]) : null, timestamp: candle?.[0] ?? null }, 200, "public, max-age=3600");
    }

    return json({ error: "Unknown venue" }, 400);
  } catch (error) {
    return json({ error: "Anchor unavailable", detail: String(error) }, 502);
  }
}
