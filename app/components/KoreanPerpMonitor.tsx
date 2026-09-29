"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./KoreanPerpMonitor.module.css";

type VenueQuote = { venue: string; symbol: string; bid: number | null; ask: number | null; bidQty: number | null; askQty: number | null; updatedAt: number | null; buyKoreaSellPerp: number | null; buyPerpSellKorea: number | null };
type Row = { code: string; name: string; cashBidKrw: number | null; cashAskKrw: number | null; cashBidQty: number | null; cashAskQty: number | null; cashUpdatedAt: number | null; cashBidUsd: number | null; cashAskUsd: number | null; venues: VenueQuote[]; mappingNote: string | null };
type Payload = { rows?: Row[]; fx?: { bid: number | null; ask: number | null; updatedAt: number | null }; posley?: { state: string; error: string; missing: string[] }; timestamp?: number; error?: string };

const fmt = (value: number | null, digits = 2) => value === null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const time = (value: number | null) => value === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

export default function KoreanPerpMonitor() {
  const [payload, setPayload] = useState<Payload>({});
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch("/api/oracle-monitor/korean-bitget", { cache: "no-store" });
      const next = await response.json() as Payload;
      if (!response.ok) throw new Error(next.error || "Korean stock feed unavailable.");
      setPayload(next); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Feeds reconnecting."); }
    finally { inFlight.current = false; }
  }, []);
  useEffect(() => { const first = window.setTimeout(() => void load(), 0); const timer = window.setInterval(load, 2_000); return () => { clearTimeout(first); clearInterval(timer); }; }, [load]);

  return <section className={styles.monitor} aria-label="Korean stock perpetual basis">
    <header><div><p>POSLEY KRX · EXCHANGE PERPETUALS</p><h2>Korean stock cross-venue basis</h2><span>Executable BBO comparison · one perp unit per share-equivalent · USDT treated as USD</span></div><div className={styles.status}><i />{payload.timestamp ? `LIVE · ${time(payload.timestamp)}` : "CONNECTING"}</div></header>
    <div className={styles.fx}><span>USD/KRW POSLEY BBO</span><strong>{fmt(payload.fx?.bid ?? null, 2)} / {fmt(payload.fx?.ask ?? null, 2)}</strong><small>Cash bid converts at FX ask; cash ask converts at FX bid.</small></div>
    {(error || payload.posley?.error) && <p className={styles.notice}>{error || payload.posley?.error}</p>}
    <div className={styles.rows}>{payload.rows?.map((row) => <article key={row.code}>
      <div className={styles.identity}><small>KRX {row.code}</small><strong>{row.name}</strong><span>KRW {fmt(row.cashBidKrw, 0)} / {fmt(row.cashAskKrw, 0)}</span><em>≈ USD {fmt(row.cashBidUsd)} / {fmt(row.cashAskUsd)} · {time(row.cashUpdatedAt)}</em></div>
      <div className={styles.venues}>{row.venues.map((quote) => <div key={quote.venue} className={styles.venue}>
        <div><b>{quote.venue}</b><code>{quote.symbol}</code><time>{time(quote.updatedAt)}</time></div>
        <div className={styles.bbo}><span>PERP BID / ASK<strong>{fmt(quote.bid)} / {fmt(quote.ask)}</strong></span><span>SIZE<strong>{fmt(quote.bidQty)} / {fmt(quote.askQty)}</strong></span></div>
        <div className={styles.edges}><span className={(quote.buyKoreaSellPerp ?? -1) > 0 ? styles.positive : ""}>BUY KRX · SELL PERP<b>{pct(quote.buyKoreaSellPerp)}</b></span><span className={(quote.buyPerpSellKorea ?? -1) > 0 ? styles.positive : ""}>BUY PERP · SELL KRX<b>{pct(quote.buyPerpSellKorea)}</b></span></div>
      </div>)}</div>
      {row.mappingNote && <p className={styles.mapping}>{row.mappingNote}</p>}
    </article>)}</div>
    <footer>Raw executable spread before fees, funding, borrow, tax, FX execution and latency. A positive number is only a price discrepancy, not guaranteed profit.</footer>
  </section>;
}
