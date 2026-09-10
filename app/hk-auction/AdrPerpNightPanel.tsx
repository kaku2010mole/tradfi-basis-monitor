"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

export type NightBasisPair = {
  stockSymbol: string;
  perpSymbol: string;
  sharesPerContract: number;
  adrSymbol: string;
  hkSharesPerAdr: number;
};

type Point = { t: number; value: number; adrPrice: number; perpPrice: number; adrAgeMinutes: number };
type Payload = {
  active: boolean;
  adrSymbol: string;
  perpSymbol: string;
  window: { start: number; end: number; label: string };
  points: Point[];
  latest: Point | null;
  stats: { open: number; latest: number; low: number; high: number; change: number } | null;
  sources: string[];
  timestamp: number;
};

const pct = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value)
  ? "—"
  : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const price = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value)
  ? "—"
  : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
const hktTime = (value: number) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(value);
const isNightNow = () => {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", hour12: false }).format(Date.now())) % 24;
  return hour >= 21 || hour < 4;
};

function NightChart({ points, cursor, windowStart, windowEnd, onCursor }: { points: Point[]; cursor: number; windowStart?: number; windowEnd?: number; onCursor: (value: number) => void }) {
  if (!points.length) return <div className={styles.nightEmpty}>No aligned ADR and perp prices for this night.</div>;
  const width = 920;
  const height = 188;
  const top = 15;
  const bottom = 154;
  const values = points.map((point) => point.value);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const padding = Math.max((rawMax - rawMin) * .1, .025);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const start = windowStart ?? points[0].t;
  const end = Math.max(start + 1, windowEnd ?? points.at(-1)?.t ?? start + 1);
  const x = (point: Point) => 16 + Math.min(1, Math.max(0, (point.t - start) / (end - start))) * (width - 32);
  const y = (value: number) => top + (max - value) / (max - min) * (bottom - top);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(point).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const selectedIndex = Math.min(points.length - 1, Math.max(0, cursor));
  const selected = points[selectedIndex];

  return <div className={styles.nightChartBlock}>
    <div className={styles.nightReadout}>
      <span><b>{hktTime(selected.t)} HKT</b></span>
      <span>Basis <b className={selected.value < 0 ? styles.negative : styles.positive}>{pct(selected.value)}</b></span>
      <span>{selected.adrPrice ? "ADR" : "Reference"} <b>${price(selected.adrPrice)}</b></span>
      <span>Perp <b>${price(selected.perpPrice)}</b></span>
    </div>
    <svg className={styles.nightChart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="ADR versus Binance perpetual night basis">
      <defs><linearGradient id="nightBasisFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b17a25" stopOpacity=".2"/><stop offset="1" stopColor="#b17a25" stopOpacity="0"/></linearGradient></defs>
      <line x1="16" x2={width - 16} y1={y(0)} y2={y(0)} className={styles.nightZero}/>
      <path d={`${path} L${x(points.at(-1)!)},${bottom} L${x(points[0])},${bottom} Z`} className={styles.nightArea}/>
      <path d={path} className={styles.nightLine}/>
      <line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} className={styles.nightCursor}/>
      <circle cx={x(selected)} cy={y(selected.value)} r="4" className={styles.nightDot}/>
      <text x="16" y="180">21:00</text><text x={width - 16} y="180" textAnchor="end">04:00</text>
    </svg>
    <input className={styles.nightSlider} type="range" min="0" max={Math.max(0, points.length - 1)} value={selectedIndex} onChange={(event) => onCursor(Number(event.target.value))} aria-label="Inspect a night basis point" />
  </div>;
}

