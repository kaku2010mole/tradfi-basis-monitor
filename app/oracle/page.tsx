"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BroadcastAlert from "../components/BroadcastAlert";
import PageSwitcher from "../components/PageSwitcher";
import ParaDepthHeatmap from "./ParaDepthHeatmap";
import styles from "./page.module.css";

type OracleQuote = {
  id: string;
  venue: "Binance" | "Hyperliquid";
  symbol: string;
  apiSymbol: string;
  bid: number | null;
  bidQty: number | null;
  ask: number | null;
  askQty: number | null;
  live: number;
  oracle: number;
  mark: number;
  deviation: number;
  funding: number | null;
  fundingHours: number;
  nextFundingTime: number | null;
  updatedAt: number;
  executableSide: "BUY" | "SELL";
  executablePrice: number | null;
  executableQty: number | null;
  executableUsd: number | null;
};

type OraclePoint = { t: number; live: number; oracle: number; deviation: number };
type SourceState = { binance: boolean; hyperliquid: boolean };
type StreamStatus = "connecting" | "live" | "reconnecting";
type BinanceStreamState = { book: StreamStatus; oracle: StreamStatus };
type BroadcastState = { title: string; message: string; tone: "positive" | "negative" };
type CustomPair = { venue: "Binance" | "Hyperliquid"; apiSymbol: string };
type BinanceStreamEnvelope = {
  data?: {
    E?: number;
    s?: string;
    b?: string;
    B?: string;
    a?: string;
    A?: string;
    p?: string;
    i?: string;
    r?: string;
    T?: number;
  };
};
type BinanceBookSnapshot = { symbol?: string; bidPrice?: string; bidQty?: string; askPrice?: string; askQty?: string; time?: number };
type BinancePremiumSnapshot = { symbol?: string; indexPrice?: string; markPrice?: string; lastFundingRate?: string; nextFundingTime?: number; time?: number };

const REFRESH_MS = 5000;
const STALE_AFTER_MS = 8_000;
const HIDE_AFTER_MS = 20_000;
const CUSTOM_PAIRS_KEY = "oracle-monitor-custom-pairs-v1";
const DEFAULT_BINANCE = ["HK1810USDT", "HK0700USDT", "TENCENTUSDT"];
const DEFAULT_PARA = ["para:OTHERS", "para:TOTAL2", "para:BTCD"];

const hktDateValue = (offsetDays = 0) => {
  const date = new Date(Date.now() + 8 * 3600_000 + offsetDays * 24 * 3600_000);
  return `${date.toISOString().slice(0, 10)}T07:00`;
};
const toEpoch = (value: string) => Date.parse(`${value}:00+08:00`);
const formatPct = (value: number, digits = 3) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const formatPrice = (value: number | null) => value == null || !Number.isFinite(value)
  ? "—"
  : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value >= 100 ? 3 : 6 });
const formatUsd = (value: number | null) => value == null || !Number.isFinite(value)
  ? "—"
  : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value >= 1000 ? 0 : 2 }).format(value);
const formatTime = (value: number, date = false) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong",
  month: date ? "short" : undefined,
  day: date ? "2-digit" : undefined,
  hour: "2-digit",
  minute: "2-digit",
  second: date ? undefined : "2-digit",
  hour12: false,
}).format(value);

const positiveNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const finiteNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rebuildBinanceQuote = (symbol: string, candidate: Partial<OracleQuote>): OracleQuote | null => {
  const bid = positiveNumber(candidate.bid);
  const bidQty = positiveNumber(candidate.bidQty);
  const ask = positiveNumber(candidate.ask);
  const askQty = positiveNumber(candidate.askQty);
  const oracle = positiveNumber(candidate.oracle);
  const mark = positiveNumber(candidate.mark);
  if (bid === null || ask === null || oracle === null || mark === null) return null;
  const live = (bid + ask) / 2;
  const executableSide = live >= oracle ? "SELL" as const : "BUY" as const;
  const executablePrice = executableSide === "SELL" ? bid : ask;
  const executableQty = executableSide === "SELL" ? bidQty : askQty;
  return {
    id: `binance:${symbol}`,
    venue: "Binance",
    symbol,
    apiSymbol: symbol,
    bid,
    bidQty,
    ask,
    askQty,
    live,
    oracle,
    mark,
    deviation: (live / oracle - 1) * 100,
    funding: finiteNumber(candidate.funding),
    fundingHours: 8,
    nextFundingTime: finiteNumber(candidate.nextFundingTime),
    updatedAt: finiteNumber(candidate.updatedAt) ?? Date.now(),
    executableSide,
    executablePrice,
    executableQty,
    executableUsd: executableQty === null ? null : executablePrice * executableQty,
  };
};

