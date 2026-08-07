"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import {
  fixedTrainingWindow,
  MAX_OBSERVATION_MS,
  PricePoint,
  projectRelationship,
  ProjectionPoint,
  RELATIONSHIPS,
  Relationship,
  TRAINING_INTERVAL,
  trainRelationshipModel,
  TrainedModel,
} from "../lib/relativeValue";
import styles from "./page.module.css";

type Analysis = {
  generatedAt: number;
  interval: string;
  observation: { start: number; end: number; maxDurationMs: number };
  relationship: Relationship;
  relationships: Relationship[];
  universe: null | {
    count: number;
    symbols: string[];
    typeCounts: Record<string, number>;
    candidates: Array<{ id: string; available: boolean }>;
  };
  model: TrainedModel;
  points: ProjectionPoint[];
  stats: {
    asset1Return: number;
    asset2Actual: number;
    asset2Theoretical: number;
    predictionError: number;
    zScore: number;
    status: "normal" | "watch" | "dislocation";
    samples: number;
  };
};

const QUICK_WINDOWS = [
  { label: "1H", milliseconds: 60 * 60_000 },
  { label: "6H", milliseconds: 6 * 60 * 60_000 },
  { label: "24H", milliseconds: 24 * 60 * 60_000 },
  { label: "3D", milliseconds: MAX_OBSERVATION_MS },
] as const;
const INITIAL_NOW = Date.now();
const DIRECT_BINANCE_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"];
const MODEL_CACHE_PREFIX = "relative-value-fixed-model-v3";

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
const formatDate = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", month: "short", day: "2-digit", year: "numeric" }).format(value);
const observationInterval = (duration: number) => duration <= 6 * 60 * 60_000 ? "1m" : duration <= 24 * 60 * 60_000 ? "5m" : "15m";

async function directBinance<T>(path: string) {
  let lastError: unknown;
  for (const host of DIRECT_BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, { cache: "no-store", signal: AbortSignal.timeout(9_000) });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Direct Binance history unavailable.");
}

async function directSeries(leg: Relationship["asset1"], start: number, end: number, interval: string): Promise<PricePoint[]> {
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
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  const rows = await response.json() as Array<{ t?: number; c?: string }>;
  return rows.flatMap((row) => Number(row.c) > 0 ? [{ t: Number(row.t), value: Number(row.c) }] : []);
}

async function directFixedModel(relationship: Relationship, now: number) {
  const { trainingStart, trainingEnd } = fixedTrainingWindow(now);
  const key = `${MODEL_CACHE_PREFIX}:${relationship.id}:${trainingEnd}`;
  try {
    const saved = window.localStorage.getItem(key);
    if (saved) return JSON.parse(saved) as TrainedModel;
  } catch { /* Browser storage is optional. */ }
  const [asset1Rows, asset2Rows] = await Promise.all([
    directSeries(relationship.asset1, trainingStart, trainingEnd, TRAINING_INTERVAL),
    directSeries(relationship.asset2, trainingStart, trainingEnd, TRAINING_INTERVAL),
  ]);
  const model = trainRelationshipModel(asset1Rows, asset2Rows, relationship, trainingStart, trainingEnd);
  try { window.localStorage.setItem(key, JSON.stringify(model)); } catch { /* Browser storage is optional. */ }
  return model;
}

