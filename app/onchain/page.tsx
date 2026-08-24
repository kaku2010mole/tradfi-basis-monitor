"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type PoolQuote = {
  id: string; label: string; name: string; displayBase: string; displayQuote: string; stockSymbol: string;
  chain: string; chainId: number; protocol: string; poolAddress: string; explorerUrl: string;
  fee: number; feePct: number; feeVerified: boolean; baseSymbol: string; quoteSymbol: string;
  baseAddress: string; quoteAddress: string; spotPrice: number | null; buyPriceBeforeSlippage: number | null;
  sellPriceBeforeSlippage: number | null; baseBalance: number | null; quoteBalance: number | null;
  tvlQuote: number | null; activeLiquidity: string; tick: number; unlocked: boolean;
  blockNumber: string; blockTimestamp: number; timestamp: number;
};
type FutuReference = {
  stockSymbol: string;
  futu: { marketTimestamp: number | null; marketState: string | null; stale: boolean } | null;
  metrics: { stockReferenceHkd: number | null; stockReferenceSource: "close-price" | "auction-price" | "book-mid" | null };
};
type ComparisonPoint = { t: number; pool: number; fair: number };
type Comparison = PoolQuote & { stockHkd: number | null; fairUsd: number | null; basisPct: number | null; referenceSource: FutuReference["metrics"]["stockReferenceSource"]; referenceTime: number | null };

const FUTU_PAIRS = [
  ["HK.01810", "HK1810USDT"],
  ["HK.02097", "TENCENTUSDT"],
  ["HK.01024", "KUAISHOUUSDT"],
  ["HK.00388", "TENCENTUSDT"],
  ["HK.00700", "TENCENTUSDT"],
  ["HK.03690", "MEITUANUSDT"],
  ["HK.09992", "POPMARTUSDT"],
] as const;
const POLL_MS = 3_000;
const HISTORY_MS = 2 * 60 * 60_000;
const STORAGE_KEY = "onchain-hk-basis-history:v2";

const formatPrice = (value: number | null, digits = 5) => value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
const formatCompact = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
const formatPct = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const formatTime = (value: number | null, seconds = true) => value === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined, hour12: false }).format(value);
const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const sourceLabel = (source: Comparison["referenceSource"]) => source === "auction-price" ? "Futu auction / IEP" : source === "book-mid" ? "Futu live midpoint" : source === "close-price" ? "Futu official close" : "Waiting for Futu";

