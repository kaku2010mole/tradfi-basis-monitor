"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type Leg = { venue: "binance" | "hyperliquid"; symbol: string; label: string };
type Relationship = {
  id: string;
  title: string;
  short: string;
  kind: "same-benchmark" | "leveraged-inverse" | "risk-regime" | "cross-index";
  a: Leg;
  b: Leg;
  expectedBeta: number | null;
  thesis: string;
  caveat: string;
};
type Point = { t: number; a: number; b: number; returnA: number; returnB: number; residual: number; z: number };
type Analysis = {
  generatedAt: number;
  interval: string;
  relationship: Relationship;
  relationships: Relationship[];
  universe: null | {
    count: number;
    symbols: string[];
    typeCounts: Record<string, number>;
    candidates: Array<{ id: string; available: boolean }>;
  };
  points: Point[];
  stats: {
    correlation: number;
    fittedBeta: number;
    modelBeta: number;
    returnA: number;
    returnB: number;
    relativeGap: number;
    zScore: number;
    status: "normal" | "watch" | "dislocation";
    samples: number;
  };
};

const QUICK_WINDOWS = [
  { label: "6H", milliseconds: 6 * 60 * 60_000 },
  { label: "24H", milliseconds: 24 * 60 * 60_000 },
  { label: "3D", milliseconds: 3 * 24 * 60 * 60_000 },
  { label: "7D", milliseconds: 7 * 24 * 60 * 60_000 },
  { label: "30D", milliseconds: 30 * 24 * 60 * 60_000 },
] as const;

const FALLBACK_RELATIONSHIPS = [
  { id: "qqq-ustech", title: "QQQ ↔ USTECH" },
  { id: "tbt-tmf", title: "TBT ↔ TMF" },
  { id: "uvxy-qqq", title: "UVXY ↔ QQQ" },
  { id: "soxl-tza", title: "SOXL ↔ TZA" },
] as const;
const INITIAL_NOW = Date.now();
const DIRECT_BINANCE_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"];

const toHktInput = (timestamp: number) => new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 16);
const fromHktInput = (value: string) => Date.parse(`${value}:00+08:00`);
const formatPct = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const formatNumber = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
const formatTime = (value: number, includeDate = false) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong",
  month: includeDate ? "short" : undefined,
  day: includeDate ? "2-digit" : undefined,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(value);

const directInterval = (duration: number) => duration <= 24 * 60 * 60_000 ? "1m"
  : duration <= 4 * 24 * 60 * 60_000 ? "5m"
    : duration <= 14 * 24 * 60 * 60_000 ? "15m"
      : duration <= 45 * 24 * 60 * 60_000 ? "1h"
        : "4h";
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const standardDeviation = (values: number[], center = average(values)) => values.length < 2 ? 0 : Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));

async function directBinance<T>(path: string) {
  let lastError: unknown;
  for (const host of DIRECT_BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Direct Binance history unavailable.");
}

async function directSeries(leg: Leg, start: number, end: number, interval: string) {
  if (leg.venue === "binance") {
    const params = new URLSearchParams({ symbol: leg.symbol, interval, startTime: String(start), endTime: String(end), limit: "1500" });
    const rows = await directBinance<Array<[number, string, string, string, string]>>(`/fapi/v1/klines?${params}`);
    return rows.flatMap((row) => Number(row[4]) > 0 ? [{ t: row[0], value: Number(row[4]) }] : []);
  }
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: leg.symbol, interval, startTime: start, endTime: end } }),
    cache: "no-store",
    signal: AbortSignal.timeout(9_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  const rows = await response.json() as Array<{ t?: number; c?: string }>;
  return rows.flatMap((row) => Number(row.c) > 0 ? [{ t: Number(row.t), value: Number(row.c) }] : []);
}

