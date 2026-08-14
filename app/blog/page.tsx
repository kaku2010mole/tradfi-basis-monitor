"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import PairExecutionPanel from "../trade/PairExecutionPanel";
import {
  fixedTrainingWindow,
  MAX_OBSERVATION_MS,
  MAX_STATISTICAL_OBSERVATION_MS,
  maxObservationMs,
  PricePoint,
  projectRelationship,
  ProjectionPoint,
  RELATIONSHIPS,
  Relationship,
  TRAINING_INTERVAL,
  trainRelationshipModel,
  TrainedModel,
} from "../lib/relativeValue";
import {
  RELATIVE_VALUE_SIGNAL_EVENT,
  RELATIVE_VALUE_SNAPSHOT_EVENT,
  RELATIVE_VALUE_SNAPSHOT_KEY,
  RelativeValueAlertSignal,
  RelativeValueAlertSnapshot,
} from "../lib/relativeValueAlerts";
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
type RankingRow = { id: string; predictionError: number; actual: number; theoretical: number; beta: number; updatedAt: number };

const QUICK_WINDOWS = [
  { label: "1H", milliseconds: 60 * 60_000 },
  { label: "6H", milliseconds: 6 * 60 * 60_000 },
  { label: "24H", milliseconds: 24 * 60 * 60_000 },
  { label: "3D", milliseconds: MAX_OBSERVATION_MS },
  { label: "7D", milliseconds: MAX_STATISTICAL_OBSERVATION_MS, statisticalOnly: true },
] as const;
const TODAY_ANCHORS = [
  { label: "10:00", hour: 10, minute: 0 },
  { label: "14:30", hour: 14, minute: 30 },
] as const;
const INITIAL_NOW = Date.now();
const HKT_OFFSET_MS = 8 * 60 * 60_000;
const LIVE_REFRESH_MS = 10_000;
const NEUTRAL_UNIT_SHARES = 100;
const DIRECT_BINANCE_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"];
const MODEL_CACHE_PREFIX = "relative-value-fixed-model-v6";
const CUSTOM_RELATIONSHIPS_KEY = "relative-value-custom-relationships-v1";
const HIDDEN_RELATIONSHIPS_KEY = "relative-value-hidden-relationships-v1";
const DIRECT_RANKING_BASELINE_CACHE = new Map<string, Promise<number>>();

type CustomDraft = {
  asset1Venue: "binance" | "hyperliquid";
  asset1Symbol: string;
  asset2Venue: "binance" | "hyperliquid";
  asset2Symbol: string;
  referenceBeta: string;
};

const EMPTY_DRAFT: CustomDraft = { asset1Venue: "binance", asset1Symbol: "", asset2Venue: "binance", asset2Symbol: "", referenceBeta: "" };

const toHktInput = (timestamp: number) => new Date(timestamp + HKT_OFFSET_MS).toISOString().slice(0, 16);
const fromHktInput = (value: string) => Date.parse(`${value}:00+08:00`);
const hktTodayAt = (hour: number, timestamp: number, minute = 0) => {
  const day = new Date(timestamp + HKT_OFFSET_MS).toISOString().slice(0, 10);
  return Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);
};
const latestHktAnchor = (hour: number, timestamp: number, minute = 0) => {
  const today = hktTodayAt(hour, timestamp, minute);
  return today <= timestamp ? today : today - 24 * 60 * 60_000;
};
const anchorDayLabel = (anchor: number, timestamp: number) => new Date(anchor + HKT_OFFSET_MS).toISOString().slice(0, 10) === new Date(timestamp + HKT_OFFSET_MS).toISOString().slice(0, 10) ? "TODAY" : "YESTERDAY";
const INITIAL_TEN = latestHktAnchor(10, INITIAL_NOW);
const INITIAL_START = INITIAL_TEN;
const INITIAL_SELECTION = "10:00";
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
const observationInterval = (start: number, end: number) => end - start > MAX_OBSERVATION_MS ? "5m" : "1m";
const INTERVAL_MS: Record<string, number> = { "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000 };

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

async function directLivePrices(relationship: Relationship) {
  const hyperliquidLegs = [relationship.asset1, relationship.asset2].filter((leg) => leg.venue === "hyperliquid");
  const hyperliquidMids = new Map([...new Set(hyperliquidLegs.map((leg) => leg.symbol.includes(":") ? leg.symbol.split(":", 1)[0] : ""))].map((dex) => [dex, fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dex ? { type: "allMids", dex } : { type: "allMids" }),
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
    return await response.json() as Record<string, string>;
  })] as const));
  const binancePrice = async (symbol: string) => {
    const book = await directBinance<{ bidPrice?: string; askPrice?: string }>(`/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);
    const bid = Number(book.bidPrice);
    const ask = Number(book.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) throw new Error(`${symbol} live midpoint unavailable.`);
    return (bid + ask) / 2;
  };
  const legPrice = async (leg: Relationship["asset1"]) => {
    if (leg.venue === "binance") return binancePrice(leg.symbol);
    const dex = leg.symbol.includes(":") ? leg.symbol.split(":", 1)[0] : "";
    const midsPromise = hyperliquidMids.get(dex);
    if (!midsPromise) throw new Error(`${leg.symbol} live midpoint unavailable.`);
    const mids = await midsPromise;
    const value = Number(mids[leg.symbol]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${leg.symbol} live midpoint unavailable.`);
    return value;
  };
  const [asset1, asset2] = await Promise.all([legPrice(relationship.asset1), legPrice(relationship.asset2)]);
  return { asset1, asset2 };
}