async function analyzeInBrowser(relationship: Relationship, start: number, end: number): Promise<Analysis> {
  const interval = observationInterval(end - start);
  const [model, asset1Rows, asset2Rows, exchangeInfo] = await Promise.all([
    directFixedModel(relationship, Date.now()),
    directSeries(relationship.asset1, start, end, interval),
    directSeries(relationship.asset2, start, end, interval),
    directBinance<{ symbols?: Array<{ symbol?: string; status?: string; underlyingType?: string; underlyingSubType?: string[] }> }>("/fapi/v1/exchangeInfo"),
  ]);
  const projection = projectRelationship(asset1Rows, asset2Rows, model);
  const tradFi = (exchangeInfo.symbols ?? []).filter((item) => item.status === "TRADING" && item.underlyingSubType?.some((tag) => tag.toLowerCase() === "tradfi"));
  const symbols = tradFi.flatMap((item) => item.symbol ? [item.symbol] : []).sort();
  const active = new Set(symbols);
  const typeCounts = tradFi.reduce<Record<string, number>>((counts, item) => { const type = item.underlyingType || "OTHER"; counts[type] = (counts[type] ?? 0) + 1; return counts; }, {});
  return {
    generatedAt: Date.now(), interval, observation: { start, end, maxDurationMs: MAX_OBSERVATION_MS }, relationship, relationships: RELATIONSHIPS, model,
    universe: { count: symbols.length, symbols, typeCounts, candidates: RELATIONSHIPS.map((item) => ({ id: item.id, available: [item.asset1, item.asset2].every((leg) => leg.venue === "hyperliquid" || active.has(leg.symbol)) })) },
    ...projection,
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

function PredictionChart({ points, relationship }: { points: ProjectionPoint[]; relationship: Relationship }) {
  const width = 920;
  const height = 340;
  const padding = { left: 58, right: 24, top: 28, bottom: 42 };
  const values = points.flatMap((point) => [point.asset1Return, point.asset2Actual, point.asset2Theoretical]);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const extra = Math.max((rawMax - rawMin) * .1, .05);
  const min = rawMin - extra;
  const max = rawMax + extra;
  const y = (value: number) => padding.top + ((max - value) / Math.max(max - min, 1e-8)) * (height - padding.top - padding.bottom);
  return <div className={styles.chartScroll}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${relationship.title} actual and theoretical return chart`}>
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
    <path d={linePath(points.map((point) => point.asset1Return), width, height, padding, min, max)} className={styles.lineA} />
    <path d={linePath(points.map((point) => point.asset2Actual), width, height, padding, min, max)} className={styles.lineB} />
    <path d={linePath(points.map((point) => point.asset2Theoretical), width, height, padding, min, max)} className={styles.theoreticalLine} />
  </svg></div>;
}

function ResidualChart({ points }: { points: ProjectionPoint[] }) {
  const width = 920;
  const height = 270;
  const padding = { left: 58, right: 24, top: 22, bottom: 34 };
  const maxMagnitude = Math.max(3, ...points.map((point) => Math.abs(point.z))) * 1.08;
  const min = -maxMagnitude;
  const max = maxMagnitude;
  const y = (value: number) => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  return <div className={styles.chartScroll}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Prediction error z-score chart">
    <rect x={padding.left} y={y(2)} width={width - padding.left - padding.right} height={y(-2) - y(2)} className={styles.normalBand} />
    {[-2, 0, 2].map((value) => <g key={value}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className={value === 0 ? styles.zeroLine : styles.alertLine} /><text x={padding.left - 9} y={y(value) + 4} textAnchor="end" className={styles.axisText}>{value > 0 ? "+" : ""}{value}σ</text></g>)}
    <path d={linePath(points.map((point) => point.z), width, height, padding, min, max)} className={styles.residualLine} />
    <circle cx={width - padding.right} cy={y(points.at(-1)?.z ?? 0)} r="5" className={Math.abs(points.at(-1)?.z ?? 0) >= 2 ? styles.hotDot : styles.liveDot} />
  </svg></div>;
}

export default function RelativeValueBlog() {
  const requestRef = useRef<AbortController | null>(null);
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
    const relationshipIdToLoad = options?.relationship ?? relationshipId;
    const relationship = RELATIONSHIPS.find((item) => item.id === relationshipIdToLoad);
    if (!relationship || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > MAX_OBSERVATION_MS + 60_000) {
      setError("Choose a valid observation window of three days or less.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ relationship: relationshipIdToLoad, start: String(start), end: String(end) });
      const response = await fetch(`/api/blog/analysis?${params}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as Partial<Analysis> & { error?: string };
      if (response.ok) setAnalysis(payload as Analysis);
      else setAnalysis(await analyzeInBrowser(relationship, start, end));
    } catch (requestError) {
      if ((requestError as Error).name !== "AbortError") setError(requestError instanceof Error ? requestError.message : "Relative-value prediction is unavailable.");
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, [endInput, relationshipId, startInput]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load({ start: INITIAL_NOW - 24 * 60 * 60_000, end: INITIAL_NOW }));
    return () => { window.cancelAnimationFrame(frame); requestRef.current?.abort(); };
    // Initial load is intentionally independent of editable input state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!followingLive) return;
    const timer = window.setInterval(() => {
      const windowConfig = QUICK_WINDOWS.find((item) => item.label === activeWindow) ?? QUICK_WINDOWS[2];
      const end = Date.now();
      const start = end - windowConfig.milliseconds;
      setStartInput(toHktInput(start));
      setEndInput(toHktInput(end));
      void load({ start, end });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [activeWindow, followingLive, load]);

  const selected = analysis?.relationship;
  const availability = useMemo(() => new Map(analysis?.universe?.candidates.map((item) => [item.id, item.available]) ?? []), [analysis?.universe]);
  const signalLabel = analysis?.model.quality === "weak" ? "MODEL WEAK" : analysis?.stats.status === "dislocation" ? "DISLOCATION" : analysis?.stats.status === "watch" ? "WATCH" : "IN RANGE";

  const applyQuickWindow = (label: string, milliseconds: number, end: number) => {
    const start = end - milliseconds;
    setActiveWindow(label);
    setFollowingLive(true);
    setStartInput(toHktInput(start));
    setEndInput(toHktInput(end));
    void load({ start, end });
  };
  const chooseRelationship = (id: string) => { setRelationshipId(id); void load({ relationship: id }); };

  return <main className={styles.shell}><div className={styles.frame}>
    <header className={styles.topbar}>
      <div><p className={styles.eyebrow}>FIXED-COEFFICIENT RELATIVE VALUE</p><h1>Relative Value Blog</h1><p>Asset 1 explains the move. A separately trained and validated model estimates Asset 2&apos;s theoretical return.</p></div>
      <div className={styles.topActions}><span className={`${styles.connection} ${analysis && !error ? styles.online : ""}`}><i />{loading ? "Updating prediction" : analysis && !error ? "Prediction live" : "Data retry needed"}</span><PageSwitcher active="blog" /></div>
    </header>

    <section className={styles.universeStrip}>
      <div><span>BINANCE TRADEFI SCAN</span><strong>{analysis?.universe ? `${analysis.universe.count} active contracts` : "Scanning universe…"}</strong></div>
      <div><span>CURATED MODELS</span><strong>{analysis?.universe ? `${analysis.universe.candidates.filter((item) => item.available).length}/${analysis.universe.candidates.length} available` : `${RELATIONSHIPS.length} defined`}</strong></div>
      <div><span>FIXED TRAINING CUTOFF</span><strong>{analysis ? `${formatDate(analysis.model.trainingEnd)} HKT` : "Three days before current session"}</strong></div>
      <div><span>MODEL QUALITY</span><strong className={analysis ? styles[analysis.model.quality] : ""}>{analysis ? analysis.model.quality.toUpperCase() : "—"}</strong></div>
    </section>

    <section className={styles.workspace}>
      <aside className={styles.relationships}>
        <div className={styles.sectionLabel}><span>ASSET 1 → ASSET 2</span><small>{RELATIONSHIPS.length} models</small></div>
        <div className={styles.relationshipList}>{RELATIONSHIPS.map((relationship) => <button key={relationship.id} className={relationshipId === relationship.id ? styles.activeRelationship : ""} disabled={availability.get(relationship.id) === false} onClick={() => chooseRelationship(relationship.id)}>
          <span>{relationship.title}</span><small>{relationship.short}</small>{relationship.referenceBeta !== null && <b>Reference β {formatNumber(relationship.referenceBeta, 2)}</b>}{availability.get(relationship.id) === false && <em>Not listed</em>}
        </button>)}</div>
        {analysis?.universe && <div className={styles.scanBreakdown}><span>LIVE UNIVERSE BREAKDOWN</span>{Object.entries(analysis.universe.typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => <div key={type}><b>{type.replaceAll("_", " ")}</b><strong>{count}</strong></div>)}<details><summary>View all {analysis.universe.count} symbols</summary><p>{analysis.universe.symbols.join(" · ")}</p></details></div>}
      </aside>

      <div className={styles.analysisColumn}>
        <section className={styles.controls}>
          <div className={styles.quickWindows}>{QUICK_WINDOWS.map((window) => <button key={window.label} className={followingLive && activeWindow === window.label ? styles.activeWindow : ""} onClick={(event) => applyQuickWindow(window.label, window.milliseconds, performance.timeOrigin + event.timeStamp)}>{window.label}</button>)}</div>
          <label>Observation start · HKT<input type="datetime-local" value={startInput} max={endInput} onChange={(event) => { setStartInput(event.target.value); setFollowingLive(false); setActiveWindow(""); }} /></label>
          <label>Observation end · HKT<input type="datetime-local" value={endInput} min={startInput} onChange={(event) => { setEndInput(event.target.value); setFollowingLive(false); setActiveWindow(""); }} /></label>
          <button className={styles.runButton} disabled={loading} onClick={() => void load()}>{loading ? "Updating…" : "Update prediction"}</button>
          <p className={styles.windowRule}>Observation is capped at 3D because leveraged ETFs reset daily. Changing this window never refits the model.</p>
        </section>

        {error && <div className={styles.errorBox}><strong>Prediction unavailable</strong><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}

        {analysis && selected && <>
          <section className={styles.heroCard}>
            <div className={styles.heroCopy}><span className={styles.kindPill}>{selected.kind.replaceAll("-", " ")}</span><h2>{selected.title}</h2><p>{selected.thesis}</p><small>{selected.caveat}</small></div>
            <div className={`${styles.signal} ${styles[analysis.model.quality === "weak" ? "watch" : analysis.stats.status]}`}><span>PREDICTION SIGNAL</span><strong>{signalLabel}</strong><b>{formatNumber(analysis.stats.zScore)}σ</b><small>{analysis.model.quality === "weak" ? "Holdout validation is too weak for a confident dislocation call." : `Asset 2 is ${formatPct(analysis.stats.predictionError)} away from theory.`}</small></div>
          </section>

          <section className={styles.predictionGrid}>
            <article><span>Asset 1 observed move</span><strong className={analysis.stats.asset1Return >= 0 ? styles.positive : styles.negative}>{formatPct(analysis.stats.asset1Return)}</strong><small>{selected.asset1.label} · model input</small></article>
            <article className={styles.theoryMetric}><span>Asset 2 theoretical move</span><strong>{formatPct(analysis.stats.asset2Theoretical)}</strong><small>α × hours + β × Asset 1</small></article>
            <article><span>Asset 2 actual move</span><strong className={analysis.stats.asset2Actual >= 0 ? styles.positive : styles.negative}>{formatPct(analysis.stats.asset2Actual)}</strong><small>{selected.asset2.label} · observed</small></article>
            <article><span>Prediction error</span><strong className={Math.abs(analysis.stats.zScore) >= 2 ? styles.negative : ""}>{formatPct(analysis.stats.predictionError, 3)}</strong><small>Actual − theoretical · {formatNumber(analysis.stats.zScore)}σ</small></article>
          </section>

          <section className={styles.modelPanel}>
            <div className={styles.modelHead}><div><span>FROZEN MODEL CARD</span><h3>Trained once, validated out of sample</h3><p>{formatDate(analysis.model.trainingStart)} — {formatDate(analysis.model.trainingEnd)} HKT · first 75% train / final 25% validation · hourly log returns</p></div><b className={styles[analysis.model.quality]}>{analysis.model.quality}</b></div>
            <div className={styles.modelMetrics}>
              <div><span>Learned β</span><strong>{formatNumber(analysis.model.beta, 3)}</strong><small>Asset 2 per Asset 1</small></div>
              <div><span>Reference β</span><strong>{analysis.model.referenceBeta === null ? "Empirical" : formatNumber(analysis.model.referenceBeta, 2)}</strong><small>Issuer / structural target</small></div>
              <div><span>Holdout correlation</span><strong>{analysis.model.validationCorrelation.toFixed(3)}</strong><small>{analysis.model.validationSamples} unseen samples</small></div>
              <div><span>Holdout R²</span><strong>{analysis.model.validationR2.toFixed(3)}</strong><small>Explained Asset 2 variance</small></div>
              <div><span>Holdout MAE</span><strong>{analysis.model.validationMaePct.toFixed(3)}%</strong><small>Per hourly prediction</small></div>
              <div><span>β drift</span><strong>{(analysis.model.betaDrift * 100).toFixed(1)}%</strong><small>Train versus holdout</small></div>
            </div>
          </section>

          <section className={styles.chartPanel}><div className={styles.panelHead}><div><span>THEORETICAL RETURN ENGINE</span><h3>Asset 2 actual versus model</h3></div><div className={styles.legend}><span><i className={styles.legendA} />Asset 1 actual</span><span><i className={styles.legendB} />Asset 2 actual</span><span><i className={styles.legendTheory} />Asset 2 theoretical</span></div></div><PredictionChart points={analysis.points} relationship={selected} /></section>

          <section className={styles.chartPanel}><div className={styles.panelHead}><div><span>PREDICTION ERROR MONITOR</span><h3>Actual Asset 2 minus theory</h3></div><p>Watch at ±1.5σ · dislocation at ±2σ · suppressed when model quality is weak.</p></div><ResidualChart points={analysis.points} /></section>

          <section className={styles.methodPanel}>
            <div><span>MODEL TRAINING</span><h3>The selected window is not a backtest.</h3><p>Each coefficient is estimated from a fixed 45-day hourly history ending three days before the live observation period. The final 25% is kept out of training and used to report correlation, R², error and coefficient drift. The same daily-cached coefficient is then reused for every refresh.</p></div>
            <div><span>PREDICTION EQUATION</span><h3>Asset 2 = α × time + β × Asset 1.</h3><p>The model works in log-return space. It converts Asset 1&apos;s cumulative move over the selected period into Asset 2&apos;s theoretical move, then compares that number with Asset 2&apos;s actual return. Funding, liquidity and oracle timing remain outside the regression.</p></div>
          </section>

          <section className={styles.sources}><div><span>RELATIONSHIP RESEARCH</span><h3>Issuer objectives and underlying links</h3></div><div className={styles.sourceGrid}>
            <a href="https://www.invesco.com/content/dam/invesco/hk/en/pdf/factsheet/Invesco_QQQ_factsheet_EN.pdf" target="_blank" rel="noreferrer"><b>Invesco QQQ</b><small>Nasdaq-100 tracking objective ↗</small></a>
            <a href="https://www.proshares.com/our-etfs/leveraged-and-inverse/tbt" target="_blank" rel="noreferrer"><b>ProShares TBT</b><small>−2× daily Treasury objective ↗</small></a>
            <a href="https://www.direxion.com/product/daily-20-year-treasury-bull-bear-3x-etfs" target="_blank" rel="noreferrer"><b>Direxion TMF</b><small>+3× daily Treasury objective ↗</small></a>
            <a href="https://www.direxion.com/product/daily-small-cap-bull-bear-3x-etfs" target="_blank" rel="noreferrer"><b>Direxion TZA</b><small>−3× Russell 2000 daily target ↗</small></a>
            <a href="https://graniteshares.com/etfs/mvll/" target="_blank" rel="noreferrer"><b>GraniteShares MVLL</b><small>+2× MRVL daily target ↗</small></a>
            <a href="https://www.sec.gov/Archives/edgar/data/1587982/000121390026057930/ea0291169-05_497.htm" target="_blank" rel="noreferrer"><b>Tradr SNXX filing</b><small>+2× SNDK daily fund ↗</small></a>
            <a href="https://www.sec.gov/Archives/edgar/data/1424958/000119312526078542/d51121d497k.htm" target="_blank" rel="noreferrer"><b>Direxion MUU filing</b><small>+2× MU daily objective ↗</small></a>
            <a href="https://www.vaneck.com/us/en/investments/semiconductor-etf-smh-fact-sheet.pdf" target="_blank" rel="noreferrer"><b>VanEck SMH</b><small>Semiconductor basket composition ↗</small></a>
          </div></section>
        </>}
      </div>
    </section>
    <footer className={styles.footer}>Research analytics only. A theoretical return is a model estimate, not a guaranteed trade or proof of arbitrage. Leveraged and inverse ETFs pursue daily objectives and can diverge materially over longer periods.</footer>
  </div></main>;
}
