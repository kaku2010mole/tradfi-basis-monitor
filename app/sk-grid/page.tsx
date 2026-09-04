"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import PaperGrid from "./PaperGrid";
import {
  BacktestResult, GridParams, GridPoint, SignalPoint, computeSignals, diagnostics, recommend, runBacktest, splitIndex,
} from "./strategy";

type MarketLeg = {
  venue: string; symbol: string; mark: number; oracle: number; mid: number | null; funding: number; fundingIntervalHours: number; openInterest: number; dayVolume: number;
  premium: number; impactBid: number | null; impactAsk: number | null; szDecimals: number; maxLeverage: number; growthMode: boolean;
};
type BookSummary = { time: number; bid: number | null; ask: number | null; spreadBps: number | null; depth10Bps: number; depth25Bps: number };
type GridFeed = {
  ok: boolean; serverTime: number; interval: string; definition: { id: string; label: string; shortLabel: string; venue: string; conversionRatio: number; premiumLabel: string; conversionNote: string };
  availablePairs: Array<{ id: string; label: string; shortLabel: string; venue: string; interval: string }>;
  pair: { x: MarketLeg; y: MarketLeg }; books: { x: BookSummary; y: BookSummary };
  points: GridPoint[]; coverage: { first: number; last: number; bars: number; days: number; fundingRowsX: number; fundingRowsY: number };
  assumptions: { makerFeeBps: number; takerFeeBps: number; feeNote: string };
};

const DEFAULT_PARAMS: GridParams = {
  capital: 10_000,
  lookbackDays: 7,
  entryZ: 1.5,
  gridStepZ: 0.6,
  exitZ: 0.35,
  stopZ: 3.8,
  maxLayers: 3,
  layerGross: 0.25,
  maxHoldHours: 48,
  feeBps: 0.9,
  slippageBps: 1,
  includeFunding: true,
};

const PRESETS: Record<string, Partial<GridParams>> = {
  Conservative: { entryZ: 2, gridStepZ: 0.8, exitZ: 0.4, stopZ: 4.2, maxLayers: 2, layerGross: 0.2, maxHoldHours: 48 },
  Balanced: { entryZ: 1.5, gridStepZ: 0.6, exitZ: 0.35, stopZ: 3.8, maxLayers: 3, layerGross: 0.25, maxHoldHours: 48 },
  Aggressive: { entryZ: 1.15, gridStepZ: 0.4, exitZ: 0.2, stopZ: 3.3, maxLayers: 4, layerGross: 0.3, maxHoldHours: 72 },
};

function fmt(value: number, digits = 2) {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function compact(value: number) { return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function signed(value: number, suffix = "%", digits = 2) { return `${value >= 0 ? "+" : ""}${fmt(value, digits)}${suffix}`; }
function percentile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}
function hkt(time: number, date = false) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong", ...(date ? { day: "2-digit", month: "short" } : {}), hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(time);
}

function premiumAnalytics(feed: GridFeed) {
  const series = feed.points.map((point) => ({ time: point.time, premium: (feed.definition.conversionRatio * point.y / point.x - 1) * 100 }));
  const current = (feed.definition.conversionRatio * feed.pair.y.mark / feed.pair.x.mark - 1) * 100;
  const windows = [7, 14, 28, Math.max(29, Math.ceil(feed.coverage.days))].map((days, index, all) => {
    const sample = series.filter((point) => point.time >= series.at(-1)!.time - days * 86_400_000).map((point) => point.premium);
    const row = { days, label: index === all.length - 1 ? "ALL" : `${days}D`, p05: percentile(sample, 0.05), p10: percentile(sample, 0.10), p25: percentile(sample, 0.25), median: percentile(sample, 0.50), p75: percentile(sample, 0.75), p90: percentile(sample, 0.90), p95: percentile(sample, 0.95) };
    return { ...row, currentPercentile: sample.filter((value) => value <= current).length / Math.max(1, sample.length) * 100 };
  });
  const recent = windows[1];
  const rawStep = Math.max(0.01, (recent.p90 - recent.p10) / 8);
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
  const step = feed.definition.id === "skhx-skhy" ? 0.5 : steps.find((candidate) => candidate >= rawStep) ?? 5;
  const sample14 = series.filter((point) => point.time >= series.at(-1)!.time - 14 * 86_400_000);
  const crossings = [];
  const firstLevel = Math.floor(recent.p05 / step) * step;
  const lastLevel = Math.ceil(recent.p95 / step) * step;
  for (let level = firstLevel; level <= lastLevel + step / 2; level += step) {
    let state = 0, flips = 0;
    const flipTimes: number[] = [];
    for (const point of sample14) {
      let next = state;
      if (point.premium <= level - step * 0.4) next = -1;
      if (point.premium >= level + step * 0.4) next = 1;
      if (state && next !== state) { flips += 1; flipTimes.push(point.time); }
      state = next;
    }
    const intervals = flipTimes.slice(1).map((time, index) => (time - flipTimes[index]) / 3_600_000);
    crossings.push({ level, flips, roundTrips: Math.floor(flips / 2), perWeek: flips / 2, medianHours: intervals.length ? percentile(intervals, 0.5) : null });
  }
  crossings.sort((a, b) => b.perWeek - a.perWeek);
  const bandLow = Math.floor(recent.p25 / step) * step;
  const bandHigh = Math.ceil(recent.p90 / step) * step;
  const status = current > recent.p95 ? "ABOVE 14D P95" : current < recent.p05 ? "BELOW 14D P05" : current > recent.p75 ? "UPPER BAND" : current < recent.p25 ? "LOWER BAND" : "CORE BAND";
  return { current, windows, crossings: crossings.slice(0, 8), step, bandLow, bandHigh, status };
}

