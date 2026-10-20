"use client";

import { useEffect, useState } from "react";
import { TAIWAN_STOCKS, taiwanComparison } from "../lib/taiwanStockBasis";
import type { TaiwanPayload, TaiwanRow } from "../lib/taiwanStockBasis";
import styles from "./KoreanPerpMonitor.module.css";

const fmt = (n: number | null | undefined, digits = 3) => n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
const stamp = (n: number | null | undefined) => n == null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(n);
const emptyRows: TaiwanRow[] = TAIWAN_STOCKS.map((stock) => ({ ...stock, adrSymbol: "adrSymbol" in stock ? stock.adrSymbol : null, anchor: null, anchorError: null, book: { bid: null, ask: null, last: null, index: null, timestamp: null } }));

export default function TaiwanStockPanel({ visible }: { visible: boolean }) {
  const [payload, setPayload] = useState<TaiwanPayload | null>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(0);
  useEffect(() => {
    let stopped = false, inFlight = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 20_000);
      try {
        // Independent of Posley login / KRX / TSE failures; only public references.
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
    const first = window.setTimeout(() => { setClock(Date.now()); void load(); }, 0);
    const timer = window.setInterval(() => { setClock(Date.now()); void load(); }, 2_000);
    return () => { stopped = true; clearTimeout(first); clearInterval(timer); controller?.abort(); };
  }, []);

  return <section hidden={!visible} className={`${styles.marketGroup} ${styles.taiwanGroup}`} aria-label="Taiwan stock reference basis">
    <div className={styles.groupHead}><div><span>03 / TAIWAN · BITGET</span><h3>Previous-day oracle &amp; TSM relative value</h3></div><small>{TAIWAN_STOCKS.length} names · 2s refresh<br />Anchor: {stamp(payload?.anchorTimestamp)} HKT / Taipei</small></div>
    <p className={styles.taiwanIntro}>Previous TWSE trading date at 14:00, skipping weekends and exchange holidays. TWTSM is adjusted by the U.S. TSM ADR return from that anchor. These are reference deviations, not executable cash/ADR spreads.</p>
    {error && <p role="status" className={styles.taiwanWarning}>{error} · Last observed quotes remain visible with their original timestamps.</p>}
    <div className={styles.rows}>{(payload?.rows ?? emptyRows).map((row) => {
      const tsm = payload?.tsm ?? { anchor: null, current: null, error: null };
      const comparison = taiwanComparison(row, tsm, clock);
      const magnitude = Math.abs(comparison.deviation ?? 0);
      const tone = magnitude >= 1 ? styles.spreadHigh : magnitude >= 0.3 ? styles.spreadMedium : styles.spreadQuiet;
      const refLabel = row.adrSymbol ? "TSM RETURN-ADJUSTED" : "PREVIOUS 14:00 ORACLE";
      return <details key={row.symbol} className={`${styles.assetRow} ${styles.taiwanRow} ${magnitude >= 1 ? styles.highSpreadRow : magnitude >= 0.3 ? styles.mediumSpreadRow : ""}`}>
        <summary className={styles.assetSummary}>
          <span className={styles.summaryIdentity}><small>TWSE {row.code} · BITGET</small><strong>{row.name}</strong><small>{row.chineseName} · {row.symbol}</small><em>{fmt(row.book.bid)} / {fmt(row.book.ask)} USDT</em></span>
          <span className={styles.summarySignals}><span className={`${styles.perpSignal} ${tone}`}><small>{refLabel} · INDICATIVE</small><strong>{pct(comparison.deviation)}</strong><em>{comparison.direction} · {comparison.freshBook ? "fresh perp BBO" : "stale / incomplete perp quote"}{row.adrSymbol ? " · vs TSM ADR relative move" : " · vs historical index"}</em></span></span>
          <span className={styles.summaryToggle}>Details <b>⌄</b></span>
        </summary>
        <div className={styles.assetDetails}>
          <div className={styles.identity}><small>TWSE {row.code} · {row.chineseName}</small><strong>{row.name}</strong><span className={styles.cashPrice}>{row.symbol}</span><span className={styles.sessionLabel}>Bitget quote: {stamp(row.book.timestamp)} HKT</span><span className={styles.sessionLabel}>No live Taiwan cash quote used</span></div>
          <div className={styles.references}>
            <div className={`${styles.referenceCard} ${tone}`}>
              <div className={styles.referenceHead}><div><span className={styles.referenceTag}>{refLabel}</span><strong>{row.symbol} · model deviation</strong></div><span className={styles.indicativePill}>INDICATIVE ONLY</span></div>
              <div className={styles.referencePrices}><span>PERP BID / ASK<b>{fmt(row.book.bid)} / {fmt(row.book.ask)}</b><small>USDT · {stamp(row.book.timestamp)} HKT</small></span><span>{row.adrSymbol ? "TSM-ADJUSTED REFERENCE" : "FROZEN ORACLE REFERENCE"}<b>{fmt(comparison.reference)} USDT</b><small>Mid deviation {pct(comparison.deviation)}</small></span></div>
              <div className={styles.referenceEdges}><span>PERP BID / REFERENCE − 1<b>{pct(comparison.sellVsReference)}</b></span><span>REFERENCE / PERP ASK − 1<b>{pct(comparison.buyVsReference)}</b></span></div>
              <small className={styles.referenceFoot}>Historical oracle: {fmt(row.anchor?.price, 6)} USDT · {stamp(row.anchor?.timestamp)} HKT · {row.anchor?.source ?? "waiting for index history"}. Current index {fmt(row.book.index)} is shown for context only; it never replaces the anchor.</small>
            </div>
            {row.adrSymbol && <div className={`${styles.referenceCard} ${styles.adrCard}`}>
              <div className={styles.referenceHead}><div><span className={styles.referenceTag}>U.S. TSM ADR · RELATIVE RETURN</span><strong>TWTSM oracle × TSM now / TSM anchor</strong></div><span className={styles.indicativePill}>NOT A 1:1 PRICE COMPARISON</span></div>
              <div className={styles.referencePrices}><span>TSM AT / BEFORE ANCHOR<b>{fmt(tsm.anchor?.price)} USD</b><small>{stamp(tsm.anchor?.timestamp)} HKT · {tsm.anchor?.source ?? "unavailable"}</small></span><span>LATEST TSM ADR<b>{fmt(tsm.current?.price)} USD</b><small>{stamp(tsm.current?.timestamp)} HKT · {tsm.current?.source ?? "unavailable"}</small></span></div>
              <div className={styles.referenceEdges}><span>TWTSM VS FROZEN ORACLE<b>{pct(comparison.perpReturn)}</b></span><span>TSM ADR CHANGE<b>{pct(comparison.tsmReturn)}</b></span></div>
              <small className={styles.referenceFoot}>TSM uses the latest available ADR observation at or before 14:00 for its anchor; its actual timestamp is shown. Extended-hours 5m bars / retained quotes are indicative, not live BBO. TSMUSDT is not substituted.</small>
            </div>}
          </div>
          {(row.anchorError || row.adrSymbol && tsm.error) && <p className={styles.mapping}>{row.anchorError || tsm.error}</p>}
        </div>
      </details>;
    })}</div>
    <p className={styles.taiwanIntro}>Source: Bitget index history + perpetual bid/ask; TSM ADR via existing Futu/office data or Yahoo extended-hours bars. {payload?.calendarSource || "Loading Taiwan trading calendar"}. Calendar reflects published exchange holidays; unscheduled closures require confirmation. No FX or share/ADR conversion is implied by this return-based model.</p>
  </section>;
}
