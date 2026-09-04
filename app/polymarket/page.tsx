"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type Market = {
  instrumentId: number;
  category: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  fundingInterval: string;
  maxLeverage: number;
  indexPrice: number | null;
  markPrice: number | null;
  lastPrice: number | null;
  midPrice: number | null;
  openInterest: number | null;
  fundingRate: number | null;
  nextFunding: number | null;
  timestamp: number;
  binanceSymbol: string | null;
  mappingKind: "direct" | "reference" | null;
  mappingVerified: boolean;
  binanceBid: number | null;
  binanceAsk: number | null;
  binanceMid: number | null;
  binanceUpdatedAt: number | null;
  binanceFundingRate: number | null;
  binanceFundingHours: number | null;
  binanceFundingHourly: number | null;
  binanceNextFunding: number | null;
  spreadPct: number | null;
  hyperSymbol: string | null;
  hyperDex: string | null;
  hyperMappingKind: "direct" | "reference" | null;
  hyperMappingVerified: boolean;
  hyperMid: number | null;
  hyperUpdatedAt: number | null;
  hyperFundingRate: number | null;
  hyperFundingHourly: number | null;
  hyperSpreadPct: number | null;
};

type FundingPoint = { t: number; rate: number };
type AccountFundingRecord = { id: string; time: number; coin: string; usdc: number; cumulativeUsdc: number; fundingRate: number | null };
type AccountFundingPayload = {
  user: string;
  updatedAt: number;
  summary: { netUsdc: number; receivedUsdc: number; paidUsdc: number; last24hUsdc: number; settlements: number; activeCoins: number; firstTime: number | null; lastTime: number | null };
  chart: Array<{ t: number; deltaUsdc: number; cumulativeUsdc: number }>;
  byCoin: Array<{ coin: string; netUsdc: number; receivedUsdc: number; paidUsdc: number; settlements: number }>;
  records: AccountFundingRecord[];
};
type AccountPositionEstimate = {
  coin: string;
  size: number;
  oracle: number | null;
  fundingRate: number | null;
  notionalUsdc: number | null;
  estimatedUsdc: number | null;
};
type AccountPositionForecast = {
  status: "connecting" | "live" | "reconnecting";
  ready: boolean;
  updatedAt: number | null;
  positions: AccountPositionEstimate[];
};
type StreamStatus = "connecting" | "live" | "reconnecting";
type BinanceBook = { symbol?: string; bidPrice?: string; askPrice?: string; time?: number };
type BinanceStreamFrame = { e?: string; s?: string; b?: string; a?: string; E?: number; r?: string; T?: number };

const HISTORY_WINDOWS = [
  { label: "24H", ms: 24 * 60 * 60_000 },
  { label: "3D", ms: 3 * 24 * 60 * 60_000 },
  { label: "7D", ms: 7 * 24 * 60 * 60_000 },
  { label: "30D", ms: 30 * 24 * 60 * 60_000 },
] as const;

const ACCOUNT_HISTORY_WINDOWS = [
  { label: "24H", ms: 24 * 60 * 60_000 },
  { label: "7D", ms: 7 * 24 * 60 * 60_000 },
  { label: "30D", ms: 30 * 24 * 60 * 60_000 },
  { label: "ALL", ms: 0 },
] as const;

const DAY_MS = 24 * 60 * 60_000;
const HKT_OFFSET_MS = 8 * 60 * 60_000;
type FundingInterval = { start: number; end: number; net: number; received: number; paid: number; settlements: number };

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const formatPct = (value: number | null, digits = 4) => value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const formatFunding = (value: number | null) => value === null ? "—" : formatPct(value * 100, 5);
const formatPrice = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value >= 100 ? 3 : 7 });
const formatCompact = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
const formatUsdc = (value: number | null, digits = 2) => value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const formatTime = (value: number | null, date = false) => value === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", month: date ? "short" : undefined, day: date ? "2-digit" : undefined, hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
const startOfHktDay = (value: number) => Math.floor((value + HKT_OFFSET_MS) / DAY_MS) * DAY_MS - HKT_OFFSET_MS;
const startOfHktWeek = (value: number) => {
  const dayStart = startOfHktDay(value);
  const weekday = new Date(dayStart + HKT_OFFSET_MS).getUTCDay();
  return dayStart - ((weekday + 6) % 7) * DAY_MS;
};
const periodLabel = (interval: FundingInterval, mode: "daily" | "weekly") => {
  const format = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short" }).format(value);
  return mode === "daily" ? format(interval.start) : `${format(interval.start)} – ${format(interval.end - 1)}`;
};
const fundingHours = (interval: string) => {
  const match = interval.trim().toLowerCase().match(/([\d.]+)\s*h/);
  const hours = Number(match?.[1]);
  return Number.isFinite(hours) && hours > 0 ? hours : 1;
};
const polyHourlyFunding = (market: Market) => market.fundingRate === null ? null : market.fundingRate / fundingHours(market.fundingInterval);

type VenueComparisonProps = {
  market: Market;
  venue: "Binance" | "Hyperliquid";
};

