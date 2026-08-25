import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SYMBOLS = ["para:OTHERS", "para:TOTAL2", "para:BTCD"];
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const HYPERTRACKER_BASE = "https://ht-api.coinmarketman.com";
const CAPTURE_MS = 10_000;
const LIQUIDATION_CAPTURE_MS = 30_000;
let dataDirectory = process.env.PARA_DATA_DIR || "/var/data/para-orderbooks";
let dataDirectoryReady = false;
let liquidationDataDirectory = process.env.PARA_LIQUIDATION_DATA_DIR || "/var/data/para-liquidations";
let liquidationDataDirectoryReady = false;
let onchainDataDirectory = process.env.ONCHAIN_BASIS_DATA_DIR || "/var/data/onchain-basis";
let onchainDataDirectoryReady = false;
const RETENTION_DAYS = Math.max(1, Math.min(90, Number(process.env.PARA_RETENTION_DAYS) || 14));
const ONCHAIN_RETENTION_DAYS = Math.max(1, Math.min(365, Number(process.env.ONCHAIN_RETENTION_DAYS) || 90));
const ONCHAIN_CAPTURE_MS = 60_000;
const ONCHAIN_FUTU_PAIRS = [
  ["HK.00388", "TENCENTUSDT"],
  ["HK.00700", "TENCENTUSDT"],
  ["HK.01024", "KUAISHOUUSDT"],
  ["HK.01810", "HK1810USDT"],
  ["HK.02097", "TENCENTUSDT"],
  ["HK.03690", "MEITUANUSDT"],
  ["HK.09992", "POPMARTUSDT"],
];
let stopped = false;
let lastCleanup = 0;
let lastLiquidationCleanup = 0;
let lastOnchainCleanup = 0;

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

async function fetchHyper(body) {
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return response.json();
}

async function cleanupOldFiles() {
  if (Date.now() - lastCleanup < 60 * 60_000) return;
  lastCleanup = Date.now();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60_000;
  const entries = await readdir(dataDirectory, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson")).map(async (entry) => {
    const file = path.join(dataDirectory, entry.name);
    if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
  }));
}

async function ensureDataDirectory() {
  if (dataDirectoryReady) return;
  try {
    await mkdir(dataDirectory, { recursive: true });
  } catch (error) {
    if (process.env.PARA_DATA_DIR || !error || typeof error !== "object" || error.code !== "EACCES") throw error;
    dataDirectory = "/tmp/para-orderbooks";
    await mkdir(dataDirectory, { recursive: true });
    console.warn("[para-recorder] Persistent disk is not mounted; using temporary Render storage until /var/data is attached.");
  }
  dataDirectoryReady = true;
}

async function ensureLiquidationDataDirectory() {
  if (liquidationDataDirectoryReady) return;
  try {
    await mkdir(liquidationDataDirectory, { recursive: true });
  } catch (error) {
    if (process.env.PARA_LIQUIDATION_DATA_DIR || !error || typeof error !== "object" || error.code !== "EACCES") throw error;
    liquidationDataDirectory = "/tmp/para-liquidations";
    await mkdir(liquidationDataDirectory, { recursive: true });
    console.warn("[liquidation-recorder] Persistent disk is not mounted; using temporary Render storage.");
  }
  liquidationDataDirectoryReady = true;
}

async function cleanupOldLiquidationFiles() {
  if (Date.now() - lastLiquidationCleanup < 60 * 60_000) return;
  lastLiquidationCleanup = Date.now();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60_000;
  const entries = await readdir(liquidationDataDirectory, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson")).map(async (entry) => {
    const file = path.join(liquidationDataDirectory, entry.name);
    if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
  }));
}

async function ensureOnchainDataDirectory() {
  if (onchainDataDirectoryReady) return;
  try {
    await mkdir(onchainDataDirectory, { recursive: true });
  } catch (error) {
    if (process.env.ONCHAIN_BASIS_DATA_DIR || !error || typeof error !== "object" || error.code !== "EACCES") throw error;
    onchainDataDirectory = "/tmp/onchain-basis";
    await mkdir(onchainDataDirectory, { recursive: true });
    console.warn("[onchain-recorder] Persistent disk is not mounted; using temporary Render storage.");
  }
  onchainDataDirectoryReady = true;
}

async function cleanupOldOnchainFiles() {
  if (Date.now() - lastOnchainCleanup < 60 * 60_000) return;
  lastOnchainCleanup = Date.now();
  const cutoff = Date.now() - ONCHAIN_RETENTION_DAYS * 24 * 60 * 60_000;
  const entries = await readdir(onchainDataDirectory, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson")).map(async (entry) => {
    const file = path.join(onchainDataDirectory, entry.name);
    if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
  }));
}

const hktSession = (timestamp = Date.now()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp).map((part) => [part.type, part.value]));
  const weekday = parts.weekday;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return weekday !== "Sat" && weekday !== "Sun" && minute >= 10 * 60 && minute <= 15 * 60;
};

