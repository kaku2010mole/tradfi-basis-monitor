"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount } from "viem/accounts";
import type { SelectedTakerDirection, TakerQuote } from "./types";
import styles from "./page.module.css";

type Side = "BUY" | "SELL";
type HyperMeta = { universe?: Array<{ name?: string; szDecimals?: number }> };
type PerpDex = { name?: string } | null;
type RawStatus = { filled: { totalSz: string; avgPx: string; oid: number } } | { error: string } | { resting: { oid: number } } | "waitingForFill" | "waitingForTrigger";
type LiveLeg = { coin: string; side: Side; price: number; size: number; notional: number; orderId: number };
type SliceReport = {
  id: number;
  time: number;
  tone: "success" | "partial" | "error";
  message: string;
  spread: number;
  requestedA: number;
  requestedB: number;
  legA?: LiveLeg;
  legB?: LiveLeg;
  balanceErrorPct?: number;
  details?: string;
};

const positive = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; };
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const px = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 8 });
const pct = (value: number, digits = 3) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const clock = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

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

function readFill(status: RawStatus | undefined, coin: string, side: Side): { leg?: LiveLeg; error?: string } {
  if (!status) return { error: `${coin}: no order status returned` };
  if (typeof status === "string") return { error: `${coin}: ${status}` };
  if ("error" in status) return { error: `${coin}: ${status.error}` };
  if ("resting" in status) return { error: `${coin}: IOC unexpectedly rested as order ${status.resting.oid}` };
  const size = positive(status.filled.totalSz);
  const price = positive(status.filled.avgPx);
  if (!size || !price) return { error: `${coin}: invalid fill response` };
  return { leg: { coin, side, price, size, notional: size * price, orderId: status.filled.oid } };
}

