import { decimalNumber } from "../lib/numberFormat";
import { honHaiGdrComparison } from "../lib/honHaiGdr";
import type { HonHaiGdrFeed } from "../lib/honHaiGdr";
import type { TaiwanBook } from "../lib/taiwanStockBasis";
import styles from "./TaiwanCashCard.module.css";

const fmt = (n: number | null | undefined) => n == null ? "—" : decimalNumber(n, 3, 3);
const pct = (n: number | null) => n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const stamp = (n: number | null | undefined) => n == null ? "—" : dateFormat.format(n);

export default function HonHaiGdrCard({ book, feed, now }: { book: TaiwanBook; feed?: HonHaiGdrFeed; now: number }) {
  const quote = feed?.quote;
  const comparison = honHaiGdrComparison("HONHAIUSDT", book, quote, now)!;
  return <section className={styles.card} aria-label="Hon Hai HNHPF GDR comparison">
    <header><div><small>U.S. OTC · GDR</small><strong>HNHPF vs HONHAIUSDT</strong></div><span>{comparison.status}</span></header>
    <div className={styles.prices}>
      <div><small>Implied GDR bid / ask · USD</small><b>{fmt(comparison.impliedBid)} / {fmt(comparison.impliedAsk)}</b><span>Bitget · {stamp(book.timestamp)} HKT</span></div>
      <div><small>HNHPF bid / ask · USD</small><b>{fmt(quote?.bid)} / {fmt(quote?.ask)}</b><span>Last {fmt(quote?.last)} · {stamp(quote?.timestamp)} HKT</span></div>
    </div>
    <div className={styles.auction}>
      <span>Perp vs GDR reference<b>{pct(comparison.deviation)}</b></span>
      <span>{comparison.currentBooks ? "Indicative BBO comparison" : "Last observed reference · not a live edge"}<b>{comparison.direction}</b></span>
      {comparison.currentBooks && <><span>Buy GDR · sell perp<b>{pct(comparison.buyGdrSellPerp)}</b></span><span>Buy perp · sell GDR<b>{pct(comparison.buyPerpSellGdr)}</b></span></>}
      <small>{quote?.source ?? (feed?.refreshing ? "Loading HNHPF quote…" : "HNHPF quote unavailable")}{feed?.error ? ` · ${feed.error}` : ""}</small>
    </div>
    <footer>1 HNHPF GDR = 2 TWSE 2317 ordinary shares. Implied GDR bid / ask = HONHAIUSDT bid / ask × 2. Assumes 1 ordinary share per perp price unit (multiplier unverified) and USDT = USD. No FX conversion is needed between these USD prices. Last / stale references are indicative, not executable spreads. <a href="https://www.otcmarkets.com/stock/HNHPF/overview" target="_blank" rel="noreferrer">GDR details</a></footer>
  </section>;
}
