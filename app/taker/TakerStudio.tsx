"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type Direction = "auto" | "shortHyper" | "longHyper";
type Quote = {
  hyperliquid: { coin: string; bid: number; ask: number; bidSize: number | null; askSize: number | null; timestamp: number };
  binance: { symbol: string; bid: number; ask: number; bidSize: number | null; askSize: number | null; timestamp: number };
  multiplier: number;
  spreads: { shortHyperLongBinance: number; longHyperShortBinance: number };
  timestamp: number;
};
type PaperFill = { id: number; time: number; notional: number; spread: number; direction: "shortHyper" | "longHyper"; hyperPrice: number; binancePrice: number };

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
const price = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 8 });
const pct = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const time = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

export default function TakerStudio() {
  const [hyperCoin, setHyperCoin] = useState("BTC");
  const [binanceSymbol, setBinanceSymbol] = useState("BTCUSDT");
  const [multiplier, setMultiplier] = useState("1");
  const [direction, setDirection] = useState<Direction>("auto");
  const [totalNotional, setTotalNotional] = useState("1000");
  const [sliceNotional, setSliceNotional] = useState("100");
  const [intervalSeconds, setIntervalSeconds] = useState("10");
  const [triggerSpread, setTriggerSpread] = useState("0.10");
  const [maxSlippageBps, setMaxSlippageBps] = useState("15");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [paperFilled, setPaperFilled] = useState(0);
  const [fills, setFills] = useState<PaperFill[]>([]);
  const requestRef = useRef(false);
  const lastSliceRef = useRef(0);

  const loadQuote = useCallback(async () => {
    if (requestRef.current || document.visibilityState === "hidden") return;
    const multiple = Number(multiplier);
    if (!hyperCoin.trim() || !binanceSymbol.trim() || !Number.isFinite(multiple) || multiple <= 0) return;
    requestRef.current = true;
    try {
      const params = new URLSearchParams({ hyper: hyperCoin.trim(), binance: binanceSymbol.trim(), multiplier: String(multiple) });
      const response = await fetch(`/api/taker/quote?${params}`, { cache: "no-store" });
      const next = await response.json() as Quote & { error?: string };
      if (!response.ok) throw new Error(next.error || "Cross-venue quote unavailable.");
      setQuote(next);
      setError("");
    } catch (quoteError) {
      setError(quoteError instanceof Error ? quoteError.message : "Cross-venue quote unavailable.");
    } finally {
      requestRef.current = false;
      setLoading(false);
    }
  }, [binanceSymbol, hyperCoin, multiplier]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadQuote(), 0);
    const timer = window.setInterval(() => void loadQuote(), 1_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [loadQuote]);

  const selected = useMemo(() => {
    const shortSpread = quote?.spreads.shortHyperLongBinance ?? null;
    const longSpread = quote?.spreads.longHyperShortBinance ?? null;
    const resolved: "shortHyper" | "longHyper" = direction === "auto"
      ? (shortSpread ?? -Infinity) >= (longSpread ?? -Infinity) ? "shortHyper" : "longHyper"
      : direction;
    return {
      direction: resolved,
      spread: resolved === "shortHyper" ? shortSpread : longSpread,
      shortLeg: resolved === "shortHyper" ? `Hyperliquid ${hyperCoin}` : `Binance ${binanceSymbol}`,
      longLeg: resolved === "shortHyper" ? `Binance ${binanceSymbol}` : `Hyperliquid ${hyperCoin}`,
    };
  }, [binanceSymbol, direction, hyperCoin, quote]);

  const total = Math.max(0, Number(totalNotional) || 0);
  const slice = Math.max(0, Number(sliceNotional) || 0);
  const interval = Math.max(1, Number(intervalSeconds) || 1);
  const trigger = Number(triggerSpread) || 0;
  const slices = slice > 0 ? Math.ceil(total / slice) : 0;
  const progress = total > 0 ? Math.min(100, paperFilled / total * 100) : 0;
  const quoteFresh = Boolean(quote && !error);
  const canStage = Boolean(quoteFresh && total > 0 && slice > 0 && selected.spread !== null);

  useEffect(() => {
    if (!running || !quote || !quoteFresh || selected.spread === null || selected.spread < trigger || paperFilled >= total) return;
    const now = Date.now();
    const delay = Math.max(0, interval * 1_000 - (now - lastSliceRef.current));
    const timer = window.setTimeout(() => {
      const executedAt = Date.now();
      const notional = Math.min(slice, total - paperFilled);
      if (notional <= 0) return;
      const shortHyper = selected.direction === "shortHyper";
      setFills((current) => [{
        id: executedAt,
        time: executedAt,
        notional,
        spread: selected.spread ?? 0,
        direction: selected.direction,
        hyperPrice: shortHyper ? quote.hyperliquid.bid : quote.hyperliquid.ask,
        binancePrice: shortHyper ? quote.binance.ask : quote.binance.bid,
      }, ...current].slice(0, 50));
      setPaperFilled((current) => Math.min(total, current + notional));
      if (paperFilled + notional >= total) setRunning(false);
      lastSliceRef.current = executedAt;
    }, delay);
    return () => window.clearTimeout(timer);
  }, [interval, paperFilled, quote, quoteFresh, running, selected.direction, selected.spread, slice, total, trigger]);

  const startPaper = () => {
    setPaperFilled(0);
    setFills([]);
    lastSliceRef.current = 0;
    setRunning(true);
  };

  const lockPage = async () => {
    await fetch("/api/trade-auth", { method: "DELETE" });
    window.location.reload();
  };

  return <main className={styles.shell}>
    <header className={styles.topbar}>
      <div><p>PROTECTED CROSS-VENUE EXECUTION</p><h1>Taker–Taker DCA</h1><small>Hyperliquid ↔ Binance · live executable spread · paper staging</small></div>
      <div className={styles.actions}><span className={quoteFresh ? styles.live : styles.offline}><i />{quoteFresh ? "LIVE" : "RECONNECTING"}</span><button onClick={lockPage}>Lock</button><PageSwitcher active="taker" /></div>
    </header>

    <section className={styles.hero}>
      <div><span>SELECTED EXECUTABLE SPREAD</span><strong className={(selected.spread ?? 0) >= 0 ? styles.positive : styles.negative}>{pct(selected.spread)}</strong><small>{loading ? "Connecting to both venues…" : error || `Updated ${quote ? time(quote.timestamp) : "—"} HKT`}</small></div>
      <div className={styles.direction}><div><span>SHORT</span><strong>{selected.shortLeg}</strong></div><i>→</i><div><span>LONG</span><strong>{selected.longLeg}</strong></div></div>
      <div className={styles.mode}><span>EXECUTION MODE</span><strong>PAPER DCA</strong><small>Real order submission is intentionally locked.</small></div>
    </section>

    <section className={styles.layout}>
      <div className={styles.mainColumn}>
        <section className={styles.panel}>
          <div className={styles.panelHead}><div><span>MARKET MAPPING</span><h2>Live spread inputs</h2></div><small>Refresh 1 second</small></div>
          <div className={styles.marketForm}>
            <label>Hyperliquid coin<input value={hyperCoin} onChange={(event) => setHyperCoin(event.target.value)} placeholder="BTC or xyz:NVDA" /></label>
            <label>Binance USDⓈ-M symbol<input value={binanceSymbol} onChange={(event) => setBinanceSymbol(event.target.value.toUpperCase())} placeholder="BTCUSDT" /></label>
            <label>Binance price multiplier<input type="number" min="0.000001" step="0.01" value={multiplier} onChange={(event) => setMultiplier(event.target.value)} /></label>
            <label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value as Direction)}><option value="auto">Auto · best positive spread</option><option value="shortHyper">Short Hyperliquid / Long Binance</option><option value="longHyper">Long Hyperliquid / Short Binance</option></select></label>
          </div>
          <div className={styles.quotes}>
            <div><span>HYPERLIQUID</span><strong>{price(quote?.hyperliquid.bid)} <i>×</i> {price(quote?.hyperliquid.ask)}</strong><small>{hyperCoin} bid / ask</small></div>
            <div><span>BINANCE</span><strong>{price(quote?.binance.bid)} <i>×</i> {price(quote?.binance.ask)}</strong><small>{binanceSymbol} bid / ask · multiplier {multiplier || "—"}</small></div>
            <div><span>SHORT HL / LONG BN</span><strong>{pct(quote?.spreads.shortHyperLongBinance)}</strong><small>HL bid versus Binance ask</small></div>
            <div><span>LONG HL / SHORT BN</span><strong>{pct(quote?.spreads.longHyperShortBinance)}</strong><small>Binance bid versus HL ask</small></div>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}><div><span>DCA ENGINE</span><h2>Slice the two-leg order</h2></div><small>{slices} planned slices · ~{Math.max(0, slices - 1) * interval}s minimum</small></div>
          <div className={styles.dcaForm}>
            <label>Total notional · USDT<input type="number" min="1" step="10" value={totalNotional} onChange={(event) => setTotalNotional(event.target.value)} /></label>
            <label>Notional per slice<input type="number" min="1" step="10" value={sliceNotional} onChange={(event) => setSliceNotional(event.target.value)} /></label>
            <label>Interval · seconds<input type="number" min="1" step="1" value={intervalSeconds} onChange={(event) => setIntervalSeconds(event.target.value)} /></label>
            <label>Minimum spread · %<input type="number" step="0.01" value={triggerSpread} onChange={(event) => setTriggerSpread(event.target.value)} /></label>
            <label>Maximum slippage · bps<input type="number" min="0" step="1" value={maxSlippageBps} onChange={(event) => setMaxSlippageBps(event.target.value)} /></label>
          </div>
          <div className={styles.progress}><div><span style={{ width: `${progress}%` }} /></div><p><strong>{money(paperFilled)}</strong> staged of {money(total)} · waits whenever spread is below {pct(trigger, 2)}</p></div>
          <div className={styles.botControls}><button className={styles.start} disabled={!canStage || running} onClick={startPaper}>{paperFilled >= total && total > 0 ? "Run paper DCA again" : "Start paper DCA"}</button><button disabled={!running} onClick={() => setRunning(false)}>Pause</button><button onClick={() => { setRunning(false); setPaperFilled(0); setFills([]); }}>Reset</button><span>{running ? selected.spread !== null && selected.spread >= trigger ? "Waiting for next slice interval" : "Waiting for spread trigger" : "Bot idle"}</span></div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}><div><span>PAPER FILL TAPE</span><h2>Simulated two-leg slices</h2></div><small>{fills.length} fills</small></div>
          {!fills.length ? <div className={styles.empty}>Start the paper bot to record triggered slices against live executable prices.</div> : <div className={styles.fillTable}><div className={styles.fillHead}><span>Time</span><span>Direction</span><span>Notional</span><span>Spread</span><span>HL price</span><span>BN price</span></div>{fills.map((fill) => <div className={styles.fillRow} key={fill.id}><span>{time(fill.time)}</span><strong>{fill.direction === "shortHyper" ? "SHORT HL" : "LONG HL"}</strong><span>{money(fill.notional)}</span><span>{pct(fill.spread)}</span><span>{price(fill.hyperPrice)}</span><span>{price(fill.binancePrice)}</span></div>)}</div>}
        </section>
      </div>

      <aside className={styles.sideColumn}>
        <section className={styles.riskCard}><span>LIVE EXECUTION GATE</span><h2>Locked by design</h2><p>This first version validates market mapping, trigger logic and DCA timing without touching funds.</p><ul><li>Dedicated Hyperliquid API wallet</li><li>Binance Futures key with withdrawals disabled</li><li>IOC orders with per-slice slippage caps</li><li>Atomic nonce manager</li><li>Fill reconciliation and emergency hedge</li><li>Dead-man switch and exposure ceiling</li></ul><small>Max slippage staged: {Number(maxSlippageBps) || 0} bps</small></section>
        <section className={styles.riskCard}><span>TAKER–TAKER SEQUENCE</span><ol><li>Read both BBOs.</li><li>Require spread ≥ trigger.</li><li>Submit the thinner-risk leg first.</li><li>Size the hedge from actual fill.</li><li>Stop on partial fill or stale quote.</li></ol></section>
      </aside>
    </section>
  </main>;
}