function VenueComparison({ market, venue }: VenueComparisonProps) {
  const isBinance = venue === "Binance";
  const symbol = isBinance ? market.binanceSymbol : market.hyperSymbol;
  const price = isBinance ? market.binanceMid : market.hyperMid;
  const priceSpread = isBinance ? market.spreadPct : market.hyperSpreadPct;
  const venueFunding = isBinance ? market.binanceFundingHourly : market.hyperFundingHourly;
  const venueRawFunding = isBinance ? market.binanceFundingRate : market.hyperFundingRate;
  const venueHours = isBinance ? market.binanceFundingHours : 1;
  const polyFunding = polyHourlyFunding(market);
  const fundingSpread = polyFunding !== null && venueFunding !== null ? polyFunding - venueFunding : null;
  const shortPoly = fundingSpread !== null ? fundingSpread >= 0 : (priceSpread ?? 0) >= 0;
  const ready = Boolean(symbol && price !== null);
  const venueShort = isBinance ? "BN" : "HL";
  return <section className={`${styles.spreadLane} ${isBinance ? styles.binanceLane : styles.hyperLane} ${!ready ? styles.unavailableLane : ""}`}>
    <header><div><span>POLY ↔ {venue.toUpperCase()}</span><strong>{market.symbol} / {symbol ?? "NO MATCH"}</strong></div><em>{ready ? "LIVE" : "UNAVAILABLE"}</em></header>
    <div className={styles.spreadHeroes}>
      <div><span>FUNDING SPREAD · 1H</span><strong className={(fundingSpread ?? 0) >= 0 ? styles.positive : styles.negative}>{formatFunding(fundingSpread)}</strong><small>Poly hourly − {venueShort} hourly</small></div>
      <div><span>PRICE SPREAD</span><strong className={(priceSpread ?? 0) >= 0 ? styles.positive : styles.negative}>{formatPct(priceSpread, 3)}</strong><small>Poly midpoint − {venueShort} midpoint</small></div>
    </div>
    <div className={styles.tradeDirection}><span>CARRY DIRECTION</span><strong>{fundingSpread === null ? "WAITING FOR FUNDING" : shortPoly ? `SHORT POLY / LONG ${venueShort}` : `LONG POLY / SHORT ${venueShort}`}</strong></div>
    <dl className={styles.venueNumbers}>
      <div><dt>Poly funding / 1h</dt><dd>{formatFunding(polyFunding)}</dd></div>
      <div><dt>{venueShort} funding / 1h</dt><dd>{formatFunding(venueFunding)}</dd>{isBinance && venueRawFunding !== null && <small>Native {formatFunding(venueRawFunding)} / {venueHours ?? 8}h</small>}</div>
      <div><dt>Poly midpoint</dt><dd>{formatPrice(market.midPrice)}</dd></div>
      <div><dt>{venueShort} midpoint</dt><dd>{formatPrice(price)}</dd></div>
    </dl>
  </section>;
}

