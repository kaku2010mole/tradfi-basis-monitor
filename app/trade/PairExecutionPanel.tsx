"use client";

import { useMemo, useState } from "react";
import type { Relationship } from "../lib/relativeValue";
import styles from "../blog/page.module.css";

type Side = "BUY" | "SELL";
type PositionMode = "oneway" | "hedge";
type Direction = "longAsset2" | "shortAsset2";
type ExchangeFilter = { filterType?: string; minQty?: string; maxQty?: string; stepSize?: string; notional?: string; minNotional?: string };
type ExchangeSymbol = { symbol?: string; status?: string; marginAsset?: string; orderTypes?: string[]; filters?: ExchangeFilter[] };
type BookTicker = { symbol?: string; bidPrice?: string; askPrice?: string; time?: number };
type BinanceOrder = { orderId?: number; clientOrderId?: string; symbol?: string; status?: string; side?: Side; positionSide?: string; avgPrice?: string; executedQty?: string; cumQuote?: string; updateTime?: number; code?: number; msg?: string };
type LegReport = { role: "Asset 1" | "Asset 2"; symbol: string; side: Side; orderId: number | null; status: string; averagePrice: number; quantity: number; notional: number; targetNotional: number; preMid: number; slippageBps: number };
type ExecutionReport = { tone: "success" | "partial" | "error"; message: string; first?: LegReport; second?: LegReport; beta: number; balanceErrorPct?: number; preTradeRatio?: number; fillRatio?: number; ratioSlippageBps?: number; executedAt?: number };

const BINANCE_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"];
const BINANCE_TRADE_API = "https://fapi.binance.com";
const AMOUNTS = [10, 100, 1000, 2000] as const;

