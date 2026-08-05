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
] as const;
const DB_NAME = "oracle-monitor-para-depth-v1";
const STORE_NAME = "snapshots";
const RETENTION_MS = 6 * 60 * 60_000;
const CAPTURE_MS = 10_000;

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

function DepthCanvas({ snapshots, windowMs, symbol }: { snapshots: StoredSnapshot[]; windowMs: number; symbol: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
      const end = Date.now();
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

      let priceMin = Math.min(...prices);
      let priceMax = Math.max(...prices);
      const padding = Math.max((priceMax - priceMin) * .06, Math.abs(priceMax) * .0001, .000001);
      priceMin -= padding;
      priceMax += padding;
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

      context.strokeStyle = "#54a6ff";
      context.lineWidth = 1.6;
      context.beginPath();
      let started = false;
      snapshots.forEach((snapshot) => {
        if (!snapshot.oracle) return;
        if (!started) context.moveTo(x(snapshot.t), y(snapshot.oracle));
        else context.lineTo(x(snapshot.t), y(snapshot.oracle));
        started = true;
      });
      context.stroke();

      context.font = "10px system-ui, sans-serif";
      context.textAlign = "left";
      context.fillStyle = "#17dcaf";
      context.fillText("BID LIQUIDITY", margin.left + 8, margin.top + 12);
      context.fillStyle = "#ff6b4c";
      context.fillText("ASK LIQUIDITY", margin.left + 98, margin.top + 12);
      context.fillStyle = "#54a6ff";
      context.fillText("ORACLE", margin.left + 192, margin.top + 12);
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [snapshots, symbol, windowMs]);

  return <canvas ref={canvasRef} className={styles.depthCanvas} aria-label={`${symbol} local orderbook liquidity heatmap`} />;
}

export default function ParaDepthHeatmap() {
  const databaseRef = useRef<IDBDatabase | null>(null);
  const requestRef = useRef(false);
  const [snapshots, setSnapshots] = useState<StoredSnapshot[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState(SYMBOLS[0].api);
  const [windowMs, setWindowMs] = useState<number>(WINDOWS[1].ms);
  const [status, setStatus] = useState<RecorderStatus>("starting");
  const [lastCapture, setLastCapture] = useState<number | null>(null);

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

  const selectedSnapshots = useMemo(() => {
    const cutoff = (lastCapture ?? snapshots.at(-1)?.t ?? 0) - windowMs;
    return snapshots.filter((snapshot) => snapshot.apiSymbol === selectedSymbol && snapshot.t >= cutoff);
  }, [lastCapture, selectedSymbol, snapshots, windowMs]);
  const latest = selectedSnapshots.at(-1);
  const bestBid = latest?.levels.filter((level) => level[2] === 0).reduce<number | null>((best, level) => best === null || level[0] > best ? level[0] : best, null) ?? null;
  const bestAsk = latest?.levels.filter((level) => level[2] === 1).reduce<number | null>((best, level) => best === null || level[0] < best ? level[0] : best, null) ?? null;
  const visibleDepth = latest?.levels.reduce((total, level) => total + level[0] * level[1], 0) ?? 0;
  const spreadBps = bestBid && bestAsk ? ((bestAsk / bestBid) - 1) * 10_000 : null;
  const statusCopy = status === "recording" ? "Local recorder live"
    : status === "retrying" ? "Feed retrying"
      : status === "local-storage-unavailable" ? "Session-only recording"
        : "Starting recorder";

  return (
    <section className={styles.depthPanel}>
      <div className={styles.depthHeader}>
        <div>
          <p className={styles.eyebrow}>LOCAL PARA ORDERBOOK RECORDER</p>
          <h2>Liquidity heatmap</h2>
          <p>Top 20 bid and ask levels captured every 10 seconds. Stored only in this browser for 6 hours while this page is open.</p>
        </div>
        <div className={`${styles.recorderStatus} ${status === "recording" ? styles.recorderLive : ""}`}>
          <i />
          <span><strong>{statusCopy}</strong><small>{lastCapture ? `${formatTime(lastCapture)} HKT` : "Waiting for first snapshot"}</small></span>
        </div>
      </div>

      <div className={styles.depthToolbar}>
        <div className={styles.depthTabs} aria-label="Para contract">
          {SYMBOLS.map((symbol) => <button key={symbol.api} className={selectedSymbol === symbol.api ? styles.activeDepthTab : ""} onClick={() => setSelectedSymbol(symbol.api)}>{symbol.label}</button>)}
        </div>
        <div className={styles.depthWindows} aria-label="Heatmap time window">
          {WINDOWS.map((window) => <button key={window.label} className={windowMs === window.ms ? styles.activeDepthWindow : ""} onClick={() => setWindowMs(window.ms)}>{window.label}</button>)}
        </div>
      </div>

      <div className={styles.depthMetrics}>
        <div><span>Best bid</span><strong>{formatPrice(bestBid)}</strong></div>
        <div><span>Best ask</span><strong>{formatPrice(bestAsk)}</strong></div>
        <div><span>Spread</span><strong>{spreadBps == null ? "—" : `${spreadBps.toFixed(2)} bps`}</strong></div>
        <div><span>Visible L2 depth</span><strong>{visibleDepth ? formatUsd(visibleDepth) : "—"}</strong></div>
        <div><span>Local samples</span><strong>{selectedSnapshots.length.toLocaleString()}</strong></div>
      </div>

      <div className={styles.depthCanvasWrap}>
        <DepthCanvas snapshots={selectedSnapshots} windowMs={windowMs} symbol={SYMBOLS.find((symbol) => symbol.api === selectedSymbol)?.label ?? selectedSymbol} />
      </div>
      <footer className={styles.depthFooter}>
        <span>Brighter cells represent more resting USD notional at that price level.</span>
        <span>Data stays on this device and is not uploaded.</span>
      </footer>
    </section>
  );
}
