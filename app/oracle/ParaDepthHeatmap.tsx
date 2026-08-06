"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

type ApiLevel = { side: "bid" | "ask"; price: number; size: number };
type ApiBook = {
  apiSymbol: string;
  symbol: string;
  time: number;
  oracle: number | null;
  mark: number | null;
  levels: ApiLevel[];
};
type CompactLevel = [price: number, size: number, side: 0 | 1];
type StoredSnapshot = {
  id: string;
  apiSymbol: string;
  symbol: string;
  t: number;
  oracle: number | null;
  mark: number | null;
  levels: CompactLevel[];
};
type RecorderStatus = "starting" | "recording" | "retrying" | "local-storage-unavailable";
type AxisMode = "auto" | "oracle";

const SYMBOLS = [
  { api: "para:OTHERS", label: "para:OTHERS" },
  { api: "para:TOTAL2", label: "para:TOTAL2" },
  { api: "para:BTCD", label: "para:BTC.D" },
] as const;
const WINDOWS = [
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "4h", ms: 4 * 60 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000 },
  { label: "12h", ms: 12 * 60 * 60_000 },
  { label: "24h", ms: 24 * 60 * 60_000 },
] as const;
const DB_NAME = "oracle-monitor-para-depth-v1";
const STORE_NAME = "snapshots";
const RETENTION_MS = 24 * 60 * 60_000;
const CAPTURE_MS = 10_000;
const MAX_IMPORT_BYTES = 60 * 1024 * 1024;

const formatPrice = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—"
  : value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 3 : 6 });
const formatUsd = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: value >= 1_000_000 ? "compact" : "standard",
  maximumFractionDigits: value >= 1000 ? 1 : 0,
}).format(value);
const formatTime = (value: number) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
}).format(value);
const formatDateTime = (value: number) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(value);

const normalizeSnapshot = (value: unknown): StoredSnapshot | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<StoredSnapshot>;
  if (!record.apiSymbol || !SYMBOLS.some((symbol) => symbol.api === record.apiSymbol) || !Number.isFinite(record.t) || !Array.isArray(record.levels)) return null;
  const levels = record.levels.slice(0, 50).flatMap<CompactLevel>((level) => {
    if (!Array.isArray(level) || level.length < 3) return [];
    const price = Number(level[0]);
    const size = Number(level[1]);
    const side = Number(level[2]);
    return Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0 && (side === 0 || side === 1)
      ? [[price, size, side]]
      : [];
  });
  if (!levels.length) return null;
  const timestamp = Number(record.t);
  const apiSymbol = record.apiSymbol;
  return {
    id: typeof record.id === "string" ? record.id : `${apiSymbol}:${Math.floor(timestamp / CAPTURE_MS)}`,
    apiSymbol,
    symbol: apiSymbol === "para:BTCD" ? "para:BTC.D" : apiSymbol,
    t: timestamp,
    oracle: Number.isFinite(Number(record.oracle)) && Number(record.oracle) > 0 ? Number(record.oracle) : null,
    mark: Number.isFinite(Number(record.mark)) && Number(record.mark) > 0 ? Number(record.mark) : null,
    levels,
  };
};

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    store.createIndex("time", "t");
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable."));
});

const readAll = (database: IDBDatabase) => new Promise<StoredSnapshot[]>((resolve, reject) => {
  const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
  request.onsuccess = () => resolve(request.result as StoredSnapshot[]);
  request.onerror = () => reject(request.error);
});