async function rankInBrowser(relationships: Relationship[], start: number, end: number): Promise<RankingRow[]> {
  type Book = { symbol?: string; bidPrice?: string; askPrice?: string };
  const books = await directBinance<Book[]>("/fapi/v1/ticker/bookTicker");
  const bookBySymbol = new Map(books.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
  const hyperLegs = relationships.flatMap((item) => [item.asset1, item.asset2]).filter((leg) => leg.venue === "hyperliquid");
  const dexNames = [...new Set(hyperLegs.map((leg) => leg.symbol.includes(":") ? leg.symbol.split(":", 1)[0] : ""))];
  const dexMids = new Map(await Promise.all(dexNames.map(async (dex) => {
    const response = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dex ? { type: "allMids", dex } : { type: "allMids" }), cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
    return [dex, await response.json() as Record<string, string>] as const;
  })));
  const baseline = (leg: Relationship["asset1"], baselineStart: number) => {
    const key = `${leg.venue}:${leg.symbol}:${baselineStart}`;
    const saved = DIRECT_RANKING_BASELINE_CACHE.get(key);
    if (saved) return saved;
    if (DIRECT_RANKING_BASELINE_CACHE.size > 240) DIRECT_RANKING_BASELINE_CACHE.clear();
    const promise = leg.venue === "binance" ? directBinance<Array<[number, string, string, string, string]>>(`/fapi/v1/klines?${new URLSearchParams({ symbol: leg.symbol, interval: "1m", startTime: String(baselineStart), limit: "1" })}`).then((rows) => Number(rows[0]?.[4])) : fetch("https://api.hyperliquid.xyz/info", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: leg.symbol, interval: "1m", startTime: baselineStart, endTime: baselineStart + 5 * 60_000 } }), cache: "no-store", signal: AbortSignal.timeout(8_000),
    }).then(async (response) => Number((await response.json() as Array<{ c?: string }>)[0]?.c));
    DIRECT_RANKING_BASELINE_CACHE.set(key, promise);
    promise.catch(() => DIRECT_RANKING_BASELINE_CACHE.delete(key));
    return promise;
  };
  const live = (leg: Relationship["asset1"]) => {
    if (leg.venue === "binance") {
      const book = bookBySymbol.get(leg.symbol); const bid = Number(book?.bidPrice); const ask = Number(book?.askPrice);
      return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    }
    const dex = leg.symbol.includes(":") ? leg.symbol.split(":", 1)[0] : "";
    const value = Number(dexMids.get(dex)?.[leg.symbol]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const output: RankingRow[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(5, relationships.length) }, async () => {
    while (cursor < relationships.length) {
      const relationship = relationships[cursor++];
      try {
        const relationshipStart = Math.max(start, end - maxObservationMs(relationship));
        const current1 = live(relationship.asset1); const current2 = live(relationship.asset2);
        if (!current1 || !current2) continue;
        const [base1, base2, model] = await Promise.all([
          baseline(relationship.asset1, relationshipStart), baseline(relationship.asset2, relationshipStart),
          relationship.referenceBeta !== null ? Promise.resolve({ alphaHourly: 0, beta: relationship.referenceBeta }) : directFixedModel(relationship, relationshipStart),
        ]);
        if (![base1, base2].every((value) => Number.isFinite(value) && value > 0)) continue;
        const elapsedHours = Math.max(0, (end - relationshipStart) / 60 / 60_000);
        const theoretical = Math.expm1(model.alphaHourly * elapsedHours + model.beta * Math.log(current1 / base1)) * 100;
        const actual = (current2 / base2 - 1) * 100;
        output.push({ id: relationship.id, predictionError: actual - theoretical, actual, theoretical, beta: model.beta, updatedAt: Date.now() });
      } catch { /* Leave unavailable relationships at the bottom until the next refresh. */ }
    }
  }));
  return output;
}

