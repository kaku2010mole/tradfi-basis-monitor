"use client";

import { memo, useEffect, useState } from "react";
import { visiblePolling } from "../lib/visiblePolling";
import { decimalNumber } from "../lib/numberFormat";
import { TAIWAN_STOCKS } from "../lib/taiwanStockBasis";
import type { TaiwanPayload, TaiwanRow } from "../lib/taiwanStockBasis";
import TaiwanAdrOutlook from "./TaiwanAdrOutlook";
import TaiwanCashCard from "./TaiwanCashCard";
import TaiwanTwdPanel from "./TaiwanTwdPanel";
import { taiwanLiveComparison } from "../lib/taiwanLiveBasis";
import styles from "./KoreanPerpMonitor.module.css";
import tabs from "./TaiwanStockPanel.module.css";

const fmt = (n: number | null | undefined, digits = 3) => n == null || !Number.isFinite(n) ? "—" : decimalNumber(n, digits, digits);
const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
const stampFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const stamp = (n: number | null | undefined) => n == null ? "—" : stampFormat.format(n);
const emptyRows: TaiwanRow[] = TAIWAN_STOCKS.map((stock) => ({ ...stock, adrSymbol: "adrSymbol" in stock ? stock.adrSymbol : null, anchor: null, anchorError: null, book: { bid: null, ask: null, last: null, index: null, timestamp: null } }));

