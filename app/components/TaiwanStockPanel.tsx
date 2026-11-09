"use client";

import { memo, useEffect, useState } from "react";
import { visiblePolling } from "../lib/visiblePolling";
import { decimalNumber } from "../lib/numberFormat";
import { TAIWAN_ADR_PAIRS, TAIWAN_STOCKS, taiwanAdrPremium, taiwanUmcAdrPremium } from "../lib/taiwanStockBasis";
import type { ReferencePrice, TaiwanBook, TaiwanPayload, TaiwanRow } from "../lib/taiwanStockBasis";
import TaiwanAdrOutlook from "./TaiwanAdrOutlook";
import TaiwanCashCard from "./TaiwanCashCard";
import TaiwanTwdPanel from "./TaiwanTwdPanel";
import HonHaiGdrCard from "./HonHaiGdrCard";
import { honHaiGdrComparison } from "../lib/honHaiGdr";
import { taiwanLiveComparison } from "../lib/taiwanLiveBasis";
import { mergeTaiwanFeed } from "../lib/taiwanFeedState";
import styles from "./KoreanPerpMonitor.module.css";
import tabs from "./TaiwanStockPanel.module.css";

const fmt = (n: number | null | undefined, digits = 3) => n == null || !Number.isFinite(n) ? "—" : decimalNumber(n, digits, digits);
const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
const stampFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const stamp = (n: number | null | undefined) => n == null ? "—" : stampFormat.format(n);
const emptyRows: TaiwanRow[] = TAIWAN_STOCKS.map((stock) => ({ ...stock, adrSymbol: "adrSymbol" in stock ? stock.adrSymbol : null, anchor: null, anchorError: null, book: { bid: null, ask: null, last: null, index: null, timestamp: null } }));

const adrStampFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const adrStatusLabel = {
  live: "Live BBO",
  "missing-adr": "ADR leg unavailable",
  waiting: "Waiting for quotes",
  stale: "Stale quotes",
  unsynced: "Quotes out of sync",
};

function AdrQuoteTime({ timestamp }: { timestamp?: number | null }) {
  const observedAt = timestamp ? new Date(timestamp) : null;
  return observedAt && Number.isFinite(observedAt.getTime())
    ? <time dateTime={observedAt.toISOString()}>{adrStampFormat.format(observedAt)} HKT</time>
    : <small>Quote time unavailable</small>;
}

function AdrPerpQuote({ symbol, book }: { symbol: string; book?: TaiwanBook | null }) {
  return <div className={tabs.adrQuote}>
    <dt>{symbol}</dt>
    <dd><strong>{book?.bid == null && book?.ask == null ? "—" : `${fmt(book.bid)} / ${fmt(book.ask)}`}</strong>
      <AdrQuoteTime timestamp={book?.timestamp} />
    </dd>
  </div>;
}

function UmcAdrReferenceQuote({ reference }: { reference?: ReferencePrice | null }) {
  return <div className={tabs.adrQuote}>
    <dt>UMC ADR overnight</dt>
    <dd><strong>{reference ? `${fmt(reference.price)} USD` : "—"}</strong>
      <small>{reference?.source ?? "Yahoo Finance · Blue Ocean ATS overnight"}</small>
      <AdrQuoteTime timestamp={reference?.timestamp} />
    </dd>
  </div>;
}

