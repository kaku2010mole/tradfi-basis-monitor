#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const RELAY_URL = process.env.POSLEY_RELAY_URL || "ws://192.168.50.112:8787/ws";
const PUSH_URL = process.env.FUTU_PUSH_URL || "https://tradfi-basis-monitor.onrender.com/api/hk-auction/ingest";
const TOKEN_FILE = process.env.FUTU_PUSH_TOKEN_FILE;
const SYMBOLS = ["TCEHY", "XIACY", "KSHTY", "MPNGY", "PMRTY", "MMXGY", "LNVGY", "BYDDY"];
const KEYS = SYMBOLS.map((symbol) => `orderbook:ibkr:STK:${symbol}:SMART:USD`);
const KOREAN_CODES = ["034020", "035420", "042700", "066570", "454910"];
const KOREAN_KEYS = KOREAN_CODES.map((code) => `orderbook:ibkr:STK:${code}:KRX:KRW`);
const JAPANESE_CODES = ["285A", "5802", "6758", "6857", "6920", "7203", "8035", "8306", "9984"];
const JAPANESE_KEYS = JAPANESE_CODES.map((code) => `orderbook:ibkr:STK:${code}:TSEJ:JPY`);
const FX_KEY = "orderbook:ibkr:FX:USD:KRW";
const FX_JPY_KEY = "orderbook:ibkr:FX:USD:JPY";
const FX_HL_KEY = "index_price:hyperliquid:xyz:KRW";
KEYS.push(FX_KEY, FX_JPY_KEY, FX_HL_KEY, ...KOREAN_KEYS, ...JAPANESE_KEYS);
const allowedKeys = new Map([
  ...SYMBOLS.map((symbol) => [`orderbook:ibkr:STK:${symbol}:SMART:USD`, `US.${symbol}`]),
  [FX_KEY, "FX.USDKRW"], [FX_JPY_KEY, "FX.USDJPY"], [FX_HL_KEY, "FX.USDKRW"],
  ...KOREAN_CODES.map((code) => [`orderbook:ibkr:STK:${code}:KRX:KRW`, `KRX.${code}`]),
  ...JAPANESE_CODES.map((code) => [`orderbook:ibkr:STK:${code}:TSEJ:JPY`, `TSE.${code}`]),
]);
const latest = new Map();
const fxHistory = new Map();

if (!TOKEN_FILE) throw new Error("FUTU_PUSH_TOKEN_FILE is required.");
const token = (await readFile(TOKEN_FILE, "utf8")).trim();
if (token.length < 32) throw new Error("Push token is invalid.");

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const timestamp = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 10_000_000_000 ? number * 1_000 : number;
};

const firstLevel = (value) => {
  const raw = Array.isArray(value) ? value[0] : typeof value === "string" ? value.split("|")[0] : null;
  if (!raw) return { price: null, size: null };
  if (Array.isArray(raw)) return { price: positive(raw[0]), size: positive(raw[1]) };
  if (typeof raw === "object") return { price: positive(raw.price ?? raw[0]), size: positive(raw.size ?? raw.qty ?? raw[1]) };
  const parts = String(raw).split(/[:,@]/).map((part) => part.trim());
  return { price: positive(parts[0]), size: positive(parts[1]) };
};