function FundingChart({ points, symbol }: { points: FundingPoint[]; symbol: string }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 1160;
  const height = 390;
  const left = 74;
  const right = 26;
  const top = 34;
  const bottom = 338;
  const values = points.map((point) => point.rate * 100);
  const extent = Math.max(.0005, ...values.map(Math.abs)) * 1.15;
  const y = (value: number) => top + ((extent - value) / (extent * 2)) * (bottom - top);
  const x = (index: number) => left + (index / Math.max(1, points.length - 1)) * (width - left - right);
  const path = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const ticks = [-extent, -extent / 2, 0, extent / 2, extent];
  const timeTicks = Array.from(new Set([0, Math.floor((points.length - 1) / 4), Math.floor((points.length - 1) / 2), Math.floor((points.length - 1) * .75), points.length - 1]));
  const selected = hoverIndex === null ? null : points[hoverIndex];
  return <div className={styles.chartWrap} onMouseLeave={() => setHoverIndex(null)} onMouseMove={(event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const chartX = ((event.clientX - rect.left + event.currentTarget.scrollLeft) / event.currentTarget.scrollWidth) * width;
    const index = Math.round(((chartX - left) / (width - left - right)) * (points.length - 1));
    setHoverIndex(Math.max(0, Math.min(points.length - 1, index)));
  }}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${symbol} hourly funding history`}>
      <rect x={left} y={top} width={width - left - right} height={bottom - top} className={styles.plotBackground} />
      {ticks.map((tick) => <g key={tick}><line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? styles.zeroLine : styles.gridLine} /><text x={left - 10} y={y(tick) + 4} textAnchor="end" className={styles.axisText}>{formatPct(tick, 4)}</text></g>)}
      {timeTicks.map((index) => <text key={index} x={x(index)} y={height - 15} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} className={styles.axisText}>{formatTime(points[index].t, true)}</text>)}
      <path d={path} className={styles.fundingLine} />
      {selected && hoverIndex !== null && <><line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={top} y2={bottom} className={styles.hoverLine} /><circle cx={x(hoverIndex)} cy={y(selected.rate * 100)} r="5" className={selected.rate >= 0 ? styles.positiveDot : styles.negativeDot} /></>}
    </svg>
    {selected && hoverIndex !== null && <div className={styles.tooltip} style={{ left: `${Math.min(78, Math.max(4, hoverIndex / Math.max(1, points.length - 1) * 100))}%` }}><strong>{formatTime(selected.t, true)} HKT</strong><span>1h funding {formatFunding(selected.rate)}</span><span>Approx. APR {formatPct(selected.rate * 24 * 365 * 100, 2)}</span></div>}
  </div>;
}

function AccountFundingChart({ points }: { points: AccountFundingPayload["chart"] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 980;
  const height = 330;
  const left = 78;
  const right = 24;
  const top = 25;
  const bottom = 278;
  const values = points.map((point) => point.cumulativeUsdc);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max(1, (max - min) * .12);
  const floor = min - padding;
  const ceiling = max + padding;
  const x = (index: number) => left + (index / Math.max(1, points.length - 1)) * (width - left - right);
  const y = (value: number) => top + ((ceiling - value) / Math.max(1, ceiling - floor)) * (bottom - top);
  const path = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const area = `${path} L${x(points.length - 1)},${bottom} L${x(0)},${bottom} Z`;
  const ticks = Array.from({ length: 5 }, (_, index) => floor + (ceiling - floor) * index / 4);
  const timeTicks = Array.from(new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1]));
  const selected = hoverIndex === null ? null : points[hoverIndex];

  return <div className={styles.accountChartWrap} onMouseLeave={() => setHoverIndex(null)} onMouseMove={(event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const chartX = ((event.clientX - rect.left + event.currentTarget.scrollLeft) / event.currentTarget.scrollWidth) * width;
    const index = Math.round(((chartX - left) / (width - left - right)) * (points.length - 1));
    setHoverIndex(Math.max(0, Math.min(points.length - 1, index)));
  }}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cumulative Hyperliquid funding income history">
      <defs><linearGradient id="accountFundingArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6e49d8" stopOpacity=".25" /><stop offset="1" stopColor="#6e49d8" stopOpacity=".02" /></linearGradient></defs>
      {ticks.map((tick) => <g key={tick}><line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className={styles.accountGridLine} /><text x={left - 10} y={y(tick) + 4} textAnchor="end" className={styles.accountAxisText}>{formatUsdc(tick, 0)}</text></g>)}
      {timeTicks.map((index) => <text key={index} x={x(index)} y={height - 15} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} className={styles.accountAxisText}>{formatTime(points[index].t, true)}</text>)}
      <path d={area} className={styles.accountArea} />
      <path d={path} className={styles.accountLine} />
      {selected && hoverIndex !== null && <><line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={top} y2={bottom} className={styles.hoverLine} /><circle cx={x(hoverIndex)} cy={y(selected.cumulativeUsdc)} r="5" className={styles.accountDot} /></>}
    </svg>
    {selected && hoverIndex !== null && <div className={styles.accountTooltip} style={{ left: `${Math.min(75, Math.max(4, hoverIndex / Math.max(1, points.length - 1) * 100))}%` }}><strong>{formatTime(selected.t, true)} HKT</strong><span>Cumulative {formatUsdc(selected.cumulativeUsdc)}</span><span>Settlement {formatUsdc(selected.deltaUsdc, 4)}</span></div>}
  </div>;
}

function AccountFundingPanel() {
  const [payload, setPayload] = useState<AccountFundingPayload | null>(null);
  const [windowMs, setWindowMs] = useState(ACCOUNT_HISTORY_WINDOWS[3].ms);
  const [periodMode, setPeriodMode] = useState<"daily" | "weekly">("daily");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [positionForecast, setPositionForecast] = useState<AccountPositionForecast>({ status: "connecting", ready: false, updatedAt: null, positions: [] });
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch("/api/hyperliquid/user-funding", { cache: "no-store" });
      const raw = await response.text();
      let next: AccountFundingPayload & { error?: string };
      try {
        next = JSON.parse(raw) as AccountFundingPayload & { error?: string };
      } catch {
        throw new Error(response.ok ? "Account funding response is temporarily unavailable." : `Account funding endpoint unavailable · HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error(next.error || "Account funding history unavailable.");
      setPayload(next);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Account funding history unavailable.");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    const timer = window.setInterval(load, 30_000);
    return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); };
  }, [load]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;
    let reconnectAttempt = 0;
    let hasPositionSnapshot = false;
    const subscribedCoins = new Set<string>();
    const positions = new Map<string, number>();
    const contexts = new Map<string, { oracle: number | null; fundingRate: number | null }>();

    const publish = (status: AccountPositionForecast["status"]) => {
      const nextPositions = [...positions.entries()].map(([coin, size]): AccountPositionEstimate => {
        const context = contexts.get(coin);
        const oracle = context?.oracle ?? null;
        const fundingRate = context?.fundingRate ?? null;
        const notionalUsdc = oracle === null ? null : Math.abs(size * oracle);
        // Positive funding is paid by longs to shorts, so a positive estimate means account income.
        const estimatedUsdc = oracle === null || fundingRate === null ? null : -size * oracle * fundingRate;
        return { coin, size, oracle, fundingRate, notionalUsdc, estimatedUsdc };
      }).sort((a, b) => Math.abs(b.estimatedUsdc ?? 0) - Math.abs(a.estimatedUsdc ?? 0));
      setPositionForecast({ status, ready: hasPositionSnapshot, updatedAt: Date.now(), positions: nextPositions });
    };

    const subscribeCoin = (coin: string) => {
      if (!socket || socket.readyState !== WebSocket.OPEN || subscribedCoins.has(coin)) return;
      subscribedCoins.add(coin);
      socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin } }));
    };

    const readClearinghouseStates = (value: unknown) => {
      if (!value || typeof value !== "object") return [] as unknown[];
      if (Array.isArray(value)) return value.map((entry) => Array.isArray(entry) ? entry[1] : entry);
      return Object.values(value as Record<string, unknown>);
    };

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket("wss://api.hyperliquid.xyz/ws");
      socket.onopen = () => {
        reconnectAttempt = 0;
        subscribedCoins.clear();
        socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "allDexsClearinghouseState", user: "0xa590a393CC3e1776a47f32fD99ef5fc7c464a243" } }));
        for (const coin of positions.keys()) subscribeCoin(coin);
        publish("live");
      };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { channel?: string; data?: unknown };
          if (frame.channel === "allDexsClearinghouseState") {
            const data = frame.data as { clearinghouseStates?: unknown } | undefined;
            const nextPositions = new Map<string, number>();
            for (const stateValue of readClearinghouseStates(data?.clearinghouseStates)) {
              const state = stateValue as { assetPositions?: Array<{ position?: { coin?: string; szi?: string | number } }> };
              for (const item of state.assetPositions ?? []) {
                const coin = item.position?.coin?.trim();
                const size = finite(item.position?.szi);
                if (coin && size !== null && size !== 0) nextPositions.set(coin, (nextPositions.get(coin) ?? 0) + size);
              }
            }
            positions.clear();
            for (const [coin, size] of nextPositions) {
              positions.set(coin, size);
              subscribeCoin(coin);
            }
            hasPositionSnapshot = true;
            publish("live");
          }
          if (frame.channel === "activeAssetCtx") {
            const data = frame.data as { coin?: string; ctx?: { oraclePx?: string | number; funding?: string | number } } | undefined;
            const coin = data?.coin?.trim();
            if (!coin) return;
            contexts.set(coin, { oracle: finite(data?.ctx?.oraclePx), fundingRate: finite(data?.ctx?.funding) });
            publish("live");
          }
        } catch {
          // Ignore malformed frames and keep the last complete forecast visible.
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        publish("reconnecting");
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, Math.min(10_000, 750 * 2 ** Math.min(4, reconnectAttempt)));
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const cutoff = windowMs && payload ? payload.updatedAt - windowMs : 0;
  const chart = useMemo(() => {
    const visible = payload?.chart.filter((point) => point.t >= cutoff) ?? [];
    if (!visible.length) return [];
    let periodRunning = 0;
    const baselineTime = windowMs ? cutoff : Math.max(0, visible[0].t - 60_000);
    return [
      { t: baselineTime, deltaUsdc: 0, cumulativeUsdc: 0 },
      ...visible.map((point) => {
        periodRunning += point.deltaUsdc;
        return { ...point, cumulativeUsdc: periodRunning };
      }),
    ];
  }, [cutoff, payload?.chart, windowMs]);
  const records = useMemo(() => (payload?.records ?? []).filter((record) => record.time >= cutoff).slice().reverse(), [cutoff, payload?.records]);
  const periodMetrics = useMemo(() => {
    const all = payload?.records ?? [];
    const now = payload?.updatedAt ?? 0;
    const summarize = (start: number) => all.reduce((result, record) => {
      if (record.time < start) return result;
      result.net += record.usdc;
      result.received += Math.max(0, record.usdc);
      result.paid += Math.max(0, -record.usdc);
      result.settlements += 1;
      return result;
    }, { net: 0, received: 0, paid: 0, settlements: 0 });
    const todayStart = startOfHktDay(now);
    const weekStart = startOfHktWeek(now);
    return {
      today: summarize(todayStart),
      week: summarize(weekStart),
      rolling7d: summarize(now - 7 * DAY_MS),
    };
  }, [payload?.records, payload?.updatedAt]);
  const intervals = useMemo(() => {
    if (!payload) return [];
    const weekly = periodMode === "weekly";
    const step = weekly ? 7 * DAY_MS : DAY_MS;
    const count = weekly ? 12 : 14;
    const currentStart = weekly ? startOfHktWeek(payload.updatedAt) : startOfHktDay(payload.updatedAt);
    const buckets = Array.from({ length: count }, (_, index): FundingInterval => {
      const start = currentStart - (count - 1 - index) * step;
      return { start, end: start + step, net: 0, received: 0, paid: 0, settlements: 0 };
    });
    const firstStart = buckets[0]?.start ?? 0;
    for (const record of payload.records) {
      if (record.time < firstStart || record.time >= currentStart + step) continue;
      const bucketStart = weekly ? startOfHktWeek(record.time) : startOfHktDay(record.time);
      const bucket = buckets[Math.round((bucketStart - firstStart) / step)];
      if (!bucket) continue;
      bucket.net += record.usdc;
      bucket.received += Math.max(0, record.usdc);
      bucket.paid += Math.max(0, -record.usdc);
      bucket.settlements += 1;
    }
    return buckets.reverse();
  }, [payload, periodMode]);
  const maxIntervalNet = Math.max(1, ...intervals.map((interval) => Math.abs(interval.net)));
  const address = payload?.user ?? "0xa590a393CC3e1776a47f32fD99ef5fc7c464a243";
  const forecastReady = positionForecast.positions.filter((position) => position.estimatedUsdc !== null);
  const nextHourEstimate = forecastReady.length || (positionForecast.ready && positionForecast.positions.length === 0)
    ? forecastReady.reduce((sum, position) => sum + (position.estimatedUsdc ?? 0), 0)
    : null;

  return <section className={styles.accountPanel}>
    <header className={styles.accountHeader}><div><p className={styles.eyebrow}>HYPERLIQUID ACCOUNT FUNDING</p><h2>Cumulative funding income</h2><code>{address}</code></div><div className={styles.accountHeaderActions}><span className={!error && payload ? styles.accountLive : styles.accountWaiting}><i />{error ? "RECONNECTING" : payload ? "LIVE · 30S" : "CONNECTING"}</span><button type="button" onClick={() => void load()}>Refresh</button></div></header>
    {error && !payload ? <div className={styles.accountEmpty}>{error}</div> : <>
      <div className={styles.accountSummary}>
        <article className={styles.accountNet}><span>LIFETIME NET</span><strong className={(payload?.summary.netUsdc ?? 0) >= 0 ? styles.positive : styles.negative}>{loading && !payload ? "Loading…" : formatUsdc(payload?.summary.netUsdc ?? null)}</strong><small>Received {formatUsdc(payload?.summary.receivedUsdc ?? null)} · paid {payload ? `−$${payload.summary.paidUsdc.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—"}</small></article>
        <article className={styles.nextFundingEstimate}><span>NEXT 1H ESTIMATE</span><strong className={(nextHourEstimate ?? 0) >= 0 ? styles.positive : styles.negative}>{formatUsdc(nextHourEstimate)}</strong><small>{positionForecast.status !== "live" ? "Position feed reconnecting" : positionForecast.ready ? `${forecastReady.length}/${positionForecast.positions.length} positions priced · current rates` : "Waiting for position snapshot"}</small></article>
        <article><span>TODAY · HKT</span><strong className={periodMetrics.today.net >= 0 ? styles.positive : styles.negative}>{formatUsdc(payload ? periodMetrics.today.net : null)}</strong><small>Since 00:00 HKT · {periodMetrics.today.settlements} settlements</small></article>
        <article><span>THIS WEEK · HKT</span><strong className={periodMetrics.week.net >= 0 ? styles.positive : styles.negative}>{formatUsdc(payload ? periodMetrics.week.net : null)}</strong><small>Since Monday 00:00 HKT · {periodMetrics.week.settlements} settlements</small></article>
        <article><span>ROLLING 7 DAYS</span><strong className={periodMetrics.rolling7d.net >= 0 ? styles.positive : styles.negative}>{formatUsdc(payload ? periodMetrics.rolling7d.net : null)}</strong><small>{periodMetrics.rolling7d.settlements} settlements</small></article>
      </div>
      <div className={styles.accountControls}><div><strong>Income history</strong><span>Every selected window is rebased to $0 at its starting time</span></div><div className={styles.accountWindows}>{ACCOUNT_HISTORY_WINDOWS.map((window) => <button key={window.label} className={windowMs === window.ms ? styles.activeAccountWindow : ""} onClick={() => setWindowMs(window.ms)}>{window.label}</button>)}</div></div>
      <div className={styles.accountBody}>
        <section className={styles.accountChartPanel}><div className={styles.accountSectionTitle}><div><span>PERIOD NET · REBASED TO $0</span><strong>{ACCOUNT_HISTORY_WINDOWS.find((window) => window.ms === windowMs)?.label}</strong></div><small>Hover for exact settlement value</small></div>{chart.length > 1 ? <AccountFundingChart points={chart} /> : <div className={styles.accountEmpty}>No funding settlements in this window.</div>}</section>
        <aside className={styles.coinBreakdown}><div className={styles.accountSectionTitle}><div><span>NEXT HOUR BY POSITION</span><strong>Current-rate estimate</strong></div><small>{positionForecast.status === "live" && positionForecast.ready ? "LIVE" : positionForecast.status === "reconnecting" ? "RECONNECTING" : "CONNECTING"}</small></div><div className={styles.coinRows}>{positionForecast.positions.length ? positionForecast.positions.slice(0, 12).map((position) => <div key={position.coin}><span><b>{position.coin}</b><small>{position.size > 0 ? "LONG" : "SHORT"} {Math.abs(position.size).toLocaleString("en-US", { maximumFractionDigits: 6 })} · {formatCompact(position.notionalUsdc)}</small></span><strong className={(position.estimatedUsdc ?? 0) >= 0 ? styles.positive : styles.negative}>{formatUsdc(position.estimatedUsdc, 4)}</strong></div>) : <div className={styles.positionEmpty}>{positionForecast.ready ? "No open perpetual positions." : "Connecting to live positions…"}</div>}</div><p className={styles.forecastNote}>Estimate = −position size × Oracle × current 1h funding rate. The final hourly rate can change before settlement.</p></aside>
      </div>
      <section className={styles.periodPanel}>
        <header className={styles.periodHead}><div><p className={styles.eyebrow}>PERIOD-BY-PERIOD INCOME</p><h3>{periodMode === "daily" ? "Daily funding income" : "Weekly funding income"}</h3><span>{periodMode === "daily" ? "Natural days · 00:00–24:00 HKT" : "Natural weeks · Monday–Sunday HKT"}</span></div><div className={styles.periodToggle}><button className={periodMode === "daily" ? styles.activePeriod : ""} onClick={() => setPeriodMode("daily")}>DAILY</button><button className={periodMode === "weekly" ? styles.activePeriod : ""} onClick={() => setPeriodMode("weekly")}>WEEKLY</button></div></header>
        <div className={styles.periodTable}><div className={styles.periodTableHead}><span>Period</span><span>Net income</span><span>Received</span><span>Paid</span><span>Settlements</span></div>{intervals.map((interval, index) => <div className={styles.periodRow} key={interval.start}><span><b>{index === 0 ? (periodMode === "daily" ? "TODAY" : "THIS WEEK") : periodLabel(interval, periodMode)}</b><small>{periodLabel(interval, periodMode)}</small></span><span className={styles.periodNet}><i className={interval.net >= 0 ? styles.periodPositiveBar : styles.periodNegativeBar} style={{ width: `${Math.max(2, Math.abs(interval.net) / maxIntervalNet * 100)}%` }} /><strong className={interval.net >= 0 ? styles.positive : styles.negative}>{formatUsdc(interval.net)}</strong></span><span className={styles.positive}>{formatUsdc(interval.received)}</span><span className={styles.negative}>{interval.paid ? `−$${interval.paid.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "$0.00"}</span><span>{interval.settlements}</span></div>)}</div>
      </section>
      <details className={styles.accountLedger}><summary><span>Settlement history</span><small>{records.length.toLocaleString()} records in selected window</small></summary><div className={styles.ledgerScroll}><table><thead><tr><th>Time · HKT</th><th>Market</th><th>Funding rate</th><th>Income · USDC</th><th>Cumulative</th></tr></thead><tbody>{records.slice(0, 250).map((record) => <tr key={record.id}><td>{formatTime(record.time, true)}</td><td>{record.coin}</td><td>{formatFunding(record.fundingRate)}</td><td className={record.usdc >= 0 ? styles.positive : styles.negative}>{formatUsdc(record.usdc, 4)}</td><td>{formatUsdc(record.cumulativeUsdc)}</td></tr>)}</tbody></table></div>{records.length > 250 && <footer>Showing the latest 250 of {records.length.toLocaleString()} records in this window.</footer>}</details>
      <footer className={styles.accountFoot}><span>Positive = funding received · negative = funding paid</span><span>{payload?.updatedAt ? `Updated ${formatTime(payload.updatedAt)} HKT` : "Connecting…"}</span></footer>
    </>}
  </section>;
}

