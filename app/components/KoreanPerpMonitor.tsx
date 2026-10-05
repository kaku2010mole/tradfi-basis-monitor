"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { equityBasis, equitySpreads } from "../lib/equityBasis";
import styles from "./KoreanPerpMonitor.module.css";

const COGNITO_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "5qup0una5tdma3l33pnn1gm87i";
const COGNITO_DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "posley.auth.us-east-1.amazoncognito.com";

type VenueQuote = { venue: string; symbol: string; bid: number | null; ask: number | null; bidQty: number | null; askQty: number | null; updatedAt: number | null; buyKoreaSellPerp: number | null; buyPerpSellKorea: number | null };
type Session = "PRE-MARKET" | "OPENING AUCTION" | "REGULAR" | "AFTER-HOURS OPENING" | "AFTER-HOURS" | "LUNCH" | "CLOSED";
type Row = { code: string; name: string; market: "KRX" | "TSE"; session: Session; currency: "KRW" | "JPY"; sharesPerPerp: number; cashBidKrw: number | null; cashAskKrw: number | null; cashLast: number | null; cashBidQty: number | null; cashAskQty: number | null; cashUpdatedAt: number | null; cashBidUsd: number | null; cashAskUsd: number | null; venues: VenueQuote[]; mappingNote: string | null };
type FxBook = { source: string; bid: number | null; ask: number | null; last: number | null; updatedAt: number | null };
type Payload = { rows?: Row[]; sessions?: { KRX: Session; TSE: Session }; fx?: FxBook; yenFx?: FxBook; posley?: { state: string; error: string; missing: string[]; source?: string }; timestamp?: number; error?: string };

const fmt = (value: number | null, digits = 2) => value === null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const time = (value: number | null) => value === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
const dateTime = (value: number | null) => value === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
const POLL_MS = 2_000;
const EDGE_MAX_AGE_MS = 60_000;

function mergeRows(previous: Row[] = [], incoming: Row[] = []) {
  const priorByCode = new Map(previous.map((row) => [row.code, row]));
  return incoming.map((row) => {
    const prior = priorByCode.get(row.code);
    if (!prior) return row;
    const cash = (row.cashLast != null || row.cashBidKrw != null || row.cashAskKrw != null) && (row.cashUpdatedAt ?? 0) >= (prior.cashUpdatedAt ?? 0) ? row : prior;
    const priorVenues = new Map(prior.venues.map((quote) => [quote.venue, quote]));
    return {
      ...row,
      cashBidKrw: cash.cashBidKrw, cashAskKrw: cash.cashAskKrw,
      cashLast: cash.cashLast,
      cashBidQty: cash.cashBidQty, cashAskQty: cash.cashAskQty,
      cashBidUsd: row.cashBidUsd,
      cashAskUsd: row.cashAskUsd,
      cashUpdatedAt: cash.cashUpdatedAt,
      venues: row.venues.map((quote) => {
        const older = priorVenues.get(quote.venue);
        if (!older) return quote;
        const book = quote.bid !== null && quote.ask !== null && (quote.updatedAt ?? 0) >= (older.updatedAt ?? 0) ? quote : older;
        return { ...book, buyKoreaSellPerp: quote.buyKoreaSellPerp, buyPerpSellKorea: quote.buyPerpSellKorea };
      }),
    };
  });
}
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function beginPosleyLogin() {
  const check = await fetch(`/api/posley-auth-check?origin=${encodeURIComponent(location.origin)}`, { cache: "no-store" });
  const status = await check.json() as { registered?: boolean; callbackUrl?: string; error?: string };
  if (!check.ok) throw new Error(status.error || "Could not verify Posley login configuration.");
  if (!status.registered) throw new Error(`Posley Cognito has not registered ${status.callbackUrl}. Ask the Posley administrator to add this exact callback URL to client ${COGNITO_CLIENT_ID}.`);
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  sessionStorage.setItem("equity_monitor_pkce", verifier);
  sessionStorage.setItem("equity_monitor_return_to", "/oracle");
  const params = new URLSearchParams({ client_id: COGNITO_CLIENT_ID, response_type: "code", scope: "openid email profile", redirect_uri: `${location.origin}/`, identity_provider: "Google", code_challenge_method: "S256", code_challenge: base64Url(new Uint8Array(digest)) });
  location.assign(`https://${COGNITO_DOMAIN}/oauth2/authorize?${params}`);
}