function TaiwanAdrPerpPanel({ payload, now }: { payload: TaiwanPayload | null; now: number }) {
  return <section className={tabs.adrPanel} aria-labelledby="taiwan-perp-adr-title">
    <header className={tabs.adrHeader}>
      <div><span>BITGET · ADR COMPARISON</span><h4 id="taiwan-perp-adr-title">ADR premiums</h4></div>
      <p>Premium relative to the Taiwan perpetual after applying the ADR share ratio.</p>
    </header>
    <div className={tabs.adrCards}>
      {TAIWAN_ADR_PAIRS.map((pair) => {
        const usesYahoo = pair.symbol === "UMCUSDT";
        const adr = usesYahoo ? null : payload?.adrPerpBooks?.[pair.symbol];
        const row = (payload?.rows ?? emptyRows).find((item) => item.symbol === pair.taiwanSymbol);
        const local = row?.book;
        const { status, midpoint, index, buyAdr, sellAdr } = taiwanAdrPremium(pair, adr, local, now);
        const reference = usesYahoo ? payload?.umcAdrReference : null;
        const indicative = reference ? taiwanUmcAdrPremium(reference, local, now) : null;
        return <article className={tabs.adrCard} key={pair.symbol}>
          <header className={tabs.adrCardHeader}>
            <div><h5>{pair.name}</h5><small>TWSE {pair.code} · 1 ADR = {pair.ratio} shares</small></div>
            <span className={tabs.adrStatus} data-state={reference ? "reference" : status}>
              {usesYahoo ? (reference ? "Overnight trade · indicative/delayed" : "Yahoo overnight quote unavailable") : adrStatusLabel[status]}
            </span>
          </header>
          <dl className={tabs.adrMetrics}>
            <div><dt>{usesYahoo ? "Reference premium" : "Midpoint premium"}</dt><dd>{pct(usesYahoo ? indicative?.premium : midpoint)}</dd></div>
            <div><dt>Index premium</dt><dd>{pct(index)}</dd></div>
            <div><dt>Buy ADR / sell TW</dt><dd>{pct(buyAdr)}</dd></div>
            <div><dt>Sell ADR / buy TW</dt><dd>{pct(sellAdr)}</dd></div>
          </dl>
          <span className={tabs.adrQuoteLabel}>{usesYahoo ? "ADR OVERNIGHT · BITGET BID / ASK (USDT)" : "BID / ASK · USDT"}</span>
          <dl className={tabs.adrQuotes}>
            {usesYahoo ? <UmcAdrReferenceQuote reference={reference} /> : <AdrPerpQuote symbol={pair.symbol} book={adr} />}
            <AdrPerpQuote symbol={pair.taiwanSymbol} book={local} />
          </dl>
          {reference && <p className={tabs.adrNote}>Reference premium assumes USD ≈ USDT.</p>}
        </article>;
      })}
    </div>
    <p className={tabs.adrNote}>Bitget directional premiums use fresh, synchronized bids and asks before fees or depth.</p>
  </section>;
}

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
    const load = async (resumed: boolean) => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 20_000);
      try {
        // Normal views skip model/index/ADR history. The optional historical
        // study reuses this poll, never a second request loop.
        const endpoint = studyOpen ? "/api/stock-basis/taiwan?view=full" : "/api/stock-basis/taiwan?view=prices";
        const response = await fetch(`${endpoint}${resumed ? "&refresh=resume" : ""}`, { cache: "no-store", signal: controller.signal });
        const next = await response.json() as TaiwanPayload;
        if (!response.ok || !Array.isArray(next.rows)) throw new Error(next.error || "Taiwan feed unavailable");
        if (!stopped) {
          setPayload(prior => mergeTaiwanFeed(prior, next));
          setClock(Date.now());
          setError(next.error || "");
        }
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : "Taiwan feed reconnecting"); }
      finally { clearTimeout(timeout); inFlight = false; }
    };
    const stopPolling = visiblePolling(resumed => { setClock(Date.now()); void load(resumed); }, 2_000);
    return () => { stopped = true; stopPolling(); controller?.abort(); };
  }, [visible, studyOpen]);

  return <section hidden={!visible} className={`${styles.marketGroup} ${styles.taiwanGroup}`} aria-label="Taiwan stock reference basis">
    <div className={styles.groupHead}><div><span>03 / TAIWAN · BITGET + CASH</span><h3>Taiwan price comparison</h3></div><small>{TAIWAN_STOCKS.length} names · perp 2s / cash 60s</small></div>
    <TaiwanAdrPerpPanel payload={payload} now={clock} />
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
      const refreshing = !live.currentCash && payload?.cash?.refreshing ? "Refreshing cash quote…"
        : !live.currentFx && payload?.fx?.refreshing ? "Refreshing USD/TWD…" : null;
      const magnitude = Math.abs(live.deviation ?? 0);
      const tone = magnitude >= 1 ? styles.spreadHigh : magnitude >= 0.5 ? styles.spreadMedium : styles.spreadQuiet;
      const gdr = honHaiGdrComparison(row.symbol, row.book, payload?.honHaiGdr?.quote, clock);
      const gdrMagnitude = gdr?.currentBooks ? Math.abs(gdr.deviation ?? 0) : 0;
      const gdrTone = gdrMagnitude >= 1 ? styles.spreadHigh : gdrMagnitude >= 0.5 ? styles.spreadMedium : styles.spreadQuiet;
      return <details key={`${mode}:${row.symbol}`} className={`${styles.assetRow} ${styles.taiwanRow} ${magnitude >= 1 ? styles.highSpreadRow : magnitude >= 0.5 ? styles.mediumSpreadRow : ""}`}>
        <summary className={styles.assetSummary}>
          <span className={styles.summaryIdentity}><small>TWSE {row.code} · BITGET</small><strong>{row.name}</strong><small>{row.chineseName} · {row.symbol}</small><em>{fmt(row.book.bid)} / {fmt(row.book.ask)} USDT</em></span>
          <span className={styles.summarySignals}><span className={`${styles.perpSignal} ${tone}`}><small>PERP VS {live.kind} · INDICATIVE</small><strong>{pct(live.deviation)}</strong><em>{refreshing ?? live.direction} · {live.isTrial ? "Trial" : "Cash"} NT$ {fmt(live.cashPrice)} · {stamp(live.cashTimestamp)} HKT{live.reason && !refreshing ? ` · ${live.reason}` : ""}</em></span>
            {gdr && <span className={`${styles.adrSignal} ${gdrTone}`}><small>HNHPF · GDR · {gdr.status}</small><strong>{pct(gdr.deviation)}</strong><em>Implied bid / ask {fmt(gdr.impliedBid)} / {fmt(gdr.impliedAsk)} USD</em><em>{gdr.direction} · Reference {fmt(gdr.reference)} · {stamp(payload?.honHaiGdr?.quote?.timestamp)} HKT</em></span>}
          </span>
          <span className={styles.summaryToggle}>Details <b>⌄</b></span>
        </summary>
        <div className={styles.assetDetails}>
          <div className={styles.identity}><small>TWSE {row.code} · {row.chineseName}</small><strong>{row.name}</strong><span className={styles.cashPrice}>{row.symbol}</span><span className={styles.sessionLabel}>Bitget quote: {stamp(row.book.timestamp)} HKT</span><span className={styles.sessionLabel}>LIVE / PRE-OPEN COMPARISON</span></div>
          <div className={styles.references}><TaiwanCashCard quote={cash} now={clock} error={payload?.cash?.errors[row.code]} configured={payload?.cash?.configured} comparison={live} book={row.book} fx={payload?.fx?.quote} />{gdr && <HonHaiGdrCard book={row.book} feed={payload?.honHaiGdr} now={clock} />}</div>
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
