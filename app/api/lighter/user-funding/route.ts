import { appendFile, mkdir, readFile } from "node:fs/promises";

const LIGHTER_API = "https://mainnet.zklighter.elliot.ai";
const MONITORED_USER = "0x821dbB4ed1A7D9Bf25a12E156F4EC10D9Af1f95C";
const ACCOUNT_INDEX = 719300;
const CACHE_MS = 60_000;
const SNAPSHOT_HEARTBEAT_MS = 6 * 60 * 60_000;
const AUTH_COOKIE = "tradfi_access";
const AUTH_MESSAGE = "tradfi-basis-monitor-access-v1";

type RawPosition = {
  market_id?: number;
  symbol?: string;
  sign?: number;
  position?: string;
  position_value?: string;
  total_funding_paid_out?: string;
};

type Snapshot = { t: number; total: number; byCoin: Record<string, number> };

type LighterPayload = {
  venue: "lighter";
  user: string;
  accountIndex: number;
  updatedAt: number;
  trackingSince: number;
  summary: { netUsdc: number; receivedUsdc: number; paidUsdc: number; settlements: number; firstTime: number | null; lastTime: number | null };
  chart: Array<{ t: number; deltaUsdc: number; cumulativeUsdc: number }>;
  records: Array<{ id: string; time: number; coin: string; usdc: number; cumulativeUsdc: number; fundingRate: number | null }>;
  positions: Array<{ coin: string; size: number; notionalUsdc: number; fundingRate: number | null; estimatedUsdc: number | null }>;
  nextHourUsdc: number | null;
  historyMode: "tracked-public";
};

type Runtime = typeof globalThis & {
  __LIGHTER_FUNDING_CACHE__?: { expiresAt: number; promise: Promise<LighterPayload> };
  __LIGHTER_FUNDING_HISTORY__?: Snapshot[];
  __LIGHTER_FUNDING_FILE__?: string;
};

const runtime = globalThis as Runtime;

const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

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

async function lighterJson(path: string) {
  const response = await fetch(`${LIGHTER_API}${path}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Lighter HTTP ${response.status}`);
  const payload = await response.json() as { code?: number; message?: string };
  if (payload.code !== undefined && payload.code !== 200) throw new Error(payload.message || `Lighter code ${payload.code}`);
  return payload;
}

async function historyFile() {
  if (runtime.__LIGHTER_FUNDING_FILE__) return runtime.__LIGHTER_FUNDING_FILE__;
  const preferred = process.env.LIGHTER_FUNDING_HISTORY_FILE?.trim() || "/var/data/lighter-funding-history.ndjson";
  try {
    await mkdir(preferred.slice(0, preferred.lastIndexOf("/")), { recursive: true });
    runtime.__LIGHTER_FUNDING_FILE__ = preferred;
  } catch {
    const fallback = "/tmp/lighter-funding-history.ndjson";
    await mkdir("/tmp", { recursive: true });
    runtime.__LIGHTER_FUNDING_FILE__ = fallback;
  }
  return runtime.__LIGHTER_FUNDING_FILE__;
}

async function loadHistory() {
  if (runtime.__LIGHTER_FUNDING_HISTORY__) return runtime.__LIGHTER_FUNDING_HISTORY__;
  const file = await historyFile();
  try {
    const source = await readFile(file, "utf8");
    runtime.__LIGHTER_FUNDING_HISTORY__ = source.split("\n").flatMap((line) => {
      try {
        const item = JSON.parse(line) as Snapshot;
        return finite(item.t) !== null && finite(item.total) !== null && item.byCoin ? [item] : [];
      } catch { return []; }
    }).slice(-20_000);
  } catch {
    runtime.__LIGHTER_FUNDING_HISTORY__ = [];
  }
  return runtime.__LIGHTER_FUNDING_HISTORY__;
}

async function recordSnapshot(snapshot: Snapshot) {
  const history = await loadHistory();
  const previous = history.at(-1);
  if (previous && Math.abs(previous.total - snapshot.total) < 1e-9 && snapshot.t - previous.t < SNAPSHOT_HEARTBEAT_MS) return history;
  history.push(snapshot);
  if (history.length > 20_000) history.splice(0, history.length - 20_000);
  try { await appendFile(await historyFile(), `${JSON.stringify(snapshot)}\n`, "utf8"); } catch { /* In-memory history remains available when disk is read-only. */ }
  return history;
}

