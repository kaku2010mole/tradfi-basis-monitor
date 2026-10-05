"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type Exchange = "Binance" | "Bitget";
type DividendEvent = { id: string; exchange: Exchange; contract: string; underlying: string; company: string; exDate: string | null; calendarDate?: string; recordDate?: string; dateType?: "record"; settlementConfirmed?: boolean; paymentDate: string | null; amount: number | null; currency: string; markPrice: number | null; percent: number | null; status: "announced" | "calendar" | "scheduled"; eligible: boolean; ruleType: "special_funding" | "no_adjustment"; ruleUrl: string; sourceUrl: string; sourceLabel: string };
type Payload = { month: string; generatedAt: number; scannedContracts: number; equityContracts: number; coveredContracts: number; exchangeCounts: Record<Exchange, { scanned: number; candidates: number }>; coverage?: { us: string; hk: string; kr: string; jp?: string }; issuerScans?: Array<{ company: string; market: string; sourceUrl: string; status: string; verifiedDates: number; error?: string }>; missingNasdaqDates?: string[]; events: DividendEvent[]; warning?: string };
const validMonth = (value: string | null): value is string => !!value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const snapshotKey = (month: string) => `dividend-calendar:${month}`;
const readSnapshot = (month: string): Payload | null => {
  try { const stored = localStorage.getItem(snapshotKey(month)); const value = stored ? JSON.parse(stored) : null; return value?.month === month && Array.isArray(value.events) ? value : null; }
  catch { return null; }
};

