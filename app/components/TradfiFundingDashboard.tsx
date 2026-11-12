"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PageSwitcher from "./PageSwitcher";
import { visiblePolling } from "../lib/visiblePolling";
import { fundingSnapshotFresh, rankTradfiFunding } from "../lib/bitgetTradfiFunding";
import type { FundingBasis, TradfiFundingRow, TradfiFundingSnapshot } from "../lib/bitgetTradfiFunding";
import styles from "./TradfiFundingDashboard.module.css";

const rateText = (value: number | null | undefined) => value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${(Math.abs(value) * 100).toFixed(4)}%`;
const timeText = (value: number | null | undefined, dated = false) => value ? new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong", ...(dated ? { day: "2-digit", month: "short", year: "numeric" } : {}),
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(value) : "—";
const countdown = (value: number | null, clock: number) => {
  if (!value || !clock || value <= clock) return null;
  const seconds = Math.ceil((value - clock) / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};
const assetOptions = [["all", "All assets"], ["stock", "Stocks"], ["etf", "ETFs"], ["index", "Indices"], ["metal", "Metals"], ["energy", "Energy"], ["fx", "Forex"], ["other", "Other TradFi"]];

export default function TradfiFundingDashboard() {
  const [data, setData] = useState<TradfiFundingSnapshot | null>(null);
  const [error, setError] = useState("");
  const [authExpired, setAuthExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(0);
  const [basis, setBasis] = useState<FundingBasis>("settlement");
  const [search, setSearch] = useState("");
  const [asset, setAsset] = useState("all");
  const [automatic, setAutomatic] = useState(true);
  const automaticRef = useRef(true), alive = useRef(false), fetching = useRef(false);
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (fetching.current || !alive.current) return;
    fetching.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/tradfi-funding", {
        cache: "no-store", signal: AbortSignal.any([abort.current!.signal, AbortSignal.timeout(12_000)]),
      });
      if (response.status === 401) { setAuthExpired(true); throw new Error("Session expired. Sign in again to refresh funding rates."); }
      if (!response.ok) throw new Error("Funding rates could not refresh. The last snapshot is retained.");
      const next = await response.json() as TradfiFundingSnapshot;
      if (!Array.isArray(next.rows) || !Number.isFinite(next.timestamp)) throw new Error("Funding rates could not refresh. The last snapshot is retained.");
      if (alive.current) { setData(next); setError(next.error ?? ""); setAuthExpired(false); setClock(Date.now()); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Funding rates could not refresh. The last snapshot is retained.");
    } finally {
      fetching.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    abort.current = new AbortController();
    const stopRefresh = visiblePolling(() => { if (automaticRef.current) void refresh(); }, 20_000);
    const stopClock = visiblePolling(() => setClock(Date.now()), 1_000);
    return () => { alive.current = false; stopRefresh(); stopClock(); abort.current?.abort(); };
  }, [refresh]);

  const ranked = rankTradfiFunding(data?.rows ?? [], basis, search, asset);
  const currentRate = (row: TradfiFundingRow | undefined) => !row ? null : basis === "8h" ? row.rate8h : row.rate;
  const fresh = fundingSnapshotFresh(data, clock) && !error;
  const highest = ranked.highest[0], lowest = ranked.lowest[0];
  const nextFunding = data?.rows.reduce<number | null>((next, row) => row.nextFundingAt && row.nextFundingAt > clock && (!next || row.nextFundingAt < next) ? row.nextFundingAt : next, null) ?? null;
  const timeRemaining = countdown(nextFunding, clock);
  const status = !data ? busy ? "Connecting" : "Unavailable" : !fresh ? "Last snapshot" : !automatic ? "Paused" : "Updating";
  const notice = error || (data && !fresh ? "This snapshot is stale. Rates and original timestamps are retained." : "");
  const tone = (value: number | null | undefined) => value == null || value === 0 ? styles.neutral : value > 0 ? styles.positive : styles.negative;

  const table = (rows: TradfiFundingRow[], side: "highest" | "lowest") => <section className={styles.board} aria-label={side === "highest" ? "Highest 10 funding rates" : "Lowest 10 funding rates"}>
    <div className={styles.boardHeading}>
      <div><span className={`${styles.sideIcon} ${side === "highest" ? styles.positiveIcon : styles.negativeIcon}`} aria-hidden="true">{side === "highest" ? "↗" : "↘"}</span><div><h2>{side === "highest" ? "Highest 10" : "Lowest 10"}</h2><p>{side === "highest" ? "Positive rates: shorts receive" : "Negative rates: longs receive"}</p></div></div>
      <span className={styles.sortLabel}>{basis === "8h" ? "Ranked by 8h equivalent" : "Ranked per settlement"}</span>
    </div>
    <div className={styles.tableWrap}><table>
      <thead><tr><th>#</th><th>Contract / underlying</th><th className={basis === "settlement" ? styles.selectedColumn : ""}>Current rate</th><th>Cycle</th><th className={basis === "8h" ? styles.selectedColumn : ""}>8h equivalent</th><th>Next funding<small>HKT</small></th></tr></thead>
      <tbody>{rows.map((row, i) => <tr key={row.symbol}>
        <td className={styles.rank}>{String(i + 1).padStart(2, "0")}</td>
        <td className={styles.identity}><a href={`https://www.bitget.com/futures/usdt/${encodeURIComponent(row.symbol)}`} target="_blank" rel="noreferrer" aria-label={`Open ${row.symbol} on Bitget`}>
          <b data-no-translate="true">{row.symbol}</b><small data-no-translate="true" title={row.name}>{row.name}</small>
        </a>{row.cashDividend !== null && <span className={styles.dividend}>Dividend event</span>}</td>
        <td className={`${tone(row.rate)} ${basis === "settlement" ? styles.emphasis : ""}`} data-no-translate="true">{rateText(row.rate)}</td>
        <td data-no-translate="true" className={styles.cycle}>{row.intervalHours === null ? "—" : `${row.intervalHours}h`}</td>
        <td className={`${tone(row.rate8h)} ${basis === "8h" ? styles.emphasis : ""}`} data-no-translate="true">{rateText(row.rate8h)}</td>
        <td className={styles.fundingTime} data-no-translate="true" title={`${timeText(row.nextFundingAt, true)} HKT`}>{row.nextFundingAt && row.nextFundingAt > clock ? timeText(row.nextFundingAt).slice(0, 5) : "—"}</td>
      </tr>)}{rows.length === 0 && <tr><td colSpan={6} className={styles.empty}>{!data ? busy ? "Loading live funding rates…" : "Funding rates are temporarily unavailable." : "No contracts match these filters."}</td></tr>}</tbody>
    </table></div>
  </section>;

  return <main className={styles.page}>
    <header className={styles.topbar}><a href="/stock-basis" className={styles.brand}><b aria-hidden="true">↗</b><span>TRADFI MONITOR<small>BITGET · FUNDING RATES</small></span></a><div className={styles.topActions}><span className={`${styles.status} ${fresh && automatic ? styles.statusLive : styles.statusWaiting}`} role="status"><i />{status}</span><PageSwitcher active="japan-estimate" /></div></header>
    <div className={styles.content}>
      <section className={styles.heading}><div><p className={styles.eyebrow}>BITGET · USDT-M TRADFI PERPETUALS</p><h1>TradFi funding rates</h1><p>The 10 highest and 10 lowest current Bitget rates.</p></div><div className={styles.refreshBlock}><button type="button" className={styles.refresh} onClick={() => void refresh()} disabled={busy}><span aria-hidden="true" className={busy ? styles.spinning : ""}>↻</span>{busy ? "Refreshing…" : "Refresh now"}</button><span>Snapshot <time data-no-translate="true">{timeText(data?.timestamp, true)} HKT</time></span></div></section>
      {notice && <div className={styles.notice} role="status"><span>{notice}</span>{authExpired && <a href="/login">Sign in</a>}</div>}
      <section className={styles.summary} aria-label="Funding rate summary">
        <article><span>CONTRACTS IN VIEW</span><strong data-no-translate="true">{data ? ranked.count : "—"}<small>/ {data?.universeCount ?? "—"}</small></strong><p>TradFi perpetual contracts</p></article>
        <article><span>HIGHEST RATE</span><strong className={tone(currentRate(highest))} data-no-translate="true">{rateText(currentRate(highest))}</strong><p data-no-translate="true">{highest?.symbol ?? "—"}<span>{basis === "8h" ? " / 8h equivalent" : highest?.intervalHours ? ` / ${highest.intervalHours}h` : ""}</span></p></article>
        <article><span>LOWEST RATE</span><strong className={tone(currentRate(lowest))} data-no-translate="true">{rateText(currentRate(lowest))}</strong><p data-no-translate="true">{lowest?.symbol ?? "—"}<span>{basis === "8h" ? " / 8h equivalent" : lowest?.intervalHours ? ` / ${lowest.intervalHours}h` : ""}</span></p></article>
        <article className={styles.settlement}><span>NEXT FUNDING</span><strong data-no-translate="true">{nextFunding ? timeText(nextFunding).slice(0, 5) : "—"}<small>HKT</small></strong><p>{timeRemaining ? <span data-no-translate="true">{timeRemaining}</span> : "Awaiting schedule update"}<span> · per-contract times below</span></p></article>
      </section>
      <section className={styles.toolbar} aria-label="Funding ranking controls">
        <div className={styles.basisControl} role="group" aria-label="Funding ranking basis"><button type="button" className={basis === "settlement" ? styles.active : ""} aria-pressed={basis === "settlement"} onClick={() => setBasis("settlement")}>Per settlement</button><button type="button" className={basis === "8h" ? styles.active : ""} aria-pressed={basis === "8h"} onClick={() => setBasis("8h")}>8-hour equivalent</button></div>
        <div className={styles.filters}><label className={styles.search}><span aria-hidden="true">⌕</span><input type="search" placeholder="Search symbols or names" aria-label="Search symbols or names" value={search} onChange={e => setSearch(e.target.value)} /></label><select aria-label="Filter TradFi asset type" value={asset} onChange={e => setAsset(e.target.value)}>{assetOptions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></div>
        <label className={styles.autoRefresh}><input type="checkbox" checked={automatic} onChange={e => { const checked = e.target.checked; automaticRef.current = checked; setAutomatic(checked); if (checked) void refresh(); }} /><span>Auto refresh · 20s</span></label>
      </section>
      <div className={styles.rankings}>{table(ranked.highest, "highest")}{table(ranked.lowest, "lowest")}</div>
      {data && data.missingFundingCount + data.invalidFundingCount > 0 && <p className={styles.coverage}><span>Contracts without a valid current funding rate:</span> <b data-no-translate="true">{data.missingFundingCount + data.invalidFundingCount}</b></p>}
      <details className={styles.method}><summary>How to read this panel</summary><div>
        <p>Positive funding: longs pay shorts. Negative funding: shorts pay longs. The displayed rate can change before settlement.</p>
        <p>Per settlement ranks the original rate. The 8-hour equivalent is rate × 8 ÷ settlement interval; it is a comparison, not a forecast of future payments. Contracts with an unknown interval are excluded from the 8-hour ranking.</p>
        <p>Only online Bitget TradFi perpetuals are included, using Bitget’s RWA classification. Stocks, ETFs, indices, metals, energy, forex and pre-IPO products may be included. Delivery futures are excluded.</p>
        <p>Stock dividends can create funding adjustments. Dividend events are flagged when Bitget supplies the event. This ranking does not include trading fees or hedge costs.</p>
        <p>Refreshes every 20 seconds while visible. All times are Hong Kong time. Failed refreshes retain the original snapshot time.</p>
        <p><a href="https://www.bitget.com/docs/catalog/market/derivatives" target="_blank" rel="noreferrer">Bitget funding data</a><span> · </span><a href="https://www.bitget.com/asia/support/articles/12560603817108" target="_blank" rel="noreferrer">Funding and settlement rules</a></p>
      </div></details>
      <footer className={styles.footer}><span>BITGET PUBLIC MARKET DATA</span><span>Current estimates · not settled funding history</span><span>Original snapshot time retained</span></footer>
    </div>
  </main>;
}