function ComparisonChart({ points, symbol }: { points: ComparisonPoint[]; symbol: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 1100; const height = 330; const left = 72; const right = 28; const top = 26; const bottom = 284;
  const values = points.flatMap((point) => [point.pool, point.fair]);
  const low = values.length ? Math.min(...values) : 0; const high = values.length ? Math.max(...values) : 1;
  const padding = Math.max((high - low) * .15, high * .0005, .001); const min = low - padding; const max = high + padding;
  const x = (index: number) => left + index / Math.max(1, points.length - 1) * (width - left - right);
  const y = (price: number) => top + (max - price) / Math.max(.0000001, max - min) * (bottom - top);
  const path = (key: "pool" | "fair") => points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(" ");
  const selected = hover === null ? null : points[hover];
  if (points.length < 2) return <div className={styles.emptyChart}>Collecting the first synchronized pool and Futu samples…</div>;
  return <div className={styles.chartWrap} onMouseLeave={() => setHover(null)} onMouseMove={(event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const chartX = (event.clientX - rect.left) / Math.max(1, rect.width) * width;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round((chartX - left) / (width - left - right) * (points.length - 1)))));
  }}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${symbol} onchain pool and Futu-implied price history`}>
      {[0, .25, .5, .75, 1].map((ratio) => { const value = max - (max - min) * ratio; const position = top + (bottom - top) * ratio; return <g key={ratio}><line x1={left} x2={width - right} y1={position} y2={position} className={styles.gridLine} /><text x={left - 10} y={position + 4} textAnchor="end" className={styles.axisText}>{formatPrice(value, 4)}</text></g>; })}
      <path d={path("fair")} className={styles.referenceLine} />
      <path d={path("pool")} className={styles.priceLine} />
      <text x={left} y={height - 14} className={styles.axisText}>{formatTime(points[0].t, false)}</text>
      <text x={width - right} y={height - 14} textAnchor="end" className={styles.axisText}>{formatTime(points.at(-1)?.t ?? null, false)}</text>
      {selected && hover !== null && <><line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} className={styles.hoverLine} /><circle cx={x(hover)} cy={y(selected.pool)} r="5" className={styles.hoverDot} /></>}
    </svg>
    {selected && <div className={styles.tooltip} style={{ left: `${Math.max(7, Math.min(76, (hover ?? 0) / Math.max(1, points.length - 1) * 100))}%` }}><strong>{formatPct((selected.pool / selected.fair - 1) * 100)}</strong><span>Pool {formatPrice(selected.pool, 6)}</span><span>Futu-implied {formatPrice(selected.fair, 6)}</span><span>{formatTime(selected.t)} HKT</span></div>}
  </div>;
}

export default function OnchainPoolsPage() {
  const [pools, setPools] = useState<PoolQuote[]>([]);
  const [references, setReferences] = useState<FutuReference[]>([]);
  const [history, setHistory] = useState<Record<string, ComparisonPoint[]>>({});
  const [selectedId, setSelectedId] = useState("xiaox-usdc-005-xlayer");
  const [usdHkd, setUsdHkd] = useState("7.83");
  const [errors, setErrors] = useState<string[]>([]);
  const requestInFlight = useRef(false);

  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, ComparisonPoint[]>; const cutoff = Date.now() - HISTORY_MS; setHistory(Object.fromEntries(Object.entries(saved).map(([id, points]) => [id, points.filter((point) => point.t >= cutoff)]))); } catch { /* Start clean. */ } }, []);

  const loadQuotes = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    const fx = Number(usdHkd);
    try {
      const referenceParams = new URLSearchParams({ usdhkd: String(fx) });
      FUTU_PAIRS.forEach(([stock, perp]) => referenceParams.append("pair", `${stock}|${perp}|1`));
      const [poolResponse, futuResponse] = await Promise.all([
        fetch("/api/onchain-pools/quote?group=hk", { cache: "no-store" }),
        fetch(`/api/hk-auction/quotes?${referenceParams}`, { cache: "no-store" }),
      ]);
      const poolPayload = await poolResponse.json() as { quotes?: PoolQuote[]; errors?: string[]; error?: string };
      const futuPayload = await futuResponse.json() as { quotes?: FutuReference[]; errors?: string[]; error?: string };
      if (!poolResponse.ok || !poolPayload.quotes?.length) throw new Error(poolPayload.error || "X Layer pools unavailable.");
      setPools(poolPayload.quotes);
      setReferences(futuPayload.quotes ?? []);
      setErrors([...(poolPayload.errors ?? []), ...(futuPayload.errors ?? []), ...(!futuResponse.ok && futuPayload.error ? [futuPayload.error] : [])]);
      const futuByStock = new Map((futuPayload.quotes ?? []).map((quote) => [quote.stockSymbol, quote]));
      const cutoff = Date.now() - HISTORY_MS;
      setHistory((current) => {
        const next = { ...current };
        poolPayload.quotes!.forEach((pool) => {
          const reference = futuByStock.get(pool.stockSymbol);
          const stockHkd = reference?.metrics.stockReferenceHkd ?? null;
          if (pool.spotPrice === null || stockHkd === null || !Number.isFinite(fx) || fx <= 0) return;
          const point = { t: Math.max(pool.blockTimestamp, reference?.futu?.marketTimestamp ?? 0), pool: pool.spotPrice, fair: stockHkd / fx };
          const kept = (current[pool.id] ?? []).filter((item) => item.t >= cutoff && item.t !== point.t);
          next[pool.id] = [...kept, point].sort((a, b) => a.t - b.t).slice(-2_400);
        });
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Keep in memory. */ }
        return next;
      });
    } catch (loadError) { setErrors([loadError instanceof Error ? loadError.message : "Feeds reconnecting."]); }
    finally { requestInFlight.current = false; }
  }, [usdHkd]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void loadQuotes()); const timer = window.setInterval(loadQuotes, POLL_MS); return () => { window.cancelAnimationFrame(frame); window.clearInterval(timer); }; }, [loadQuotes]);

  const comparisons = useMemo<Comparison[]>(() => {
    const fx = Number(usdHkd); const byStock = new Map(references.map((reference) => [reference.stockSymbol, reference]));
    return pools.map((pool) => { const reference = byStock.get(pool.stockSymbol); const stockHkd = reference?.metrics.stockReferenceHkd ?? null; const fairUsd = stockHkd !== null && fx > 0 ? stockHkd / fx : null; return { ...pool, stockHkd, fairUsd, basisPct: pool.spotPrice !== null && fairUsd !== null ? (pool.spotPrice / fairUsd - 1) * 100 : null, referenceSource: reference?.metrics.stockReferenceSource ?? null, referenceTime: reference?.futu?.marketTimestamp ?? null }; }).sort((a, b) => b.basisPct === null ? -1 : a.basisPct === null ? 1 : Math.abs(b.basisPct) - Math.abs(a.basisPct));
  }, [pools, references, usdHkd]);
  const selected = comparisons.find((item) => item.id === selectedId) ?? comparisons[0] ?? null;
  const widest = comparisons.find((item) => item.basisPct !== null) ?? null;
  const latestBlockAge = pools.length ? Math.max(0, Date.now() - Math.max(...pools.map((pool) => pool.blockTimestamp))) : null;
  const poolLive = latestBlockAge !== null && latestBlockAge < 30_000;
  const futuLive = references.some((reference) => reference.metrics.stockReferenceHkd !== null);
  const selectedHistory = selected ? history[selected.id] ?? [] : [];
  const selectedRange = selectedHistory.length ? { low: Math.min(...selectedHistory.flatMap((point) => [point.pool, point.fair])), high: Math.max(...selectedHistory.flatMap((point) => [point.pool, point.fair])) } : null;

  return <main className={styles.shell}><div className={styles.frame}>
    <header className={styles.topbar}><div><p className={styles.eyebrow}>X LAYER / HONG KONG RWA BASIS</p><h1>Onchain Pool Monitor</h1><p>Active Hong Kong xStock pools compared with the corresponding Futu share price, normalized through USD/HKD.</p></div><div className={styles.topActions}><span className={poolLive ? styles.live : styles.retrying}><i />X Layer {poolLive ? "live" : "retrying"}</span><span className={futuLive ? styles.live : styles.retrying}><i />Futu {futuLive ? "reference live" : "waiting"}</span><PageSwitcher active="onchain" /></div></header>

    <section className={styles.hero}><div className={styles.poolIdentity}><span>WIDEST ABSOLUTE DEVIATION</span><h2>{widest?.displayBase ?? "HK xSTOCKS"}</h2><p>{widest ? `${widest.name} · ${widest.stockSymbol}` : "Discovering seven verified activity pools"}</p></div><div className={styles.heroPrice}><span>{widest?.basisPct !== null && widest?.basisPct !== undefined && widest.basisPct < 0 ? "DISCOUNT" : "PREMIUM"}</span><strong className={widest?.basisPct !== null && widest?.basisPct !== undefined && widest.basisPct < 0 ? styles.negative : styles.positive}>{formatPct(widest?.basisPct ?? null)}</strong><small>{widest?.basisPct === null || widest === null ? "Waiting for synchronized prices" : widest.basisPct >= 0 ? "Pool rich versus Futu" : "Pool cheap versus Futu"}</small></div><div className={styles.heroChange}><span>LIVE COVERAGE</span><strong>{comparisons.filter((item) => item.basisPct !== null).length} / 7</strong><small>Sorted by |premium / discount|</small></div></section>

    <section className={styles.controlBar}><label><span>USD / HKD</span><input type="number" min="1" max="20" step="0.0001" value={usdHkd} onChange={(event) => setUsdHkd(event.target.value)} /></label><div><strong>REFERENCE RULE</strong><span>Futu auction / live midpoint during market hours · official close outside market hours</span></div><div><strong>REFRESH</strong><span>3 seconds · pool addresses verified from the OKX activity page</span></div></section>
    {errors.length > 0 && <div className={styles.notice}><strong>Partial data</strong><span>{[...new Set(errors)].slice(0, 2).join(" · ")}</span></div>}

    <section className={styles.poolSection}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>ACTIVE HONG KONG POOLS</p><h2>Premium & discount ranking</h2></div><span>Select a row to inspect its synchronized history</span></div><div className={styles.poolTable}><div className={styles.poolTableHead}><span>PAIR / STOCK</span><span>ONCHAIN</span><span>FUTU · HKD</span><span>FAIR · USD</span><span>PREMIUM / DISCOUNT</span><span>REFERENCE</span></div>{comparisons.map((item) => <button key={item.id} className={`${styles.poolRow} ${selected?.id === item.id ? styles.selectedRow : ""}`} onClick={() => setSelectedId(item.id)}><span><b>{item.displayBase}</b><small>{item.name} · {item.stockSymbol}</small></span><span><b>{formatPrice(item.spotPrice, 5)}</b><small>{item.quoteSymbol} · {item.feePct.toFixed(2)}%</small></span><span><b>{formatPrice(item.stockHkd, 3)}</b><small>{sourceLabel(item.referenceSource)}</small></span><span><b>{formatPrice(item.fairUsd, 5)}</b><small>HKD ÷ {formatPrice(Number(usdHkd), 4)}</small></span><span className={item.basisPct === null ? "" : item.basisPct >= 0 ? styles.premiumCell : styles.discountCell}><b>{formatPct(item.basisPct)}</b><small>{item.basisPct === null ? "WAITING" : item.basisPct >= 0 ? "SELL POOL / BUY STOCK" : "BUY POOL / SELL STOCK"}</small></span><span><b>{formatTime(item.referenceTime)}</b><small>{shortAddress(item.poolAddress)}</small></span></button>)}</div></section>

    {selected && <><section className={styles.executionStrip}><div><span>BUY {selected.baseSymbol}</span><strong>{formatPrice(selected.buyPriceBeforeSlippage, 6)}</strong><small>{selected.quoteSymbol} · fee included, before slippage/gas</small></div><div className={styles.spotCell}><span>{selected.basisPct !== null && selected.basisPct < 0 ? "DISCOUNT" : "PREMIUM"} VS FUTU</span><strong className={selected.basisPct !== null && selected.basisPct < 0 ? styles.negative : styles.positive}>{formatPct(selected.basisPct)}</strong><small>{selected.basisPct === null ? "Waiting for both venues" : selected.basisPct >= 0 ? "SELL POOL / BUY FUTU" : "BUY POOL / SELL FUTU"}</small></div><div><span>SELL {selected.baseSymbol}</span><strong>{formatPrice(selected.sellPriceBeforeSlippage, 6)}</strong><small>{selected.quoteSymbol} · fee included, before slippage/gas</small></div></section>
    <section className={styles.metrics}><article><span>POOL TVL · APPROX.</span><strong>${formatCompact(selected.tvlQuote)}</strong><small>Both token balances at pool spot</small></article><article><span>{selected.baseSymbol} IN POOL</span><strong>{formatCompact(selected.baseBalance)}</strong><small>{shortAddress(selected.baseAddress)}</small></article><article><span>FUTU BENCHMARK</span><strong>HK${formatPrice(selected.stockHkd, 3)}</strong><small>{sourceLabel(selected.referenceSource)}</small></article><article><span>BLOCK FRESHNESS</span><strong>{latestBlockAge === null ? "—" : `${Math.round(latestBlockAge / 1000)}s`}</strong><small>Block {Number(selected.blockNumber).toLocaleString()}</small></article></section>
    <section className={styles.chartPanel}><div className={styles.panelHead}><div><p className={styles.eyebrow}>ROLLING LOCAL HISTORY · {selected.displayBase}</p><h2>Pool versus Futu-implied USD</h2></div><div className={styles.chartLegend}><span><i className={styles.poolLegend} />ONCHAIN</span><span><i className={styles.futuLegend} />FUTU-IMPLIED</span></div><div className={styles.rangeStats}><span>LOW <b>{formatPrice(selectedRange?.low ?? null, 5)}</b></span><span>HIGH <b>{formatPrice(selectedRange?.high ?? null, 5)}</b></span></div></div><ComparisonChart points={selectedHistory} symbol={selected.displayBase} /><footer><span>Captured every 3 seconds while this dashboard is open · retained locally for 2 hours</span><span>HKT · hover for exact values</span></footer></section>
    <section className={styles.verificationPanel}><div><span>POOL CONTRACT</span><a href={selected.explorerUrl} target="_blank" rel="noreferrer">{selected.poolAddress} ↗</a></div><div><span>ONCHAIN TOKEN</span><strong>{selected.baseSymbol}</strong><small>The contract symbol may be wrapped even when the activity label omits “w”.</small></div><div><span>FEE CHECK</span><strong>{selected.feePct.toFixed(2)}% {selected.feeVerified ? "VERIFIED" : "MISMATCH"}</strong><small>Read from the pool contract, not trusted from the campaign label.</small></div></section></>}
    <footer className={styles.footer}>Premium / discount uses the marginal pool spot. Real executable size requires a Uniswap V3 quote simulation across initialized ticks, plus gas and stock-side execution costs.</footer>
  </div></main>;
}
