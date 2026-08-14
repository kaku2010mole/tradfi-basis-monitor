"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

type ApiLevel = {
  priceStart: number;
  priceEnd: number;
  price: number;
  valueUsd: number;
  positions: number;
  side: "long" | "short" | "unknown";
};
type ApiSnapshot = {
  symbol: string;
  displaySymbol: string;
  t: number;
  oracle: number | null;
  mark: number | null;
  source: "HyperTracker";
  exact: true;
  levels: ApiLevel[];
};
type CompactLevel = [priceStart: number, priceEnd: number, valueUsd: number, positions: number, side: 0 | 1];
type StoredSnapshot = {
  id: string;
  apiSymbol: string;
  symbol: string;
  t: number;
  oracle: number | null;
  mark: number | null;
  source: "HyperTracker";
  levels: CompactLevel[];
};
type FeedStatus = "connecting" | "live" | "retrying" | "not-configured";

const DEFAULT_SYMBOLS = [
  { api: "para:OTHERS", label: "para:OTHERS" },
  { api: "para:TOTAL2", label: "para:TOTAL2" },
  { api: "para:BTCD", label: "para:BTC.D" },
] as const;
const WINDOWS = [
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "4h", ms: 4 * 60 * 60_000 },
  { label: "12h", ms: 12 * 60 * 60_000 },
  { label: "24h", ms: 24 * 60 * 60_000 },
] as const;
const RANGE_OPTIONS = [5, 10, 20, 40];
const CAPTURE_MS = 30_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const DB_NAME = "oracle-monitor-liquidations-v1";
const STORE_NAME = "snapshots";
const CUSTOM_SYMBOLS_KEY = "oracle-liquidation-custom-symbols-v1";

const formatPrice = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—"
  : value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 3 : 6 });
const formatUsd = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
}).format(value);
const formatTime = (value: number, includeDate = false) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong",
  month: includeDate ? "short" : undefined,
  day: includeDate ? "2-digit" : undefined,
  hour: "2-digit",
  minute: "2-digit",
  second: includeDate ? undefined : "2-digit",
  hour12: false,
}).format(value);
const displaySymbol = (symbol: string) => symbol === "para:BTCD" ? "para:BTC.D" : symbol;
const normalizeSymbol = (value: string) => {
  const clean = value.trim();
  const normalized = clean.toLowerCase() === "para:btc.d" ? "para:BTCD" : clean;
  return /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(normalized) && normalized.length <= 64 ? normalized : null;
};

const normalizeStored = (value: unknown): StoredSnapshot | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<StoredSnapshot>;
  if (!record.apiSymbol || !Number.isFinite(record.t) || !Array.isArray(record.levels)) return null;
  const levels = record.levels.flatMap<CompactLevel>((level) => {
    if (!Array.isArray(level) || level.length < 5) return [];
    const start = Number(level[0]);
    const end = Number(level[1]);
    const usd = Number(level[2]);
    const positions = Number(level[3]);
    const side = Number(level[4]);
    return start > 0 && end > start && usd > 0 && Number.isFinite(positions) && (side === 0 || side === 1)
      ? [[start, end, usd, positions, side]]
      : [];
  });
  if (!levels.length) return null;
  const t = Number(record.t);
  return {
    id: typeof record.id === "string" ? record.id : `${record.apiSymbol}:${Math.floor(t / CAPTURE_MS)}`,
    apiSymbol: record.apiSymbol,
    symbol: record.symbol || displaySymbol(record.apiSymbol),
    t,
    oracle: Number(record.oracle) > 0 ? Number(record.oracle) : null,
    mark: Number(record.mark) > 0 ? Number(record.mark) : null,
    source: "HyperTracker",
    levels,
  };
};

