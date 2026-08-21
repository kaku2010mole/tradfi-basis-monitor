"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type PairConfig = { stockSymbol: string; perpSymbol: string; sharesPerContract: number; adrSymbol?: string; hkSharesPerAdr?: number };
type Book = { bid: number; ask: number; bidSize: number | null; askSize: number | null; marketTimestamp: number; stale: boolean | null };
type FutuBook = Omit<Book, "marketTimestamp"> & {
  name: string | null;
  auctionPrice: number | null;
  marketState: string | null;
  marketTimestamp: number | null;
};
type Direction = { basisPct: number | null; capacityContracts: number | null; capacityUsdt: number | null };
type Quote = PairConfig & {
  id: string;
  futu: FutuBook | null;
  binance: (Book & { mid: number; fundingRate: number | null; nextFundingTime: number | null }) | null;
  metrics: {
    stockReferenceHkd: number | null;
    stockReferenceSource: "auction-price" | "book-mid" | "close-price" | null;
    fairUsdt: number | null;
    binanceMid: number | null;
    midBasisPct: number | null;
    depthUsdt: { stockBid: number | null; stockAsk: number | null; binanceBid: number | null; binanceAsk: number | null };
    sellPerpBuyStock: Direction;
    buyPerpSellStock: Direction;
  };
  status: "live" | "stale" | "partial";
};
type Payload = { quotes: Quote[]; usdHkd: number; timestamp: number; sources: { futu: boolean; binance: boolean }; errors: string[] };
type HistoryPoint = { t: number; value: number; stockCloseHkd?: number; perpClose?: number };
type AdrBook = { symbol: string; streamKey: string; bid: number | null; ask: number | null; last: number | null; bidSize: number | null; askSize: number | null; timestamp: number };
type AdrFeedState = "connecting" | "live" | "partial" | "reconnecting" | "unconfigured";

const STORAGE_KEY = "hk-auction-pairs-v3";
const LEGACY_STORAGE_KEYS = ["hk-auction-pairs-v2", "hk-auction-pairs-v1"];
const ADR_STALE_MS = 30_000;
const ADR_BENCHMARK_MAX_AGE_MS = 96 * 60 * 60_000;
const DEFAULT_ADR: Record<string, { adrSymbol: string; hkSharesPerAdr: number }> = {
  "HK.00700": { adrSymbol: "TCEHY", hkSharesPerAdr: 1 },
  "HK.01810": { adrSymbol: "XIACY", hkSharesPerAdr: 5 },
  "HK.01024": { adrSymbol: "KSHTY", hkSharesPerAdr: 0.2 },
  "HK.03690": { adrSymbol: "MPNGY", hkSharesPerAdr: 2 },
  "HK.09992": { adrSymbol: "PMRTY", hkSharesPerAdr: 1 },
  "HK.00100": { adrSymbol: "MMXGY", hkSharesPerAdr: 0.2 },
};
const DEFAULT_PAIRS: PairConfig[] = [
  { stockSymbol: "HK.00700", perpSymbol: "TENCENTUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.00700"] },
  { stockSymbol: "HK.01810", perpSymbol: "XIAOMIUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.01810"] },
  { stockSymbol: "HK.01024", perpSymbol: "KUAISHOUUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.01024"] },
  { stockSymbol: "HK.03690", perpSymbol: "MEITUANUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.03690"] },
  { stockSymbol: "HK.09992", perpSymbol: "POPMARTUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.09992"] },
  { stockSymbol: "HK.00100", perpSymbol: "MINIMAXUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.00100"] },
  { stockSymbol: "HK.02513", perpSymbol: "ZHIPUUSDT", sharesPerContract: 1 },
  { stockSymbol: "HK.00700", perpSymbol: "HK0700USDT", sharesPerContract: 7.83, ...DEFAULT_ADR["HK.00700"] },
  { stockSymbol: "HK.01810", perpSymbol: "HK1810USDT", sharesPerContract: 7.83, ...DEFAULT_ADR["HK.01810"] },
];