const quoteFromEntry = (message) => {
  const symbol = allowedKeys.get(message.key);
  const fields = message.fields;
  if (!symbol || !fields || typeof fields !== "object") return null;
  const bid = firstLevel(fields.bids ?? fields.bid);
  const ask = firstLevel(fields.asks ?? fields.ask);
  let details = fields.specific_data;
  if (typeof details === "string") {
    try { details = JSON.parse(details); } catch { details = null; }
  }
  const stale = details?.stale === true || details?.stale === "true";
  // A stale heartbeat is not a new book, but its original last trade remains
  // useful after a relay/Render restart. Preserve only last and its old market
  // timestamp; never turn a repeated heartbeat into a live bid/ask.
  const candidates = [
    fields.last_tick_ts_ms,
    fields.bids_receive_ts_ms,
    fields.asks_receive_ts_ms,
    fields.local_receive_ts_ms,
    fields.timestamp,
    fields.ts,
    fields.updated_at,
    fields.marketTimestamp,
  ]
    .map(timestamp).filter((value) => value !== null);
  const bookTimes = [fields.bids_receive_ts_ms, fields.asks_receive_ts_ms]
    .map(timestamp).filter((value) => value !== null);
  const staleMarketTimes = [fields.last_tick_ts_ms, fields.bids_receive_ts_ms, fields.asks_receive_ts_ms, fields.local_receive_ts_ms]
    .map(timestamp).filter((value) => value !== null);
  const last = positive(fields.index_price ?? fields.mark_price ?? fields.last_price ?? fields.last ?? fields.price);
  if (stale && (last === null || !staleMarketTimes.length)) return null;
  if (!stale && bid.price === null && ask.price === null && last === null) return null;
  const isFx = symbol.startsWith("FX.");
  return {
    symbol,
    name: symbol,
    marketState: isFx ? "FX_REFERENCE" : symbol.startsWith("KRX.") ? "KRX_REFERENCE" : symbol.startsWith("TSE.") ? "TSE_REFERENCE" : "US_REFERENCE",
    auctionPrice: null,
    last,
    previousClose: positive(fields.previous_close ?? fields.prev_close),
    bid: !stale && bid.size !== null ? bid.price : null,
    ask: !stale && ask.size !== null ? ask.price : null,
    bidSize: stale ? null : bid.size,
    askSize: stale ? null : ask.size,
    // An opening-auction book can update before the first print. Timestamp
    // a complete BBO from its receive time, not the prior session's last tick.
    marketTimestamp: stale ? Math.max(...staleMarketTimes)
      : bid.size !== null && ask.size !== null && bookTimes.length ? Math.max(...bookTimes)
        : candidates.length ? Math.max(...candidates) : Date.now(),
    source: message.key === FX_HL_KEY ? "Posley Hyperliquid KRW index" : isFx ? "Posley IBKR FX" : "Posley office relay",
  };
};

let socket;
let reconnectMs = 1_000;
let pingTimer;
let pushing = false;
let lastRelayMessageAt = Date.now();

// The outer LaunchAgent loop restarts this process if a network change leaves
// the WebSocket stuck without a close event.
setInterval(() => {
  if (Date.now() - lastRelayMessageAt > 90_000) {
    console.error("Posley ADR relay silent for 90s; restarting the pusher.");
    process.exit(1);
  }
}, 15_000);

const connect = () => {
  socket = new WebSocket(RELAY_URL);
  socket.addEventListener("open", () => {
    lastRelayMessageAt = Date.now();
    reconnectMs = 1_000;
    socket.send(JSON.stringify({ action: "subscribe", keys: KEYS, snapshot: 1 }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('{"action":"ping"}');
    }, 20_000);
    console.log(`Posley ADR relay connected; subscribed to ${KEYS.length} streams.`);
  });
  socket.addEventListener("message", (event) => {
    lastRelayMessageAt = Date.now();
    try {
      const message = JSON.parse(String(event.data));
      if (message.type !== "entry") return;
      const quote = quoteFromEntry(message);
      if (quote) {
        const existing = latest.get(quote.symbol);
        if (message.key !== FX_HL_KEY || !existing?.bid || !existing?.ask) latest.set(quote.symbol, quote);
        if (quote.symbol === "FX.USDKRW") {
          const price = quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : quote.last;
          if (price && quote.marketTimestamp) {
            fxHistory.set(Math.floor(quote.marketTimestamp / 60_000) * 60_000, price);
            const cutoff = Date.now() - 8 * 24 * 60 * 60_000;
            for (const timestamp of fxHistory.keys()) if (timestamp < cutoff) fxHistory.delete(timestamp);
          }
        }
      }
    } catch (error) {
      console.error(`Posley ADR message ignored: ${error instanceof Error ? error.message : error}`);
    }
  });
  socket.addEventListener("close", () => {
    clearInterval(pingTimer);
    const wait = reconnectMs;
    reconnectMs = Math.min(reconnectMs * 2, 30_000);
    console.error(`Posley ADR relay disconnected; retrying in ${wait}ms.`);
    setTimeout(connect, wait);
  });
  socket.addEventListener("error", (event) => {
    // The close event owns reconnects. Calling close() from Node's error event
    // can recursively dispatch another error and overflow the call stack.
    console.error(`Posley ADR socket error: ${event?.message ?? "connection failed"}`);
  });
};

setInterval(async () => {
  if (pushing || latest.size === 0) return;
  pushing = true;
  try {
    const response = await fetch(PUSH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "posley-adr-pusher/1" },
      body: JSON.stringify({
        generatedAt: Date.now(),
        quotes: [...latest.values()],
        history: fxHistory.size ? { "FX.USDKRW": [...fxHistory].sort((left, right) => left[0] - right[0]).slice(-2500) } : undefined,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status !== 202) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  } catch (error) {
    console.error(`Posley ADR push unavailable: ${error instanceof Error ? error.message : error}`);
  } finally {
    pushing = false;
  }
}, 1_000);

connect();