export default function PolymarketPerpsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [sources, setSources] = useState({ polymarket: false, binance: false, hyperliquid: false });
  const [polyStream, setPolyStream] = useState<StreamStatus>("connecting");
  const [binanceStream, setBinanceStream] = useState<StreamStatus>("connecting");
  const [hyperStream, setHyperStream] = useState<StreamStatus>("connecting");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [history, setHistory] = useState<FundingPoint[]>([]);
  const [historyWindow, setHistoryWindow] = useState(HISTORY_WINDOWS[2].ms);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [matchedOnly, setMatchedOnly] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const requestInFlight = useRef(false);

  const mergeBinanceBooks = useCallback((books: BinanceBook[]) => {
    const bySymbol = new Map(books.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
    setMarkets((current) => current.map((market) => {
      if (!market.binanceSymbol) return market;
      const book = bySymbol.get(market.binanceSymbol);
      if (!book) return market;
      const bid = positive(book.bidPrice);
      const ask = positive(book.askPrice);
      const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
      return { ...market, mappingVerified: mid !== null || market.mappingVerified, binanceBid: bid, binanceAsk: ask, binanceMid: mid, binanceUpdatedAt: finite(book.time) ?? Date.now(), spreadPct: market.midPrice !== null && mid !== null ? (market.midPrice / mid - 1) * 100 : null };
    }));
  }, []);

  const mergeBinanceFunding = useCallback((symbol: string, rateValue: unknown, nextFundingValue: unknown, timestamp: number) => {
    const rate = finite(rateValue);
    setMarkets((current) => current.map((market) => market.binanceSymbol === symbol
      ? { ...market, binanceFundingRate: rate, binanceFundingHourly: rate !== null && market.binanceFundingHours ? rate / market.binanceFundingHours : null, binanceNextFunding: finite(nextFundingValue), binanceUpdatedAt: timestamp }
      : market));
  }, []);

  const mergeHyperBook = useCallback((symbol: string, bidValue: unknown, askValue: unknown, timestamp: number) => {
    const bid = positive(bidValue);
    const ask = positive(askValue);
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
    setMarkets((current) => current.map((market) => market.hyperSymbol === symbol
      ? { ...market, hyperMappingVerified: mid !== null || market.hyperMappingVerified, hyperMid: mid, hyperUpdatedAt: timestamp, hyperSpreadPct: market.midPrice !== null && mid !== null ? (market.midPrice / mid - 1) * 100 : null }
      : market));
  }, []);

  const mergeHyperContext = useCallback((symbol: string, midValue: unknown, fundingValue: unknown, timestamp: number) => {
    const mid = positive(midValue);
    const rate = finite(fundingValue);
    setMarkets((current) => current.map((market) => market.hyperSymbol === symbol
      ? { ...market, hyperMappingVerified: mid !== null || market.hyperMappingVerified, hyperMid: mid ?? market.hyperMid, hyperUpdatedAt: timestamp, hyperFundingRate: rate, hyperFundingHourly: rate, hyperSpreadPct: market.midPrice !== null && (mid ?? market.hyperMid) !== null ? (market.midPrice / (mid ?? market.hyperMid)! - 1) * 100 : null }
      : market));
  }, []);

  const loadMarkets = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const response = await fetch("/api/polymarket-perps/markets", { cache: "no-store" });
      const payload = await response.json() as { markets?: Market[]; sources?: { polymarket: boolean; binance: boolean; hyperliquid: boolean }; timestamp?: number; error?: string };
      if (!response.ok || !payload.markets?.length) throw new Error(payload.error || "Polymarket Perps data unavailable.");
      setMarkets((current) => payload.markets!.map((market) => {
        const live = current.find((item) => item.instrumentId === market.instrumentId);
        const keepPolyStream = polyStream === "live" && live && live.timestamp > market.timestamp;
        const keepBinanceStream = binanceStream === "live" && live?.binanceUpdatedAt && (!market.binanceUpdatedAt || live.binanceUpdatedAt > market.binanceUpdatedAt);
        const keepHyperStream = hyperStream === "live" && live?.hyperUpdatedAt && (!market.hyperUpdatedAt || live.hyperUpdatedAt > market.hyperUpdatedAt);
        const merged = keepPolyStream ? { ...market, indexPrice: live.indexPrice, markPrice: live.markPrice, lastPrice: live.lastPrice, midPrice: live.midPrice, openInterest: live.openInterest, fundingRate: live.fundingRate, nextFunding: live.nextFunding, timestamp: live.timestamp } : market;
        const withBinance = keepBinanceStream ? { ...merged, mappingVerified: live.mappingVerified, binanceBid: live.binanceBid, binanceAsk: live.binanceAsk, binanceMid: live.binanceMid, binanceUpdatedAt: live.binanceUpdatedAt, binanceFundingRate: live.binanceFundingRate, binanceFundingHourly: live.binanceFundingHourly, binanceNextFunding: live.binanceNextFunding, spreadPct: merged.midPrice !== null && live.binanceMid !== null ? (merged.midPrice / live.binanceMid - 1) * 100 : null } : merged;
        return keepHyperStream ? { ...withBinance, hyperMappingVerified: live.hyperMappingVerified, hyperMid: live.hyperMid, hyperUpdatedAt: live.hyperUpdatedAt, hyperFundingRate: live.hyperFundingRate, hyperFundingHourly: live.hyperFundingHourly, hyperSpreadPct: withBinance.midPrice !== null && live.hyperMid !== null ? (withBinance.midPrice / live.hyperMid - 1) * 100 : null } : withBinance;
      }));
      setSources(payload.sources ?? { polymarket: true, binance: false, hyperliquid: false });
      setLastUpdate(payload.timestamp ?? Date.now());
      setError("");
      if (payload.sources?.binance === false) {
        try {
          const direct = await fetch("https://fapi.binance.com/fapi/v1/ticker/bookTicker", { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(8_000) });
          if (direct.ok) {
            mergeBinanceBooks(await direct.json() as BinanceBook[]);
            setSources((current) => ({ ...current, binance: true }));
          }
        } catch { /* Binance WebSocket remains the browser-side fallback. */ }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Market data is reconnecting.");
    } finally { requestInFlight.current = false; }
  }, [binanceStream, hyperStream, mergeBinanceBooks, polyStream]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadMarkets());
    const timer = window.setInterval(loadMarkets, 10_000);
    return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); };
  }, [loadMarkets]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer = 0;
    const connect = (attempt = 0) => {
      if (stopped) return;
      setPolyStream(attempt ? "reconnecting" : "connecting");
      socket = new WebSocket("wss://ws.perpetuals.polymarket.com/v1/ws");
      const openedAt = Date.now();
      socket.onopen = () => { socket?.send(JSON.stringify({ id: 1, req: "sub", chs: ["tickers::all"] })); setPolyStream("live"); };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { ch?: string; ts?: number; data?: { iid?: number; idx?: string; mark?: string; last?: string; mid?: string; oi?: string; fr?: string; nxf?: number } };
          if (!frame.ch?.startsWith("tickers::") || !frame.data?.iid) return;
          setMarkets((current) => current.map((market) => {
            if (market.instrumentId !== frame.data!.iid) return market;
            const midPrice = positive(frame.data!.mid);
            return { ...market, indexPrice: positive(frame.data!.idx), markPrice: positive(frame.data!.mark), lastPrice: positive(frame.data!.last), midPrice, openInterest: positive(frame.data!.oi), fundingRate: finite(frame.data!.fr), nextFunding: finite(frame.data!.nxf), timestamp: finite(frame.ts) ?? Date.now(), spreadPct: midPrice !== null && market.binanceMid !== null ? (midPrice / market.binanceMid - 1) * 100 : null, hyperSpreadPct: midPrice !== null && market.hyperMid !== null ? (midPrice / market.hyperMid - 1) * 100 : null };
          }));
          setLastUpdate(finite(frame.ts) ?? Date.now());
        } catch { /* Ignore acknowledgements and malformed frames. */ }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        setPolyStream("reconnecting");
        const nextAttempt = Date.now() - openedAt > 20_000 ? 0 : attempt + 1;
        timer = window.setTimeout(() => connect(nextAttempt), Math.min(8_000, 600 * 2 ** Math.min(4, nextAttempt)));
      };
    };
    connect();
    return () => { stopped = true; window.clearTimeout(timer); socket?.close(); };
  }, []);

  const mappedKey = useMemo(() => [...new Set(markets.flatMap((market) => market.binanceSymbol ? [market.binanceSymbol] : []))].sort().join(","), [markets]);
  useEffect(() => {
    if (!mappedKey) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer = 0;
    const symbols = mappedKey.split(",");
    const connect = (attempt = 0) => {
      if (stopped) return;
      setBinanceStream(attempt ? "reconnecting" : "connecting");
      socket = new WebSocket("wss://fstream.binance.com/public/stream");
      const openedAt = Date.now();
      socket.onopen = () => { socket?.send(JSON.stringify({ method: "SUBSCRIBE", params: symbols.flatMap((symbol) => [`${symbol.toLowerCase()}@bookTicker`, `${symbol.toLowerCase()}@markPrice@1s`]), id: 1 })); setBinanceStream("live"); };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { data?: BinanceStreamFrame };
          const data = frame.data;
          if (!data?.s) return;
          if (data.e === "markPriceUpdate") mergeBinanceFunding(data.s, data.r, data.T, data.E ?? Date.now());
          else mergeBinanceBooks([{ symbol: data.s, bidPrice: data.b, askPrice: data.a, time: data.E }]);
        } catch { /* Ignore subscription acknowledgements. */ }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        setBinanceStream("reconnecting");
        const nextAttempt = Date.now() - openedAt > 20_000 ? 0 : attempt + 1;
        timer = window.setTimeout(() => connect(nextAttempt), Math.min(8_000, 600 * 2 ** Math.min(4, nextAttempt)));
      };
    };
    connect();
    return () => { stopped = true; window.clearTimeout(timer); socket?.close(); };
  }, [mappedKey, mergeBinanceBooks, mergeBinanceFunding]);

  const hyperMappedKey = useMemo(() => [...new Set(markets.flatMap((market) => market.hyperSymbol ? [market.hyperSymbol] : []))].sort().join(","), [markets]);
  useEffect(() => {
    if (!hyperMappedKey) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer = 0;
    const symbols = hyperMappedKey.split(",");
    const connect = (attempt = 0) => {
      if (stopped) return;
      setHyperStream(attempt ? "reconnecting" : "connecting");
      socket = new WebSocket("wss://api.hyperliquid.xyz/ws");
      const openedAt = Date.now();
      socket.onopen = () => {
        symbols.forEach((coin) => {
          socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin } }));
          socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin } }));
        });
        setHyperStream("live");
      };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { channel?: string; data?: { coin?: string; time?: number; levels?: Array<Array<{ px?: string }>>; ctx?: { midPx?: string; funding?: string } } };
          if (!frame.data?.coin) return;
          if (frame.channel === "l2Book") mergeHyperBook(frame.data.coin, frame.data.levels?.[0]?.[0]?.px, frame.data.levels?.[1]?.[0]?.px, frame.data.time ?? Date.now());
          if (frame.channel === "activeAssetCtx") mergeHyperContext(frame.data.coin, frame.data.ctx?.midPx, frame.data.ctx?.funding, Date.now());
        } catch { /* Ignore subscription acknowledgements and malformed frames. */ }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        setHyperStream("reconnecting");
        const nextAttempt = Date.now() - openedAt > 20_000 ? 0 : attempt + 1;
        timer = window.setTimeout(() => connect(nextAttempt), Math.min(8_000, 600 * 2 ** Math.min(4, nextAttempt)));
      };
    };
    connect();
    return () => { stopped = true; window.clearTimeout(timer); socket?.close(); };
  }, [hyperMappedKey, mergeHyperBook, mergeHyperContext]);

  const selected = markets.find((market) => market.instrumentId === expandedId);
  const selectedInstrumentId = selected?.instrumentId;
  useEffect(() => {
    if (!selectedInstrumentId) return;
    const controller = new AbortController();
    const frame = window.requestAnimationFrame(() => {
      setLoadingHistory(true);
      const end = Date.now();
      const params = new URLSearchParams({ instrumentId: String(selectedInstrumentId), start: String(end - historyWindow), end: String(end) });
      void fetch(`/api/polymarket-perps/funding?${params}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
        const payload = await response.json() as { points?: FundingPoint[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Funding history unavailable.");
        setHistory(payload.points ?? []);
        setError("");
      }).catch((historyError: unknown) => {
        if (controller.signal.aborted) return;
        setHistory([]);
        setError(historyError instanceof Error ? historyError.message : "Funding history unavailable.");
      }).finally(() => { if (!controller.signal.aborted) setLoadingHistory(false); });
    });
    return () => { window.cancelAnimationFrame(frame); controller.abort(); };
  }, [historyWindow, selectedInstrumentId]);

  const toggleHistory = useCallback((instrumentId: number) => {
    setHistory([]);
    setLoadingHistory(false);
    setExpandedId((current) => current === instrumentId ? null : instrumentId);
  }, []);

  const categories = useMemo(() => [...new Set(markets.map((market) => market.category))].sort(), [markets]);
  const fundingSpreadFor = useCallback((market: Market, venue: "Binance" | "Hyperliquid") => {
    const poly = polyHourlyFunding(market);
    const comparison = venue === "Binance" ? market.binanceFundingHourly : market.hyperFundingHourly;
    return poly !== null && comparison !== null ? poly - comparison : null;
  }, []);
  const largestAbsoluteFundingSpread = useCallback((market: Market) => Math.max(
    Math.abs(fundingSpreadFor(market, "Binance") ?? 0),
    Math.abs(fundingSpreadFor(market, "Hyperliquid") ?? 0),
  ), [fundingSpreadFor]);
  const visible = useMemo(() => markets.filter((market) => {
    const needle = search.trim().toLowerCase();
    return (!needle || market.symbol.toLowerCase().includes(needle) || market.binanceSymbol?.toLowerCase().includes(needle) || market.hyperSymbol?.toLowerCase().includes(needle))
      && (category === "all" || market.category === category)
      && (!matchedOnly || market.binanceMid !== null || market.hyperMid !== null);
  }).sort((a, b) => largestAbsoluteFundingSpread(b) - largestAbsoluteFundingSpread(a)
    || Math.max(Math.abs(b.spreadPct ?? 0), Math.abs(b.hyperSpreadPct ?? 0)) - Math.max(Math.abs(a.spreadPct ?? 0), Math.abs(a.hyperSpreadPct ?? 0))), [category, largestAbsoluteFundingSpread, markets, matchedOnly, search]);
  const matched = markets.filter((market) => market.binanceMid !== null).length;
  const hyperMatched = markets.filter((market) => market.hyperMid !== null).length;
  const largestFundingSpread = markets.reduce<{ market: Market; venue: "Binance" | "Hyperliquid"; value: number } | null>((best, market) => {
    const candidates = (["Binance", "Hyperliquid"] as const).flatMap((venue) => {
      const value = fundingSpreadFor(market, venue);
      return value === null ? [] : [{ market, venue, value }];
    });
    return candidates.reduce((current, candidate) => !current || Math.abs(candidate.value) > Math.abs(current.value) ? candidate : current, best);
  }, null);
  const largestSpread = markets.reduce<{ market: Market; venue: "Binance" | "Hyperliquid"; value: number } | null>((best, market) => {
    const candidates = [
      market.spreadPct === null ? null : { market, venue: "Binance" as const, value: market.spreadPct },
      market.hyperSpreadPct === null ? null : { market, venue: "Hyperliquid" as const, value: market.hyperSpreadPct },
    ].filter((candidate): candidate is { market: Market; venue: "Binance" | "Hyperliquid"; value: number } => candidate !== null);
    return candidates.reduce((current, candidate) => !current || Math.abs(candidate.value) > Math.abs(current.value) ? candidate : current, best);
  }, null);
  const fundingReadyRoutes = markets.reduce((count, market) => count + Number(fundingSpreadFor(market, "Binance") !== null) + Number(fundingSpreadFor(market, "Hyperliquid") !== null), 0);
  const priceReadyRoutes = markets.reduce((count, market) => count + Number(market.spreadPct !== null) + Number(market.hyperSpreadPct !== null), 0);

  return <main className={styles.shell}><div className={styles.frame}>
    <header className={styles.topbar}><div><p className={styles.eyebrow}>THREE-VENUE CARRY &amp; BASIS</p><h1>Funding &amp; Basis</h1><p>One screen for Polymarket, Hyperliquid and Binance. Every matched route shows normalized hourly funding spread, live price spread and the carry direction.</p></div><div className={styles.topActions}><div className={styles.connections}><span className={polyStream === "live" || sources.polymarket ? styles.online : ""}><i />Poly {polyStream === "live" ? "WS live" : "REST fallback"}</span><span className={binanceStream === "live" || sources.binance ? styles.online : ""}><i />BN {binanceStream === "live" ? "WS live" : sources.binance ? "REST fallback" : "reconnecting"}</span><span className={hyperStream === "live" || sources.hyperliquid ? styles.online : ""}><i />HL {hyperStream === "live" ? "WS live" : sources.hyperliquid ? "REST fallback" : "reconnecting"}</span></div><PageSwitcher active="polymarket" /></div></header>

    <section className={styles.stats}><article><span>Active Poly Perps</span><strong>{markets.length || "—"}</strong><small>{categories.length} market categories</small></article><article><span>Funding-ready routes</span><strong>{fundingReadyRoutes}</strong><small>Hourly-normalized Poly ↔ BN / HL</small></article><article><span>Price-ready routes</span><strong>{priceReadyRoutes}</strong><small>{matched} Binance · {hyperMatched} Hyperliquid</small></article><article><span>Largest funding spread</span><strong className={(largestFundingSpread?.value ?? 0) >= 0 ? styles.positive : styles.negative}>{formatFunding(largestFundingSpread?.value ?? null)}</strong><small>{largestFundingSpread ? `${largestFundingSpread.market.symbol} · Poly ↔ ${largestFundingSpread.venue}` : "Waiting for synchronized funding"}</small></article><article><span>Largest price spread</span><strong className={(largestSpread?.value ?? 0) >= 0 ? styles.positive : styles.negative}>{formatPct(largestSpread?.value ?? null, 3)}</strong><small>{largestSpread ? `${largestSpread.market.symbol} · Poly ↔ ${largestSpread.venue}` : "Waiting for synchronized midpoint"}</small></article></section>

    <AccountFundingPanel />

    <section className={styles.filters}><label>Search markets<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="BTC, AAPL, GOLD…" /></label><label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label className={styles.matchToggle}><input type="checkbox" checked={matchedOnly} onChange={(event) => setMatchedOnly(event.target.checked)} /><span>Cross-venue midpoint available</span></label><button onClick={() => void loadMarkets()}>Refresh now</button><p>{error || (lastUpdate ? `Last market update ${formatTime(lastUpdate)} HKT` : "Connecting public market data…")}</p></section>

    <section className={styles.marketGrid}>{visible.map((market) => {
      const funding = polyHourlyFunding(market);
      const expanded = expandedId === market.instrumentId;
      return <article key={market.instrumentId} className={`${styles.marketCard} ${expanded ? styles.expandedCard : ""}`}>
        <div className={styles.cardHead}><div><small>{market.category} · #{market.instrumentId}</small><strong>{market.symbol}</strong><p>Poly mid {formatPrice(market.midPrice)} · OI {formatCompact(market.openInterest)} {market.baseAsset}</p></div><span className={(funding ?? 0) >= 0 ? styles.positiveFunding : styles.negativeFunding}>{formatFunding(funding)}<small>POLY / 1H</small></span></div>
        <div className={styles.venueComparisons}><VenueComparison market={market} venue="Binance" /><VenueComparison market={market} venue="Hyperliquid" /></div>
        <div className={styles.cardFooter}><div><span>Poly next {formatTime(market.nextFunding)} HKT</span>{market.binanceNextFunding && <span>BN next {formatTime(market.binanceNextFunding)} HKT</span>}</div><button type="button" aria-expanded={expanded} aria-controls={`funding-history-${market.instrumentId}`} onClick={() => toggleHistory(market.instrumentId)}>{expanded ? "Close Poly history" : "Open Poly funding history"}<i aria-hidden="true">{expanded ? "−" : "+"}</i></button></div>
        {expanded && <section id={`funding-history-${market.instrumentId}`} className={styles.inlineHistory}>
          <div className={styles.historyHead}><div><p className={styles.eyebrow}>HOURLY FUNDING HISTORY</p><h2>{market.symbol}</h2><span>Current {formatFunding(market.fundingRate)} · next settlement {formatTime(market.nextFunding)} HKT</span></div><div className={styles.historyWindows}>{HISTORY_WINDOWS.map((window) => <button key={window.label} className={historyWindow === window.ms ? styles.activeWindow : ""} onClick={() => setHistoryWindow(window.ms)}>{window.label}</button>)}</div></div>
          {loadingHistory ? <div className={styles.emptyChart}>Loading funding settlements…</div> : history.length > 1 ? <FundingChart points={history} symbol={market.symbol} /> : <div className={styles.emptyChart}>No settled funding observations are available in this window.</div>}
          <footer><span>Polymarket public funding history · hourly settlements</span><span>{history.length} observations</span></footer>
        </section>}
      </article>;
    })}{!visible.length && <div className={styles.noMarkets}>No markets match the current filters.</div>}</section>

    <footer className={styles.footer}>Funding spread = Polymarket hourly rate − comparison venue hourly rate. Binance native funding is divided by its current settlement interval; Hyperliquid and Polymarket settle hourly. Price spread = Polymarket midpoint ÷ comparison midpoint − 1. Reference mappings can differ in session, collateral and index methodology.</footer>
  </div></main>;
}
