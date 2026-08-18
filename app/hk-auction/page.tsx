"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type PairConfig = { stockSymbol: string; perpSymbol: string; sharesPerContract: number };
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
  binance: (Book & { mid: number }) | null;
  metrics: {
    stockReferenceHkd: number | null;
    stockReferenceSource: "auction-price" | "book-mid" | null;
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
type HistoryPoint = { t: number; value: number };

const STORAGE_KEY = "hk-auction-pairs-v1";
const DEFAULT_PAIRS: PairConfig[] = [
  { stockSymbol: "HK.00700", perpSymbol: "HK0700USDT", sharesPerContract: 7.83 },
  { stockSymbol: "HK.01810", perpSymbol: "HK1810USDT", sharesPerContract: 7.83 },
];

const defaultShares = (perp: string) => ["HK0700USDT", "HK1810USDT"].includes(perp.toUpperCase()) ? 7.83 : 1;
const number = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const pct = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const money = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? "—" : `$${value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : value.toFixed(0)}`;
const time = (value: number | null | undefined) => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value) : "—";

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

function BasisTape({ points }: { points: HistoryPoint[] }) {
  const recent = points.slice(-48);
  const max = Math.max(.05, ...recent.map((point) => Math.abs(point.value)));
  if (!recent.length) return <div className={styles.emptyTape}>History starts after both real feeds produce a valid basis.</div>;
  return <div className={styles.tape} aria-label="Session basis samples">
    {recent.map((point) => <i key={point.t} title={`${time(point.t)} HKT · ${pct(point.value)}`} className={point.value >= 0 ? styles.upBar : styles.downBar} style={{ height: `${Math.max(4, Math.abs(point.value) / max * 46)}%` }} />)}
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
  const [draft, setDraft] = useState({ stockSymbol: "HK.", perpSymbol: "", sharesPerContract: "1" });
  const [pairError, setPairError] = useState("");
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const requestRef = useRef(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as PairConfig[];
      if (Array.isArray(saved) && saved.length) setPairs(saved.slice(0, 24));
    } catch { /* Keep safe defaults. */ }
  }, []);

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
      setHistory((current) => {
        const updated = { ...current };
        next.quotes.forEach((quote) => {
          if (quote.metrics.midBasisPct === null || quote.status !== "live") return;
          const prior = updated[quote.id] ?? [];
          if (prior.at(-1)?.t === next.timestamp) return;
          updated[quote.id] = [...prior, { t: next.timestamp, value: quote.metrics.midBasisPct }].slice(-1800);
        });
        return updated;
      });
    } catch (error) {
      setPayload((current) => current ? { ...current, errors: [error instanceof Error ? error.message : "Auction quotes unavailable."] } : null);
    } finally {
      requestRef.current = false;
      setLoading(false);
    }
  }, [pairs, usdHkd]);

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
    if (!/^HK\.\d{5}$/.test(stockSymbol) || !/^[A-Z0-9_]{3,32}USDT$/.test(perpSymbol) || !Number.isFinite(sharesPerContract) || sharesPerContract <= 0) {
      setPairError("Use Futu format HK.00700, a Binance USDT symbol, and positive shares per contract.");
      return;
    }
    if (pairs.some((pair) => pair.stockSymbol === stockSymbol && pair.perpSymbol === perpSymbol)) {
      setPairError("That mapping is already monitored.");
      return;
    }
    savePairs([...pairs, { stockSymbol, perpSymbol, sharesPerContract }].slice(-24));
    setDraft({ stockSymbol: "HK.", perpSymbol: "", sharesPerContract: "1" });
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
      <div><p>HKEX PRE-OPEN / CROSS-VENUE BASIS</p><h1>HK Auction Basis</h1><small>Futu auction order book versus Binance USDⓈ-M perpetuals</small></div>
      <div className={styles.topActions}><span className={styles.clock}>{time(now)} HKT</span><PageSwitcher active="auction" /></div>
    </header>

    <section className={styles.sessionHero}>
      <div><span>ACTIVE SESSION PHASE</span><h2>{session.label}</h2><p>{session.detail}</p></div>
      <div className={styles.sessionTrack}><i style={{ width: `${session.progress}%` }} /><div><span>09:00 INPUT</span><span>09:15 NO CANCEL</span><span>09:20 MATCH</span><span>09:30 OPEN</span></div></div>
      <div className={styles.links}>
        <span className={payload?.sources.futu ? styles.online : ""}><i />Futu {payload?.sources.futu ? "connected" : "waiting for relay"}</span>
        <span className={payload?.sources.binance ? styles.online : ""}><i />Binance {payload?.sources.binance ? "live" : "reconnecting"}</span>
      </div>
    </section>

    <section className={styles.controls}>
      <label><span>USD / HKD</span><input type="number" min="1" max="20" step="0.0001" value={usdHkd} onChange={(event) => setUsdHkd(event.target.value)} /><small>FX conversion · separate from shares/contract</small></label>
      <label><span>Alert threshold</span><input type="number" min="0" max="100" step="0.05" value={threshold} onChange={(event) => setThreshold(event.target.value)} /><small>Absolute midpoint basis %</small></label>
      <div className={styles.formula}><span>FAIR PERP VALUE</span><strong>auction HKD × shares / USDHKD</strong><small>HK0700 and HK1810 use 7.83 shares; other mappings default to 1.</small></div>
      <button onClick={() => setManagerOpen((open) => !open)}>{managerOpen ? "Close pair setup" : "Manage pairs"}</button>
    </section>

    {managerOpen && <section className={styles.manager}>
      <label>Futu stock<input value={draft.stockSymbol} onChange={(event) => setDraft((current) => ({ ...current, stockSymbol: event.target.value }))} placeholder="HK.00700" /></label>
      <label>Binance perp<input value={draft.perpSymbol} onChange={(event) => updatePerpDraft(event.target.value)} placeholder="HK0700USDT" /></label>
      <label>Shares per contract<input type="number" min="0.000001" step="0.01" value={draft.sharesPerContract} onChange={(event) => setDraft((current) => ({ ...current, sharesPerContract: event.target.value }))} /></label>
      <button onClick={addPair}>Add mapping</button>
      {pairError && <p>{pairError}</p>}
    </section>}

    {payload?.errors?.length ? <div className={styles.notice}><strong>Partial data</strong><span>{payload.errors.join(" · ")}</span></div> : null}

    <section className={styles.board}>
      <div className={styles.boardHead}><div><span>MONITORED MAPPINGS</span><h2>Executable auction basis</h2></div><p>{loading ? "Connecting…" : `${payload?.quotes.filter((quote) => quote.status === "live").length ?? 0}/${pairs.length} fully live`} · sorted by |mid basis|</p></div>
      <div className={styles.cards}>{orderedPairs.map((pair) => {
        const id = `${pair.stockSymbol}:${pair.perpSymbol}`;
        const quote = quoteById.get(id);
        const basisValue = quote?.metrics.midBasisPct ?? null;
        const hot = basisValue !== null && Math.abs(basisValue) >= alert;
        const futuFresh = quote?.futu?.stale === false;
        const binanceFresh = quote?.binance?.stale === false;
        return <article key={id} className={`${styles.card} ${hot ? styles.hotCard : ""}`}>
          <header><div><span>FUTU {pair.stockSymbol}</span><h3>{pair.perpSymbol}</h3><small>{pair.sharesPerContract.toLocaleString()} shares per 1 perp</small></div><div className={`${styles.status} ${quote?.status === "live" ? styles.live : quote?.status === "stale" ? styles.stale : ""}`}><i />{quote?.status ?? "waiting"}</div></header>
          <div className={styles.basisHero}><span>MID BASIS</span><strong className={basisValue !== null && basisValue < 0 ? styles.negative : styles.positive}>{pct(basisValue)}</strong><small>{quote?.metrics.stockReferenceSource === "auction-price" ? "Futu auction / IEP reference" : quote?.metrics.stockReferenceSource === "book-mid" ? "Futu BBO midpoint proxy" : "No valid auction reference"}</small></div>
          <dl className={styles.coreMetrics}>
            <div><dt>Auction ref · HKD</dt><dd>{number(quote?.metrics.stockReferenceHkd)}</dd></div>
            <div><dt>Fair perp · USDT</dt><dd>{number(quote?.metrics.fairUsdt)}</dd></div>
            <div><dt>Perp midpoint</dt><dd>{number(quote?.metrics.binanceMid)}</dd></div>
          </dl>
          <div className={styles.books}>
            <div><span>FUTU AUCTION BOOK</span><strong><b>{number(futuFresh ? quote?.futu?.bid : null)}</b><i>×</i><em>{number(futuFresh ? quote?.futu?.ask : null)}</em></strong><small>{number(futuFresh ? quote?.futu?.bidSize : null, 0)} / {number(futuFresh ? quote?.futu?.askSize : null, 0)} shares · {time(quote?.futu?.marketTimestamp)} HKT</small></div>
            <div><span>BINANCE PERP BOOK</span><strong><b>{number(binanceFresh ? quote?.binance?.bid : null)}</b><i>×</i><em>{number(binanceFresh ? quote?.binance?.ask : null)}</em></strong><small>{number(binanceFresh ? quote?.binance?.bidSize : null, 3)} / {number(binanceFresh ? quote?.binance?.askSize : null, 3)} qty · {time(quote?.binance?.marketTimestamp)} HKT</small></div>
          </div>
          <div className={styles.edges}>
            <div><span>SELL PERP / BUY STOCK</span><strong>{pct(quote?.metrics.sellPerpBuyStock.basisPct)}</strong><small>Capacity {money(quote?.metrics.sellPerpBuyStock.capacityUsdt)}</small></div>
            <div><span>BUY PERP / SELL STOCK</span><strong>{pct(quote?.metrics.buyPerpSellStock.basisPct)}</strong><small>Capacity {money(quote?.metrics.buyPerpSellStock.capacityUsdt)}</small></div>
          </div>
          <details className={styles.history}><summary>Session basis tape <span>{history[id]?.length ?? 0} real samples</span></summary><BasisTape points={history[id] ?? []} /></details>
          <footer><span>Stock depth {money(quote ? Math.min(quote.metrics.depthUsdt.stockBid ?? Infinity, quote.metrics.depthUsdt.stockAsk ?? Infinity) : null)}</span><span>Perp depth {money(quote ? Math.min(quote.metrics.depthUsdt.binanceBid ?? Infinity, quote.metrics.depthUsdt.binanceAsk ?? Infinity) : null)}</span><button aria-label={`Remove ${pair.perpSymbol}`} onClick={() => savePairs(pairs.filter((item) => item.stockSymbol !== pair.stockSymbol || item.perpSymbol !== pair.perpSymbol))}>Remove</button></footer>
        </article>;
      })}</div>
    </section>

    <footer className={styles.pageFooter}>Raw basis excludes fees, funding, FX execution cost and stock-lot rounding. Missing Futu auction data remains blank by design.</footer>
  </main>;
}