const fromApi = (snapshot: ApiSnapshot): StoredSnapshot => ({
  id: `${snapshot.symbol}:${Math.floor(snapshot.t / CAPTURE_MS)}`,
  apiSymbol: snapshot.symbol,
  symbol: snapshot.displaySymbol,
  t: snapshot.t,
  oracle: snapshot.oracle,
  mark: snapshot.mark,
  source: "HyperTracker",
  levels: snapshot.levels.flatMap<CompactLevel>((level) => level.side === "unknown" ? [] : [[
    level.priceStart,
    level.priceEnd,
    level.valueUsd,
    level.positions,
    level.side === "long" ? 0 : 1,
  ]]),
});

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    store.createIndex("time", "t");
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const readAll = (database: IDBDatabase) => new Promise<StoredSnapshot[]>((resolve, reject) => {
  const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
  request.onsuccess = () => resolve(request.result as StoredSnapshot[]);
  request.onerror = () => reject(request.error);
});

const persistSnapshot = (database: IDBDatabase, snapshot: StoredSnapshot) => new Promise<void>((resolve, reject) => {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  store.put(snapshot);
  const cursor = store.index("time").openCursor(IDBKeyRange.upperBound(Date.now() - RETENTION_MS));
  cursor.onsuccess = () => {
    const item = cursor.result;
    if (!item) return;
    item.delete();
    item.continue();
  };
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
});