const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const price = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 8 });
const signed = (value: number, suffix = "") => `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;

async function publicBinance<T>(path: string) {
  let lastError: unknown;
  for (const host of BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(9_000) });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("Binance market data unavailable.");
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
  const fraction = normalized.split(".")[1]?.replace(/0+$/, "") ?? "";
  return fraction.length;
};

function quantityForNotional(instrument: ExchangeSymbol, targetNotional: number, referencePrice: number) {
  const filters = instrument.filters ?? [];
  const lot = filters.find((filter) => filter.filterType === "MARKET_LOT_SIZE") ?? filters.find((filter) => filter.filterType === "LOT_SIZE");
  const stepText = lot?.stepSize ?? "";
  const step = number(stepText);
  const minQty = number(lot?.minQty) ?? 0;
  const maxQty = number(lot?.maxQty) ?? Number.POSITIVE_INFINITY;
  const notionalFilter = filters.find((filter) => filter.filterType === "MIN_NOTIONAL" || filter.filterType === "NOTIONAL");
  const minNotional = number(notionalFilter?.notional ?? notionalFilter?.minNotional) ?? 0;
  if (!step) throw new Error(`${instrument.symbol} has no usable market-order step size.`);
  const raw = targetNotional / referencePrice;
  const stepped = Math.round(raw / step) * step;
  if (stepped < minQty || stepped <= 0) throw new Error(`${instrument.symbol} target is below its minimum market quantity.`);
  if (stepped > maxQty) throw new Error(`${instrument.symbol} target exceeds its maximum market quantity.`);
  if (stepped * referencePrice < minNotional) throw new Error(`${instrument.symbol} target is below its ${money(minNotional)} minimum notional.`);
  return stepped.toFixed(decimalPlaces(stepText));
}

async function placeMarketOrder(input: { apiKey: string; apiSecret: string; symbol: string; side: Side; quantity: string; positionMode: PositionMode; serverOffset: number; role: "a1" | "a2" }) {
  const timestamp = Math.round(Date.now() + input.serverOffset);
  const params = new URLSearchParams({
    symbol: input.symbol,
    side: input.side,
    type: "MARKET",
    quantity: input.quantity,
    positionSide: input.positionMode === "hedge" ? input.side === "BUY" ? "LONG" : "SHORT" : "BOTH",
    newOrderRespType: "RESULT",
    newClientOrderId: `rv_${input.role}_${timestamp.toString(36)}`,
    recvWindow: "5000",
    timestamp: String(timestamp),
  });
  const query = params.toString();
  const signature = await hmacHex(input.apiSecret, query);
  let response: Response;
  try {
    response = await fetch(`${BINANCE_TRADE_API}/fapi/v1/order?${query}&signature=${signature}`, {
      method: "POST",
      credentials: "omit",
      headers: { "X-MBX-APIKEY": input.apiKey },
    });
  } catch {
    throw new Error(`Network interrupted after submitting ${input.symbol}. Its order status is unknown; check Binance before retrying.`);
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) as BinanceOrder : {};
  if (!response.ok) throw new Error(payload.msg || `Binance rejected ${input.symbol} (HTTP ${response.status}).`);
  return payload;
}

function reportLeg(role: LegReport["role"], targetNotional: number, preMid: number, order: BinanceOrder): LegReport {
  const quantity = number(order.executedQty);
  const averagePrice = number(order.avgPrice);
  const cumQuote = number(order.cumQuote);
  if (!quantity || !averagePrice) throw new Error(`${order.symbol || role} returned no completed fill price.`);
  const notional = cumQuote ?? quantity * averagePrice;
  const side = order.side === "SELL" ? "SELL" : "BUY";
  const slippageBps = side === "BUY" ? (averagePrice / preMid - 1) * 10_000 : (preMid / averagePrice - 1) * 10_000;
  return { role, symbol: order.symbol ?? "—", side, orderId: Number.isFinite(Number(order.orderId)) ? Number(order.orderId) : null, status: order.status ?? "UNKNOWN", averagePrice, quantity, notional, targetNotional, preMid, slippageBps };
}

export default function PairExecutionPanel({ relationship, beta }: { relationship: Relationship; beta: number }) {
  const [amount, setAmount] = useState<number>(100);
  const [direction, setDirection] = useState<Direction>("longAsset2");
  const [positionMode, setPositionMode] = useState<PositionMode>("oneway");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ExecutionReport | null>(null);

  const eligible = relationship.asset1.venue === "binance" && relationship.asset2.venue === "binance" && Number.isFinite(beta) && Math.abs(beta) > .0001;
  const sides = useMemo(() => {
    const asset2: Side = direction === "longAsset2" ? "BUY" : "SELL";
    const asset1: Side = direction === "longAsset2" ? beta >= 0 ? "SELL" : "BUY" : beta >= 0 ? "BUY" : "SELL";
    return { asset1, asset2 };
  }, [beta, direction]);
  const asset1Target = Math.abs(beta) * amount;

  const execute = async () => {
    if (!eligible || !apiKey || !apiSecret || !acknowledged || loading) return;
    setLoading(true);
    setReport(null);
    let first: LegReport | undefined;
    try {
      const [exchange, books, time] = await Promise.all([
        publicBinance<{ symbols?: ExchangeSymbol[] }>("/fapi/v1/exchangeInfo"),
        publicBinance<BookTicker[]>("/fapi/v1/ticker/bookTicker"),
        publicBinance<{ serverTime?: number }>("/fapi/v1/time"),
      ]);
      const instruments = new Map((exchange.symbols ?? []).flatMap((item) => item.symbol ? [[item.symbol, item] as const] : []));
      const booksBySymbol = new Map(books.flatMap((item) => item.symbol ? [[item.symbol, item] as const] : []));
      const asset1Instrument = instruments.get(relationship.asset1.symbol);
      const asset2Instrument = instruments.get(relationship.asset2.symbol);
      const asset1Book = booksBySymbol.get(relationship.asset1.symbol);
      const asset2Book = booksBySymbol.get(relationship.asset2.symbol);
      if (!asset1Instrument || asset1Instrument.status !== "TRADING" || asset1Instrument.marginAsset !== "USDT" || !asset1Instrument.orderTypes?.includes("MARKET")) throw new Error(`${relationship.asset1.symbol} is not available for Binance USDⓈ-M market orders.`);
      if (!asset2Instrument || asset2Instrument.status !== "TRADING" || asset2Instrument.marginAsset !== "USDT" || !asset2Instrument.orderTypes?.includes("MARKET")) throw new Error(`${relationship.asset2.symbol} is not available for Binance USDⓈ-M market orders.`);
      const asset1Bid = number(asset1Book?.bidPrice); const asset1Ask = number(asset1Book?.askPrice);
      const asset2Bid = number(asset2Book?.bidPrice); const asset2Ask = number(asset2Book?.askPrice);
      if (!asset1Bid || !asset1Ask || !asset2Bid || !asset2Ask) throw new Error("One or both Binance order books are unavailable.");
      const asset1Mid = (asset1Bid + asset1Ask) / 2;
      const asset2Mid = (asset2Bid + asset2Ask) / 2;
      const asset2Reference = sides.asset2 === "BUY" ? asset2Ask : asset2Bid;
      const asset1Reference = sides.asset1 === "BUY" ? asset1Ask : asset1Bid;
      const asset2Quantity = quantityForNotional(asset2Instrument, amount, asset2Reference);
      quantityForNotional(asset1Instrument, asset1Target, asset1Reference);
      const serverOffset = Number(time.serverTime) - Date.now();
      const firstOrder = await placeMarketOrder({ apiKey: apiKey.trim(), apiSecret, symbol: relationship.asset2.symbol, side: sides.asset2, quantity: asset2Quantity, positionMode, serverOffset: Number.isFinite(serverOffset) ? serverOffset : 0, role: "a2" });
      first = reportLeg("Asset 2", amount, asset2Mid, firstOrder);
      const refreshedBook = await publicBinance<BookTicker>(`/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(relationship.asset1.symbol)}`);
      const refreshedBid = number(refreshedBook.bidPrice); const refreshedAsk = number(refreshedBook.askPrice);
      if (!refreshedBid || !refreshedAsk) throw new Error(`${relationship.asset1.symbol} order book disappeared after Asset 2 filled.`);
      const secondTarget = Math.abs(beta) * first.notional;
      const secondReference = sides.asset1 === "BUY" ? refreshedAsk : refreshedBid;
      const asset1Quantity = quantityForNotional(asset1Instrument, secondTarget, secondReference);
      const secondOrder = await placeMarketOrder({ apiKey: apiKey.trim(), apiSecret, symbol: relationship.asset1.symbol, side: sides.asset1, quantity: asset1Quantity, positionMode, serverOffset: Number.isFinite(serverOffset) ? serverOffset : 0, role: "a1" });
      const second = reportLeg("Asset 1", secondTarget, asset1Mid, secondOrder);
      const preTradeRatio = asset2Mid / asset1Mid;
      const fillRatio = first.averagePrice / second.averagePrice;
      setReport({ tone: "success", message: "Both Binance market orders filled.", first, second, beta, balanceErrorPct: (second.notional / (Math.abs(beta) * first.notional) - 1) * 100, preTradeRatio, fillRatio, ratioSlippageBps: (fillRatio / preTradeRatio - 1) * 10_000, executedAt: Date.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pair execution failed.";
      setReport(first ? { tone: "partial", message: `Asset 2 filled but Asset 1 did not complete: ${message}`, first, beta, executedAt: Date.now() } : { tone: "error", message, beta, executedAt: Date.now() });
    } finally { setLoading(false); }
  };

  const lockPage = async () => {
    setApiSecret("");
    await fetch("/api/trade-auth", { method: "DELETE" });
    window.location.reload();
  };

  return <section className={styles.executionPanel}>
    <div className={styles.executionHead}><div><span>LIVE BINANCE EXECUTION</span><h3>β-balanced two-leg market order</h3><p>Asset 2 executes first. Asset 1 is sized from the actual Asset 2 fill so the final notionals target |β| : 1.</p></div><button onClick={lockPage}>Lock page</button></div>
    {!eligible ? <div className={styles.executionUnavailable}><strong>Execution unavailable for this relationship</strong><span>Both assets must be active Binance USDⓈ-M symbols and the model beta must be non-zero.</span></div> : <>
      <div className={styles.executionPlan}>
        <div><span>Asset 1 hedge</span><strong className={sides.asset1 === "BUY" ? styles.positive : styles.negative}>{sides.asset1} {relationship.asset1.symbol}</strong><small>Target {money(asset1Target)} · |β| × Asset 2</small></div>
        <div><span>Asset 2 position</span><strong className={sides.asset2 === "BUY" ? styles.positive : styles.negative}>{sides.asset2} {relationship.asset2.symbol}</strong><small>Target {money(amount)} · executes first</small></div>
        <div><span>Balance rule</span><strong>{Math.abs(beta).toFixed(3)} : 1</strong><small>β {signed(beta)} · Asset 1 : Asset 2</small></div>
      </div>
      <div className={styles.executionControls}>
        <div className={styles.executionField}><span>Asset 2 amount</span><div className={styles.amountButtons}>{AMOUNTS.map((value) => <button key={value} className={amount === value ? styles.activeAmount : ""} onClick={() => { setAmount(value); setReport(null); }}>{money(value)}</button>)}</div></div>
        <label>Relative direction<select value={direction} onChange={(event) => { setDirection(event.target.value as Direction); setReport(null); }}><option value="longAsset2">Long Asset 2 residual</option><option value="shortAsset2">Short Asset 2 residual</option></select></label>
        <label>Binance position mode<select value={positionMode} onChange={(event) => setPositionMode(event.target.value as PositionMode)}><option value="oneway">One-way · BOTH</option><option value="hedge">Hedge mode · LONG/SHORT</option></select></label>
      </div>
      <div className={styles.executionCredentials}>
        <label>Binance Futures API key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Trade permission required" /></label>
        <label>HMAC API secret<input type="password" autoComplete="new-password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} placeholder="Held only in this page memory" /></label>
      </div>
      <div className={styles.executionSecurity}><strong>Credentials are signed locally and sent directly from this browser to Binance.</strong><span>They are not sent to this website or saved in local storage. Use a dedicated Futures key with withdrawals disabled and an IP whitelist matching this device when possible.</span></div>
      <label className={styles.liveAcknowledgement}><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I understand this submits two real market orders. If the second leg fails, the first leg remains open and must be managed in Binance.</span></label>
      <button className={styles.executeButton} disabled={loading || !apiKey.trim() || !apiSecret || !acknowledged} onClick={() => void execute()}>{loading ? "Executing live pair…" : `Execute ${money(asset1Target)} / ${money(amount)} live pair`}</button>
    </>}
    {report && <div className={`${styles.executionReport} ${styles[report.tone]}`}><div className={styles.reportTitle}><div><span>EXECUTION REPORT</span><strong>{report.message}</strong></div>{report.executedAt && <small>{new Date(report.executedAt).toLocaleString("en-GB", { timeZone: "Asia/Hong_Kong", hour12: false })} HKT</small>}</div>{[report.first, report.second].filter((leg): leg is LegReport => Boolean(leg)).map((leg) => <div className={styles.reportLeg} key={leg.role}><div><span>{leg.role}</span><strong>{leg.side} {leg.symbol}</strong></div><div><span>Average fill</span><strong>{price(leg.averagePrice)}</strong></div><div><span>Executed quantity</span><strong>{price(leg.quantity)}</strong></div><div><span>Actual / target</span><strong>{money(leg.notional)} / {money(leg.targetNotional)}</strong></div><div><span>Mid slippage</span><strong>{signed(leg.slippageBps, " bps")}</strong></div><div><span>Order</span><strong>{leg.orderId ?? "—"} · {leg.status}</strong></div></div>)}{report.tone === "success" && <div className={styles.reportSummary}><div><span>Balance error</span><strong>{signed(report.balanceErrorPct ?? 0, "%")}</strong></div><div><span>Pre-trade A2/A1</span><strong>{price(report.preTradeRatio ?? 0)}</strong></div><div><span>Fill A2/A1</span><strong>{price(report.fillRatio ?? 0)}</strong></div><div><span>Ratio slippage</span><strong>{signed(report.ratioSlippageBps ?? 0, " bps")}</strong></div></div>}</div>}
  </section>;
}
