"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./XstockPerpMonitor.module.css";

type PoolQuote = {
  id: string; label: string; name: string; displayBase: string; displayQuote: string;
  perpSymbol: string; poolAddress: string; explorerUrl: string; feePct: number;
  xstockUnitsPerPerp: number;
  spotPrice: number | null; buyPriceBeforeSlippage: number | null; sellPriceBeforeSlippage: number | null;
  tvlQuote: number | null; blockTimestamp: number; unlocked: boolean;
};
type PerpQuote = {
  id: string; apiSymbol: string; bid: number; ask: number; funding: number | null;
  fundingHours: number; quoteVolume24h?: number | null; updatedAt: number;
};
type Row = PoolQuote & {
  perp: PerpQuote | null; longPoolEdge: number | null; shortPoolEdge: number | null;
  bestEdge: number | null; direction: string; filtered: boolean;
};
type TrailPoint = { t: number; edge: number };
type CustomPair = { id: string; name: string; base: string; quote: string; perp: string; address: string; fee: number; ratio: number };

const DEFAULT_MAX_VOLUME_M = 25;
const VOLUME_KEY = "xstock-perp-max-volume-m:v1";
const CUSTOM_KEY = "xstock-perp-custom-pairs:v1";
const POLL_MS = 3_000;
const formatPrice = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const formatPct = (value: number | null, digits = 3) => value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const formatCompact = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
const formatTime = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