async function analyzeInBrowser(relationship: Relationship, relationships: Relationship[], start: number, end: number): Promise<Analysis> {
  const interval = directInterval(end - start);
  const [aRows, bRows, exchangeInfo] = await Promise.all([
    directSeries(relationship.a, start, end, interval),
    directSeries(relationship.b, start, end, interval),
    directBinance<{ symbols?: Array<{ symbol?: string; status?: string; underlyingType?: string; underlyingSubType?: string[] }> }>("/fapi/v1/exchangeInfo"),
  ]);
  const bByTime = new Map(bRows.map((row) => [row.t, row.value]));
  const aligned = aRows.flatMap((row) => bByTime.has(row.t) ? [{ t: row.t, a: row.value, b: bByTime.get(row.t)! }] : []);
  if (aligned.length < 12) throw new Error("Not enough overlapping candles for this window.");
  const returnsA = aligned.slice(1).map((row, index) => Math.log(row.a / aligned[index].a));
  const returnsB = aligned.slice(1).map((row, index) => Math.log(row.b / aligned[index].b));
  const meanA = average(returnsA);
  const meanB = average(returnsB);
  const covariance = returnsA.reduce((sum, value, index) => sum + (value - meanA) * (returnsB[index] - meanB), 0) / Math.max(1, returnsA.length - 1);
  const varianceB = returnsB.reduce((sum, value) => sum + (value - meanB) ** 2, 0) / Math.max(1, returnsB.length - 1);
  const fittedBeta = varianceB > 0 ? covariance / varianceB : 0;
  const stdA = standardDeviation(returnsA, meanA);
  const stdB = standardDeviation(returnsB, meanB);
  const correlation = stdA && stdB ? covariance / (stdA * stdB) : 0;
  const modelBeta = relationship.expectedBeta ?? fittedBeta;
  const first = aligned[0];
  const residuals = aligned.map((row) => Math.log(row.a / first.a) - modelBeta * Math.log(row.b / first.b));
  const baseline = residuals.slice(0, Math.max(10, Math.min(residuals.length - 1, Math.floor(residuals.length * .8))));
  const residualMean = average(baseline);
  const residualStd = standardDeviation(baseline, residualMean);
  const points = aligned.map((row, index) => ({ t: row.t, a: row.a, b: row.b, returnA: (row.a / first.a - 1) * 100, returnB: (row.b / first.b - 1) * 100, residual: residuals[index] * 100, z: residualStd ? (residuals[index] - residualMean) / residualStd : 0 }));
  const latest = points.at(-1)!;
  const tradFi = (exchangeInfo.symbols ?? []).filter((item) => item.status === "TRADING" && item.underlyingSubType?.some((tag) => tag.toLowerCase() === "tradfi"));
  const symbols = tradFi.flatMap((item) => item.symbol ? [item.symbol] : []).sort();
  const active = new Set(symbols);
  const typeCounts = tradFi.reduce<Record<string, number>>((counts, item) => { const type = item.underlyingType || "OTHER"; counts[type] = (counts[type] ?? 0) + 1; return counts; }, {});
  const zMagnitude = Math.abs(latest.z);
  return {
    generatedAt: Date.now(), interval, relationship, relationships,
    universe: { count: symbols.length, symbols, typeCounts, candidates: relationships.map((item) => ({ id: item.id, available: [item.a, item.b].every((leg) => leg.venue === "hyperliquid" || active.has(leg.symbol)) })) },
    points,
    stats: { correlation, fittedBeta, modelBeta, returnA: latest.returnA, returnB: latest.returnB, relativeGap: latest.residual, zScore: latest.z, status: zMagnitude >= 2 ? "dislocation" : zMagnitude >= 1.5 ? "watch" : "normal", samples: points.length },
  };
}

