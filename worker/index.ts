/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SITE_PASSWORD?: string;
  FUTU_PUSH_TOKEN?: string;
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
  async fetch(request: Request, env: Env | undefined, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const sitePassword =
      env?.SITE_PASSWORD ??
      (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.SITE_PASSWORD;

    if (url.pathname === "/api/hk-auction/ingest" && request.method === "POST") {
      return handleFutuIngest(request, env?.FUTU_PUSH_TOKEN, sitePassword);
    }

    if (sitePassword) {
      if (url.pathname === "/login") {
        return handleLogin(request, sitePassword);
      }

      if (url.pathname === "/logout" && request.method === "POST") {
        return new Response(null, {
          status: 303,
          headers: {
            location: "/login",
            "set-cookie": `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
            "cache-control": "no-store",
          },
        });
      }

      if (!(await isAuthorized(request, sitePassword))) {
        if (url.pathname.startsWith("/api/")) {
          return json({ error: "Authentication required", login: "/login" }, 401);
        }
        return Response.redirect(new URL("/login", request.url), 302);
      }
    }

    if (url.pathname === "/api/markets") {
      return getMarkets();
    }

    if (url.pathname === "/api/anchor") {
      return getAnchor(url);
    }

    if (url.pathname === "/_vinext/image") {
      if (!env?.ASSETS || !env.IMAGES) {
        return new Response("Image optimization unavailable", { status: 503 });
      }
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env as Env, ctx);
  },
};

export default worker;

const AUTH_COOKIE = "tradfi_access";
const AUTH_MESSAGE = "tradfi-basis-monitor-access-v1";
const FUTU_PUSH_MESSAGE = "futu-opend-readonly-push-v1:";
const encoder = new TextEncoder();

type FutuPushPayload = {
  generatedAt: number;
  quotes: Array<Record<string, unknown>>;
  orderbooks?: Array<Record<string, unknown>>;
  history?: Record<string, Array<[number, number]>>;
};

type FutuPushStore = typeof globalThis & {
  __FUTU_PUSH_SNAPSHOT__?: { payload: FutuPushPayload; receivedAt: number };
};

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function valuesMatch(value: string, expected: string) {
  const [left, right] = await Promise.all([digest(value), digest(expected)]);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function accessToken(password: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(AUTH_MESSAGE)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function handleFutuIngest(request: Request, configuredToken?: string, sitePassword?: string) {
  const expected = configuredToken?.trim() || (sitePassword ? hex(await digest(`${FUTU_PUSH_MESSAGE}${sitePassword}`)) : "");
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!expected || supplied.length > 256 || !(await valuesMatch(supplied, expected))) {
    return json({ error: "Invalid Futu push credential." }, 401);
  }

  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > 512_000) return json({ error: "Futu payload is too large." }, 413);
  let payload: FutuPushPayload;
  try {
    payload = await request.json() as FutuPushPayload;
  } catch {
    return json({ error: "Invalid Futu payload." }, 400);
  }
  const now = Date.now();
  if (
    !payload || !Number.isFinite(payload.generatedAt) || Math.abs(now - payload.generatedAt) > 30_000 ||
    !Array.isArray(payload.quotes) || payload.quotes.length < 1 || payload.quotes.length > 24 ||
    payload.quotes.some((quote) => typeof quote?.symbol !== "string" || !/^HK\.(?:\d{5}|800000|HSImain)$/.test(quote.symbol)) ||
    (payload.orderbooks !== undefined && (!Array.isArray(payload.orderbooks) || payload.orderbooks.length > 24)) ||
    (payload.history !== undefined && (
      !payload.history || typeof payload.history !== "object" ||
      Object.keys(payload.history).length > 24 ||
      Object.entries(payload.history).some(([symbol, points]) =>
        !/^HK\.(?:\d{5}|800000|HSImain)$/.test(symbol) || !Array.isArray(points) || points.length > 1500 ||
        points.some((point) => !Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
      )
    ))
  ) {
    return json({ error: "Futu payload failed validation." }, 400);
  }
  (globalThis as FutuPushStore).__FUTU_PUSH_SNAPSHOT__ = { payload, receivedAt: now };
  return json({ accepted: true, receivedAt: now }, 202);
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

async function isAuthorized(request: Request, password: string) {
  const token = cookieValue(request, AUTH_COOKIE);
  return token ? valuesMatch(token, await accessToken(password)) : false;
}

async function handleLogin(request: Request, password: string) {
  if (request.method === "GET" && await isAuthorized(request, password)) {
    return Response.redirect(new URL("/", request.url), 302);
  }

  let invalid = false;
  if (request.method === "POST") {
    const form = await request.formData();
    const submitted = String(form.get("password") ?? "");
    if (submitted.length <= 256 && await valuesMatch(submitted, password)) {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": `${AUTH_COOKIE}=${await accessToken(password)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
          "cache-control": "no-store",
        },
      });
    }
    invalid = true;
  }

  return new Response(loginPage(invalid), {
    status: invalid ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function loginPage(invalid: boolean) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Access · TradFi Basis Monitor</title>
  <style>
    :root{color-scheme:light;--ink:#17231e;--paper:#f4f6f1;--line:#dfe6e0;--acid:#dfff45;--muted:#6c7771}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 80% 0%,rgba(223,255,69,.18),transparent 32rem),var(--paper);color:var(--ink);font-family:Arial,sans-serif}
    main{width:min(430px,100%);padding:34px;background:#fbfcf8;border:1px solid var(--line);border-radius:6px 24px 6px 6px;box-shadow:0 24px 70px rgba(23,35,30,.12)}
    .mark{width:44px;height:44px;display:grid;place-items:center;margin-bottom:30px;background:var(--ink);color:var(--acid);border-radius:4px 14px 4px 4px;font:900 20px monospace}
    .eyebrow{color:#0d8d63;font:800 10px monospace;letter-spacing:.16em}h1{margin:10px 0 8px;font-size:34px;letter-spacing:-.04em}p{margin:0 0 26px;color:var(--muted);font-size:13px;line-height:1.6}
    label{display:block;margin-bottom:8px;font:800 10px monospace;letter-spacing:.08em;text-transform:uppercase}input{width:100%;height:48px;padding:0 14px;border:1px solid var(--line);border-radius:5px;background:white;color:var(--ink);font-size:16px;outline:none}input:focus{border-color:#0d8d63;box-shadow:0 0 0 3px rgba(13,141,99,.1)}
    button{width:100%;height:48px;margin-top:12px;border:0;border-radius:5px;background:var(--ink);color:white;font-weight:800;cursor:pointer}button:hover{background:#24382f}.error{margin:0 0 14px;padding:10px 12px;border:1px solid #efc7c2;border-radius:4px;background:#fff0ee;color:#a3332d;font-size:12px}
    footer{margin-top:24px;padding-top:18px;border-top:1px solid var(--line);color:#9aa49e;font:9px monospace;text-transform:uppercase;letter-spacing:.1em}
  </style>
</head>
<body>
  <main>
    <div class="mark">M</div>
    <div class="eyebrow">PROTECTED MARKET INTELLIGENCE</div>
    <h1>Enter access password</h1>
    <p>This dashboard is private. Enter the shared password to continue to live market monitoring.</p>
    ${invalid ? '<div class="error" role="alert">Incorrect password. Please try again.</div>' : ""}
    <form method="post" action="/login">
      <label for="password">Access password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Unlock dashboard</button>
    </form>
    <footer>TradFi Basis Monitor · Secure access</footer>
  </main>
</body>
</html>`;
}

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
        updatedAt: 0,
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
          updatedAt: book ? now : 0,
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
      const targetMinute = Math.floor(at / 60_000) * 60_000;
      const candle = candles.find((item) => item.t === targetMinute);
      return json({ price: candle ? Number(candle.c) : null, timestamp: candle?.t ?? null }, 200, "public, max-age=3600");
    }

    if (venue === "Binance") {
      const targetMinute = Math.floor(at / 60_000) * 60_000;
      const params = new URLSearchParams({
        symbol,
        interval: "1m",
        startTime: String(targetMinute),
        endTime: String(targetMinute + 60_000),
        limit: "2",
      });
      const response = await fetch(`https://fapi.binance.com/fapi/v1/markPriceKlines?${params}`);
      const candles = await response.json() as Array<[number, string, string, string, string]>;
      const candle = candles.find((item) => item[0] === targetMinute);
      return json({ price: candle ? Number(candle[4]) : null, timestamp: candle?.[0] ?? null }, 200, "public, max-age=3600");
    }

    return json({ error: "Unknown venue" }, 400);
  } catch (error) {
    return json({ error: "Anchor unavailable", detail: String(error) }, 502);
  }
}