const defaultShares = (perp: string) => ["HK0700USDT", "HK1810USDT"].includes(perp.toUpperCase()) ? 7.83 : 1;
const number = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const pct = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const time = (value: number | null | undefined) => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value) : "—";

const normalizeSavedPair = (pair: PairConfig): PairConfig => {
  const mapping = DEFAULT_ADR[pair.stockSymbol];
  if (!mapping || pair.adrSymbol) return pair;
  return { ...pair, ...mapping };
};

function sessionState(now: number, futuState?: string | null) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const total = hour * 60 + minute;
  const official = futuState?.toUpperCase();
  if (official === "WAITING_OPEN") return { key: "blocking", label: "Auction locked / waiting open", detail: "Futu market state", progress: 100 };
  if (official && !["AUCTION", "ACTION"].includes(official)) return { key: "closed", label: official.replaceAll("_", " "), detail: "Futu market state", progress: 0 };
  if (["Sat", "Sun"].includes(weekday) || total < 540 || total >= 570) return { key: "closed", label: "Outside pre-opening session", detail: "Next monitored window 09:00–09:30 HKT", progress: 0 };
  if (total < 555) return { key: "input", label: "Order input", detail: "Orders may be amended or cancelled", progress: ((total - 540) / 15) * 25 };
  if (total < 560) return { key: "nocancel", label: "No-cancellation", detail: "New auction orders accepted; no cancel", progress: 25 + ((total - 555) / 5) * 25 };
  if (total < 562) return { key: "matching", label: "Random matching", detail: "Opening match may occur at any moment", progress: 50 + ((total - 560) / 2) * 25 };
  return { key: "blocking", label: "Blocking / waiting open", detail: "Auction result is locked until 09:30", progress: 75 + ((total - 562) / 8) * 25 };
}

