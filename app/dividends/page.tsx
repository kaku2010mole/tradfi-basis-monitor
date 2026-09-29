"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type DividendEvent = { id: string; contract: string; underlying: string; company: string; exDate: string; paymentDate: string | null; amount: number; currency: string; markPrice: number | null; percent: number | null; status: "announced" | "calendar"; eligible: boolean; sourceUrl: string; sourceLabel: string };
type Payload = { month: string; generatedAt: number; scannedContracts: number; equityContracts: number; coveredContracts: number; events: DividendEvent[] };

const fmt = (value: number | null, digits = 2) => value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const monthLabel = (month: string) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
const moveMonth = (month: string, delta: number) => { const date = new Date(`${month}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + delta); return date.toISOString().slice(0, 7); };

export default function DividendCalendarPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const response = await fetch(`/api/dividend-calendar?month=${month}`, { cache: "no-store" }); const next = await response.json(); if (!response.ok) throw new Error(next.error || "股息日历不可用"); setPayload(next); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : "股息日历不可用"); }
    finally { setLoading(false); }
  }, [month]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const firstWeekday = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const dayCount = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const byDay = useMemo(() => new Map(Array.from({ length: dayCount }, (_, index) => [index + 1, (payload?.events ?? []).filter((event) => Number(event.exDate.slice(8, 10)) === index + 1)])), [dayCount, payload]);
  const filtered = (payload?.events ?? []).filter((event) => `${event.contract} ${event.company}`.toLowerCase().includes(query.trim().toLowerCase()));
  const highest = Math.max(0, ...(payload?.events ?? []).map((event) => event.percent ?? 0));

  return <main className={styles.shell}>
    <header className={styles.topbar}><div><p>BINANCE TRADFI CORPORATE ACTIONS</p><h1>Dividend Calendar</h1><span>除息日、每股金额与一次性特殊 funding 影响</span></div><div className={styles.topActions}><span className={loading ? styles.scanning : styles.live}><i />{loading ? "SCANNING" : "UPDATED"}</span><PageSwitcher active="dividends" /></div></header>
    <section className={styles.hero}>
      <article><span>TRADFI CONTRACTS SCANNED</span><strong>{payload?.scannedContracts ?? "—"}</strong><small>Binance 动态合约清单</small></article>
      <article><span>EQUITY / ETF CONTRACTS</span><strong>{payload?.equityContracts ?? "—"}</strong><small>股息扫描对象</small></article>
      <article><span>EVENTS THIS MONTH</span><strong>{payload?.events.length ?? "—"}</strong><small>{payload?.coveredContracts ?? 0} 个合约</small></article>
      <article><span>HIGHEST SINGLE DIVIDEND</span><strong>{highest ? `${highest.toFixed(2)}%` : "—"}</strong><small>股息 ÷ 对应股票价格</small></article>
    </section>
    {error && <div className={styles.error}>{error}</div>}
    <section className={styles.panel}>
      <header className={styles.panelHead}><div><span>MONTHLY EX-DIVIDEND VIEW</span><h2>{monthLabel(month)}</h2></div><div className={styles.monthNav}><button onClick={() => setMonth(moveMonth(month, -1))}>← 上月</button><button onClick={() => setMonth(new Date().toISOString().slice(0, 7))}>本月</button><button onClick={() => setMonth(moveMonth(month, 1))}>下月 →</button><button onClick={() => void load()}>刷新</button></div></header>
      <div className={styles.weekdays}>{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className={styles.calendar}>{Array.from({ length: firstWeekday }, (_, index) => <div className={styles.blank} key={`blank-${index}`} />)}{Array.from({ length: dayCount }, (_, index) => { const day = index + 1; const events = byDay.get(day) ?? []; return <div className={`${styles.day} ${events.length ? styles.hasEvent : ""}`} key={day}><b>{day}</b><div>{events.slice(0, 3).map((event) => <a href={`#${event.id}`} key={event.id}><strong>{event.contract.replace(/USDT$/, "")}</strong><span>{event.currency} {fmt(event.amount, 4)} · {fmt(event.percent)}%</span></a>)}{events.length > 3 && <small>+{events.length - 3} more</small>}</div></div>; })}</div>
      <footer><span><i className={styles.announcedDot} /> Binance 已公告</span><span><i className={styles.calendarDot} /> 公司行动日历</span><span>预测与实际特殊 funding 可能不同</span></footer>
    </section>
    <section className={styles.eventsPanel}>
      <header className={styles.eventsHead}><div><span>EVENT DETAIL</span><h2>股息事件清单</h2></div><input aria-label="搜索合约" placeholder="搜索合约或公司…" value={query} onChange={(event) => setQuery(event.target.value)} /></header>
      <div className={styles.eventTable}><div className={styles.tableHead}><span>除息日</span><span>合约 / 公司</span><span>每股金额</span><span>对应股票价格</span><span>单次占比</span><span>状态</span></div>{filtered.map((event) => <a id={event.id} className={styles.tableRow} href={event.sourceUrl} target="_blank" rel="noreferrer" key={event.id}><span><strong>{event.exDate}</strong><small>{event.paymentDate ? `派息 ${event.paymentDate}` : "特殊 funding 日"}</small></span><span><strong>{event.contract}</strong><small>{event.company}</small></span><span><strong>{event.currency} {fmt(event.amount, 6)}</strong><small>per share</small></span><span><strong>{fmt(event.markPrice, 4)}</strong><small>{event.currency} underlying</small></span><span><strong className={(event.percent ?? 0) >= 1 ? styles.high : ""}>{fmt(event.percent)}%</strong><small>amount / stock</small></span><span><b className={!event.eligible ? styles.excluded : event.status === "announced" ? styles.announced : styles.calendarStatus}>{!event.eligible ? "不执行特殊 FUNDING" : event.status === "announced" ? "BINANCE 已公告" : "日历已公告"}</b><small>{event.sourceLabel} ↗</small></span></a>)}{!loading && !filtered.length && <div className={styles.empty}>该月份没有匹配的股息事件。</div>}</div>
      <footer>覆盖范围以 Binance 当前 TRADIFI_PERPETUAL 股票/ETF 合约为准。商品、指数和 Pre-IPO 合约不进入股息扫描；合约单位调整可能影响最终特殊 funding，以 Binance 公告为准。</footer>
    </section>
  </main>;
}
