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
  spreadPct: number | null;
};

type FundingPoint = { t: number; rate: number };
type StreamStatus = "connecting" | "live" | "reconnecting";
type BinanceBook = { symbol?: string; bidPrice?: string; askPrice?: string; time?: number };

const HISTORY_WINDOWS = [
  { label: "24H", ms: 24 * 60 * 60_000 },
  { label: "3D", ms: 3 * 24 * 60 * 60_000 },
  { label: "7D", ms: 7 * 24 * 60 * 60_000 },
  { label: "30D", ms: 30 * 24 * 60 * 60_000 },
] as const;

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
const formatTime = (value: number | null, date = false) => value === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", month: date ? "short" : undefined, day: date ? "2-digit" : undefined, hour: "2-digit", minute: "2-digit", hour12: false }).format(value);

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

export default function PolymarketPerpsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [sources, setSources] = useState({ polymarket: false, binance: false });
  const [polyStream, setPolyStream] = useState<StreamStatus>("connecting");
  const [binanceStream, setBinanceStream] = useState<StreamStatus>("connecting");
  const [selectedId, setSelectedId] = useState(6);
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

  const loadMarkets = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const response = await fetch("/api/polymarket-perps/markets", { cache: "no-store" });
      const payload = await response.json() as { markets?: Market[]; sources?: { polymarket: boolean; binance: boolean }; timestamp?: number; error?: string };
      if (!response.ok || !payload.markets?.length) throw new Error(payload.error || "Polymarket Perps data unavailable.");
      setMarkets((current) => payload.markets!.map((market) => {
        const live = current.find((item) => item.instrumentId === market.instrumentId);
        const keepPolyStream = polyStream === "live" && live && live.timestamp > market.timestamp;
        const keepBinanceStream = binanceStream === "live" && live?.binanceUpdatedAt && (!market.binanceUpdatedAt || live.binanceUpdatedAt > market.binanceUpdatedAt);
        const merged = keepPolyStream ? { ...market, indexPrice: live.indexPrice, markPrice: live.markPrice, lastPrice: live.lastPrice, midPrice: live.midPrice, openInterest: live.openInterest, fundingRate: live.fundingRate, nextFunding: live.nextFunding, timestamp: live.timestamp } : market;
        return keepBinanceStream ? { ...merged, mappingVerified: live.mappingVerified, binanceBid: live.binanceBid, binanceAsk: live.binanceAsk, binanceMid: live.binanceMid, binanceUpdatedAt: live.binanceUpdatedAt, spreadPct: merged.midPrice !== null && live.binanceMid !== null ? (merged.midPrice / live.binanceMid - 1) * 100 : null } : merged;
      }));
      setSources(payload.sources ?? { polymarket: true, binance: false });
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
  }, [binanceStream, mergeBinanceBooks, polyStream]);

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
            return { ...market, indexPrice: positive(frame.data!.idx), markPrice: positive(frame.data!.mark), lastPrice: positive(frame.data!.last), midPrice, openInterest: positive(frame.data!.oi), fundingRate: finite(frame.data!.fr), nextFunding: finite(frame.data!.nxf), timestamp: finite(frame.ts) ?? Date.now(), spreadPct: midPrice !== null && market.binanceMid !== null ? (midPrice / market.binanceMid - 1) * 100 : null };
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
      socket.onopen = () => { socket?.send(JSON.stringify({ method: "SUBSCRIBE", params: symbols.map((symbol) => `${symbol.toLowerCase()}@bookTicker`), id: 1 })); setBinanceStream("live"); };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { data?: { s?: string; b?: string; a?: string; E?: number } };
          const data = frame.data;
          if (!data?.s) return;
          mergeBinanceBooks([{ symbol: data.s, bidPrice: data.b, askPrice: data.a, time: data.E }]);
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
  }, [mappedKey, mergeBinanceBooks]);

  const selected = markets.find((market) => market.instrumentId === selectedId) ?? markets[0];
  const selectedInstrumentId = selected?.instrumentId;
  const loadHistory = useCallback(async () => {
    if (!selectedInstrumentId) return;
    setLoadingHistory(true);
    try {
      const end = Date.now();
      const params = new URLSearchParams({ instrumentId: String(selectedInstrumentId), start: String(end - historyWindow), end: String(end) });
      const response = await fetch(`/api/polymarket-perps/funding?${params}`, { cache: "no-store" });
      const payload = await response.json() as { points?: FundingPoint[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Funding history unavailable.");
      setHistory(payload.points ?? []);
    } catch (historyError) {
      setHistory([]);
      setError(historyError instanceof Error ? historyError.message : "Funding history unavailable.");
    } finally { setLoadingHistory(false); }
  }, [historyWindow, selectedInstrumentId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadHistory());
    return () => window.cancelAnimationFrame(frame);
  }, [loadHistory]);

  const categories = useMemo(() => [...new Set(markets.map((market) => market.category))].sort(), [markets]);
  const visible = useMemo(() => markets.filter((market) => {
    const needle = search.trim().toLowerCase();
    return (!needle || market.symbol.toLowerCase().includes(needle) || market.binanceSymbol?.toLowerCase().includes(needle))
      && (category === "all" || market.category === category)
      && (!matchedOnly || market.binanceMid !== null);
  }).sort((a, b) => Math.abs(b.fundingRate ?? 0) - Math.abs(a.fundingRate ?? 0)), [category, markets, matchedOnly, search]);
  const matched = markets.filter((market) => market.binanceMid !== null).length;
  const largestFunding = markets.reduce<Market | null>((best, market) => !best || Math.abs(market.fundingRate ?? 0) > Math.abs(best.fundingRate ?? 0) ? market : best, null);
  const largestSpread = markets.reduce<Market | null>((best, market) => market.spreadPct === null ? best : !best || Math.abs(market.spreadPct) > Math.abs(best.spreadPct ?? 0) ? market : best, null);

  return <main className={styles.shell}><div className={styles.frame}>
    <header className={styles.topbar}><div><p className={styles.eyebrow}>POLYMARKET PERPS / CARRY INTELLIGENCE</p><h1>Funding & Basis</h1><p>Monitor hourly Polymarket Perps funding, settlement history, and live midpoint spreads against verified Binance equivalents.</p></div><div className={styles.topActions}><div className={styles.connections}><span className={polyStream === "live" || sources.polymarket ? styles.online : ""}><i />Polymarket {polyStream === "live" ? "WS live" : "REST fallback"}</span><span className={binanceStream === "live" || sources.binance ? styles.online : ""}><i />Binance {binanceStream === "live" ? "WS live" : sources.binance ? "REST fallback" : "reconnecting"}</span></div><PageSwitcher active="polymarket" /></div></header>

    <section className={styles.stats}><article><span>Active Perps</span><strong>{markets.length || "—"}</strong><small>{categories.length} market categories</small></article><article><span>Live Binance matches</span><strong>{matched}</strong><small>Exact or named reference symbols</small></article><article><span>Largest |1h funding|</span><strong className={(largestFunding?.fundingRate ?? 0) >= 0 ? styles.positive : styles.negative}>{formatFunding(largestFunding?.fundingRate ?? null)}</strong><small>{largestFunding?.symbol ?? "Waiting for data"}</small></article><article><span>Largest live spread</span><strong className={(largestSpread?.spreadPct ?? 0) >= 0 ? styles.positive : styles.negative}>{formatPct(largestSpread?.spreadPct ?? null, 3)}</strong><small>{largestSpread ? `${largestSpread.symbol} vs ${largestSpread.binanceSymbol}` : "No synchronized midpoint"}</small></article></section>

    <section className={styles.filters}><label>Search markets<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="BTC, AAPL, GOLD…" /></label><label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label className={styles.matchToggle}><input type="checkbox" checked={matchedOnly} onChange={(event) => setMatchedOnly(event.target.checked)} /><span>Binance midpoint available</span></label><button onClick={() => void loadMarkets()}>Refresh now</button><p>{error || (lastUpdate ? `Last market update ${formatTime(lastUpdate)} HKT` : "Connecting public market data…")}</p></section>

    <section className={styles.marketGrid}>{visible.map((market) => {
      const funding = market.fundingRate;
      const markBasis = market.markPrice !== null && market.indexPrice !== null ? (market.markPrice / market.indexPrice - 1) * 100 : null;
      return <button key={market.instrumentId} className={`${styles.marketCard} ${selected?.instrumentId === market.instrumentId ? styles.selectedCard : ""}`} onClick={() => setSelectedId(market.instrumentId)}>
        <div className={styles.cardHead}><div><small>{market.category} · #{market.instrumentId}</small><strong>{market.symbol}</strong></div><span className={(funding ?? 0) >= 0 ? styles.positiveFunding : styles.negativeFunding}>{formatFunding(funding)}<small>per 1h</small></span></div>
        <div className={styles.rateMeta}><span>{funding === null ? "Funding unavailable" : funding > 0 ? "Longs pay shorts" : funding < 0 ? "Shorts pay longs" : "Balanced funding"}</span><b>APR {funding === null ? "—" : formatPct(funding * 24 * 365 * 100, 2)}</b></div>
        <div className={styles.priceGrid}><div><span>Mid</span><b>{formatPrice(market.midPrice)}</b></div><div><span>Mark</span><b>{formatPrice(market.markPrice)}</b></div><div><span>Index</span><b>{formatPrice(market.indexPrice)}</b></div><div><span>Mark basis</span><b>{formatPct(markBasis, 3)}</b></div></div>
        <div className={`${styles.comparison} ${market.binanceSymbol ? "" : styles.noComparison}`}><div><span>{market.binanceSymbol ? `BINANCE · ${market.binanceSymbol}` : "NO EXACT BINANCE SYMBOL"}</span><strong>{formatPrice(market.binanceMid)}</strong></div><div><span>POLY − BINANCE</span><strong className={(market.spreadPct ?? 0) >= 0 ? styles.positive : styles.negative}>{formatPct(market.spreadPct, 3)}</strong></div></div>
        <footer><span>OI {formatCompact(market.openInterest)} {market.baseAsset}</span><span>Next {formatTime(market.nextFunding)} HKT</span></footer>
      </button>;
    })}{!visible.length && <div className={styles.noMarkets}>No markets match the current filters.</div>}</section>

    <section className={styles.historyPanel}><div className={styles.historyHead}><div><p className={styles.eyebrow}>HOURLY FUNDING HISTORY</p><h2>{selected?.symbol ?? "Select a market"}</h2><span>{selected ? `Current ${formatFunding(selected.fundingRate)} · next settlement ${formatTime(selected.nextFunding)} HKT` : "Waiting for market list"}</span></div><div className={styles.historyWindows}>{HISTORY_WINDOWS.map((window) => <button key={window.label} className={historyWindow === window.ms ? styles.activeWindow : ""} onClick={() => setHistoryWindow(window.ms)}>{window.label}</button>)}</div></div>{loadingHistory ? <div className={styles.emptyChart}>Loading funding settlements…</div> : history.length > 1 && selected ? <FundingChart points={history} symbol={selected.symbol} /> : <div className={styles.emptyChart}>No settled funding observations are available in this window.</div>}<footer><span>Polymarket public funding history · hourly settlements</span><span>{history.length} observations</span></footer></section>

    <footer className={styles.footer}>Spread = Polymarket midpoint ÷ Binance midpoint − 1. A reference mapping may differ in session, contract construction, collateral and index methodology. Missing or zero midpoint data is never converted into a synthetic spread.</footer>
  </div></main>;
}
