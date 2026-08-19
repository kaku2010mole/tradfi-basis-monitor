"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import LiveDcaPanel from "./LiveDcaPanel";
import type { TakerDirection, TakerQuote } from "./types";
import styles from "./page.module.css";

type Direction = "auto" | TakerDirection;
type PaperFill = { id: number; time: number; notionalA: number; notionalB: number; spread: number; direction: TakerDirection; priceA: number; priceB: number };

const money = (value: number, digits = 0) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(value);
const price = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 8 });
const pct = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const time = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

export default function TakerStudio() {
  const [coinA, setCoinA] = useState("BTC");
  const [coinB, setCoinB] = useState("ETH");
  const [fairRatio, setFairRatio] = useState("");
  const [direction, setDirection] = useState<Direction>("auto");
  const [hedgeRatio, setHedgeRatio] = useState("1");
  const [totalNotional, setTotalNotional] = useState("1000");
  const [sliceNotional, setSliceNotional] = useState("100");
  const [intervalSeconds, setIntervalSeconds] = useState("10");
  const [triggerSpread, setTriggerSpread] = useState("0.10");
  const [maxSlippageBps, setMaxSlippageBps] = useState("15");
  const [quote, setQuote] = useState<TakerQuote | null>(null);
  const [lastQuoteAt, setLastQuoteAt] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const [now, setNow] = useState(0);
  const [running, setRunning] = useState(false);
  const [paperFilled, setPaperFilled] = useState(0);
  const [fills, setFills] = useState<PaperFill[]>([]);
  const requestRef = useRef(false);
  const lastSliceRef = useRef(0);

  const loadQuote = useCallback(async () => {
    if (requestRef.current || document.visibilityState === "hidden") return;
    const ratio = fairRatio.trim() ? Number(fairRatio) : null;
    if (!coinA.trim() || !coinB.trim() || coinA.trim() === coinB.trim() || (ratio !== null && (!Number.isFinite(ratio) || ratio <= 0))) return;
    requestRef.current = true;
    try {
      const params = new URLSearchParams({ coinA: coinA.trim(), coinB: coinB.trim(), fairRatio: ratio === null ? "auto" : String(ratio) });
      const response = await fetch(`/api/taker/quote?${params}`, { cache: "no-store" });
      const next = await response.json() as TakerQuote & { error?: string };
      if (!response.ok) throw new Error(next.error || "Hyperliquid pair quote unavailable.");
      setQuote(next);
      if (ratio === null) setFairRatio(String(Number(next.fairRatio.toPrecision(10))));
      setLastQuoteAt(Date.now());
      setError("");
    } catch (quoteError) {
      setError(quoteError instanceof Error ? quoteError.message : "Hyperliquid pair quote unavailable.");
    } finally {
      requestRef.current = false;
      setLoading(false);
    }
  }, [coinA, coinB, fairRatio]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadQuote(), 0);
    const timer = window.setInterval(() => void loadQuote(), 1_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [loadQuote]);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState === "visible");
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", updateVisibility); };
  }, []);

  const selected = useMemo(() => {
    const shortSpread = quote?.spreads.shortALongB ?? null;
    const longSpread = quote?.spreads.longAShortB ?? null;
    const resolved: TakerDirection = direction === "auto"
      ? (shortSpread ?? -Infinity) >= (longSpread ?? -Infinity) ? "shortA" : "longA"
      : direction;
    return {
      direction: resolved,
      spread: resolved === "shortA" ? shortSpread : longSpread,
      shortLeg: resolved === "shortA" ? coinA : coinB,
      longLeg: resolved === "shortA" ? coinB : coinA,
      liquidityUsd: resolved === "shortA" ? quote?.liquidityUsd.shortALongB ?? null : quote?.liquidityUsd.longAShortB ?? null,
    };
  }, [coinA, coinB, direction, quote]);

  const total = Math.max(0, Number(totalNotional) || 0);
  const slice = Math.max(0, Number(sliceNotional) || 0);
  const hedge = Math.max(0, Number(hedgeRatio) || 0);
  const interval = Math.max(1, Number(intervalSeconds) || 1);
  const trigger = Number(triggerSpread) || 0;
  const slices = slice > 0 ? Math.ceil(total / slice) : 0;
  const progress = total > 0 ? Math.min(100, paperFilled / total * 100) : 0;
  const quoteMatchesPair = Boolean(quote && quote.legA.coin === coinA.trim() && quote.legB.coin === coinB.trim());
  const quoteFresh = Boolean(quoteMatchesPair && !error && pageVisible && now - lastQuoteAt < 5_000);
  const canStage = Boolean(quoteFresh && total > 0 && slice > 0 && hedge > 0 && selected.spread !== null);

  useEffect(() => {
    if (!running || !quote || !quoteFresh || selected.spread === null || selected.spread < trigger || paperFilled >= total) return;
    const delay = Math.max(0, interval * 1_000 - (Date.now() - lastSliceRef.current));
    const timer = window.setTimeout(() => {
      const executedAt = Date.now();
      const notionalA = Math.min(slice, total - paperFilled);
      if (notionalA <= 0) return;
      setFills((current) => [{
        id: executedAt,
        time: executedAt,
        notionalA,
        notionalB: notionalA * hedge,
        spread: selected.spread ?? 0,
        direction: selected.direction,
        priceA: selected.direction === "shortA" ? quote.legA.bid : quote.legA.ask,
        priceB: selected.direction === "shortA" ? quote.legB.ask : quote.legB.bid,
      }, ...current].slice(0, 50));
      setPaperFilled((current) => Math.min(total, current + notionalA));
      if (paperFilled + notionalA >= total) setRunning(false);
      lastSliceRef.current = executedAt;
    }, delay);
    return () => window.clearTimeout(timer);
  }, [hedge, interval, paperFilled, quote, quoteFresh, running, selected.direction, selected.spread, slice, total, trigger]);

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
      <div><p>PROTECTED HYPERLIQUID EXECUTION</p><h1>Internal Taker–Taker DCA</h1><small>Two Hyperliquid perps · one multi-order IOC action · live executable spread</small></div>
      <div className={styles.actions}><span className={quoteFresh ? styles.live : styles.offline}><i />{quoteFresh ? "LIVE" : "RECONNECTING"}</span><button onClick={lockPage}>Lock</button><PageSwitcher active="taker" /></div>
    </header>

    <section className={styles.hero}>
      <div><span>SELECTED EXECUTABLE SPREAD</span><strong className={(selected.spread ?? 0) >= 0 ? styles.positive : styles.negative}>{pct(selected.spread)}</strong><small>{loading ? "Connecting to Hyperliquid…" : error || `Updated ${quote ? time(quote.timestamp) : "—"} HKT · top liquidity ${selected.liquidityUsd === null ? "—" : money(selected.liquidityUsd)}`}</small></div>
      <div className={styles.direction}><div><span>SHORT</span><strong>Hyperliquid {selected.shortLeg}</strong></div><i>↔</i><div><span>LONG</span><strong>Hyperliquid {selected.longLeg}</strong></div></div>
      <div className={styles.mode}><span>EXECUTION MODE</span><strong>PAPER + LIVE</strong><small>Both IOC legs share one signed Hyperliquid action.</small></div>
    </section>

    <section className={styles.layout}>
      <div className={styles.mainColumn}>
        <section className={styles.panel}>
          <div className={styles.panelHead}><div><span>PAIR DEFINITION</span><h2>Internal executable spread</h2></div><button className={styles.anchorAction} onClick={() => setFairRatio("")}>Re-anchor fair ratio</button></div>
          <div className={styles.marketForm}>
            <label>Hyperliquid leg A<input value={coinA} onChange={(event) => setCoinA(event.target.value)} placeholder="BTC or xyz:XYZ100" /></label>
            <label>Hyperliquid leg B<input value={coinB} onChange={(event) => setCoinB(event.target.value)} placeholder="ETH or para:TOTAL2" /></label>
            <label>Fair A / B price ratio<input type="number" min="0.00000001" step="any" value={fairRatio} onChange={(event) => setFairRatio(event.target.value)} placeholder="Auto-lock current midpoint ratio" /></label>
            <label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value as Direction)}><option value="auto">Auto · best executable spread</option><option value="shortA">Short A / Long B</option><option value="longA">Long A / Short B</option></select></label>
          </div>
          <div className={styles.quotes}>
            <div><span>HYPERLIQUID · LEG A</span><strong>{price(quote?.legA.bid)} <i>×</i> {price(quote?.legA.ask)}</strong><small>{coinA} bid / ask</small></div>
            <div><span>HYPERLIQUID · LEG B</span><strong>{price(quote?.legB.bid)} <i>×</i> {price(quote?.legB.ask)}</strong><small>{coinB} bid / ask · fair ratio {price(quote?.fairRatio)}</small></div>
            <div><span>SHORT A / LONG B</span><strong>{pct(quote?.spreads.shortALongB)}</strong><small>Top executable {quote?.liquidityUsd.shortALongB == null ? "—" : money(quote.liquidityUsd.shortALongB)}</small></div>
            <div><span>LONG A / SHORT B</span><strong>{pct(quote?.spreads.longAShortB)}</strong><small>Top executable {quote?.liquidityUsd.longAShortB == null ? "—" : money(quote.liquidityUsd.longAShortB)}</small></div>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}><div><span>DCA ENGINE</span><h2>Slice both Hyperliquid legs</h2></div><small>{slices} planned slices · ~{Math.max(0, slices - 1) * interval}s minimum</small></div>
          <div className={styles.dcaForm}>
            <label>Total leg A notional · USD<input type="number" min="1" step="10" value={totalNotional} onChange={(event) => setTotalNotional(event.target.value)} /></label>
            <label>Leg A per slice<input type="number" min="1" step="10" value={sliceNotional} onChange={(event) => setSliceNotional(event.target.value)} /></label>
            <label>Leg B USD ratio<input type="number" min="0.0001" step="0.01" value={hedgeRatio} onChange={(event) => setHedgeRatio(event.target.value)} /></label>
            <label>Interval · seconds<input type="number" min="1" step="1" value={intervalSeconds} onChange={(event) => setIntervalSeconds(event.target.value)} /></label>
            <label>Minimum spread · %<input type="number" step="0.01" value={triggerSpread} onChange={(event) => setTriggerSpread(event.target.value)} /></label>
            <label>Maximum IOC slippage · bps<input type="number" min="0" step="1" value={maxSlippageBps} onChange={(event) => setMaxSlippageBps(event.target.value)} /></label>
          </div>
          <div className={styles.progress}><div><span style={{ width: `${progress}%` }} /></div><p><strong>{money(paperFilled)}</strong> staged of {money(total)} on leg A · leg B targets {hedge.toFixed(3)}× USD · waits below {pct(trigger, 2)}</p></div>
          <div className={styles.botControls}><button className={styles.start} disabled={!canStage || running} onClick={startPaper}>{paperFilled >= total && total > 0 ? "Run paper DCA again" : "Start paper DCA"}</button><button disabled={!running} onClick={() => setRunning(false)}>Pause</button><button onClick={() => { setRunning(false); setPaperFilled(0); setFills([]); }}>Reset</button><span>{running ? selected.spread !== null && selected.spread >= trigger ? "Waiting for next slice interval" : "Waiting for spread trigger" : "Paper bot idle"}</span></div>
        </section>

        <LiveDcaPanel quote={quote} quoteFresh={quoteFresh} selected={selected} coinA={coinA.trim()} coinB={coinB.trim()} hedgeRatio={hedge} total={total} slice={slice} interval={interval} trigger={trigger} slippageBps={Math.max(0, Number(maxSlippageBps) || 0)} />

        <section className={styles.panel}>
          <div className={styles.panelHead}><div><span>PAPER FILL TAPE</span><h2>Simulated internal IOC slices</h2></div><small>{fills.length} slices</small></div>
          {!fills.length ? <div className={styles.empty}>Start the paper bot to record triggered two-perp slices against live Hyperliquid BBOs.</div> : <div className={styles.fillTable}><div className={styles.fillHead}><span>Time</span><span>Direction</span><span>A / B USD</span><span>Spread</span><span>{coinA}</span><span>{coinB}</span></div>{fills.map((fill) => <div className={styles.fillRow} key={fill.id}><span>{time(fill.time)}</span><strong>{fill.direction === "shortA" ? `SHORT ${coinA}` : `LONG ${coinA}`}</strong><span>{money(fill.notionalA)} / {money(fill.notionalB)}</span><span>{pct(fill.spread)}</span><span>{price(fill.priceA)}</span><span>{price(fill.priceB)}</span></div>)}</div>}
        </section>
      </div>

      <aside className={styles.sideColumn}>
        <section className={styles.riskCard}><span>LIVE EXECUTION GATE</span><h2>One wallet, two IOC legs</h2><p>Paper mode remains the default. Live mode requires a dedicated Hyperliquid API wallet and explicit mainnet acknowledgement.</p><ul><li>Both orders share one signed action</li><li>Independent size and price precision per perp</li><li>Configurable USD hedge ratio</li><li>Automatic stop on any incomplete leg</li><li>No credential persistence</li><li>No retry after uncertain submission</li></ul><small>Per-leg IOC slippage cap: {Number(maxSlippageBps) || 0} bps</small></section>
        <section className={styles.riskCard}><span>INTERNAL TAKER–TAKER</span><ol><li>Read both Hyperliquid BBOs.</li><li>Normalize with the fair A/B ratio.</li><li>Require executable spread ≥ trigger.</li><li>Submit both IOC orders in one action.</li><li>Stop and flag any one-leg fill.</li></ol></section>
      </aside>
    </section>
  </main>;
}