function SpreadChart({ signals, params, labelX, labelY, conversionRatio, premiumLabel }: { signals: SignalPoint[]; params: GridParams; labelX: string; labelY: string; conversionRatio: number; premiumLabel: string }) {
  const [range, setRange] = useState<"7D" | "30D" | "ALL">("30D");
  const [metric, setMetric] = useState<"z" | "premium">("z");
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const shown = useMemo(() => {
    if (!signals.length || range === "ALL") return signals;
    const cutoff = signals.at(-1)!.time - (range === "7D" ? 7 : 30) * 86_400_000;
    return signals.filter((point) => point.time >= cutoff);
  }, [signals, range]);
  const W = 1160, H = 470, L = 64, R = 30, topA = 35, bottomA = 225, topB = 285, bottomB = 430;
  const t0 = shown[0]?.time ?? 0, t1 = shown.at(-1)?.time ?? 1;
  const baseX = shown[0]?.x || 1, baseY = shown[0]?.y || 1;
  const indexedX = shown.map((point) => point.x / baseX * 100);
  const indexedY = shown.map((point) => point.y / baseY * 100);
  const premiums = shown.map((point) => (conversionRatio * point.y / point.x - 1) * 100);
  const pMin = Math.min(...indexedX, ...indexedY), pMax = Math.max(...indexedX, ...indexedY);
  const zLimit = Math.max(4.5, params.stopZ + 0.3, ...shown.map((point) => Math.abs(point.z ?? 0)));
  const premiumMin = premiums.length ? Math.min(...premiums) : -1;
  const premiumMax = premiums.length ? Math.max(...premiums) : 1;
  const premiumPad = Math.max(0.01, (premiumMax - premiumMin) * 0.12);
  const x = (time: number) => L + (time - t0) / Math.max(1, t1 - t0) * (W - L - R);
  const yPrice = (value: number) => bottomA - (value - pMin) / Math.max(1e-9, pMax - pMin) * (bottomA - topA);
  const yZ = (value: number) => bottomB - (value + zLimit) / (2 * zLimit) * (bottomB - topB);
  const yPremium = (value: number) => bottomB - (value - (premiumMin - premiumPad)) / Math.max(1e-9, premiumMax - premiumMin + 2 * premiumPad) * (bottomB - topB);
  const yMetric = metric === "z" ? yZ : yPremium;
  const path = (values: Array<number | null>, y: (value: number) => number) => {
    let started = false;
    return values.map((value, index) => {
      if (value === null) return "";
      const command = started ? "L" : "M";
      started = true;
      return `${command}${x(shown[index].time).toFixed(1)},${y(value).toFixed(1)}`;
    }).join(" ");
  };
  const active = hover === null ? null : shown[hover];
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !shown.length) return;
    const px = (event.clientX - rect.left) / rect.width * W;
    const target = t0 + Math.max(0, Math.min(1, (px - L) / (W - L - R))) * (t1 - t0);
    let best = 0;
    shown.forEach((point, index) => { if (Math.abs(point.time - target) < Math.abs(shown[best].time - target)) best = index; });
    setHover(best);
  };

  return <div className="grid-chart-card">
    <div className="grid-chart-head">
      <div className="grid-legend"><span className="gx" />{labelX} indexed <span className="gy" />{labelY} indexed <span className="gz" />Rolling residual z-score</div>
      <div className="grid-chart-actions"><div className="grid-range">{(["z", "premium"] as const).map((item) => <button key={item} className={metric === item ? "active" : ""} onClick={() => setMetric(item)}>{item === "z" ? "Z-SCORE" : "PREMIUM"}</button>)}</div><div className="grid-range">{(["7D", "30D", "ALL"] as const).map((item) => <button key={item} className={range === item ? "active" : ""} onClick={() => setRange(item)}>{item}</button>)}</div></div>
    </div>
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`Interactive ${labelX} and ${labelY} normalized prices and residual spread chart`}>
      {[topA, bottomA, topB, metric === "z" ? yZ(0) : yPremium((premiumMin + premiumMax) / 2), bottomB].map((value, index) => <line key={index} x1={L} x2={W - R} y1={value} y2={value} className="grid-line" />)}
      {metric === "z" && [params.entryZ, -params.entryZ, params.entryZ + params.gridStepZ, -(params.entryZ + params.gridStepZ), params.stopZ, -params.stopZ].map((value) => <line key={value} x1={L} x2={W - R} y1={yZ(value)} y2={yZ(value)} className={Math.abs(value) === params.stopZ ? "grid-stop" : "grid-level"} />)}
      <text x={L} y={20} className="grid-axis-title">Indexed price · visible range starts at 100</text>
      <text x={L} y={270} className="grid-axis-title">{metric === "z" ? "Log-price residual · rolling z-score" : `${premiumLabel} · conversion-adjusted`}</text>
      {metric === "z" ? <><text x={L - 10} y={yZ(params.entryZ) + 4} textAnchor="end" className="grid-axis">+{params.entryZ.toFixed(1)}σ</text><text x={L - 10} y={yZ(0) + 4} textAnchor="end" className="grid-axis">0</text><text x={L - 10} y={yZ(-params.entryZ) + 4} textAnchor="end" className="grid-axis">−{params.entryZ.toFixed(1)}σ</text></> : <><text x={L - 10} y={topB + 4} textAnchor="end" className="grid-axis">{fmt(premiumMax + premiumPad, 2)}%</text><text x={L - 10} y={bottomB + 4} textAnchor="end" className="grid-axis">{fmt(premiumMin - premiumPad, 2)}%</text></>}
      <path d={path(indexedX, yPrice)} className="grid-path gx" />
      <path d={path(indexedY, yPrice)} className="grid-path gy" />
      <path d={path(metric === "z" ? shown.map((point) => point.z) : premiums, yMetric)} className="grid-path gz" />
      {active && <>
        <line x1={x(active.time)} x2={x(active.time)} y1={topA} y2={bottomB} className="grid-crosshair" />
        <g transform={`translate(${Math.max(L, Math.min(W - 245, x(active.time) - 105))},${topA + 10})`}>
          <rect width="225" height="102" rx="7" className="grid-tooltip-bg" />
          <text x="12" y="20" className="grid-tooltip-muted">{hkt(active.time, true)} HKT</text>
          <text x="12" y="41" className="grid-tooltip">{labelX} {fmt(active.x, 2)} · {labelY} {fmt(active.y, 2)}</text>
          <text x="12" y="62" className="grid-tooltip">Ratio {fmt(active.x / active.y, 4)}</text>
          <text x="12" y="79" className="grid-tooltip">Z-score {active.z === null ? "warming up" : signed(active.z, "σ", 2)}</text>
          <text x="12" y="96" className="grid-tooltip">Premium {signed((conversionRatio * active.y / active.x - 1) * 100)}</text>
        </g>
      </>}
      {shown.length > 1 && <><text x={L} y={462} className="grid-axis">{hkt(t0, true)}</text><text x={W - R} y={462} textAnchor="end" className="grid-axis">{hkt(t1, true)}</text></>}
    </svg>
  </div>;
}

