const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const MONITORED_USER = "0xa590a393CC3e1776a47f32fD99ef5fc7c464a243";
const PAGE_SIZE = 500;
const MAX_PAGES = 40;
const CACHE_MS = 30_000;
const AUTH_COOKIE = "tradfi_access";
const AUTH_MESSAGE = "tradfi-basis-monitor-access-v1";

type RawFundingRecord = {
  time?: number;
  hash?: string;
  delta?: {
    type?: string;
    coin?: string;
    usdc?: string;
    fundingRate?: string;
    nSamples?: number;
  };
};

type FundingRecord = {
  id: string;
  time: number;
  coin: string;
  usdc: number;
  cumulativeUsdc: number;
  fundingRate: number | null;
};

type FundingPayload = {
  user: string;
  updatedAt: number;
  summary: {
    netUsdc: number;
    receivedUsdc: number;
    paidUsdc: number;
    last24hUsdc: number;
    settlements: number;
    activeCoins: number;
    firstTime: number | null;
    lastTime: number | null;
  };
  chart: Array<{ t: number; deltaUsdc: number; cumulativeUsdc: number }>;
  byCoin: Array<{ coin: string; netUsdc: number; receivedUsdc: number; paidUsdc: number; settlements: number }>;
  records: FundingRecord[];
};

let cached: { expiresAt: number; payload: FundingPayload } | null = null;

const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const recordKey = (record: RawFundingRecord) => [
  record.time,
  record.hash ?? "",
  record.delta?.coin ?? "",
  record.delta?.usdc ?? "",
  record.delta?.fundingRate ?? "",
].join("|");

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

async function expectedAccessToken(password: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(AUTH_MESSAGE)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function isAuthorized(request: Request) {
  const password = process.env.SITE_PASSWORD?.trim();
  const supplied = cookieValue(request, AUTH_COOKIE);
  if (!password || !supplied || supplied.length !== 64) return false;
  const expected = await expectedAccessToken(password);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return difference === 0;
}

async function fetchPage(startTime: number) {
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "userFunding", user: MONITORED_USER, startTime }),
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid funding HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("Unexpected Hyperliquid funding response.");
  return payload as RawFundingRecord[];
}

async function fetchAllFunding() {
  const records = new Map<string, RawFundingRecord>();
  let cursor = 0;
  let previousLast = -1;

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await fetchPage(cursor);
    if (!page.length) break;
    for (const record of page) records.set(recordKey(record), record);
    const lastTime = Math.max(...page.map((record) => finite(record.time) ?? -1));
    if (lastTime < 0 || page.length < PAGE_SIZE) break;

    // Overlap one boundary once so records sharing a settlement timestamp are not skipped.
    cursor = lastTime > previousLast ? lastTime : lastTime + 1;
    previousLast = lastTime;
  }
  return [...records.values()].sort((a, b) => (finite(a.time) ?? 0) - (finite(b.time) ?? 0));
}

function buildPayload(raw: RawFundingRecord[]): FundingPayload {
  let running = 0;
  let received = 0;
  let paid = 0;
  const now = Date.now();
  const coinTotals = new Map<string, { netUsdc: number; receivedUsdc: number; paidUsdc: number; settlements: number }>();
  const chartByTime = new Map<number, number>();
  const records: FundingRecord[] = [];

  for (const item of raw) {
    const time = finite(item.time);
    const usdc = finite(item.delta?.usdc);
    const coin = item.delta?.coin?.trim();
    if (time === null || usdc === null || !coin || item.delta?.type !== "funding") continue;
    running += usdc;
    received += Math.max(0, usdc);
    paid += Math.max(0, -usdc);
    chartByTime.set(time, (chartByTime.get(time) ?? 0) + usdc);

    const total = coinTotals.get(coin) ?? { netUsdc: 0, receivedUsdc: 0, paidUsdc: 0, settlements: 0 };
    total.netUsdc += usdc;
    total.receivedUsdc += Math.max(0, usdc);
    total.paidUsdc += Math.max(0, -usdc);
    total.settlements += 1;
    coinTotals.set(coin, total);
    records.push({ id: recordKey(item), time, coin, usdc, cumulativeUsdc: running, fundingRate: finite(item.delta?.fundingRate) });
  }

  let chartRunning = 0;
  const chart = [...chartByTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, deltaUsdc]) => {
    chartRunning += deltaUsdc;
    return { t, deltaUsdc, cumulativeUsdc: chartRunning };
  });
  const byCoin = [...coinTotals.entries()].map(([coin, total]) => ({ coin, ...total }))
    .sort((a, b) => Math.abs(b.netUsdc) - Math.abs(a.netUsdc));

  return {
    user: MONITORED_USER,
    updatedAt: now,
    summary: {
      netUsdc: running,
      receivedUsdc: received,
      paidUsdc: paid,
      last24hUsdc: records.reduce((sum, record) => record.time >= now - 24 * 60 * 60_000 ? sum + record.usdc : sum, 0),
      settlements: records.length,
      activeCoins: byCoin.length,
      firstTime: records[0]?.time ?? null,
      lastTime: records.at(-1)?.time ?? null,
    },
    chart,
    byCoin,
    records,
  };
}

export async function GET(request: Request) {
  if (!await isAuthorized(request)) return Response.json({ error: "Authentication required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    if (cached && cached.expiresAt > Date.now()) return Response.json(cached.payload, { headers: { "Cache-Control": "no-store", "X-Data-Cache": "HIT" } });
    const payload = buildPayload(await fetchAllFunding());
    cached = { expiresAt: Date.now() + CACHE_MS, payload };
    return Response.json(payload, { headers: { "Cache-Control": "no-store", "X-Data-Cache": "MISS" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Hyperliquid funding history unavailable." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