function EdgeSparkline({ points }: { points: TrailPoint[] }) {
  if (points.length < 2) return <div className={styles.collecting}>Collecting synchronized edge history…</div>;
  const width = 760; const height = 138; const pad = 13;
  const values = points.map((point) => point.edge); const low = Math.min(0, ...values); const high = Math.max(0, ...values);
  const span = Math.max(.001, high - low); const x = (i: number) => pad + i / Math.max(1, points.length - 1) * (width - pad * 2);
  const y = (v: number) => pad + (high - v) / span * (height - pad * 2);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.edge).toFixed(1)}`).join(" ");
  return <svg className={styles.sparkline} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Indicative xStock perp edge history">
    <line x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} />
    <path d={path} />
  </svg>;
}

export default function XstockPerpMonitor({ compact = false }: { compact?: boolean }) {
  const [pools, setPools] = useState<PoolQuote[]>([]);
  const [perps, setPerps] = useState<PerpQuote[]>([]);
  const [maxVolumeM, setMaxVolumeM] = useState(DEFAULT_MAX_VOLUME_M);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [trails, setTrails] = useState<Record<string, TrailPoint[]>>({});
  const [customPairs, setCustomPairs] = useState<CustomPair[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [formError, setFormError] = useState("");
  const [draft, setDraft] = useState({ name: "", base: "", perp: "", address: "", feePct: "0.05", ratio: "1" });
  const inFlight = useRef(false);

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(VOLUME_KEY));
    if (Number.isFinite(saved) && saved > 0) setMaxVolumeM(saved);
    try { setCustomPairs(JSON.parse(window.localStorage.getItem(CUSTOM_KEY) || "[]") as CustomPair[]); } catch { /* Keep verified defaults. */ }
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const poolResponse = await fetch("/api/onchain-pools/quote?group=hk", { cache: "no-store" });
      const poolPayload = await poolResponse.json() as { quotes?: PoolQuote[]; errors?: string[]; error?: string };
      if (!poolResponse.ok || !poolPayload.quotes?.length) throw new Error(poolPayload.error || "OKX X Layer pool feed unavailable.");
      const customResults = await Promise.all(customPairs.map(async (pair) => {
        const params = new URLSearchParams({ address: pair.address, stock: "HK.00000", base: pair.base, quote: pair.quote, name: pair.name, fee: String(pair.fee), perp: pair.perp, ratio: String(pair.ratio || 1) });
        const response = await fetch(`/api/onchain-pools/quote?${params}`, { cache: "no-store" });
        return response.ok ? await response.json() as PoolQuote : null;
      }));
      const allPools = [...poolPayload.quotes, ...customResults.filter((pool): pool is PoolQuote => pool !== null)];
      const symbols = Array.from(new Set(allPools.map((pool) => pool.perpSymbol).filter(Boolean)));
      const perpResponse = await fetch(`/api/oracle-monitor/quotes?binance=${encodeURIComponent(symbols.join(","))}&para=-`, { cache: "no-store" });
      const perpPayload = await perpResponse.json() as { quotes?: PerpQuote[]; error?: string };
      const nextPerps = perpResponse.ok ? (perpPayload.quotes ?? []) : [];
      setPools(allPools); setPerps(nextPerps); setUpdatedAt(Date.now());
      setError([...(poolPayload.errors ?? []), ...(!perpResponse.ok && perpPayload.error ? [perpPayload.error] : [])].join(" · "));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "xStock–Perp feeds reconnecting.");
    } finally { inFlight.current = false; }
  }, [customPairs]);

  const addPair = (event: React.FormEvent) => {
    event.preventDefault();
    const address = draft.address.trim(); const base = draft.base.trim(); const perp = draft.perp.trim().toUpperCase();
    const fee = Math.round(Number(draft.feePct) * 10_000); const ratio = Number(draft.ratio);
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return setFormError("Enter a valid X Layer Uniswap V3 pool address.");
    if (!/^[A-Za-z0-9._-]{2,24}$/.test(base)) return setFormError("Enter the xStock token symbol.");
    if (!/^[A-Z0-9_]{2,32}$/.test(perp)) return setFormError("Enter a Binance futures symbol such as POPMARTUSDT.");
    if (!Number.isInteger(fee) || fee < 1 || fee > 1_000_000) return setFormError("Enter a valid pool fee.");
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1_000) return setFormError("Enter a valid xStock units per perp ratio.");
    const pair = { id: `custom-${address.toLowerCase()}`, name: draft.name.trim() || base, base, quote: "USD", perp, address, fee, ratio };
    const next = [...customPairs.filter((item) => item.id !== pair.id), pair].slice(-12);
    setCustomPairs(next); window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
    setDraft({ name: "", base: "", perp: "", address: "", feePct: "0.05", ratio: "1" }); setFormError(""); setShowAdd(false);
  };

  useEffect(() => { const frame = requestAnimationFrame(() => void load()); const timer = window.setInterval(load, POLL_MS); return () => { cancelAnimationFrame(frame); clearInterval(timer); }; }, [load]);

  const rows = useMemo<Row[]>(() => {
    const bySymbol = new Map(perps.map((perp) => [perp.apiSymbol, perp]));
    return pools.map((pool) => {
      const perp = bySymbol.get(pool.perpSymbol) ?? null;
      const ratio = pool.xstockUnitsPerPerp || 1;
      const normalizedBid = perp ? perp.bid / ratio : null; const normalizedAsk = perp ? perp.ask / ratio : null;
      const longPoolEdge = pool.buyPriceBeforeSlippage !== null && normalizedBid !== null ? (normalizedBid / pool.buyPriceBeforeSlippage - 1) * 100 : null;
      const shortPoolEdge = pool.sellPriceBeforeSlippage !== null && normalizedAsk !== null ? (pool.sellPriceBeforeSlippage / normalizedAsk - 1) * 100 : null;
      const bestEdge = longPoolEdge === null ? shortPoolEdge : shortPoolEdge === null ? longPoolEdge : Math.max(longPoolEdge, shortPoolEdge);
      const direction = bestEdge === null ? "WAITING FOR BINANCE PERP" : longPoolEdge !== null && longPoolEdge >= (shortPoolEdge ?? -Infinity) ? "LONG xSTOCK · SHORT BINANCE" : "SHORT xSTOCK · LONG BINANCE";
      const filtered = perp?.quoteVolume24h != null && perp.quoteVolume24h > maxVolumeM * 1_000_000;
      return { ...pool, perp, longPoolEdge, shortPoolEdge, bestEdge, direction, filtered };
    }).sort((a, b) => (b.bestEdge ?? -Infinity) - (a.bestEdge ?? -Infinity));
  }, [pools, perps, maxVolumeM]);

  useEffect(() => {
    if (!rows.length) return;
    const t = Date.now();
    setTrails((current) => {
      const next = { ...current };
      rows.forEach((row) => { if (row.bestEdge !== null) next[row.id] = [...(next[row.id] ?? []), { t, edge: row.bestEdge }].slice(-1_200); });
      return next;
    });
    setSelectedId((current) => current || rows[0]?.id || "");
  }, [rows]);

  const visible = rows.filter((row) => !row.filtered);
  const excluded = rows.length - visible.length;
  const selected = rows.find((row) => row.id === selectedId) ?? visible[0] ?? rows[0] ?? null;
  const live = updatedAt > 0 && Date.now() - updatedAt < 12_000;

  return <section className={`${styles.monitor} ${compact ? styles.compact : ""}`}>
    <header className={styles.header}>
      <div><p>OKX X LAYER · BINANCE FUTURES</p><h2>xStock ↔ Perp</h2><span>Fee-adjusted pool quotes versus executable Binance best bid / ask.</span></div>
      <div className={styles.headerActions}><span className={live ? styles.live : styles.offline}><i />{live ? `LIVE · ${formatTime(updatedAt)}` : "RECONNECTING"}</span>{compact && <Link href="/onchain">Open full monitor →</Link>}</div>
    </header>
    <div className={styles.controls}>
      <label>MAX BINANCE 24H VOLUME<div><input type="number" min="0.1" step="1" value={maxVolumeM} onChange={(event) => { const value = Math.max(.1, Number(event.target.value) || DEFAULT_MAX_VOLUME_M); setMaxVolumeM(value); window.localStorage.setItem(VOLUME_KEY, String(value)); }} /><span>M USDT</span></div></label>
      <div><strong>{visible.length}</strong><span>visible matches</span></div><div><strong>{excluded}</strong><span>high-volume excluded</span></div><div><strong>{rows.filter((row) => row.bestEdge !== null && row.bestEdge > 0 && !row.filtered).length}</strong><span>positive indicative edges</span></div>
    </div>
    {!compact && <><button className={styles.addToggle} onClick={() => setShowAdd((value) => !value)}>{showAdd ? "Close pair form" : "+ Add xStock pair"}</button>{showAdd && <form className={styles.addForm} onSubmit={addPair}>
      <label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Company" /></label>
      <label>xStock symbol<input value={draft.base} onChange={(event) => setDraft({ ...draft, base: event.target.value })} placeholder="TOKENx" /></label>
      <label>Binance perp<input value={draft.perp} onChange={(event) => setDraft({ ...draft, perp: event.target.value })} placeholder="TOKENUSDT" /></label>
      <label>Pool address<input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="0x…" /></label>
      <label>Fee %<input type="number" min="0.0001" step="0.01" value={draft.feePct} onChange={(event) => setDraft({ ...draft, feePct: event.target.value })} /></label>
      <label>xStock / perp<input type="number" min="0.000001" step="0.01" value={draft.ratio} onChange={(event) => setDraft({ ...draft, ratio: event.target.value })} /></label>
      <button type="submit">Add pair</button>{formError && <p>{formError}</p>}
    </form>}</>}
    {error && <p className={styles.notice}>{error}</p>}
    <div className={styles.grid}>
      {visible.map((row) => <button key={row.id} className={`${styles.card} ${selected?.id === row.id ? styles.selected : ""}`} onClick={() => setSelectedId(row.id)}>
        <div className={styles.cardTop}><div><small>{row.label} · {row.feePct.toFixed(2)}% fee · {row.xstockUnitsPerPerp}:1 units</small><strong>{row.displayBase} <b>↔</b> {row.perpSymbol}</strong></div><span>{row.perp ? "MATCHED" : "NO LISTING"}</span></div>
        <div className={styles.edge}><small>BEST INDICATIVE EDGE</small><strong className={(row.bestEdge ?? 0) > 0 ? styles.positive : styles.muted}>{formatPct(row.bestEdge)}</strong><span>{row.direction}</span></div>
        <div className={styles.prices}><span><small>BUY xSTOCK</small><b>{formatPrice(row.buyPriceBeforeSlippage)}</b></span><span><small>BINANCE BBO / xSTOCK</small><b>{row.perp ? `${formatPrice(row.perp.bid / row.xstockUnitsPerPerp)} / ${formatPrice(row.perp.ask / row.xstockUnitsPerPerp)}` : "—"}</b></span><span><small>SELL xSTOCK</small><b>{formatPrice(row.sellPriceBeforeSlippage)}</b></span></div>
        <footer><span>Funding {row.perp?.funding == null ? "—" : formatPct(row.perp.funding * 100, 4)} / {row.perp?.fundingHours ?? 8}h</span><span>24h vol {formatCompact(row.perp?.quoteVolume24h)} USDT</span></footer>
      </button>)}
    </div>
    {!compact && selected && <div className={styles.detail}>
      <div><small>SELECTED ROUTE</small><strong>{selected.direction}</strong><span>{selected.bestEdge !== null && selected.bestEdge > 0 ? "Positive before slippage, gas and position funding." : "No positive fee-adjusted crossing at the current top of book."}</span></div>
      <EdgeSparkline points={trails[selected.id] ?? []} />
      <a href={selected.explorerUrl} target="_blank" rel="noreferrer">Verify pool {selected.poolAddress.slice(0, 8)}…{selected.poolAddress.slice(-6)} ↗</a>
    </div>}
    <footer className={styles.disclaimer}>Indicative only: pool prices include the configured fee but exclude size-dependent slippage and gas. A positive number is not guaranteed profit. SHEIN remains visible without a synthetic price until Binance publishes a matching futures contract.</footer>
  </section>;
}