function SpreadHistory({ points, cursor, onCursor }: { points: HistoryPoint[]; cursor?: number; onCursor: (index: number) => void }) {
  if (!points.length) return <div className={styles.emptyChart}>History starts after both real feeds produce a valid basis.</div>;
  const width = 720;
  const height = 218;
  const plotTop = 18;
  const plotBottom = 178;
  const values = points.map((point) => point.value);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const padding = Math.max((rawMax - rawMin) * .12, .04);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const x = (index: number) => points.length === 1 ? width / 2 : 18 + index / (points.length - 1) * (width - 36);
  const y = (value: number) => plotTop + (max - value) / (max - min) * (plotBottom - plotTop);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const selectedIndex = Math.min(points.length - 1, Math.max(0, cursor ?? points.length - 1));
  const selected = points[selectedIndex];
  return <div className={styles.chartWrap}>
    <div className={styles.chartReadout}><div><span>SELECTED BASIS</span><strong className={selected.value < 0 ? styles.negative : styles.positive}>{pct(selected.value)}</strong></div><div><span>FUTU / BINANCE CLOSE</span><strong>{number(selected.stockCloseHkd)} / {number(selected.perpClose)}</strong></div><div><span>TIME · 1 MINUTE</span><strong>{time(selected.t)} HKT</strong></div></div>
    <svg className={styles.chart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Historical midpoint basis trend">
      <defs><linearGradient id="basisFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#248e69" stopOpacity=".22"/><stop offset="1" stopColor="#248e69" stopOpacity="0"/></linearGradient></defs>
      <line x1="18" x2={width - 18} y1={y(0)} y2={y(0)} className={styles.zeroLine}/>
      <path d={`${path} L${x(points.length - 1)},${plotBottom} L${x(0)},${plotBottom} Z`} className={styles.areaPath}/>
      <path d={path} className={styles.linePath}/>
      <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={plotTop} y2={plotBottom} className={styles.cursorLine}/>
      <circle cx={x(selectedIndex)} cy={y(selected.value)} r="5" className={styles.cursorDot}/>
      <text x="18" y="208">{time(points[0].t)}</text><text x={width - 18} y="208" textAnchor="end">{time(points.at(-1)?.t)}</text>
    </svg>
    <input className={styles.chartSlider} type="range" min="0" max={Math.max(0, points.length - 1)} value={selectedIndex} onChange={(event) => onCursor(Number(event.target.value))} aria-label="Select a historical basis sample" />
    <p>{points.length.toLocaleString()} aligned Futu + Binance one-minute bars · range {pct(rawMin)} → {pct(rawMax)}</p>
  </div>;
}

export default function HkAuctionPage() {
  const [pairs, setPairs] = useState<PairConfig[]>(DEFAULT_PAIRS);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [usdHkd, setUsdHkd] = useState("7.83");
  const [threshold, setThreshold] = useState("0.50");
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [managerOpen, setManagerOpen] = useState(false);
  const [draft, setDraft] = useState({ stockSymbol: "HK.", perpSymbol: "", sharesPerContract: "1", adrSymbol: "", hkSharesPerAdr: "1" });
  const [pairError, setPairError] = useState("");
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [historyError, setHistoryError] = useState<Record<string, string>>({});
  const [cardTabs, setCardTabs] = useState<Record<string, "overview" | "history">>({});
  const [historyCursor, setHistoryCursor] = useState<Record<string, number>>({});
  const [adrBooks, setAdrBooks] = useState<Record<string, AdrBook>>({});
  const [adrFeedState, setAdrFeedState] = useState<AdrFeedState>("connecting");
  const [adrFeedError, setAdrFeedError] = useState("");
  const [missingAdrStreams, setMissingAdrStreams] = useState<string[]>([]);
  const requestRef = useRef(false);

  useEffect(() => {
    try {
      const current = window.localStorage.getItem(STORAGE_KEY);
      if (current !== null) {
        const saved = JSON.parse(current) as PairConfig[];
        if (Array.isArray(saved)) setPairs(saved.slice(0, 24));
        return;
      }
      const legacyRaw = LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean);
      const legacy = JSON.parse(legacyRaw || "[]") as PairConfig[];
      const merged = new Map(DEFAULT_PAIRS.map((pair) => [`${pair.stockSymbol}:${pair.perpSymbol}`, pair]));
      if (Array.isArray(legacy)) legacy.forEach((pair) => merged.set(`${pair.stockSymbol}:${pair.perpSymbol}`, normalizeSavedPair(pair)));
      const migrated = [...merged.values()].map(normalizeSavedPair).slice(0, 24);
      setPairs(migrated);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    } catch { /* Keep safe defaults. */ }
  }, []);

  const adrSymbolsKey = useMemo(() => [...new Set(pairs.flatMap((pair) => pair.adrSymbol ? [pair.adrSymbol.toUpperCase()] : []))].sort().join(","), [pairs]);

  useEffect(() => {
    const symbols = adrSymbolsKey.split(",").filter(Boolean);
    if (!symbols.length) {
      setAdrFeedState("partial");
      setMissingAdrStreams([]);
      return;
    }
    let cancelled = false;
    const loadAdr = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const params = new URLSearchParams();
        symbols.forEach((symbol) => params.append("symbol", symbol));
        const response = await fetch(`/api/hk-auction/adr-quotes?${params}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        });
        const snapshot = await response.json() as { configured?: boolean; state?: AdrFeedState; error?: string; books?: AdrBook[]; missing?: string[] };
        if (cancelled) return;
        if (!response.ok && response.status !== 503) throw new Error(snapshot.error || `ADR proxy HTTP ${response.status}`);
        setAdrFeedState(snapshot.state ?? (snapshot.configured ? "connecting" : "unconfigured"));
        setAdrFeedError(snapshot.error ?? "");
        setMissingAdrStreams(snapshot.missing ?? []);
        if (snapshot.books?.length) setAdrBooks((current) => ({ ...current, ...Object.fromEntries(snapshot.books!.map((book) => [book.symbol, book])) }));
      } catch (error) {
        if (!cancelled) {
          setAdrFeedState("reconnecting");
          setAdrFeedError(error instanceof Error ? error.message : "Posley ADR proxy unavailable.");
        }
      }
    };
    void loadAdr();
    const timer = window.setInterval(() => void loadAdr(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [adrSymbolsKey]);

  const load = useCallback(async () => {
    if (requestRef.current || document.visibilityState === "hidden") return;
    const fx = Number(usdHkd);
    if (!Number.isFinite(fx) || fx <= 0) return;
    requestRef.current = true;
    try {
      const params = new URLSearchParams({ usdhkd: String(fx) });
      pairs.forEach((pair) => params.append("pair", `${pair.stockSymbol}|${pair.perpSymbol}|${pair.sharesPerContract}`));
      const response = await fetch(`/api/hk-auction/quotes?${params}`, { cache: "no-store" });
      const next = await response.json() as Payload & { error?: string };
      if (!response.ok) throw new Error(next.error || "Auction quotes unavailable.");
      setPayload(next);
    } catch (error) {
      setPayload((current) => current ? { ...current, errors: [error instanceof Error ? error.message : "Auction quotes unavailable."] } : null);
    } finally {
      requestRef.current = false;
      setLoading(false);
    }
  }, [pairs, usdHkd]);

  const loadHistory = useCallback(async (id: string, pair: PairConfig) => {
    setHistoryLoading((current) => ({ ...current, [id]: true }));
    setHistoryError((current) => ({ ...current, [id]: "" }));
    try {
      const params = new URLSearchParams({
        stock: pair.stockSymbol,
        perp: pair.perpSymbol,
        shares: String(pair.sharesPerContract),
        usdhkd: usdHkd,
      });
      const response = await fetch(`/api/hk-auction/history?${params}`, { cache: "no-store" });
      const result = await response.json() as { points?: HistoryPoint[]; error?: string };
      if (!response.ok || !Array.isArray(result.points)) throw new Error(result.error || "Historical spread is unavailable.");
      setHistory((current) => ({ ...current, [id]: result.points ?? [] }));
      setHistoryCursor((current) => ({ ...current, [id]: Math.max(0, (result.points?.length ?? 1) - 1) }));
    } catch (error) {
      setHistoryError((current) => ({ ...current, [id]: error instanceof Error ? error.message : "Historical spread is unavailable." }));
    } finally {
      setHistoryLoading((current) => ({ ...current, [id]: false }));
    }
  }, [usdHkd]);

  useEffect(() => {
    void load();
    const quoteTimer = window.setInterval(() => void load(), 1_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearInterval(quoteTimer); window.clearInterval(clockTimer); };
  }, [load]);

  const savePairs = (next: PairConfig[]) => {
    setPairs(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };
  const addPair = () => {
    const stockSymbol = draft.stockSymbol.trim().toUpperCase();
    const perpSymbol = draft.perpSymbol.trim().toUpperCase();
    const sharesPerContract = Number(draft.sharesPerContract);
    const adrSymbol = draft.adrSymbol.trim().toUpperCase();
    const hkSharesPerAdr = Number(draft.hkSharesPerAdr);
    if (!/^HK\.\d{5}$/.test(stockSymbol) || !/^[A-Z0-9_]{3,32}USDT$/.test(perpSymbol) || !Number.isFinite(sharesPerContract) || sharesPerContract <= 0) {
      setPairError("Use Futu format HK.00700, a Binance USDT symbol, and positive shares per contract.");
      return;
    }
    if (adrSymbol && (!/^[A-Z0-9.]{1,16}$/.test(adrSymbol) || !Number.isFinite(hkSharesPerAdr) || hkSharesPerAdr <= 0)) {
      setPairError("ADR ticker must be valid and HK shares per ADR must be positive.");
      return;
    }
    if (pairs.some((pair) => pair.stockSymbol === stockSymbol && pair.perpSymbol === perpSymbol)) {
      setPairError("That mapping is already monitored.");
      return;
    }
    savePairs([...pairs, { stockSymbol, perpSymbol, sharesPerContract, ...(adrSymbol ? { adrSymbol, hkSharesPerAdr } : {}) }].slice(-24));
    setDraft({ stockSymbol: "HK.", perpSymbol: "", sharesPerContract: "1", adrSymbol: "", hkSharesPerAdr: "1" });
    setPairError("");
  };
  const updatePerpDraft = (value: string) => {
    const perpSymbol = value.toUpperCase();
    setDraft((current) => ({ ...current, perpSymbol, sharesPerContract: String(defaultShares(perpSymbol)) }));
  };

  const quoteById = useMemo(() => new Map(payload?.quotes.map((quote) => [quote.id, quote]) ?? []), [payload]);
  const orderedPairs = useMemo(() => [...pairs].sort((left, right) => {
    const leftQuote = quoteById.get(`${left.stockSymbol}:${left.perpSymbol}`);
    const rightQuote = quoteById.get(`${right.stockSymbol}:${right.perpSymbol}`);
    const leftScore = leftQuote?.metrics.midBasisPct === null || leftQuote?.metrics.midBasisPct === undefined
      ? -1
      : Math.abs(leftQuote.metrics.midBasisPct);
    const rightScore = rightQuote?.metrics.midBasisPct === null || rightQuote?.metrics.midBasisPct === undefined
      ? -1
      : Math.abs(rightQuote.metrics.midBasisPct);
    return rightScore - leftScore;
  }), [pairs, quoteById]);
  const futuState = payload?.quotes.find((quote) => quote.futu?.marketState)?.futu?.marketState;
  const session = sessionState(now, futuState);
  const alert = Number(threshold) || 0;

  return <main className={styles.shell}>
    <header className={styles.topbar}>
      <div><p>HKEX PRE-OPEN / CROSS-VENUE BASIS</p><h1>HK Auction Basis</h1><small>Futu auction versus Binance perpetuals and Posley ADRs</small></div>
      <div className={styles.topActions}><span className={styles.clock}>{time(now)} HKT</span><PageSwitcher active="auction" /></div>
    </header>

    <section className={styles.sessionHero}>
      <div><span>ACTIVE SESSION PHASE</span><h2>{session.label}</h2><p>{session.detail}</p></div>
      <div className={styles.sessionTrack}><i style={{ width: `${session.progress}%` }} /><div><span>09:00 INPUT</span><span>09:15 NO CANCEL</span><span>09:20 MATCH</span><span>09:30 OPEN</span></div></div>
      <div className={styles.links}>
        <span className={payload?.sources.futu ? styles.online : ""}><i />Futu {payload?.sources.futu ? "connected" : "waiting for relay"}</span>
        <span className={payload?.sources.binance ? styles.online : ""}><i />Binance {payload?.sources.binance ? "live" : "reconnecting"}</span>
        <button className={adrFeedState === "live" || (adrFeedState === "partial" && !adrFeedError) ? styles.online : ""} disabled><i />{adrFeedState === "live" ? "Posley ADR live" : adrFeedState === "unconfigured" ? "ADR server setup" : adrFeedState === "partial" ? missingAdrStreams.length ? "ADR partial" : "ADR benchmark" : "ADR reconnecting"}</button>
      </div>
    </section>

    <section className={styles.controls}>
      <label><span>USD / HKD</span><input type="number" min="1" max="20" step="0.0001" value={usdHkd} onChange={(event) => setUsdHkd(event.target.value)} /><small>FX conversion · separate from shares/contract</small></label>
      <label><span>Alert threshold</span><input type="number" min="0" max="100" step="0.05" value={threshold} onChange={(event) => setThreshold(event.target.value)} /><small>Absolute midpoint basis %</small></label>
      <div className={styles.formula}><span>CROSS-VENUE NORMALIZATION</span><strong>HK basis: Futu stock ↔ Binance perp · ADR basis: Posley ADR ↔ Binance perp</strong><small>Each comparison is normalized by its HK-share exposure.</small></div>
      <button onClick={() => setManagerOpen((open) => !open)}>{managerOpen ? "Close pair setup" : "Manage pairs"}</button>
    </section>

    {managerOpen && <section className={styles.manager}>
      <label>Futu stock<input value={draft.stockSymbol} onChange={(event) => setDraft((current) => ({ ...current, stockSymbol: event.target.value }))} placeholder="HK.00700" /></label>
      <label>Binance perp<input value={draft.perpSymbol} onChange={(event) => updatePerpDraft(event.target.value)} placeholder="HK0700USDT" /></label>
      <label>Shares per contract<input type="number" min="0.000001" step="0.01" value={draft.sharesPerContract} onChange={(event) => setDraft((current) => ({ ...current, sharesPerContract: event.target.value }))} /></label>
      <label>ADR ticker · optional<input value={draft.adrSymbol} onChange={(event) => setDraft((current) => ({ ...current, adrSymbol: event.target.value.toUpperCase() }))} placeholder="TCEHY" /></label>
      <label>HK shares per ADR<input type="number" min="0.000001" step="0.01" value={draft.hkSharesPerAdr} onChange={(event) => setDraft((current) => ({ ...current, hkSharesPerAdr: event.target.value }))} /></label>
      <button onClick={addPair}>Add mapping</button>
      {pairError && <p>{pairError}</p>}
    </section>}

    {payload?.errors?.length ? <div className={styles.notice}><strong>Partial data</strong><span>{payload.errors.join(" · ")}</span></div> : null}
    {adrFeedError || missingAdrStreams.length ? <div className={styles.notice}><strong>Posley ADR</strong><span>{adrFeedError || "Some configured ADR streams are not currently published."}{missingAdrStreams.length ? ` Missing: ${missingAdrStreams.join(", ")}.` : ""}</span></div> : null}

    <section className={styles.board}>
      <div className={styles.boardHead}><div><span>MONITORED MAPPINGS</span><h2>Executable auction basis</h2></div><p>{loading ? "Connecting…" : `${payload?.quotes.filter((quote) => quote.status === "live").length ?? 0}/${pairs.length} fully live`} · sorted by |mid basis|</p></div>
      <div className={styles.cards}>{orderedPairs.map((pair) => {
        const id = `${pair.stockSymbol}:${pair.perpSymbol}`;
        const quote = quoteById.get(id);
        const basisValue = quote?.metrics.midBasisPct ?? null;
        const hot = basisValue !== null && Math.abs(basisValue) >= alert;
        const sellPerpBasis = quote?.metrics.sellPerpBuyStock.basisPct ?? null;
        const buyPerpBasis = quote?.metrics.buyPerpSellStock.basisPct ?? null;
        const richEdge = sellPerpBasis ?? basisValue;
        const cheapEdge = buyPerpBasis === null ? (basisValue === null ? null : -basisValue) : -buyPerpBasis;
        const shortPerp = richEdge !== null && (cheapEdge === null || richEdge >= cheapEdge);
        const signalReady = basisValue !== null;
        const shortVenue = shortPerp ? "BINANCE" : "FUTU";
        const longVenue = shortPerp ? "FUTU" : "BINANCE";
        const shortSymbol = shortPerp ? pair.perpSymbol : pair.stockSymbol;
        const longSymbol = shortPerp ? pair.stockSymbol : pair.perpSymbol;
        const signalEdge = signalReady ? Math.max(richEdge ?? -Infinity, cheapEdge ?? -Infinity) : null;
        const activeTab = cardTabs[id] ?? "overview";
        const fundingPct = quote?.binance?.fundingRate === null || quote?.binance?.fundingRate === undefined ? null : quote.binance.fundingRate * 100;
        const adr = pair.adrSymbol ? adrBooks[pair.adrSymbol] : undefined;
        const adrFresh = Boolean(adr && now - adr.timestamp <= ADR_STALE_MS);
        const adrUsable = Boolean(adr && now - adr.timestamp <= ADR_BENCHMARK_MAX_AGE_MS);
        const adrMid = adrUsable && adr ? adr.bid !== null && adr.ask !== null ? (adr.bid + adr.ask) / 2 : adr.last : null;
        const adrRatio = pair.hkSharesPerAdr ?? null;
        const perpsPerAdr = adrRatio !== null ? adrRatio / pair.sharesPerContract : null;
        const binanceImpliedAdrUsd = quote?.metrics.binanceMid !== null && quote?.metrics.binanceMid !== undefined && perpsPerAdr !== null
          ? quote.metrics.binanceMid * perpsPerAdr : null;
        const adrBasisPct = adrMid !== null && binanceImpliedAdrUsd !== null && binanceImpliedAdrUsd > 0
          ? (adrMid / binanceImpliedAdrUsd - 1) * 100 : null;
        const adrRich = adrBasisPct !== null && adrBasisPct >= 0;
        const cardHot = hot || (adrBasisPct !== null && Math.abs(adrBasisPct) >= alert);
        return <article key={id} className={`${styles.card} ${cardHot ? styles.hotCard : ""}`}>
          <header><div><span>FUTU {pair.stockSymbol}</span><h3>{pair.perpSymbol}</h3><small>{pair.sharesPerContract.toLocaleString()} shares / perp{pair.adrSymbol ? ` · ${pair.adrSymbol} ${pair.hkSharesPerAdr} shares / ADR` : ""}</small></div><div className={`${styles.status} ${quote?.status === "live" ? styles.live : quote?.status === "stale" ? styles.stale : ""}`}><i />{quote?.status ?? "waiting"}</div></header>
          <div className={styles.cardSignals}>
            <section className={`${styles.signalRow} ${styles.hkSignal} ${!signalReady ? styles.signalWaiting : ""}`}>
              <div className={styles.signalBasis}><span>FUTU ↔ BINANCE</span><strong className={basisValue !== null && basisValue < 0 ? styles.negative : styles.positive}>{pct(basisValue)}</strong><small>MID BASIS · {quote?.metrics.stockReferenceSource === "close-price" ? "official close" : quote?.metrics.stockReferenceSource === "auction-price" ? "auction / IEP" : quote?.metrics.stockReferenceSource === "book-mid" ? "live BBO" : "waiting"}</small></div>
              <div className={styles.signalDirection}><span>TRADE DIRECTION</span><strong>{signalReady ? `SHORT ${shortVenue} → LONG ${longVenue}` : "WAITING FOR BOTH VENUES"}</strong><small>{signalReady ? `${shortSymbol} → ${longSymbol} · executable edge ${pct(signalEdge)}` : "No stale price is used for a trading signal"}</small></div>
              <dl className={styles.signalMetrics}>
                <div><dt>Futu · HKD</dt><dd>{number(quote?.metrics.stockReferenceHkd)}</dd></div>
                <div><dt>Fair perp · USDT</dt><dd>{number(quote?.metrics.fairUsdt)}</dd></div>
                <div><dt>Binance midpoint</dt><dd>{number(quote?.metrics.binanceMid)}</dd></div>
                <div><dt>Funding</dt><dd className={fundingPct !== null && fundingPct < 0 ? styles.negative : styles.positive}>{pct(fundingPct, 4)}</dd><small>Next {time(quote?.binance?.nextFundingTime)}</small></div>
              </dl>
            </section>
            {pair.adrSymbol ? <section className={`${styles.signalRow} ${styles.adrSignal} ${adrBasisPct === null ? styles.signalWaiting : ""} ${adrBasisPct !== null && Math.abs(adrBasisPct) >= alert ? styles.signalRowHot : ""}`}>
              <div className={styles.signalBasis}><span>POSLEY ADR ↔ BINANCE</span><strong className={adrBasisPct !== null && adrBasisPct < 0 ? styles.negative : styles.positive}>{pct(adrBasisPct)}</strong><small title={adr?.streamKey}>{adrFresh ? `LIVE ADR · ${time(adr?.timestamp)}` : adrUsable && adr ? `US BENCHMARK · ${time(adr.timestamp)}` : adr ? "ADR TOO OLD" : "ADR STREAM MISSING"}</small></div>
              <div className={styles.signalDirection}><span>TRADE DIRECTION</span><strong>{adrBasisPct === null ? "WAITING FOR BOTH VENUES" : adrRich ? `SHORT ${pair.adrSymbol} → LONG ${pair.perpSymbol}` : `LONG ${pair.adrSymbol} → SHORT ${pair.perpSymbol}`}</strong><small>{adrBasisPct === null ? "Unavailable or expired data is excluded" : `${adrFresh ? "Live" : "Latest US benchmark"} ADR versus Binance · gap ${pct(Math.abs(adrBasisPct))}`}</small></div>
              <dl className={`${styles.signalMetrics} ${styles.adrMetrics}`}>
                <div><dt>{pair.adrSymbol} · USD</dt><dd>{number(adrMid, 4)}</dd></div>
                <div><dt>Binance-implied ADR</dt><dd>{number(binanceImpliedAdrUsd, 4)}</dd></div>
                <div><dt>Market-neutral hedge</dt><dd>1 ADR ↔ {number(perpsPerAdr, 4)} perp</dd><small>{pair.perpSymbol}</small></div>
              </dl>
            </section> : null}
          </div>
          <div className={styles.cardTabs} role="tablist" aria-label={`${pair.perpSymbol} card view`}>
            <button role="tab" aria-selected={activeTab === "overview"} onClick={() => setCardTabs((current) => ({ ...current, [id]: "overview" }))}>Overview</button>
            <button role="tab" aria-selected={activeTab === "history"} onClick={() => { if (activeTab === "history") setCardTabs((current) => ({ ...current, [id]: "overview" })); else { setCardTabs((current) => ({ ...current, [id]: "history" })); void loadHistory(id, pair); } }}>{activeTab === "history" ? "Close history" : "Open spread history"} <span>{history[id]?.length ?? 0}</span></button>
          </div>
          {activeTab === "history" ? <div className={styles.tabPanel} role="tabpanel">{historyLoading[id] ? <div className={styles.emptyChart}>Reading Futu and Binance one-minute history…</div> : historyError[id] ? <div className={styles.historyFailure}><strong>History unavailable</strong><span>{historyError[id]}</span><button onClick={() => void loadHistory(id, pair)}>Retry</button></div> : <SpreadHistory points={history[id] ?? []} cursor={historyCursor[id]} onCursor={(index) => setHistoryCursor((current) => ({ ...current, [id]: index }))} />}</div> : null}
          <footer><span>Futu {time(quote?.futu?.marketTimestamp)} HKT</span><span>Binance {time(quote?.binance?.marketTimestamp)} HKT</span><button aria-label={`Remove ${pair.perpSymbol}`} onClick={() => savePairs(pairs.filter((item) => item.stockSymbol !== pair.stockSymbol || item.perpSymbol !== pair.perpSymbol))}>Remove</button></footer>
        </article>;
      })}</div>
    </section>

    <footer className={styles.pageFooter}>Raw basis excludes fees, funding, FX execution cost, ADR fees and lot-size rounding. ADR basis compares Posley ADR directly with Binance perp after HK-share exposure normalization; ADR data older than 96 hours and missing venue data remain blank.</footer>
  </main>;
}