function linePath(values: number[], width: number, height: number, padding: { left: number; right: number; top: number; bottom: number }, min: number, max: number) {
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const range = Math.max(max - min, 1e-8);
  return values.map((value, index) => {
    const x = padding.left + (index / Math.max(1, values.length - 1)) * plotWidth;
    const y = padding.top + ((max - value) / range) * plotHeight;
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function PerformanceChart({ points, relationship }: { points: Point[]; relationship: Relationship }) {
  const width = 920;
  const height = 340;
  const padding = { left: 58, right: 24, top: 28, bottom: 42 };
  const values = points.flatMap((point) => [point.returnA, point.returnB]);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const extra = Math.max((rawMax - rawMin) * .1, .05);
  const min = rawMin - extra;
  const max = rawMax + extra;
  const y = (value: number) => padding.top + ((max - value) / Math.max(max - min, 1e-8)) * (height - padding.top - padding.bottom);
  return (
    <div className={styles.chartScroll}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${relationship.title} normalized return chart`}>
        <defs>
          <linearGradient id="blogChartFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7ce3c1" stopOpacity=".13" /><stop offset="1" stopColor="#7ce3c1" stopOpacity="0" /></linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((tick) => {
          const value = max - ((max - min) * tick) / 4;
          const chartY = y(value);
          return <g key={tick}><line x1={padding.left} x2={width - padding.right} y1={chartY} y2={chartY} className={styles.gridLine} /><text x={padding.left - 9} y={chartY + 4} textAnchor="end" className={styles.axisText}>{value.toFixed(2)}%</text></g>;
        })}
        {[0, .25, .5, .75, 1].map((ratio) => {
          const index = Math.min(points.length - 1, Math.round((points.length - 1) * ratio));
          const x = padding.left + ratio * (width - padding.left - padding.right);
          return <text key={ratio} x={x} y={height - 15} textAnchor={ratio === 0 ? "start" : ratio === 1 ? "end" : "middle"} className={styles.axisText}>{formatTime(points[index].t, points.at(-1)!.t - points[0].t > 24 * 60 * 60_000)}</text>;
        })}
        <line x1={padding.left} x2={width - padding.right} y1={y(0)} y2={y(0)} className={styles.zeroLine} />
        <path d={linePath(points.map((point) => point.returnA), width, height, padding, min, max)} className={styles.lineA} />
        <path d={linePath(points.map((point) => point.returnB), width, height, padding, min, max)} className={styles.lineB} />
      </svg>
    </div>
  );
}

function ResidualChart({ points }: { points: Point[] }) {
  const width = 920;
  const height = 270;
  const padding = { left: 58, right: 24, top: 22, bottom: 34 };
  const maxMagnitude = Math.max(3, ...points.map((point) => Math.abs(point.z))) * 1.08;
  const min = -maxMagnitude;
  const max = maxMagnitude;
  const y = (value: number) => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  return (
    <div className={styles.chartScroll}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Relative-value residual z-score chart">
        <rect x={padding.left} y={y(2)} width={width - padding.left - padding.right} height={y(-2) - y(2)} className={styles.normalBand} />
        {[-2, 0, 2].map((value) => <g key={value}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className={value === 0 ? styles.zeroLine : styles.alertLine} /><text x={padding.left - 9} y={y(value) + 4} textAnchor="end" className={styles.axisText}>{value > 0 ? "+" : ""}{value}σ</text></g>)}
        <path d={linePath(points.map((point) => point.z), width, height, padding, min, max)} className={styles.residualLine} />
        <circle cx={width - padding.right} cy={y(points.at(-1)?.z ?? 0)} r="5" className={Math.abs(points.at(-1)?.z ?? 0) >= 2 ? styles.hotDot : styles.liveDot} />
      </svg>
    </div>
  );
}

export default function RelativeValueBlog() {
  const requestRef = useRef<AbortController | null>(null);
  const relationshipsRef = useRef<Relationship[] | null>(null);
  const [relationshipId, setRelationshipId] = useState("qqq-ustech");
  const [startInput, setStartInput] = useState(() => toHktInput(INITIAL_NOW - 24 * 60 * 60_000));
  const [endInput, setEndInput] = useState(() => toHktInput(INITIAL_NOW));
  const [followingLive, setFollowingLive] = useState(true);
  const [activeWindow, setActiveWindow] = useState("24H");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (options?: { relationship?: string; start?: number; end?: number }) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const start = options?.start ?? fromHktInput(startInput);
    const end = options?.end ?? fromHktInput(endInput);
    const relationship = options?.relationship ?? relationshipId;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      setError("Choose a valid HKT start and end time.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ relationship, start: String(start), end: String(end) });
      const response = await fetch(`/api/blog/analysis?${params}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as Partial<Analysis> & { error?: string };
      if (response.ok) {
        relationshipsRef.current = payload.relationships ?? null;
        setAnalysis(payload as Analysis);
      } else {
        const relationships = payload.relationships?.length ? payload.relationships : relationshipsRef.current;
        const target = relationships?.find((item) => item.id === relationship);
        if (!relationships || !target) throw new Error(payload.error || "Relative-value data is unavailable.");
        relationshipsRef.current = relationships;
        setAnalysis(await analyzeInBrowser(target, relationships, start, end));
      }
    } catch (requestError) {
      if ((requestError as Error).name !== "AbortError") setError(requestError instanceof Error ? requestError.message : "Relative-value data is unavailable.");
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, [endInput, relationshipId, startInput]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load({ start: INITIAL_NOW - 24 * 60 * 60_000, end: INITIAL_NOW }));
    return () => {
      window.cancelAnimationFrame(frame);
      requestRef.current?.abort();
    };
    // Initial load is intentionally independent of editable input state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!followingLive) return;
    const timer = window.setInterval(() => {
      const windowConfig = QUICK_WINDOWS.find((item) => item.label === activeWindow) ?? QUICK_WINDOWS[1];
      const end = Date.now();
      const start = end - windowConfig.milliseconds;
      setStartInput(toHktInput(start));
      setEndInput(toHktInput(end));
      void load({ start, end });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [activeWindow, followingLive, load]);

  const relationships = analysis?.relationships ?? FALLBACK_RELATIONSHIPS;
  const selected = analysis?.relationship;
  const availability = useMemo(() => new Map(analysis?.universe?.candidates.map((item) => [item.id, item.available]) ?? []), [analysis?.universe]);
  const statusLabel = analysis?.stats.status === "dislocation" ? "DISLOCATION" : analysis?.stats.status === "watch" ? "WATCH" : "NORMAL";

  const applyQuickWindow = (label: string, milliseconds: number, end: number) => {
    const start = end - milliseconds;
    setActiveWindow(label);
    setFollowingLive(true);
    setStartInput(toHktInput(start));
    setEndInput(toHktInput(end));
    void load({ start, end });
  };

  const chooseRelationship = (id: string) => {
    setRelationshipId(id);
    void load({ relationship: id });
  };

  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>MARKET RELATIONSHIP RESEARCH</p>
            <h1>Relative Value Blog</h1>
            <p>Live Binance TradFi scanning, cross-venue return comparison and statistically unusual relative moves.</p>
          </div>
          <div className={styles.topActions}>
            <span className={`${styles.connection} ${analysis && !error ? styles.online : ""}`}><i />{loading ? "Updating data" : analysis && !error ? "Analytics live" : "Data retry needed"}</span>
            <PageSwitcher active="blog" />
          </div>
        </header>

        <section className={styles.universeStrip}>
          <div><span>BINANCE TRADEFI SCAN</span><strong>{analysis?.universe ? `${analysis.universe.count} active contracts` : "Scanning universe…"}</strong></div>
          <div><span>CURATED LINKS AVAILABLE</span><strong>{analysis?.universe ? `${analysis.universe.candidates.filter((item) => item.available).length}/${analysis.universe.candidates.length}` : "—"}</strong></div>
          <div><span>DATA WINDOW</span><strong>{analysis ? `${formatTime(analysis.points[0].t, true)} — ${formatTime(analysis.points.at(-1)!.t, true)} HKT` : "—"}</strong></div>
          <div><span>LAST CALCULATION</span><strong>{analysis ? `${formatTime(analysis.generatedAt)} HKT` : "—"}</strong></div>
        </section>

        <section className={styles.workspace}>
          <aside className={styles.relationships}>
            <div className={styles.sectionLabel}><span>RELATIONSHIP MAP</span><small>Select a model</small></div>
            <div className={styles.relationshipList}>
              {relationships.map((relationship) => <button key={relationship.id} className={relationshipId === relationship.id ? styles.activeRelationship : ""} disabled={availability.get(relationship.id) === false} onClick={() => chooseRelationship(relationship.id)}>
                <span>{relationship.title}</span>
                <small>{"short" in relationship ? relationship.short : "Relative-value model"}</small>
                {availability.get(relationship.id) === false && <em>Not listed</em>}
              </button>)}
            </div>
            {analysis?.universe && <div className={styles.scanBreakdown}>
              <span>LIVE UNIVERSE BREAKDOWN</span>
              {Object.entries(analysis.universe.typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => <div key={type}><b>{type.replaceAll("_", " ")}</b><strong>{count}</strong></div>)}
              <details><summary>View all {analysis.universe.count} symbols</summary><p>{analysis.universe.symbols.join(" · ")}</p></details>
            </div>}
          </aside>

          <div className={styles.analysisColumn}>
            <section className={styles.controls}>
              <div className={styles.quickWindows}>{QUICK_WINDOWS.map((window) => <button key={window.label} className={followingLive && activeWindow === window.label ? styles.activeWindow : ""} onClick={(event) => applyQuickWindow(window.label, window.milliseconds, performance.timeOrigin + event.timeStamp)}>{window.label}</button>)}</div>
              <label>Start · HKT<input type="datetime-local" value={startInput} onChange={(event) => { setStartInput(event.target.value); setFollowingLive(false); setActiveWindow(""); }} /></label>
              <label>End · HKT<input type="datetime-local" value={endInput} onChange={(event) => { setEndInput(event.target.value); setFollowingLive(false); setActiveWindow(""); }} /></label>
              <button className={styles.runButton} disabled={loading} onClick={() => void load()}>{loading ? "Calculating…" : "Analyze window"}</button>
            </section>

            {error && <div className={styles.errorBox}><strong>History feed unavailable</strong><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}

            {analysis && selected && <>
              <section className={styles.heroCard}>
                <div className={styles.heroCopy}>
                  <span className={styles.kindPill}>{selected.kind.replaceAll("-", " ")}</span>
                  <h2>{selected.title}</h2>
                  <p>{selected.thesis}</p>
                  <small>{selected.caveat}</small>
                </div>
                <div className={`${styles.signal} ${styles[analysis.stats.status]}`}>
                  <span>LATEST SIGNAL</span>
                  <strong>{statusLabel}</strong>
                  <b>{formatNumber(analysis.stats.zScore)}σ</b>
                  <small>{Math.abs(analysis.stats.zScore) >= 2 ? "Residual is outside the ±2σ baseline." : "Residual remains inside the ±2σ baseline."}</small>
                </div>
              </section>

              <section className={styles.metricGrid}>
                <article><span>{selected.a.label} move</span><strong className={analysis.stats.returnA >= 0 ? styles.positive : styles.negative}>{formatPct(analysis.stats.returnA)}</strong><small>{selected.a.symbol}</small></article>
                <article><span>{selected.b.label} move</span><strong className={analysis.stats.returnB >= 0 ? styles.positive : styles.negative}>{formatPct(analysis.stats.returnB)}</strong><small>{selected.b.symbol}</small></article>
                <article><span>Model residual</span><strong>{formatPct(analysis.stats.relativeGap, 3)}</strong><small>A − β × B in log-return space</small></article>
                <article><span>Return correlation</span><strong>{analysis.stats.correlation.toFixed(3)}</strong><small>{analysis.stats.samples.toLocaleString()} aligned {analysis.interval} candles</small></article>
                <article><span>Model beta</span><strong>{formatNumber(analysis.stats.modelBeta, 3)}</strong><small>{selected.expectedBeta === null ? "Dynamically fitted" : "Structural daily target"}</small></article>
                <article><span>Observed beta</span><strong>{formatNumber(analysis.stats.fittedBeta, 3)}</strong><small>OLS on interval log returns</small></article>
              </section>

              <section className={styles.chartPanel}>
                <div className={styles.panelHead}><div><span>NORMALIZED PERFORMANCE</span><h3>Move since selected start</h3></div><div className={styles.legend}><span><i className={styles.legendA} />{selected.a.label}</span><span><i className={styles.legendB} />{selected.b.label}</span></div></div>
                <PerformanceChart points={analysis.points} relationship={selected} />
              </section>

              <section className={styles.chartPanel}>
                <div className={styles.panelHead}><div><span>DISLOCATION MONITOR</span><h3>Model residual z-score</h3></div><p>Flags begin at ±1.5σ; dislocation begins at ±2σ.</p></div>
                <ResidualChart points={analysis.points} />
              </section>

              <section className={styles.methodPanel}>
                <div><span>HOW TO READ THIS</span><h3>Relationship first, statistics second.</h3><p>The chart aligns venue candles, converts both legs to log returns and compares A against β × B. Structural pairs use the issuer&apos;s stated daily leverage ratio. Cross-index and volatility relationships use a fitted beta because no fixed conversion exists.</p></div>
                <div><span>WHAT COUNTS AS UNUSUAL</span><h3>A residual outside its own baseline.</h3><p>The first 80% of the selected window establishes the residual mean and standard deviation. A large z-score is an investigation prompt—not proof of executable arbitrage. Funding, oracle timing, ETF reset mechanics and order-book depth still matter.</p></div>
              </section>

              <section className={styles.sources}>
                <div><span>RESEARCH NOTES & PRIMARY SOURCES</span><h3>Why these legs are linked</h3></div>
                <div className={styles.sourceGrid}>
                  <a href="https://academy.binance.com/en/articles/tradfi-assets-you-can-trade-on-binance-futures" target="_blank" rel="noreferrer"><b>Binance TradFi contracts</b><small>Contract universe and 24/7 perpetual structure ↗</small></a>
                  <a href="https://www.invesco.com/content/dam/invesco/hk/en/pdf/factsheet/Invesco_QQQ_factsheet_EN.pdf" target="_blank" rel="noreferrer"><b>Invesco QQQ</b><small>Nasdaq-100 tracking objective ↗</small></a>
                  <a href="https://app.hyperliquid.xyz/trade/mkts:USTECH" target="_blank" rel="noreferrer"><b>Hyperliquid USTECH</b><small>Live HIP-3 market ↗</small></a>
                  <a href="https://www.proshares.com/our-etfs/leveraged-and-inverse/tbt" target="_blank" rel="noreferrer"><b>ProShares TBT</b><small>−2× daily 20+ year Treasury objective ↗</small></a>
                  <a href="https://www.direxion.com/product/daily-20-year-treasury-bull-bear-3x-etfs" target="_blank" rel="noreferrer"><b>Direxion TMF</b><small>+3× daily 20+ year Treasury objective ↗</small></a>
                  <a href="https://www.proshares.com/our-etfs/leveraged-and-inverse/uvxy" target="_blank" rel="noreferrer"><b>ProShares UVXY</b><small>Short-term VIX futures exposure ↗</small></a>
                  <a href="https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs" target="_blank" rel="noreferrer"><b>Direxion SOXL / SOXS</b><small>±3× semiconductor daily targets ↗</small></a>
                  <a href="https://www.direxion.com/product/daily-small-cap-bull-bear-3x-etfs" target="_blank" rel="noreferrer"><b>Direxion TZA</b><small>−3× Russell 2000 daily target ↗</small></a>
                </div>
              </section>
            </>}
          </div>
        </section>

        <footer className={styles.footer}>Research analytics only. A statistical dislocation can reflect a real change in beta, funding, index construction, market hours or liquidity—not a guaranteed arbitrage.</footer>
      </div>
    </main>
  );
}
