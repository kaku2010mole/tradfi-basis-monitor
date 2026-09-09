"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./XstockPerpMonitor.module.css";

type ScannerRow = {
  id: string; okxSymbol: string; perpSymbol: string; ratio: number; priority: boolean;
  spotBid: number | null; spotAsk: number | null; spotBidQty: number | null; spotAskQty: number | null;
  okxVolume24h: number | null; okxUpdatedAt: number | null;
  perpBid: number | null; perpAsk: number | null; perpBidQty: number | null; perpAskQty: number | null;
  binanceVolume24h: number | null; funding: number | null; fundingHours: number;
  bestEdge: number | null; longSpotEdge: number | null; shortSpotEdge: number | null; direction: string;
};
type CustomPair = { okx: string; perp: string; ratio: number };
type TrailPoint = { t: number; edge: number };

const POLL_MS = 3_000;
const VOLUME_KEY = "xstock-perp-max-volume-m:v2";
const CUSTOM_KEY = "xstock-perp-custom-pairs:v2";
const formatPrice = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const formatPct = (value: number | null, digits = 3) => value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const compactNumber = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
const formatTime = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

function EdgeChart({ points }: { points: TrailPoint[] }) {
  if (points.length < 2) return <div className={styles.collecting}>Collecting synchronized OKX / Binance samples…</div>;
  const width = 760; const height = 138; const pad = 13; const values = points.map((point) => point.edge);
  const low = Math.min(0, ...values); const high = Math.max(0, ...values); const span = Math.max(.001, high - low);
  const x = (index: number) => pad + index / Math.max(1, points.length - 1) * (width - 2 * pad);
  const y = (value: number) => pad + (high - value) / span * (height - 2 * pad);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.edge).toFixed(1)}`).join(" ");
  return <svg className={styles.sparkline} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="OKX spot versus Binance perpetual edge history"><line x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} /><path d={path} /></svg>;
}

export default function XstockPerpMonitor({ compact = false }: { compact?: boolean }) {
  const [rows, setRows] = useState<ScannerRow[]>([]);
  const [scanned, setScanned] = useState(0);
  const [maxVolumeM, setMaxVolumeM] = useState(25);
  const [customPairs, setCustomPairs] = useState<CustomPair[]>([]);
  const [draft, setDraft] = useState({ okx: "", perp: "", ratio: "1" });
  const [showAdd, setShowAdd] = useState(false); const [formError, setFormError] = useState("");
  const [selectedId, setSelectedId] = useState(""); const [trails, setTrails] = useState<Record<string, TrailPoint[]>>({});
  const [updatedAt, setUpdatedAt] = useState(0); const [error, setError] = useState(""); const inFlight = useRef(false);

  useEffect(() => {
    const volume = Number(localStorage.getItem(VOLUME_KEY)); if (Number.isFinite(volume) && volume > 0) setMaxVolumeM(volume);
    try { setCustomPairs(JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]") as CustomPair[]); } catch { /* Keep auto-discovery only. */ }
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return; inFlight.current = true;
    try {
      const params = new URLSearchParams();
      if (customPairs.length) params.set("pairs", customPairs.map((pair) => `${pair.okx}|${pair.perp}|${pair.ratio}`).join(","));
      const response = await fetch(`/api/xstock-perp?${params}`, { cache: "no-store" });
      const payload = await response.json() as { rows?: ScannerRow[]; scanned?: number; timestamp?: number; error?: string };
      if (!response.ok || !payload.rows) throw new Error(payload.error || "OKX spot / Binance scanner unavailable.");
      setRows(payload.rows); setScanned(payload.scanned ?? 0); setUpdatedAt(payload.timestamp ?? Date.now()); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Feeds reconnecting."); }
    finally { inFlight.current = false; }
  }, [customPairs]);

  useEffect(() => { const frame = requestAnimationFrame(() => void load()); const timer = window.setInterval(load, POLL_MS); return () => { cancelAnimationFrame(frame); clearInterval(timer); }; }, [load]);

  const visible = useMemo(() => rows.filter((row) => row.priority || row.binanceVolume24h === null || row.binanceVolume24h <= maxVolumeM * 1_000_000).slice(0, compact ? 6 : 48), [rows, maxVolumeM, compact]);
  const excluded = rows.filter((row) => !row.priority && row.binanceVolume24h !== null && row.binanceVolume24h > maxVolumeM * 1_000_000).length;
  const selected = rows.find((row) => row.id === selectedId) ?? visible[0] ?? null;

  useEffect(() => {
    const now = Date.now();
    setTrails((current) => { const next = { ...current }; rows.forEach((row) => { if (row.bestEdge !== null) next[row.id] = [...(next[row.id] ?? []), { t: now, edge: row.bestEdge }].slice(-1_200); }); return next; });
    if (!selectedId && rows[0]) setSelectedId(rows[0].id);
  }, [rows, selectedId]);

  const addPair = (event: React.FormEvent) => {
    event.preventDefault(); const okx = draft.okx.trim().toUpperCase(); const perp = draft.perp.trim().toUpperCase(); const ratio = Number(draft.ratio);
    if (!/^[A-Z0-9]+-USDT$/.test(okx)) return setFormError("Use an OKX instrument ID such as XSHEIN-USDT.");
    if (!/^[A-Z0-9_]{2,32}$/.test(perp)) return setFormError("Use a Binance futures symbol such as POPMARTUSDT.");
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1_000) return setFormError("Enter a valid OKX spot units per Binance contract ratio.");
    const next = [...customPairs.filter((pair) => pair.okx !== okx), { okx, perp, ratio }].slice(-12);
    setCustomPairs(next); localStorage.setItem(CUSTOM_KEY, JSON.stringify(next)); setDraft({ okx: "", perp: "", ratio: "1" }); setFormError(""); setShowAdd(false);
  };

  return <section className={`${styles.monitor} ${compact ? styles.compact : ""}`}>
    <header className={styles.header}><div><p>OKX SPOT · BINANCE FUTURES</p><h2>xStock ↔ Perp</h2><span>Exchange order book versus exchange order book — no AMM, pool or onchain price.</span></div><div className={styles.headerActions}><span className={updatedAt && Date.now() - updatedAt < 12_000 ? styles.live : styles.offline}><i />{updatedAt ? `LIVE · ${formatTime(updatedAt)}` : "CONNECTING"}</span>{compact && <Link href="/onchain">Open full monitor →</Link>}</div></header>
    <div className={styles.controls}>
      <label>MAX BINANCE 24H VOLUME<div><input type="number" min="0.1" step="1" value={maxVolumeM} onChange={(event) => { const value = Math.max(.1, Number(event.target.value) || 25); setMaxVolumeM(value); localStorage.setItem(VOLUME_KEY, String(value)); }} /><span>M USDT</span></div></label>
      <div><strong>{scanned}</strong><span>OKX stock spots scanned</span></div><div><strong>{visible.length}</strong><span>matched and visible</span></div><div><strong>{excluded}</strong><span>high-volume excluded</span></div>
    </div>
    {!compact && <><button className={styles.addToggle} onClick={() => setShowAdd((value) => !value)}>{showAdd ? "Close pair form" : "+ Add exchange pair"}</button>{showAdd && <form className={styles.addForm} onSubmit={addPair}>
      <label>OKX spot instrument<input value={draft.okx} onChange={(event) => setDraft({ ...draft, okx: event.target.value })} placeholder="XSHEIN-USDT" /></label>
      <label>Binance perp<input value={draft.perp} onChange={(event) => setDraft({ ...draft, perp: event.target.value })} placeholder="SHEINUSDT" /></label>
      <label>Spot units / perp<input type="number" min="0.000001" step="0.01" value={draft.ratio} onChange={(event) => setDraft({ ...draft, ratio: event.target.value })} /></label>
      <button type="submit">Add pair</button>{formError && <p>{formError}</p>}
    </form>}</>}
    {error && <p className={styles.notice}>{error}</p>}
    <div className={styles.grid}>{visible.map((row) => <button key={row.id} className={`${styles.card} ${selected?.id === row.id ? styles.selected : ""}`} onClick={() => setSelectedId(row.id)}>
      <div className={styles.cardTop}><div><small>{row.okxSymbol} · {row.ratio}:1 units</small><strong>{row.okxSymbol.replace(/-USDT$/, "")} <b>↔</b> {row.perpSymbol}</strong></div><span>{row.bestEdge === null ? "UNMATCHED" : "MATCHED"}</span></div>
      <div className={styles.edge}><small>RAW EXECUTABLE EDGE</small><strong className={(row.bestEdge ?? 0) > 0 ? styles.positive : styles.muted}>{formatPct(row.bestEdge)}</strong><span>{row.direction}</span></div>
      <div className={styles.prices}><span><small>OKX BID / ASK</small><b>{formatPrice(row.spotBid)} / {formatPrice(row.spotAsk)}</b></span><span><small>BINANCE BBO / SPOT UNIT</small><b>{formatPrice(row.perpBid)} / {formatPrice(row.perpAsk)}</b></span><span><small>OKX 24H VOLUME</small><b>{compactNumber(row.okxVolume24h)} USDT</b></span></div>
      <footer><span>Funding {row.funding === null ? "—" : formatPct(row.funding * 100, 4)} / {row.fundingHours}h</span><span>Binance vol {compactNumber(row.binanceVolume24h)} USDT</span></footer>
    </button>)}</div>
    {!compact && selected && <div className={styles.detail}><div><small>SELECTED ROUTE</small><strong>{selected.direction}</strong><span>{selected.bestEdge === null ? "No matching Binance contract is currently published." : "Raw BBO crossing before account-specific fees. Shorting OKX spot requires margin inventory or borrow availability."}</span></div><EdgeChart points={trails[selected.id] ?? []} /></div>}
    <footer className={styles.disclaimer}>Prices are normalized into one OKX share-equivalent unit. Raw edge excludes exchange fees, borrow cost and execution latency. Priority rows remain visible even when unmatched; XSHEIN currently has no matching Binance futures quote and is never replaced with a synthetic price.</footer>
  </section>;
}
