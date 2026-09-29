"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type Exchange = "Binance" | "Bitget";
type DividendEvent = { id: string; exchange: Exchange; contract: string; underlying: string; company: string; exDate: string; paymentDate: string | null; amount: number; currency: string; markPrice: number | null; percent: number | null; status: "announced" | "calendar"; eligible: boolean; sourceUrl: string; sourceLabel: string };
type Payload = { month: string; generatedAt: number; scannedContracts: number; equityContracts: number; coveredContracts: number; exchangeCounts: Record<Exchange, { scanned: number; candidates: number }>; events: DividendEvent[] };

const fmt = (value: number | null, digits = 2) => value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const monthLabel = (month: string) => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
const moveMonth = (month: string, delta: number) => { const date = new Date(`${month}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + delta); return date.toISOString().slice(0, 7); };

export default function DividendCalendarPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [exchange, setExchange] = useState<"All" | Exchange>("All");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const response = await fetch(`/api/dividend-calendar?month=${month}`, { cache: "no-store" }); const next = await response.json(); if (!response.ok) throw new Error(next.error || "Dividend calendar unavailable"); setPayload(next); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Dividend calendar unavailable"); }
    finally { setLoading(false); }
  }, [month]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const firstWeekday = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const dayCount = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const byDay = useMemo(() => new Map(Array.from({ length: dayCount }, (_, index) => [index + 1, (payload?.events ?? []).filter((event) => Number(event.exDate.slice(8, 10)) === index + 1)])), [dayCount, payload]);
  const filtered = (payload?.events ?? []).filter((event) => (exchange === "All" || event.exchange === exchange) && `${event.exchange} ${event.contract} ${event.company}`.toLowerCase().includes(query.trim().toLowerCase()));
  const highest = Math.max(0, ...(payload?.events ?? []).map((event) => event.percent ?? 0));

  return <main className={styles.shell}>
    <header className={styles.topbar}><div><p>BINANCE + BITGET TRADFI CORPORATE ACTIONS</p><h1>Dividend Calendar</h1><span>Ex-dividend dates, per-share payouts and one-time funding impact</span></div><div className={styles.topActions}><span className={loading ? styles.scanning : styles.live}><i />{loading ? "SCANNING" : "UPDATED"}</span><PageSwitcher active="dividends" /></div></header>
    <section className={styles.hero}>
      <article><span>BINANCE TRADFI CONTRACTS</span><strong>{payload?.exchangeCounts?.Binance.scanned ?? "—"}</strong><small>{payload?.exchangeCounts?.Binance.candidates ?? "—"} stock / ETF candidates</small></article>
      <article><span>BITGET RWA CONTRACTS</span><strong>{payload?.exchangeCounts?.Bitget.scanned ?? "—"}</strong><small>Stocks and ETFs included</small></article>
      <article><span>EVENTS THIS MONTH</span><strong>{payload?.events.length ?? "—"}</strong><small>{payload?.coveredContracts ?? 0} exchange-listed pairs</small></article>
      <article><span>HIGHEST SINGLE DIVIDEND</span><strong>{highest ? `${highest.toFixed(2)}%` : "—"}</strong><small>Dividend ÷ underlying price</small></article>
    </section>
    {error && <div className={styles.error}>{error}</div>}
    <section className={styles.panel}>
      <header className={styles.panelHead}><div><span>MONTHLY EX-DIVIDEND VIEW</span><h2>{monthLabel(month)}</h2></div><div className={styles.monthNav}><button onClick={() => setMonth(moveMonth(month, -1))}>← Previous</button><button onClick={() => setMonth(new Date().toISOString().slice(0, 7))}>Current</button><button onClick={() => setMonth(moveMonth(month, 1))}>Next →</button><button onClick={() => void load()}>Refresh</button></div></header>
      <div className={styles.weekdays}>{["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className={styles.calendar}>{Array.from({ length: firstWeekday }, (_, index) => <div className={styles.blank} key={`blank-${index}`} />)}{Array.from({ length: dayCount }, (_, index) => { const day = index + 1; const events = byDay.get(day) ?? []; return <div className={`${styles.day} ${events.length ? styles.hasEvent : ""}`} key={day}><b>{day}</b><div>{events.slice(0, 3).map((event) => <a href={`#${event.id}`} key={event.id}><strong>{event.contract.replace(/USDT$/, "")} <em>{event.exchange === "Binance" ? "BN" : "BG"}</em></strong><span>{event.currency} {fmt(event.amount, 4)} · {fmt(event.percent)}%</span></a>)}{events.length > 3 && <small>+{events.length - 3} more</small>}</div></div>; })}</div>
      <footer><span><i className={styles.announcedDot} /> Exchange-announced</span><span><i className={styles.calendarDot} /> Corporate-action calendar</span><span>Estimated and final special funding may differ</span></footer>
    </section>
    <section className={styles.eventsPanel}>
      <header className={styles.eventsHead}><div><span>EVENT DETAIL</span><h2>Dividend events</h2></div><div className={styles.filters}><div>{(["All", "Binance", "Bitget"] as const).map((name) => <button className={exchange === name ? styles.selected : ""} onClick={() => setExchange(name)} key={name}>{name}</button>)}</div><input aria-label="Search contracts" placeholder="Search pair or company…" value={query} onChange={(event) => setQuery(event.target.value)} /></div></header>
      <div className={styles.eventTable}><div className={styles.tableHead}><span>EX-DATE</span><span>EXCHANGE / PAIR / COMPANY</span><span>PER-SHARE AMOUNT</span><span>UNDERLYING PRICE</span><span>ONE-TIME YIELD</span><span>STATUS</span></div>{filtered.map((event) => <a id={event.id} className={styles.tableRow} href={event.sourceUrl} target="_blank" rel="noreferrer" key={event.id}><span><strong>{event.exDate}</strong><small>{event.paymentDate ? `Pays ${event.paymentDate}` : "Special funding date"}</small></span><span><strong><i className={event.exchange === "Binance" ? styles.binance : styles.bitget}>{event.exchange}</i> {event.contract}</strong><small>{event.company}</small></span><span><strong>{event.currency} {fmt(event.amount, 6)}</strong><small>per share</small></span><span><strong>{fmt(event.markPrice, 4)}</strong><small>{event.currency} underlying</small></span><span><strong className={(event.percent ?? 0) >= 1 ? styles.high : ""}>{fmt(event.percent)}%</strong><small>amount / stock price</small></span><span><b className={!event.eligible ? styles.excluded : event.status === "announced" ? styles.announced : styles.calendarStatus}>{!event.eligible ? "NO SPECIAL FUNDING" : event.status === "announced" ? "EXCHANGE ANNOUNCED" : "CALENDAR ANNOUNCED"}</b><small>{event.sourceLabel} ↗</small></span></a>)}{!loading && !filtered.length && <div className={styles.empty}>No matching dividend events for this month.</div>}</div>
      <footer>Coverage follows the live Binance TradFi and Bitget RWA perpetual listings. Stocks and ETFs are included; commodities, indices, FX and pre-IPO contracts only appear if they match a confirmed cash-dividend event. Contract multipliers and exchange rules can change the final settlement.</footer>
    </section>
  </main>;
}