async function fetchBrowserBinanceQuotes(symbols: string[], signal: AbortSignal) {
  const [bookResponse, premiumResponse] = await Promise.all([
    fetch("https://fapi.binance.com/fapi/v1/ticker/bookTicker", { cache: "no-store", credentials: "omit", signal }),
    fetch("https://fapi.binance.com/fapi/v1/premiumIndex", { cache: "no-store", credentials: "omit", signal }),
  ]);
  if (!bookResponse.ok || !premiumResponse.ok) throw new Error("Binance browser snapshot unavailable.");
  const [books, premiums] = await Promise.all([
    bookResponse.json() as Promise<BinanceBookSnapshot[]>,
    premiumResponse.json() as Promise<BinancePremiumSnapshot[]>,
  ]);
  const bookBySymbol = new Map(books.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
  const premiumBySymbol = new Map(premiums.flatMap((premium) => premium.symbol ? [[premium.symbol, premium] as const] : []));
  return symbols.flatMap((symbol) => {
    const book = bookBySymbol.get(symbol);
    const premium = premiumBySymbol.get(symbol);
    const quote = rebuildBinanceQuote(symbol, {
      bid: positiveNumber(book?.bidPrice),
      bidQty: positiveNumber(book?.bidQty),
      ask: positiveNumber(book?.askPrice),
      askQty: positiveNumber(book?.askQty),
      oracle: positiveNumber(premium?.indexPrice),
      mark: positiveNumber(premium?.markPrice),
      funding: finiteNumber(premium?.lastFundingRate),
      nextFundingTime: finiteNumber(premium?.nextFundingTime),
      updatedAt: Math.max(book?.time ?? 0, premium?.time ?? 0, Date.now()),
    });
    return quote ? [quote] : [];
  });
}

function DeviationChart({ points, threshold, symbol }: { points: OraclePoint[]; threshold: number; symbol: string }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 1240;
  const height = 500;
  const left = 72;
  const right = 26;
  const top = 38;
  const bottom = 438;
  const values = points.map((point) => point.deviation);
  const extent = Math.max(threshold * 1.25, ...values.map(Math.abs), 0.01);
  const yMin = -extent * 1.12;
  const yMax = extent * 1.12;
  const x = (index: number) => left + (index / Math.max(1, points.length - 1)) * (width - left - right);
  const y = (value: number) => top + ((yMax - value) / (yMax - yMin)) * (bottom - top);
  const path = points.map((point, index) => `${index ? "L" : "M"} ${x(index).toFixed(2)} ${y(point.deviation).toFixed(2)}`).join(" ");
  const yTicks = Array.from({ length: 5 }, (_, index) => yMin + ((yMax - yMin) * index) / 4);
  const timeTicks = Array.from(new Set([0, Math.floor((points.length - 1) / 4), Math.floor((points.length - 1) / 2), Math.floor((points.length - 1) * .75), points.length - 1]));
  const selected = hoverIndex === null ? null : points[hoverIndex];

  return (
    <div
      className={styles.chartWrap}
      onMouseLeave={() => setHoverIndex(null)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const chartX = ((event.clientX - rect.left) / rect.width) * width;
        const index = Math.round(((chartX - left) / (width - left - right)) * (points.length - 1));
        setHoverIndex(Math.max(0, Math.min(points.length - 1, index)));
      }}
    >
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${symbol} live price deviation from oracle`}>
        <rect x={left} y={top} width={width - left - right} height={bottom - top} fill="#fbfcfe" />
        <rect x={left} y={y(threshold)} width={width - left - right} height={y(-threshold) - y(threshold)} fill="rgba(36,118,229,.055)" />
        {yTicks.map((tick) => <g key={tick}>
          <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke="#dfe6ef" />
          <text x={left - 10} y={y(tick) + 4} textAnchor="end" fill="#748197" fontSize="11">{formatPct(tick, 2)}</text>
        </g>)}
        {timeTicks.map((index) => <text key={index} x={x(index)} y={height - 14} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fill="#748197" fontSize="11">
          {formatTime(points[index].t, true)}
        </text>)}
        <line x1={left} x2={width - right} y1={y(threshold)} y2={y(threshold)} stroke="#079a76" strokeDasharray="7 6" />
        <line x1={left} x2={width - right} y1={y(-threshold)} y2={y(-threshold)} stroke="#d85151" strokeDasharray="7 6" />
        <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke="#748197" strokeWidth="1.4" />
        <path d={path} fill="none" stroke="#2476e5" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
        {selected && hoverIndex !== null && <>
          <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={top} y2={bottom} stroke="#8090a6" strokeDasharray="4 4" />
          <circle cx={x(hoverIndex)} cy={y(selected.deviation)} r="5" fill="#2476e5" stroke="#fff" strokeWidth="2" />
        </>}
      </svg>
      {selected && hoverIndex !== null && <div className={styles.tooltip} style={{ left: `${Math.min(77, Math.max(4, (hoverIndex / Math.max(1, points.length - 1)) * 100))}%` }}>
        <strong>{formatTime(selected.t, true)} HKT</strong>
        <span>Deviation {formatPct(selected.deviation)}</span>
        <span>Live {formatPrice(selected.live)}</span>
        <span>Oracle {formatPrice(selected.oracle)}</span>
      </div>}
    </div>
  );
}

function QuoteCard({ quote, threshold, selected, stale, onSelect }: { quote: OracleQuote; threshold: number; selected: boolean; stale: boolean; onSelect: () => void }) {
  const triggered = Math.abs(quote.deviation) >= threshold;
  return (
    <button className={`${styles.quoteCard} ${selected ? styles.selectedCard : ""} ${triggered ? styles.triggeredCard : ""} ${stale ? styles.staleCard : ""}`} onClick={onSelect}>
      <div className={styles.cardTop}>
        <div><small>{quote.venue}</small><strong>{quote.symbol}</strong></div>
        <span className={quote.deviation >= 0 ? styles.positive : styles.negative}>{formatPct(quote.deviation)}</span>
      </div>
      <div className={styles.cardPrices}>
        <div><span>Live midpoint</span><b>{formatPrice(quote.live)}</b></div>
        <div><span>Oracle</span><b>{formatPrice(quote.oracle)}</b></div>
        <div><span>Mark</span><b>{formatPrice(quote.mark)}</b></div>
      </div>
      <div className={styles.executableBar}>
        <div>
          <span>{quote.executableSide === "SELL" ? "Sell into best bid" : "Buy from best ask"}</span>
          <strong>{formatUsd(quote.executableUsd)}</strong>
        </div>
        <small>{quote.executableQty == null || quote.executablePrice == null ? "Depth unavailable" : `${formatPrice(quote.executableQty)} @ ${formatPrice(quote.executablePrice)}`}</small>
      </div>
      <footer>
        <span>Funding {quote.funding == null ? "—" : formatPct(quote.funding * 100, 4)} / {quote.fundingHours}h</span>
        <span>{stale ? "RECONNECTING · " : ""}{formatTime(quote.updatedAt)} HKT</span>
      </footer>
    </button>
  );
}

export default function OracleMonitor() {
  const [quotes, setQuotes] = useState<OracleQuote[]>([]);
  const [sources, setSources] = useState<SourceState>({ binance: false, hyperliquid: false });
  const [threshold, setThreshold] = useState(.1);
  const [selectedId, setSelectedId] = useState("binance:HK1810USDT");
  const [sessionPoints, setSessionPoints] = useState<Record<string, OraclePoint[]>>({});
  const [history, setHistory] = useState<OraclePoint[]>([]);
  const [historyInterval, setHistoryInterval] = useState("1m");
  const [startValue, setStartValue] = useState(hktDateValue(-1));
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState("");
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [broadcast, setBroadcast] = useState<BroadcastState | null>(null);
  const [customPairs, setCustomPairs] = useState<CustomPair[]>([]);
  const [pairsReady, setPairsReady] = useState(false);
  const [pairManagerOpen, setPairManagerOpen] = useState(false);
  const [newVenue, setNewVenue] = useState<CustomPair["venue"]>("Binance");
  const [newSymbol, setNewSymbol] = useState("");
  const [pairError, setPairError] = useState("");
  const [clock, setClock] = useState(0);
  const [binanceStreams, setBinanceStreams] = useState<BinanceStreamState>({ book: "connecting", oracle: "connecting" });
  const [binanceBrowserRest, setBinanceBrowserRest] = useState(false);
  const triggerDirections = useRef<Record<string, -1 | 0 | 1>>({});
  const requestInFlight = useRef(false);
  const streamCache = useRef<Record<string, Partial<OracleQuote>>>({});
  const quotesRef = useRef<OracleQuote[]>([]);
  const thresholdRef = useRef(threshold);
  const dismissBroadcast = useCallback(() => setBroadcast(null), []);

  useEffect(() => {
    let saved: CustomPair[] = [];
    try {
      saved = JSON.parse(window.localStorage.getItem(CUSTOM_PAIRS_KEY) || "[]") as CustomPair[];
    } catch { /* Device has no usable saved pairs. */ }
    const frame = window.requestAnimationFrame(() => {
      setCustomPairs(saved.filter((pair) => pair && (pair.venue === "Binance" || pair.venue === "Hyperliquid") && typeof pair.apiSymbol === "string").slice(0, 24));
      setPairsReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const quoteUrl = useMemo(() => {
    const binance = new Set(DEFAULT_BINANCE);
    const para = new Set(DEFAULT_PARA);
    for (const pair of customPairs) (pair.venue === "Binance" ? binance : para).add(pair.apiSymbol);
    const params = new URLSearchParams({ binance: [...binance].join(","), para: [...para].join(",") });
    return `/api/oracle-monitor/quotes?${params}`;
  }, [customPairs]);

  const binanceSymbols = useMemo(() => {
    const symbols = new Set(DEFAULT_BINANCE);
    for (const pair of customPairs) if (pair.venue === "Binance") symbols.add(pair.apiSymbol);
    return [...symbols];
  }, [customPairs]);

  const desiredIds = useMemo(() => {
    const ids = new Set(binanceSymbols.map((symbol) => `binance:${symbol}`));
    for (const symbol of DEFAULT_PARA) ids.add(`hyperliquid:${symbol}`);
    for (const pair of customPairs) if (pair.venue === "Hyperliquid") ids.add(`hyperliquid:${pair.apiSymbol}`);
    return ids;
  }, [binanceSymbols, customPairs]);

  const commitQuotes = useCallback((update: (current: OracleQuote[]) => OracleQuote[]) => {
    const next = update(quotesRef.current);
    quotesRef.current = next;
    setQuotes(next);

    const nextDirections: Record<string, -1 | 0 | 1> = {};
    const crossings: OracleQuote[] = [];
    for (const quote of next) {
      const direction: -1 | 0 | 1 = quote.deviation >= thresholdRef.current ? 1 : quote.deviation <= -thresholdRef.current ? -1 : 0;
      nextDirections[quote.id] = direction;
      const previous = triggerDirections.current[quote.id] ?? 0;
      if (direction !== 0 && direction !== previous) crossings.push(quote);
    }
    triggerDirections.current = nextDirections;
    if (crossings.length) {
      const strongest = crossings.reduce((best, quote) => Math.abs(quote.deviation) > Math.abs(best.deviation) ? quote : best);
      const tone = strongest.deviation >= 0 ? "positive" : "negative";
      setBroadcast({
        tone,
        title: `${strongest.symbol} ${tone === "positive" ? "POSITIVE" : "NEGATIVE"} ORACLE TRIGGER`,
        message: `${strongest.venue} live midpoint is ${formatPct(strongest.deviation)} from oracle, outside the ±${thresholdRef.current.toFixed(3)}% band${crossings.length > 1 ? ` · ${crossings.length - 1} additional trigger${crossings.length > 2 ? "s" : ""}` : ""}.`,
      });
    }

    setSessionPoints((current) => {
      const points = { ...current };
      let changed = false;
      for (const quote of next) {
        const point = { t: quote.updatedAt, live: quote.live, oracle: quote.oracle, deviation: quote.deviation };
        const existing = points[quote.id] ?? [];
        if ((existing.at(-1)?.t ?? 0) > point.t - 900) continue;
        points[quote.id] = [...existing, point].slice(-720);
        changed = true;
      }
      return changed ? points : current;
    });
  }, []);

  const applyBinanceStreamPatch = useCallback((symbol: string, patch: Partial<OracleQuote>) => {
    const normalized = symbol.toUpperCase();
    streamCache.current[normalized] = { ...streamCache.current[normalized], ...patch };
    commitQuotes((current) => {
      const existing = current.find((quote) => quote.id === `binance:${normalized}`);
      const rebuilt = rebuildBinanceQuote(normalized, { ...existing, ...streamCache.current[normalized] });
      if (!rebuilt) return current;
      const index = current.findIndex((quote) => quote.id === rebuilt.id);
      return index < 0
        ? [...current, rebuilt]
        : current.map((quote, quoteIndex) => quoteIndex === index ? rebuilt : quote);
    });
    setLastRefresh((current) => Math.max(current ?? 0, Number(patch.updatedAt) || Date.now()));
    setError("");
  }, [commitQuotes]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!pairsReady || !binanceSymbols.length) return;
    let cancelled = false;
    const sockets: Partial<Record<"book" | "oracle", WebSocket>> = {};
    const reconnectTimers: number[] = [];

    const connect = (kind: "book" | "oracle", attempt = 0) => {
      if (cancelled) return;
      setBinanceStreams((current) => ({ ...current, [kind]: attempt ? "reconnecting" : "connecting" }));
      const suffix = kind === "book" ? "@bookTicker" : "@markPrice@1s";
      const streams = binanceSymbols.map((symbol) => `${symbol.toLowerCase()}${suffix}`);
      const channel = kind === "book" ? "public" : "market";
      const socket = new WebSocket(`wss://fstream.binance.com/${channel}/stream`);
      sockets[kind] = socket;
      const openedAt = Date.now();

      socket.onopen = () => {
        socket.send(JSON.stringify({ method: "SUBSCRIBE", params: streams, id: kind === "book" ? 1 : 2 }));
        setBinanceStreams((current) => ({ ...current, [kind]: "live" }));
      };
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as BinanceStreamEnvelope;
          const data = payload.data;
          if (!data?.s) return;
          const updatedAt = finiteNumber(data.E) ?? Date.now();
          if (kind === "book") {
            applyBinanceStreamPatch(data.s, {
              bid: positiveNumber(data.b),
              bidQty: positiveNumber(data.B),
              ask: positiveNumber(data.a),
              askQty: positiveNumber(data.A),
              updatedAt,
            });
          } else {
            const mark = positiveNumber(data.p);
            const oracle = positiveNumber(data.i);
            applyBinanceStreamPatch(data.s, {
              ...(mark === null ? {} : { mark }),
              ...(oracle === null ? {} : { oracle }),
              funding: finiteNumber(data.r),
              nextFundingTime: finiteNumber(data.T),
              updatedAt,
            });
          }
        } catch { /* Ignore malformed frames and keep the healthy socket open. */ }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (cancelled || sockets[kind] !== socket) return;
        setBinanceStreams((current) => ({ ...current, [kind]: "reconnecting" }));
        const stable = Date.now() - openedAt > 15_000;
        const nextAttempt = stable ? 0 : attempt + 1;
        const delay = Math.min(6_000, 550 * 2 ** Math.min(nextAttempt, 4)) + Math.round(Math.random() * 350);
        reconnectTimers.push(window.setTimeout(() => connect(kind, nextAttempt), delay));
      };
    };

    connect("book");
    connect("oracle");
    return () => {
      cancelled = true;
      reconnectTimers.forEach((timer) => window.clearTimeout(timer));
      Object.values(sockets).forEach((socket) => socket?.close());
    };
  }, [applyBinanceStreamPatch, binanceSymbols, pairsReady]);

  const loadQuotes = useCallback(async () => {
    if (!pairsReady || requestInFlight.current) return;
    requestInFlight.current = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 9_000);
    try {
      const response = await fetch(quoteUrl, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as { quotes?: OracleQuote[]; sources?: SourceState; timestamp?: number; error?: string };
      if (!response.ok || !payload.quotes?.length) throw new Error(payload.error || "Oracle feed unavailable.");
      let browserQuotes: OracleQuote[] = [];
      if (payload.sources?.binance === false) {
        try {
          browserQuotes = await fetchBrowserBinanceQuotes(binanceSymbols, controller.signal);
        } catch { /* The WebSocket can remain the primary source. */ }
      }
      const resolvedQuotes = payload.sources?.binance === false
        ? [...payload.quotes.filter((quote) => quote.venue !== "Binance"), ...browserQuotes]
        : payload.quotes;
      for (const quote of resolvedQuotes) {
        if (quote.venue === "Binance") streamCache.current[quote.apiSymbol] = { ...streamCache.current[quote.apiSymbol], ...quote };
      }
      commitQuotes((current) => {
        const byId = new Map(current.filter((quote) => desiredIds.has(quote.id)).map((quote) => [quote.id, quote]));
        for (const quote of resolvedQuotes) {
          const existing = byId.get(quote.id);
          const websocketLive = quote.venue === "Binance" && binanceStreams.book === "live" && binanceStreams.oracle === "live";
          byId.set(quote.id, websocketLive && existing ? existing : quote);
        }
        return [...byId.values()];
      });
      const browserFallbackLive = browserQuotes.length > 0;
      setBinanceBrowserRest(browserFallbackLive);
      setSources({ binance: Boolean(payload.sources?.binance || browserFallbackLive), hyperliquid: Boolean(payload.sources?.hyperliquid) });
      setLastRefresh(payload.timestamp ?? Date.now());
      setError(payload.sources?.binance === false && !browserFallbackLive ? "Binance snapshot is retrying; live WebSocket remains active." : "");
    } catch (loadError) {
      try {
        const browserController = new AbortController();
        const browserTimeout = window.setTimeout(() => browserController.abort(), 5_000);
        const browserQuotes = await fetchBrowserBinanceQuotes(binanceSymbols, browserController.signal);
        window.clearTimeout(browserTimeout);
        for (const quote of browserQuotes) streamCache.current[quote.apiSymbol] = { ...streamCache.current[quote.apiSymbol], ...quote };
        commitQuotes((current) => {
          const byId = new Map(current.filter((quote) => desiredIds.has(quote.id)).map((quote) => [quote.id, quote]));
          for (const quote of browserQuotes) byId.set(quote.id, quote);
          return [...byId.values()];
        });
        setBinanceBrowserRest(browserQuotes.length > 0);
        setSources({ binance: browserQuotes.length > 0, hyperliquid: false });
        setLastRefresh(Date.now());
        setError(browserQuotes.length ? "Hyperliquid snapshot is retrying; Binance browser fallback is live." : "Market feeds are retrying.");
      } catch {
        setBinanceBrowserRest(false);
        setError(loadError instanceof Error && loadError.name !== "AbortError" ? loadError.message : "REST snapshot timed out; live streams are reconnecting.");
        setSources({ binance: false, hyperliquid: false });
      }
    } finally {
      window.clearTimeout(timeout);
      requestInFlight.current = false;
    }
  }, [binanceStreams.book, binanceStreams.oracle, binanceSymbols, commitQuotes, desiredIds, pairsReady, quoteUrl]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadQuotes());
    const timer = window.setInterval(loadQuotes, REFRESH_MS);
    return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); };
  }, [loadQuotes]);

  const visibleQuotes = useMemo(() => quotes.filter((quote) => clock - quote.updatedAt <= HIDE_AFTER_MS), [clock, quotes]);
  const selected = visibleQuotes.find((quote) => quote.id === selectedId) ?? visibleQuotes[0];
  const selectedVenue = selected?.venue;
  const selectedApiSymbol = selected?.apiSymbol;

  const loadHistory = useCallback(async () => {
    if (!selectedApiSymbol || selectedVenue !== "Binance") {
      setHistory([]);
      return;
    }
    const start = toEpoch(startValue);
    if (!Number.isFinite(start) || start >= Date.now()) return;
    setLoadingHistory(true);
    try {
      const response = await fetch(`/api/oracle-monitor/history?symbol=${selectedApiSymbol}&start=${start}&end=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json() as { points?: OraclePoint[]; interval?: string; error?: string };
      if (!response.ok || !payload.points?.length) throw new Error(payload.error || "No history returned.");
      setHistory(payload.points);
      setHistoryInterval(payload.interval ?? "1m");
    } catch (historyError) {
      setHistory([]);
      setError(historyError instanceof Error ? historyError.message : "History unavailable.");
    } finally {
      setLoadingHistory(false);
    }
  }, [selectedApiSymbol, selectedVenue, startValue]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadHistory());
    return () => window.cancelAnimationFrame(frame);
  }, [loadHistory]);

  const selectedSession = useMemo(() => selected ? sessionPoints[selected.id] ?? [] : [], [selected, sessionPoints]);
  const chartPoints = useMemo(() => {
    if (!selected || selected.venue !== "Binance" || !history.length) return selectedSession;
    const lastHistoryTime = history.at(-1)?.t ?? 0;
    return [...history, ...selectedSession.filter((point) => point.t > lastHistoryTime)];
  }, [history, selected, selectedSession]);
  const positive = visibleQuotes.filter((quote) => quote.deviation >= 0).sort((a, b) => b.deviation - a.deviation);
  const negative = visibleQuotes.filter((quote) => quote.deviation < 0).sort((a, b) => a.deviation - b.deviation);
  const triggered = visibleQuotes.filter((quote) => Math.abs(quote.deviation) >= threshold);
  const extreme = visibleQuotes.reduce<OracleQuote | null>((best, quote) => !best || Math.abs(quote.deviation) > Math.abs(best.deviation) ? quote : best, null);
  const binanceCount = visibleQuotes.filter((quote) => quote.venue === "Binance").length;
  const paraCount = visibleQuotes.length - binanceCount;
  const binanceWebSocketLive = binanceStreams.book === "live" && binanceStreams.oracle === "live";
  const binanceOnline = binanceCount > 0 && (binanceWebSocketLive || sources.binance);
  const paraOnline = paraCount > 0 && sources.hyperliquid;
  const binanceStatus = binanceWebSocketLive ? "Binance WS live" : binanceBrowserRest ? "Binance browser fallback" : sources.binance ? "Binance REST fallback" : "Binance reconnecting";

  const addPair = () => {
    const normalized = newVenue === "Binance"
      ? newSymbol.trim().toUpperCase()
      : newSymbol.trim().replace(/^para:/i, "para:").replace(/BTC\.D$/i, "BTCD");
    const valid = newVenue === "Binance" ? /^[A-Z0-9_]{2,32}$/.test(normalized) : /^para:[A-Z0-9._-]{1,28}$/i.test(normalized);
    if (!valid) {
      setPairError(newVenue === "Binance" ? "Use a Binance Futures symbol such as AAPLUSDT." : "Use a para symbol such as para:OTHERS.");
      return;
    }
    const builtIn = (newVenue === "Binance" ? DEFAULT_BINANCE : DEFAULT_PARA).includes(normalized);
    const duplicate = customPairs.some((pair) => pair.venue === newVenue && pair.apiSymbol === normalized);
    if (builtIn || duplicate) {
      setPairError("This pair is already monitored.");
      return;
    }
    const next = [...customPairs, { venue: newVenue, apiSymbol: normalized }].slice(0, 24);
    setCustomPairs(next);
    window.localStorage.setItem(CUSTOM_PAIRS_KEY, JSON.stringify(next));
    setNewSymbol("");
    setPairError("");
  };

  const removePair = (pair: CustomPair) => {
    const next = customPairs.filter((item) => item.venue !== pair.venue || item.apiSymbol !== pair.apiSymbol);
    setCustomPairs(next);
    window.localStorage.setItem(CUSTOM_PAIRS_KEY, JSON.stringify(next));
  };

  return (
    <main className={styles.shell}>
      <BroadcastAlert open={broadcast !== null} title={broadcast?.title ?? ""} message={broadcast?.message ?? ""} tone={broadcast?.tone ?? "positive"} onDismiss={dismissBroadcast} />
      <div className={styles.frame}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>LIVE / ORACLE INTELLIGENCE</p>
            <h1>Oracle Monitor</h1>
            <p>Compare market midpoint against oracle and mark prices across Binance TradFi contracts and Hyperliquid para indices. Trigger broadcasts fire on threshold crossings.</p>
          </div>
          <div className={styles.topActions}>
            <div className={styles.links} aria-label="Connection status">
              <span className={binanceOnline ? styles.online : ""}><i />{binanceStatus}</span>
              <span className={paraOnline ? styles.online : ""}><i />{paraOnline ? "Hyperliquid live" : "Hyperliquid reconnecting"}</span>
            </div>
            <PageSwitcher active="oracle" />
          </div>
        </header>

        <section className={styles.controlBar}>
          <label>
            Alert threshold
            <div><input type="number" min="0.001" max="10" step="0.01" value={threshold} onChange={(event) => {
              const nextThreshold = Math.max(.001, Number(event.target.value) || .1);
              thresholdRef.current = nextThreshold;
              setThreshold(nextThreshold);
              triggerDirections.current = {};
            }} /><span>%</span></div>
          </label>
          <button onClick={() => void loadQuotes()}>Refresh now</button>
          <button className={styles.secondaryButton} onClick={() => setPairManagerOpen((open) => !open)}>{pairManagerOpen ? "Close pair manager" : "Add pairs"}</button>
          <span className={styles.refreshText}>{error || (lastRefresh ? `Last live update ${formatTime(lastRefresh)} HKT · WS + 5s snapshot` : "Connecting live feeds…")}</span>
        </section>

        {pairManagerOpen && <section className={styles.pairManager} aria-label="Custom pair manager">
          <div className={styles.pairManagerCopy}>
            <p className={styles.eyebrow}>CUSTOM UNIVERSE</p>
            <h2>Add an Oracle pair</h2>
            <p>Pairs are saved on this device. Binance symbols receive historical charts; Hyperliquid para symbols collect a live session trail.</p>
          </div>
          <div className={styles.pairForm}>
            <label>Venue<select value={newVenue} onChange={(event) => setNewVenue(event.target.value as CustomPair["venue"])}><option>Binance</option><option>Hyperliquid</option></select></label>
            <label>Symbol<input value={newSymbol} onChange={(event) => setNewSymbol(event.target.value)} placeholder={newVenue === "Binance" ? "AAPLUSDT" : "para:OTHERS"} /></label>
            <button onClick={addPair}>Add pair</button>
          </div>
          {pairError && <p className={styles.pairError}>{pairError}</p>}
          <div className={styles.customPairs}>
            {customPairs.map((pair) => <span key={`${pair.venue}:${pair.apiSymbol}`}><b>{pair.venue}</b>{pair.apiSymbol === "para:BTCD" ? "para:BTC.D" : pair.apiSymbol}<button aria-label={`Remove ${pair.apiSymbol}`} onClick={() => removePair(pair)}>×</button></span>)}
            {!customPairs.length && <small>No custom pairs on this device.</small>}
          </div>
        </section>}

        <section className={styles.stats}>
          <article><span>Live now</span><strong>{visibleQuotes.length || "—"}</strong><small>{binanceCount} Binance · {paraCount} Hyperliquid para</small></article>
          <article><span>Triggered</span><strong className={triggered.length ? styles.warningText : ""}>{triggered.length}</strong><small>Outside ±{threshold.toFixed(3)}%</small></article>
          <article><span>Largest drift</span><strong className={extreme && extreme.deviation >= 0 ? styles.positive : styles.negative}>{extreme ? formatPct(extreme.deviation) : "—"}</strong><small>{extreme?.symbol ?? "Waiting for data"}</small></article>
          <article><span>Selected funding</span><strong>{selected?.funding == null ? "—" : formatPct(selected.funding * 100, 4)}</strong><small>{selected ? `${selected.fundingHours}h rate · ${selected.venue}` : "—"}</small></article>
        </section>

        <section className={styles.deviationBoard}>
          <div className={`${styles.side} ${styles.positiveSide}`}>
            <header><div><span>↗</span><strong>Positive deviation</strong></div><b>{positive.length}</b></header>
            <div className={styles.cardList}>{positive.map((quote) => <QuoteCard key={quote.id} quote={quote} threshold={threshold} stale={clock - quote.updatedAt > STALE_AFTER_MS} selected={quote.id === selected?.id} onSelect={() => setSelectedId(quote.id)} />)}
              {!positive.length && <p>No positive deviations.</p>}
            </div>
          </div>
          <div className={`${styles.side} ${styles.negativeSide}`}>
            <header><div><span>↘</span><strong>Negative deviation</strong></div><b>{negative.length}</b></header>
            <div className={styles.cardList}>{negative.map((quote) => <QuoteCard key={quote.id} quote={quote} threshold={threshold} stale={clock - quote.updatedAt > STALE_AFTER_MS} selected={quote.id === selected?.id} onSelect={() => setSelectedId(quote.id)} />)}
              {!negative.length && <p>No negative deviations.</p>}
            </div>
          </div>
        </section>

        <section className={styles.chartPanel}>
          <div className={styles.panelHead}>
            <div><p className={styles.eyebrow}>DEVIATION HISTORY</p><h2>{selected?.symbol ?? "Select a contract"}</h2></div>
            {selected?.venue === "Binance" ? <div className={styles.historyControls}>
              <label>Window start · HKT<input type="datetime-local" value={startValue} onChange={(event) => setStartValue(event.target.value)} /></label>
              <button onClick={() => void loadHistory()}>Apply</button>
            </div> : <span className={styles.sessionLabel}>Live session trail · starts when this page opens</span>}
          </div>
          {loadingHistory ? <div className={styles.emptyChart}>Loading market and oracle history…</div>
            : chartPoints.length > 1 && selected ? <DeviationChart points={chartPoints} threshold={threshold} symbol={selected.symbol} />
              : <div className={styles.emptyChart}>{selected?.venue === "Hyperliquid" ? "Collecting live para deviation samples…" : "Waiting for synchronized history…"}</div>}
          <footer className={styles.chartFooter}>
            <span>{selected?.venue === "Binance" ? `Binance market and index-price klines · ${historyInterval}` : "Hyperliquid metaAndAssetCtxs · live midpoint / oracle"}</span>
            <span>{chartPoints.length.toLocaleString()} points</span>
          </footer>
        </section>

        <ParaDepthHeatmap />

        <footer className={styles.footer}>Oracle and mark prices are reference inputs, not executable prices. Funding is shown in each venue&apos;s native interval.</footer>
      </div>
    </main>
  );
}