export default function AdrPerpNightPanel({ pairs }: { pairs: NightBasisPair[] }) {
  const options = useMemo(() => {
    const unique = new Map<string, NightBasisPair>();
    pairs.forEach((pair) => unique.set(`${pair.perpSymbol}:${pair.adrSymbol}`, pair));
    return [...unique.values()];
  }, [pairs]);
  const [selectedKey, setSelectedKey] = useState("");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(0);
  const [nightActive, setNightActive] = useState(isNightNow);

  useEffect(() => {
    const timer = window.setInterval(() => setNightActive(isNightNow()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const effectiveKey = options.some((pair) => `${pair.perpSymbol}:${pair.adrSymbol}` === selectedKey)
    ? selectedKey
    : options[0] ? `${options[0].perpSymbol}:${options[0].adrSymbol}` : "";
  const selected = options.find((pair) => `${pair.perpSymbol}:${pair.adrSymbol}` === effectiveKey);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const params = new URLSearchParams({
          adr: selected.adrSymbol,
          perp: selected.perpSymbol,
          shares: String(selected.sharesPerContract),
          hkshares: String(selected.hkSharesPerAdr),
        });
        const response = await fetch(`/api/hk-auction/adr-basis-history?${params}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json() as Payload & { error?: string };
        if (!response.ok || !Array.isArray(result.points)) throw new Error(result.error || "Night basis history is unavailable.");
        if (!cancelled) {
          setPayload(result);
          setCursor(Math.max(0, result.points.length - 1));
          setError("");
        }
      } catch (caught) {
        if (!cancelled && !(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(caught instanceof Error ? caught.message : "Night basis history is unavailable.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = nightActive ? window.setInterval(() => void load(), 30_000) : null;
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [nightActive, selected]);

  if (!options.length) return null;
  const latest = payload?.latest;
  return <section className={styles.nightPanel}>
    <header className={styles.nightHeader}>
      <div><span>ADR / PERP NIGHT WINDOW</span><h2>Overnight basis tape</h2><p>21:00–04:00 HKT · outside the window, the latest completed night stays on screen</p></div>
      <label><span>STOCK</span><select value={effectiveKey} onChange={(event) => { setPayload(null); setError(""); setLoading(true); setSelectedKey(event.target.value); }}>{options.map((pair) => <option key={`${pair.perpSymbol}:${pair.adrSymbol}`} value={`${pair.perpSymbol}:${pair.adrSymbol}`}>{pair.perpSymbol} ↔ {pair.adrSymbol}</option>)}</select></label>
    </header>
    <div className={styles.nightBody}>
      <aside className={styles.nightSummary}>
        <div className={styles.nightWindowBadge}>{payload?.active ? "LIVE NIGHT" : "LAST COMPLETED NIGHT"}</div>
        <small>{payload?.window.label ?? "Selecting the latest window…"}</small>
        <strong className={latest && latest.value < 0 ? styles.negative : styles.positive}>{pct(latest?.value)}</strong>
        <span>ADR premium / discount to Binance-implied ADR</span>
        <dl>
          <div><dt>OPEN</dt><dd>{pct(payload?.stats?.open)}</dd></div>
          <div><dt>LOW / HIGH</dt><dd>{pct(payload?.stats?.low)} / {pct(payload?.stats?.high)}</dd></div>
          <div><dt>WINDOW MOVE</dt><dd>{pct(payload?.stats?.change)}</dd></div>
        </dl>
      </aside>
      <div className={styles.nightPlot}>
        {loading && !payload ? <div className={styles.nightEmpty}>Loading the latest night window…</div> : error && !payload ? <div className={styles.nightEmpty}><strong>Night history unavailable</strong><span>{error}</span></div> : <NightChart points={payload?.points ?? []} cursor={cursor} windowStart={payload?.window.start} windowEnd={payload?.window.end} onCursor={setCursor} />}
        <footer><span>{payload?.points.length.toLocaleString() ?? 0} aligned one-minute observations</span><span>{payload?.sources.join(" + ") || "OpenD / Posley + Binance"}</span>{error && payload ? <span className={styles.negative}>Refresh delayed · keeping last chart</span> : null}</footer>
      </div>
    </div>
  </section>;
}
