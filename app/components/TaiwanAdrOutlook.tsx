"use client";

import { memo, useState } from "react";
import sample from "../data/taiwanAdrStudy.json";
import { adrCohort, adrReturn, adrStudyStats, matchesAdrThreshold, matchingAdrDirection } from "../lib/taiwanAdrStudy";
import type { AdrDirection } from "../lib/taiwanAdrStudy";
import { fresh, TAIWAN_STOCKS } from "../lib/taiwanStockBasis";
import type { TsmReference } from "../lib/taiwanStockBasis";
import styles from "./TaiwanAdrOutlook.module.css";

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const stamp = (n: number | null | undefined) => n && Number.isFinite(n) ? timeFormat.format(n) : "—";
const signed = (n: number | null) => n === null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
const price = (n: number | undefined) => n && Number.isFinite(n) ? `$${n.toFixed(3)}` : "—";
const tone = (n: number | null) => n === null || n === 0 ? "" : n > 0 ? styles.positive : styles.negative;
const thresholdLabel = (direction: AdrDirection, threshold: number) => `${direction === "up" ? "ADR up" : direction === "down" ? "ADR down" : "ADR move"} ≥${threshold}%`;

// Immutable research snapshot: compute all six cohorts once, not on every 2s quote.
const COHORTS = Object.fromEntries((["up", "down", "either"] as const).map((direction) => [direction, [1, 2].map((threshold) => {
  const indices = adrCohort(sample, direction, threshold / 100);
  return { threshold, n: indices.length, frequency: indices.length / sample.dates.length * 100,
    stocks: Object.fromEntries(TAIWAN_STOCKS.map((stock) => [stock.code, adrStudyStats(sample, stock.code, indices)])) };
})])) as Record<AdrDirection, Array<{ threshold: number; n: number; frequency: number; stocks: Record<string, ReturnType<typeof adrStudyStats>> }>>;

const HistoryTable = memo(function HistoryTable({ direction }: { direction: AdrDirection }) {
  const cohorts = COHORTS[direction];
  return <div className={styles.table} role="table" aria-label="Taiwan 09:30 conditional historical returns">
    <div className={styles.tableHead} role="row">
      <div role="columnheader">TAIWAN STOCK<small>09:30 vs prior close</small></div>
      {cohorts.map((cohort) => <div key={cohort.threshold} role="columnheader">{thresholdLabel(direction, cohort.threshold)}<small>{cohort.n} historical days</small></div>)}
    </div>
    {TAIWAN_STOCKS.map((stock) => <div key={stock.code} className={styles.tableRow} role="row">
      <div role="rowheader" className={styles.stock}><strong>{stock.name}</strong><small>{stock.code} · {stock.chineseName}</small></div>
      {cohorts.map((cohort) => {
        const stats = cohort.stocks[stock.code];
        return <div key={cohort.threshold} role="cell" className={styles.result}>
          <span><small>AVG MOVE</small><strong className={tone(stats.meanPct)}>{signed(stats.meanPct)}</strong></span>
          <span title={stats.interval ? `Same-direction observations: ${stats.hits}/${stats.n}; ${stats.flat} flat days count as misses. Approximate 95% Wilson interval: ${stats.interval[0].toFixed(1)}–${stats.interval[1].toFixed(1)}%. Not trading P&L.` : "No valid observations"}><small>DIRECTION HIT</small><strong>{stats.hitPct === null ? "—" : `${stats.hitPct.toFixed(1)}%`} <em>{stats.hits}/{stats.n}</em></strong></span>
        </div>;
      })}
    </div>)}
  </div>;
});

