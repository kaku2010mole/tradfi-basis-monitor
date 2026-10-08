"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { equityBasis, equitySpreads, preferCashLast } from "../lib/equityBasis";
import styles from "./KoreanPerpMonitor.module.css";

const COGNITO_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "5qup0una5tdma3l33pnn1gm87i";
const COGNITO_DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "posley.auth.us-east-1.amazoncognito.com";

type VenueQuote = { venue: string; symbol: string; bid: number | null; ask: number | null; bidQty: number | null; askQty: number | null; updatedAt: number | null; buyKoreaSellPerp: number | null; buyPerpSellKorea: number | null };
type Session = "PRE-MARKET" | "OPENING AUCTION" | "REGULAR" | "AFTER-HOURS OPENING" | "AFTER-HOURS" | "LUNCH" | "CLOSED";
type AdrQuote = { symbol: string; sharesPerAdr: number; source: string; marketState: string | null; bid: number | null; ask: number | null; last: number | null; bidQty: number | null; askQty: number | null; updatedAt: number | null; buyAdrSellPerp: number | null; buyPerpSellAdr: number | null };
type Row = { code: string; name: string; market: "KRX" | "TSE"; session: Session; currency: "KRW" | "JPY"; sharesPerPerp: number; cashBidKrw: number | null; cashAskKrw: number | null; cashLast: number | null; cashBidQty: number | null; cashAskQty: number | null; cashUpdatedAt: number | null; cashBidUsd: number | null; cashAskUsd: number | null; venues: VenueQuote[]; adr?: AdrQuote | null; mappingNote: string | null };
type FxBook = { source: string; bid: number | null; ask: number | null; last: number | null; updatedAt: number | null };
type Payload = { rows?: Row[]; sessions?: { KRX: Session; TSE: Session; US: Session }; fx?: FxBook; yenFx?: FxBook; posley?: { state: string; error: string; missing: string[]; source?: string }; timestamp?: number; error?: string };

