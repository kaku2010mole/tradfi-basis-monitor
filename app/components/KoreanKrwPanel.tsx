import { koreanDate, koreanPerpKrw, type KoreanCloseReference, type KrwConversionRate } from "../lib/koreanPerpKrw";
import styles from "./KoreanKrwPanel.module.css";

type Row = {
  code: string; name: string; chineseName?: string | null; sharesPerPerp: number;
  previousClose?: KoreanCloseReference | null;
  venues: { venue: string; symbol: string; sharesPerPerp?: number; bid: number | null; ask: number | null; updatedAt: number | null }[];
};
const fmt = (value: number | null | undefined, digits = 3) => value == null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const time = (stamp: number | null | undefined) => stamp ? `${timeFormat.format(stamp)} HKT` : "Time unavailable";
const fresh = (stamp: number | null | undefined, now: number) => Boolean(stamp && now - stamp <= 60_000 && stamp - now < 5_000);
const tone = (change: number | null) => change === null || change === 0 ? styles.neutral : change > 0 ? styles.up : styles.down;

export default function KoreanKrwPanel({ rows, conversion, now }: { rows: Row[]; conversion?: KrwConversionRate; now: number }) {
  if (!rows.length) return null;
  const fxLive = Boolean(conversion?.live && fresh(conversion.updatedAt, now));
  return <section className={styles.panel} aria-labelledby="korean-krw-title">
    <header className={styles.header}>
      <div><span>KOREA · PERP → KRW</span><h3 id="korean-krw-title">Implied KRW price vs previous close</h3><p>Perpetual bid / ask converted per ordinary share. Change is against the Korean cash stock’s previous trading-session close.</p></div>
      <div className={styles.fx}><small>USD/KRW · {fxLive ? "LIVE" : "REFERENCE / STALE"}</small><strong>{fmt(conversion?.rate)}</strong><small>{conversion?.source ?? "FX unavailable"}</small><small>{conversion?.date && !conversion.live ? conversion.date : time(conversion?.updatedAt)}</small></div>
    </header>
    <div className={styles.scroll} tabIndex={0} role="region" aria-label="Korean perpetual KRW conversion table">
      <table className={styles.table}>
        <thead><tr><th scope="col">Stock / contract</th><th scope="col">Perp bid / ask · USDT</th><th scope="col">Implied bid / ask · KRW</th><th scope="col">Previous cash close · KRW</th><th scope="col">Midpoint vs close</th></tr></thead>
        <tbody>{rows.flatMap((row) => row.venues.map((quote) => {
          const ref = row.previousClose;
          const calc = koreanPerpKrw(quote.bid, quote.ask, quote.sharesPerPerp ?? row.sharesPerPerp, conversion?.rate ?? null, ref?.price ?? null);
          const quoteLive = fresh(quote.updatedAt, now);
          const olderReference = Boolean(ref && ref.sessionDate !== koreanDate(now));
          return <tr key={`${row.code}:${quote.venue}:${quote.symbol}`}>
            <th scope="row"><strong>{row.name}</strong>{row.chineseName && <small>{row.chineseName}</small>}<small>KRX {row.code} · {quote.venue}</small><small>{quote.symbol}</small></th>
            <td><strong>{fmt(quote.bid)} / {fmt(quote.ask)}</strong><small>{quoteLive ? "CURRENT PERP" : "STALE / RETAINED PERP"}</small><small>{time(quote.updatedAt)}</small></td>
            <td><strong>{fmt(calc.bidKrw)} / {fmt(calc.askKrw)}</strong><small>Midpoint {fmt(calc.midpointKrw)}</small><small>FX {fxLive ? "live midpoint / last" : "reference / stale"} · implied, not cash</small></td>
            <td><strong>{fmt(ref?.price)}</strong><small>{ref?.source ?? "Previous close unavailable"}</small>{ref && <small className={olderReference ? styles.warning : undefined}>{olderReference ? "OLDER REFERENCE · " : ""}For {ref.sessionDate} session</small>}</td>
            <td><strong className={`${styles.change} ${tone(calc.midpointChangePct)}`}>{pct(calc.midpointChangePct)}</strong><small>Bid {pct(calc.bidChangePct)} / Ask {pct(calc.askChangePct)}</small><small>{!ref ? "Waiting for cash previous close" : olderReference ? "Retained session reference" : !quoteLive || !fxLive ? "Indicative · stale / reference inputs" : "Indicative conversion"}</small></td>
          </tr>;
        }))}</tbody>
      </table>
    </div>
    <p className={styles.note}>KRW/share = perp USDT × USD/KRW ÷ shares per contract; change = (implied KRW ÷ previous cash close − 1) × 100%. Uses the existing contract/share mapping and 1 USDT ≈ 1 USD. FX midpoint / last or daily reference is not an executable FX quote. Missing inputs remain blank; older references stay dated. This panel does not change the cash/perp signals above.</p>
  </section>;
}
