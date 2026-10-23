import { koreanPerpKrw, type KoreanCloseReference, type KrwConversionRate } from "../lib/koreanPerpKrw";
import { decimalNumber } from "../lib/numberFormat";
import styles from "./KoreanKrwPanel.module.css";

type Row = {
  code: string; name: string; chineseName?: string | null; sharesPerPerp: number;
  previousClose?: KoreanCloseReference | null;
  venues: { venue: string; symbol: string; sharesPerPerp?: number; bid: number | null; ask: number | null; updatedAt: number | null }[];
};
const fmt = (value: number | null | undefined, digits = 3) => value == null ? "—" : decimalNumber(value, digits, digits);
const pct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const time = (stamp: number | null | undefined) => stamp ? `${timeFormat.format(stamp)} HKT` : "Time unavailable";
const fresh = (stamp: number | null | undefined, now: number) => Boolean(stamp && now - stamp <= 60_000 && stamp - now < 5_000);
const tone = (change: number | null) => change === null ? styles.neutral : change >= 0.5 ? styles.up : change < 0 ? styles.down : styles.neutral;

export default function KoreanKrwPanel({ rows, conversion, now }: { rows: Row[]; conversion?: KrwConversionRate; now: number }) {
  if (!rows.length) return null;
  const fxLive = Boolean(conversion?.live && fresh(conversion.updatedAt, now));
  return <section className={styles.panel} aria-labelledby="korean-krw-title">
    <header className={styles.header}>
      <div><span>KOREA · PERP → KRW</span><h3 id="korean-krw-title">Implied KRW price vs latest cash close</h3><p>Uses the latest completed regular session: today’s confirmed close after 15:30 KST / 14:30 HKT; the preceding session before then. After-hours trades never reset the close.</p></div>
      <div className={styles.fx}><small>USD/KRW · {fxLive ? "LIVE" : "REFERENCE / STALE"}</small><strong>{fmt(conversion?.rate)}</strong><small>{conversion?.source ?? "FX unavailable"}</small><small>{conversion?.date && !conversion.live ? conversion.date : time(conversion?.updatedAt)}</small></div>
    </header>
    <div className={styles.scroll} tabIndex={0} role="region" aria-label="Korean perpetual KRW conversion table">
      <table className={styles.table}>
        <thead><tr><th scope="col">Stock / contract</th><th scope="col">Perp bid / ask · USDT</th><th scope="col">Implied bid / ask · KRW</th><th scope="col">Latest cash close · KRW</th><th scope="col">Midpoint vs close</th></tr></thead>
        <tbody>{rows.flatMap((row) => row.venues.map((quote) => {
          const ref = row.previousClose;
          const calc = koreanPerpKrw(quote.bid, quote.ask, quote.sharesPerPerp ?? row.sharesPerPerp, conversion?.rate ?? null, ref?.price ?? null);
          const quoteLive = fresh(quote.updatedAt, now);
          const pending = ref?.pendingCloseDate;
          return <tr key={`${row.code}:${quote.venue}:${quote.symbol}`}>
            <th scope="row"><strong>{row.name}</strong>{row.chineseName && <small>{row.chineseName}</small>}<small>KRX {row.code} · {quote.venue}</small><small>{quote.symbol}</small></th>
            <td><strong>{fmt(quote.bid)} / {fmt(quote.ask)}</strong><small>{quoteLive ? "CURRENT PERP" : "STALE / RETAINED PERP"}</small><small>{time(quote.updatedAt)}</small></td>
            <td><strong>{fmt(calc.bidKrw, 0)} / {fmt(calc.askKrw, 0)}</strong><small>Midpoint {fmt(calc.midpointKrw, 0)}</small><small>FX {fxLive ? "live midpoint / last" : "reference / stale"} · implied, not cash</small></td>
            <td><strong>{fmt(ref?.price, 0)}</strong><small>{ref?.source ?? "Latest cash close unavailable"}</small>{ref && <small>Close date: {ref.closeDate ?? ref.sessionDate}</small>}{pending && <small className={styles.warning}>OLDER REFERENCE · awaiting {pending} regular close</small>}</td>
            <td><strong className={`${styles.change} ${tone(calc.midpointChangePct)}`}>{pct(calc.midpointChangePct)}</strong><small>Bid {pct(calc.bidChangePct)} / Ask {pct(calc.askChangePct)}</small><small>{!ref ? "Waiting for verified cash close" : pending ? "Retained close · new session pending" : !quoteLive || !fxLive ? "Indicative · stale / reference inputs" : "Indicative conversion"}</small></td>
          </tr>;
        }))}</tbody>
      </table>
    </div>
    <p className={styles.note}>KRW/share = perp USDT × USD/KRW ÷ shares per contract; change = (implied KRW ÷ latest confirmed cash close − 1) × 100%. Uses the existing contract/share mapping and 1 USDT ≈ 1 USD. FX midpoint / last or daily reference is not an executable FX quote. Missing inputs remain blank; retained closes keep their actual date, including holidays and delayed publication. This panel does not change the cash/perp signals above.</p>
  </section>;
}
