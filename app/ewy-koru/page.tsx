"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type MarketPoint = {
  t: number;
  ewy: number;
  koru: number;
  pairId: PairId;
};

type DerivedPoint = MarketPoint & {
  ewyReturn: number;
  koruReturn: number;
  ewyTriple: number;
  residual: number;
};

type FeedState = "connecting" | "posley-office" | "posley-remote" | "binance-rest" | "paused";

type OrderLevel = {
  price: number;
  size: number;
};

type OrderBook = {
  bids: OrderLevel[];
  asks: OrderLevel[];
  ts: number;
};

type PairId = "ewy-koru" | "sndk-snxx" | "mrvl-mvll" | "qqq-tqqq" | "tencent-hk0700";

type PairConfig = {
  id: PairId;
  base: string;
  leveraged: string;
  factor: 1 | 2 | 3;
  priceRatio?: number;
  label: string;
};

const OFFICE_RELAY = "ws://192.168.50.112:8787/ws";
const REMOTE_GATEWAY = process.env.NEXT_PUBLIC_REDIS_BACKEND_URL ?? "https://redis-data.posley.capital";
const COGNITO_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "5qup0una5tdma3l33pnn1gm87i";
const COGNITO_DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "posley.auth.us-east-1.amazoncognito.com";
const PAIRS: Record<PairId, PairConfig> = {
  "ewy-koru": { id: "ewy-koru", base: "EWYUSDT", leveraged: "KORUUSDT", factor: 3, label: "EWY ↔ KORU · 3×" },
  "sndk-snxx": { id: "sndk-snxx", base: "SNDKUSDT", leveraged: "SNXXUSDT", factor: 2, label: "SNDK ↔ SNXX · 2×" },
  "mrvl-mvll": { id: "mrvl-mvll", base: "MRVLUSDT", leveraged: "MVLLUSDT", factor: 2, label: "MRVL ↔ MVLL · 2×" },
  "qqq-tqqq": { id: "qqq-tqqq", base: "QQQUSDT", leveraged: "TQQQUSDT", factor: 3, label: "QQQ ↔ TQQQ · 3×" },
  "tencent-hk0700": {
    id: "tencent-hk0700",
    base: "TENCENTUSDT",
    leveraged: "HK0700USDT",
    factor: 1,
    priceRatio: 7.84,
    label: "TENCENT ↔ HK0700 · 7.84:1",
  },
};

const hktDateTimeValue = (offsetDays = 0, hour = 7) => {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return `${now.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00`;
};

const hktValueToEpoch = (value: string) => Date.parse(`${value}:00+08:00`);
const pct = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const residualPct = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const price = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const hktTime = (value: number, includeDate = false) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    month: includeDate ? "short" : undefined,
    day: includeDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: includeDate ? undefined : "2-digit",
    hour12: false,
  }).format(value);

function parseLevels(levels?: string): OrderLevel[] {
  if (!levels) return [];
  return levels
    .split("|")
    .filter(Boolean)
    .map((level) => {
      const [priceText, sizeText] = level.split(",", 2);
      return { price: Number(priceText), size: Number(sizeText) };
    })
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
    .slice(0, 5);
}

function encodeBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function beginPosleyLogin() {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = encodeBase64Url(new Uint8Array(digest));
  sessionStorage.setItem("equity_monitor_pkce", verifier);
  sessionStorage.setItem("equity_monitor_return_to", "/ewy-koru");
  const params = new URLSearchParams({
    client_id: COGNITO_CLIENT_ID,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: `${location.origin}/`,
    identity_provider: "Google",
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  location.assign(`https://${COGNITO_DOMAIN}/oauth2/authorize?${params}`);
}

function FiveLevelOrderBook({ symbol, book }: { symbol: string; book?: OrderBook }) {
  const rows = Array.from({ length: 5 }, (_, index) => index);
  const spread = book?.bids[0] && book?.asks[0] ? book.asks[0].price - book.bids[0].price : null;

  return (
    <article className={styles.orderBookCard}>
      <div className={styles.orderBookHead}>
        <div>
          <p className={styles.metricLabel}>{symbol}</p>
          <h3>Five-level order book</h3>
        </div>
        <span className={styles.bookSpread}>{spread === null ? "Waiting for depth" : `Spread ${price(spread)}`}</span>
      </div>
      <table className={styles.orderBookTable}>
        <thead>
          <tr><th>Level</th><th>Bid size</th><th>Bid</th><th>Ask</th><th>Ask size</th></tr>
        </thead>
        <tbody>
          {rows.map((index) => {
            const bid = book?.bids[index];
            const ask = book?.asks[index];
            return (
              <tr key={index}>
                <td>{index + 1}</td>
                <td>{bid ? price(bid.size) : "—"}</td>
                <td className={styles.bidPrice}>{bid ? price(bid.price) : "—"}</td>
                <td className={styles.askPrice}>{ask ? price(ask.price) : "—"}</td>
                <td>{ask ? price(ask.size) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={styles.bookTimestamp}>{book ? `Updated ${hktTime(book.ts)} HKT` : "Connecting to live depth feed…"}</p>
    </article>
  );
}

function PriceRatioChart({ points, target }: { points: DerivedPoint[]; target: number }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 1240;
  const height = 470;
  const left = 72;
  const right = 24;
  const top = 42;
  const bottom = 420;
  const ratios = points.map((point) => point.koru / point.ewy);
  const ratioMin = Math.min(target, ...ratios);
  const ratioMax = Math.max(target, ...ratios);
  const pad = Math.max(0.01, (ratioMax - ratioMin) * 0.12);
  const yMin = ratioMin - pad;
  const yMax = ratioMax + pad;
  const x = (index: number) => left + (index / Math.max(1, points.length - 1)) * (width - left - right);
  const y = (value: number) => top + ((yMax - value) / Math.max(0.0001, yMax - yMin)) * (bottom - top);
  const path = ratios.map((value, index) => `${index ? "L" : "M"} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`).join(" ");
  const ratioTicks = Array.from({ length: 5 }, (_, index) => yMin + ((yMax - yMin) * index) / 4);
  const timeTicks = Array.from(new Set([0, Math.floor((points.length - 1) / 4), Math.floor((points.length - 1) / 2), Math.floor((points.length - 1) * 0.75), points.length - 1]));
  const selected = hoverIndex === null ? points.at(-1) : points[hoverIndex];
  const selectedRatio = selected ? selected.koru / selected.ewy : null;

  return (
    <div
      className={styles.chartWrap}
      onMouseLeave={() => setHoverIndex(null)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const innerX = ((event.clientX - rect.left) / rect.width) * width;
        const index = Math.round(((innerX - left) / (width - left - right)) * (points.length - 1));
        setHoverIndex(Math.max(0, Math.min(points.length - 1, index)));
      }}
    >
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`HK0700USDT to TENCENTUSDT price ratio against ${target}`}>
        <rect x={left} y={top} width={width - left - right} height={bottom - top} fill="#fbfcfe" />
        {ratioTicks.map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke="#dfe6ef" strokeWidth="1" />
            <text x={left - 10} y={y(tick) + 4} textAnchor="end" fill="#748197" fontSize="11">{tick.toFixed(4)}</text>
          </g>
        ))}
        {timeTicks.map((index) => (
          <g key={index}>
            <line x1={x(index)} x2={x(index)} y1={top} y2={bottom} stroke="#edf1f6" strokeWidth="1" />
            <text x={x(index)} y={height - 12} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fill="#748197" fontSize="11">
              {hktTime(points[index].t, true)}
            </text>
          </g>
        ))}
        <line x1={left} x2={width - right} y1={y(target)} y2={y(target)} stroke="#f28c32" strokeWidth="2.5" strokeDasharray="8 7" />
        <path d={path} fill="none" stroke="#079a76" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
        {selectedRatio !== null && hoverIndex !== null && (
          <>
            <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={top} y2={bottom} stroke="#8090a6" strokeWidth="1" strokeDasharray="4 4" />
            <circle cx={x(hoverIndex)} cy={y(selectedRatio)} r="5" fill="#079a76" stroke="#fff" strokeWidth="2" />
          </>
        )}
      </svg>
      {selected && selectedRatio !== null && hoverIndex !== null && (
        <div
          className={styles.tooltip}
          style={{
            left: `${Math.min(78, Math.max(4, (hoverIndex / Math.max(1, points.length - 1)) * 100))}%`,
            top: "70px",
          }}
        >
          <strong>{hktTime(selected.t, true)} HKT</strong>
          <div>Price ratio {selectedRatio.toFixed(4)}</div>
          <div>Target {target.toFixed(4)}</div>
          <div>Deviation {residualPct((selectedRatio / target - 1) * 100)}</div>
        </div>
      )}
    </div>
  );
}

function RelativeValueChart({ points, threshold, pair }: { points: DerivedPoint[]; threshold: number; pair: PairConfig }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 1240;
  const height = 650;
  const left = 72;
  const right = 24;
  const topA = 42;
  const bottomA = 360;
  const topB = 438;
  const bottomB = 606;
  const latest = points.at(-1);
  const baseReturnLabel = pair.factor === 1 ? `${pair.base} return` : `${pair.factor} × ${pair.base} return`;
  const residualLabel = pair.priceRatio
    ? `Deviation = ${pair.leveraged} ÷ (${pair.priceRatio} × ${pair.base}) − 1`
    : `Residual = ${pair.leveraged} return − ${pair.factor} × ${pair.base} return`;

  const allReturns = points.flatMap((point) => [point.koruReturn, point.ewyTriple]);
  const returnMin = Math.min(...allReturns, -1);
  const returnMax = Math.max(...allReturns, 1);
  const returnPad = Math.max(1, (returnMax - returnMin) * 0.08);
  const yMin = returnMin - returnPad;
  const yMax = returnMax + returnPad;
  const residualAbs = Math.max(1.5, ...points.map((point) => Math.abs(point.residual)), threshold + 0.5);

  const x = (index: number) => left + (index / Math.max(1, points.length - 1)) * (width - left - right);
  const yReturn = (value: number) => topA + ((yMax - value) / Math.max(0.01, yMax - yMin)) * (bottomA - topA);
  const yResidual = (value: number) => topB + ((residualAbs - value) / (residualAbs * 2)) * (bottomB - topB);
  const pathFor = (selector: (point: DerivedPoint) => number, y: (value: number) => number) =>
    points.map((point, index) => `${index ? "L" : "M"} ${x(index).toFixed(2)} ${y(selector(point)).toFixed(2)}`).join(" ");
  const selected = hoverIndex === null ? latest : points[hoverIndex];
  const returnTicks = Array.from({ length: 5 }, (_, index) => yMin + ((yMax - yMin) * index) / 4);
  const residualTicks = [-residualAbs, -threshold, 0, threshold, residualAbs]
    .filter((value, index, values) => values.findIndex((candidate) => Math.abs(candidate - value) < 0.001) === index)
    .sort((a, b) => a - b);
  const timeTicks = Array.from(new Set([0, Math.floor((points.length - 1) / 4), Math.floor((points.length - 1) / 2), Math.floor((points.length - 1) * 0.75), points.length - 1]));

  return (
    <div
      className={styles.chartWrap}
      onMouseLeave={() => setHoverIndex(null)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const innerX = ((event.clientX - rect.left) / rect.width) * width;
        const index = Math.round(((innerX - left) / (width - left - right)) * (points.length - 1));
        setHoverIndex(Math.max(0, Math.min(points.length - 1, index)));
      }}
    >
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${pair.base} and ${pair.leveraged} normalized returns and relative-value residual`}>
        <rect x={left} y={topA} width={width - left - right} height={bottomA - topA} fill="#fbfcfe" />
        <rect x={left} y={topB} width={width - left - right} height={bottomB - topB} fill="#fbfcfe" />
        {returnTicks.map((tick) => (
          <g key={`r-${tick}`}>
            <line x1={left} x2={width - right} y1={yReturn(tick)} y2={yReturn(tick)} stroke="#dfe6ef" strokeWidth="1" />
            <text x={left - 10} y={yReturn(tick) + 4} textAnchor="end" fill="#748197" fontSize="11">{pct(tick, 1)}</text>
          </g>
        ))}
        {residualTicks.map((tick) => (
          <g key={`p-${tick}`}>
            <line
              x1={left}
              x2={width - right}
              y1={yResidual(tick)}
              y2={yResidual(tick)}
              stroke={Math.abs(tick) === threshold ? "#bf9769" : tick === 0 ? "#9ba8ba" : "#dfe6ef"}
              strokeWidth={tick === 0 ? "2" : "1"}
              strokeDasharray={Math.abs(tick) === threshold ? "6 6" : undefined}
            />
            <text x={left - 10} y={yResidual(tick) + 4} textAnchor="end" fill="#748197" fontSize="11">{residualPct(tick, 1)}</text>
          </g>
        ))}
        {timeTicks.map((index) => (
          <g key={`t-${index}`}>
            <line x1={x(index)} x2={x(index)} y1={topA} y2={bottomB} stroke="#edf1f6" strokeWidth="1" />
            <text x={x(index)} y={height - 12} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fill="#748197" fontSize="11">
              {hktTime(points[index].t, true)}
            </text>
          </g>
        ))}
        <text x={left} y={24} fill="#10233f" fontSize="13" fontWeight="700">Cumulative return from selected baseline</text>
        <text x={left} y={421} fill="#10233f" fontSize="13" fontWeight="700">{residualLabel}</text>
        <path d={pathFor((point) => point.koruReturn, yReturn)} fill="none" stroke="#f28c32" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d={pathFor((point) => point.ewyTriple, yReturn)} fill="none" stroke="#2476e5" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d={pathFor((point) => point.residual, yResidual)} fill="none" stroke="#079a76" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point, index) => Math.abs(point.residual) >= threshold && index % 3 === 0 ? (
          <circle key={point.t} cx={x(index)} cy={yResidual(point.residual)} r="2.5" fill={point.residual > 0 ? "#f28c32" : "#d85151"} />
        ) : null)}
        {selected && hoverIndex !== null && (
          <>
            <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={topA} y2={bottomB} stroke="#8090a6" strokeWidth="1" strokeDasharray="4 4" />
            <circle cx={x(hoverIndex)} cy={yReturn(selected.koruReturn)} r="5" fill="#f28c32" stroke="#fff" strokeWidth="2" />
            <circle cx={x(hoverIndex)} cy={yReturn(selected.ewyTriple)} r="5" fill="#2476e5" stroke="#fff" strokeWidth="2" />
            <circle cx={x(hoverIndex)} cy={yResidual(selected.residual)} r="5" fill="#079a76" stroke="#fff" strokeWidth="2" />
          </>
        )}
      </svg>
      {selected && hoverIndex !== null && (
        <div
          className={styles.tooltip}
          style={{
            left: `${Math.min(78, Math.max(4, (hoverIndex / Math.max(1, points.length - 1)) * 100))}%`,
            top: "74px",
          }}
        >
          <strong>{hktTime(selected.t, true)} HKT</strong>
          <div>{pair.leveraged} return {pct(selected.koruReturn)}</div>
          <div>{baseReturnLabel} {pct(selected.ewyTriple)}</div>
          <div>Residual {residualPct(selected.residual)}</div>
        </div>
      )}
    </div>
  );
}

export default function EwyKoruMonitor() {
  const [pairId, setPairId] = useState<PairId>("ewy-koru");
  const [startValue, setStartValue] = useState(hktDateTimeValue(0, 7));
  const [endValue, setEndValue] = useState(hktDateTimeValue(0, 16));
  const [liveEnd, setLiveEnd] = useState(true);
  const [threshold, setThreshold] = useState(1);
  const [rawPoints, setRawPoints] = useState<MarketPoint[]>([]);
  const [interval, setIntervalName] = useState("1m");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dataNotice, setDataNotice] = useState("");
  const [feed, setFeed] = useState<FeedState>("connecting");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [liveBooks, setLiveBooks] = useState<{ ewy?: OrderBook; koru?: OrderBook }>({});
  const socketRef = useRef<WebSocket | null>(null);
  const feedRef = useRef<FeedState>("connecting");
  const liveQuoteRef = useRef<{
    ewy?: { price: number; ts: number };
    koru?: { price: number; ts: number };
  }>({});
  const lastAppendRef = useRef(0);
  const historyAbortRef = useRef<AbortController | null>(null);
  const historyRequestRef = useRef(0);
  const feedGenerationRef = useRef(0);
  const pair = PAIRS[pairId];

  const setFeedState = (next: FeedState) => {
    feedRef.current = next;
    setFeed(next);
  };

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequestRef.current;
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    const start = hktValueToEpoch(startValue);
    const end = liveEnd ? Date.now() : hktValueToEpoch(endValue);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      setError("Choose a valid baseline before the end time.");
      return;
    }
    setLoading(true);
    setError("");
    setDataNotice("");
    try {
      const response = await fetch(
        `/api/ewy-koru/history?pair=${pairId}&start=${start}&end=${end}`,
        { cache: "no-store", signal: controller.signal },
      );
      const payload = await response.json() as {
        interval?: string;
        points?: Array<Omit<MarketPoint, "pairId">>;
        error?: string;
      };
      if (requestId !== historyRequestRef.current || controller.signal.aborted) return;
      if (!response.ok || !payload.points?.length) throw new Error(payload.error || "No matched EWY/KORU observations were returned.");
      setRawPoints(payload.points.map((point) => ({ ...point, pairId })));
      setIntervalName(payload.interval || "1m");
    } catch (loadError) {
      if (controller.signal.aborted || requestId !== historyRequestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load history.");
    } finally {
      if (requestId === historyRequestRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, [endValue, liveEnd, pairId, startValue]);

  useEffect(() => {
    void loadHistory();
    return () => historyAbortRef.current?.abort();
  }, [loadHistory]);

  useEffect(() => {
    if (!liveEnd) {
      socketRef.current?.close();
      setLiveBooks({});
      setFeedState("paused");
      return;
    }

    liveQuoteRef.current = {};
    setLiveBooks({});
    lastAppendRef.current = 0;
    const generation = ++feedGenerationRef.current;
    let cancelled = false;
    let remoteStarted = false;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let officeTimeout: ReturnType<typeof setTimeout> | null = null;
    const isActive = () => !cancelled && feedGenerationRef.current === generation;

    const appendLivePoint = (t: number, ewy: number, koru: number) => {
      if (!isActive()) return;
      if (t - lastAppendRef.current < 2500) return;
      lastAppendRef.current = t;
      setRawPoints((current) => {
        if (!isActive()) return current;
        const prior = current.at(-1);
        if (prior) {
          const baseJump = Math.abs(ewy / prior.ewy - 1);
          const leveragedJump = Math.abs(koru / prior.koru - 1);
          if (baseJump > 0.15 || leveragedJump > 0.15) {
            setDataNotice(
              `A discontinuous quote was rejected for ${pair.label}. Waiting for a synchronized update before extending the chart.`,
            );
            return current;
          }
          if (t <= prior.t) return current;
        }
        setDataNotice("");
        setLastUpdate(t);
        const next = [...current, { t, ewy, koru, pairId }];
        return next.slice(-1500);
      });
    };

    const acceptBook = (streamKey: string, data: Record<string, string>) => {
      const bids = parseLevels(data.bids);
      const asks = parseLevels(data.asks);
      const bid = bids[0]?.price;
      const ask = asks[0]?.price;
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
      const mid = (bid + ask) / 2;
      const quoteTs = Number(data.last_tick_ts_ms || data.event_emit_ts_ms) || Date.now();
      const book = { bids, asks, ts: quoteTs };
      if (streamKey.endsWith(pair.base)) {
        liveQuoteRef.current.ewy = { price: mid, ts: quoteTs };
        setLiveBooks((current) => ({ ...current, ewy: book }));
      }
      if (streamKey.endsWith(pair.leveraged)) {
        liveQuoteRef.current.koru = { price: mid, ts: quoteTs };
        setLiveBooks((current) => ({ ...current, koru: book }));
      }
      const { ewy, koru } = liveQuoteRef.current;
      if (!ewy || !koru) return;
      if (Math.abs(ewy.ts - koru.ts) > 10_000) return;
      appendLivePoint(Math.max(ewy.ts, koru.ts), ewy.price, koru.price);
    };

    const startRestFallback = () => {
      if (fallbackTimer || !isActive()) return;
      setFeedState("binance-rest");
      const poll = async () => {
        try {
          const response = await fetch(`/api/ewy-koru/quote?pair=${pairId}`, { cache: "no-store" });
          const quote = await response.json() as {
            t: number;
            ewy: { mid: number; bids: OrderLevel[]; asks: OrderLevel[]; ts: number };
            koru: { mid: number; bids: OrderLevel[]; asks: OrderLevel[]; ts: number };
          };
          if (response.ok && isActive()) {
            setLiveBooks({
              ewy: { bids: quote.ewy.bids, asks: quote.ewy.asks, ts: quote.ewy.ts || quote.t },
              koru: { bids: quote.koru.bids, asks: quote.koru.asks, ts: quote.koru.ts || quote.t },
            });
            appendLivePoint(quote.t, quote.ewy.mid, quote.koru.mid);
          }
        } catch {
          // The next polling cycle retries automatically.
        }
      };
      void poll();
      fallbackTimer = setInterval(poll, 5000);
    };

    const connectRemote = () => {
      if (remoteStarted || !isActive()) return;
      remoteStarted = true;
      const token = localStorage.getItem("equity_monitor_id_token");
      const expiresAt = Number(localStorage.getItem("equity_monitor_expires_at") || 0);
      if (!token || expiresAt < Date.now() + 30_000) {
        startRestFallback();
        return;
      }
      const url = new URL("/socket.io/", REMOTE_GATEWAY);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.search = "EIO=4&transport=websocket";
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => socket.send(`40${JSON.stringify({ token })}`);
      socket.onmessage = (message) => {
        if (!isActive()) return;
        const frame = String(message.data);
        if (frame === "2") return socket.send("3");
        if (frame.startsWith("40")) {
          setFeedState("posley-remote");
          [pair.base, pair.leveraged].map((symbol) => `orderbook:binance:perp:${symbol}`).forEach((streamKey) => {
            socket.send(`42${JSON.stringify(["stream:subscribe", { streamKey, region: "tokyo" }])}`);
          });
          return;
        }
        if (!frame.startsWith("42")) return;
        const [eventName, event] = JSON.parse(frame.slice(2)) as [string, {
          streamKey?: string;
          entries?: Array<{ data?: Record<string, string> }>;
        }];
        if (eventName !== "stream:data" || !event.streamKey) return;
        const data = event.entries?.at(-1)?.data;
        if (data) acceptBook(event.streamKey, data);
      };
      socket.onerror = startRestFallback;
      socket.onclose = () => {
        if (isActive()) startRestFallback();
      };
    };

    const connectOffice = () => {
      if (location.protocol !== "http:") {
        connectRemote();
        return;
      }
      setFeedState("connecting");
      const socket = new WebSocket(OFFICE_RELAY);
      socketRef.current = socket;
      let connected = false;
      officeTimeout = setTimeout(() => {
        if (!connected && isActive()) {
          socket.close();
          connectRemote();
        }
      }, 2500);
      socket.onopen = () => {
        connected = true;
        if (officeTimeout) clearTimeout(officeTimeout);
        setFeedState("posley-office");
        socket.send(JSON.stringify({
          action: "subscribe",
          keys: [pair.base, pair.leveraged].map((symbol) => `orderbook:binance:perp:${symbol}`),
          snapshot: 1,
        }));
      };
      socket.onmessage = (message) => {
        if (!isActive()) return;
        const event = JSON.parse(String(message.data)) as {
          type?: string;
          key?: string;
          fields?: Record<string, string>;
        };
        if (event.type === "entry" && event.key && event.fields) acceptBook(event.key, event.fields);
      };
      socket.onerror = () => {
        if (!connected) connectRemote();
      };
      socket.onclose = () => {
        if (connected && isActive()) startRestFallback();
      };
    };

    connectOffice();
    return () => {
      cancelled = true;
      if (officeTimeout) clearTimeout(officeTimeout);
      if (fallbackTimer) clearInterval(fallbackTimer);
      socketRef.current?.close();
    };
  }, [liveEnd, pair.base, pair.leveraged, pairId]);

  const points = useMemo<DerivedPoint[]>(() => {
    const activePoints = rawPoints.filter((point) => point.pairId === pairId);
    const baseline = activePoints[0];
    if (!baseline) return [];
    return activePoints.map((point) => {
      const ewyReturn = (point.ewy / baseline.ewy - 1) * 100;
      const koruReturn = (point.koru / baseline.koru - 1) * 100;
      return {
        ...point,
        ewyReturn,
        koruReturn,
        ewyTriple: ewyReturn * pair.factor,
        residual: pair.priceRatio
          ? (point.koru / (point.ewy * pair.priceRatio) - 1) * 100
          : koruReturn - ewyReturn * pair.factor,
      };
    });
  }, [pair.factor, pair.priceRatio, rawPoints]);

  const latest = points.at(-1);
  const currentRatio = latest && pair.priceRatio ? latest.koru / latest.ewy : null;
  const peakPositive = points.reduce<DerivedPoint | null>((best, point) => !best || point.residual > best.residual ? point : best, null);
  const peakNegative = points.reduce<DerivedPoint | null>((best, point) => !best || point.residual < best.residual ? point : best, null);
  const alerting = latest ? Math.abs(latest.residual) >= threshold : false;
  const signal = !latest
    ? "Waiting for data"
    : latest.residual >= threshold
      ? `${pair.leveraged} rich · short ${pair.leveraged} / long ${pair.priceRatio ? `${pair.priceRatio}× ` : ""}${pair.base}`
      : latest.residual <= -threshold
        ? `${pair.leveraged} cheap · long ${pair.leveraged} / short ${pair.priceRatio ? `${pair.priceRatio}× ` : ""}${pair.base}`
        : "Inside monitoring band";
  const recentRows = points.slice(-6).reverse();
  const feedLabel = {
    connecting: "Connecting live feed",
    "posley-office": "Live · Posley office relay",
    "posley-remote": "Live · Posley remote gateway",
    "binance-rest": "Live · Binance REST fallback",
    paused: "Historical review · live paused",
  }[feed];

  return (
    <div className={styles.shell}>
      <div className={styles.frame}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>RELATIVE-VALUE INTELLIGENCE</p>
            <h1 className={styles.title}>Leveraged Pair Monitor</h1>
            <p className={styles.subtitle}>
              Track five linked-product combinations from any selected baseline. Positive residual means the comparison product is rich versus its target relationship; negative residual means it is cheap.
            </p>
          </div>
          <div className={styles.statusStack}>
            <span className={`${styles.status} ${feed.startsWith("posley") || feed === "binance-rest" ? styles.statusLive : ""}`}><i />{feedLabel}</span>
            <PageSwitcher active="pairs" />
          </div>
        </header>

        <section className={styles.controlBar} aria-label="Monitoring controls">
          <label className={styles.field}>
            Monitoring pair
            <select
              value={pairId}
              onChange={(event) => {
                historyAbortRef.current?.abort();
                socketRef.current?.close();
                feedGenerationRef.current += 1;
                liveQuoteRef.current = {};
                setLiveBooks({});
                setRawPoints([]);
                setLoading(true);
                setDataNotice("");
                setPairId(event.target.value as PairId);
              }}
            >
              {Object.values(PAIRS).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            {pair.priceRatio ? "Window start · HKT" : "Baseline time · HKT"}
            <input type="datetime-local" value={startValue} onChange={(event) => setStartValue(event.target.value)} />
          </label>
          <label className={styles.toggle}>
            <input type="checkbox" checked={liveEnd} onChange={(event) => setLiveEnd(event.target.checked)} />
            Continue to live
          </label>
          {!liveEnd && (
            <label className={styles.field}>
              End time · HKT
              <input type="datetime-local" value={endValue} onChange={(event) => setEndValue(event.target.value)} />
            </label>
          )}
          <label className={styles.field}>
            Alert threshold · %
            <input type="number" min="0.1" max="10" step="0.1" value={threshold} onChange={(event) => setThreshold(Math.max(0.1, Number(event.target.value) || 1))} />
          </label>
          <div className={styles.buttonGroup}>
            <button className={styles.presetButton} onClick={() => { setStartValue(hktDateTimeValue(0, 7)); setLiveEnd(true); }}>Today 07:00</button>
            <button className={styles.presetButton} onClick={() => { setStartValue(hktDateTimeValue(-1, 7)); setLiveEnd(true); }}>Yesterday 07:00</button>
            <button className={styles.presetButton} onClick={() => {
              historyAbortRef.current?.abort();
              socketRef.current?.close();
              feedGenerationRef.current += 1;
              liveQuoteRef.current = {};
              setLiveBooks({});
              setRawPoints([]);
              setLoading(true);
              setDataNotice("");
              setPairId("ewy-koru");
              setStartValue("2026-07-29T07:00");
              setEndValue("2026-07-29T16:00");
              setLiveEnd(false);
            }}>29 Jul EWY/KORU case</button>
            <button className={styles.primaryButton} onClick={() => void loadHistory()}>{pair.priceRatio ? "Apply window" : "Apply baseline"}</button>
          </div>
        </section>

        <section className={styles.metricGrid}>
          <article className={`${styles.metricCard} ${styles.signalCard}`}>
            <p className={styles.metricLabel}>Current signal</p>
            <div className={`${styles.metricValue} ${alerting ? latest!.residual > 0 ? styles.metricValuePositive : styles.metricValueNegative : ""}`}>{signal}</div>
            <p className={styles.metricSub}>Alert band ±{threshold.toFixed(1)}% · costs, liquidity, funding and legging risk are not included.</p>
          </article>
          <article className={styles.metricCard}>
            <p className={styles.metricLabel}>{pair.priceRatio ? "Current price ratio" : "Current residual"}</p>
            <div className={`${styles.metricValue} ${latest && latest.residual >= 0 ? styles.metricValuePositive : styles.metricValueNegative}`}>
              {pair.priceRatio ? currentRatio?.toFixed(4) ?? "—" : latest ? residualPct(latest.residual) : "—"}
            </div>
            <p className={styles.metricSub}>
              {pair.priceRatio
                ? `Target ${pair.priceRatio.toFixed(4)} · deviation ${latest ? residualPct(latest.residual) : "—"}`
                : `${pair.leveraged} return minus ${pair.factor}× ${pair.base} return`}
            </p>
          </article>
          <article className={styles.metricCard}>
            <p className={styles.metricLabel}>{pair.base}</p>
            <div className={styles.metricValue}>{latest ? price(latest.ewy) : "—"}</div>
            <p className={styles.metricSub}>{latest ? pair.priceRatio ? "Live midpoint" : `${pct(latest.ewyReturn)} from baseline` : "Waiting for price"}</p>
          </article>
          <article className={styles.metricCard}>
            <p className={styles.metricLabel}>{pair.leveraged}</p>
            <div className={styles.metricValue}>{latest ? price(latest.koru) : "—"}</div>
            <p className={styles.metricSub}>{latest ? pair.priceRatio ? "Live midpoint" : `${pct(latest.koruReturn)} from baseline` : "Waiting for price"}</p>
          </article>
          <article className={styles.metricCard}>
            <p className={styles.metricLabel}>Last update</p>
            <div className={styles.metricValue}>{lastUpdate ? hktTime(lastUpdate) : latest ? hktTime(latest.t) : "—"}</div>
            <p className={styles.metricSub}>{points.length.toLocaleString()} points · {interval} history</p>
          </article>
        </section>

        {dataNotice && <div className={styles.qualityWarning} role="status">{dataNotice}</div>}

        {pair.priceRatio && (
          <section className={styles.orderBookPanel} aria-label="Live five-level order books">
            <div className={styles.panelHead}>
              <div>
                <p className={styles.panelKicker}>LIVE MARKET DEPTH</p>
                <h2 className={styles.panelTitle}>Five-level order books</h2>
              </div>
              <span className={styles.bookSource}>{feedLabel}</span>
            </div>
            <div className={styles.orderBookGrid}>
              <FiveLevelOrderBook symbol={pair.base} book={liveBooks.ewy} />
              <FiveLevelOrderBook symbol={pair.leveraged} book={liveBooks.koru} />
            </div>
          </section>
        )}

        <section className={styles.chartPanel}>
          <div className={styles.panelHead}>
            <div>
              <p className={styles.panelKicker}>FULL-WINDOW EVIDENCE</p>
              <h2 className={styles.panelTitle}>{pair.priceRatio ? `Direct price ratio vs ${pair.priceRatio.toFixed(4)}` : "Normalized performance and residual"}</h2>
            </div>
            <div className={styles.legend}>
              {pair.priceRatio ? (
                <>
                  <span><i style={{ background: "#079a76" }} />HK0700USDT / TENCENTUSDT</span>
                  <span><i style={{ background: "#f28c32" }} />Theoretical ratio {pair.priceRatio.toFixed(4)}</span>
                </>
              ) : (
                <>
                  <span><i style={{ background: "#f28c32" }} />{pair.leveraged} return</span>
                  <span><i style={{ background: "#2476e5" }} />{pair.factor === 1 ? pair.base : `${pair.factor} × ${pair.base}`} return</span>
                  <span><i style={{ background: "#079a76" }} />Residual</span>
                </>
              )}
            </div>
          </div>
          {loading
            ? <div className={styles.loading}>Loading synchronized pair history…</div>
            : error
              ? <div className={styles.error}>{error}</div>
              : points.length
                ? pair.priceRatio
                  ? <PriceRatioChart points={points} target={pair.priceRatio} />
                  : <RelativeValueChart points={points} threshold={threshold} pair={pair} />
                : <div className={styles.loading}>Waiting for synchronized pair data…</div>}
        </section>

        <section className={styles.detailGrid}>
          <article className={styles.detailCard}>
            <h3>Window diagnostics</h3>
            <ul>
              {pair.priceRatio ? (
                <>
                  <li>Theoretical ratio: {pair.priceRatio.toFixed(4)}</li>
                  <li>Latest ratio: {currentRatio?.toFixed(4) ?? "—"} · deviation {latest ? residualPct(latest.residual) : "—"}</li>
                  <li>Peak positive deviation: {peakPositive ? `${residualPct(peakPositive.residual)} at ${hktTime(peakPositive.t, true)} HKT` : "—"}</li>
                  <li>Peak negative deviation: {peakNegative ? `${residualPct(peakNegative.residual)} at ${hktTime(peakNegative.t, true)} HKT` : "—"}</li>
                </>
              ) : (
                <>
                  <li>Baseline: {points[0] ? `${hktTime(points[0].t, true)} HKT · ${pair.base} ${price(points[0].ewy)} · ${pair.leveraged} ${price(points[0].koru)}` : "—"}</li>
                  <li>Peak positive residual: {peakPositive ? `${residualPct(peakPositive.residual)} at ${hktTime(peakPositive.t, true)} HKT` : "—"}</li>
                  <li>Peak negative residual: {peakNegative ? `${residualPct(peakNegative.residual)} at ${hktTime(peakNegative.t, true)} HKT` : "—"}</li>
                </>
              )}
              <li>Live pricing prefers Posley Redis orderbooks and automatically falls back to Binance official depth data.</li>
            </ul>
            {!feed.startsWith("posley") && (
              <button className={styles.authButton} onClick={() => void beginPosleyLogin()}>Connect Posley remote feed</button>
            )}
          </article>
          <article className={styles.detailCard}>
            <h3>Latest observations</h3>
            <table className={styles.observationTable}>
              <thead>
                <tr>
                  <th>HKT</th><th>{pair.base}</th><th>{pair.leveraged}</th>
                  {pair.priceRatio && <th>Ratio</th>}
                  <th>{pair.priceRatio ? "Deviation" : "Residual"}</th>
                </tr>
              </thead>
              <tbody>
                {recentRows.map((point) => (
                  <tr key={point.t}>
                    <td>{hktTime(point.t)}</td>
                    <td>{price(point.ewy)}</td>
                    <td>{price(point.koru)}</td>
                    {pair.priceRatio && <td>{(point.koru / point.ewy).toFixed(4)}</td>}
                    <td className={point.residual >= 0 ? styles.metricValuePositive : styles.metricValueNegative}>{residualPct(point.residual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        </section>

        <footer className={styles.footer}>
          <span>Historical source: Binance USDⓈ-M futures synchronized closes. Live source: Posley Redis orderbooks, with Binance REST fallback.</span>
          <span>Leveraged-return targets are approximations; the Tencent pair uses HK0700USDT = 7.84 × TENCENTUSDT as its theoretical price relationship. Neither is a guaranteed risk-free trade.</span>
        </footer>
      </div>
    </div>
  );
}
