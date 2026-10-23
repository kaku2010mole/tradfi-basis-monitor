import { decimalNumber } from "../lib/numberFormat";
import { taiwanPerpTwd } from "../lib/taiwanPerpTwd";
import type { TaiwanPayload, TaiwanRow } from "../lib/taiwanStockBasis";
import styles from "./KoreanKrwPanel.module.css";

const fmt = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? "—" : decimalNumber(value, digits, digits);
const pct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const stamp = (time: number | null | undefined) => time ? `${timeFormat.format(time)} HKT` : "Time unavailable";
const tone = (value: number | null) => value === null ? styles.neutral : value >= 0.5 ? styles.up : value < 0 ? styles.down : styles.neutral;

export default function TaiwanTwdPanel({ rows, payload, now }: { rows: TaiwanRow[]; payload: TaiwanPayload | null; now: number }) {
  const fx = payload?.fx?.quote;
  return <section className={styles.panel} aria-labelledby="taiwan-twd-title">
    <header className={styles.header}>
      <div><span>TAIWAN · PERP → TWD</span><h3 id="taiwan-twd-title">Implied TWD price vs latest cash close</h3><p>Bitget bid / ask converted to NT$ per share. After the 13:30 HKT cash close, uses today’s confirmed regular-session close; before then, uses the preceding session. No oracle or ADR model.</p></div>
      <div className={styles.fx}><small>USD/TWD · INDICATIVE</small><strong>{fmt(fx?.price, 3)}</strong><small>{fx?.source ?? "FX unavailable"}</small><small>{stamp(fx?.timestamp)}</small>{payload?.fx?.error && <small>{payload.fx.error}</small>}</div>
    </header>
    <div className={styles.scroll} tabIndex={0} role="region" aria-label="Taiwan perpetual TWD conversion table">
      <table className={styles.table}>
        <thead><tr><th scope="col">Stock / contract</th><th scope="col">Perp bid / ask · USDT</th><th scope="col">Implied bid / ask · TWD</th><th scope="col">Latest cash close · TWD</th><th scope="col">Midpoint vs close</th></tr></thead>
        <tbody>{rows.map(row => {
          const cash = payload?.cash?.quotes[row.code];
          const ref = payload?.closes?.[row.code];
          const pending = Boolean(ref && payload?.latestCloseDate && ref.date < payload.latestCloseDate);
          const calc = taiwanPerpTwd(row.book, fx, ref?.price ?? null, now);
          return <tr key={row.symbol}>
            <th scope="row"><strong>{row.name}</strong><small>{row.chineseName}</small><small>TWSE {row.code} · BITGET</small><small>{row.symbol}</small></th>
            <td><strong>{fmt(row.book.bid, 3)} / {fmt(row.book.ask, 3)}</strong><small>{calc.perpFresh ? "CURRENT PERP" : "STALE / RETAINED PERP"}</small><small>{stamp(row.book.timestamp)}</small></td>
            <td><strong>{fmt(calc.bidTwd)} / {fmt(calc.askTwd)}</strong><small>Midpoint {fmt(calc.midpointTwd)}</small><small>FX {calc.fxFresh ? "current observation" : "stale / unavailable"} · implied, not cash</small></td>
            <td><strong>{fmt(ref?.price)}</strong><small>{ref?.source ?? "Latest cash close unavailable"}</small><small>{ref ? `Close date: ${ref.date}` : `Required close date: ${payload?.latestCloseDate ?? "calendar unavailable"}`}</small>{pending && <small className={styles.warning}>OLDER REFERENCE · awaiting {payload?.latestCloseDate} regular close</small>}{!ref && cash && <small className={styles.warning}>Cash snapshot: {cash.date} · not substituted</small>}{ref?.adjusted && <small className={styles.warning}>Adjusted cash reference · return is unadjusted</small>}{payload?.cash?.errors[row.code] && <small className={styles.warning}>{payload.cash.errors[row.code]}</small>}</td>
            <td><strong className={`${styles.change} ${tone(calc.midpointChangePct)}`}>{pct(calc.midpointChangePct)}</strong><small>Bid {pct(calc.bidChangePct)} / Ask {pct(calc.askChangePct)}</small><small>{!ref ? "Waiting for verified cash close" : pending ? "Retained close · new session pending" : !calc.perpFresh || !calc.fxFresh ? "Indicative · stale / reference inputs" : "Indicative conversion"}</small></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className={styles.note}>NT$/share = perp USDT × USD/TWD; change = (implied NT$ ÷ latest confirmed cash close − 1) × 100%. Assumes USDT = USD and one Taiwan share per quoted perp unit; contract multiplier is not independently verified. FX is indicative, not executable BBO. Missing closes remain blank; retained closes keep their actual date and are not relabeled as today. TWD prices use two decimals; calculations retain full precision. Green starts at +0.5%.</p>
  </section>;
}
