"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

const DEFAULT_URL = "https://polymarket.com/event/highest-temperature-in-hong-kong-on-august-26-2026/highest-temperature-in-hong-kong-on-august-26-2026-31c";
const SDK_URL = "https://esm.sh/@polymarket/clob-client-v2@1.1.0?bundle";

type Snapshot = { eventTitle: string; question: string; marketSlug: string; outcome: string; outcomes: string[]; tokenId: string; tickSize: string; negRisk: boolean; active: boolean; closed: boolean; acceptingOrders: boolean; endDate: string | null; bestBid: number | null; bestAsk: number | null; bidSize: number | null; askSize: number | null; minOrderSize: number | null; timestamp: number; error?: string };
type Status = "connecting" | "live" | "retrying" | "stopped";
type Report = { time: number; tone: "ok" | "error" | "warning"; text: string; detail?: string };

const price = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}¢`;
const money = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const clock = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

export default function PolySniper() {
  const [marketUrl, setMarketUrl] = useState(DEFAULT_URL);
  const [outcome, setOutcome] = useState("No");
  const [maxPrice, setMaxPrice] = useState(.5);
  const [amount, setAmount] = useState(10);
  const [pollMs, setPollMs] = useState(500);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState("");
  const [armed, setArmed] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const [ticks, setTicks] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [funder, setFunder] = useState("");
  const [signatureType, setSignatureType] = useState(3);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reports, setReports] = useState<Report[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const executingRef = useRef(false);
  const disarmedRef = useRef(false);
  const explicitFailureRef = useRef(0);

  useEffect(() => {
    const saved = localStorage.getItem("poly-sniper-settings");
    if (!saved) return;
    try { const value = JSON.parse(saved) as { marketUrl?: string; outcome?: string; maxPrice?: number; amount?: number; pollMs?: number }; if (value.marketUrl) setMarketUrl(value.marketUrl); if (value.outcome) setOutcome(value.outcome); if (value.maxPrice) setMaxPrice(value.maxPrice); if (value.amount) setAmount(value.amount); if (value.pollMs) setPollMs(value.pollMs); } catch { /* ignore stale local preferences */ }
  }, []);
  useEffect(() => { localStorage.setItem("poly-sniper-settings", JSON.stringify({ marketUrl, outcome, maxPrice, amount, pollMs })); }, [amount, marketUrl, maxPrice, outcome, pollMs]);

  const addReport = useCallback((report: Report) => setReports((current) => [report, ...current].slice(0, 60)), []);
  const loadSnapshot = useCallback(async () => {
    try {
      const response = await fetch(`/api/poly-sniper/market?url=${encodeURIComponent(marketUrl)}&outcome=${encodeURIComponent(outcome)}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const data = await response.json() as Snapshot;
      if (!response.ok || data.error) throw new Error(data.error || `Market lookup HTTP ${response.status}`);
      setSnapshot(data); setStatus("live"); setError(""); setTicks((value) => value + 1);
    } catch (loadError) { setStatus("retrying"); setError(loadError instanceof Error ? loadError.message : "Market data unavailable; retrying."); }
  }, [marketUrl, outcome]);

  useEffect(() => {
    void loadSnapshot();
    const timer = window.setInterval(() => void loadSnapshot(), Math.max(250, pollMs));
    return () => window.clearInterval(timer);
  }, [loadSnapshot, pollMs]);

  useEffect(() => {
    if (!snapshot?.tokenId) return;
    let stopped = false; let retry = 0; let heartbeat = 0; let reconnect = 0;
    const connect = () => {
      if (stopped) return;
      setStatus(retry ? "retrying" : "connecting");
      const socket = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market"); socketRef.current = socket;
      socket.onopen = () => { retry = 0; setStatus("live"); socket.send(JSON.stringify({ assets_ids: [snapshot.tokenId], type: "market", custom_feature_enabled: true })); heartbeat = window.setInterval(() => socket.readyState === WebSocket.OPEN && socket.send("PING"), 10_000); };
      socket.onmessage = (event) => {
        if (event.data === "PONG") return;
        try {
          const parsed = JSON.parse(String(event.data)); const frames = Array.isArray(parsed) ? parsed : [parsed];
          for (const frame of frames) {
            if (frame.asset_id && frame.asset_id !== snapshot.tokenId) continue;
            if (frame.event_type === "book") {
              const bids = (frame.bids ?? []).map((level: { price?: string }) => Number(level.price)).filter(Number.isFinite).sort((a: number, b: number) => b - a);
              const asks = (frame.asks ?? []).map((level: { price?: string }) => Number(level.price)).filter(Number.isFinite).sort((a: number, b: number) => a - b);
              setSnapshot((current) => current ? { ...current, bestBid: bids[0] ?? current.bestBid, bestAsk: asks[0] ?? current.bestAsk, timestamp: Number(frame.timestamp) || Date.now() } : current);
            } else if (frame.event_type === "best_bid_ask") {
              setSnapshot((current) => current ? { ...current, bestBid: Number(frame.best_bid) || current.bestBid, bestAsk: Number(frame.best_ask) || current.bestAsk, timestamp: Number(frame.timestamp) || Date.now() } : current);
            }
            setTicks((value) => value + 1);
          }
        } catch { /* acknowledgements */ }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => { window.clearInterval(heartbeat); if (stopped) return; setStatus("retrying"); retry += 1; reconnect = window.setTimeout(connect, Math.min(10_000, 400 * 2 ** Math.min(retry, 5))); };
    };
    connect();
    return () => { stopped = true; window.clearInterval(heartbeat); window.clearTimeout(reconnect); socketRef.current?.close(); };
  }, [snapshot?.tokenId]);

  const credentialsReady = Boolean(apiKey.trim() && apiSecret.trim() && passphrase.trim() && /^0x[0-9a-fA-F]{64}$/.test(privateKey.trim()) && /^0x[0-9a-fA-F]{40}$/.test(funder.trim()));
  const triggerReady = Boolean(snapshot?.acceptingOrders && snapshot.bestAsk !== null && snapshot.bestAsk <= maxPrice);
  const canArm = credentialsReady && acknowledged && amount > 0 && maxPrice > 0 && maxPrice < 1 && Boolean(snapshot?.acceptingOrders);

  const execute = useCallback(async () => {
    if (!snapshot || !armed || !triggerReady || executingRef.current || disarmedRef.current) return;
    executingRef.current = true; setExecuting(true); setAttempts((value) => value + 1);
    try {
      const account = privateKeyToAccount(privateKey.trim() as `0x${string}`);
      const signer = createWalletClient({ account, transport: http() });
      const sdk = await import(/* @vite-ignore */ SDK_URL) as any;
      const client = new sdk.ClobClient({ host: "https://clob.polymarket.com", chain: 137, signer, creds: { key: apiKey.trim(), secret: apiSecret.trim(), passphrase: passphrase.trim() }, signatureType, funderAddress: funder.trim(), throwOnError: true });
      const result = await client.createAndPostMarketOrder({ tokenID: snapshot.tokenId, amount, price: maxPrice, side: sdk.Side.BUY, orderType: sdk.OrderType.FAK }, { tickSize: snapshot.tickSize, negRisk: snapshot.negRisk }, sdk.OrderType.FAK);
      disarmedRef.current = true; setArmed(false); explicitFailureRef.current = 0;
      addReport({ time: Date.now(), tone: "ok", text: `LIVE BUY accepted · ${money(amount)} ${snapshot.outcome} @ ≤ ${price(maxPrice)}`, detail: `Order ${result?.orderID ?? result?.orderId ?? "accepted"} · ${JSON.stringify(result)}` });
    } catch (orderError) {
      const detail = orderError instanceof Error ? orderError.message : String(orderError);
      const explicit = /status|rejected|insufficient|balance|allowance|invalid|error/i.test(detail);
      addReport({ time: Date.now(), tone: explicit ? "error" : "warning", text: explicit ? "Order rejected — retrying while trigger remains valid" : "Submission state unknown — stopped to prevent a duplicate fill", detail });
      if (explicit) { explicitFailureRef.current += 1; window.setTimeout(() => { executingRef.current = false; setExecuting(false); setRetryNonce((value) => value + 1); }, Math.min(5_000, 400 * 2 ** Math.min(explicitFailureRef.current, 4))); }
      else { disarmedRef.current = true; setArmed(false); }
    } finally {
      if (!armed || disarmedRef.current) { executingRef.current = false; setExecuting(false); }
    }
  }, [addReport, amount, apiKey, apiSecret, armed, funder, maxPrice, passphrase, privateKey, signatureType, snapshot, triggerReady]);

  useEffect(() => { if (armed && triggerReady && !executingRef.current) void execute(); }, [armed, execute, retryNonce, snapshot?.bestAsk, triggerReady]);

  const stateLabel = useMemo(() => executing ? "SUBMITTING LIVE FAK" : armed ? triggerReady ? "TRIGGERED" : `WAITING FOR ASK ≤ ${price(maxPrice)}` : "DISARMED", [armed, executing, maxPrice, triggerReady]);
  const arm = () => { if (!canArm) return; disarmedRef.current = false; explicitFailureRef.current = 0; setReports([]); setAttempts(0); setArmed(true); };
  const stop = () => { disarmedRef.current = true; setArmed(false); setExecuting(false); executingRef.current = false; };
  const logout = async () => { stop(); setApiKey(""); setApiSecret(""); setPassphrase(""); setPrivateKey(""); setFunder(""); await fetch("/api/trade-auth", { method: "DELETE" }); location.reload(); };

  return <main className={styles.shell}>
    <header className={styles.topbar}><div><span className={styles.kicker}>POLYMARKET CLOB · LIVE EXECUTION</span><h1>Polymarket Sniper</h1></div><div className={styles.actions}><span className={`${styles.connection} ${styles[status]}`}><i />{status.toUpperCase()}</span><PageSwitcher active="sniper" /><button onClick={logout}>Lock</button></div></header>
    <section className={styles.marketHero}>
      <div><span>WATCHING OUTCOME</span><h2>{snapshot?.outcome ?? outcome.toUpperCase()}</h2><p>{snapshot?.question ?? "Resolving market…"}</p></div>
      <div className={styles.quote}><span>BEST ASK</span><strong>{price(snapshot?.bestAsk ?? null)}</strong><small>{money(snapshot?.askSize && snapshot.bestAsk ? snapshot.askSize * snapshot.bestAsk : null)} visible</small></div>
      <div className={styles.quote}><span>BEST BID</span><strong>{price(snapshot?.bestBid ?? null)}</strong><small>{money(snapshot?.bidSize && snapshot.bestBid ? snapshot.bidSize * snapshot.bestBid : null)} visible</small></div>
      <div className={`${styles.botState} ${armed ? styles.armed : ""}`}><span>SNIPER STATE</span><strong>{stateLabel}</strong><small>{ticks.toLocaleString()} updates · {attempts} order attempts</small></div>
    </section>
    {error && <div className={styles.banner}>{error} · automatic retry is active</div>}
    <div className={styles.grid}>
      <section className={styles.panel}><header><span>01 · TARGET</span><h3>Market and trigger</h3></header><div className={styles.fields}>
        <label className={styles.full}>Polymarket market URL<input value={marketUrl} onChange={(event) => { stop(); setMarketUrl(event.target.value); }} /></label>
        <label>Outcome<input value={outcome} onChange={(event) => { stop(); setOutcome(event.target.value); }} /></label>
        <label>Fallback poll interval<input type="number" min="250" step="50" value={pollMs} onChange={(event) => setPollMs(Math.max(250, Number(event.target.value)))} /><small>ms · WebSocket remains primary</small></label>
        <label>Buy when best ask ≤<input type="number" min="0.001" max="0.999" step={snapshot?.tickSize ?? ".01"} value={maxPrice} onChange={(event) => { stop(); setMaxPrice(Number(event.target.value)); }} /><small>{price(maxPrice)}</small></label>
        <label>Order amount<input type="number" min="1" step="1" value={amount} onChange={(event) => { stop(); setAmount(Number(event.target.value)); }} /><small>USDC · FAK partial fill allowed</small></label>
      </div><div className={styles.marketMeta}><span>{snapshot?.acceptingOrders ? "ACCEPTING ORDERS" : "NOT ACCEPTING ORDERS"}</span><span>Tick {snapshot?.tickSize ?? "—"}</span><span>{snapshot?.negRisk ? "NEG RISK" : "BINARY"}</span><span>Updated {snapshot ? clock(snapshot.timestamp) : "—"} HKT</span></div></section>
      <section className={`${styles.panel} ${styles.credentials}`}><header><span>02 · LIVE CREDENTIALS</span><h3>Sign locally, submit directly</h3></header><div className={styles.fields}>
        <label>API key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
        <label>Passphrase<input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
        <label className={styles.full}>API secret<input type="password" autoComplete="off" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} /></label>
        <label className={styles.full}>Signing private key<input type="password" autoComplete="new-password" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} placeholder="0x…" /></label>
        <label>Polymarket funder / deposit wallet<input type="password" autoComplete="off" value={funder} onChange={(event) => setFunder(event.target.value)} placeholder="0x…" /></label>
        <label>Signature type<select value={signatureType} onChange={(event) => setSignatureType(Number(event.target.value))}><option value="3">3 · POLY_1271 (default)</option><option value="0">0 · EOA</option><option value="1">1 · Proxy</option><option value="2">2 · Gnosis Safe</option></select></label>
      </div><p className={styles.security}>Credentials stay in this browser tab. They are never saved to local storage or sent to this website&apos;s server.</p></section>
    </div>
    <section className={styles.armPanel}><label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I authorize a real Polygon mainnet FAK order. Explicit rejections retry continuously; unknown submission states stop to prevent duplicate fills.</label><div><button className={styles.stop} onClick={stop} disabled={!armed && !executing}>STOP</button><button className={styles.arm} onClick={arm} disabled={!canArm || armed || executing}>ARM LIVE SNIPER</button></div></section>
    <section className={styles.log}><header><span>EXECUTION REPORT</span><strong>{reports.length ? `${reports.length} events` : "No orders submitted"}</strong></header>{reports.map((report) => <article key={`${report.time}-${report.text}`} className={styles[report.tone]}><time>{clock(report.time)} HKT</time><div><strong>{report.text}</strong>{report.detail && <small>{report.detail}</small>}</div></article>)}</section>
  </main>;
}