async function localJson(pathname) {
  const port = Number(process.env.PORT) || 3000;
  const origin = `http://127.0.0.1:${port}`;
  const request = (cookie = "") => fetch(`${origin}${pathname}`, {
    cache: "no-store",
    headers: cookie ? { Cookie: cookie } : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let response = await request();
  if (response.status === 401 && process.env.SITE_PASSWORD) {
    const login = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: process.env.SITE_PASSWORD }),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    if (!cookie) throw new Error("Recorder login did not return an access cookie.");
    response = await request(cookie);
  }
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}`);
  return response.json();
}

async function captureOnchainBasis() {
  await localJson("/api/onchain-pools/history?capture=1");
}

async function onchainRecorderLoop() {
  while (!stopped) {
    const started = Date.now();
    if (hktSession(started)) {
      try {
        await captureOnchainBasis();
      } catch (error) {
        console.warn(`[onchain-recorder] ${error instanceof Error ? error.message : "capture failed"}`);
      }
    }
    const delay = Math.max(1_000, ONCHAIN_CAPTURE_MS - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function capture() {
  const [contexts, books] = await Promise.all([
    fetchHyper({ type: "metaAndAssetCtxs", dex: "para" }),
    Promise.all(SYMBOLS.map((coin) => fetchHyper({ type: "l2Book", coin }))),
  ]);
  const [meta, assetContexts] = contexts;
  const contextBySymbol = new Map(meta.universe.map((asset, index) => [asset.name, assetContexts[index]]));
  const records = books.flatMap((book, index) => {
    const apiSymbol = SYMBOLS[index];
    const context = contextBySymbol.get(apiSymbol) || {};
    const levels = [
      ...(book.levels?.[0] || []).flatMap((level) => {
        const price = positive(level.px);
        const size = positive(level.sz);
        return price && size ? [[price, size, 0]] : [];
      }),
      ...(book.levels?.[1] || []).flatMap((level) => {
        const price = positive(level.px);
        const size = positive(level.sz);
        return price && size ? [[price, size, 1]] : [];
      }),
    ];
    if (!levels.length) return [];
    const timestamp = Number(book.time) || Date.now();
    return [{
      id: `${apiSymbol}:${Math.floor(timestamp / CAPTURE_MS)}`,
      apiSymbol,
      symbol: apiSymbol === "para:BTCD" ? "para:BTC.D" : apiSymbol,
      t: timestamp,
      oracle: positive(context.oraclePx),
      mark: positive(context.markPx),
      levels,
    }];
  });
  if (!records.length) return;
  await ensureDataDirectory();
  const date = new Date(records[0].t).toISOString().slice(0, 10);
  await appendFile(path.join(dataDirectory, `${date}.ndjson`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await cleanupOldFiles();
}

async function recorderLoop() {
  while (!stopped) {
    const started = Date.now();
    try {
      await capture();
    } catch (error) {
      console.warn(`[para-recorder] ${error instanceof Error ? error.message : "capture failed"}`);
    }
    const delay = Math.max(250, CAPTURE_MS - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function fetchLiquidationMap(symbol, token) {
  const response = await fetch(`${HYPERTRACKER_BASE}/api/external/exports/coins/${encodeURIComponent(symbol)}/liquidation-heatmap`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HyperTracker ${symbol} HTTP ${response.status}`);
  return response.json();
}

async function captureLiquidations(token) {
  const [contexts, maps] = await Promise.all([
    fetchHyper({ type: "metaAndAssetCtxs", dex: "para" }),
    Promise.all(SYMBOLS.map((symbol) => fetchLiquidationMap(symbol, token))),
  ]);
  const [meta, assetContexts] = contexts;
  const contextBySymbol = new Map(meta.universe.map((asset, index) => [asset.name, assetContexts[index]]));
  const timestamp = Date.now();
  const records = maps.flatMap((payload, index) => {
    const apiSymbol = SYMBOLS[index];
    const context = contextBySymbol.get(apiSymbol) || {};
    const oracle = positive(context.oraclePx);
    const mark = positive(context.markPx);
    const reference = oracle || mark;
    if (!reference) return [];
    const levels = (payload.heatmap || []).flatMap((bin) => {
      const start = positive(bin.priceBinStart);
      const end = positive(bin.priceBinEnd);
      const usd = positive(bin.liquidationValue);
      if (!start || !end || !usd || end <= start) return [];
      return [[start, end, usd, Math.max(0, Number(bin.positionsCount) || 0), (start + end) / 2 < reference ? 0 : 1]];
    });
    if (!levels.length) return [];
    return [{
      id: `${apiSymbol}:${Math.floor(timestamp / LIQUIDATION_CAPTURE_MS)}`,
      apiSymbol,
      symbol: apiSymbol === "para:BTCD" ? "para:BTC.D" : apiSymbol,
      t: timestamp,
      oracle,
      mark,
      source: "HyperTracker",
      levels,
    }];
  });
  if (!records.length) return;
  await ensureLiquidationDataDirectory();
  const date = new Date(timestamp).toISOString().slice(0, 10);
  await appendFile(path.join(liquidationDataDirectory, `${date}.ndjson`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await cleanupOldLiquidationFiles();
}

async function liquidationRecorderLoop(token) {
  while (!stopped) {
    const started = Date.now();
    try {
      await captureLiquidations(token);
    } catch (error) {
      console.warn(`[liquidation-recorder] ${error instanceof Error ? error.message : "capture failed"}`);
    }
    const delay = Math.max(500, LIQUIDATION_CAPTURE_MS - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

const executable = fileURLToPath(new URL("../node_modules/.bin/vinext", import.meta.url));
const web = spawn(executable, ["start"], {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
});

void recorderLoop();
void onchainRecorderLoop();
if (process.env.HYPERTRACKER_API_KEY) void liquidationRecorderLoop(process.env.HYPERTRACKER_API_KEY);

const shutdown = (signal) => {
  stopped = true;
  if (!web.killed) web.kill(signal);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
web.on("exit", (code, signal) => {
  stopped = true;
  process.exitCode = code ?? (signal ? 1 : 0);
});