function Metric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return <div className={`grid-metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function BacktestTable({ full, train, test }: { full: BacktestResult; train: BacktestResult; test: BacktestResult }) {
  const rows = [{ label: "Full sample", result: full }, { label: "Training 65%", result: train }, { label: "Holdout 35%", result: test }];
  return <div className="grid-table-wrap"><table><thead><tr><th>Window</th><th>Net return</th><th>Max DD</th><th>Sharpe</th><th>Win rate</th><th>Cycles</th><th>Avg hold</th><th>Fees</th><th>Funding</th></tr></thead><tbody>
    {rows.map(({ label, result }) => <tr key={label}><td>{label}<small>{fmt(result.days, 0)} days</small></td><td className={result.returnPct >= 0 ? "positive" : "negative"}>{signed(result.returnPct)}</td><td>−{fmt(result.maxDrawdownPct)}%</td><td>{fmt(result.sharpe)}</td><td>{fmt(result.winRatePct, 1)}%</td><td>{result.cycles}</td><td>{fmt(result.avgHoldHours, 1)}h</td><td>−{fmt(result.feesPct, 2)}%</td><td className={result.fundingPct >= 0 ? "positive" : "negative"}>{signed(result.fundingPct)}</td></tr>)}
  </tbody></table></div>;
}

export default function SkGridPage() {
  const [feed, setFeed] = useState<GridFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPair, setSelectedPair] = useState("skhx-skhy");
  const [params, setParams] = useState<GridParams>(DEFAULT_PARAMS);
  const [execution, setExecution] = useState<"taker" | "maker">("taker");
  const appliedRecommendation = useRef(false);
  const feedAvailable = feed !== null;

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/sk-grid?pair=${encodeURIComponent(selectedPair)}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Live pair feed unavailable");
        if (!stopped) { setFeed(data); setError(null); }
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : "Live pair feed unavailable");
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [selectedPair]);

  useEffect(() => {
    if (!feedAvailable) return;
    let stopped = false;
    const refreshLive = async () => {
      try {
        const response = await fetch(`/api/sk-grid?pair=${encodeURIComponent(selectedPair)}&live=1`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Live BBO unavailable");
        if (!stopped) {
          setFeed((current) => current?.definition.id === selectedPair ? { ...current, serverTime: data.serverTime, pair: data.pair, books: data.books } : current);
          setError(null);
        }
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : "Live BBO unavailable");
      }
    };
    const initial = window.setTimeout(refreshLive, 1_000);
    const timer = window.setInterval(refreshLive, 5_000);
    return () => { stopped = true; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [feedAvailable, selectedPair]);

  const candidates = useMemo(() => feed ? recommend(feed.points, {
    ...DEFAULT_PARAMS,
    capital: params.capital,
    feeBps: execution === "taker" ? feed.assumptions.takerFeeBps : feed.assumptions.makerFeeBps,
    slippageBps: execution === "taker" ? 1 : 0.3,
  }) : [], [feed, execution, params.capital]);
  useEffect(() => {
    if (candidates[0] && !appliedRecommendation.current) {
      appliedRecommendation.current = true;
      setParams((current) => ({ ...candidates[0].params, capital: current.capital }));
    }
  }, [candidates]);
  const modelPoints = useMemo(() => {
    if (!feed) return [];
    const current: GridPoint = { time: Math.max(feed.serverTime, (feed.points.at(-1)?.time ?? 0) + 1), x: feed.pair.x.mark, y: feed.pair.y.mark, fundingX: feed.pair.x.funding, fundingY: feed.pair.y.funding };
    return [...feed.points.filter((point) => point.time < current.time), current];
  }, [feed]);
  const signals = useMemo(() => computeSignals(modelPoints, params.lookbackDays), [modelPoints, params.lookbackDays]);
  const split = useMemo(() => splitIndex(signals), [signals]);
  const results = useMemo(() => ({
    full: runBacktest(signals, params),
    train: runBacktest(signals, params, 1, split),
    test: runBacktest(signals, params, split, signals.length),
  }), [signals, params, split]);
  const holdoutGross = useMemo(() => runBacktest(signals, { ...params, feeBps: 0, slippageBps: 0 }, split, signals.length), [signals, params, split]);
  const holdoutOneBps = useMemo(() => runBacktest(signals, { ...params, feeBps: 1, slippageBps: 0 }, split, signals.length), [signals, params, split]);
  const diag = useMemo(() => diagnostics(signals), [signals]);
  const bands = useMemo(() => feed ? premiumAnalytics(feed) : null, [feed]);
  const bandExtreme = bands?.status.includes("P95") || bands?.status.includes("P05");
  const latest = signals.at(-1);
  const z = latest?.z ?? 0;
  const side = z > 0 ? -1 : 1;
  const labelX = feed?.pair.x.symbol.replace("xyz:", "") ?? "LEG X";
  const labelY = feed?.pair.y.symbol.replace("xyz:", "") ?? "LEG Y";
  const action = Math.abs(z) < params.exitZ ? "FLAT / TAKE PROFIT" : Math.abs(z) < params.entryZ ? "WAIT" : side > 0 ? `LONG ${labelX} · SHORT ${labelY}` : `SHORT ${labelX} · LONG ${labelY}`;
  const suggestedLayers = Math.abs(z) < params.entryZ ? 0 : Math.min(params.maxLayers, 1 + Math.floor((Math.abs(z) - params.entryZ) / params.gridStepZ));
  const beta = latest?.beta ?? 1;
  const weightX = 1 / (1 + Math.abs(beta));
  const weightY = Math.abs(beta) / (1 + Math.abs(beta));
  const grossPerLayer = params.capital * params.layerGross;
  const qtyX = feed ? grossPerLayer * weightX / feed.pair.x.mark : 0;
  const qtyY = feed ? grossPerLayer * weightY / feed.pair.y.mark : 0;
  const fundingCarryHourly = feed ? side * (-weightX * feed.pair.x.funding + weightY * feed.pair.y.funding) * params.layerGross * 100 : 0;
  const breakEvenCostBps = holdoutOneBps.feesPct > 0 ? Math.max(0, holdoutGross.returnPct / holdoutOneBps.feesPct) : 0;
  const deployable = results.train.returnPct > 0 && results.test.returnPct > 0 && results.test.cycles >= 5;

  const updateNumber = (key: keyof GridParams, value: number) => setParams((current) => ({ ...current, [key]: value }));
  const setExecutionMode = (mode: "taker" | "maker") => {
    setExecution(mode);
    if (feed) updateNumber("feeBps", mode === "taker" ? feed.assumptions.takerFeeBps : feed.assumptions.makerFeeBps);
  };
  const selectPair = (pairId: string) => {
    appliedRecommendation.current = false;
    setFeed(null);
    setSelectedPair(pairId);
  };

  return <main className="grid-page">
    <header className="grid-topbar">
      <a className="grid-brand" href="/sk-grid"><span>PAIR/GRID</span><strong>{feed?.definition.label ?? "RELATIVE VALUE"}</strong></a>
      <PageSwitcher active="sk-grid" />
      <div className={`grid-status ${error ? "offline" : ""}`}><i />{feed ? `LIVE · ${hkt(feed.serverTime)} HKT` : "CONNECTING"}</div>
    </header>

    <section className="grid-hero">
      <div><p className="grid-eyebrow">RELATIVE-VALUE GRID LAB · {(feed?.interval ?? "15m").toUpperCase()}</p><h1>Trade the relationship,<br />not the direction.</h1></div>
      <div className={`grid-action-card ${side > 0 ? "long" : "short"} ${deployable ? "" : "blocked"}`}>
        <span>MODEL ACTION</span><strong>{action}</strong><small>{suggestedLayers ? `${suggestedLayers} of ${params.maxLayers} layers indicated` : "No new layer indicated"}</small>
        {!deployable && <em>RESEARCH ONLY · NO POSITIVE HOLDOUT EDGE AFTER CURRENT COSTS</em>}
      </div>
    </section>

    {error && <div className="grid-error">{error}. Retrying automatically; the last complete snapshot remains visible.</div>}

    <section className="grid-pair-picker" aria-label="Pair selection">
      {(feed?.availablePairs ?? [
        { id: "skhx-skhy", label: "SKHX / SKHY", shortLabel: "SK semis", venue: "hyperliquid", interval: "15m" },
        { id: "xau-xaut", label: "XAU / XAUT", shortLabel: "Gold · primary", venue: "binance", interval: "1h" },
        { id: "xau-paxg", label: "XAU / PAXG", shortLabel: "Gold · alternate", venue: "binance", interval: "1h" },
        { id: "xaut-paxg", label: "XAUT / PAXG", shortLabel: "Tokenized gold", venue: "binance", interval: "1h" },
      ]).map((pair) => <button key={pair.id} className={selectedPair === pair.id ? "active" : ""} onClick={() => selectPair(pair.id)}><strong>{pair.label}</strong><span>{pair.venue} · {pair.interval}</span></button>)}
    </section>

    <section className="grid-premium-strip">
      <Metric label={`${labelX} mark`} value={feed ? fmt(feed.pair.x.mark) : "—"} />
      <Metric label={`${labelY} mark`} value={feed ? fmt(feed.pair.y.mark) : "—"} />
      <Metric label="Conversion" value={feed ? feed.definition.conversionNote : "—"} />
      <Metric label={feed?.definition.premiumLabel ?? "Mark premium"} value={feed ? signed((feed.definition.conversionRatio * feed.pair.y.mark / feed.pair.x.mark - 1) * 100) : "—"} tone={feed && Math.abs((feed.definition.conversionRatio * feed.pair.y.mark / feed.pair.x.mark - 1) * 100) > 1 ? "attention" : ""} />
      <Metric label={`Sell ${labelY} / buy ${labelX}`} value={feed?.books.y.bid && feed?.books.x.ask ? signed((feed.definition.conversionRatio * feed.books.y.bid / feed.books.x.ask - 1) * 100) : "—"} />
      <Metric label={`Buy ${labelY} / sell ${labelX}`} value={feed?.books.y.ask && feed?.books.x.bid ? signed((feed.definition.conversionRatio * feed.books.y.ask / feed.books.x.bid - 1) * 100) : "—"} />
      <Metric label="Residual z-score" value={latest?.z === null || !latest ? "—" : signed(z, "σ")} tone={Math.abs(z) >= params.entryZ ? "attention" : ""} />
      <Metric label="Rolling hedge β" value={fmt(beta, 3)} />
      <Metric label="14d return corr." value={fmt(diag.correlation, 3)} />
      <Metric label="Mean-reversion half-life" value={diag.halfLifeHours > 300 ? ">300h" : `${fmt(diag.halfLifeHours, 1)}h`} />
    </section>

    <PaperGrid
      pairId={selectedPair}
      labelX={labelX}
      labelY={labelY}
      latest={latest}
      quote={feed ? { bidX: feed.books.x.bid ?? feed.pair.x.mark, askX: feed.books.x.ask ?? feed.pair.x.mark, bidY: feed.books.y.bid ?? feed.pair.y.mark, askY: feed.books.y.ask ?? feed.pair.y.mark } : null}
      params={params}
    />

    <section className="grid-band-section">
      <div className="grid-section-title"><div><p className="grid-eyebrow">DYNAMIC PREMIUM BAND</p><h2>Where the premium actually travels</h2></div><div><span>Signal state</span><strong>{bands?.status ?? "—"}</strong></div></div>
      <div className="grid-band-cards">
        <Metric label="Live mark premium" value={bands ? signed(bands.current) : "—"} tone={bandExtreme ? "warning" : ""} />
        <Metric label="14d paper-trading band" value={bands ? `${fmt(bands.bandLow, 2)}% → ${fmt(bands.bandHigh, 2)}%` : "—"} />
        <Metric label="Indicative grid spacing" value={bands ? `${fmt(bands.step, bands.step < 0.1 ? 2 : 1)} pp` : "—"} />
        <Metric label="Band policy" value={bandExtreme ? "PAUSE / SMALLEST FADE" : "TWO-SIDED PAPER GRID"} tone={bandExtreme ? "warning" : ""} />
      </div>
      <div className="grid-band-layout">
        <div className="grid-table-wrap"><table><thead><tr><th>Window</th><th>P05</th><th>P10</th><th>P25</th><th>Median</th><th>P75</th><th>P90</th><th>P95</th><th>Live pctile</th></tr></thead><tbody>
          {(bands?.windows ?? []).map((row) => <tr key={row.label}><td>{row.label}</td><td>{signed(row.p05)}</td><td>{signed(row.p10)}</td><td>{signed(row.p25)}</td><td><strong>{signed(row.median)}</strong></td><td>{signed(row.p75)}</td><td>{signed(row.p90)}</td><td>{signed(row.p95)}</td><td>{fmt(row.currentPercentile, 1)}%</td></tr>)}
        </tbody></table></div>
        <div className="grid-crossing-card"><div className="grid-subhead"><h3>Most-travelled levels · 14D</h3><span>{bands ? `${fmt(bands.step, bands.step < 0.1 ? 2 : 1)} pp ladder · hysteresis applied` : "—"}</span></div><div className="grid-crossing-list">
          {(bands?.crossings ?? []).map((row) => <div key={row.level}><strong>{signed(row.level)}</strong><span>{fmt(row.perWeek, 1)} crosses / week</span><span>{row.roundTrips} round trips</span><span>{row.medianHours === null ? "—" : `${fmt(row.medianHours, 1)}h median`}</span></div>)}
        </div></div>
      </div>
      {feed?.definition.id === "skhx-skhy" && <div className="grid-benchmark-strip"><div><span>TSMC ADR parity reference</span><strong>1 ADS = 5 Taiwan shares</strong></div><div><span>2Y premium median</span><strong>20.04%</strong></div><div><span>2Y P05–P95</span><strong>11.55%–27.55%</strong></div><div><span>Recent 60 common days median</span><strong>13.75%</strong></div><div><span>Interpretation</span><strong>Positive ADR premium can persist; SK is still cross-sectionally elevated</strong></div></div>}
      <p className="grid-footnote">Premium bands are descriptive, not a parity target. Crossing counts use a hysteresis buffer to reduce one-tick noise. The TSMC benchmark uses same-calendar-date closes and is non-synchronous across Taiwan and New York.</p>
    </section>

    <section className="grid-chart-section">
      <div className="grid-section-title"><div><p className="grid-eyebrow">LIVE RELATIONSHIP</p><h2>Price and residual spread</h2></div><div><span>Common history</span><strong>{feed ? `${fmt(feed.coverage.days, 0)} days · ${feed.coverage.bars.toLocaleString()} bars` : "—"}</strong></div></div>
      <SpreadChart signals={signals} params={params} labelX={labelX} labelY={labelY} conversionRatio={feed?.definition.conversionRatio ?? 1} premiumLabel={feed?.definition.premiumLabel ?? "Pair premium"} />
      <div className="grid-market-tape">
        <div><span>{labelX} book</span><strong>{feed?.books.x.spreadBps == null ? "—" : `${fmt(feed.books.x.spreadBps, 2)} bps`}</strong><small>${feed ? compact(feed.books.x.depth10Bps) : "—"} within 10 bps</small></div>
        <div><span>{labelY} book</span><strong>{feed?.books.y.spreadBps == null ? "—" : `${fmt(feed.books.y.spreadBps, 2)} bps`}</strong><small>${feed ? compact(feed.books.y.depth10Bps) : "—"} within 10 bps</small></div>
        <div><span>{labelX} funding / hour</span><strong>{feed ? signed(feed.pair.x.funding * 100, "%", 4) : "—"}</strong><small>{feed ? `$${compact(feed.pair.x.dayVolume)} 24h volume` : "—"}</small></div>
        <div><span>{labelY} funding / hour</span><strong>{feed ? signed(feed.pair.y.funding * 100, "%", 4) : "—"}</strong><small>{feed ? `$${compact(feed.pair.y.dayVolume)} 24h volume` : "—"}</small></div>
        <div><span>Current carry / layer</span><strong className={fundingCarryHourly >= 0 ? "positive" : "negative"}>{signed(fundingCarryHourly, "%/h", 4)}</strong><small>At indicated pair direction</small></div>
      </div>
    </section>

    <section className="grid-lab-section">
      <div className="grid-section-title"><div><p className="grid-eyebrow">CONFIGURATION</p><h2>Grid parameters</h2></div><button className="grid-recommend" disabled={!candidates[0]} onClick={() => candidates[0] && setParams({ ...candidates[0].params, capital: params.capital })}>{deployable ? "Apply recommended" : "Apply research candidate"}</button></div>
      <div className="grid-lab-layout">
        <aside className="grid-controls">
          <div className="grid-presets">{Object.entries(PRESETS).map(([name, preset]) => <button key={name} onClick={() => setParams((current) => ({ ...current, ...preset }))}>{name}</button>)}</div>
          <div className="grid-control-grid">
            <label><span>Capital · USDC</span><input type="number" min="100" step="100" value={params.capital} onChange={(event) => updateNumber("capital", Number(event.target.value))} /></label>
            <label><span>Lookback · days</span><input type="number" min="3" max="21" step="1" value={params.lookbackDays} onChange={(event) => updateNumber("lookbackDays", Number(event.target.value))} /></label>
            <label><span>First entry · σ</span><input type="number" min="0.5" max="3" step="0.05" value={params.entryZ} onChange={(event) => updateNumber("entryZ", Number(event.target.value))} /></label>
            <label><span>Grid step · σ</span><input type="number" min="0.2" max="1.5" step="0.05" value={params.gridStepZ} onChange={(event) => updateNumber("gridStepZ", Number(event.target.value))} /></label>
            <label><span>Take-profit · σ</span><input type="number" min="0" max="1.2" step="0.05" value={params.exitZ} onChange={(event) => updateNumber("exitZ", Number(event.target.value))} /></label>
            <label><span>Stop · σ</span><input type="number" min="2" max="6" step="0.1" value={params.stopZ} onChange={(event) => updateNumber("stopZ", Number(event.target.value))} /></label>
            <label><span>Maximum layers</span><input type="number" min="1" max="6" step="1" value={params.maxLayers} onChange={(event) => updateNumber("maxLayers", Number(event.target.value))} /></label>
            <label><span>Gross / layer · % capital</span><input type="number" min="5" max="75" step="5" value={Math.round(params.layerGross * 100)} onChange={(event) => updateNumber("layerGross", Number(event.target.value) / 100)} /></label>
            <label><span>Maximum hold · hours</span><input type="number" min="4" max="168" step="4" value={params.maxHoldHours} onChange={(event) => updateNumber("maxHoldHours", Number(event.target.value))} /></label>
            <label><span>Execution</span><select value={execution} onChange={(event) => setExecutionMode(event.target.value as "taker" | "maker")}><option value="taker">Taker / immediate</option><option value="maker">Maker / post-only</option></select></label>
            <label><span>Fee / fill · bps</span><input type="number" min="0" max="20" step="0.1" value={params.feeBps} onChange={(event) => updateNumber("feeBps", Number(event.target.value))} /></label>
            <label><span>Slippage / fill · bps</span><input type="number" min="0" max="30" step="0.1" value={params.slippageBps} onChange={(event) => updateNumber("slippageBps", Number(event.target.value))} /></label>
          </div>
          <label className="grid-checkbox"><input type="checkbox" checked={params.includeFunding} onChange={(event) => setParams((current) => ({ ...current, includeFunding: event.target.checked }))} /><span>Include historical hourly funding</span></label>
        </aside>

        <div className="grid-order-card">
          <div><span>INDICATED PAIR</span><strong>{action}</strong></div>
          <dl>
            <div><dt>Gross per layer</dt><dd>${fmt(grossPerLayer, 0)}</dd></div>
            <div><dt>Maximum gross</dt><dd>${fmt(grossPerLayer * params.maxLayers, 0)} · {fmt(params.layerGross * params.maxLayers, 2)}× capital</dd></div>
            <div><dt>{labelX} weight / quantity</dt><dd>{fmt(weightX * 100, 1)}% · {fmt(qtyX, feed?.pair.x.szDecimals ?? 3)}</dd></div>
            <div><dt>{labelY} weight / quantity</dt><dd>{fmt(weightY * 100, 1)}% · {fmt(qtyY, feed?.pair.y.szDecimals ?? 2)}</dd></div>
            <div><dt>Entry ladder</dt><dd>{Array.from({ length: params.maxLayers }, (_, index) => `${fmt(params.entryZ + index * params.gridStepZ, 2)}σ`).join(" · ")}</dd></div>
            <div><dt>Take profit / stop</dt><dd>{fmt(params.exitZ, 2)}σ / {fmt(params.stopZ, 2)}σ</dd></div>
          </dl>
          <p>Quantities are beta-weighted and dollar-neutral by gross exposure. This dashboard does not place orders.</p>
        </div>
      </div>
    </section>

    <section className="grid-results-section">
      <div className="grid-section-title"><div><p className="grid-eyebrow">15-MINUTE WALK-FORWARD SIMULATION</p><h2>Net backtest</h2></div><div><span>Costs included</span><strong>{fmt(params.feeBps, 1)} bps fee + {fmt(params.slippageBps, 1)} bps slippage per fill</strong></div></div>
      <div className="grid-result-cards">
        <Metric label="Deployment verdict" value={deployable ? "PASS" : "NO EDGE AFTER COSTS"} tone={deployable ? "positive" : "negative"} />
        <Metric label="Holdout net return" value={signed(results.test.returnPct)} tone={results.test.returnPct >= 0 ? "positive" : "negative"} />
        <Metric label="Holdout max drawdown" value={`−${fmt(results.test.maxDrawdownPct)}%`} />
        <Metric label="Holdout Sharpe" value={fmt(results.test.sharpe)} />
        <Metric label="Holdout cycles" value={String(results.test.cycles)} />
        <Metric label="Break-even all-in cost" value={`${fmt(breakEvenCostBps, 2)} bps / fill`} tone={breakEvenCostBps < params.feeBps + params.slippageBps ? "warning" : "positive"} />
      </div>
      <BacktestTable full={results.full} train={results.train} test={results.test} />

      <div className="grid-alternatives">
        <div className="grid-subhead"><h3>Training-ranked alternatives</h3><span>Holdout results were not used to rank these rows</span></div>
        <div className="grid-table-wrap"><table><thead><tr><th>Rank</th><th>Lookback</th><th>Entry / step</th><th>Exit</th><th>Max hold</th><th>Train return</th><th>Holdout return</th><th>Holdout DD</th><th>Holdout cycles</th><th /></tr></thead><tbody>
          {candidates.slice(0, 6).map((candidate, index) => <tr key={`${candidate.params.lookbackDays}-${candidate.params.entryZ}-${candidate.params.gridStepZ}-${candidate.params.exitZ}-${candidate.params.maxHoldHours}`}><td>#{index + 1}</td><td>{candidate.params.lookbackDays}d</td><td>{fmt(candidate.params.entryZ, 2)}σ / {fmt(candidate.params.gridStepZ, 2)}σ</td><td>{fmt(candidate.params.exitZ, 2)}σ</td><td>{candidate.params.maxHoldHours}h</td><td className={candidate.train.returnPct >= 0 ? "positive" : "negative"}>{signed(candidate.train.returnPct)}</td><td className={candidate.test.returnPct >= 0 ? "positive" : "negative"}>{signed(candidate.test.returnPct)}</td><td>−{fmt(candidate.test.maxDrawdownPct)}%</td><td>{candidate.test.cycles}</td><td><button onClick={() => setParams({ ...candidate.params, capital: params.capital })}>Use</button></td></tr>)}
        </tbody></table></div>
      </div>

      <div className="grid-method-strip">
        <div><span>Signal</span><strong>Rolling log-price OLS residual</strong></div>
        <div><span>Hedge</span><strong>Dynamic beta · prior data only</strong></div>
        <div><span>Fill model</span><strong>15m close · conservative cost overlay</strong></div>
        <div><span>Funding</span><strong>{params.includeFunding ? "Historical hourly payments included" : "Excluded by user"}</strong></div>
        <div><span>History limit</span><strong>{feed?.definition.id === "skhx-skhy" ? "SKHY inception · recent 5,000 candles" : "Later-listed contract inception"}</strong></div>
      </div>
      <p className="grid-footnote">Recommendation is selected on the first 65% of available common history and reported separately on the final 35%. The sample begins only when SKHY history becomes available, so annualized figures are intentionally omitted from the main view. A live strategy should cap size by SKHY liquidity, use paired or IOC safeguards, and stop if correlation or residual half-life deteriorates.</p>
    </section>
  </main>;
}
