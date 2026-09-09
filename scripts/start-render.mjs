import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SYMBOLS = ["para:OTHERS", "para:TOTAL2", "para:BTCD"];
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const CAPTURE_MS = 10_000;
let dataDirectory = process.env.PARA_DATA_DIR || "/var/data/para-orderbooks";
let dataDirectoryReady = false;
const RETENTION_DAYS = Math.max(1, Math.min(90, Number(process.env.PARA_RETENTION_DAYS) || 14));
let stopped = false;
let lastCleanup = 0;

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

const executable = fileURLToPath(new URL("../node_modules/.bin/vinext", import.meta.url));
const web = spawn(executable, ["start"], {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
});

void recorderLoop();

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
