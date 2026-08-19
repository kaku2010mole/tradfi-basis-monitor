"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount } from "viem/accounts";
import type { SelectedTakerDirection, TakerQuote } from "./types";
import styles from "./page.module.css";

type Side = "BUY" | "SELL";
type PositionMode = "oneway" | "hedge";
type ExchangeFilter = { filterType?: string; minQty?: string; maxQty?: string; stepSize?: string; notional?: string; minNotional?: string };
type ExchangeSymbol = { symbol?: string; status?: string; marginAsset?: string; orderTypes?: string[]; filters?: ExchangeFilter[] };
type BinanceBook = { bidPrice?: string; askPrice?: string };
type BinanceOrder = { orderId?: number; avgPrice?: string; executedQty?: string; cumQuote?: string; msg?: string };
type HyperMeta = { universe?: Array<{ name?: string; szDecimals?: number }> };
type PerpDex = { name?: string } | null;
type HyperFill = { totalSz: string; avgPx: string; oid: number };
type SliceReport = {
  id: number;
  time: number;
  tone: "success" | "partial" | "error";
  message: string;
  direction: SelectedTakerDirection["direction"];
  spread: number;
  requested: number;
  hyper?: { side: Side; price: number; size: number; notional: number; orderId: number };
  binance?: { side: Side; price: number; size: number; notional: number; orderId: number | null };
};

const BINANCE_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"];
const BINANCE_TRADE_API = "https://fapi.binance.com";
const positive = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; };
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const px = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 8 });
const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const clock = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

