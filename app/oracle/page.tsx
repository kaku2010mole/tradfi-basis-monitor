"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BroadcastAlert from "../components/BroadcastAlert";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type OracleQuote = {
  id: string;
  venue: "Binance" | "Hyperliquid";
  symbol: string;
  apiSymbol: string;
  bid: number | null;
  ask: number | null;
  live: number;
  oracle: number;
  mark: number;
  deviation: number;
  funding: number | null;
  fundingHours: number;
  nextFundingTime: number | null;
  updatedAt: number;
};

type OraclePoint = { t: number; live: number; oracle: number; deviation: number };
type SourceState = { binance: boolean; hyperliquid: boolean };
type BroadcastState = { title: string; message: string; tone: "positive" | "negative" };

const REFRESH_MS = 5000;

const hktDateValue = (offsetDays = 0) => {
  const date = new Date(Date.now() + 8 * 3600_000 + offsetDays * 24 * 3600_000);
  return `${date.toISOString().slice(0, 10)}T07:00`;
};
const toEpoch = (value: string) => Date.parse(`${value}:00+08:00`);
const formatPct = (value: number, digits = 3) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const formatPrice = (value: number | null) => value == null || !Number.isFinite(value)
  ? "—"
  : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value >= 100 ? 3 : 6 });
const formatTime = (value: number, date = false) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong",
  month: date ? "short" : undefined,
  day: date ? "2-digit" : undefined,
  hour: "2-digit",
  minute: "2-digit",
  second: date ? undefined : "2-digit",
  hour12: false,
}).format(value);

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

