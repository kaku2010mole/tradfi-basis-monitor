"use client";

import { FormEvent, useEffect, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type Item = { direction: "LONG" | "SHORT"; symbol: string; venue: string; market: "PERP" | "SPOT"; role: "PRIMARY" | "RELATED" | "HEDGE"; reason: string };
type Result = { thesis: string; source: string; items: Item[]; checked: number; timestamp: number; message: string | null };
type Status = { venues?: Record<string, number>; instruments?: number; aiReady?: boolean; provider?: "GEMINI" | "OPENAI" | null };
const examples = ["China political stimulus is positive", "XYZ100 will fall", "Oil prices will rise and inflation expectations will increase"];

export default function ThesisMapperPage() {
  const [thesis, setThesis] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState<Status>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { fetch("/api/thesis", { cache: "no-store" }).then((response) => response.json()).then(setStatus).catch(() => setStatus({})); }, []);
  const submit = async (event?: FormEvent, override?: string) => {
    event?.preventDefault();
    const value = (override ?? thesis).trim();
    if (!value) return;
    if (override) setThesis(override);
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/thesis", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thesis: value }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Mapping unavailable");
      setResult(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Mapping unavailable"); }
    finally { setLoading(false); }
  };

  const groups = (["PRIMARY", "RELATED", "HEDGE"] as const).map((role) => ({ role, items: result?.items.filter((item) => item.role === role) ?? [] })).filter((group) => group.items.length);
  return <main className={styles.shell}>
    <header className={styles.topbar}><div><p>WEEKEND THESIS → TRADEABLE SYMBOLS</p><h1>Thesis Mapper</h1><span>No categories. No invented tickers. Only exchange-verified instruments.</span></div><PageSwitcher active="thesis" /></header>
    <section className={styles.hero}>
      <div><span className={styles.kicker}>ASK A DIFFERENT CASE EVERY TIME</span><h2>Tell me what you think happens next.</h2><p>The mapper turns your causal view into a short watchlist, then rejects every symbol that is not currently listed by Binance, OKX, Bitget or Hyperliquid.</p></div>
      <aside><strong>{status.instruments?.toLocaleString() ?? "—"}</strong><span>live instruments indexed</span><small>{status.aiReady ? `${status.provider ?? "AI"} reasoning engine online` : "Reasoning engine needs GEMINI_API_KEY"}</small></aside>
    </section>
    <form className={styles.composer} onSubmit={(event) => void submit(event)}>
      <label htmlFor="thesis">MARKET VIEW</label><textarea id="thesis" value={thesis} onChange={(event) => setThesis(event.target.value)} placeholder="e.g. China policy support will improve risk appetite…" maxLength={1000} />
      <div><span>{thesis.length}/1,000</span><button disabled={loading || thesis.trim().length < 3}>{loading ? "Scanning live markets…" : "Map to instruments"}</button></div>
    </form>
    <div className={styles.examples}>{examples.map((example) => <button key={example} onClick={() => void submit(undefined, example)}>{example}</button>)}</div>
    {error && <div className={styles.error}>{error}</div>}
    {result && <section className={styles.results}>
      <header><div><span>SUBMITTED THESIS</span><h2>{result.thesis}</h2></div><div><b>{result.source}</b><small>{result.checked.toLocaleString()} instruments checked</small></div></header>
      {groups.length ? groups.map((group) => <section className={styles.group} key={group.role}><h3>{group.role}</h3><div className={styles.cards}>{group.items.map((item) => <article key={`${item.direction}:${item.venue}:${item.market}:${item.symbol}`} className={item.direction === "LONG" ? styles.long : styles.short}>
        <div><span>{item.direction}</span><strong>{item.symbol}</strong></div><dl><div><dt>VENUE</dt><dd>{item.venue}</dd></div><div><dt>TYPE</dt><dd>{item.market}</dd></div></dl><p>{item.reason}</p><footer><i />LISTING VERIFIED</footer>
      </article>)}</div></section>) : <div className={styles.empty}><strong>No verified instrument found.</strong><span>{result.message}</span></div>}
    </section>}
    <section className={styles.venues}><span>LIVE DIRECTORIES</span>{["BINANCE", "OKX", "BITGET", "HYPERLIQUID"].map((venue) => <div key={venue}><i className={status.venues?.[venue] ? styles.online : ""} /><strong>{venue}</strong><small>{status.venues?.[venue]?.toLocaleString() ?? "—"} listed</small></div>)}</section>
    <footer className={styles.footer}>Instrument mapping is a watchlist aid, not an order instruction. Availability is verified against public exchange directories; account eligibility and regional restrictions are not checked.</footer>
  </main>;
}