export default function LiveDcaPanel({ quote, quoteFresh, selected, coinA, coinB, hedgeRatio, total, slice, interval, trigger, slippageBps }: {
  quote: TakerQuote | null;
  quoteFresh: boolean;
  selected: SelectedTakerDirection;
  coinA: string;
  coinB: string;
  hedgeRatio: number;
  total: number;
  slice: number;
  interval: number;
  trigger: number;
  slippageBps: number;
}) {
  const [privateKey, setPrivateKey] = useState("");
  const [vaultAddress, setVaultAddress] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [running, setRunning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [filledNotionalA, setFilledNotionalA] = useState(0);
  const [reports, setReports] = useState<SliceReport[]>([]);
  const lastSliceRef = useRef(0);
  const executionRef = useRef(false);

  const remaining = Math.max(0, total - filledNotionalA);
  const progress = total > 0 ? Math.min(100, filledNotionalA / total * 100) : 0;
  const canArm = Boolean(quoteFresh && quote && selected.spread !== null && total > 0 && slice > 0 && hedgeRatio > 0 && slippageBps >= 0 && /^0x[0-9a-fA-F]{64}$/.test(privateKey.trim()) && (!vaultAddress.trim() || /^0x[0-9a-fA-F]{40}$/.test(vaultAddress.trim())) && acknowledged);
  const addReport = useCallback((report: SliceReport) => setReports((current) => [report, ...current].slice(0, 80)), []);

  useEffect(() => {
    const timer = window.setTimeout(() => setRunning(false), 0);
    return () => window.clearTimeout(timer);
  }, [coinA, coinB, hedgeRatio, interval, selected.direction, slice, slippageBps, total, trigger]);

  const executeSlice = useCallback(async (requestedA: number) => {
    if (!quote || selected.spread === null || executionRef.current) return;
    executionRef.current = true;
    setExecuting(true);
    const startedAt = Date.now();
    const requestedB = requestedA * hedgeRatio;
    const buyA = selected.direction === "longA";
    const sideA: Side = buyA ? "BUY" : "SELL";
    const sideB: Side = buyA ? "SELL" : "BUY";
    let submitted = false;
    try {
      const [assetA, assetB] = await Promise.all([resolveHyperAsset(coinA), resolveHyperAsset(coinB)]);
      const referenceA = buyA ? quote.legA.ask : quote.legA.bid;
      const referenceB = buyA ? quote.legB.bid : quote.legB.ask;
      const sizeA = formatSize(requestedA / referenceA, assetA.szDecimals);
      const sizeB = formatSize(requestedB / referenceB, assetB.szDecimals);
      if (!positive(sizeA)) throw new Error(`${coinA} slice is below its minimum size precision.`);
      if (!positive(sizeB)) throw new Error(`${coinB} slice is below its minimum size precision.`);
      const paddedA = referenceA * (buyA ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000);
      const paddedB = referenceB * (buyA ? 1 - slippageBps / 10_000 : 1 + slippageBps / 10_000);
      const orderPriceA = formatPrice(paddedA, assetA.szDecimals, "perp");
      const orderPriceB = formatPrice(paddedB, assetB.szDecimals, "perp");
      const wallet = privateKeyToAccount(privateKey.trim() as `0x${string}`);
      const client = new ExchangeClient({
        transport: new HttpTransport({ timeout: 8_000 }),
        wallet,
        ...(vaultAddress.trim() ? { defaultVaultAddress: vaultAddress.trim() as `0x${string}` } : {}),
        defaultExpiresAfter: () => Date.now() + 5_000,
      });

      submitted = true;
      const result = await client.order({
        orders: [
          { a: assetA.assetId, b: buyA, p: orderPriceA, s: sizeA, r: false, t: { limit: { tif: "Ioc" } } },
          { a: assetB.assetId, b: !buyA, p: orderPriceB, s: sizeB, r: false, t: { limit: { tif: "Ioc" } } },
        ],
        grouping: "na",
      });
      const statuses = result.response.data.statuses as RawStatus[];
      const parsedA = readFill(statuses[0], coinA, sideA);
      const parsedB = readFill(statuses[1], coinB, sideB);
      const legA = parsedA.leg;
      const legB = parsedB.leg;

      if (legA && legB) {
        const balanceErrorPct = (legB.notional / (hedgeRatio * legA.notional) - 1) * 100;
        addReport({ id: startedAt, time: Date.now(), tone: "success", message: "Both Hyperliquid IOC legs filled.", spread: selected.spread, requestedA, requestedB, legA, legB, balanceErrorPct });
        setFilledNotionalA((current) => {
          const next = Math.min(total, current + legA.notional);
          if (next >= total) setRunning(false);
          return next;
        });
        lastSliceRef.current = Date.now();
      } else {
        const filled = legA ?? legB;
        addReport({
          id: startedAt,
          time: Date.now(),
          tone: filled ? "partial" : "error",
          message: filled ? `UNHEDGED ${filled.coin} FILL — the opposite IOC leg did not fill.` : "Neither Hyperliquid IOC leg filled.",
          spread: selected.spread,
          requestedA,
          requestedB,
          legA,
          legB,
          details: [parsedA.error, parsedB.error].filter(Boolean).join(" · "),
        });
        setRunning(false);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Live Hyperliquid slice failed.";
      addReport({
        id: startedAt,
        time: Date.now(),
        tone: submitted ? "partial" : "error",
        message: submitted ? "ORDER STATUS UNKNOWN — verify both Hyperliquid positions before retrying." : detail,
        details: submitted ? detail : undefined,
        spread: selected.spread,
        requestedA,
        requestedB,
      });
      setRunning(false);
    } finally {
      executionRef.current = false;
      setExecuting(false);
    }
  }, [addReport, coinA, coinB, hedgeRatio, privateKey, quote, selected.direction, selected.spread, slippageBps, total, vaultAddress]);

  useEffect(() => {
    if (!running || executing || !quoteFresh || selected.spread === null || selected.spread < trigger || remaining <= 0) return;
    const delay = Math.max(0, interval * 1_000 - (Date.now() - lastSliceRef.current));
    const timer = window.setTimeout(() => void executeSlice(Math.min(slice, remaining)), delay);
    return () => window.clearTimeout(timer);
  }, [executeSlice, executing, interval, quoteFresh, remaining, running, selected.spread, slice, trigger]);

  const stateText = useMemo(() => {
    if (executing) return "Submitting one two-order Hyperliquid action…";
    if (!running) return "Live bot disarmed";
    if (!quoteFresh) return "Paused for stale quote";
    if ((selected.spread ?? -Infinity) < trigger) return `Waiting for spread ≥ ${trigger.toFixed(2)}%`;
    return "Waiting for next internal IOC slice";
  }, [executing, quoteFresh, running, selected.spread, trigger]);

  const arm = () => {
    if (!canArm) return;
    setFilledNotionalA(0);
    setReports([]);
    lastSliceRef.current = 0;
    setRunning(true);
  };

  const clearCredentials = () => {
    setRunning(false);
    setPrivateKey("");
    setVaultAddress("");
    setAcknowledged(false);
  };

  return <section className={`${styles.panel} ${styles.livePanel}`}>
    <div className={styles.panelHead}><div><span>HYPERLIQUID MAINNET</span><h2>Live internal taker–taker DCA</h2></div><small>Two IOC orders · one signed exchange action</small></div>
    <div className={styles.liveCredentials}>
      <label>Hyperliquid API wallet private key<input type="password" autoComplete="new-password" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} placeholder="0x… dedicated API wallet" /></label>
      <label>Vault / subaccount address · optional<input type="password" autoComplete="off" value={vaultAddress} onChange={(event) => setVaultAddress(event.target.value)} placeholder="0x… leave empty for main account" /></label>
    </div>
    <div className={styles.securityNote}><strong>The API wallet key stays in this browser tab and is sent only as a signature to Hyperliquid.</strong><span>Keep this tab visible while live DCA is armed. Hidden or stale tabs pause automatically. Use a dedicated API wallet with only the permissions and balance you need.</span></div>
    <label className={styles.liveAcknowledgement}><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I authorize two real Hyperliquid mainnet IOC orders per slice. I understand a multi-order action is not atomic: one perp can fill while the other does not.</span></label>
    <div className={styles.liveProgress}><div><span style={{ width: `${progress}%` }} /></div><p><strong>{money(filledNotionalA)}</strong> completed of {money(total)} on {coinA} · next targets {money(Math.min(slice, remaining))} {coinA} / {money(Math.min(slice, remaining) * hedgeRatio)} {coinB}</p></div>
    <div className={styles.liveControls}><button className={styles.armButton} disabled={!canArm || running || executing} onClick={arm}>{filledNotionalA > 0 ? "Start a new LIVE DCA" : "Arm & start LIVE DCA"}</button><button disabled={!running || executing} onClick={() => setRunning(false)}>Pause</button><button disabled={executing} onClick={clearCredentials}>Clear key</button><span>{stateText}</span></div>
    {reports.length > 0 && <div className={styles.liveReports}><div className={styles.liveReportHead}><span>HYPERLIQUID FILL REPORT</span><small>{reports.length} slice{reports.length === 1 ? "" : "s"}</small></div>{reports.map((report) => <article key={report.id} className={`${styles.liveReport} ${styles[report.tone]}`}><div><strong>{report.message}</strong><small>{clock(report.time)} HKT · trigger spread {pct(report.spread)}{report.balanceErrorPct === undefined ? "" : ` · balance error ${pct(report.balanceErrorPct, 2)}`}</small>{report.details && <small>{report.details}</small>}</div><div className={styles.liveLegs}>{report.legA && <span><b>{report.legA.side} {report.legA.coin}</b> {px(report.legA.size)} @ {px(report.legA.price)} · {money(report.legA.notional)} · #{report.legA.orderId}</span>}{report.legB && <span><b>{report.legB.side} {report.legB.coin}</b> {px(report.legB.size)} @ {px(report.legB.price)} · {money(report.legB.notional)} · #{report.legB.orderId}</span>}{!report.legA && !report.legB && <span><b>Requested</b> {money(report.requestedA)} {coinA} / {money(report.requestedB)} {coinB}</span>}</div></article>)}</div>}
  </section>;
}