function QuoteCard({ quote, threshold, selected, onSelect }: { quote: OracleQuote; threshold: number; selected: boolean; onSelect: () => void }) {
  const triggered = Math.abs(quote.deviation) >= threshold;
  return (
    <button className={`${styles.quoteCard} ${selected ? styles.selectedCard : ""} ${triggered ? styles.triggeredCard : ""}`} onClick={onSelect}>
      <div className={styles.cardTop}>
        <div><small>{quote.venue}</small><strong>{quote.symbol}</strong></div>
        <span className={quote.deviation >= 0 ? styles.positive : styles.negative}>{formatPct(quote.deviation)}</span>
      </div>
      <div className={styles.cardPrices}>
        <div><span>Live midpoint</span><b>{formatPrice(quote.live)}</b></div>
        <div><span>Oracle</span><b>{formatPrice(quote.oracle)}</b></div>
        <div><span>Mark</span><b>{formatPrice(quote.mark)}</b></div>
      </div>
      <footer>
        <span>Funding {quote.funding == null ? "—" : formatPct(quote.funding * 100, 4)} / {quote.fundingHours}h</span>
        <span>{formatTime(quote.updatedAt)} HKT</span>
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
  const triggerDirections = useRef<Record<string, -1 | 0 | 1>>({});
  const dismissBroadcast = useCallback(() => setBroadcast(null), []);

  const loadQuotes = useCallback(async () => {
    try {
      const response = await fetch("/api/oracle-monitor/quotes", { cache: "no-store" });
      const payload = await response.json() as { quotes?: OracleQuote[]; sources?: SourceState; timestamp?: number; error?: string };
      if (!response.ok || !payload.quotes?.length) throw new Error(payload.error || "Oracle feed unavailable.");
      const nextDirections: Record<string, -1 | 0 | 1> = {};
      const crossings: OracleQuote[] = [];
      for (const quote of payload.quotes) {
        const direction: -1 | 0 | 1 = quote.deviation >= threshold ? 1 : quote.deviation <= -threshold ? -1 : 0;
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
          message: `${strongest.venue} live midpoint is ${formatPct(strongest.deviation)} from oracle, outside the ±${threshold.toFixed(3)}% band${crossings.length > 1 ? ` · ${crossings.length - 1} additional trigger${crossings.length > 2 ? "s" : ""}` : ""}.`,
        });
      }
      setQuotes(payload.quotes);
      setSources(payload.sources ?? { binance: false, hyperliquid: false });
      setLastRefresh(payload.timestamp ?? Date.now());
      setError("");
      setSessionPoints((current) => {
        const next = { ...current };
        for (const quote of payload.quotes!) {
          const point = { t: quote.updatedAt, live: quote.live, oracle: quote.oracle, deviation: quote.deviation };
          const existing = next[quote.id] ?? [];
          if (existing.at(-1)?.t === point.t) continue;
          next[quote.id] = [...existing, point].slice(-720);
        }
        return next;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Oracle feeds are reconnecting.");
      setSources({ binance: false, hyperliquid: false });
    }
  }, [threshold]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadQuotes());
    const timer = window.setInterval(loadQuotes, REFRESH_MS);
    return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); };
  }, [loadQuotes]);

  const selected = quotes.find((quote) => quote.id === selectedId) ?? quotes[0];
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
  const positive = quotes.filter((quote) => quote.deviation >= 0).sort((a, b) => b.deviation - a.deviation);
  const negative = quotes.filter((quote) => quote.deviation < 0).sort((a, b) => a.deviation - b.deviation);
  const triggered = quotes.filter((quote) => Math.abs(quote.deviation) >= threshold);
  const extreme = quotes.reduce<OracleQuote | null>((best, quote) => !best || Math.abs(quote.deviation) > Math.abs(best.deviation) ? quote : best, null);

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
              <span className={sources.binance ? styles.online : ""}><i />Binance</span>
              <span className={sources.hyperliquid ? styles.online : ""}><i />Hyperliquid para</span>
            </div>
            <PageSwitcher active="oracle" />
          </div>
        </header>

        <section className={styles.controlBar}>
          <label>
            Alert threshold
            <div><input type="number" min="0.001" max="10" step="0.01" value={threshold} onChange={(event) => {
              setThreshold(Math.max(.001, Number(event.target.value) || .1));
              triggerDirections.current = {};
            }} /><span>%</span></div>
          </label>
          <button onClick={() => void loadQuotes()}>Refresh now</button>
          <span className={styles.refreshText}>{error || (lastRefresh ? `Updated ${formatTime(lastRefresh)} HKT · auto-refresh 5s` : "Connecting live feeds…")}</span>
        </section>

        <section className={styles.stats}>
          <article><span>Monitored</span><strong>{quotes.length || "—"}</strong><small>3 Binance · 3 Hyperliquid para</small></article>
          <article><span>Triggered</span><strong className={triggered.length ? styles.warningText : ""}>{triggered.length}</strong><small>Outside ±{threshold.toFixed(3)}%</small></article>
          <article><span>Largest drift</span><strong className={extreme && extreme.deviation >= 0 ? styles.positive : styles.negative}>{extreme ? formatPct(extreme.deviation) : "—"}</strong><small>{extreme?.symbol ?? "Waiting for data"}</small></article>
          <article><span>Selected funding</span><strong>{selected?.funding == null ? "—" : formatPct(selected.funding * 100, 4)}</strong><small>{selected ? `${selected.fundingHours}h rate · ${selected.venue}` : "—"}</small></article>
        </section>

        <section className={styles.deviationBoard}>
          <div className={`${styles.side} ${styles.positiveSide}`}>
            <header><div><span>↗</span><strong>Positive deviation</strong></div><b>{positive.length}</b></header>
            <div className={styles.cardList}>{positive.map((quote) => <QuoteCard key={quote.id} quote={quote} threshold={threshold} selected={quote.id === selected?.id} onSelect={() => setSelectedId(quote.id)} />)}
              {!positive.length && <p>No positive deviations.</p>}
            </div>
          </div>
          <div className={`${styles.side} ${styles.negativeSide}`}>
            <header><div><span>↘</span><strong>Negative deviation</strong></div><b>{negative.length}</b></header>
            <div className={styles.cardList}>{negative.map((quote) => <QuoteCard key={quote.id} quote={quote} threshold={threshold} selected={quote.id === selected?.id} onSelect={() => setSelectedId(quote.id)} />)}
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

        <footer className={styles.footer}>Oracle and mark prices are reference inputs, not executable prices. Funding is shown in each venue&apos;s native interval.</footer>
      </div>
    </main>
  );
}
