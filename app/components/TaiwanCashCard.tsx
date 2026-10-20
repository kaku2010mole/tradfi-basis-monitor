import { taiwanCashView } from "../lib/taiwanCash";
import type { TaiwanCashQuote } from "../lib/taiwanCash";
import styles from "./TaiwanCashCard.module.css";

const format = new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const n = (value: number | null | undefined) => value == null ? "—" : format.format(value);
const stamp = (value: number | null | undefined) => value == null ? "—" : time.format(value);
const percent = (value: number | null | undefined) => value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;

export default function TaiwanCashCard({ quote, now, error, configured, auction }: {
  quote?: TaiwanCashQuote; now: number; error?: string; configured?: boolean;
  auction: { reference: number | null; deviation: number | null; trialReturn: number | null; reason: string | null };
}) {
  const view = taiwanCashView(quote, now);
  const trialChange = quote?.trial && quote.previousClose ? (quote.trial.price / quote.previousClose - 1) * 100 : null;
  return <section className={styles.card} aria-label="Taiwan cash and trial auction">
    <header><div><small>FUGLE · TWSE CASH · TWD</small><strong>Cash &amp; trial auction</strong></div><span>{view.phase}{quote && !view.fresh ? " · STALE" : ""}</span></header>
    <div className={styles.prices}>
      <div><small>{quote?.isTrial ? "LATEST TRIAL · NOT EXECUTED" : "LAST CASH TRADE"}</small><b>NT$ {n(view.price)}</b><span>{percent(view.changePct)} vs previous close</span><small>{stamp(view.priceTimestamp)} HKT</small></div>
      <div><small>{quote?.isTrial ? "TRIAL SIZE / REFERENCE" : "LAST TRIAL · HISTORICAL"}</small><b>{quote?.isTrial ? n(quote.trial?.size) : `NT$ ${n(quote?.trial?.price)}`}</b><span>{quote?.isTrial ? "Quantity in source units" : `${percent(trialChange)} vs previous close`}</span><small>{stamp(quote?.trial?.timestamp)} HKT</small></div>
    </div>
    <div className={styles.auction}>
      <span>PRE-OPEN TRIAL-IMPLIED REFERENCE <b>{n(auction.reference)} USDT</b></span>
      <span>PERP MID VS TRIAL <b>{percent(auction.deviation)}</b></span>
      <small>{auction.reason ?? "Prior 14:00 oracle × trial price / cash previous close. TSM ADR is not compounded again. Indicative, not executable."}</small>
    </div>
    <details className={styles.book}>
      <summary>Five-level book · {quote?.bids.length ?? 0} bids / {quote?.asks.length ?? 0} asks</summary>
      <table><caption>{quote?.isTrial ? "Simulated post-match book — not firm executable quotes" : "Latest observed cash order book"}</caption><thead><tr><th>Bid qty</th><th>Bid TWD</th><th>Ask TWD</th><th>Ask qty</th></tr></thead><tbody>
        {Array.from({ length: Math.max(quote?.bids.length ?? 0, quote?.asks.length ?? 0) }, (_, i) => <tr key={i}><td>{n(quote?.bids[i]?.size)}</td><td>{n(quote?.bids[i]?.price)}</td><td>{n(quote?.asks[i]?.price)}</td><td>{n(quote?.asks[i]?.size)}</td></tr>)}
      </tbody></table>
      <small>Quantities use provider units. Book timestamp: {stamp(quote?.timestamp)} HKT.</small>
    </details>
    <footer>{error ? `${error}. Last observed data retained. ` : configured === false ? "Cash API not configured on this server. " : ""}Cash refresh: 60s · fetched {stamp(quote?.fetchedAt)} HKT.<br />Previous close NT$ {n(quote?.previousClose)} · exchange reference NT$ {n(quote?.referencePrice)}. Cash previous close and the 14:00 oracle have different anchor times; this is a return comparison, not a verified share/FX conversion.</footer>
  </section>;
}