async function directSeries(leg: Relationship["asset1"], start: number, end: number, interval: string): Promise<PricePoint[]> {
  if (leg.venue === "binance") {
    const rows: Array<[number, string, string, string, string]> = [];
    const step = INTERVAL_MS[interval] ?? 60_000;
    let cursor = start;
    while (cursor <= end && rows.length < 5_000) {
      const params = new URLSearchParams({ symbol: leg.symbol, interval, startTime: String(cursor), endTime: String(end), limit: "1500" });
      const page = await directBinance<Array<[number, string, string, string, string]>>(`/fapi/v1/klines?${params}`);
      if (!page.length) break;
      rows.push(...page);
      const next = page.at(-1)![0] + step;
      if (page.length < 1_500 || next <= cursor) break;
      cursor = next;
    }
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
  const trainingSeries = (leg: Relationship["asset1"]) => directSeries(leg, trainingStart, trainingEnd, TRAINING_INTERVAL).catch((error) => {
    if (relationship.referenceBeta !== null) return [];
    throw error;
  });
  const [asset1Rows, asset2Rows] = await Promise.all([trainingSeries(relationship.asset1), trainingSeries(relationship.asset2)]);
  const model = trainRelationshipModel(asset1Rows, asset2Rows, relationship, trainingStart, trainingEnd);
  try { window.localStorage.setItem(key, JSON.stringify(model)); } catch { /* Browser storage is optional. */ }
  return model;
}

async function analyzeInBrowser(relationship: Relationship, start: number, end: number): Promise<Analysis> {
  const interval = observationInterval(start, end);
  const [model, asset1Rows, asset2Rows, exchangeInfo] = await Promise.all([
    directFixedModel(relationship, start),
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
    generatedAt: Date.now(), interval, observation: { start, end, maxDurationMs: maxObservationMs(relationship) }, relationship, relationships: RELATIONSHIPS.some((item) => item.id === relationship.id) ? RELATIONSHIPS : [...RELATIONSHIPS, relationship], model,
    universe: { count: symbols.length, symbols, typeCounts, candidates: (RELATIONSHIPS.some((item) => item.id === relationship.id) ? RELATIONSHIPS : [...RELATIONSHIPS, relationship]).map((item) => ({ id: item.id, available: [item.asset1, item.asset2].every((leg) => leg.venue === "hyperliquid" || active.has(leg.symbol)) })) },
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

function PredictionErrorChart({ points }: { points: ProjectionPoint[] }) {
  const width = 920;
  const height = 300;
  const padding = { left: 58, right: 24, top: 24, bottom: 42 };
  const alertThreshold = 2;
  const maxMagnitude = Math.max(alertThreshold * 1.15, ...points.map((point) => Math.abs(point.predictionError))) * 1.08;
  const min = -maxMagnitude;
  const max = maxMagnitude;
  const y = (value: number) => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  const latest = points.at(-1)?.predictionError ?? 0;
  return <div className={styles.chartScroll}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Historical prediction error percentage chart">
    <rect x={padding.left} y={y(alertThreshold)} width={width - padding.left - padding.right} height={y(-alertThreshold) - y(alertThreshold)} className={styles.errorBand} />
    {[max, max / 2, 0, min / 2, min].map((value, index) => <g key={index}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className={value === 0 ? styles.zeroLine : styles.gridLine} /><text x={padding.left - 9} y={y(value) + 4} textAnchor="end" className={styles.axisText}>{formatPct(value, 2)}</text></g>)}
    {[alertThreshold, -alertThreshold].map((value) => <line key={value} x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className={styles.predictionAlertLine} />)}
    {[0, .25, .5, .75, 1].map((ratio) => {
      const index = Math.min(points.length - 1, Math.round((points.length - 1) * ratio));
      const x = padding.left + ratio * (width - padding.left - padding.right);
      return <text key={ratio} x={x} y={height - 15} textAnchor={ratio === 0 ? "start" : ratio === 1 ? "end" : "middle"} className={styles.axisText}>{formatTime(points[index].t, points.at(-1)!.t - points[0].t > 24 * 60 * 60_000)}</text>;
    })}
    <path d={linePath(points.map((point) => point.predictionError), width, height, padding, min, max)} className={styles.predictionErrorLine} />
    <circle cx={width - padding.right} cy={y(latest)} r="5" className={Math.abs(latest) >= alertThreshold ? styles.errorHotDot : styles.errorLiveDot} />
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

export default function RelativeValueBlog({ trading = false }: { trading?: boolean } = {}) {
  const initialRelationshipId = trading ? "skhynix-csop2l" : "qqq-ustech";
  const requestRef = useRef<AbortController | null>(null);
  const [relationshipId, setRelationshipId] = useState(initialRelationshipId);
  const [startInput, setStartInput] = useState(() => toHktInput(INITIAL_START));
  const [endInput, setEndInput] = useState(() => toHktInput(INITIAL_NOW));
  const [followingLive, setFollowingLive] = useState(true);
  const [activeWindow, setActiveWindow] = useState(INITIAL_SELECTION);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const analysisRef = useRef<Analysis | null>(null);
  const liveRequestRef = useRef(false);
  const [lastLiveAt, setLastLiveAt] = useState(0);
  const [liveError, setLiveError] = useState("");
  const [livePrices, setLivePrices] = useState<{ relationshipId: string; asset1: number; asset2: number; updatedAt: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [customRelationships, setCustomRelationships] = useState<Relationship[]>([]);
  const [hiddenRelationshipIds, setHiddenRelationshipIds] = useState<string[]>([]);
  const [pairManagerOpen, setPairManagerOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState<CustomDraft>(EMPTY_DRAFT);
  const [pairError, setPairError] = useState("");
  const [rankings, setRankings] = useState<Map<string, RankingRow>>(new Map());
  const [rankingLoading, setRankingLoading] = useState(true);
  const [rankingUpdatedAt, setRankingUpdatedAt] = useState(0);
  const relationships = useMemo(() => [...RELATIONSHIPS.filter((item) => !hiddenRelationshipIds.includes(item.id)), ...customRelationships], [customRelationships, hiddenRelationshipIds]);

  useEffect(() => { analysisRef.current = analysis; }, [analysis]);

  useEffect(() => {
    const first = analysis?.points[0];
    if (!analysis || !first) return;
    const snapshot: RelativeValueAlertSnapshot = {
      id: analysis.relationship.id,
      title: analysis.relationship.title,
      asset1: analysis.relationship.asset1,
      asset2: analysis.relationship.asset2,
      savedAt: Date.now(),
      start: first.t,
      baseAsset1: first.asset1,
      baseAsset2: first.asset2,
      alphaHourly: analysis.model.alphaHourly,
      beta: analysis.model.beta,
    };
    window.localStorage.setItem(RELATIVE_VALUE_SNAPSHOT_KEY, JSON.stringify(snapshot));
    window.dispatchEvent(new CustomEvent(RELATIVE_VALUE_SNAPSHOT_EVENT, { detail: snapshot }));
  }, [analysis]);

  useEffect(() => {
    let savedCustom: Relationship[] = [];
    let savedHidden: string[] = [];
    try { savedCustom = JSON.parse(window.localStorage.getItem(CUSTOM_RELATIONSHIPS_KEY) || "[]") as Relationship[]; } catch { /* Start without malformed saved relationships. */ }
    try { savedHidden = JSON.parse(window.localStorage.getItem(HIDDEN_RELATIONSHIPS_KEY) || "[]") as string[]; } catch { /* Start with all built-in relationships. */ }
    const frame = window.requestAnimationFrame(() => {
      const validCustom = savedCustom.filter((item) => item?.kind === "custom"
        && /^custom-[a-z0-9-]{4,32}$/i.test(item.id)
        && (item.asset1?.venue === "binance" || item.asset1?.venue === "hyperliquid")
        && (item.asset2?.venue === "binance" || item.asset2?.venue === "hyperliquid")
        && typeof item.asset1?.symbol === "string" && typeof item.asset2?.symbol === "string").slice(0, 30);
      const validHidden = savedHidden.filter((id) => RELATIONSHIPS.some((item) => item.id === id));
      setCustomRelationships(validCustom);
      setHiddenRelationshipIds(validHidden);
      if (validHidden.includes(initialRelationshipId)) {
        const fallback = RELATIONSHIPS.find((item) => !validHidden.includes(item.id) && (!trading || (item.asset1.venue === "binance" && item.asset2.venue === "binance"))) ?? validCustom.find((item) => !trading || (item.asset1.venue === "binance" && item.asset2.venue === "binance"));
        setRelationshipId(fallback?.id ?? "");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialRelationshipId, trading]);

  const load = useCallback(async (options?: { relationship?: string; definition?: Relationship; start?: number; end?: number }) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const start = options?.start ?? fromHktInput(startInput);
    const end = options?.end ?? fromHktInput(endInput);
    const relationshipIdToLoad = options?.relationship ?? relationshipId;
    const relationship = options?.definition ?? relationships.find((item) => item.id === relationshipIdToLoad);
    const maximumWindow = relationship ? maxObservationMs(relationship) : MAX_OBSERVATION_MS;
    if (!relationship || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > maximumWindow + 60_000) {
      setError(relationship?.referenceBeta === null ? "Choose a valid statistical-model window of seven days or less." : "Choose a valid structural-beta window of three days or less.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ relationship: relationshipIdToLoad, start: String(start), end: String(end) });
      if (relationship.kind === "custom") {
        params.set("asset1Venue", relationship.asset1.venue);
        params.set("asset1Symbol", relationship.asset1.symbol);
        params.set("asset2Venue", relationship.asset2.venue);
        params.set("asset2Symbol", relationship.asset2.symbol);
        if (relationship.referenceBeta !== null) params.set("referenceBeta", String(relationship.referenceBeta));
      }
      const response = await fetch(`/api/blog/analysis?${params}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as Partial<Analysis> & { error?: string };
      if (response.ok) setAnalysis(payload as Analysis);
      else setAnalysis(await analyzeInBrowser(relationship, start, end));
    } catch (requestError) {
      if ((requestError as Error).name !== "AbortError") setError(requestError instanceof Error ? requestError.message : "Relative-value prediction is unavailable.");
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, [endInput, relationshipId, relationships, startInput]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load({ start: INITIAL_START, end: INITIAL_NOW }));
    return () => { window.cancelAnimationFrame(frame); requestRef.current?.abort(); };
    // Initial load is intentionally independent of editable input state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!followingLive) return;
    const timer = window.setInterval(() => {
      const end = Date.now();
      const anchor = TODAY_ANCHORS.find((item) => item.label === activeWindow);
      const windowConfig = QUICK_WINDOWS.find((item) => item.label === activeWindow);
      const start = anchor ? latestHktAnchor(anchor.hour, end, anchor.minute) : end - (windowConfig?.milliseconds ?? 60 * 60_000);
      if (start >= end) return;
      setStartInput(toHktInput(start));
      setEndInput(toHktInput(end));
      void load({ start, end });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [activeWindow, followingLive, load]);

  useEffect(() => {
    if (!followingLive) return;
    let stopped = false;
    const updateLive = async () => {
      const current = analysisRef.current;
      if (stopped || liveRequestRef.current || document.visibilityState === "hidden" || !current || current.relationship.id !== relationshipId || current.points.length < 2) return;
      liveRequestRef.current = true;
      try {
        const quote = await directLivePrices(current.relationship);
        if (stopped || analysisRef.current?.relationship.id !== current.relationship.id) return;
        const now = Date.now();
        const first = current.points[0];
        const liveProjection = projectRelationship(
          [{ t: first.t, value: first.asset1 }, { t: now, value: quote.asset1 }],
          [{ t: first.t, value: first.asset2 }, { t: now, value: quote.asset2 }],
          current.model,
        );
        const livePoint = liveProjection.points.at(-1)!;
        const snapshot: RelativeValueAlertSnapshot = {
          id: current.relationship.id,
          title: current.relationship.title,
          asset1: current.relationship.asset1,
          asset2: current.relationship.asset2,
          savedAt: now,
          start: first.t,
          baseAsset1: first.asset1,
          baseAsset2: first.asset2,
          alphaHourly: current.model.alphaHourly,
          beta: current.model.beta,
        };
        const signal: RelativeValueAlertSignal = {
          snapshot,
          predictionError: liveProjection.stats.predictionError,
          asset2Actual: liveProjection.stats.asset2Actual,
          asset2Theoretical: liveProjection.stats.asset2Theoretical,
          updatedAt: now,
        };
        window.dispatchEvent(new CustomEvent(RELATIVE_VALUE_SIGNAL_EVENT, { detail: signal }));
        setLivePrices({ relationshipId: current.relationship.id, asset1: quote.asset1, asset2: quote.asset2, updatedAt: now });
        setAnalysis((previous) => {
          if (!previous || previous.relationship.id !== current.relationship.id) return previous;
          const withoutPreviousTick = previous.points.at(-1)?.t % 60_000 === 0 ? previous.points : previous.points.slice(0, -1);
          return { ...previous, generatedAt: now, points: [...withoutPreviousTick, livePoint], stats: { ...liveProjection.stats, samples: withoutPreviousTick.length + 1 } };
        });
        setLastLiveAt(now);
        setLiveError("");
      } catch (quoteError) {
        if (!stopped) setLiveError(quoteError instanceof Error ? quoteError.message : "Live quote unavailable.");
      } finally {
        liveRequestRef.current = false;
      }
    };
    void updateLive();
    const timer = window.setInterval(() => void updateLive(), LIVE_REFRESH_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [followingLive, relationshipId]);

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    const refreshRanking = async () => {
      if (stopped || document.visibilityState === "hidden" || !relationships.length) return;
      const start = fromHktInput(startInput);
      const end = Date.now();
      if (!Number.isFinite(start) || start >= end || end - start > MAX_STATISTICAL_OBSERVATION_MS + 60_000) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/blog/ranking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start, end, relationships }),
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as { generatedAt?: number; rankings?: RankingRow[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Prediction ranking unavailable.");
        if (stopped) return;
        setRankings(new Map((payload.rankings ?? []).map((row) => [row.id, row])));
        setRankingUpdatedAt(payload.generatedAt ?? Date.now());
        setRankingLoading(false);
      } catch (rankingError) {
        if ((rankingError as Error).name === "AbortError" || stopped) return;
        try {
          const directRows = await rankInBrowser(relationships, start, end);
          if (!stopped) {
            setRankings(new Map(directRows.map((row) => [row.id, row])));
            setRankingUpdatedAt(Date.now());
          }
        } finally { if (!stopped) setRankingLoading(false); }
      }
    };
    void refreshRanking();
    const timer = window.setInterval(() => void refreshRanking(), LIVE_REFRESH_MS);
    return () => { stopped = true; controller?.abort(); window.clearInterval(timer); };
  }, [relationships, startInput]);

  const selected = analysis?.relationship;
  const selectedDefinition = relationships.find((item) => item.id === relationshipId);
  const availability = useMemo(() => new Map(analysis?.universe?.candidates.map((item) => [item.id, item.available]) ?? []), [analysis?.universe]);
  const formulaOnly = analysis?.model.method === "reference" && analysis.model.validationSamples === 0;
  const signalLabel = formulaOnly ? "BETA LOCKED" : analysis?.model.quality === "weak" ? "MODEL WEAK" : analysis?.stats.status === "dislocation" ? "DISLOCATION" : analysis?.stats.status === "watch" ? "WATCH" : "IN RANGE";
  const rankedRelationships = useMemo(() => {
    const originalOrder = new Map(relationships.map((item, index) => [item.id, index]));
    return [...relationships].sort((left, right) => {
      const leftError = left.id === analysis?.relationship.id ? analysis.stats.predictionError : rankings.get(left.id)?.predictionError;
      const rightError = right.id === analysis?.relationship.id ? analysis.stats.predictionError : rankings.get(right.id)?.predictionError;
      if (leftError === undefined && rightError !== undefined) return 1;
      if (leftError !== undefined && rightError === undefined) return -1;
      if (leftError !== undefined && rightError !== undefined && Math.abs(rightError) !== Math.abs(leftError)) return Math.abs(rightError) - Math.abs(leftError);
      return (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0);
    });
  }, [analysis, rankings, relationships]);
  const rankingError = (id: string) => id === analysis?.relationship.id ? analysis.stats.predictionError : rankings.get(id)?.predictionError;

  const applyQuickWindow = (label: string, milliseconds: number, end: number) => {
    const start = end - milliseconds;
    setActiveWindow(label);
    setFollowingLive(true);
    setStartInput(toHktInput(start));
    setEndInput(toHktInput(end));
    void load({ start, end });
  };
  const applyDailyAnchor = (label: string, hour: number, minute: number, end: number) => {
    const start = latestHktAnchor(hour, end, minute);
    setActiveWindow(label);
    setFollowingLive(true);
    setStartInput(toHktInput(start));
    setEndInput(toHktInput(end));
    void load({ start, end });
  };

  const neutralPrices = analysis && selected ? livePrices?.relationshipId === selected.id ? livePrices : {
    relationshipId: selected.id,
    asset1: analysis.points.at(-1)?.asset1 ?? 0,
    asset2: analysis.points.at(-1)?.asset2 ?? 0,
    updatedAt: analysis.points.at(-1)?.t ?? analysis.generatedAt,
  } : null;
  const neutralAsset1Shares = analysis && neutralPrices && neutralPrices.asset1 > 0 ? NEUTRAL_UNIT_SHARES * Math.abs(analysis.model.beta) * neutralPrices.asset2 / neutralPrices.asset1 : null;
  const neutralAsset2Side = analysis?.stats.predictionError && analysis.stats.predictionError > 0 ? "SHORT" : "LONG";
  const neutralAsset1Side = analysis ? analysis.model.beta >= 0 ? neutralAsset2Side === "LONG" ? "SHORT" : "LONG" : neutralAsset2Side : "—";
  const chooseRelationship = (id: string) => {
    const relationship = relationships.find((item) => item.id === id);
    if (!relationship) return;
    const end = fromHktInput(endInput);
    const currentStart = fromHktInput(startInput);
    const maximumWindow = maxObservationMs(relationship);
    const start = Number.isFinite(end) && Number.isFinite(currentStart) && end - currentStart > maximumWindow ? end - maximumWindow : currentStart;
    if (start !== currentStart) {
      setStartInput(toHktInput(start));
      setActiveWindow(relationship.referenceBeta === null ? activeWindow : "3D");
    }
    setRelationshipId(id);
    void load({ relationship: id, definition: relationship, start, end });
  };

  const normalizeSymbol = (venue: CustomDraft["asset1Venue"], value: string) => {
    const trimmed = value.trim();
    if (venue === "binance") return trimmed.toUpperCase();
    const colon = trimmed.indexOf(":");
    return colon > 0 ? `${trimmed.slice(0, colon).toLowerCase()}:${trimmed.slice(colon + 1).toUpperCase()}` : trimmed.toUpperCase();
  };

  const addRelationship = () => {
    const asset1Symbol = normalizeSymbol(customDraft.asset1Venue, customDraft.asset1Symbol);
    const asset2Symbol = normalizeSymbol(customDraft.asset2Venue, customDraft.asset2Symbol);
    const valid = (venue: CustomDraft["asset1Venue"], symbol: string) => venue === "binance" ? /^[A-Z0-9_]{2,32}$/.test(symbol) : /^[A-Z0-9._:-]{2,40}$/i.test(symbol);
    const referenceBeta = customDraft.referenceBeta.trim() === "" ? null : Number(customDraft.referenceBeta);
    if (!valid(customDraft.asset1Venue, asset1Symbol) || !valid(customDraft.asset2Venue, asset2Symbol)) {
      setPairError("Enter valid Binance symbols or Hyperliquid coins such as mkts:USTECH.");
      return;
    }
    if (referenceBeta !== null && (!Number.isFinite(referenceBeta) || Math.abs(referenceBeta) > 20)) {
      setPairError("Reference beta must be between −20 and +20, or left blank for regression.");
      return;
    }
    if (relationships.some((item) => item.asset1.venue === customDraft.asset1Venue && item.asset1.symbol === asset1Symbol && item.asset2.venue === customDraft.asset2Venue && item.asset2.symbol === asset2Symbol)) {
      setPairError("This relationship is already in the list.");
      return;
    }
    const id = `custom-${Date.now().toString(36)}`;
    const relationship: Relationship = {
      id,
      title: `${asset1Symbol} → ${asset2Symbol}`,
      short: "Custom relative-value relationship",
      kind: "custom",
      asset1: { venue: customDraft.asset1Venue, symbol: asset1Symbol, label: `${customDraft.asset1Venue === "binance" ? "Binance" : "Hyperliquid"} ${asset1Symbol}` },
      asset2: { venue: customDraft.asset2Venue, symbol: asset2Symbol, label: `${customDraft.asset2Venue === "binance" ? "Binance" : "Hyperliquid"} ${asset2Symbol}` },
      referenceBeta,
      leveraged: referenceBeta !== null && Math.abs(referenceBeta) > 1,
      thesis: referenceBeta === null ? `Estimate ${asset2Symbol} from ${asset1Symbol} with a historical regression coefficient.` : `Apply the user-defined structural beta ${referenceBeta} directly to ${asset1Symbol}'s move to estimate ${asset2Symbol}.`,
      caveat: "This custom relationship is a monitoring assumption. Validate market structure, liquidity and reference timing before acting on it.",
    };
    const next = [...customRelationships, relationship].slice(-30);
    setCustomRelationships(next);
    window.localStorage.setItem(CUSTOM_RELATIONSHIPS_KEY, JSON.stringify(next));
    setCustomDraft(EMPTY_DRAFT);
    setPairError("");
    setRelationshipId(id);
    void load({ relationship: id, definition: relationship });
  };

  const removeRelationship = (relationship: Relationship) => {
    const custom = relationship.kind === "custom";
    const nextCustom = custom ? customRelationships.filter((item) => item.id !== relationship.id) : customRelationships;
    const nextHidden = custom ? hiddenRelationshipIds : [...new Set([...hiddenRelationshipIds, relationship.id])];
    setCustomRelationships(nextCustom);
    setHiddenRelationshipIds(nextHidden);
    window.localStorage.setItem(CUSTOM_RELATIONSHIPS_KEY, JSON.stringify(nextCustom));
    window.localStorage.setItem(HIDDEN_RELATIONSHIPS_KEY, JSON.stringify(nextHidden));
    if (relationshipId !== relationship.id) return;
    const nextRelationships = [...RELATIONSHIPS.filter((item) => !nextHidden.includes(item.id)), ...nextCustom];
    const next = nextRelationships[0];
    if (!next) {
      setRelationshipId("");
      setAnalysis(null);
      setError("Add a relationship to begin a backtest.");
      return;
    }
    setRelationshipId(next.id);
    void load({ relationship: next.id, definition: next });
  };

  const restoreBuiltIns = () => {
    setHiddenRelationshipIds([]);
    window.localStorage.setItem(HIDDEN_RELATIONSHIPS_KEY, "[]");
  };

  return <main className={styles.shell}><div className={styles.frame}>
    <header className={styles.topbar}>
      <div><p className={styles.eyebrow}>{trading ? "LIVE RELATIVE VALUE EXECUTION" : "TEN-SECOND RELATIVE VALUE"}</p><h1>{trading ? "Relative Value Execution" : "Relative Value Monitor"}</h1><p>{trading ? "Use the same real-time relative-value models and charts, then submit a β-balanced two-leg Binance Futures order with a complete fill and spread report." : "The selected predictor explains the paired contract's move. Live midpoint, theoretical return and deviation refresh every 10 seconds; the historical curve remains aligned to one-minute candles."}</p></div>
      <div className={styles.topActions}><span className={styles.releaseBadge}>RELEASE 08.14 · 7D + NEWS HOLD</span><span title={liveError || (lastLiveAt ? `Last live update ${formatTime(lastLiveAt)} HKT` : "Waiting for live quote")} className={`${styles.connection} ${lastLiveAt && !liveError ? styles.online : ""}`}><i />{loading && !analysis ? "Loading history" : liveError ? "Live quote retrying" : lastLiveAt ? "Live · 10s" : "Connecting live"}</span><PageSwitcher active={trading ? "trade" : "blog"} /></div>
    </header>

    <section className={styles.universeStrip}>
      <div><span>BINANCE TRADEFI SCAN</span><strong>{analysis?.universe ? `${analysis.universe.count} active contracts` : "Scanning universe…"}</strong></div>
      <div><span>VISIBLE MODELS</span><strong>{analysis?.universe ? `${relationships.filter((item) => availability.get(item.id) !== false).length}/${relationships.length} available` : `${relationships.length} defined`}</strong></div>
      <div><span>FIXED TRAINING CUTOFF</span><strong>{analysis ? `${formatDate(analysis.model.trainingEnd)} HKT` : "Three days before current session"}</strong></div>
      <div><span>MODEL MODE</span><strong className={analysis ? styles[formulaOnly ? "locked" : analysis.model.quality] : ""}>{analysis ? formulaOnly ? "BETA LOCKED" : analysis.model.quality.toUpperCase() : "—"}</strong></div>
    </section>

    <section className={styles.workspace}>
      <aside className={styles.relationships}>
        <div className={styles.sectionLabel}><span>|PREDICTION ERROR| RANKING</span><div><small>{rankingLoading ? "Updating…" : rankingUpdatedAt ? `${formatTime(rankingUpdatedAt)} HKT` : `${relationships.length} models`}</small><button onClick={() => setPairManagerOpen((open) => !open)}>{pairManagerOpen ? "Close" : "Manage"}</button></div></div>
        {pairManagerOpen && <div className={styles.pairManager}>
          <strong>Add relationship</strong>
          <div className={styles.legFields}><label>Predictor venue<select value={customDraft.asset1Venue} onChange={(event) => setCustomDraft((draft) => ({ ...draft, asset1Venue: event.target.value as CustomDraft["asset1Venue"] }))}><option value="binance">Binance</option><option value="hyperliquid">Hyperliquid</option></select></label><label>Predictor symbol<input value={customDraft.asset1Symbol} onChange={(event) => setCustomDraft((draft) => ({ ...draft, asset1Symbol: event.target.value }))} placeholder={customDraft.asset1Venue === "binance" ? "QQQUSDT" : "mkts:USTECH"} /></label></div>
          <div className={styles.legFields}><label>Target venue<select value={customDraft.asset2Venue} onChange={(event) => setCustomDraft((draft) => ({ ...draft, asset2Venue: event.target.value as CustomDraft["asset2Venue"] }))}><option value="binance">Binance</option><option value="hyperliquid">Hyperliquid</option></select></label><label>Target symbol<input value={customDraft.asset2Symbol} onChange={(event) => setCustomDraft((draft) => ({ ...draft, asset2Symbol: event.target.value }))} placeholder={customDraft.asset2Venue === "binance" ? "TQQQUSDT" : "mkts:US500"} /></label></div>
          <label>Reference beta · recommended for new contracts<input type="number" min="-20" max="20" step="0.1" value={customDraft.referenceBeta} onChange={(event) => setCustomDraft((draft) => ({ ...draft, referenceBeta: event.target.value }))} placeholder="Multiplier used directly" /></label>
          <button className={styles.addPairButton} onClick={addRelationship}>Add and analyze</button>
          {pairError && <p>{pairError}</p>}
          {hiddenRelationshipIds.length > 0 && <button className={styles.restoreButton} onClick={restoreBuiltIns}>Restore {hiddenRelationshipIds.length} deleted built-in model{hiddenRelationshipIds.length === 1 ? "" : "s"}</button>}
        </div>}
        <div className={styles.relationshipList}>{rankedRelationships.map((relationship, index) => { const predictionError = rankingError(relationship.id); return <div key={relationship.id} className={styles.relationshipItem}><button className={relationshipId === relationship.id ? styles.activeRelationship : ""} disabled={availability.get(relationship.id) === false} onClick={() => chooseRelationship(relationship.id)}>
          <span className={styles.relationshipTitle}><i>#{index + 1}</i>{relationship.title}</span><small>{relationship.short}</small><div className={styles.relationshipMeta}>{predictionError !== undefined ? <strong className={`${styles.rankingError} ${predictionError >= 0 ? styles.positiveError : styles.negativeError}`}>{formatPct(predictionError, 3)}</strong> : <strong className={styles.pendingError}>CALCULATING</strong>}{relationship.referenceBeta !== null && <b>β {formatNumber(relationship.referenceBeta, 2)}</b>}</div>{availability.get(relationship.id) === false && <em>Not listed</em>}
        </button><button className={styles.removeRelationship} aria-label={`Delete ${relationship.title}`} title={`Delete ${relationship.title}`} onClick={() => removeRelationship(relationship)}>×</button></div>; })}</div>
        {analysis?.universe && <div className={styles.scanBreakdown}><span>LIVE UNIVERSE BREAKDOWN</span>{Object.entries(analysis.universe.typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => <div key={type}><b>{type.replaceAll("_", " ")}</b><strong>{count}</strong></div>)}<details><summary>View all {analysis.universe.count} symbols</summary><p>{analysis.universe.symbols.join(" · ")}</p></details></div>}
      </aside>

      <div className={styles.analysisColumn}>
        <section className={styles.controls}>
          <div className={styles.quickWindows}>{TODAY_ANCHORS.map((anchor) => { const now = analysis?.generatedAt ?? INITIAL_NOW; const latest = latestHktAnchor(anchor.hour, now, anchor.minute); const day = anchorDayLabel(latest, now); return <button key={anchor.label} className={`${styles.anchorWindow} ${followingLive && activeWindow === anchor.label ? styles.activeWindow : ""}`} title={`Compare from the latest ${anchor.label} HKT anchor within the past 24 hours · ${day.toLowerCase()}`} onClick={(event) => applyDailyAnchor(anchor.label, anchor.hour, anchor.minute, performance.timeOrigin + event.timeStamp)}><span>{anchor.label}</span><small>{day}</small></button>; })}{QUICK_WINDOWS.map((window) => { const statisticalOnly = "statisticalOnly" in window; const disabled = statisticalOnly && selectedDefinition?.referenceBeta !== null; return <button key={window.label} disabled={disabled} title={disabled ? "7D is available for fitted statistical models; structural-beta products remain capped at 3D." : undefined} className={followingLive && activeWindow === window.label ? styles.activeWindow : ""} onClick={(event) => applyQuickWindow(window.label, window.milliseconds, performance.timeOrigin + event.timeStamp)}>{window.label}{disabled && <small>STAT</small>}</button>; })}</div>
          <label>Backtest start · HKT<input type="datetime-local" value={startInput} max={endInput} onChange={(event) => { setStartInput(event.target.value); setFollowingLive(false); setActiveWindow(""); }} /></label>
          <label>Backtest end · HKT<input type="datetime-local" value={endInput} min={startInput} onChange={(event) => { setEndInput(event.target.value); setFollowingLive(false); setActiveWindow(""); }} /></label>
          <button className={styles.runButton} disabled={loading} onClick={() => void load()}>{loading ? "Updating…" : "Update prediction"}</button>
          <p className={styles.windowRule}>{followingLive ? `Following ${TODAY_ANCHORS.some((item) => item.label === activeWindow) ? `the latest ${activeWindow} HKT anchor within the past 24 hours` : `the latest ${activeWindow} window`}.` : "Historical backtest selected."} Statistical models support up to 7D using five-minute candles; shorter windows retain one-minute precision. Structural-beta and daily-reset products remain capped at 3D. A supplied beta always runs directly; history is validation only.</p>
        </section>

        {error && <div className={styles.errorBox}><strong>Prediction unavailable</strong><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}

        {analysis && selected && <>
          <section className={styles.heroCard}>
            <div className={styles.heroCopy}><span className={styles.kindPill}>{selected.kind.replaceAll("-", " ")}</span><h2>{selected.title}</h2><p>{selected.thesis}</p><small>{selected.caveat}</small></div>
            <div className={`${styles.signal} ${styles[formulaOnly ? "normal" : analysis.model.quality === "weak" ? "watch" : analysis.stats.status]}`}><span>PREDICTION SIGNAL</span><strong>{signalLabel}</strong><b>{formulaOnly ? `β ${formatNumber(analysis.model.beta, 2)}` : `${formatNumber(analysis.stats.zScore)}σ`}</b><small>{formulaOnly ? `Using the supplied multiplier without blocking on historical validation. ${selected.asset2.symbol} is ${formatPct(analysis.stats.predictionError)} from theory.` : analysis.model.quality === "weak" ? "Holdout validation is too weak for a confident dislocation call." : `${selected.asset2.symbol} is ${formatPct(analysis.stats.predictionError)} away from theory.`}</small></div>
          </section>

          {trading && <PairExecutionPanel relationship={selected} beta={analysis.model.beta} />}

          <section className={styles.predictionGrid}>
            <article><span>{selected.asset1.symbol} observed move</span><strong className={analysis.stats.asset1Return >= 0 ? styles.positive : styles.negative}>{formatPct(analysis.stats.asset1Return)}</strong><small>{selected.asset1.label} · predictor</small></article>
            <article className={styles.theoryMetric}><span>{selected.asset2.symbol} theoretical move</span><strong>{formatPct(analysis.stats.asset2Theoretical)}</strong><small>{analysis.model.method === "reference" ? `Locked β × ${selected.asset1.symbol} · zero intercept` : `α × hours + fitted β × ${selected.asset1.symbol}`}</small></article>
            <article><span>{selected.asset2.symbol} actual move</span><strong className={analysis.stats.asset2Actual >= 0 ? styles.positive : styles.negative}>{formatPct(analysis.stats.asset2Actual)}</strong><small>{selected.asset2.label} · observed</small></article>
            <article><span>Prediction error</span><strong className={!formulaOnly && Math.abs(analysis.stats.zScore) >= 2 ? styles.negative : ""}>{formatPct(analysis.stats.predictionError, 3)}</strong><small>{formulaOnly ? "Actual − theoretical · significance unavailable" : `Actual − theoretical · ${formatNumber(analysis.stats.zScore)}σ`}</small></article>
          </section>

          <section className={styles.chartPanel}><div className={styles.panelHead}><div><span>THEORETICAL RETURN ENGINE</span><h3>{selected.asset2.symbol} actual versus model</h3><p>{analysis.points.length.toLocaleString()} aligned points · {analysis.interval} resolution</p></div><div className={styles.legend}><span><i className={styles.legendA} />{selected.asset1.symbol} actual</span><span><i className={styles.legendB} />{selected.asset2.symbol} actual</span><span><i className={styles.legendTheory} />{selected.asset2.symbol} theoretical</span></div></div><PredictionChart points={analysis.points} relationship={selected} /></section>

          <section className={`${styles.chartPanel} ${styles.errorChartPanel}`}><div className={styles.panelHead}><div><span>PREDICTION ERROR HISTORY</span><h3>Actual {selected.asset2.symbol} minus theoretical return</h3><p>Cumulative percentage-point error from the selected anchor · ±2% broadcast threshold</p></div><div className={styles.errorSnapshot}><span>LATEST ERROR</span><strong className={analysis.stats.predictionError >= 0 ? styles.positive : styles.negative}>{formatPct(analysis.stats.predictionError, 3)}</strong></div></div><PredictionErrorChart points={analysis.points} /></section>

          {!formulaOnly && <section className={styles.chartPanel}><div className={styles.panelHead}><div><span>STANDARDIZED ERROR MONITOR</span><h3>Prediction error significance</h3></div><p>Watch at ±1.5σ · dislocation at ±2σ · suppressed when model quality is weak.</p></div><ResidualChart points={analysis.points} /></section>}

          {neutralPrices && neutralAsset1Shares !== null && <section className={styles.neutralPanel}>
            <div className={styles.neutralIntro}><span>LIVE β-NEUTRAL SHARE RATIO</span><h3>Hedge {NEUTRAL_UNIT_SHARES} {selected.asset2.symbol} shares with {neutralAsset1Shares.toLocaleString("en-US", { maximumFractionDigits: 6 })} {selected.asset1.symbol} shares.</h3><p>The share ratio updates from both live midpoints every 10 seconds. Target notionals remain |β| : 1; exchange quantity steps may introduce a small rounding error.</p></div>
            <div className={styles.neutralLeg}><span>{selected.asset2.symbol} SIGNAL LEG</span><strong className={neutralAsset2Side === "LONG" ? styles.positive : styles.negative}>{neutralAsset2Side} {NEUTRAL_UNIT_SHARES.toFixed(6)}</strong><b>{selected.asset2.symbol}</b><small>@ {neutralPrices.asset2.toLocaleString("en-US", { maximumFractionDigits: 8 })}</small></div>
            <div className={styles.neutralLeg}><span>{selected.asset1.symbol} HEDGE LEG</span><strong className={neutralAsset1Side === "LONG" ? styles.positive : styles.negative}>{neutralAsset1Side} {neutralAsset1Shares.toLocaleString("en-US", { maximumFractionDigits: 6 })}</strong><b>{selected.asset1.symbol}</b><small>@ {neutralPrices.asset1.toLocaleString("en-US", { maximumFractionDigits: 8 })}</small></div>
            <div className={styles.neutralRatio}><span>NOTIONAL BALANCE</span><strong>{Math.abs(analysis.model.beta).toFixed(3)} : 1</strong><small>{selected.asset1.symbol} : {selected.asset2.symbol} · β {formatNumber(analysis.model.beta, 3)}</small></div>
          </section>}

          <section className={styles.methodPanel}>
            <div><span>{analysis.model.method === "reference" ? "RULE VALIDATION" : "MODEL TRAINING"}</span><h3>{formulaOnly ? "The supplied beta runs without a minimum history requirement." : "The backtest never refits on its own result."}</h3><p>{formulaOnly ? "This contract is too new for a meaningful holdout test, so the engine skips regression and applies the supplied leverage multiplier directly. Validation metrics will appear automatically once enough aligned hourly history exists." : analysis.model.method === "reference" ? "This relationship has an explicit beta, so the site does not fit a coefficient. The preceding 45-day hourly history and holdout sample only test how reliably the zero-intercept structural formula behaved before the selected backtest." : "The coefficient is estimated from a 45-day hourly history ending three days before the selected backtest. The final 25% is kept out of training and reports correlation, R², error and coefficient drift."}</p></div>
            <div><span>PREDICTION EQUATION</span><h3>{analysis.model.method === "reference" ? `${selected.asset2.symbol} = locked β × ${selected.asset1.symbol}.` : `${selected.asset2.symbol} = α × time + fitted β × ${selected.asset1.symbol}.`}</h3><p>The engine works in log-return space. It converts {selected.asset1.symbol}&apos;s cumulative move over the selected period into {selected.asset2.symbol}&apos;s theoretical move, then compares that number with {selected.asset2.symbol}&apos;s actual return. Funding, liquidity and oracle timing remain outside the formula.</p></div>
          </section>

          <section className={styles.sources}><div><span>RELATIONSHIP RESEARCH</span><h3>Issuer objectives and underlying links</h3></div><div className={styles.sourceGrid}>
            <a href="https://www.invesco.com/content/dam/invesco/hk/en/pdf/factsheet/Invesco_QQQ_factsheet_EN.pdf" target="_blank" rel="noreferrer"><b>Invesco QQQ</b><small>Nasdaq-100 tracking objective ↗</small></a>
            <a href="https://www.proshares.com/our-etfs/leveraged-and-inverse/tbt" target="_blank" rel="noreferrer"><b>ProShares TBT</b><small>−2× daily Treasury objective ↗</small></a>
            <a href="https://www.direxion.com/product/daily-20-year-treasury-bull-bear-3x-etfs" target="_blank" rel="noreferrer"><b>Direxion TMF</b><small>+3× daily Treasury objective ↗</small></a>
            <a href="https://www.direxion.com/product/daily-small-cap-bull-bear-3x-etfs" target="_blank" rel="noreferrer"><b>Direxion TZA</b><small>−3× Russell 2000 daily target ↗</small></a>
            <a href="https://graniteshares.com/etfs/mvll/" target="_blank" rel="noreferrer"><b>GraniteShares MVLL</b><small>+2× MRVL daily target ↗</small></a>
            <a href="https://www.sec.gov/Archives/edgar/data/1587982/000121390026057930/ea0291169-05_497.htm" target="_blank" rel="noreferrer"><b>Tradr SNXX filing</b><small>+2× SNDK daily fund ↗</small></a>
            <a href="https://www.vaneck.com/us/en/investments/semiconductor-etf-smh-fact-sheet.pdf" target="_blank" rel="noreferrer"><b>VanEck SMH</b><small>Semiconductor basket composition ↗</small></a>
          </div></section>

          <section className={styles.modelPanel}>
            <div className={styles.modelHead}><div><span>{analysis.model.method === "reference" ? "LOCKED STRUCTURAL RULE" : "FROZEN MODEL CARD"}</span><h3>{formulaOnly ? "Direct formula · no history required" : analysis.model.method === "reference" ? "Direct formula, validated out of sample" : "Trained once, validated out of sample"}</h3><p>{formulaOnly ? `β ${formatNumber(analysis.model.beta, 3)} supplied by the user · zero intercept · theoretical return remains active` : `${formatDate(analysis.model.trainingStart)} — ${formatDate(analysis.model.trainingEnd)} HKT · ${analysis.model.method === "reference" ? "β fixed from the stated product relationship · zero intercept · history used only for validation" : "first 75% train / final 25% validation"} · hourly log returns`}</p></div><b className={styles[formulaOnly ? "locked" : analysis.model.quality]}>{formulaOnly ? "locked" : analysis.model.quality}</b></div>
            <div className={styles.modelMetrics}>
              <div><span>{analysis.model.method === "reference" ? "Locked β" : "Learned β"}</span><strong>{formatNumber(analysis.model.beta, 3)}</strong><small>{analysis.model.method === "reference" ? "Used directly, not regressed" : "Estimated on training sample"}</small></div>
              <div><span>Formula type</span><strong>{analysis.model.method === "reference" ? "Structural" : "Empirical"}</strong><small>{analysis.model.method === "reference" ? "Issuer / benchmark relationship" : "Historical regression"}</small></div>
              <div><span>Holdout correlation</span><strong>{formulaOnly ? "—" : analysis.model.validationCorrelation.toFixed(3)}</strong><small>{formulaOnly ? "Awaiting enough history" : `${analysis.model.validationSamples} unseen samples`}</small></div>
              <div><span>Holdout R²</span><strong>{formulaOnly ? "—" : analysis.model.validationR2.toFixed(3)}</strong><small>{formulaOnly ? "Not required for calculation" : `Explained ${selected.asset2.symbol} variance`}</small></div>
              <div><span>Holdout MAE</span><strong>{formulaOnly ? "—" : `${analysis.model.validationMaePct.toFixed(3)}%`}</strong><small>{formulaOnly ? "Validation pending" : "Per hourly prediction"}</small></div>
              <div><span>β drift</span><strong>{formulaOnly ? "—" : `${(analysis.model.betaDrift * 100).toFixed(1)}%`}</strong><small>{formulaOnly ? "Using supplied beta unchanged" : analysis.model.method === "reference" ? "Observed holdout β versus locked β" : "Train versus holdout"}</small></div>
            </div>
          </section>
        </>}
      </div>
    </section>
    <footer className={styles.footer}>Research analytics only. A theoretical return is a model estimate, not a guaranteed trade or proof of arbitrage. Leveraged and inverse ETFs pursue daily objectives and can diverge materially over longer periods.</footer>
  </div></main>;
}
