"use client";
import { useEffect, useState } from "react";
import PageSwitcher from "./PageSwitcher";
import { visiblePolling } from "../lib/visiblePolling";
import { QUOTE_MAX_AGE } from "../lib/japanEstimate";
import { japanBrowserToken, connectJapanFeed } from "../lib/posleyBrowserSession";
import type { JapanEstimatePayload } from "../lib/japanEstimateMarket";
import styles from "./JapanEstimateDashboard.module.css";

const number = (v: number | null | undefined, digits = 2) => v !== null && v !== undefined && Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
const pct = (v: number | null | undefined) => v !== null && v !== undefined ? `${v >= 0 ? "+" : ""}${number(v)}%` : "—";
const stamp = (v: number | null | undefined) => v ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(v) + " HKT" : "No quote";
export default function JapanEstimateDashboard() {
  const [data, setData] = useState<JapanEstimatePayload | null>(null), [error, setError] = useState(""), [clock, setClock] = useState(0), [busyLogin, setBusyLogin] = useState(false);
  useEffect(() => {
    let alive = true, busy = false;
    const controller = new AbortController();
    const stop = visiblePolling(async () => {
      setClock(Date.now()); if (busy) return; busy = true;
      try {
        const token = await japanBrowserToken().catch(() => null);
        if (!alive) return;
        const response = await fetch("/api/japan-estimate", { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error(response.status === 401 ? "Session expired. Reload this page and sign in again." : "Data temporarily unavailable. The last estimate and original quote time are retained.");
        const next = await response.json() as JapanEstimatePayload;
        if (alive) { setData(next); setError(""); setClock(Date.now()); }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "Market data temporarily unavailable"); }
      finally { busy = false; }
    }, 2000);
    return () => { alive = false; stop(); controller.abort(); };
  }, []);
  const fresh = (t: number | null | undefined) => Boolean(t && clock - t <= QUOTE_MAX_AGE && t <= clock + 5000 && data && clock - data.timestamp <= 15_000);
  const liveK = fresh(data?.kioxia.quote?.timestamp) && !data?.kioxia.quote?.delayMinutes, liveFx = fresh(data?.fx.quote?.timestamp);
  const delayedK = Boolean(data?.kioxia.quote?.delayMinutes && clock - data.kioxia.quote.timestamp <= 35 * 60_000 && clock - data.timestamp <= 15_000);
  const status = !data ? "Connecting" : !data.anchorReady ? "Awaiting closing anchors" : liveK ? "Live cash input" : delayedK ? "Delayed cash estimate" : data.kioxia.quote ? "Estimate frozen" : "Awaiting post-close cash quote";
  const connect = async () => { setBusyLogin(true); try { await connectJapanFeed(); } catch (e) { setError(e instanceof Error ? e.message : "Connection failed"); setBusyLogin(false); } };
  return <main className={styles.page}>
    <header className={styles.topbar}><a href="/stock-basis" className={styles.brand}><b>↗</b><span>TRADFI MONITOR<small>JAPAN · CASH ESTIMATES</small></span></a><div className={styles.actions}><span className={liveK ? styles.live : styles.paused}><i />{status}</span><PageSwitcher active="japan-estimate" /></div></header>
    <div className={styles.content}>
      <section className={styles.heading}><div><p className={styles.eyebrow}>JAPAN CASH MARKET · KIOXIA REFERENCE</p><h1>Japanese stock estimates</h1><p>Anchored to each day’s cash close and updated with Kioxia stock quotes. The latest trading-day close carries over the weekend.</p></div><a className={styles.back} href="/stock-basis?market=TSE">Cash / perpetual monitor ↗</a></section>
      {error && <div className={styles.notice} role="status">{error}</div>}
      <section className={styles.summary} aria-label="Estimate inputs and anchors">
        <article className={styles.anchor}><span>COMMON CLOSE ANCHOR</span><strong>{data?.anchorDate ?? "Checking calendar…"}</strong><p>15:30 JST · 14:30 HKT</p><small>{data?.anchorReady ? "All cash closing prices confirmed" : data ? "Estimates pause where the new close is missing" : "Loading cash closing prices"}</small></article>
        <article><span>KIOXIA 285A · CASH STOCK</span><strong>¥{number(data?.kioxia.price, 0)} <em className={styles.move}>{pct(data?.kioxia.changePct)}</em></strong><p>Close anchor ¥{number(data?.kioxia.anchor, 0)} · {data?.kioxia.quote ? data.kioxia.quote.kind === "mid" ? "Bid/ask midpoint" : "Last trade" : "Closing reference"}</p><small>{stamp(data?.kioxia.quote?.timestamp)}<br />{data?.kioxia.quote?.source ?? "Awaiting a post-close Kioxia stock quote"}</small></article>
        <article><span>USD / JPY · SPOT FX</span><strong>{number(data?.fx.quote?.price, 4)} <em className={liveFx ? styles.tagLive : styles.tag}>{liveFx ? "Updating" : "Reference / waiting"}</em></strong><p>JPY estimate ÷ USD/JPY = USD estimate</p><small>{stamp(data?.fx.quote?.timestamp)}<br />{data?.fx.quote?.source ?? "Awaiting spot FX quote"}</small></article>
      </section>
      <div className={styles.explanation}><span>Close-based estimate · overnight unvalidated</span><p>The model uses cash-stock returns. Bitget quotes are for comparison only. Positive deviation means the contract is above the estimate.</p></div>
      <section className={styles.tableCard} aria-label="Stock price estimates">
        <div className={styles.tableHeading}><h2>11 Japanese stocks</h2><span>{liveK ? "Refreshes every 2 seconds while visible" : "Last estimate and original quote time retained"}</span></div>
        <div className={styles.tableWrap}><table><thead><tr><th>Stock / status</th><th>Close anchor<br /><small>JPY</small></th><th>Estimated price<br /><small>JPY / USD</small></th><th>Vs close</th><th>β / correlation</th><th>Historical daily error<br /><small>Walk-forward MAE</small></th><th>Bitget bid / ask<br /><small>USDT</small></th><th>Contract vs estimate<br /><small>Midpoint deviation</small></th></tr></thead><tbody>
          {data?.rows.map(row => {
            const comparable = liveK && liveFx && row.contract?.timestamp && clock - row.contract.timestamp <= 30_000;
            const deviation = comparable ? row.deviationPct : null;
            const rowStatus = row.status === "Cash-driven estimate" && !liveK || row.status === "Delayed cash estimate" && !delayedK ? "Estimate frozen" : row.status;
            return <tr key={row.code}><td><a href={`https://finance.yahoo.com/quote/${row.code}.T/`} target="_blank" rel="noreferrer"><b>{row.name}</b><small>TSE {row.code}</small></a><span className={styles.rowStatus}>{rowStatus}{row.weak ? " · Weak relationship" : ""}</span></td><td>{number(row.close, 0)}</td><td className={styles.estimate}><b>¥{number(row.yen, 1)}</b><small>${number(row.usd, 3)}{row.usd !== null && !liveFx ? " · Reference FX" : ""}</small></td><td className={(row.changePct ?? 0) < 0 ? styles.down : styles.up}>{pct(row.changePct)}</td><td><b>{number(row.model?.beta, 3)}</b><small>r {number(row.model?.correlation, 3)}</small></td><td>{number(row.model?.maePct)}<small>pp · {row.model?.testN ?? 0} days<br />{row.model?.improvementPct !== null && row.model?.improvementPct !== undefined ? `Improvement ${number(row.model.improvementPct, 0)}%` : ""}</small></td><td>{number(row.contract?.bid, 3)} / {number(row.contract?.ask, 3)}<small>{row.symbol}<br />{stamp(row.contract?.timestamp)}</small></td><td><b className={deviation !== null && deviation < 0 ? styles.down : deviation !== null ? styles.up : ""}>{pct(deviation)}</b><small>{deviation === null ? "Awaiting valid quotes" : "1-share basis · reference only"}</small></td></tr>;
          }) ?? <tr><td colSpan={8} className={styles.loading}>Loading cash closing anchors, stock models and quotes…</td></tr>}
        </tbody></table></div>
        <p className={styles.tableNote}>USD estimates are per ordinary share. Contract comparisons assume one share per quoted unit and 1 USDT ≈ 1 USD; contract multipliers have not been independently verified. Deviation is a model comparison. Stale inputs suppress it.</p>
      </section>
      <details className={styles.method}><summary>Methodology, historical validation and update rules</summary><div>
        <p><b>Estimate:</b> Stock close × (Kioxia current price / Kioxia same-day close)<sup>β</sup>. Resets to each stock’s cash closing price every trading day, without an intercept or cumulative drift. Divide the JPY estimate by the spot USD/JPY rate for USD.</p>
        <p><b>Calibration:</b> Beta is fitted through the origin using the latest 126 valid sessions of cash-stock close-to-close log returns. The correlation r is Pearson’s coefficient over the same window. Calibration through {data?.anchorDate ?? "—"}. Historical closes are split-adjusted; returns exclude dividend adjustments.</p>
        <p><b>Error:</b> Walk-forward validation over the latest 60 sessions, fitting each day with at most 126 earlier sessions. MAE is the mean absolute difference between estimated and actual daily returns in percentage points. Improvement is relative to always predicting an unchanged stock price. These daily cash-return errors are not overnight or weekend confidence intervals. A weak relationship means |r| &lt; 0.4 or no improvement in historical error.</p>
        <p><b>Anchors:</b> Uses the <a href="https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html" target="_blank" rel="noreferrer">JPX 2026–2027 trading calendar</a>. Anchors switch at 15:30 JST each trading day. Stocks with unpublished closes pause. The prior close carries over weekends, holidays and the next session until its close. Yahoo closing data may be delayed; split days wait for a new anchor.</p>
        <p><b>Cash inputs:</b> Posley Kioxia stock and USD/JPY FX quotes take priority. Kioxia can also use <a href="https://kabutan.jp/stock/?code=285A" target="_blank" rel="noreferrer">Japannext PTS cash trades</a>. Public Kabutan quotes have a <a href="https://support.kabutan.jp/hc/ja/articles/36411519620889-PTS%E6%A0%AA%E4%BE%A1%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6" target="_blank" rel="noreferrer">15-minute delay</a>, are explicitly marked and do not enable live deviation. Yahoo USD/JPY spot references can supplement missing FX. Original market timestamps are retained. Live inputs freeze after 90 seconds; delayed inputs freeze after 35 minutes. Missing cash quotes leave the closing reference. Contract prices never replace cash inputs. Historical source: <a href="https://finance.yahoo.com/quote/285A.T/history/" target="_blank" rel="noreferrer">Yahoo Finance · TSE equities</a>.</p>
        {data?.rows.some(r => r.historyError) && <p className={styles.warning}>Some cash histories failed to refresh. Dated caches are retained; missing new-session closes pause the affected estimates.</p>}
      </div></details>
      <footer className={styles.footer}><span>All quote times in HKT · JPY estimates use cash-market inputs</span><button onClick={() => void connect()} disabled={busyLogin}>{busyLogin ? "Connecting…" : "Connect Posley cash feed"}</button><span>Updated {stamp(data?.timestamp)}</span></footer>
    </div>
  </main>;
}
