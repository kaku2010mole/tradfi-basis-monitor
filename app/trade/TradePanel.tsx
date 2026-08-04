"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type Market = {
  symbol: string;
  oracle: number;
  mark: number;
  bid: number;
  bidQty: number | null;
  ask: number;
  askQty: number | null;
  serverTime: number;
  clientTime: number;
  updatedAt: number;
  filters: {
    minPrice: number | null;
    maxPrice: number | null;
    tickSize: number | null;
    minQty: number | null;
    maxQty: number | null;
    stepSize: number | null;
    minNotional: number | null;
  };
};
type OrderDraft = {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "BOTH" | "LONG" | "SHORT";
  price: string;
  quantity: string;
  notional: number;
  oracle: number;
  offsetPct: number;
  serverTime: number;
  reduceOnly: boolean;
};

const CUSTOM_PAIRS_KEY = "oracle-monitor-custom-pairs-v1";
const DEFAULT_SYMBOLS = ["HK1810USDT", "HK0700USDT", "TENCENTUSDT"];
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const price = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 8 });
const decimals = (step: number) => {
  const value = step.toString().toLowerCase();
  if (value.includes("e-")) return Number(value.split("e-")[1]);
  return value.includes(".") ? value.split(".")[1].length : 0;
};
const stepped = (value: number, step: number, mode: "round" | "floor") => {
  const units = mode === "round" ? Math.round(value / step) : Math.floor((value + step * 1e-9) / step);
  return (units * step).toFixed(decimals(step));
};
const hmacHex = async (secret: string, message: string) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export default function TradePanel() {
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOLS[0]);
  const [symbolInput, setSymbolInput] = useState(DEFAULT_SYMBOLS[0]);
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS);
  const [market, setMarket] = useState<Market | null>(null);
  const [side, setSide] = useState<"BUY" | "SELL">("SELL");
  const [positionSide, setPositionSide] = useState<"BOTH" | "LONG" | "SHORT">("BOTH");
  const [offsetPct, setOffsetPct] = useState(.25);
  const [notionalUsd, setNotionalUsd] = useState(1000);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [liveAcknowledged, setLiveAcknowledged] = useState(false);
  const [review, setReview] = useState<OrderDraft | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [result, setResult] = useState<{ tone: "success" | "error"; message: string; detail?: string } | null>(null);

  useEffect(() => {
    let nextSymbols = DEFAULT_SYMBOLS;
    try {
      const custom = JSON.parse(window.localStorage.getItem(CUSTOM_PAIRS_KEY) || "[]") as Array<{ venue?: string; apiSymbol?: string }>;
      nextSymbols = Array.from(new Set([...DEFAULT_SYMBOLS, ...custom.filter((pair) => pair.venue === "Binance").map((pair) => String(pair.apiSymbol || "").toUpperCase()).filter(Boolean)]));
    } catch { /* Device has no usable saved pairs. */ }
    const frame = window.requestAnimationFrame(() => setSymbols(nextSymbols));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const loadMarket = useCallback(async () => {
    try {
      const response = await fetch(`/api/binance-trade/market?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const payload = await response.json() as Market & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Market unavailable.");
      setMarket(payload);
      setMarketError("");
    } catch (error) {
      setMarket(null);
      setMarketError(error instanceof Error ? error.message : "Market unavailable.");
    }
  }, [symbol]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadMarket());
    const timer = window.setInterval(loadMarket, 5000);
    return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); };
  }, [loadMarket]);

  const calculation = useMemo(() => {
    const tick = market?.filters.tickSize;
    const step = market?.filters.stepSize;
    if (!market || !tick || !step || !Number.isFinite(offsetPct) || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
    const target = market.oracle * (1 + offsetPct / 100);
    const orderPrice = stepped(target, tick, "round");
    const quantity = stepped(notionalUsd / Number(orderPrice), step, "floor");
    const actualNotional = Number(orderPrice) * Number(quantity);
    const errors: string[] = [];
    if (Number(quantity) <= 0) errors.push("USD amount is too small for the quantity step.");
    if (market.filters.minQty && Number(quantity) < market.filters.minQty) errors.push(`Minimum quantity is ${market.filters.minQty}.`);
    if (market.filters.maxQty && Number(quantity) > market.filters.maxQty) errors.push(`Maximum quantity is ${market.filters.maxQty}.`);
    if (market.filters.minNotional && actualNotional < market.filters.minNotional) errors.push(`Minimum notional is ${money(market.filters.minNotional)}.`);
    if (market.filters.minPrice && Number(orderPrice) < market.filters.minPrice) errors.push("Target price is below Binance's allowed range.");
    if (market.filters.maxPrice && Number(orderPrice) > market.filters.maxPrice) errors.push("Target price is above Binance's allowed range.");
    return { orderPrice, quantity, actualNotional, errors };
  }, [market, notionalUsd, offsetPct]);

  const changeDraft = () => { setReview(null); setResult(null); };
  const reviewOrder = () => {
    if (!market || !calculation || calculation.errors.length) return;
    setReview({ symbol, side, positionSide, price: calculation.orderPrice, quantity: calculation.quantity, notional: calculation.actualNotional, oracle: market.oracle, offsetPct, serverTime: market.serverTime, clientTime: Date.now(), reduceOnly });
    setResult(null);
  };

  const submitOrder = async () => {
    if (!review || !apiKey || !apiSecret || (liveMode && !liveAcknowledged)) return;
    setLoading(true);
    setResult(null);
    try {
      const now = review.serverTime + Math.max(0, Date.now() - review.clientTime);
      const params = new URLSearchParams({
        symbol: review.symbol,
        side: review.side,
        type: "LIMIT",
        timeInForce: "GTX",
        quantity: review.quantity,
        price: review.price,
        positionSide: review.positionSide,
        newOrderRespType: "RESULT",
        newClientOrderId: `oracle_${Date.now().toString(36)}`,
        recvWindow: "5000",
        timestamp: String(Math.round(now)),
      });
      if (review.reduceOnly && review.positionSide === "BOTH") params.set("reduceOnly", "true");
      const query = params.toString();
      const signature = await hmacHex(apiSecret, query);
      const response = await fetch("/api/binance-trade/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, query, signature, live: liveMode }),
      });
      const payload = await response.json() as { error?: string; order?: { orderId?: number; status?: string; clientOrderId?: string } };
      if (!response.ok) throw new Error(payload.error || "Order rejected.");
      setResult({
        tone: "success",
        message: liveMode ? "Live post-only order submitted." : "Signature and order parameters passed Binance Test Order.",
        detail: payload.order?.orderId ? `Order ${payload.order.orderId} · ${payload.order.status || "NEW"}` : liveMode ? payload.order?.clientOrderId : "No order entered the matching engine.",
      });
      setReview(null);
    } catch (error) {
      setResult({ tone: "error", message: error instanceof Error ? error.message : "Order request failed." });
    } finally {
      setApiSecret("");
      setLoading(false);
    }
  };

  const lockDesk = async () => {
    await fetch("/api/trade-auth", { method: "DELETE" });
    window.location.reload();
  };

  return <main className={styles.shell}>
    <div className={styles.frame}>
      <header className={styles.topbar}>
        <div><p className={styles.eyebrow}>SIGNED EXECUTION / BINANCE USDⓈ-M</p><h1>Oracle Order Desk</h1><p>Build a post-only limit order at Oracle ± offset. Review first, then sign locally in this browser.</p></div>
        <div className={styles.topActions}><span className={market ? styles.online : styles.offline}><i />{market ? "Binance connected" : "Binance reconnecting"}</span><PageSwitcher active="trade" /><button onClick={lockDesk}>Lock desk</button></div>
      </header>

      <section className={styles.securityNotice}><strong>API Secret stays in this browser.</strong><span>The browser signs the order locally. Only the API key and signed order are sent to this server. Use a dedicated Futures key with withdrawals disabled.</span></section>

      <div className={styles.workspace}>
        <section className={styles.builder}>
          <div className={styles.sectionHead}><div><p className={styles.eyebrow}>01 / BUILD</p><h2>Order instructions</h2></div><span>Post-only · GTX</span></div>
          <div className={styles.formGrid}>
            <label className={styles.wide}>Binance Futures symbol<div className={styles.symbolControl}><input list="trade-symbols" value={symbolInput} onChange={(event) => { setSymbolInput(event.target.value.toUpperCase()); changeDraft(); }} /><button onClick={() => { const next = symbolInput.trim().toUpperCase(); if (/^[A-Z0-9_]{2,32}$/.test(next)) setSymbol(next); }}>Load</button></div><datalist id="trade-symbols">{symbols.map((item) => <option key={item} value={item} />)}</datalist></label>
            <label>Side<select value={side} onChange={(event) => { setSide(event.target.value as "BUY" | "SELL"); changeDraft(); }}><option value="BUY">BUY</option><option value="SELL">SELL</option></select></label>
            <label>Position side<select value={positionSide} onChange={(event) => { setPositionSide(event.target.value as "BOTH" | "LONG" | "SHORT"); setReduceOnly(false); changeDraft(); }}><option value="BOTH">BOTH · one-way</option><option value="LONG">LONG · hedge mode</option><option value="SHORT">SHORT · hedge mode</option></select></label>
            <label>Oracle offset<div className={styles.unitInput}><input type="number" step="0.01" value={offsetPct} onChange={(event) => { setOffsetPct(Number(event.target.value)); changeDraft(); }} /><span>%</span></div></label>
            <label>Order amount<div className={styles.unitInput}><span>$</span><input type="number" min="1" step="10" value={notionalUsd} onChange={(event) => { setNotionalUsd(Number(event.target.value)); changeDraft(); }} /></div></label>
          </div>
          <label className={styles.check}><input type="checkbox" checked={reduceOnly} disabled={positionSide !== "BOTH"} onChange={(event) => { setReduceOnly(event.target.checked); changeDraft(); }} /><span>Reduce-only <small>Available in one-way mode only</small></span></label>
          {marketError && <p className={styles.error}>{marketError}</p>}
          {calculation?.errors.map((message) => <p className={styles.error} key={message}>{message}</p>)}
        </section>

        <aside className={styles.marketCard}>
          <div className={styles.sectionHead}><div><p className={styles.eyebrow}>LIVE REFERENCE</p><h2>{symbol}</h2></div><button onClick={() => void loadMarket()}>Refresh</button></div>
          <dl><div><dt>Oracle</dt><dd>{market ? price(market.oracle) : "—"}</dd></div><div><dt>Mark</dt><dd>{market ? price(market.mark) : "—"}</dd></div><div><dt>Best bid</dt><dd>{market ? price(market.bid) : "—"}<small>{market?.bidQty ? `${price(market.bidQty)} qty` : ""}</small></dd></div><div><dt>Best ask</dt><dd>{market ? price(market.ask) : "—"}<small>{market?.askQty ? `${price(market.askQty)} qty` : ""}</small></dd></div></dl>
          <div className={styles.target}><span>Target limit</span><strong>{calculation ? calculation.orderPrice : "—"}</strong><small>{offsetPct >= 0 ? "+" : ""}{offsetPct}% from current oracle</small></div>
        </aside>
      </div>

      <section className={styles.reviewPanel}>
        <div className={styles.sectionHead}><div><p className={styles.eyebrow}>02 / REVIEW & SIGN</p><h2>Execution preview</h2></div><button className={styles.reviewButton} disabled={!calculation || calculation.errors.length > 0} onClick={reviewOrder}>Review order</button></div>
        {review ? <>
          <div className={styles.ticket}>
            <div><span>Side</span><strong className={review.side === "BUY" ? styles.buy : styles.sell}>{review.side}</strong></div><div><span>Symbol</span><strong>{review.symbol}</strong></div><div><span>Limit price</span><strong>{review.price}</strong></div><div><span>Quantity</span><strong>{review.quantity}</strong></div><div><span>Notional</span><strong>{money(review.notional)}</strong></div><div><span>Reference</span><strong>{price(review.oracle)}</strong></div>
          </div>
          <div className={styles.modeTabs}><button className={!liveMode ? styles.activeMode : ""} onClick={() => { setLiveMode(false); setLiveAcknowledged(false); }}>Test order</button><button className={liveMode ? styles.liveMode : ""} onClick={() => setLiveMode(true)}>Live order</button></div>
          <div className={styles.credentials}>
            <label>Binance API key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value.trim())} placeholder="Required · sent with signed order" /></label>
            <label>HMAC API secret<input type="password" autoComplete="new-password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} placeholder="Required · never leaves this browser" /></label>
          </div>
          {liveMode && <label className={`${styles.check} ${styles.liveCheck}`}><input type="checkbox" checked={liveAcknowledged} onChange={(event) => setLiveAcknowledged(event.target.checked)} /><span>I confirm this is a real order that may execute on Binance.</span></label>}
          <button className={`${styles.submitButton} ${liveMode ? styles.liveSubmit : ""}`} disabled={loading || !apiKey || !apiSecret || (liveMode && !liveAcknowledged)} onClick={submitOrder}>{loading ? "Signing and submitting…" : liveMode ? "Confirm & place live order" : "Sign & validate test order"}</button>
        </> : <div className={styles.emptyReview}>Build the order, then lock a preview before entering credentials.</div>}
        {result && <div className={result.tone === "success" ? styles.successResult : styles.errorResult}><strong>{result.message}</strong>{result.detail && <span>{result.detail}</span>}</div>}
      </section>

      <footer className={styles.footer}>Target prices are recalculated from the latest Binance index price when you review. Post-only orders can be rejected if they would immediately cross the book. Always verify live order status in Binance.</footer>
    </div>
  </main>;
}