function buildRecords(history: Snapshot[]) {
  let running = 0;
  return history.slice(1).flatMap((snapshot, index) => {
    const previous = history[index];
    const coins = new Set([...Object.keys(previous.byCoin), ...Object.keys(snapshot.byCoin)]);
    return [...coins].flatMap((coin) => {
      const delta = (snapshot.byCoin[coin] ?? 0) - (previous.byCoin[coin] ?? 0);
      if (Math.abs(delta) < 1e-9) return [];
      running += delta;
      return [{ id: `${snapshot.t}:${coin}`, time: snapshot.t, coin, usdc: delta, cumulativeUsdc: running, fundingRate: null }];
    });
  });
}

async function buildPayload(): Promise<LighterPayload> {
  const [accountPayload, ratesPayload] = await Promise.all([
    lighterJson(`/api/v1/account?by=l1_address&value=${MONITORED_USER}`),
    lighterJson("/api/v1/funding-rates"),
  ]) as [{ accounts?: Array<{ index?: number; positions?: RawPosition[] }> }, { funding_rates?: Array<{ market_id?: number; exchange?: string; rate?: number }> }];
  const account = accountPayload.accounts?.find((item) => item.index === ACCOUNT_INDEX) ?? accountPayload.accounts?.[0];
  if (!account) throw new Error("Lighter account was not found.");
  const positions = account.positions ?? [];
  const byCoin: Record<string, number> = {};
  for (const position of positions) {
    const coin = position.symbol?.trim();
    const total = finite(position.total_funding_paid_out);
    if (coin && total !== null) byCoin[coin] = (byCoin[coin] ?? 0) + total;
  }
  const now = Date.now();
  const total = Object.values(byCoin).reduce((sum, value) => sum + value, 0);
  const history = await recordSnapshot({ t: now, total, byCoin });
  const records = buildRecords(history);
  const rateByMarket = new Map((ratesPayload.funding_rates ?? []).flatMap((item) => item.exchange === "lighter" && finite(item.market_id) !== null && finite(item.rate) !== null ? [[item.market_id!, item.rate! / 8] as const] : []));
  const livePositions = positions.flatMap((position) => {
    const size = finite(position.position);
    const sign = finite(position.sign);
    const notional = Math.abs(finite(position.position_value) ?? 0);
    const coin = position.symbol?.trim();
    if (!coin || size === null || sign === null || Math.abs(size) < 1e-12 || notional <= 0) return [];
    const signedSize = Math.abs(size) * Math.sign(sign || 1);
    const fundingRate = rateByMarket.get(position.market_id ?? -1) ?? null;
    const estimatedUsdc = fundingRate === null ? null : -Math.sign(signedSize) * notional * fundingRate;
    return [{ coin, size: signedSize, notionalUsdc: notional, fundingRate, estimatedUsdc }];
  }).sort((a, b) => Math.abs(b.estimatedUsdc ?? 0) - Math.abs(a.estimatedUsdc ?? 0));
  const nextHourReady = livePositions.filter((position) => position.estimatedUsdc !== null);
  const nextHourUsdc = nextHourReady.length ? nextHourReady.reduce((sum, position) => sum + position.estimatedUsdc!, 0) : null;
  const received = records.reduce((sum, record) => sum + Math.max(0, record.usdc), 0);
  const paid = records.reduce((sum, record) => sum + Math.max(0, -record.usdc), 0);
  const chart = [{ t: history[0]?.t ?? now, deltaUsdc: 0, cumulativeUsdc: 0 }, ...records.map((record) => ({ t: record.time, deltaUsdc: record.usdc, cumulativeUsdc: record.cumulativeUsdc }))];
  return {
    venue: "lighter", user: MONITORED_USER, accountIndex: account.index ?? ACCOUNT_INDEX, updatedAt: now, trackingSince: history[0]?.t ?? now,
    summary: { netUsdc: total, receivedUsdc: received, paidUsdc: paid, settlements: records.length, firstTime: records[0]?.time ?? null, lastTime: records.at(-1)?.time ?? null },
    chart, records, positions: livePositions, nextHourUsdc, historyMode: "tracked-public",
  };
}

export async function GET(request: Request) {
  if (!await isAuthorized(request)) return Response.json({ error: "Authentication required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const now = Date.now();
    if (!runtime.__LIGHTER_FUNDING_CACHE__ || runtime.__LIGHTER_FUNDING_CACHE__.expiresAt <= now) {
      runtime.__LIGHTER_FUNDING_CACHE__ = { expiresAt: now + CACHE_MS, promise: buildPayload() };
    }
    return Response.json(await runtime.__LIGHTER_FUNDING_CACHE__.promise, { headers: { "Cache-Control": "no-store", "X-Data-Cache": "60s" } });
  } catch (error) {
    runtime.__LIGHTER_FUNDING_CACHE__ = undefined;
    return Response.json({ error: error instanceof Error ? error.message : "Lighter funding data unavailable." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