const persistSnapshots = (database: IDBDatabase, snapshots: StoredSnapshot[]) => new Promise<void>((resolve, reject) => {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  snapshots.forEach((snapshot) => store.put(snapshot));
  const cutoff = Date.now() - RETENTION_MS;
  const cursor = store.index("time").openCursor(IDBKeyRange.upperBound(cutoff));
  cursor.onsuccess = () => {
    const item = cursor.result;
    if (!item) return;
    item.delete();
    item.continue();
  };
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

function DepthCanvas({ snapshots, windowMs, symbol, axisMode, oracleRangePct, verticalPan, viewEnd, minViewEnd, maxViewEnd, onViewEndChange, onVerticalPanChange }: {
  snapshots: StoredSnapshot[];
  windowMs: number;
  symbol: string;
  axisMode: AxisMode;
  oracleRangePct: number;
  verticalPan: number;
  viewEnd: number;
  minViewEnd: number;
  maxViewEnd: number;
  onViewEndChange: (value: number) => void;
  onVerticalPanChange: (value: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; end: number; verticalPan: number; width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(320, rect.width);
      const height = Math.max(300, rect.height);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#07131f";
      context.fillRect(0, 0, width, height);

      const margin = { left: 68, right: 14, top: 18, bottom: 34 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      const end = viewEnd;
      const start = end - windowMs;
      const prices = snapshots.flatMap((snapshot) => [
        ...snapshot.levels.map((level) => level[0]),
        ...(snapshot.oracle ? [snapshot.oracle] : []),
      ]).filter(Number.isFinite);

      if (!snapshots.length || !prices.length) {
        context.fillStyle = "#8da2b7";
        context.font = "12px system-ui, sans-serif";
        context.textAlign = "center";
        context.fillText("Collecting 10-second orderbook snapshots…", width / 2, height / 2);
        return;
      }

      let latestOracle: number | null = null;
      for (let index = snapshots.length - 1; index >= 0; index -= 1) {
        if (snapshots[index].oracle) {
          latestOracle = snapshots[index].oracle;
          break;
        }
      }
      let priceMin: number;
      let priceMax: number;
      if (axisMode === "oracle" && latestOracle) {
        const span = Math.max(latestOracle * oracleRangePct / 100, Math.abs(latestOracle) * .00001, .000001);
        const center = latestOracle + span * verticalPan;
        priceMin = center - span;
        priceMax = center + span;
      } else {
        priceMin = Math.min(...prices);
        priceMax = Math.max(...prices);
        const padding = Math.max((priceMax - priceMin) * .06, Math.abs(priceMax) * .0001, .000001);
        priceMin -= padding;
        priceMax += padding;
        const span = (priceMax - priceMin) / 2;
        const center = (priceMax + priceMin) / 2 + span * verticalPan;
        priceMin = center - span;
        priceMax = center + span;
      }
      const x = (time: number) => margin.left + ((time - start) / windowMs) * plotWidth;
      const y = (price: number) => margin.top + ((priceMax - price) / (priceMax - priceMin)) * plotHeight;

      context.lineWidth = 1;
      context.font = "10px ui-monospace, SFMono-Regular, monospace";
      for (let index = 0; index <= 4; index += 1) {
        const gridY = margin.top + (plotHeight * index) / 4;
        const price = priceMax - ((priceMax - priceMin) * index) / 4;
        context.strokeStyle = "rgba(151,174,196,.13)";
        context.beginPath();
        context.moveTo(margin.left, gridY);
        context.lineTo(width - margin.right, gridY);
        context.stroke();
        context.fillStyle = "#7890a6";
        context.textAlign = "right";
        context.fillText(formatPrice(price), margin.left - 8, gridY + 3);
      }
      for (let index = 0; index <= 4; index += 1) {
        const time = start + (windowMs * index) / 4;
        const gridX = x(time);
        context.strokeStyle = "rgba(151,174,196,.08)";
        context.beginPath();
        context.moveTo(gridX, margin.top);
        context.lineTo(gridX, height - margin.bottom);
        context.stroke();
        context.fillStyle = "#7890a6";
        context.textAlign = index === 0 ? "left" : index === 4 ? "right" : "center";
        context.fillText(formatTime(time).slice(0, 5), gridX, height - 12);
      }

      const rows = Math.max(60, Math.min(120, Math.floor(plotHeight / 3)));
      const cells: Array<{ x: number; row: number; side: 0 | 1; usd: number }> = [];
      let maxUsd = 1;
      snapshots.forEach((snapshot) => {
        const aggregated = new Map<string, number>();
        snapshot.levels.forEach(([price, size, side]) => {
          if (price < priceMin || price > priceMax) return;
          const row = Math.max(0, Math.min(rows - 1, Math.floor(((priceMax - price) / (priceMax - priceMin)) * rows)));
          const key = `${row}:${side}`;
          aggregated.set(key, (aggregated.get(key) ?? 0) + price * size);
        });
        aggregated.forEach((usd, key) => {
          const [row, side] = key.split(":").map(Number);
          maxUsd = Math.max(maxUsd, usd);
          cells.push({ x: x(snapshot.t), row, side: side as 0 | 1, usd });
        });
      });
      const expectedColumns = Math.max(1, windowMs / CAPTURE_MS);
      const cellWidth = Math.max(2, Math.min(10, plotWidth / expectedColumns * 1.7));
      const cellHeight = Math.max(2, plotHeight / rows + .8);
      cells.forEach((cell) => {
        const strength = Math.pow(Math.log1p(cell.usd) / Math.log1p(maxUsd), .72);
        context.fillStyle = cell.side === 0
          ? `rgba(23, 220, 174, ${.08 + strength * .82})`
          : `rgba(255, 107, 76, ${.08 + strength * .82})`;
        context.fillRect(cell.x - cellWidth / 2, margin.top + (cell.row / rows) * plotHeight, cellWidth, cellHeight);
      });

      const traceOracle = () => {
        context.beginPath();
        let started = false;
        snapshots.forEach((snapshot) => {
          if (!snapshot.oracle || snapshot.oracle < priceMin || snapshot.oracle > priceMax) return;
          if (!started) context.moveTo(x(snapshot.t), y(snapshot.oracle));
          else context.lineTo(x(snapshot.t), y(snapshot.oracle));
          started = true;
        });
      };
      context.save();
      context.lineJoin = "round";
      context.lineCap = "round";
      context.shadowColor = "#42bfff";
      context.shadowBlur = 14;
      context.strokeStyle = "rgba(66,191,255,.52)";
      context.lineWidth = 6;
      traceOracle();
      context.stroke();
      context.shadowBlur = 0;
      context.strokeStyle = "#bdeaff";
      context.lineWidth = 2.6;
      traceOracle();
      context.stroke();
      context.restore();

    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [axisMode, oracleRangePct, snapshots, symbol, verticalPan, viewEnd, windowMs]);

  return <canvas
    ref={canvasRef}
    className={`${styles.depthCanvas} ${dragging ? styles.draggingCanvas : ""}`}
    aria-label={`${symbol} local orderbook liquidity heatmap. Drag horizontally through time and vertically through price.`}
    onPointerDown={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      dragRef.current = { x: event.clientX, y: event.clientY, end: viewEnd, verticalPan, width: rect.width, height: rect.height };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const drag = dragRef.current;
      if (!drag) return;
      const timeDelta = ((event.clientX - drag.x) / Math.max(1, drag.width)) * windowMs;
      const priceDelta = ((event.clientY - drag.y) / Math.max(1, drag.height)) * 2;
      onViewEndChange(Math.max(minViewEnd, Math.min(maxViewEnd, drag.end - timeDelta)));
      onVerticalPanChange(Math.max(-8, Math.min(8, drag.verticalPan + priceDelta)));
    }}
    onPointerUp={(event) => {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      setDragging(false);
    }}
    onPointerCancel={() => {
      dragRef.current = null;
      setDragging(false);
    }}
    onDoubleClick={() => { onViewEndChange(maxViewEnd); onVerticalPanChange(0); }}
  />;
}

export default function ParaDepthHeatmap() {
  const databaseRef = useRef<IDBDatabase | null>(null);
  const requestRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [snapshots, setSnapshots] = useState<StoredSnapshot[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState(SYMBOLS[0].api);
  const [windowMs, setWindowMs] = useState<number>(WINDOWS[1].ms);
  const [axisMode, setAxisMode] = useState<AxisMode>("auto");
  const [oracleRangePct, setOracleRangePct] = useState(.5);
  const [verticalPan, setVerticalPan] = useState(0);
  const [status, setStatus] = useState<RecorderStatus>("starting");
  const [lastCapture, setLastCapture] = useState<number | null>(null);
  const [viewEnd, setViewEnd] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyMessage, setHistoryMessage] = useState("");
  const [loadingServerHistory, setLoadingServerHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!("indexedDB" in window)) {
      const frame = window.requestAnimationFrame(() => setStatus("local-storage-unavailable"));
      return () => window.cancelAnimationFrame(frame);
    }
    void openDatabase().then(async (database) => {
      if (cancelled) return database.close();
      databaseRef.current = database;
      const saved = await readAll(database);
      if (!cancelled) setSnapshots(saved.filter((snapshot) => snapshot.t >= Date.now() - RETENTION_MS).sort((a, b) => a.t - b.t));
    }).catch(() => {
      if (!cancelled) setStatus("local-storage-unavailable");
    });
    return () => {
      cancelled = true;
      databaseRef.current?.close();
      databaseRef.current = null;
    };
  }, []);

  const capture = useCallback(async () => {
    if (requestRef.current) return;
    requestRef.current = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch("/api/oracle-monitor/orderbook", { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as { books?: ApiBook[]; error?: string };
      if (!response.ok || !payload.books?.length) throw new Error(payload.error || "Orderbook snapshot unavailable.");
      const next = payload.books.map<StoredSnapshot>((book) => ({
        id: `${book.apiSymbol}:${Math.floor(book.time / CAPTURE_MS)}`,
        apiSymbol: book.apiSymbol,
        symbol: book.symbol,
        t: book.time,
        oracle: book.oracle,
        mark: book.mark,
        levels: book.levels.map((level) => [level.price, level.size, level.side === "bid" ? 0 : 1]),
      }));
      if (databaseRef.current) await persistSnapshots(databaseRef.current, next);
      const cutoff = Date.now() - RETENTION_MS;
      setSnapshots((current) => {
        const byId = new Map(current.filter((snapshot) => snapshot.t >= cutoff).map((snapshot) => [snapshot.id, snapshot]));
        next.forEach((snapshot) => byId.set(snapshot.id, snapshot));
        return [...byId.values()].sort((a, b) => a.t - b.t);
      });
      setLastCapture(Math.max(...next.map((snapshot) => snapshot.t)));
      setStatus(databaseRef.current ? "recording" : "local-storage-unavailable");
    } catch {
      setStatus("retrying");
    } finally {
      window.clearTimeout(timeout);
      requestRef.current = false;
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void capture());
    const timer = window.setInterval(capture, CAPTURE_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, [capture]);

  const symbolSnapshots = useMemo(() => snapshots.filter((snapshot) => snapshot.apiSymbol === selectedSymbol), [selectedSymbol, snapshots]);
  const latestTime = symbolSnapshots.at(-1)?.t ?? lastCapture ?? 0;
  const earliestTime = symbolSnapshots[0]?.t ?? latestTime;
  const minViewEnd = Math.min(latestTime, earliestTime + windowMs);
  const resolvedViewEnd = viewEnd === null ? latestTime : Math.max(minViewEnd, Math.min(latestTime, viewEnd));
  const selectedSnapshots = useMemo(() => symbolSnapshots.filter((snapshot) => (
    snapshot.t >= resolvedViewEnd - windowMs && snapshot.t <= resolvedViewEnd
  )), [resolvedViewEnd, symbolSnapshots, windowMs]);
  const latest = selectedSnapshots.at(-1);
  const bestBid = latest?.levels.filter((level) => level[2] === 0).reduce<number | null>((best, level) => best === null || level[0] > best ? level[0] : best, null) ?? null;
  const bestAsk = latest?.levels.filter((level) => level[2] === 1).reduce<number | null>((best, level) => best === null || level[0] < best ? level[0] : best, null) ?? null;
  const visibleDepth = latest?.levels.reduce((total, level) => total + level[0] * level[1], 0) ?? 0;
  const spreadBps = bestBid && bestAsk ? ((bestAsk / bestBid) - 1) * 10_000 : null;
  const statusCopy = status === "recording" ? "Local recorder live"
    : status === "retrying" ? "Feed retrying"
      : status === "local-storage-unavailable" ? "Session-only recording"
        : "Starting recorder";

  const updateViewEnd = useCallback((value: number) => {
    setViewEnd(value >= latestTime - CAPTURE_MS ? null : value);
  }, [latestTime]);

  const mergeHistory = useCallback((incoming: StoredSnapshot[]) => {
    setSnapshots((current) => {
      const byId = new Map(current.map((snapshot) => [snapshot.id, snapshot]));
      incoming.forEach((snapshot) => byId.set(snapshot.id, snapshot));
      return [...byId.values()].sort((a, b) => a.t - b.t);
    });
  }, []);

  const loadServerHistory = useCallback(async () => {
    if (!latestTime || loadingServerHistory) return;
    setLoadingServerHistory(true);
    setHistoryMessage("");
    try {
      const end = viewEnd ?? latestTime;
      const response = await fetch(`/api/oracle-monitor/orderbook-history?symbol=${encodeURIComponent(selectedSymbol)}&start=${Math.max(0, end - windowMs)}&end=${end}`, { cache: "no-store" });
      const payload = await response.json() as { snapshots?: unknown[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Server archive unavailable.");
      const imported = (payload.snapshots ?? []).flatMap((snapshot) => {
        const normalized = normalizeSnapshot(snapshot);
        return normalized ? [normalized] : [];
      });
      mergeHistory(imported);
      setHistoryMessage(imported.length ? `Loaded ${imported.length.toLocaleString()} Render archive samples.` : "No Render archive samples exist for this window yet.");
    } catch (error) {
      setHistoryMessage(error instanceof Error ? error.message : "Server archive unavailable.");
    } finally {
      setLoadingServerHistory(false);
    }
  }, [latestTime, loadingServerHistory, mergeHistory, selectedSymbol, viewEnd, windowMs]);

  const importHistoryFile = useCallback(async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setHistoryMessage("File is larger than the 60 MB import limit.");
      return;
    }
    try {
      const text = await file.text();
      let raw: unknown[];
      try {
        const parsed = JSON.parse(text) as unknown;
        raw = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "snapshots" in parsed
          ? ((parsed as { snapshots?: unknown[] }).snapshots ?? [])
          : [parsed];
      } catch {
        raw = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
      }
      const imported = raw.slice(0, 150_000).flatMap((snapshot) => {
        const normalized = normalizeSnapshot(snapshot);
        return normalized ? [normalized] : [];
      });
      if (!imported.length) throw new Error("No valid Para orderbook snapshots were found in this file.");
      mergeHistory(imported);
      setViewEnd(imported.at(-1)?.t ?? null);
      setHistoryMessage(`Loaded ${imported.length.toLocaleString()} samples from ${file.name}.`);
    } catch (error) {
      setHistoryMessage(error instanceof Error ? error.message : "History file could not be read.");
    }
  }, [mergeHistory]);

  const exportHistoryFile = useCallback(() => {
    if (!snapshots.length) {
      setHistoryMessage("There are no loaded samples to export yet.");
      return;
    }
    const payload = JSON.stringify({ format: "para-depth-v1", exportedAt: new Date().toISOString(), snapshots });
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `para-orderbooks-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setHistoryMessage(`Exported ${snapshots.length.toLocaleString()} loaded samples.`);
  }, [snapshots]);

  return (
    <section className={styles.depthPanel}>
      <div className={styles.depthHeader}>
        <div>
          <p className={styles.eyebrow}>LOCAL PARA ORDERBOOK RECORDER</p>
          <h2>Liquidity heatmap</h2>
          <p>Top 20 bid and ask levels captured every 10 seconds. The browser keeps a 24-hour local cache; the Render archive records independently.</p>
        </div>
        <div className={styles.depthHeaderActions}>
          <button className={styles.historyToggle} onClick={() => setHistoryOpen((open) => !open)}>{historyOpen ? "Close history data" : "Read history data"}</button>
          <div className={`${styles.recorderStatus} ${status === "recording" ? styles.recorderLive : ""}`}>
            <i />
            <span><strong>{statusCopy}</strong><small>{lastCapture ? `${formatTime(lastCapture)} HKT` : "Waiting for first snapshot"}</small></span>
          </div>
        </div>
      </div>

      <div className={styles.depthToolbar}>
        <div className={styles.depthTabs} aria-label="Para contract">
          {SYMBOLS.map((symbol) => <button key={symbol.api} className={selectedSymbol === symbol.api ? styles.activeDepthTab : ""} onClick={() => { setSelectedSymbol(symbol.api); setViewEnd(null); setVerticalPan(0); }}>{symbol.label}</button>)}
        </div>
        <div className={styles.depthTools}>
          <div className={styles.depthWindows} aria-label="Heatmap time window">
            {WINDOWS.map((window) => <button key={window.label} className={windowMs === window.ms ? styles.activeDepthWindow : ""} onClick={() => { setWindowMs(window.ms); setViewEnd(null); }}>{window.label}</button>)}
          </div>
          <div className={styles.depthAxis}>
            <label>Y axis<select value={axisMode} onChange={(event) => setAxisMode(event.target.value as AxisMode)}><option value="auto">Auto depth</option><option value="oracle">Oracle range</option></select></label>
            <label className={axisMode === "auto" ? styles.disabledAxis : ""}>Range<div><span>±</span><input aria-label="Vertical axis range around oracle in percent" type="number" min="0.01" max="20" step="0.05" disabled={axisMode === "auto"} value={oracleRangePct} onChange={(event) => setOracleRangePct(Math.max(.01, Math.min(20, Number(event.target.value) || .01)))} /><span>%</span></div></label>
            <button className={styles.resetAxis} disabled={verticalPan === 0} onClick={() => setVerticalPan(0)}>Reset Y</button>
          </div>
        </div>
      </div>

      <div className={styles.depthMetrics}>
        <div><span>Best bid</span><strong>{formatPrice(bestBid)}</strong></div>
        <div><span>Best ask</span><strong>{formatPrice(bestAsk)}</strong></div>
        <div><span>Spread</span><strong>{spreadBps == null ? "—" : `${spreadBps.toFixed(2)} bps`}</strong></div>
        <div><span>Visible L2 depth</span><strong>{visibleDepth ? formatUsd(visibleDepth) : "—"}</strong></div>
        <div><span>Local samples</span><strong>{selectedSnapshots.length.toLocaleString()}</strong></div>
      </div>

      <div className={styles.depthLegend} aria-label="Heatmap legend">
        <span><i className={styles.bidLegend} />Bid liquidity</span>
        <span><i className={styles.askLegend} />Ask liquidity</span>
        <span><i className={styles.oracleLegend} />Oracle price</span>
        <small>Drag left/right through time · drag up/down through price · double-click to reset</small>
      </div>
      <div className={styles.depthCanvasWrap}>
        <DepthCanvas snapshots={selectedSnapshots} windowMs={windowMs} symbol={SYMBOLS.find((symbol) => symbol.api === selectedSymbol)?.label ?? selectedSymbol} axisMode={axisMode} oracleRangePct={oracleRangePct} verticalPan={verticalPan} viewEnd={resolvedViewEnd} minViewEnd={minViewEnd} maxViewEnd={latestTime} onViewEndChange={updateViewEnd} onVerticalPanChange={setVerticalPan} />
      </div>
      <div className={styles.timeNavigator}>
        <div><span>{resolvedViewEnd ? `${formatDateTime(resolvedViewEnd - windowMs)} — ${formatDateTime(resolvedViewEnd)} HKT` : "Waiting for history"}</span><button className={viewEnd === null ? styles.liveTime : ""} onClick={() => setViewEnd(null)}>● Live</button></div>
        <input aria-label="Heatmap history position" type="range" min={minViewEnd} max={Math.max(minViewEnd, latestTime)} step={CAPTURE_MS} value={resolvedViewEnd} disabled={!latestTime || latestTime <= minViewEnd} onChange={(event) => updateViewEnd(Number(event.target.value))} />
      </div>

      {historyOpen && <div className={styles.historyDataPanel}>
        <div><strong>History data</strong><span>Load the Render recorder or open a local JSON / NDJSON archive. Imported files stay on this device.</span></div>
        <div className={styles.historyDataActions}>
          <button disabled={loadingServerHistory} onClick={() => void loadServerHistory()}>{loadingServerHistory ? "Loading Render…" : "Load Render history"}</button>
          <button onClick={() => fileInputRef.current?.click()}>Open local file</button>
          <button onClick={exportHistoryFile}>Export loaded history</button>
          <input ref={fileInputRef} type="file" hidden accept=".json,.ndjson,application/json" onChange={(event) => { void importHistoryFile(event.target.files?.[0] ?? null); event.target.value = ""; }} />
        </div>
        <small>{historyMessage || "Render history is available from the Render deployment. Local files are parsed in this browser and are not uploaded to a server."}</small>
      </div>}
      <footer className={styles.depthFooter}>
        <span>Brighter cells represent more resting USD notional at that price level.</span>
        <span>{selectedSnapshots.length.toLocaleString()} samples in this view · {viewEnd === null ? "live" : "historical"}</span>
      </footer>
    </section>
  );
}