const fmt = (value: number | null, digits = 2) => value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const monthLabel = (month: string) => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
const moveMonth = (month: string, delta: number) => { const date = new Date(`${month}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + delta); return date.toISOString().slice(0, 7); };
const eventDate = (event: DividendEvent) => event.calendarDate ?? event.exDate ?? "";
const settlementTime = (event: DividendEvent) => {
  if (event.ruleType === "no_adjustment") return "No special settlement";
  if (event.exchange === "Bitget") return "Normally 08:00 UTC+8 on the U.S. ex-dividend date";
  if (event.currency === "KRW") return "08:00 KST on the ex-dividend date";
  if (event.currency === "HKD") return "09:00 HKT on the ex-dividend date";
  if (event.currency === "CNY") return "09:15 CST on the ex-dividend date";
  return "20:00 ET on the calendar day before the U.S. ex-dividend date";
};

export default function DividendCalendarPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [exchange, setExchange] = useState<"All" | Exchange>("All");
  const [selected, setSelected] = useState<DividendEvent | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<number>>(() => new Set());
  const [ready, setReady] = useState(false);
  const requestId = useRef(0);

  useEffect(() => { const timer = window.setTimeout(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem("dividend-calendar:month"); } catch { /* Storage may be disabled. */ }
    const fromUrl = new URLSearchParams(window.location.search).get("month");
    const initial = validMonth(fromUrl) ? fromUrl : validMonth(saved) ? saved : new Date().toISOString().slice(0, 7);
    setMonth(initial);
    setPayload(readSnapshot(initial));
    setReady(true);
  }, 0); return () => window.clearTimeout(timer); }, []);

  const chooseMonth = (next: string) => {
    requestId.current += 1;
    setMonth(next);
    setPayload(readSnapshot(next));
    setSelected(null);
    setExpandedDays(new Set());
    try { localStorage.setItem("dividend-calendar:month", next); } catch { /* Storage may be disabled. */ }
    const url = new URL(window.location.href);
    url.searchParams.set("month", next);
    window.history.replaceState(window.history.state, "", url);
  };

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/dividend-calendar?month=${month}`, { cache: "no-store" });
      const next = await response.json() as Payload & { error?: string };
      if (!response.ok) throw new Error(next.error || "Dividend calendar unavailable");
      if (next.month !== month || !Array.isArray(next.events)) throw new Error("Invalid dividend calendar response");
      if (id !== requestId.current) return;
      const saved = readSnapshot(month);
      if (!next.events.length && saved?.events.length) {
        setPayload(saved);
        setError("Live scan returned no events; showing the last complete calendar.");
      } else {
        setPayload(next);
        setError(next.warning ?? null);
        if (next.events.length) try { localStorage.setItem(snapshotKey(month), JSON.stringify(next)); } catch { /* Storage may be disabled. */ }
      }
    } catch (loadError) { if (id === requestId.current) setError(loadError instanceof Error ? loadError.message : "Dividend calendar unavailable"); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [month]);

  useEffect(() => { if (!ready) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load, ready]);
  const visible = payload?.month === month ? payload : null;
  const firstWeekday = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const dayCount = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const byDay = useMemo(() => new Map(Array.from({ length: dayCount }, (_, index) => [index + 1, (visible?.events ?? []).filter((event) => eventDate(event).startsWith(month) && Number(eventDate(event).slice(8, 10)) === index + 1)])), [dayCount, month, visible]);
  const filtered = (visible?.events ?? []).filter((event) => (exchange === "All" || event.exchange === exchange) && `${event.exchange} ${event.contract} ${event.company}`.toLowerCase().includes(query.trim().toLowerCase()));
  const highest = Math.max(0, ...(visible?.events ?? []).map((event) => event.percent ?? 0));

  return <main className={styles.shell}>
    <header className={styles.topbar}><div><p>BINANCE + BITGET TRADFI CORPORATE ACTIONS</p><h1>Dividend Calendar</h1><span>Ex-dividend dates, per-share payouts and one-time funding impact</span></div><div className={styles.topActions}><span className={loading ? styles.scanning : styles.live}><i />{loading ? "SCANNING" : "UPDATED"}</span><PageSwitcher active="dividends" /></div></header>
    <section className={styles.hero}>
      <article><span>BINANCE TRADFI CONTRACTS</span><strong>{visible?.exchangeCounts?.Binance.scanned ?? "—"}</strong><small>{visible?.exchangeCounts?.Binance.candidates ?? "—"} stock / ETF candidates</small></article>
      <article><span>BITGET RWA CONTRACTS</span><strong>{visible?.exchangeCounts?.Bitget.scanned ?? "—"}</strong><small>Stocks and ETFs included</small></article>
      <article><span>EVENTS THIS MONTH</span><strong>{visible?.events.length ?? "—"}</strong><small>{visible?.coveredContracts ?? 0} exchange-listed pairs</small></article>
      <article><span>HIGHEST SINGLE DIVIDEND</span><strong>{highest ? `${highest.toFixed(2)}%` : "—"}</strong><small>Dividend ÷ underlying price</small></article>
    </section>
    {error && <div className={styles.error}>{error}</div>}
    {visible?.coverage && <div className={styles.error}>Coverage: US — {visible.coverage.us}; Hong Kong — {visible.coverage.hk}; Korea — {visible.coverage.kr}; Japan — {visible.coverage.jp ?? "Issuer scan pending"}. An empty date is not confirmation that no dividend is scheduled.</div>}
    {visible?.issuerScans && <details className={styles.issuerSources}><summary>Korean &amp; Japanese company dividend sources ({visible.issuerScans.length})</summary><p>Record dates are shown separately from ex-dividend dates. A source with no verified exact date is a coverage gap, not a no-dividend announcement.</p>{visible.issuerScans.map((scan) => <div key={`${scan.market}:${scan.company}`}><a href={scan.sourceUrl} target="_blank" rel="noreferrer">{scan.company}</a><span>{scan.status === "dates_found" ? `${scan.verifiedDates} issuer dates verified` : scan.status === "verified_snapshot" ? "Verified issuer dates · latest refresh unavailable" : scan.status === "unavailable" ? "Company source unavailable" : "No exact dividend date verified"}</span></div>)}</details>}

    <section className={styles.panel}>
      <header className={styles.panelHead}><div><span>MONTHLY EX-DIVIDEND VIEW + ISSUER RECORD DATES</span><h2>{monthLabel(month)}</h2></div><div className={styles.monthNav}><button onClick={() => chooseMonth(moveMonth(month, -1))}>← Previous</button><button onClick={() => chooseMonth(new Date().toISOString().slice(0, 7))}>Current</button><button onClick={() => chooseMonth(moveMonth(month, 1))}>Next →</button><button onClick={() => void load()}>Refresh</button></div></header>
      <div className={styles.weekdays}>{["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className={styles.calendar}>{Array.from({ length: firstWeekday }, (_, index) => <div className={styles.blank} key={`blank-${index}`} />)}{Array.from({ length: dayCount }, (_, index) => { const day = index + 1; const events = byDay.get(day) ?? []; const expanded = expandedDays.has(day); return <div className={`${styles.day} ${events.length ? styles.hasEvent : ""}`} key={day}><b>{day}</b><div>{events.slice(0, expanded ? events.length : 3).map((event) => <button onClick={() => setSelected(event)} key={event.id}><strong>{event.contract.replace(/USDT$/, "")} <em>{event.exchange === "Binance" ? "BN" : "BG"}</em></strong><span>{event.dateType === "record" ? "Record date · " : ""}{event.amount === null ? "Amount pending" : `${event.currency} ${fmt(event.amount, 4)} · ${fmt(event.percent)}%`}</span></button>)}{events.length > 3 && <button className={styles.moreButton} aria-expanded={expanded} onClick={() => setExpandedDays((current) => { const next = new Set(current); if (expanded) next.delete(day); else next.add(day); return next; })}>{expanded ? "Show less" : `+${events.length - 3} more`}</button>}</div></div>; })}</div>
      <footer><span><i className={styles.announcedDot} /> Exchange-announced</span><span><i className={styles.calendarDot} /> Corporate-action calendar</span><span>Estimated and final special funding may differ</span></footer>
    </section>
    <section className={styles.eventsPanel}>
      <header className={styles.eventsHead}><div><span>EVENT DETAIL</span><h2>Dividend events</h2></div><div className={styles.filters}><div>{(["All", "Binance", "Bitget"] as const).map((name) => <button className={exchange === name ? styles.selected : ""} onClick={() => setExchange(name)} key={name}>{name}</button>)}</div><input aria-label="Search contracts" placeholder="Search pair or company…" value={query} onChange={(event) => setQuery(event.target.value)} /></div></header>
      <div className={styles.eventTable}><div className={styles.tableHead}><span>DIVIDEND DATE</span><span>EXCHANGE / PAIR / COMPANY</span><span>PER-SHARE AMOUNT</span><span>UNDERLYING PRICE</span><span>ONE-TIME YIELD</span><span>STATUS</span></div>{filtered.map((event) => <button id={event.id} className={styles.tableRow} onClick={() => setSelected(event)} key={event.id}><span><strong>{eventDate(event)}</strong><small>{event.dateType === "record" ? "Record date · ex-date unconfirmed" : "Ex-dividend date"}{event.paymentDate ? ` · Pays ${event.paymentDate}` : ""}</small></span><span><strong><i className={event.exchange === "Binance" ? styles.binance : styles.bitget}>{event.exchange}</i> {event.contract}</strong><small>{event.company}</small></span><span><strong>{event.amount === null ? "Pending" : `${event.currency} ${fmt(event.amount, 6)}`}</strong><small>per share</small></span><span><strong>{fmt(event.markPrice, 4)}</strong><small>{event.currency} underlying</small></span><span><strong className={(event.percent ?? 0) >= 1 ? styles.high : ""}>{fmt(event.percent)}{event.percent === null ? "" : "%"}</strong><small>amount / stock price</small></span><span><b className={!event.eligible ? styles.excluded : event.status === "announced" ? styles.announced : styles.calendarStatus}>{!event.eligible ? "NO SPECIAL FUNDING" : event.status === "announced" ? "EXCHANGE ANNOUNCED" : event.status === "scheduled" ? "DATE SCHEDULED" : "CALENDAR ANNOUNCED"}</b><small>{event.sourceLabel} · View rules</small></span></button>)}{!loading && !filtered.length && <div className={styles.empty}>No matching announced dividend events found. Coverage is not exhaustive.</div>}</div>
      <footer>Coverage follows the live Binance TradFi and Bitget RWA perpetual listings. Stocks and ETFs are included; commodities, indices, FX and pre-IPO contracts only appear if they match a confirmed cash-dividend event. Contract multipliers and exchange rules can change the final settlement.</footer>
    </section>
    {selected && <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setSelected(null)}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="rule-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>{selected.exchange} · {selected.contract}</span><h2 id="rule-title">Dividend treatment</h2></div><button aria-label="Close details" onClick={() => setSelected(null)}>×</button></header>
      <div className={styles.modalSummary}><div><small>{selected.dateType === "record" ? "RECORD DATE" : "EX-DIVIDEND DATE"}</small><strong>{eventDate(selected)}</strong></div><div><small>DIVIDEND / SHARE</small><strong>{selected.currency} {fmt(selected.amount, 6)}</strong></div><div><small>ESTIMATED IMPACT</small><strong>{fmt(selected.percent)}%</strong></div></div>
      {selected.settlementConfirmed === false ? <div className={styles.noAdjustment}><b>Company dividend schedule</b><p>This is the company’s record date, not a confirmed ex-dividend date. The company announcement does not confirm perpetual-contract settlement. Amounts and payment dates appear only when published by the issuer.</p></div> : selected.ruleType === "no_adjustment" ? <div className={styles.noAdjustment}><b>No special dividend settlement</b><p>{selected.exchange === "Bitget" && selected.contract === "STRCUSDT" ? "Bitget explicitly excludes STRC dividends: no cash credit or deduction and no position adjustment. The ex-dividend decline is reflected naturally in the mark price and ordinary funding, so the resulting P&L is borne by the trader." : "This contract is excluded from the exchange's special dividend-funding process. The market-price adjustment is not offset by a dividend credit."}</p></div> : <div className={styles.ruleGrid}><div><small>SETTLEMENT TIME</small><strong>{settlementTime(selected)}</strong></div><div><small>DIRECTION</small><strong>Longs receive · shorts pay</strong></div><div><small>CALCULATION</small><strong>{selected.exchange === "Binance" ? "Special funding rate = − dividend ÷ mark price" : "Dividend per share × net position size"}</strong></div><div><small>POSITION BASIS</small><strong>Net open position at the settlement snapshot</strong></div></div>}
      {selected.settlementConfirmed !== false && selected.exchange === "Binance" && selected.ruleType === "special_funding" && <p className={styles.note}>For U.S. equities, Binance normally switches to hourly funding, enters reduce-only mode at 19:30 ET, executes special funding after standard funding at 20:00 ET, and restores normal trading around 20:01 ET. The special dividend rate bypasses the normal funding cap.</p>}
      {selected.settlementConfirmed !== false && selected.exchange === "Bitget" && selected.ruleType === "special_funding" && <p className={styles.note}>Bitget normally keeps contract trading active during dividend settlement. The credit or deduction appears as a funding fee; long and short positions under the same UID are netted first.</p>}
      <footer><a href={selected.ruleUrl} target="_blank" rel="noreferrer">Exchange rule ↗</a><a href={selected.sourceUrl} target="_blank" rel="noreferrer">Dividend source ↗</a></footer>
    </section></div>}
  </main>;
}