export default function TaiwanAdrOutlook({ tsm, anchorTimestamp, now }: { tsm: TsmReference; anchorTimestamp: number | null; now: number }) {
  const [mode, setMode] = useState<"auto" | AdrDirection>("auto");
  const cutoff = tsm.cutoffTimestamp ?? null;
  // Do not rewrite the morning's locked signal when the price model resets at 14:00.
  const openingAnchor = tsm.openingAnchor === undefined ? tsm.anchor : tsm.openingAnchor;
  const openingTarget = tsm.openingAnchorTimestamp === undefined ? anchorTimestamp : tsm.openingAnchorTimestamp;
  const latestReturn = adrReturn(openingAnchor, tsm.current, openingTarget, now);
  const signalReturn = cutoff === null ? null : adrReturn(openingAnchor, tsm.preOpen, openingTarget, Math.min(now, cutoff));
  const signalDirection = matchingAdrDirection(signalReturn);
  const direction = mode === "auto" ? signalDirection ?? "up" : mode;
  const locked = cutoff !== null && now >= cutoff;
  const quoteLabel = tsm.current?.source.includes("Yahoo") ? "INDICATIVE BAR" : fresh(tsm.current?.timestamp, now) ? "LIVE QUOTE" : "LAST OBSERVED";
  return <section className={styles.outlook} aria-label="TSM ADR opening outlook">
    <div className={styles.heading}><div><span>OVERNIGHT STUDY · 09:30 HKT / TAIPEI</span><h4>TSM ADR → Taiwan opening outlook</h4><p>Historical cash returns versus the previous close. Not a buy-at-open trading win rate.</p></div><span className={styles.researchBadge}>HISTORICAL SAMPLE<br /> {sample.dates.length} common days · through {sample.asOf}</span></div>
    <div className={styles.overview}>
      <div className={styles.liveCard}>
        <div className={styles.liveLabel}><span>CURRENT TSM ADR CHANGE</span><small>{quoteLabel}</small></div>
        <strong className={`${styles.liveMove} ${tone(latestReturn)}`}>{signed(latestReturn)}</strong>
        <p>{price(tsm.current?.price)} now / {price(openingAnchor?.price)} opening-study anchor</p>
        <small>Quote: {stamp(tsm.current?.timestamp)} · HKT<br />Opening-study anchor observation: {stamp(openingAnchor?.timestamp)} · HKT</small>
        <div className={styles.signal}><span>{locked ? "09:00 INPUT · LOCKED" : "PRE-OPEN INPUT · UPDATING"}<small>Session cutoff: {stamp(cutoff)} HKT</small></span><b className={tone(signalReturn)}>{signed(signalReturn)}</b></div>
        {tsm.error && <small className={styles.warning}>Feed warning: retained observations are indicative. {tsm.error}</small>}
      </div>
      <div className={styles.conditions}>
        <div className={styles.controls} role="group" aria-label="ADR historical direction">
          {([ ["auto", "Follow ADR"], ["up", "Up"], ["down", "Down"], ["either", "Either"] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}
        </div>
        <p className={styles.selectionNote}>{mode === "auto" ? signalDirection ? `Following the ${locked ? "locked" : "latest pre-open"} ADR ${signalDirection} signal.` : "No directional input available · showing historical ADR-up cases." : "Manual historical view · this does not change the current ADR input."}</p>
        <div className={styles.thresholds}>{COHORTS[direction].map((cohort) => {
          const matched = matchesAdrThreshold(signalReturn, direction, cohort.threshold);
          return <div key={cohort.threshold} className={`${styles.threshold} ${matched ? styles.matched : ""}`}>
            <div><strong>{thresholdLabel(direction, cohort.threshold)}</strong><span>{matched ? "MATCHES INPUT" : signalReturn === null ? "INPUT UNAVAILABLE" : "NOT TRIGGERED"}</span></div>
            <p>{cohort.frequency.toFixed(1)}% <small>historical occurrence</small></p>
            <small>{cohort.n} / {sample.dates.length} sample days · {cohort.n < 30 ? "small sample" : "limited sample"}</small>
          </div>;
        })}</div>
        <small className={styles.helper}>Occurrence = frequency within the historical sample, not a probability that today will reach the threshold. The ≥2% sample is included in ≥1%.</small>
      </div>
    </div>
    <HistoryTable direction={direction} />
    <details className={styles.method}><summary>Method, sample dates &amp; interpretation</summary><div>
      <p><b>{sample.start} – {sample.asOf}</b> · {sample.dates.length} matched trading dates across all eight stocks. This is a dated research snapshot, not an automatically rolling backtest.</p>
      <p><b>Average move:</b> mean of all qualifying 09:30 cash returns versus the previous daily close, including losing and flat days. The 09:00–09:30 bar close approximates the 09:30 price.</p>
      <p><b>Direction hit:</b> ADR up and stock above prior close, or ADR down and stock below prior close. Flat stock returns are misses. This is not the return from buying at 09:00. Small samples and 100% hit rates do not establish a reliable future probability.</p>
      <p><b>ADR input:</b> last available observation before 09:00 divided by the last observation at or before the prior Taiwan trading date at 14:00. The input is frozen at 09:00; the separate current ADR quote may continue changing. Unavailable quotes are never treated as zero.</p>
      <p>History: Yahoo Finance extended-hours ADR and Taiwan cash bars; reported corporate-action dates and inconsistent bars excluded. No separate FX control or transaction-cost adjustment. Hourly ADR bars were used in the historical study; current references use available Futu quotes or 5-minute Yahoo bars.</p>
    </div></details>
  </section>;
}
