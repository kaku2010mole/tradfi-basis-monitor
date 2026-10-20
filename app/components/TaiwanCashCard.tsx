import { taiwanCashView } from "../lib/taiwanCash";
import type { TaiwanCashQuote } from "../lib/taiwanCash";
import type { TaiwanBook } from "../lib/taiwanStockBasis";
import type { TaiwanFx, taiwanLiveComparison } from "../lib/taiwanLiveBasis";
import styles from "./TaiwanCashCard.module.css";

const format = new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const n = (value: number | null | undefined) => value == null ? "—" : format.format(value);
const stamp = (value: number | null | undefined) => value == null ? "—" : time.format(value);
const percent = (value: number | null | undefined) => value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;

export default function TaiwanCashCard({ quote, now, error, configured, comparison, book, fx }: {
  quote?: TaiwanCashQuote; now: number; error?: string; configured?: boolean;
  comparison: ReturnType<typeof taiwanLiveComparison>; book: TaiwanBook; fx?: TaiwanFx | null;
}) {
  const view = taiwanCashView(quote, now);
  return <section className={styles.card} aria-label="Taiwan cash and trial auction">
    <header><div><small>LIVE / PRE-OPEN · DIRECT PRICE COMPARISON</small><strong>Cash / trial vs Bitget</strong></div><span>{comparison.status}</span></header>
    <div className={styles.prices}>
      <div><small>{comparison.kind}{comparison.isTrial ? " · NOT EXECUTED" : ""}</small><b>NT$ {n(comparison.cashPrice)}</b><span>{n(comparison.reference)} USDT equivalent</span><small>{stamp(comparison.cashTimestamp)} HKT · {view.phase}</small></div>
      <div><small>BITGET PERP MID</small><b>{n(comparison.perpMid)} USDT</b><span>NT$ {n(comparison.perpTwd)} equivalent</span><small>Bid / ask {n(book.bid)} / {n(book.ask)} · {stamp(book.timestamp)} HKT</small></div>
    </div>
    <div className={styles.auction}>
      <span>PERP VS {comparison.isTrial ? "TRIAL" : "CASH"}<b>{percent(comparison.deviation)}</b></span>
      <span>RELATIVE PRICING<b>{comparison.direction}</b></span>
      <small>{comparison.reason ?? "Perp midpoint × USD/TWD ÷ cash reference − 1. Indicative only; excludes fees, funding and FX spread."}</small>
    </div>
    {!comparison.isTrial && <div className={styles.prices}>
      <div><small>BUY CASH · SELL PERP</small><b>{percent(comparison.buyCashSellPerp)}</b><small>Perp bid × FX / cash ask − 1</small></div>
      <div><small>BUY PERP · SELL CASH</small><b>{percent(comparison.buyPerpSellCash)}</b><small>Cash bid / (perp ask × FX) − 1</small></div>
    </div>}
    <p className={styles.note}>{comparison.isTrial ? "Trial price is not a firm fill. Directional executable edges are not shown during auction." : `Cash BBO NT$ ${n(comparison.cashBid)} / ${n(comparison.cashAsk)} · Last trade NT$ ${n(quote?.last?.price)} (${stamp(quote?.last?.timestamp)} HKT).`}</p>
    <details className={styles.book}>
      <summary>Five-level book · {quote?.bids.length ?? 0} bids / {quote?.asks.length ?? 0} asks</summary>
      <table><caption>{quote?.isTrial ? "Simulated post-match book — not firm executable quotes" : "Latest observed cash order book"}</caption><thead><tr><th>Bid qty</th><th>Bid TWD</th><th>Ask TWD</th><th>Ask qty</th></tr></thead><tbody>
        {Array.from({ length: Math.max(quote?.bids.length ?? 0, quote?.asks.length ?? 0) }, (_, i) => <tr key={i}><td>{n(quote?.bids[i]?.size)}</td><td>{n(quote?.bids[i]?.price)}</td><td>{n(quote?.asks[i]?.price)}</td><td>{n(quote?.asks[i]?.size)}</td></tr>)}
      </tbody></table>
      <small>Quantities use provider units. Book timestamp: {stamp(quote?.timestamp)} HKT.</small>
    </details>
    <footer>{error ? `${error}. Last observed data retained. ` : configured === false ? "Cash API not configured on this server. " : ""}Cash refresh: 60s · fetched {stamp(quote?.fetchedAt)} HKT.<br />USD/TWD {n(fx?.price)} · {stamp(fx?.timestamp)} HKT · indicative FX, not executable BBO. Display assumes USDT = USD and one Taiwan share per perp price unit (contract multiplier not independently verified). No oracle / ADR adjustment is used in this tab.</footer>
  </section>;
}
