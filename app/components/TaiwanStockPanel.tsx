"use client";

import { memo, useEffect, useState } from "react";
import { visiblePolling } from "../lib/visiblePolling";
import { TAIWAN_STOCKS, taiwanAdrReference, taiwanComparison } from "../lib/taiwanStockBasis";
import type { TaiwanPayload, TaiwanRow } from "../lib/taiwanStockBasis";
import TaiwanAdrOutlook from "./TaiwanAdrOutlook";
import TaiwanCashCard from "./TaiwanCashCard";
import { taiwanLiveComparison } from "../lib/taiwanLiveBasis";
import styles from "./KoreanPerpMonitor.module.css";
import tabs from "./TaiwanStockPanel.module.css";

const fmt = (n: number | null | undefined, digits = 3) => n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
const stampFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const stamp = (n: number | null | undefined) => n == null ? "—" : stampFormat.format(n);
const emptyRows: TaiwanRow[] = TAIWAN_STOCKS.map((stock) => ({ ...stock, adrSymbol: "adrSymbol" in stock ? stock.adrSymbol : null, anchor: null, anchorError: null, book: { bid: null, ask: null, last: null, index: null, timestamp: null } }));

const TaiwanStockPanel = memo(function TaiwanStockPanel({ visible }: { visible: boolean }) {
  const [payload, setPayload] = useState<TaiwanPayload | null>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(0);
  const [mode, setMode] = useState<"live" | "model">("live");
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
        // Independent of Posley login / KRX / TSE failures. Cash credentials stay on the server.
        const response = await fetch("/api/stock-basis/taiwan", { cache: "no-store", signal: controller.signal });
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
  }, [visible]);

  return <section hidden={!visible} className={`${styles.marketGroup} ${styles.taiwanGroup}`} aria-label="Taiwan stock reference basis">
    <div className={styles.groupHead}><div><span>03 / TAIWAN · BITGET + CASH</span><h3>Taiwan price comparison</h3></div><small>{TAIWAN_STOCKS.length} names · perp 2s / cash 60s</small></div>
    <div className={tabs.tabs} role="tablist" aria-label="Taiwan comparison basis">
      {(["live", "model"] as const).map((tab) => <button key={tab} id={`taiwan-${tab}-tab`} type="button" role="tab" aria-selected={mode === tab} aria-controls={`taiwan-${tab}-panel`} tabIndex={mode === tab ? 0 : -1} onClick={() => setMode(tab)} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "live" : event.key === "End" ? "model" : mode === "live" ? "model" : "live";
        setMode(next); document.getElementById(`taiwan-${next}-tab`)?.focus();
      }}><strong>{tab === "live" ? "Live / Pre-open" : "Model"}</strong><small>{tab === "live" ? "Cash & trial vs perp" : "14:00 oracle / ADR returns"}</small></button>)}
    </div>
    {error && <p role="status" className={styles.taiwanWarning}>{error} · Last observed quotes remain visible with their original timestamps.</p>}
    <div role="tabpanel" id={`taiwan-${mode}-panel`} aria-labelledby={`taiwan-${mode}-tab`}>
    {mode === "live" ? <div className={tabs.context}>
      <div><b>Cash / trial price vs Bitget</b><span>Cash BBO midpoint during trading; trial price during auction. Stale inputs suppress the spread. All comparisons are indicative.</span></div>
      <div><b>USD/TWD {fmt(payload?.fx?.quote?.price)}</b><span>{stamp(payload?.fx?.quote?.timestamp)} HKT · {payload?.fx?.quote?.source ?? "Waiting for independent FX"}</span></div>
      <small>Assumes USDT = USD and 1 Taiwan share per perp price unit; multiplier unverified. Minute-sampled cash and indicative FX are not firm executable quotes.{payload?.fx?.error ? ` ${payload.fx.error}.` : ""}</small>
    </div> : <p className={styles.taiwanIntro}>Model only · Latest TWSE 14:00 anchor: {stamp(payload?.anchorTimestamp)} HKT. Automatically resets at 14:00 HKT on each TWSE trading day; before 14:00 or on holidays, uses the latest completed anchor. TWTSM follows TSM ADR returns; TWUMC follows UMC ADR returns. ADR baseline: 14:00 first, same-date 16:00 fallback if unavailable. Until that quote exists, the model waits. No current Taiwan cash price is used.</p>}
    <div className={styles.rows}>{(payload?.rows ?? emptyRows).map((row) => {
      const adr = taiwanAdrReference(row.adrSymbol, payload);
      const comparison = taiwanComparison(row, adr, clock);
      const cash = payload?.cash?.quotes[row.code];
      const live = taiwanLiveComparison(cash, row.book, payload?.fx?.quote, clock);
      const selected = mode === "live" ? live : comparison;
      const magnitude = Math.abs(selected.deviation ?? 0);
      const tone = magnitude >= 1 ? styles.spreadHigh : magnitude >= 0.3 ? styles.spreadMedium : styles.spreadQuiet;
      const modelLabel = row.adrSymbol ? `${row.adrSymbol} RETURN-ADJUSTED` : "LATEST 14:00 ORACLE";
      const refLabel = mode === "live" ? `PERP VS ${live.kind}` : modelLabel;
      return <details key={`${mode}:${row.symbol}`} className={`${styles.assetRow} ${styles.taiwanRow} ${magnitude >= 1 ? styles.highSpreadRow : magnitude >= 0.3 ? styles.mediumSpreadRow : ""}`}>
        <summary className={styles.assetSummary}>
          <span className={styles.summaryIdentity}><small>TWSE {row.code} · BITGET</small><strong>{row.name}</strong><small>{row.chineseName} · {row.symbol}</small><em>{fmt(row.book.bid)} / {fmt(row.book.ask)} USDT</em></span>
          <span className={styles.summarySignals}><span className={`${styles.perpSignal} ${tone}`}><small>{refLabel} · INDICATIVE{mode === "model" && row.adrSymbol ? ` · ADR ${adr.anchorMode ?? "waiting"}` : ""}</small><strong>{pct(selected.deviation)}</strong><em>{selected.direction} · {mode === "live" ? `${live.isTrial ? "Trial" : "Cash"} NT$ ${fmt(live.cashPrice)} · ${stamp(live.cashTimestamp)} HKT${live.reason ? ` · ${live.reason}` : ""}` : `${comparison.freshBook ? "fresh perp BBO" : "stale / incomplete perp quote"} · model ${fmt(comparison.reference)} USDT`}</em></span></span>
          <span className={styles.summaryToggle}>Details <b>⌄</b></span>
        </summary>
        <div className={styles.assetDetails}>
          <div className={styles.identity}><small>TWSE {row.code} · {row.chineseName}</small><strong>{row.name}</strong><span className={styles.cashPrice}>{row.symbol}</span><span className={styles.sessionLabel}>Bitget quote: {stamp(row.book.timestamp)} HKT</span><span className={styles.sessionLabel}>{mode === "live" ? "LIVE / PRE-OPEN COMPARISON" : "MODEL COMPARISON"}</span></div>
          <div className={styles.references}>
            {mode === "live" ? <TaiwanCashCard quote={cash} now={clock} error={payload?.cash?.errors[row.code]} configured={payload?.cash?.configured} comparison={live} book={row.book} fx={payload?.fx?.quote} /> : <>
            <div className={`${styles.referenceCard} ${tone}`}>
              <div className={styles.referenceHead}><div><span className={styles.referenceTag}>{refLabel}</span><strong>{row.symbol} · model deviation</strong></div><span className={styles.indicativePill}>INDICATIVE ONLY</span></div>
              <div className={styles.referencePrices}><span>PERP BID / ASK<b>{fmt(row.book.bid)} / {fmt(row.book.ask)}</b><small>USDT · {stamp(row.book.timestamp)} HKT</small></span><span>{row.adrSymbol ? `${row.adrSymbol}-ADJUSTED REFERENCE` : "FROZEN ORACLE REFERENCE"}<b>{fmt(comparison.reference)} USDT</b><small>Mid deviation {pct(comparison.deviation)}</small></span></div>
              <div className={styles.referenceEdges}><span>PERP BID / REFERENCE − 1<b>{pct(comparison.sellVsReference)}</b></span><span>REFERENCE / PERP ASK − 1<b>{pct(comparison.buyVsReference)}</b></span></div>
              <small className={styles.referenceFoot}>Historical oracle: {fmt(row.anchor?.price, 6)} USDT · {stamp(row.anchor?.timestamp)} HKT · {row.anchor?.source ?? "waiting for index history"}. Current index {fmt(row.book.index)} is shown for context only; it never replaces the anchor.</small>
            </div>
            {row.adrSymbol && <div className={`${styles.referenceCard} ${styles.adrCard}`}>
              <div className={styles.referenceHead}><div><span className={styles.referenceTag}>U.S. {row.adrSymbol} ADR · RELATIVE RETURN</span><strong>{row.symbol.replace(/USDT$/, "")} oracle × {row.adrSymbol} now / {row.adrSymbol} anchor</strong></div><span className={styles.indicativePill}>NOT A 1:1 PRICE COMPARISON</span></div>
              <div className={styles.referencePrices}><span>{row.adrSymbol} ADR BASELINE · {adr.anchorMode ?? "WAITING"}<b>{fmt(adr.anchor?.price)} USD</b><small>{stamp(adr.anchor?.timestamp)} HKT · {adr.anchor?.source ?? "Waiting for 14:00 / 16:00 ADR"}</small></span><span>LATEST {row.adrSymbol} ADR<b>{fmt(adr.current?.price)} USD</b><small>{stamp(adr.current?.timestamp)} HKT · {adr.current?.source ?? "unavailable"}</small></span></div>
              <div className={styles.referenceEdges}><span>{row.symbol.replace(/USDT$/, "")} VS FROZEN ORACLE<b>{pct(comparison.perpReturn)}</b></span><span>{row.adrSymbol} ADR CHANGE<b>{pct(comparison.adrReturn)}</b></span></div>
              <small className={styles.referenceFoot}>ADR baseline: 14:00 HKT, or same-date 16:00 if 14:00 is unavailable. Quotes must be no more than 60s old at that boundary; a boundary candle uses its open, not its later close. The oracle stays fixed at 14:00; with the fallback, ADR returns start at 16:00 and do not cover 14:00–16:00. Actual observation times are shown. Indicative only; no 08:00 close, other ADR or perpetual substitution.</small>
            </div>}
            </>}
          </div>
          {mode === "model" && (row.anchorError || row.adrSymbol && adr.error) && <p className={styles.mapping}>{row.anchorError || adr.error}</p>}
        </div>
      </details>;
    })}</div>
    {mode === "model" && <details className={tabs.study}><summary>TSM ADR → Taiwan opening outlook · historical study</summary><TaiwanAdrOutlook tsm={payload?.tsm ?? { anchor: null, current: null, error: null }} anchorTimestamp={payload?.anchorTimestamp ?? null} now={clock} /></details>}
    <p className={styles.taiwanIntro}>{mode === "live" ? "Fugle cash / trial: shared 60s cache. USD/TWD: shared 60s cache, indicative observation; Bitget BBO: 2s. Trial and stale cash never become executable signals. No model adjustment in this tab." : `Source: Bitget 14:00 index history + U.S. TSM / UMC ADR returns. ${payload?.calendarSource || "Loading Taiwan trading calendar"}. Model deviations are not current cash spreads.`}</p>
    </div>
  </section>;
});

export default TaiwanStockPanel;
