"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import type { EarningsEvent, EarningsPayload } from "../lib/earningsCalendar";
import styles from "./page.module.css";

type Exchange = "Binance" | "Bitget";
type DividendEvent = { id: string; exchange: Exchange; contract: string; underlying: string; company: string; exDate: string | null; calendarDate?: string; recordDate?: string; dateType?: "record"; settlementConfirmed?: boolean; paymentDate: string | null; amount: number | null; currency: string; markPrice: number | null; percent: number | null; status: "announced" | "calendar" | "scheduled"; eligible: boolean; ruleType: "special_funding" | "no_adjustment"; ruleUrl: string; sourceUrl: string; sourceLabel: string };
type Payload = { month: string; generatedAt: number; scannedContracts: number; equityContracts: number; coveredContracts: number; exchangeCounts: Record<Exchange, { scanned: number; candidates: number }>; coverage?: { us: string; hk: string; kr: string; jp?: string }; issuerScans?: Array<{ company: string; market: string; sourceUrl: string; status: string; verifiedDates: number; error?: string }>; missingNasdaqDates?: string[]; events: DividendEvent[]; warning?: string };
const validMonth = (value: string | null): value is string => !!value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const snapshotKey = (month: string) => `dividend-calendar:${month}`;
const earningsKey = (month: string) => `earnings-calendar:v1:${month}`;
const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit" }).format(new Date());
const readEarnings = (month: string): EarningsPayload | null => {
  try { const value = JSON.parse(localStorage.getItem(earningsKey(month)) ?? "null"); return value?.month === month && Array.isArray(value.events) && Array.isArray(value.sourceStatus) ? value : null; } catch { return null; }
};
const marketName = (market: string) => ({ US: "United States", JP: "Japan", KR: "Korea", HK: "Hong Kong" }[market] ?? market);
const earningsTime = (event: EarningsEvent) => event.timeHkt ? `${event.timeHkt} HKT` : event.session === "after_close" ? "After U.S. close · HKT next day" : event.session === "before_open" ? "Before U.S. open · time pending" : "Time not announced · local date";
const dividendMarket = (event: DividendEvent) => event.currency === "JPY" ? "JP" : event.currency === "KRW" ? "KR" : ["HKD", "CNY", "RMB"].includes(event.currency) ? "HK" : "US";
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
  const [month, setMonth] = useState(currentMonth);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [exchange, setExchange] = useState<"All" | Exchange>("All");
  const [selected, setSelected] = useState<DividendEvent | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<number>>(() => new Set());
  const [ready, setReady] = useState(false);
  const requestId = useRef(0);
  const [earnings, setEarnings] = useState<EarningsPayload | null>(null);
  const [earningsLoading, setEarningsLoading] = useState(true);
  const [earningsError, setEarningsError] = useState<string | null>(null);
  const [eventType, setEventType] = useState("All events");
  const [market, setMarket] = useState("All markets");
  const [selectedEarnings, setSelectedEarnings] = useState<EarningsEvent | null>(null);
  const earningsRequestId = useRef(0);

  useEffect(() => { const timer = window.setTimeout(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem("dividend-calendar:month"); } catch { /* Storage may be disabled. */ }
    const fromUrl = new URLSearchParams(window.location.search).get("month");
    const initial = validMonth(fromUrl) ? fromUrl : validMonth(saved) ? saved : currentMonth();
    setMonth(initial);
    setPayload(readSnapshot(initial));
    setEarnings(readEarnings(initial));
    setReady(true);
  }, 0); return () => window.clearTimeout(timer); }, []);

  const chooseMonth = (next: string) => {
    requestId.current += 1;
    earningsRequestId.current += 1;
    setMonth(next);
    setPayload(readSnapshot(next));
    setEarnings(readEarnings(next));
    setSelected(null);
    setSelectedEarnings(null);
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

  const loadEarnings = useCallback(async () => {
    const id = ++earningsRequestId.current;
    setEarningsLoading(true); setEarningsError(null);
    try {
      const response = await fetch(`/api/earnings-calendar?month=${month}`, { cache: "no-store" });
      const next = await response.json() as EarningsPayload & { error?: string };
      if (!response.ok || next.month !== month || !Array.isArray(next.events) || !Array.isArray(next.sourceStatus)) throw new Error(next.error ?? "Earnings scan unavailable");
      if (id !== earningsRequestId.current) return;
      const prior = readEarnings(month);
      if (!next.events.length && next.warnings.length && prior?.events.length) {
        setEarnings({ ...prior, events: prior.events.map(e => ({ ...e, stale: true })), warnings: next.warnings });
        setEarningsError("Earnings refresh incomplete. Retained events are labelled STALE.");
      } else {
        setEarnings(next);
        try { localStorage.setItem(earningsKey(month), JSON.stringify(next)); } catch { /* Optional browser cache. */ }
      }
    } catch (e) { if (id === earningsRequestId.current) { setEarningsError(e instanceof Error ? e.message : "Earnings unavailable"); setEarnings(old => old ? { ...old, events: old.events.map(event => ({ ...event, stale: true })) } : null); } }
    finally { if (id === earningsRequestId.current) setEarningsLoading(false); }
  }, [month]);

  useEffect(() => { if (!ready) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load, ready]);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void loadEarnings(), 0);
    const refresh = () => { if (document.visibilityState === "visible") void loadEarnings(); };
    const interval = window.setInterval(refresh, 5 * 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); window.removeEventListener("focus", refresh); earningsRequestId.current += 1; };
  }, [loadEarnings, ready]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") { setSelected(null); setSelectedEarnings(null); } };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, []);
  const visible = payload?.month === month ? payload : null;
  const visibleEarnings = earnings?.month === month ? earnings : null;
  const firstWeekday = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const dayCount = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const filtered = useMemo(() => (visible?.events ?? []).filter(event => eventType !== "Earnings" && (market === "All markets" || dividendMarket(event) === market) && (exchange === "All" || event.exchange === exchange) && `${event.exchange} ${event.contract} ${event.company}`.toLowerCase().includes(query.trim().toLowerCase())), [visible, eventType, market, exchange, query]);
  const filteredEarnings = useMemo(() => (visibleEarnings?.events ?? []).filter(event => eventType !== "Dividends" && (market === "All markets" || event.market === market || event.contracts.some(c => c.listingMarket === market)) && (exchange === "All" || event.contracts.some(c => c.exchange === exchange)) && `${event.code} ${event.company} ${event.contracts.map(c => `${c.exchange} ${c.symbol}`).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())), [visibleEarnings, eventType, market, exchange, query]);
  type CalendarItem = { type: "dividend"; value: DividendEvent } | { type: "earnings"; value: EarningsEvent };
  const byDay = useMemo(() => {
    const items: CalendarItem[] = [...filteredEarnings.map(value => ({ type: "earnings" as const, value })), ...filtered.map(value => ({ type: "dividend" as const, value }))];
    return new Map(Array.from({ length: dayCount }, (_, index) => [index + 1, items.filter(item => { const date = item.type === "earnings" ? item.value.calendarDate : eventDate(item.value); return date.startsWith(month) && Number(date.slice(8, 10)) === index + 1; })]));
  }, [dayCount, month, filtered, filteredEarnings]);
  const highest = Math.max(0, ...(visible?.events ?? []).map((event) => event.percent ?? 0));

  return <main className={styles.shell}>
    <header className={styles.topbar}><div><p>BINANCE + BITGET TRADFI CORPORATE ACTIONS</p><h1>Dividend Calendar <span className={styles.titleAddition}>+ Earnings</span></h1><span>Dividends and US / Japan / Korea earnings · official schedules and estimates clearly separated</span></div><div className={styles.topActions}><span className={loading || earningsLoading ? styles.scanning : styles.live}><i />{loading || earningsLoading ? "SCANNING" : "UPDATED"}</span><PageSwitcher active="dividends" /></div></header>
    <section className={styles.hero}>
      <article><span>BINANCE TRADFI CONTRACTS</span><strong>{visible?.exchangeCounts?.Binance.scanned ?? "—"}</strong><small>{visible?.exchangeCounts?.Binance.candidates ?? "—"} stock / ETF candidates</small></article>
      <article><span>BITGET RWA CONTRACTS</span><strong>{visible?.exchangeCounts?.Bitget.scanned ?? "—"}</strong><small>Stocks and ETFs included</small></article>
      <article><span>DIVIDEND EVENTS THIS MONTH</span><strong>{visible?.events.length ?? "—"}</strong><small>{visible?.coveredContracts ?? 0} exchange-listed pairs</small></article>
      <article><span>HIGHEST SINGLE DIVIDEND</span><strong>{highest ? `${highest.toFixed(2)}%` : "—"}</strong><small>Dividend ÷ underlying price</small></article>
    </section>
    <section className={styles.earningsOverview} aria-label="Earnings coverage">
      {(["US", "JP", "KR"] as const).map(m => <article key={m}><span>{marketName(m).toUpperCase()} EARNINGS</span><strong>{visibleEarnings?.markets[m].events ?? "—"}</strong><small>{visibleEarnings?.markets[m].issuers ?? "—"} companies scanned · {visibleEarnings?.markets[m].withoutDate ?? "—"} without a verified date this month</small></article>)}
      <article><span>LIVE LISTING COVERAGE</span><strong>{visibleEarnings?.trackedContracts ?? "—"}<small> pairs</small></strong><small>Binance {visibleEarnings?.exchangeCounts.Binance ?? "—"} / Bitget {visibleEarnings?.exchangeCounts.Bitget ?? "—"} scanned · refresh every 5 min</small></article>
    </section>
    {earningsError && <div className={styles.error}>{earningsError}</div>}
    {!!visibleEarnings?.warnings.length && <div className={styles.error}>{visibleEarnings.warnings.join(" · ")}</div>}
    {error && <div className={styles.error}>{error}</div>}
    {visible?.coverage && <div className={styles.error}>Coverage: US — {visible.coverage.us}; Hong Kong — {visible.coverage.hk}; Korea — {visible.coverage.kr}; Japan — {visible.coverage.jp ?? "Issuer scan pending"}. An empty date is not confirmation that no dividend is scheduled.</div>}
    {visible?.issuerScans && <details className={styles.issuerSources}><summary>Korean &amp; Japanese company dividend sources ({visible.issuerScans.length})</summary><p>Record dates are shown separately from ex-dividend dates. A source with no verified exact date is a coverage gap, not a no-dividend announcement.</p>{visible.issuerScans.map((scan) => <div key={`${scan.market}:${scan.company}`}><a href={scan.sourceUrl} target="_blank" rel="noreferrer">{scan.company}</a><span>{scan.status === "dates_found" ? `${scan.verifiedDates} issuer dates verified` : scan.status === "verified_snapshot" ? "Verified issuer dates · latest refresh unavailable" : scan.status === "unavailable" ? "Company source unavailable" : "No exact dividend date verified"}</span></div>)}</details>}

    <section className={styles.panel}>
      <header className={styles.panelHead}><div><span>MONTHLY EX-DIVIDEND VIEW + EARNINGS + ISSUER RECORD DATES</span><h2>{monthLabel(month)}</h2></div><div className={styles.monthNav}><button onClick={() => chooseMonth(moveMonth(month, -1))}>← Previous</button><button onClick={() => chooseMonth(currentMonth())}>Current</button><button onClick={() => chooseMonth(moveMonth(month, 1))}>Next →</button><button onClick={() => { void load(); void loadEarnings(); }}>Refresh</button></div></header>
      <div className={styles.calendarFilters}>
        <div className={styles.filterTabs} aria-label="Event type">{["All events", "Dividends", "Earnings"].map(type => <button key={type} aria-pressed={type === eventType} onClick={() => { setEventType(type); setExpandedDays(new Set()); }}>{type}</button>)}</div>
        <label>Market <select aria-label="Filter market" value={market} onChange={e => setMarket(e.target.value)}>{["All markets", "US", "JP", "KR", "HK"].map(m => <option value={m} key={m}>{marketName(m)}</option>)}</select></label>
        <label>Exchange <select aria-label="Filter exchange" value={exchange} onChange={e => setExchange(e.target.value as "All" | Exchange)}>{["All", "Binance", "Bitget"].map(e => <option key={e}>{e}</option>)}</select></label>
        <input aria-label="Search calendar" placeholder="Search pair, company or stock code…" value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      <p className={styles.dateNote}>Exact times are HKT. After-U.S.-close events appear on the next HKT day. When no time is published, the calendar retains the issuer’s local date — no midnight time is assumed. Click any earnings event for the source and original timezone.</p>
      <div className={styles.weekdays}>{["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className={styles.calendar}>{Array.from({ length: firstWeekday }, (_, index) => <div className={styles.blank} key={`blank-${index}`} />)}{Array.from({ length: dayCount }, (_, index) => { const day = index + 1; const events = byDay.get(day) ?? []; const expanded = expandedDays.has(day); return <div className={`${styles.day} ${events.length ? styles.hasEvent : ""}`} key={day}><b>{day}</b><div>{events.slice(0, expanded ? events.length : 3).map(item => item.type === "earnings" ? (
        <button className={`${styles.earningsChip} ${item.value.status === "estimated" ? styles.estimatedChip : ""}`} onClick={() => setSelectedEarnings(item.value)} key={item.value.eventId} title={item.value.company}>
          <strong>{item.value.code} <em>{item.value.market}</em></strong>
          <span>{item.value.stale ? "STALE · " : ""}{item.value.kind === "earnings_call" ? "Results / call" : "Earnings"} · {item.value.status === "confirmed" ? "Confirmed" : "Estimated"}</span>
          <span>{[...new Set(item.value.contracts.map(c => c.exchange === "Binance" ? "BN" : "BG"))].join(" + ")}</span>
        </button>
      ) : <button onClick={() => setSelected(item.value)} key={item.value.id}><strong>{item.value.contract.replace(/USDT$/, "")} <em>{item.value.exchange === "Binance" ? "BN" : "BG"}</em></strong><span>Dividend · {item.value.dateType === "record" ? "Record date · " : ""}{item.value.amount === null ? "Amount pending" : `${item.value.currency} ${fmt(item.value.amount, 4)} · ${fmt(item.value.percent)}%`}</span></button>)}{events.length > 3 && <button className={styles.moreButton} aria-expanded={expanded} onClick={() => setExpandedDays((current) => { const next = new Set(current); if (expanded) next.delete(day); else next.add(day); return next; })}>{expanded ? "Show less" : `+${events.length - 3} more`}</button>}</div></div>; })}</div>
      <footer><span><i className={styles.calendarDot} /> Dividends</span><span><i className={styles.earningsDot} /> Earnings · confirmed</span><span><i className={styles.estimatedDot} /> Earnings · estimated</span><span>Schedules may change. An empty day is not confirmation of no event.</span></footer>
    </section>
    {eventType !== "Dividends" && <section className={styles.eventsPanel}>
      <header className={styles.eventsHead}><div><span>US · JAPAN · KOREA / ONE ROW PER COMPANY EVENT</span><h2>Earnings events ({filteredEarnings.length})</h2></div><span className={styles.checkedAt}>{visibleEarnings ? `Last scan ${new Date(visibleEarnings.generatedAt).toLocaleString("en-GB", { timeZone: "Asia/Hong_Kong" })} HKT` : "Scanning official schedules…"}</span></header>
      <div className={styles.earningsTable}>{filteredEarnings.map(event => <button key={event.eventId} onClick={() => setSelectedEarnings(event)} className={styles.earningsRow}>
        <span><strong>{event.calendarDate}</strong><small>{earningsTime(event)}</small></span>
        <span><strong>{event.company}</strong><small>{marketName(event.market)} · {event.code} · {event.kind === "earnings_call" ? "Results / IR call" : "Financial results"}</small></span>
        <span><strong>{event.contracts.map(c => `${c.exchange === "Binance" ? "BN" : "BG"} ${c.symbol}`).join(" · ")}</strong><small>{event.period ?? "Reporting period not supplied"}</small></span>
        <span><b className={event.status === "confirmed" ? styles.confirmedBadge : styles.estimatedBadge}>{event.stale ? "STALE · " : ""}{event.status.toUpperCase()}</b><small>{event.sourceLabel} ↗</small></span>
      </button>)}{!earningsLoading && !filteredEarnings.length && <div className={styles.empty}>No verified matching earnings dates in this view. Check coverage below; this does not mean no earnings are scheduled.</div>}</div>
      <footer>ETF distributions remain in the dividend calendar. ETFs do not have corporate quarterly earnings releases. STRC follows its issuer Strategy; ADR and ordinary-share contracts share the company’s financial reporting event.</footer>
    </section>}
    {visibleEarnings && <details className={styles.earningsCoverage}><summary>Earnings coverage &amp; data gaps · {visibleEarnings.issuers} companies · {visibleEarnings.missing.length} without a date this month · {visibleEarnings.unresolved.length} unmapped contracts</summary>
      <p>Listings are scanned from both exchanges. Missing dates are disclosed, not guessed. JPX schedules are issuer-submitted; KIND times may be conference-call times, with results released earlier. Nasdaq dates remain estimated until verified against the company.</p>
      <h3>Sources</h3>{visibleEarnings.sourceStatus.map(s => <div key={s.name}><a href={s.url} target="_blank" rel="noreferrer">{s.name} ↗</a><span>{s.ok ? "Checked" : "INCOMPLETE"} · {s.detail}</span></div>)}
      <h3>Companies without an exact date in {month}</h3>{visibleEarnings.missing.filter(i => market === "All markets" || i.market === market || i.contracts.some(c => c.listingMarket === market)).map(i => <div key={i.id}><strong>{i.company} · {i.code}</strong><span>{i.contracts.map(c => `${c.exchange} ${c.symbol}`).join(" · ")} — No date found this month</span></div>)}
      <h3>Unmapped contracts</h3>{visibleEarnings.unresolved.map(c => <div key={`${c.exchange}:${c.symbol}`}><strong>{c.exchange} {c.symbol}</strong><span>{c.reason}</span></div>)}
      <details><summary>Excluded funds / other markets ({visibleEarnings.excluded.length})</summary>{visibleEarnings.excluded.map(c => <div key={`${c.exchange}:${c.symbol}`}>{c.exchange} {c.symbol} — {c.reason}</div>)}</details>
    </details>}
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
    {selectedEarnings && <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setSelectedEarnings(null)}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="earnings-title" onMouseDown={e => e.stopPropagation()}>
      <header><div><span>{marketName(selectedEarnings.market)} · {selectedEarnings.code}</span><h2 id="earnings-title">{selectedEarnings.company}</h2></div><button aria-label="Close earnings details" onClick={() => setSelectedEarnings(null)}>×</button></header>
      <div className={styles.modalSummary}><div><small>CALENDAR DATE</small><strong>{selectedEarnings.calendarDate}</strong></div><div><small>TIME</small><strong>{earningsTime(selectedEarnings)}</strong></div><div><small>DATE STATUS</small><strong>{selectedEarnings.stale ? "STALE / " : ""}{selectedEarnings.status.toUpperCase()}</strong></div></div>
      <div className={styles.ruleGrid}><div><small>ORIGINAL DATE / TIMEZONE</small><strong>{selectedEarnings.reportDate} {selectedEarnings.timeLocal ?? "Time not announced"}<br />{selectedEarnings.timeZone}</strong></div><div><small>EVENT TYPE</small><strong>{selectedEarnings.kind === "earnings_call" ? "Results / earnings conference call" : "Financial results release"}</strong></div><div><small>PERIOD</small><strong>{selectedEarnings.period ?? "Not supplied by source"}</strong></div><div><small>VERIFICATION</small><strong>{selectedEarnings.sourceLabel}</strong></div></div>
      <div className={styles.contractList}><small>EXCHANGE-LISTED CONTRACTS</small>{selectedEarnings.contracts.map(c => <div key={`${c.exchange}:${c.symbol}`}><b>{c.exchange}</b> {c.symbol} <small>{marketName(c.listingMarket)} listing</small></div>)}</div>
      <p className={styles.note}>Source verified: {new Date(selectedEarnings.checkedAt).toLocaleString("en-GB", { timeZone: "Asia/Hong_Kong" })} HKT.{selectedEarnings.stale ? " Live refresh is unavailable. This previously verified date is retained for reference; recheck with the issuer before relying on it." : " Scheduled dates and times remain subject to change."}</p>
      <p className={styles.note}>{selectedEarnings.status === "estimated" ? "Nasdaq’s calendar includes algorithmic estimates based on historical reporting patterns. This is not issuer confirmation. Before/after-market labels are sessions, not exact release times." : "Published company/exchange schedule; subject to change. An IR call can be later than the financial-results release. Only explicitly published times are converted to HKT."} Earnings events do not imply a dividend or a perpetual-contract adjustment.</p>
      <footer><a href={selectedEarnings.sourceUrl} target="_blank" rel="noreferrer">Earnings source ↗</a></footer>
    </section></div>}
  </main>;
}