function LiquidationCanvas({ snapshots, windowMs, rangePct, verticalPan, viewEnd, minViewEnd, maxViewEnd, onViewEndChange, onVerticalPanChange }: {
  snapshots: StoredSnapshot[];
  windowMs: number;
  rangePct: number;
  verticalPan: number;
  viewEnd: number;
  minViewEnd: number;
  maxViewEnd: number;
  onViewEndChange: (value: number) => void;
  onVerticalPanChange: (value: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; end: number; pan: number; width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(320, rect.width);
      const height = Math.max(320, rect.height);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = "#050b16";
      context.fillRect(0, 0, width, height);
      const margin = { left: 70, right: 16, top: 20, bottom: 38 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      const startTime = viewEnd - windowMs;
      const references = snapshots.map((snapshot) => snapshot.oracle ?? snapshot.mark).filter((value): value is number => value !== null && value > 0);
      const reference = references.at(-1) ?? null;
      if (!snapshots.length || reference === null) {
        context.fillStyle = "#7890aa";
        context.font = "12px system-ui, sans-serif";
        context.textAlign = "center";
        context.fillText("Waiting for exact liquidation-price data…", width / 2, height / 2);
        return;
      }
      const halfSpan = Math.max(reference * rangePct / 100, 0.000001);
      const center = reference + halfSpan * verticalPan;
      const priceMin = Math.max(0.0000001, center - halfSpan);
      const priceMax = center + halfSpan;
      const x = (time: number) => margin.left + ((time - startTime) / windowMs) * plotWidth;
      const y = (price: number) => margin.top + ((priceMax - price) / (priceMax - priceMin)) * plotHeight;

      context.font = "10px ui-monospace, SFMono-Regular, monospace";
      for (let index = 0; index <= 5; index += 1) {
        const gridY = margin.top + (plotHeight * index) / 5;
        const price = priceMax - ((priceMax - priceMin) * index) / 5;
        context.strokeStyle = "rgba(128,158,190,.14)";
        context.beginPath();
        context.moveTo(margin.left, gridY);
        context.lineTo(width - margin.right, gridY);
        context.stroke();
        context.fillStyle = "#70859d";
        context.textAlign = "right";
        context.fillText(formatPrice(price), margin.left - 8, gridY + 3);
      }
      for (let index = 0; index <= 4; index += 1) {
        const time = startTime + (windowMs * index) / 4;
        const gridX = x(time);
        context.strokeStyle = "rgba(128,158,190,.08)";
        context.beginPath();
        context.moveTo(gridX, margin.top);
        context.lineTo(gridX, height - margin.bottom);
        context.stroke();
        context.fillStyle = "#70859d";
        context.textAlign = index === 0 ? "left" : index === 4 ? "right" : "center";
        context.fillText(formatTime(time).slice(0, 5), gridX, height - 13);
      }

      const rows = Math.max(72, Math.min(150, Math.floor(plotHeight / 2.6)));
      const cells: Array<{ index: number; row: number; side: 0 | 1; usd: number }> = [];
      let maxUsd = 1;
      snapshots.forEach((snapshot, index) => {
        const rowTotals = new Map<string, number>();
        snapshot.levels.forEach(([binStart, binEnd, usd, , side]) => {
          const levelPrice = (binStart + binEnd) / 2;
          if (levelPrice < priceMin || levelPrice > priceMax) return;
          const row = Math.max(0, Math.min(rows - 1, Math.floor(((priceMax - levelPrice) / (priceMax - priceMin)) * rows)));
          const key = `${row}:${side}`;
          rowTotals.set(key, (rowTotals.get(key) ?? 0) + usd);
        });
        rowTotals.forEach((usd, key) => {
          const [row, side] = key.split(":").map(Number);
          maxUsd = Math.max(maxUsd, usd);
          cells.push({ index, row, side: side as 0 | 1, usd });
        });
      });
      const singleSnapshot = snapshots.length === 1;
      cells.forEach((cell) => {
        const snapshot = snapshots[cell.index];
        const next = snapshots[cell.index + 1];
        const cellStart = singleSnapshot ? margin.left : Math.max(margin.left, x(snapshot.t));
        const cellEnd = singleSnapshot ? width - margin.right : Math.min(width - margin.right, next ? x(next.t) : x(snapshot.t + CAPTURE_MS));
        const strength = Math.pow(Math.log1p(cell.usd) / Math.log1p(maxUsd), .64);
        context.fillStyle = cell.side === 0
          ? `rgba(255, 76, 102, ${.07 + strength * .9})`
          : `rgba(45, 221, 172, ${.07 + strength * .9})`;
        context.fillRect(cellStart, margin.top + (cell.row / rows) * plotHeight, Math.max(2, cellEnd - cellStart + 1), Math.max(2, plotHeight / rows + .9));
      });

      const trace = () => {
        context.beginPath();
        let started = false;
        snapshots.forEach((snapshot) => {
          const price = snapshot.oracle ?? snapshot.mark;
          if (!price || price < priceMin || price > priceMax) return;
          const traceX = singleSnapshot ? width - margin.right : x(snapshot.t);
          if (!started) context.moveTo(traceX, y(price));
          else context.lineTo(traceX, y(price));
          started = true;
        });
        if (singleSnapshot) {
          context.moveTo(margin.left, y(reference));
          context.lineTo(width - margin.right, y(reference));
        }
      };
      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";
      context.shadowColor = "#52b8ff";
      context.shadowBlur = 15;
      context.strokeStyle = "rgba(65,176,255,.55)";
      context.lineWidth = 7;
      trace();
      context.stroke();
      context.shadowBlur = 0;
      context.strokeStyle = "#d8f2ff";
      context.lineWidth = 2.8;
      trace();
      context.stroke();
      context.restore();
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [rangePct, snapshots, verticalPan, viewEnd, windowMs]);

  return <canvas
    ref={canvasRef}
    className={`${styles.depthCanvas} ${dragging ? styles.draggingCanvas : ""}`}
    aria-label="Liquidation price heatmap. Drag horizontally through time and vertically through price."
    onPointerDown={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      dragRef.current = { x: event.clientX, y: event.clientY, end: viewEnd, pan: verticalPan, width: rect.width, height: rect.height };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const drag = dragRef.current;
      if (!drag) return;
      const timeDelta = ((event.clientX - drag.x) / Math.max(1, drag.width)) * windowMs;
      const priceDelta = ((event.clientY - drag.y) / Math.max(1, drag.height)) * 2;
      onViewEndChange(Math.max(minViewEnd, Math.min(maxViewEnd, drag.end - timeDelta)));
      onVerticalPanChange(Math.max(-8, Math.min(8, drag.pan + priceDelta)));
    }}
    onPointerUp={(event) => {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      setDragging(false);
    }}
    onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
    onDoubleClick={() => { onViewEndChange(maxViewEnd); onVerticalPanChange(0); }}
  />;
}

export default function LiquidationPriceMap() {
  const databaseRef = useRef<IDBDatabase | null>(null);
  const requestRef = useRef(false);
  const [snapshots, setSnapshots] = useState<StoredSnapshot[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState("para:OTHERS");
  const [customSymbols, setCustomSymbols] = useState<string[]>([]);
  const [newSymbol, setNewSymbol] = useState("");
  const [pairError, setPairError] = useState("");
  const [windowMs, setWindowMs] = useState<number>(WINDOWS[1].ms);
  const [rangePct, setRangePct] = useState(20);
  const [verticalPan, setVerticalPan] = useState(0);
  const [viewEnd, setViewEnd] = useState<number | null>(null);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [message, setMessage] = useState("Connecting to exact position data…");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [initialClock] = useState(() => Date.now());

  const mergeSnapshots = useCallback((incoming: StoredSnapshot[]) => {
    if (!incoming.length) return;
    setSnapshots((current) => {
      const cutoff = Date.now() - RETENTION_MS;
      const byId = new Map(current.filter((snapshot) => snapshot.t >= cutoff).map((snapshot) => [snapshot.id, snapshot]));
      incoming.forEach((snapshot) => byId.set(snapshot.id, snapshot));
      return [...byId.values()].sort((a, b) => a.t - b.t);
    });
  }, []);

  useEffect(() => {
    let savedFrame = 0;
    try {
      const saved = JSON.parse(window.localStorage.getItem(CUSTOM_SYMBOLS_KEY) || "[]") as unknown;
      if (Array.isArray(saved)) savedFrame = window.requestAnimationFrame(() => setCustomSymbols(saved.flatMap((value) => typeof value === "string" && normalizeSymbol(value) ? [value] : [])));
    } catch { /* Use the built-in universe. */ }
    if (!("indexedDB" in window)) return () => window.cancelAnimationFrame(savedFrame);
    let cancelled = false;
    void openDatabase().then(async (database) => {
      if (cancelled) return database.close();
      databaseRef.current = database;
      const saved = await readAll(database);
      if (!cancelled) mergeSnapshots(saved.filter((snapshot) => snapshot.t >= Date.now() - RETENTION_MS));
    }).catch(() => undefined);
    return () => { cancelled = true; window.cancelAnimationFrame(savedFrame); databaseRef.current?.close(); databaseRef.current = null; };
  }, [mergeSnapshots]);

  const capture = useCallback(async () => {
    if (requestRef.current) return;
    requestRef.current = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/oracle-monitor/liquidation-map?symbol=${encodeURIComponent(selectedSymbol)}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as ApiSnapshot & { error?: string };
      if (!response.ok || !payload.levels?.length) throw new Error(payload.error || "Liquidation map unavailable.");
      const next = fromApi(payload);
      if (databaseRef.current) await persistSnapshot(databaseRef.current, next);
      mergeSnapshots([next]);
      setLastUpdate(next.t);
      setStatus("live");
      setMessage(`Exact position aggregate · ${next.levels.length.toLocaleString()} active price bins`);
    } catch (error) {
      const copy = error instanceof Error ? error.message : "Liquidation map unavailable.";
      setStatus(copy.includes("not configured") ? "not-configured" : "retrying");
      setMessage(copy);
    } finally {
      window.clearTimeout(timeout);
      requestRef.current = false;
    }
  }, [mergeSnapshots, selectedSymbol]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setStatus("connecting");
      setMessage("Connecting to exact position data…");
      void capture();
    });
    const timer = window.setInterval(capture, CAPTURE_MS);
    return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); };
  }, [capture]);

  useEffect(() => {
    const end = Date.now();
    void fetch(`/api/oracle-monitor/liquidation-history?symbol=${encodeURIComponent(selectedSymbol)}&start=${end - windowMs}&end=${end}`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ snapshots?: unknown[] }> : { snapshots: [] })
      .then((payload) => mergeSnapshots((payload.snapshots ?? []).flatMap((value) => {
        const snapshot = normalizeStored(value);
        return snapshot ? [snapshot] : [];
      })))
      .catch(() => undefined);
  }, [mergeSnapshots, selectedSymbol, windowMs]);

  const symbolSnapshots = useMemo(() => snapshots.filter((snapshot) => snapshot.apiSymbol === selectedSymbol), [selectedSymbol, snapshots]);
  const latestTime = symbolSnapshots.at(-1)?.t ?? initialClock;
  const earliestTime = symbolSnapshots[0]?.t ?? latestTime;
  const minViewEnd = Math.min(latestTime, earliestTime + windowMs);
  const resolvedViewEnd = viewEnd === null ? latestTime : Math.max(minViewEnd, Math.min(latestTime, viewEnd));
  const visibleSnapshots = useMemo(() => symbolSnapshots.filter((snapshot) => snapshot.t >= resolvedViewEnd - windowMs && snapshot.t <= resolvedViewEnd), [resolvedViewEnd, symbolSnapshots, windowMs]);
  const latest = visibleSnapshots.at(-1) ?? symbolSnapshots.at(-1);
  const reference = latest?.oracle ?? latest?.mark ?? null;
  const longUsd = latest?.levels.filter((level) => level[4] === 0).reduce((sum, level) => sum + level[2], 0) ?? 0;
  const shortUsd = latest?.levels.filter((level) => level[4] === 1).reduce((sum, level) => sum + level[2], 0) ?? 0;
  const positionCount = latest?.levels.reduce((sum, level) => sum + level[3], 0) ?? 0;
  const strongest = latest?.levels.reduce<CompactLevel | null>((best, level) => !best || level[2] > best[2] ? level : best, null) ?? null;
  const strongestPrice = strongest ? (strongest[0] + strongest[1]) / 2 : null;
  const strongestDistance = strongestPrice && reference ? (strongestPrice / reference - 1) * 100 : null;
  const allSymbols = [...DEFAULT_SYMBOLS.map((item) => item.api), ...customSymbols.filter((symbol) => !DEFAULT_SYMBOLS.some((item) => item.api === symbol))];

  const selectSymbol = (symbol: string) => {
    setSelectedSymbol(symbol);
    setViewEnd(null);
    setVerticalPan(0);
  };
  const addSymbol = () => {
    const normalized = normalizeSymbol(newSymbol);
    if (!normalized) { setPairError("Use a Hyperliquid symbol such as BTC or xyz:XYZ100."); return; }
    const next = [...new Set([...customSymbols, normalized])];
    setCustomSymbols(next);
    window.localStorage.setItem(CUSTOM_SYMBOLS_KEY, JSON.stringify(next));
    setNewSymbol("");
    setPairError("");
    selectSymbol(normalized);
  };
  const removeSymbol = (symbol: string) => {
    const next = customSymbols.filter((item) => item !== symbol);
    setCustomSymbols(next);
    window.localStorage.setItem(CUSTOM_SYMBOLS_KEY, JSON.stringify(next));
    if (selectedSymbol === symbol) selectSymbol("para:OTHERS");
  };
  const updateViewEnd = (value: number) => setViewEnd(value >= latestTime - CAPTURE_MS ? null : value);
  const statusCopy = status === "live" ? "HyperTracker live"
    : status === "retrying" ? "Reconnecting"
      : status === "not-configured" ? "Server setup required"
        : "Connecting";

  return <section className={`${styles.depthPanel} ${styles.liquidationPanel}`}>
    <div className={styles.depthHeader}>
      <div>
        <p className={styles.eyebrow}>EXACT POSITION LIQUIDATION RISK</p>
        <h2>Liquidation price map</h2>
        <p>Select any Hyperliquid contract. Bright bands show more USD notional clustered at liquidation prices; long risk is below the reference price and short risk is above it.</p>
      </div>
      <div className={`${styles.recorderStatus} ${status === "live" ? styles.recorderLive : ""}`}>
        <i />
        <span><strong>{statusCopy}</strong><small>{lastUpdate ? `${formatTime(lastUpdate)} HKT · 30s refresh` : "Waiting for first snapshot"}</small></span>
      </div>
    </div>

    <div className={styles.liquidationPairBar}>
      <div className={styles.depthTabs} aria-label="Liquidation contract">
        {allSymbols.map((symbol) => <span className={styles.liquidationPairChip} key={symbol}>
          <button className={selectedSymbol === symbol ? styles.activeDepthTab : ""} onClick={() => selectSymbol(symbol)}>{displaySymbol(symbol)}</button>
          {!DEFAULT_SYMBOLS.some((item) => item.api === symbol) && <button aria-label={`Remove ${symbol}`} className={styles.removeLiquidationPair} onClick={() => removeSymbol(symbol)}>×</button>}
        </span>)}
      </div>
      <div className={styles.liquidationPairForm}>
        <input value={newSymbol} onChange={(event) => setNewSymbol(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addSymbol(); }} placeholder="BTC or xyz:XYZ100" aria-label="Hyperliquid symbol" />
        <button onClick={addSymbol}>Add pair</button>
      </div>
      {pairError && <small className={styles.liquidationError}>{pairError}</small>}
    </div>

    <div className={styles.depthToolbar}>
      <div className={styles.depthWindows} aria-label="Liquidation heatmap time window">
        {WINDOWS.map((window) => <button key={window.label} className={windowMs === window.ms ? styles.activeDepthWindow : ""} onClick={() => { setWindowMs(window.ms); setViewEnd(null); }}>{window.label}</button>)}
      </div>
      <div className={styles.liquidationRange}>
        <span>Y range</span>
        {RANGE_OPTIONS.map((range) => <button key={range} className={rangePct === range ? styles.activeRange : ""} onClick={() => { setRangePct(range); setVerticalPan(0); }}>±{range}%</button>)}
        <button disabled={verticalPan === 0} onClick={() => setVerticalPan(0)}>Reset Y</button>
      </div>
    </div>

    <div className={styles.depthMetrics}>
      <div><span>Reference price</span><strong>{formatPrice(reference)}</strong></div>
      <div><span>Long liquidation risk</span><strong className={styles.longRisk}>{longUsd ? formatUsd(longUsd) : "—"}</strong></div>
      <div><span>Short liquidation risk</span><strong className={styles.shortRisk}>{shortUsd ? formatUsd(shortUsd) : "—"}</strong></div>
      <div><span>Strongest cluster</span><strong>{strongestPrice ? formatPrice(strongestPrice) : "—"}</strong></div>
      <div><span>Cluster distance</span><strong>{strongestDistance == null ? "—" : `${strongestDistance >= 0 ? "+" : ""}${strongestDistance.toFixed(2)}%`}</strong></div>
    </div>

    <div className={styles.depthLegend}>
      <span><i className={styles.longLiquidationLegend} />Long liquidations</span>
      <span><i className={styles.shortLiquidationLegend} />Short liquidations</span>
      <span><i className={styles.oracleLegend} />Oracle / reference price</span>
      <small>Drag left/right through time · drag up/down through price · double-click to reset</small>
    </div>
    <div className={`${styles.depthCanvasWrap} ${styles.liquidationCanvasWrap}`}>
      <LiquidationCanvas snapshots={visibleSnapshots} windowMs={windowMs} rangePct={rangePct} verticalPan={verticalPan} viewEnd={resolvedViewEnd} minViewEnd={minViewEnd} maxViewEnd={latestTime} onViewEndChange={updateViewEnd} onVerticalPanChange={setVerticalPan} />
    </div>
    <div className={styles.timeNavigator}>
      <div><span>{resolvedViewEnd ? `${formatTime(resolvedViewEnd - windowMs, true)} — ${formatTime(resolvedViewEnd, true)} HKT` : "Waiting for history"}</span><button className={viewEnd === null ? styles.liveTime : ""} onClick={() => setViewEnd(null)}>● Live</button></div>
      <input aria-label="Liquidation map history position" type="range" min={minViewEnd} max={Math.max(minViewEnd, latestTime)} step={CAPTURE_MS} value={resolvedViewEnd} disabled={!symbolSnapshots.length || latestTime <= minViewEnd} onChange={(event) => updateViewEnd(Number(event.target.value))} />
    </div>
    <footer className={styles.depthFooter}>
      <span>{message}</span>
      <span>{visibleSnapshots.length.toLocaleString()} snapshots · {positionCount.toLocaleString()} positions in latest aggregate · exact HyperTracker data</span>
    </footer>
  </section>;
}