async function browserIdToken() {
  const stored = localStorage.getItem("equity_monitor_id_token");
  const expiresAt = Number(localStorage.getItem("equity_monitor_expires_at"));
  if (stored && expiresAt > Date.now() + 60_000) return stored;
  const refreshToken = localStorage.getItem("equity_monitor_refresh_token");
  if (!refreshToken) return null;
  const response = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: COGNITO_CLIENT_ID, refresh_token: refreshToken }) });
  if (!response.ok) return null;
  const tokens = await response.json() as { id_token?: string; expires_in?: number };
  if (!tokens.id_token) return null;
  localStorage.setItem("equity_monitor_id_token", tokens.id_token);
  localStorage.setItem("equity_monitor_expires_at", String(Date.now() + (tokens.expires_in ?? 3600) * 1_000));
  return tokens.id_token;
}

export default function KoreanPerpMonitor() {
  const [payload, setPayload] = useState<Payload>({});
  const [clock, setClock] = useState(0);
  const [error, setError] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const token = await browserIdToken();
      const response = await fetch("/api/oracle-monitor/korean-bitget", { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      const next = await response.json() as Payload;
      if (!response.ok) throw new Error(next.error || "Korean stock feed unavailable.");
      setPayload((previous) => ({
        ...next,
        fx: next.fx && (next.fx.bid !== null || next.fx.ask !== null || next.fx.last !== null) ? next.fx : previous.fx,
        yenFx: next.yenFx && (next.yenFx.bid !== null || next.yenFx.ask !== null || next.yenFx.last !== null) ? next.yenFx : previous.yenFx,
        rows: mergeRows(previous.rows, next.rows),
      }));
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Feeds reconnecting."); }
    finally { setClock(Date.now()); inFlight.current = false; }
  }, []);
  useEffect(() => { const first = window.setTimeout(() => void load(), 0); const timer = window.setInterval(load, POLL_MS); return () => { clearTimeout(first); clearInterval(timer); }; }, [load]);

  const connect = async () => {
    setLoginBusy(true); setLoginError("");
    try { await beginPosleyLogin(); }
    catch (reason) { setLoginError(reason instanceof Error ? reason.message : "Posley login is unavailable."); setLoginBusy(false); }
  };

  return <section className={styles.monitor} aria-label="Korean and Japanese stock perpetual basis">
    <header><div><p>POSLEY KRX + TSE · EXCHANGE PERPETUALS</p><h2>Korean &amp; Japanese stock cross-venue basis</h2><span>All-session basis · latest available quotes · USDT treated as USD</span></div><div className={`${styles.status} ${payload.sessions?.KRX !== "REGULAR" && payload.sessions?.KRX !== "AFTER-HOURS" && payload.sessions?.TSE !== "REGULAR" ? styles.closed : ""}`}><i />{payload.sessions ? `KRX ${payload.sessions.KRX} · TSE ${payload.sessions.TSE}${payload.posley?.state === "partial" ? " · DATA PARTIAL" : ""}` : "CONNECTING"}</div></header>
    <div className={styles.fx}><span>USD/KRW POSLEY {payload.fx?.bid != null && payload.fx?.ask != null ? clock - (payload.fx.updatedAt ?? 0) <= EDGE_MAX_AGE_MS ? "BBO" : "LAST BBO" : "LAST"}</span><strong>{payload.fx?.bid != null && payload.fx?.ask != null ? `${fmt(payload.fx.bid, 2)} / ${fmt(payload.fx.ask, 2)}` : fmt(payload.fx?.last ?? null, 2)}</strong><small>As of {dateTime(payload.fx?.updatedAt ?? null)} HKT · Latest available FX is used for basis; older quotes are labelled.</small></div>
    <div className={styles.fx}><span>USD/JPY {payload.yenFx?.source?.toUpperCase() ?? "WAITING"} {payload.yenFx?.bid != null && payload.yenFx?.ask != null ? clock - (payload.yenFx.updatedAt ?? 0) <= EDGE_MAX_AGE_MS ? "BBO" : "LAST BBO" : "LAST"}</span><strong>{payload.yenFx?.bid != null && payload.yenFx?.ask != null ? `${fmt(payload.yenFx.bid, 2)} / ${fmt(payload.yenFx.ask, 2)}` : fmt(payload.yenFx?.last ?? null, 2)}</strong><small>As of {dateTime(payload.yenFx?.updatedAt ?? null)} HKT · FX index fallback is used for indicative basis when BBO is unavailable.</small></div>
    {(loginError || error || payload.posley?.error) && <div className={styles.notice}><span>{loginError || error || payload.posley?.error}</span><button disabled={loginBusy} onClick={() => void connect()}>{loginBusy ? "Checking…" : "Connect Posley"}</button></div>}
    <div className={styles.rows}>{payload.rows?.map((row) => {
      const active = row.session === "REGULAR" || row.market === "KRX" && row.session === "AFTER-HOURS";
      const fx = (row.market === "TSE" ? payload.yenFx : payload.fx) ?? {};
      const basis = equityBasis({ bid: row.cashBidKrw, ask: row.cashAskKrw, last: row.cashLast }, fx, row.sharesPerPerp, !active);
      return <article key={row.code}>
      <div className={styles.identity}><small>{row.market} {row.code}{row.sharesPerPerp !== 1 ? ` · ${row.sharesPerPerp} shares / perp` : ""}</small><strong>{row.name}</strong><span>{row.currency} {basis.usesLast && row.cashLast != null ? `${fmt(row.cashLast, 0)} last` : `${fmt(row.cashBidKrw, 0)} / ${fmt(row.cashAskKrw, 0)}`} · {row.session}</span><em>≈ USD {fmt(basis.cashBidUsd)} / {fmt(basis.cashAskUsd)} · {basis.usesLast ? "Last cash price" : "Cash BBO"} · {dateTime(row.cashUpdatedAt)} HKT</em></div>
      <div className={styles.venues}>{row.venues.map((quote) => {
        const oldestLeg = Math.min(row.cashUpdatedAt ?? 0, fx.updatedAt ?? 0, quote.updatedAt ?? 0);
        const stale = !oldestLeg || clock - oldestLeg > EDGE_MAX_AGE_MS;
        const indicative = !active || stale || basis.usesLast || basis.usesFxLast || !row.cashBidQty || !row.cashAskQty;
        const spreads = equitySpreads(basis.cashBidUsd, basis.cashAskUsd, quote);
        const label = indicative ? `${row.session} · INDICATIVE${stale ? " · LAST QUOTES" : ""}` : row.session === "AFTER-HOURS" ? "AFTER-HOURS BBO" : "LIVE BBO";
        return <div key={quote.venue} className={styles.venue}>
        <div><b>{quote.venue}</b><code>{quote.symbol}</code><time>{time(quote.updatedAt)}</time></div>
        <div className={styles.bbo}><span>PERP BID / ASK<strong>{fmt(quote.bid)} / {fmt(quote.ask)}</strong></span><span>SIZE<strong>{fmt(quote.bidQty)} / {fmt(quote.askQty)}</strong></span></div>
        <div className={styles.edges}><span className={(spreads.buyKoreaSellPerp ?? -1) > 0 ? styles.positive : ""}>BUY {row.market} · SELL PERP<b>{pct(spreads.buyKoreaSellPerp)}</b><small>{label}</small></span><span className={(spreads.buyPerpSellKorea ?? -1) > 0 ? styles.positive : ""}>BUY PERP · SELL {row.market}<b>{pct(spreads.buyPerpSellKorea)}</b><small>{label}</small></span></div>
      </div>; })}</div>
      {row.mappingNote && <p className={styles.mapping}>{row.mappingNote}</p>}
    </article>; })}</div>
    <footer>Basis is shown in every market session. Closed, pre-market, auction, stale and last-price or FX-index comparisons are labelled INDICATIVE. Missing prices or FX show —. The Posley KRX book is not verified as an NXT-routable quote; confirm the cash venue before trading. Figures exclude fees, funding, borrow, tax, FX execution and latency.</footer>
  </section>;
}