const TaiwanStockPanel = memo(function TaiwanStockPanel({ visible }: { visible: boolean }) {
  const [payload, setPayload] = useState<TaiwanPayload | null>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(0);
  const [mode, setMode] = useState<"live" | "returns">("live");
  const [studyOpen, setStudyOpen] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let stopped = false, inFlight = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 20_000);
      try {
        // Normal views skip model/index/ADR history. The optional historical
        // study reuses this poll, never a second request loop.
        const response = await fetch(studyOpen ? "/api/stock-basis/taiwan" : "/api/stock-basis/taiwan?view=prices", { cache: "no-store", signal: controller.signal });
        const next = await response.json() as TaiwanPayload;
        if (!response.ok || !Array.isArray(next.rows)) throw new Error(next.error || "Taiwan feed unavailable");
        if (!stopped) {
          setPayload((prior) => ({ ...next, rows: next.rows.map((row) => {
            const old = prior?.rows.find((item) => item.symbol === row.symbol);
            const useful = row.book.bid !== null || row.book.ask !== null || row.book.last !== null;
            return old && (!useful || (old.book.timestamp ?? 0) > (row.book.timestamp ?? 0)) ? { ...row, book: old.book } : row;
          }) }));
          setError(next.error || "");
        }
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : "Taiwan feed reconnecting"); }
      finally { clearTimeout(timeout); inFlight = false; }
    };
    const stopPolling = visiblePolling(() => { setClock(Date.now()); void load(); }, 2_000);
    return () => { stopped = true; stopPolling(); controller?.abort(); };
  }, [visible, studyOpen]);

  return <section hidden={!visible} className={`${styles.marketGroup} ${styles.taiwanGroup}`} aria-label="Taiwan stock reference basis">
    <div className={styles.groupHead}><div><span>03 / TAIWAN · BITGET + CASH</span><h3>Taiwan price comparison</h3></div><small>{TAIWAN_STOCKS.length} names · perp 2s / cash 60s</small></div>
    <div className={tabs.tabs} role="tablist" aria-label="Taiwan comparison basis">
      {(["live", "returns"] as const).map((tab) => <button key={tab} id={`taiwan-${tab}-tab`} type="button" role="tab" aria-selected={mode === tab} aria-controls={`taiwan-${tab}-panel`} tabIndex={mode === tab ? 0 : -1} onClick={() => setMode(tab)} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "live" : event.key === "End" ? "returns" : mode === "live" ? "returns" : "live";
        setMode(next); document.getElementById(`taiwan-${next}-tab`)?.focus();
      }}><strong>{tab === "live" ? "Live / Pre-open" : "Change vs close"}</strong><small>{tab === "live" ? "Cash & trial vs perp" : "Perp → TWD / latest cash close"}</small></button>)}
    </div>
    {error && <p role="status" className={styles.taiwanWarning}>{error} · Last observed quotes remain visible with their original timestamps.</p>}
    <div role="tabpanel" id={`taiwan-${mode}-panel`} aria-labelledby={`taiwan-${mode}-tab`}>
    {mode === "returns" ? <TaiwanTwdPanel rows={payload?.rows ?? emptyRows} payload={payload} now={clock} /> : <>
    <div className={tabs.context}>
      <div><b>Cash / trial price vs Bitget</b><span>Cash BBO midpoint during trading; trial price during auction. Stale inputs suppress the spread. All comparisons are indicative.</span></div>
      <div><b>USD/TWD {fmt(payload?.fx?.quote?.price)}</b><span>{stamp(payload?.fx?.quote?.timestamp)} HKT · {payload?.fx?.quote?.source ?? "Waiting for independent FX"}</span></div>
      <small>Assumes USDT = USD and 1 Taiwan share per perp price unit; multiplier unverified. Minute-sampled cash and indicative FX are not firm executable quotes.{payload?.fx?.error ? ` ${payload.fx.error}.` : ""}</small>
    </div>
    <div className={styles.rows}>{(payload?.rows ?? emptyRows).map((row) => {
      const cash = payload?.cash?.quotes[row.code];
      const live = taiwanLiveComparison(cash, row.book, payload?.fx?.quote, clock);
      const magnitude = Math.abs(live.deviation ?? 0);
      const tone = magnitude >= 1 ? styles.spreadHigh : magnitude >= 0.5 ? styles.spreadMedium : styles.spreadQuiet;
      return <details key={`${mode}:${row.symbol}`} className={`${styles.assetRow} ${styles.taiwanRow} ${magnitude >= 1 ? styles.highSpreadRow : magnitude >= 0.5 ? styles.mediumSpreadRow : ""}`}>
        <summary className={styles.assetSummary}>
          <span className={styles.summaryIdentity}><small>TWSE {row.code} · BITGET</small><strong>{row.name}</strong><small>{row.chineseName} · {row.symbol}</small><em>{fmt(row.book.bid)} / {fmt(row.book.ask)} USDT</em></span>
          <span className={styles.summarySignals}><span className={`${styles.perpSignal} ${tone}`}><small>PERP VS {live.kind} · INDICATIVE</small><strong>{pct(live.deviation)}</strong><em>{live.direction} · {live.isTrial ? "Trial" : "Cash"} NT$ {fmt(live.cashPrice)} · {stamp(live.cashTimestamp)} HKT{live.reason ? ` · ${live.reason}` : ""}</em></span></span>
          <span className={styles.summaryToggle}>Details <b>⌄</b></span>
        </summary>
        <div className={styles.assetDetails}>
          <div className={styles.identity}><small>TWSE {row.code} · {row.chineseName}</small><strong>{row.name}</strong><span className={styles.cashPrice}>{row.symbol}</span><span className={styles.sessionLabel}>Bitget quote: {stamp(row.book.timestamp)} HKT</span><span className={styles.sessionLabel}>LIVE / PRE-OPEN COMPARISON</span></div>
          <div className={styles.references}><TaiwanCashCard quote={cash} now={clock} error={payload?.cash?.errors[row.code]} configured={payload?.cash?.configured} comparison={live} book={row.book} fx={payload?.fx?.quote} /></div>
        </div>
      </details>;
    })}</div>
    <p className={styles.taiwanIntro}>Fugle cash / trial: shared 60s cache. USD/TWD: shared 60s cache, indicative observation; Bitget BBO: 2s. Trial and stale cash never become executable signals. No model adjustment in this tab.</p>
    </>}
    </div>
    <details className={tabs.study} onToggle={event => setStudyOpen(event.currentTarget.open)}><summary>TSM ADR → Taiwan opening outlook · historical study</summary>{studyOpen && (payload?.view === "full" ? <TaiwanAdrOutlook tsm={payload.tsm} anchorTimestamp={payload.anchorTimestamp} now={clock} /> : <p>Loading historical study…</p>)}</details>
  </section>;
});

export default TaiwanStockPanel;