async function publicBinance<T>(path: string) {
  let lastError: unknown;
  for (const host of BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("Binance market data unavailable.");
}

async function hyperInfo<T>(payload: Record<string, unknown>) {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid info HTTP ${response.status}`);
  return await response.json() as T;
}

async function resolveHyperAsset(coin: string) {
  const normalized = coin.trim();
  const separator = normalized.indexOf(":");
  const dex = separator > 0 ? normalized.slice(0, separator) : "";
  const meta = await hyperInfo<HyperMeta>(dex ? { type: "meta", dex } : { type: "meta" });
  const universe = meta.universe ?? [];
  const tail = separator > 0 ? normalized.slice(separator + 1) : normalized;
  const index = universe.findIndex((asset) => asset.name === normalized || asset.name === tail);
  if (index < 0) throw new Error(`${normalized} is not present in Hyperliquid perp metadata.`);
  const szDecimals = Number(universe[index]?.szDecimals);
  if (!Number.isInteger(szDecimals) || szDecimals < 0) throw new Error(`${normalized} has invalid Hyperliquid size precision.`);
  if (!dex) return { assetId: index, szDecimals };
  const dexes = await hyperInfo<PerpDex[]>({ type: "perpDexs" });
  const dexIndex = dexes.findIndex((entry) => entry?.name === dex);
  if (dexIndex < 0) throw new Error(`Hyperliquid perp dex ${dex} was not found.`);
  return { assetId: 100_000 + dexIndex * 10_000 + index, szDecimals };
}

const hmacHex = async (secret: string, message: string) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const decimalPlaces = (step: string) => {
  const normalized = step.toLowerCase();
  if (normalized.includes("e-")) return Number(normalized.split("e-")[1]);
  return normalized.split(".")[1]?.replace(/0+$/, "").length ?? 0;
};

function binanceQuantity(instrument: ExchangeSymbol, targetNotional: number, referencePrice: number) {
  const filters = instrument.filters ?? [];
  const lot = filters.find((filter) => filter.filterType === "MARKET_LOT_SIZE") ?? filters.find((filter) => filter.filterType === "LOT_SIZE");
  const stepText = lot?.stepSize ?? "";
  const step = positive(stepText);
  const minQty = positive(lot?.minQty) ?? 0;
  const maxQty = positive(lot?.maxQty) ?? Number.POSITIVE_INFINITY;
  const notionalFilter = filters.find((filter) => filter.filterType === "MIN_NOTIONAL" || filter.filterType === "NOTIONAL");
  const minNotional = positive(notionalFilter?.notional ?? notionalFilter?.minNotional) ?? 0;
  if (!step) throw new Error(`${instrument.symbol} has no usable market-order step size.`);
  const stepped = Math.round((targetNotional / referencePrice) / step) * step;
  if (stepped <= 0 || stepped < minQty) throw new Error(`${instrument.symbol} slice is below its minimum market quantity.`);
  if (stepped > maxQty) throw new Error(`${instrument.symbol} slice exceeds its maximum market quantity.`);
  if (stepped * referencePrice < minNotional) throw new Error(`${instrument.symbol} slice is below its ${money(minNotional)} minimum notional.`);
  return stepped.toFixed(decimalPlaces(stepText));
}

async function placeBinanceMarket(input: { apiKey: string; secret: string; symbol: string; side: Side; quantity: string; positionMode: PositionMode; serverOffset: number }) {
  const timestamp = Math.round(Date.now() + input.serverOffset);
  const params = new URLSearchParams({
    symbol: input.symbol, side: input.side, type: "MARKET", quantity: input.quantity,
    positionSide: input.positionMode === "hedge" ? input.side === "BUY" ? "LONG" : "SHORT" : "BOTH",
    newOrderRespType: "RESULT", newClientOrderId: `tt_${timestamp.toString(36)}`,
    recvWindow: "5000", timestamp: String(timestamp),
  });
  const query = params.toString();
  const signature = await hmacHex(input.secret, query);
  let response: Response;
  try {
    response = await fetch(`${BINANCE_TRADE_API}/fapi/v1/order?${query}&signature=${signature}`, {
      method: "POST", credentials: "omit", headers: { "X-MBX-APIKEY": input.apiKey },
    });
  } catch {
    throw new Error(`Network interrupted after submitting ${input.symbol}; verify Binance order history before taking any action.`);
  }
  const text = await response.text();
  const order = text ? JSON.parse(text) as BinanceOrder : {};
  if (!response.ok) throw new Error(order.msg || `Binance rejected ${input.symbol} (HTTP ${response.status}).`);
  return order;
}

export default function LiveDcaPanel({ quote, quoteFresh, selected, hyperCoin, binanceSymbol, total, slice, interval, trigger, slippageBps }: {
  quote: TakerQuote | null;
  quoteFresh: boolean;
  selected: SelectedTakerDirection;
  hyperCoin: string;
  binanceSymbol: string;
  total: number;
  slice: number;
  interval: number;
  trigger: number;
  slippageBps: number;
}) {
  const [hyperPrivateKey, setHyperPrivateKey] = useState("");
  const [vaultAddress, setVaultAddress] = useState("");
  const [binanceApiKey, setBinanceApiKey] = useState("");
  const [binanceSecret, setBinanceSecret] = useState("");
  const [positionMode, setPositionMode] = useState<PositionMode>("oneway");
  const [acknowledged, setAcknowledged] = useState(false);
  const [running, setRunning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [filledNotional, setFilledNotional] = useState(0);
  const [reports, setReports] = useState<SliceReport[]>([]);
  const lastSliceRef = useRef(0);
  const executionRef = useRef(false);

  const remaining = Math.max(0, total - filledNotional);
  const progress = total > 0 ? Math.min(100, filledNotional / total * 100) : 0;
  const canArm = Boolean(quoteFresh && quote && selected.spread !== null && total > 0 && slice > 0 && slippageBps >= 0 && /^0x[0-9a-fA-F]{64}$/.test(hyperPrivateKey.trim()) && (!vaultAddress.trim() || /^0x[0-9a-fA-F]{40}$/.test(vaultAddress.trim())) && binanceApiKey.trim() && binanceSecret && acknowledged);
  const addReport = useCallback((report: SliceReport) => setReports((current) => [report, ...current].slice(0, 80)), []);

  const executeSlice = useCallback(async (requested: number) => {
    if (!quote || selected.spread === null || executionRef.current) return;
    executionRef.current = true;
    setExecuting(true);
    const startedAt = Date.now();
    const direction = selected.direction;
    const hyperBuy = direction === "longHyper";
    const binanceSide: Side = hyperBuy ? "SELL" : "BUY";
    let hyper: SliceReport["hyper"];
    try {
      const [{ assetId, szDecimals }, exchangeInfo, binanceBook, serverTime] = await Promise.all([
        resolveHyperAsset(hyperCoin),
        publicBinance<{ symbols?: ExchangeSymbol[] }>("/fapi/v1/exchangeInfo"),
        publicBinance<BinanceBook>(`/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(binanceSymbol)}`),
        publicBinance<{ serverTime?: number }>("/fapi/v1/time"),
      ]);
      const instrument = (exchangeInfo.symbols ?? []).find((item) => item.symbol === binanceSymbol);
      if (!instrument || instrument.status !== "TRADING" || instrument.marginAsset !== "USDT" || !instrument.orderTypes?.includes("MARKET")) throw new Error(`${binanceSymbol} is not available for Binance USDⓈ-M market orders.`);
      const hyperReference = hyperBuy ? quote.hyperliquid.ask : quote.hyperliquid.bid;
      const orderSize = formatSize(requested / hyperReference, szDecimals);
      if (!positive(orderSize)) throw new Error(`${hyperCoin} slice is below Hyperliquid's minimum size precision.`);
      const paddedPrice = hyperReference * (hyperBuy ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000);
      const orderPrice = formatPrice(paddedPrice, szDecimals, "perp");
      const wallet = privateKeyToAccount(hyperPrivateKey.trim() as `0x${string}`);
      const client = new ExchangeClient({
        transport: new HttpTransport({ timeout: 8_000 }), wallet,
        ...(vaultAddress.trim() ? { defaultVaultAddress: vaultAddress.trim() as `0x${string}` } : {}),
        defaultExpiresAfter: () => Date.now() + 5_000,
      });
      const result = await client.order({ orders: [{ a: assetId, b: hyperBuy, p: orderPrice, s: orderSize, r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
      const status = result.response.data.statuses[0];
      if (!status || typeof status === "string") throw new Error(`Hyperliquid returned ${status || "no order status"}.`);
      if ("error" in status) throw new Error(`Hyperliquid rejected the IOC: ${status.error}`);
      if (!("filled" in status)) throw new Error("Hyperliquid IOC did not fill; no Binance hedge was submitted.");
      const fill = status.filled as HyperFill;
      const hyperSize = positive(fill.totalSz);
      const hyperPrice = positive(fill.avgPx);
      if (!hyperSize || !hyperPrice) throw new Error("Hyperliquid returned an invalid fill response.");
      hyper = { side: hyperBuy ? "BUY" : "SELL", price: hyperPrice, size: hyperSize, notional: hyperSize * hyperPrice, orderId: fill.oid };

      const binanceReference = binanceSide === "BUY" ? positive(binanceBook.askPrice) : positive(binanceBook.bidPrice);
      if (!binanceReference) throw new Error(`${binanceSymbol} BBO disappeared after Hyperliquid filled.`);
      const quantity = binanceQuantity(instrument, hyper.notional, binanceReference);
      const offset = Number(serverTime.serverTime) - Date.now();
      const order = await placeBinanceMarket({ apiKey: binanceApiKey.trim(), secret: binanceSecret, symbol: binanceSymbol, side: binanceSide, quantity, positionMode, serverOffset: Number.isFinite(offset) ? offset : 0 });
      const binanceSize = positive(order.executedQty);
      const binancePrice = positive(order.avgPrice);
      if (!binanceSize || !binancePrice) throw new Error(`${binanceSymbol} returned no completed fill price.`);
      const binanceNotional = positive(order.cumQuote) ?? binanceSize * binancePrice;
      const binance = { side: binanceSide, price: binancePrice, size: binanceSize, notional: binanceNotional, orderId: Number.isFinite(Number(order.orderId)) ? Number(order.orderId) : null };
      addReport({ id: startedAt, time: Date.now(), tone: "success", message: "Both mainnet legs filled.", direction, spread: selected.spread, requested, hyper, binance });
      setFilledNotional((current) => {
        const next = Math.min(total, current + hyper.notional);
        if (next >= total) setRunning(false);
        return next;
      });
      lastSliceRef.current = Date.now();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Live slice failed.";
      addReport({ id: startedAt, time: Date.now(), tone: hyper ? "partial" : "error", message: hyper ? `UNHEDGED HYPERLIQUID FILL — Binance hedge failed: ${detail}` : detail, direction, spread: selected.spread, requested, hyper });
      setRunning(false);
    } finally {
      executionRef.current = false;
      setExecuting(false);
    }
  }, [addReport, binanceApiKey, binanceSecret, binanceSymbol, hyperCoin, hyperPrivateKey, positionMode, quote, selected.direction, selected.spread, slippageBps, total, vaultAddress]);

  useEffect(() => {
    if (!running || executing || !quoteFresh || selected.spread === null || selected.spread < trigger || remaining <= 0) return;
    const delay = Math.max(0, interval * 1_000 - (Date.now() - lastSliceRef.current));
    const timer = window.setTimeout(() => void executeSlice(Math.min(slice, remaining)), delay);
    return () => window.clearTimeout(timer);
  }, [executeSlice, executing, interval, quoteFresh, remaining, running, selected.spread, slice, trigger]);

  const stateText = useMemo(() => {
    if (executing) return "Submitting and reconciling both legs…";
    if (!running) return "Live bot disarmed";
    if (!quoteFresh) return "Paused for stale quote";
    if ((selected.spread ?? -Infinity) < trigger) return `Waiting for spread ≥ ${trigger.toFixed(2)}%`;
    return "Waiting for next live slice";
  }, [executing, quoteFresh, running, selected.spread, trigger]);

  const arm = () => {
    if (!canArm) return;
    setFilledNotional(0);
    setReports([]);
    lastSliceRef.current = 0;
    setRunning(true);
  };
  const clearCredentials = () => {
    setRunning(false); setHyperPrivateKey(""); setVaultAddress(""); setBinanceApiKey(""); setBinanceSecret(""); setAcknowledged(false);
  };

  return <section className={`${styles.panel} ${styles.livePanel}`}>
    <div className={styles.panelHead}><div><span>MAINNET EXECUTION</span><h2>Live two-venue DCA</h2></div><small>Hyperliquid IOC first · Binance market hedge second</small></div>
    <div className={styles.liveCredentials}>
      <label>Hyperliquid API wallet private key<input type="password" autoComplete="new-password" value={hyperPrivateKey} onChange={(event) => setHyperPrivateKey(event.target.value)} placeholder="0x… dedicated API wallet" /></label>
      <label>Vault / subaccount address · optional<input type="password" autoComplete="off" value={vaultAddress} onChange={(event) => setVaultAddress(event.target.value)} placeholder="0x… leave empty for main account" /></label>
      <label>Binance Futures API key<input type="password" autoComplete="off" value={binanceApiKey} onChange={(event) => setBinanceApiKey(event.target.value)} placeholder="Trade permission · withdrawals off" /></label>
      <label>Binance HMAC secret<input type="password" autoComplete="new-password" value={binanceSecret} onChange={(event) => setBinanceSecret(event.target.value)} placeholder="Held only in this page memory" /></label>
      <label>Binance position mode<select value={positionMode} onChange={(event) => setPositionMode(event.target.value as PositionMode)}><option value="oneway">One-way · BOTH</option><option value="hedge">Hedge mode · LONG / SHORT</option></select></label>
    </div>
    <div className={styles.securityNote}><strong>Keys stay in this browser tab and are never saved or sent to this website.</strong><span>Keep this tab visible while live DCA is armed. Hidden or stale tabs pause automatically. Use dedicated trading keys, disable withdrawals, and set an IP whitelist where available.</span></div>
    <label className={styles.liveAcknowledgement}><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I authorize real Hyperliquid and Binance mainnet orders. I understand Hyperliquid fills first and can remain unhedged if Binance rejects or loses connectivity.</span></label>
    <div className={styles.liveProgress}><div><span style={{ width: `${progress}%` }} /></div><p><strong>{money(filledNotional)}</strong> hedged of {money(total)} · next slice up to {money(Math.min(slice, remaining))}</p></div>
    <div className={styles.liveControls}><button className={styles.armButton} disabled={!canArm || running || executing} onClick={arm}>{filledNotional > 0 ? "Start a new LIVE DCA" : "Arm & start LIVE DCA"}</button><button disabled={!running || executing} onClick={() => setRunning(false)}>Pause</button><button disabled={executing} onClick={clearCredentials}>Clear keys</button><span>{stateText}</span></div>
    {reports.length > 0 && <div className={styles.liveReports}><div className={styles.liveReportHead}><span>LIVE FILL REPORT</span><small>{reports.length} slice{reports.length === 1 ? "" : "s"}</small></div>{reports.map((report) => <article key={report.id} className={`${styles.liveReport} ${styles[report.tone]}`}><div><strong>{report.message}</strong><small>{clock(report.time)} HKT · trigger spread {pct(report.spread)}</small></div><div className={styles.liveLegs}>{report.hyper && <span><b>{report.hyper.side} HL</b> {px(report.hyper.size)} @ {px(report.hyper.price)} · {money(report.hyper.notional)} · #{report.hyper.orderId}</span>}{report.binance && <span><b>{report.binance.side} BN</b> {px(report.binance.size)} @ {px(report.binance.price)} · {money(report.binance.notional)} · #{report.binance.orderId ?? "—"}</span>}</div></article>)}</div>}
  </section>;
}