const fmt = (value: number | null, digits = 2) => value === null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const time = (value: number | null) => value === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
const dateTime = (value: number | null) => value === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
const POLL_MS = 2_000;
const EDGE_MAX_AGE_MS = 60_000;
const isFresh = (timestamp: number | null | undefined, now: number) => Boolean(timestamp && now - timestamp <= EDGE_MAX_AGE_MS && timestamp - now < 5_000);
const adrSpreads = (row: Row, adr: AdrQuote, perp: VenueQuote) => {
  const scale = row.sharesPerPerp / adr.sharesPerAdr;
  const spreads = equitySpreads(adr.bid === null ? null : adr.bid * scale, adr.ask === null ? null : adr.ask * scale, perp);
  return { buyAdrSellPerp: spreads.buyKoreaSellPerp, buyPerpSellAdr: spreads.buyPerpSellKorea };
};

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
      adr: row.adr && (row.adr.bid !== null || row.adr.ask !== null || row.adr.last !== null) && (row.adr.updatedAt ?? 0) >= (prior.adr?.updatedAt ?? 0) ? row.adr : prior.adr ?? row.adr,
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
  const [marketFilter, setMarketFilter] = useState<"AUTO" | "ALL" | "KRX" | "TSE">("AUTO");
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

  const liveEdges = (payload.rows ?? []).flatMap((row) => {
    const fx = row.market === "TSE" ? payload.yenFx : payload.fx;
    const cashActive = row.session === "REGULAR" || row.market === "KRX" && row.session === "AFTER-HOURS";
    const basis = equityBasis({ bid: row.cashBidKrw, ask: row.cashAskKrw, last: row.cashLast }, fx ?? {}, row.sharesPerPerp,
      preferCashLast(row.market, row.session, row.cashUpdatedAt, clock));
    const cashEdges = cashActive && !basis.usesLast && !basis.usesFxLast && row.cashBidQty && row.cashAskQty && isFresh(row.cashUpdatedAt, clock) && isFresh(fx?.updatedAt, clock)
      ? row.venues.flatMap((quote) => {
        if (!isFresh(quote.updatedAt, clock) || !quote.bidQty || !quote.askQty) return [];
        const spreads = equitySpreads(basis.cashBidUsd, basis.cashAskUsd, quote);
        return [{ value: spreads.buyKoreaSellPerp, direction: `Buy ${row.market} · sell ${quote.venue}`, name: row.name, code: row.code, source: row.market === "KRX" ? "KRX route unverified" : "Live TSE BBO" },
          { value: spreads.buyPerpSellKorea, direction: `Buy ${quote.venue} · sell ${row.market}`, name: row.name, code: row.code, source: row.market === "KRX" ? "KRX route unverified" : "Live TSE BBO" }];
      }) : [];
    const adr = row.adr;
    const perp = row.venues.find((quote) => quote.venue === "Bitget");
    const adrActive = payload.sessions?.US === "REGULAR" && (!adr?.marketState || ["MORNING", "AFTERNOON", "REGULAR"].includes(adr.marketState.toUpperCase()));
    const adrBasis = adr && perp ? adrSpreads(row, adr, perp) : null;
    const adrEdges = adr && perp && adrActive && isFresh(adr.updatedAt, clock) && isFresh(perp.updatedAt, clock) && adr.bidQty && adr.askQty && perp.bidQty && perp.askQty
      ? [{ value: adrBasis?.buyAdrSellPerp ?? null, direction: `Buy ${adr.symbol} · sell Bitget`, name: row.name, code: row.code, source: "Live U.S. ADR BBO" },
        { value: adrBasis?.buyPerpSellAdr ?? null, direction: `Buy Bitget · sell ${adr.symbol}`, name: row.name, code: row.code, source: "Live U.S. ADR BBO" }] : [];
    return [...cashEdges, ...adrEdges].flatMap((edge) => edge.value !== null && edge.value > 0 ? [{ ...edge, value: edge.value }] : []);
  }).sort((left, right) => right.value - left.value);
  const activeCashRows = (payload.rows ?? []).filter((row) => row.session === "REGULAR" || row.market === "KRX" && row.session === "AFTER-HOURS");
  const activeAdrRows = payload.sessions?.US === "REGULAR" ? (payload.rows ?? []).filter((row) => row.adr) : [];
  const staleMarkets = (["KRX", "TSE"] as const).filter((market) => activeCashRows.some((row) => row.market === market) &&
    !activeCashRows.some((row) => row.market === market && row.cashBidKrw && row.cashAskKrw && row.cashBidQty && row.cashAskQty && isFresh(row.cashUpdatedAt, clock)));
  const requiredFx = (["KRX", "TSE"] as const).filter((market) => activeCashRows.some((row) => row.market === market)).flatMap((market) => {
    const fx = market === "KRX" ? payload.fx : payload.yenFx;
    return fx?.bid && fx.ask && isFresh(fx.updatedAt, clock) ? [] : [market === "KRX" ? "USD/KRW" : "USD/JPY"];
  });
  const staleAdr = activeAdrRows.length > 0 && !activeAdrRows.some((row) => row.adr?.bid && row.adr.ask && row.adr.bidQty && row.adr.askQty && isFresh(row.adr.updatedAt, clock));
  const activeRows = [...activeCashRows, ...activeAdrRows];
  const stalePerps = activeRows.length > 0 && !activeRows.some((row) => row.venues.some((quote) => quote.bid && quote.ask && quote.bidQty && quote.askQty && isFresh(quote.updatedAt, clock)));
  const feedProblems = [
    ...staleMarkets.map((market) => `${market} cash BBO stale or missing`),
    ...requiredFx.map((pair) => `${pair} executable FX BBO stale or missing`),
    ...(staleAdr ? ["U.S. ADR BBO stale or missing"] : []),
    ...(stalePerps ? ["perpetual BBO stale or missing"] : []),
  ];
  const radarMessage = feedProblems.length
    ? `Live comparison limited: ${feedProblems.join(" · ")}. Prices below are indicative until those feeds resume.`
    : activeCashRows.length || activeAdrRows.length
      ? "No positive edge on the currently fresh bid/ask routes. Fees and routing are not included."
      : "Cash and U.S. ADR markets are closed. Last quoted differences below are indicative.";
  const effectiveMarket = marketFilter === "AUTO" ? payload.sessions?.US === "REGULAR" && payload.sessions.TSE === "CLOSED" && payload.sessions.KRX === "CLOSED" ? "TSE" : "ALL" : marketFilter;
  const shownRows = (payload.rows ?? []).filter((row) => effectiveMarket === "ALL" || row.market === effectiveMarket);
  const koreaRows = shownRows.filter((row) => row.market === "KRX");
  const japanRows = shownRows.filter((row) => row.market === "TSE");

  const renderRow = (row: Row) => {
    const cashActive = row.session === "REGULAR" || row.market === "KRX" && row.session === "AFTER-HOURS";
    const fx = row.market === "TSE" ? payload.yenFx : payload.fx;
    const basis = equityBasis({ bid: row.cashBidKrw, ask: row.cashAskKrw, last: row.cashLast }, fx ?? {}, row.sharesPerPerp,
      preferCashLast(row.market, row.session, row.cashUpdatedAt, clock));
    const adr = row.adr;
    const perp = row.venues.find((quote) => quote.venue === "Bitget");
    const adrActive = payload.sessions?.US === "REGULAR" && (!adr?.marketState || ["MORNING", "AFTERNOON", "REGULAR"].includes(adr.marketState.toUpperCase()));
    const adrLive = Boolean(adr && perp && adrActive && isFresh(adr.updatedAt, clock) && isFresh(perp.updatedAt, clock) && adr.bidQty && adr.askQty && perp.bidQty && perp.askQty);
    const adrBasis = adr && perp ? adrSpreads(row, adr, perp) : null;
    const adrCard = adr && perp ? <div className={`${styles.referenceCard} ${styles.adrCard}`} key="adr">
      <div className={styles.referenceHead}><div><span className={styles.referenceTag}>U.S. ADR ↔ BITGET</span><strong>{adr.symbol} / {perp.symbol}</strong></div><span className={adrLive ? styles.livePill : styles.indicativePill}>{adrLive ? "LIVE US BBO" : `${payload.sessions?.US ?? "US"} · INDICATIVE`}</span></div>
      <div className={styles.referencePrices}><span>ADR BID / ASK <b>{fmt(adr.bid)} / {fmt(adr.ask)}</b></span><span>BITGET BID / ASK <b>{fmt(perp.bid)} / {fmt(perp.ask)}</b></span></div>
      <div className={styles.referenceEdges}><span className={(adrBasis?.buyAdrSellPerp ?? -1) > 0 ? styles.positive : ""}>BUY ADR · SELL PERP<b>{pct(adrBasis?.buyAdrSellPerp ?? null)}</b></span><span className={(adrBasis?.buyPerpSellAdr ?? -1) > 0 ? styles.positive : ""}>BUY PERP · SELL ADR<b>{pct(adrBasis?.buyPerpSellAdr ?? null)}</b></span></div>
      <small className={styles.referenceFoot}>1 ADR = {adr.sharesPerAdr} TSE {adr.sharesPerAdr === 1 ? "share" : "shares"} · 1 perp = {row.sharesPerPerp} · {adr.source} {time(adr.updatedAt)} HKT{!adrLive ? " · Last quotes only" : ""}</small>
    </div> : null;
    const cashCards = row.venues.map((quote) => {
      const spreads = equitySpreads(basis.cashBidUsd, basis.cashAskUsd, quote);
      const live = cashActive && !basis.usesLast && !basis.usesFxLast && Boolean(row.cashBidQty && row.cashAskQty && quote.bidQty && quote.askQty) && isFresh(row.cashUpdatedAt, clock) && isFresh(fx?.updatedAt, clock) && isFresh(quote.updatedAt, clock);
      return <div className={styles.referenceCard} key={quote.venue}>
        <div className={styles.referenceHead}><div><span className={styles.referenceTag}>{row.market} CASH ↔ {quote.venue.toUpperCase()}</span><strong>{quote.symbol}</strong></div><span className={live ? styles.livePill : styles.indicativePill}>{live ? row.session === "AFTER-HOURS" ? "AFTER-HOURS BBO" : "LIVE BBO" : `${row.session} · INDICATIVE`}</span></div>
        <div className={styles.referencePrices}><span>CASH · USD EQUIV <b>{fmt(basis.cashBidUsd)} / {fmt(basis.cashAskUsd)}</b></span><span>PERP BID / ASK <b>{fmt(quote.bid)} / {fmt(quote.ask)}</b></span></div>
        <div className={styles.referenceEdges}><span className={(spreads.buyKoreaSellPerp ?? -1) > 0 ? styles.positive : ""}>BUY {row.market} · SELL PERP<b>{pct(spreads.buyKoreaSellPerp)}</b></span><span className={(spreads.buyPerpSellKorea ?? -1) > 0 ? styles.positive : ""}>BUY PERP · SELL {row.market}<b>{pct(spreads.buyPerpSellKorea)}</b></span></div>
        <small className={styles.referenceFoot}>{quote.venue} {time(quote.updatedAt)} HKT · Top size {fmt(quote.bidQty)} / {fmt(quote.askQty)}{!live ? basis.usesLast ? " · Cash last / incomplete book" : row.session === "OPENING AUCTION" ? " · Auction book, not yet executable" : " · Indicative book" : ""}</small>
      </div>;
    });
    return <article className={styles.assetRow} key={row.code}>
      <div className={styles.identity}><small>{row.market} {row.code}</small><strong>{row.name}</strong><span className={styles.cashPrice}>{row.currency} {basis.usesLast && row.cashLast != null ? `${fmt(row.cashLast, 0)} last` : `${fmt(row.cashBidKrw, 0)} bid / ${fmt(row.cashAskKrw, 0)} ask`}</span><span className={styles.sessionLabel}>{row.session} · {dateTime(row.cashUpdatedAt)} HKT</span>{row.sharesPerPerp !== 1 && <em>1 perp = {row.sharesPerPerp} TSE shares</em>}</div>
      <div className={styles.references}>{row.market === "TSE" && adrActive && adrCard}{cashCards}{row.market === "TSE" && !adrActive && adrCard}</div>
      {row.mappingNote && <p className={styles.mapping}>{row.mappingNote}</p>}
    </article>;
  };

  return <section className={styles.monitor} aria-label="Korean and Japanese stock cross-venue basis">
    <header className={styles.monitorHeader}><div><p>KRX · TSE · U.S. ADR / PERPETUALS</p><h2>Stock cross-venue basis</h2><span>Live quote edges first. Closed-market comparisons remain visible and explicitly indicative.</span></div><div className={styles.status}><i />{payload.sessions ? `KRX ${payload.sessions.KRX} · TSE ${payload.sessions.TSE} · US ${payload.sessions.US}` : "CONNECTING"}</div></header>
    <div className={styles.signalDeck}><div className={styles.signalIntro}><span>LIVE QUOTE RADAR</span><strong>{liveEdges.length ? `${liveEdges.length} positive edges` : "No live positive edge"}</strong><small>Ranked from fresh bid/ask books only. Fees and routing are not included.</small></div><div className={styles.signalList}>{liveEdges.slice(0, 3).map((edge, index) => <div key={`${edge.code}:${edge.direction}`} className={styles.signalItem}><small>0{index + 1} · {edge.source}</small><strong>{edge.name}<b>{pct(edge.value)}</b></strong><span>{edge.direction}</span></div>)}{!liveEdges.length && <p>{radarMessage}</p>}</div></div>
    <div className={styles.toolRow}><div className={styles.filters} role="group" aria-label="Filter stock market">{(["ALL", "KRX", "TSE"] as const).map((market) => <button key={market} className={effectiveMarket === market ? styles.activeFilter : ""} onClick={() => setMarketFilter(market)}>{market === "ALL" ? "All stocks" : market === "KRX" ? "Korea" : "Japan + ADR"}</button>)}</div><div className={styles.fxGroup}><span>USD/KRW <b>{payload.fx?.bid != null && payload.fx?.ask != null ? `${fmt(payload.fx.bid)} / ${fmt(payload.fx.ask)}` : fmt(payload.fx?.last ?? null)}</b><small>{isFresh(payload.fx?.updatedAt, clock) && payload.fx?.bid && payload.fx.ask ? "LIVE BBO" : "LAST / INDICATIVE"}</small></span><span>USD/JPY <b>{payload.yenFx?.bid != null && payload.yenFx?.ask != null ? `${fmt(payload.yenFx.bid)} / ${fmt(payload.yenFx.ask)}` : fmt(payload.yenFx?.last ?? null)}</b><small>{isFresh(payload.yenFx?.updatedAt, clock) && payload.yenFx?.bid && payload.yenFx.ask ? "LIVE BBO" : payload.yenFx?.source.includes("index") ? "INDEX / INDICATIVE" : "LAST / INDICATIVE"}</small></span></div></div>
    {(loginError || error || payload.posley?.error) && <div className={styles.notice}><span>{loginError || error || payload.posley?.error}</span><button disabled={loginBusy} onClick={() => void connect()}>{loginBusy ? "Checking…" : "Connect Posley"}</button></div>}
    {koreaRows.length > 0 && <div className={styles.marketGroup}><div className={styles.groupHead}><div><span>01 / KOREA</span><h3>KRX cash vs perpetuals</h3></div><small>{payload.sessions?.KRX ?? "—"} · {koreaRows.length} names</small></div><div className={styles.rows}>{koreaRows.map(renderRow)}</div></div>}
    {japanRows.length > 0 && <div className={styles.marketGroup}><div className={styles.groupHead}><div><span>02 / JAPAN + U.S. NIGHT</span><h3>TSE cash &amp; U.S. ADR vs Bitget</h3></div><small>TSE {payload.sessions?.TSE ?? "—"} · US {payload.sessions?.US ?? "—"} · {japanRows.length} names</small></div><div className={styles.rows}>{japanRows.map(renderRow)}</div></div>}
    <footer>Positive percentages are gross quoted differences, not guaranteed arbitrage. U.S. ADR comparisons use verified share ratios and do not need USD/JPY; TSE comparisons do. Pre-market, closed and stale books are INDICATIVE. The KRX stream is not verified as NXT-routable. Confirm venue, fees, funding, borrow, tax and latency before trading.</footer>
  </section>;
}
