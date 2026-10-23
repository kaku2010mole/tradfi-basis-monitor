"use client";

import { useEffect, useState } from "react";
import { visiblePolling } from "../lib/visiblePolling";
import { decimalNumber } from "../lib/numberFormat";
import PageSwitcher from "./PageSwitcher";
import TaiwanStockPanel from "./TaiwanStockPanel";
import KoreanKrwPanel from "./KoreanKrwPanel";
import type { KoreanCloseReference } from "../lib/koreanPerpKrw";
import { equityBasis, equitySpreads, impliedAdrBook, perpetualPairBasis, preferCashLast } from "../lib/equityBasis";
import styles from "./KoreanPerpMonitor.module.css";

const COGNITO_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "5qup0una5tdma3l33pnn1gm87i";
const COGNITO_DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "posley.auth.us-east-1.amazoncognito.com";

type VenueQuote = { venue: string; symbol: string; sharesPerPerp?: number; bid: number | null; ask: number | null; bidQty: number | null; askQty: number | null; updatedAt: number | null; buyKoreaSellPerp: number | null; buyPerpSellKorea: number | null };
type Session = "PRE-MARKET" | "OPENING AUCTION" | "REGULAR" | "AFTER-HOURS OPENING" | "AFTER-HOURS" | "LUNCH" | "CLOSED";
type AdrQuote = { symbol: string; sharesPerAdr: number; source: string; marketState: string | null; bid: number | null; ask: number | null; last: number | null; bidQty: number | null; askQty: number | null; updatedAt: number | null };
type Row = { previousClose?: KoreanCloseReference | null; strictCashBook?: boolean; code: string; name: string; chineseName?: string | null; cashSource?: string; showPerpQuote?: boolean; market: "KRX" | "TSE"; session: Session; currency: "KRW" | "JPY"; sharesPerPerp: number; cashBidKrw: number | null; cashAskKrw: number | null; cashLast: number | null; cashBidQty: number | null; cashAskQty: number | null; cashUpdatedAt: number | null; cashBidUsd: number | null; cashAskUsd: number | null; venues: VenueQuote[]; adr?: AdrQuote | null; perpPair?: { leftSymbol: string; rightSymbol: string } | null; mappingNote: string | null };
type FxBook = { source: string; bid: number | null; ask: number | null; last: number | null; updatedAt: number | null };
type BitgetOnlyKorean = { code: string; name: string; chineseName: string; symbol: string; bid: number | null; ask: number | null; last: number | null; updatedAt: number | null; impliedBidKrw: number | null; impliedAskKrw: number | null; impliedLastKrw: number | null };
type KrwConversion = { rate: number | null; source: string; date: string | null; updatedAt: number | null; live: boolean };
type Payload = { rows?: Row[]; bitgetOnlyKorean?: BitgetOnlyKorean[]; krwConversion?: KrwConversion; sessions?: { KRX: Session; TSE: Session; US: Session }; fx?: FxBook; yenFx?: FxBook; posley?: { state: string; error: string; missing: string[]; source?: string }; timestamp?: number; error?: string };

const fmt = (value: number | null, digits = 2) => value === null ? "—" : decimalNumber(value, digits, digits);
const pct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateTimeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const time = (value: number | null) => value === null ? "—" : timeFormat.format(value);
const dateTime = (value: number | null) => value === null ? "—" : dateTimeFormat.format(value);
const POLL_MS = 2_000;
const EDGE_MAX_AGE_MS = 60_000;
const isFresh = (timestamp: number | null | undefined, now: number) => Boolean(timestamp && now - timestamp <= EDGE_MAX_AGE_MS && timestamp - now < 5_000);
const quoteKey = (quote: VenueQuote) => `${quote.venue}:${quote.symbol}`;
const perpComparison = (row: Row, now: number) => {
  if (!row.perpPair) return null;
  const left = row.venues.find((quote) => quote.venue === "Bitget" && quote.symbol === row.perpPair?.leftSymbol);
  const right = row.venues.find((quote) => quote.venue === "Bitget" && quote.symbol === row.perpPair?.rightSymbol);
  if (!left || !right) return null;
  const basis = perpetualPairBasis({ ...left, sharesPerPerp: left.sharesPerPerp ?? row.sharesPerPerp },
    { ...right, sharesPerPerp: right.sharesPerPerp ?? row.sharesPerPerp }, now, EDGE_MAX_AGE_MS);
  const directions = [
    { value: basis.buyLeftSellRight, direction: `Buy ${left.symbol} · sell ${right.symbol}` },
    { value: basis.buyRightSellLeft, direction: `Buy ${right.symbol} · sell ${left.symbol}` },
  ];
  const headline = directions.filter((edge): edge is { value: number; direction: string } => edge.value !== null).sort((a, b) => b.value - a.value)[0];
  return { ...basis, left, right, directions, headline };
};
const adrSpreads = (row: Row, adr: AdrQuote, perp: VenueQuote) => {
  const scale = (perp.sharesPerPerp ?? row.sharesPerPerp) / adr.sharesPerAdr;
  const spreads = equitySpreads(adr.bid === null ? null : adr.bid * scale, adr.ask === null ? null : adr.ask * scale, perp);
  return { buyAdrSellPerp: spreads.buyKoreaSellPerp, buyPerpSellAdr: spreads.buyPerpSellKorea };
};
type SpreadTone = "quiet" | "medium" | "high";
// Spread magnitude controls color independently of whether the quote is live or indicative.
const spreadTone = (value: number | null | undefined): SpreadTone =>
  value == null || value <= 0 ? "quiet" : value >= 1 ? "high" : value >= 0.5 ? "medium" : "quiet";
const strongerTone = (left: SpreadTone, right: SpreadTone): SpreadTone =>
  left === "high" || right === "high" ? "high" : left === "medium" || right === "medium" ? "medium" : "quiet";
const toneClass = (tone: SpreadTone) => tone === "high" ? styles.spreadHigh : tone === "medium" ? styles.spreadMedium : styles.spreadQuiet;

function mergeRows(previous: Row[] = [], incoming: Row[] = []) {
  const priorByCode = new Map(previous.map((row) => [row.code, row]));
  return incoming.map((row) => {
    const prior = priorByCode.get(row.code);
    if (!prior) return row;
    const cash = (row.cashLast != null || row.cashBidKrw != null || row.cashAskKrw != null) && (row.cashUpdatedAt ?? 0) >= (prior.cashUpdatedAt ?? 0) ? row : prior;
    const priorVenues = new Map(prior.venues.map((quote) => [quoteKey(quote), quote]));
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
        const older = priorVenues.get(quoteKey(quote));
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
  sessionStorage.setItem("equity_monitor_return_to", "/stock-basis");
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
  const [marketFilter, setMarketFilter] = useState<"ALL" | "KRX" | "TSE" | "TWSE">("ALL");
  useEffect(() => {
    let stopped = false, inFlight = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), 20_000);
      try {
        const token = await browserIdToken();
        if (stopped || request.signal.aborted) return;
        const response = await fetch("/api/oracle-monitor/korean-bitget", { cache: "no-store", signal: request.signal, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
        const next = await response.json() as Payload;
        if (!response.ok) throw new Error(next.error || "Korean stock feed unavailable.");
        if (stopped) return;
        setPayload((previous) => ({
          ...next,
          fx: next.fx && (next.fx.bid !== null || next.fx.ask !== null || next.fx.last !== null) ? next.fx : previous.fx,
          yenFx: next.yenFx && (next.yenFx.bid !== null || next.yenFx.ask !== null || next.yenFx.last !== null) ? next.yenFx : previous.yenFx,
          rows: mergeRows(previous.rows, next.rows),
        }));
        setError("");
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : "Feeds reconnecting."); }
      finally { clearTimeout(timeout); if (!stopped) setClock(Date.now()); inFlight = false; }
    };
    const stopPolling = visiblePolling((resumed) => {
      // Normal completed requests batch clock + quote state into one render.
      // Resume/slow requests still age stale books immediately.
      if (resumed || inFlight) setClock(Date.now());
      void load();
    }, POLL_MS);
    return () => { stopped = true; stopPolling(); controller?.abort(); };
  }, []);

  const connect = async () => {
    setLoginBusy(true); setLoginError("");
    try { await beginPosleyLogin(); }
    catch (reason) { setLoginError(reason instanceof Error ? reason.message : "Posley login is unavailable."); setLoginBusy(false); }
  };

  const liveEdges = (payload.rows ?? []).flatMap((row) => {
    const fx = row.market === "TSE" ? payload.yenFx : payload.fx;
    const cashActive = row.session === "REGULAR" || row.market === "KRX" && row.session === "AFTER-HOURS";
    const cashEdges = cashActive && row.cashBidQty && row.cashAskQty && isFresh(row.cashUpdatedAt, clock) && isFresh(fx?.updatedAt, clock)
      ? row.venues.flatMap((quote) => {
        if (!isFresh(quote.updatedAt, clock) || !quote.bidQty || !quote.askQty) return [];
        const basis = equityBasis({ bid: row.cashBidKrw, ask: row.cashAskKrw, last: row.cashLast }, fx ?? {}, quote.sharesPerPerp ?? row.sharesPerPerp,
          preferCashLast(row.market, row.session, row.cashUpdatedAt, clock), row.strictCashBook);
        if (basis.usesLast || basis.usesFxLast) return [];
        const spreads = equitySpreads(basis.cashBidUsd, basis.cashAskUsd, quote);
        return [{ value: spreads.buyKoreaSellPerp, direction: `Buy ${row.market} · sell ${quote.venue} ${quote.symbol}`, name: row.name, code: row.code, source: row.market === "KRX" ? "KRX route unverified" : "Live TSE BBO" },
          { value: spreads.buyPerpSellKorea, direction: `Buy ${quote.venue} ${quote.symbol} · sell ${row.market}`, name: row.name, code: row.code, source: row.market === "KRX" ? "KRX route unverified" : "Live TSE BBO" }];
      }) : [];
    const adr = row.adr;
    const adrActive = payload.sessions?.US === "REGULAR" && (!adr?.marketState || ["MORNING", "AFTERNOON", "REGULAR"].includes(adr.marketState.toUpperCase()));
    const adrEdges = adr && adrActive && isFresh(adr.updatedAt, clock) && adr.bidQty && adr.askQty
      ? row.venues.flatMap((perp) => {
        if (!isFresh(perp.updatedAt, clock) || !perp.bidQty || !perp.askQty) return [];
        const adrBasis = adrSpreads(row, adr, perp);
        return [{ value: adrBasis.buyAdrSellPerp, direction: `Buy ${adr.symbol} · sell ${perp.venue} ${perp.symbol}`, name: row.name, code: row.code, source: "Live U.S. ADR BBO" },
          { value: adrBasis.buyPerpSellAdr, direction: `Buy ${perp.venue} ${perp.symbol} · sell ${adr.symbol}`, name: row.name, code: row.code, source: "Live U.S. ADR BBO" }];
      }) : [];
    const pair = perpComparison(row, clock);
    const perpEdges = pair?.live ? pair.directions.map((edge) => ({ ...edge, name: row.name, code: row.code, source: "Bitget JP ↔ ADR perps" })) : [];
    return [...cashEdges, ...adrEdges, ...perpEdges].flatMap((edge) => edge.value !== null && edge.value > 0 ? [{ ...edge, value: edge.value }] : []);
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
    : activeCashRows.length || activeAdrRows.length || (payload.rows ?? []).some((row) => perpComparison(row, clock)?.live)
      ? "No positive edge on the currently fresh bid/ask routes. Fees and routing are not included."
      : "No fresh comparable BBO route. Cash/ADR and retained perp differences below are indicative.";
  const effectiveMarket = marketFilter;
  const shownRows = (payload.rows ?? []).filter((row) => effectiveMarket === "ALL" || row.market === effectiveMarket);
  const koreaRows = shownRows.filter((row) => row.market === "KRX");
  const japanRows = shownRows.filter((row) => row.market === "TSE");
  const bitgetOnlyKorean = effectiveMarket === "ALL" || effectiveMarket === "KRX" ? payload.bitgetOnlyKorean ?? [] : [];
  const krwConversion = payload.krwConversion;

  const renderRow = (row: Row) => {
    const cashActive = row.session === "REGULAR" || row.market === "KRX" && row.session === "AFTER-HOURS";
    const fx = row.market === "TSE" ? payload.yenFx : payload.fx;
    const basis = equityBasis({ bid: row.cashBidKrw, ask: row.cashAskKrw, last: row.cashLast }, fx ?? {}, row.sharesPerPerp,
      preferCashLast(row.market, row.session, row.cashUpdatedAt, clock), row.strictCashBook);
    const displayLast = basis.usesLast && row.cashLast != null &&
      (!row.strictCashBook || row.cashBidKrw === null && row.cashAskKrw === null);
    const adr = row.adr;
    const adrActive = payload.sessions?.US === "REGULAR" && (!adr?.marketState || ["MORNING", "AFTERNOON", "REGULAR"].includes(adr.marketState.toUpperCase()));
    const adrComparisons = adr ? row.venues.filter((quote) => quote.venue === "Bitget").map((perp) => ({
      perp, spreads: adrSpreads(row, adr, perp), implied: impliedAdrBook(perp, perp.sharesPerPerp ?? row.sharesPerPerp, adr.sharesPerAdr),
      live: Boolean(adrActive && isFresh(adr.updatedAt, clock) && isFresh(perp.updatedAt, clock) && adr.bidQty && adr.askQty && perp.bidQty && perp.askQty),
    })) : [];
    const adrLive = adrComparisons.some(({ live }) => live);
    const adrHeadline = adrComparisons.filter(({ live }) => live).flatMap(({ perp, spreads }) => [
      { value: spreads.buyAdrSellPerp, direction: `Buy ${adr?.symbol} · sell ${perp.symbol}` },
      { value: spreads.buyPerpSellAdr, direction: `Buy ${perp.symbol} · sell ${adr?.symbol}` },
    ]).filter((edge): edge is { value: number; direction: string } => edge.value !== null).sort((left, right) => right.value - left.value)[0];
    const impliedHeadline = adrComparisons[0]?.implied;
    const impliedMid = impliedHeadline?.bid != null && impliedHeadline.ask != null ? (impliedHeadline.bid + impliedHeadline.ask) / 2 : impliedHeadline?.bid ?? impliedHeadline?.ask ?? null;
    const adrTone = adrComparisons.reduce<SpreadTone>((tone, { spreads }) => strongerTone(tone,
      strongerTone(spreadTone(spreads.buyAdrSellPerp), spreadTone(spreads.buyPerpSellAdr))), "quiet");
    const cashComparisons = row.venues.map((quote) => {
      const quoteBasis = equityBasis({ bid: row.cashBidKrw, ask: row.cashAskKrw, last: row.cashLast }, fx ?? {}, quote.sharesPerPerp ?? row.sharesPerPerp,
        preferCashLast(row.market, row.session, row.cashUpdatedAt, clock), row.strictCashBook);
      const spreads = equitySpreads(quoteBasis.cashBidUsd, quoteBasis.cashAskUsd, quote);
      const live = cashActive && !quoteBasis.usesLast && !quoteBasis.usesFxLast && Boolean(row.cashBidQty && row.cashAskQty && quote.bidQty && quote.askQty) && isFresh(row.cashUpdatedAt, clock) && isFresh(fx?.updatedAt, clock) && isFresh(quote.updatedAt, clock);
      const tone = strongerTone(spreadTone(spreads.buyKoreaSellPerp), spreadTone(spreads.buyPerpSellKorea));
      return { quote, basis: quoteBasis, spreads, live, tone };
    });
    const cashSummaryLive = cashComparisons.some(({ live }) => live);
    const headlineComparisons = cashSummaryLive ? cashComparisons.filter(({ live }) => live) : cashComparisons;
    const cashHeadline = headlineComparisons.flatMap(({ quote, spreads }) => [
      { value: spreads.buyKoreaSellPerp, direction: `Buy ${row.market} · sell ${quote.symbol}` },
      { value: spreads.buyPerpSellKorea, direction: `Buy ${quote.symbol} · sell ${row.market}` },
    ]).filter((edge): edge is { value: number; direction: string } => edge.value !== null).sort((left, right) => right.value - left.value)[0];
    const cashTone = spreadTone(cashHeadline?.value);
    const pair = perpComparison(row, clock);
    const perpTone = spreadTone(pair?.headline?.value);
    const rowTone = strongerTone(strongerTone(cashTone, adrTone), perpTone);
    const perpCard = pair && <div className={`${styles.referenceCard} ${styles.perpPairCard} ${toneClass(perpTone)}`}>
      <div className={styles.referenceHead}><div><span className={styles.referenceTag}>BITGET · JP PERP ↔ ADR-LINKED PERP</span><strong>{pair.left.symbol} / {pair.right.symbol}</strong></div><span className={pair.live ? styles.livePill : styles.indicativePill}>{pair.live ? "LIVE PERP BBO" : "STALE / INCOMPLETE BBO"}</span></div>
      <div className={styles.referencePrices}><span>{pair.left.symbol} · BID / ASK<b>{fmt(pair.left.bid, 3)} / {fmt(pair.left.ask, 3)} USDT</b><small>{time(pair.left.updatedAt)} HKT · Size {fmt(pair.left.bidQty)} / {fmt(pair.left.askQty)}</small></span><span>{pair.right.symbol} · BID / ASK<b>{fmt(pair.right.bid, 3)} / {fmt(pair.right.ask, 3)} USDT</b><small>{time(pair.right.updatedAt)} HKT · Size {fmt(pair.right.bidQty)} / {fmt(pair.right.askQty)}</small></span></div>
      <div className={styles.referenceEdges}>{pair.directions.map((edge) => <span key={edge.direction} className={toneClass(spreadTone(edge.value))}>{edge.direction}<b>{pct(edge.value)}</b></span>)}</div>
      <small className={styles.referenceFoot}>Perp/perp basis · 1 {pair.left.symbol} ↔ {fmt((pair.left.sharesPerPerp ?? row.sharesPerPerp) / (pair.right.sharesPerPerp ?? row.sharesPerPerp), 3)} {pair.right.symbol} · No live cash, ADR or FX feed required · Gross, before fees/funding{!pair.live ? " · Indicative only" : ""}</small>
    </div>;
    const adrCards = adrComparisons.map(({ perp, spreads, implied, live }) => <div className={`${styles.referenceCard} ${styles.adrCard} ${toneClass(strongerTone(spreadTone(spreads.buyAdrSellPerp), spreadTone(spreads.buyPerpSellAdr)))}`} key={`adr:${perp.symbol}`}>
      <div className={styles.referenceHead}><div><span className={styles.referenceTag}>U.S. ADR ↔ BITGET</span><strong>{adr?.symbol} / {perp.symbol}</strong></div><span className={live ? styles.livePill : styles.indicativePill}>{live ? "LIVE US BBO" : "IMPLIED · NO LIVE ADR EDGE"}</span></div>
      <div className={styles.referencePrices}><span>IMPLIED ADR BID / ASK <b>{fmt(implied.bid)} / {fmt(implied.ask)}</b></span><span>ADR MARKET BID / ASK <b>{fmt(adr?.bid ?? null)} / {fmt(adr?.ask ?? null)}</b></span></div>
      <div className={styles.referenceEdges}><span className={toneClass(spreadTone(spreads.buyAdrSellPerp))}>BUY ADR · SELL PERP<b>{pct(spreads.buyAdrSellPerp)}</b></span><span className={toneClass(spreadTone(spreads.buyPerpSellAdr))}>BUY PERP · SELL ADR<b>{pct(spreads.buyPerpSellAdr)}</b></span></div>
      <small className={styles.referenceFoot}>1 ADR = {adr?.sharesPerAdr} TSE shares · 1 {perp.symbol} = {perp.sharesPerPerp ?? row.sharesPerPerp} TSE shares · implied = perp × ADR shares / perp shares · {adr?.source}{!live ? " · Indicative only" : ""}</small>
    </div>);
    const cashCards = cashComparisons.map(({ quote, basis: quoteBasis, spreads, live, tone }) => {
      return <div className={`${styles.referenceCard} ${toneClass(tone)}`} key={quoteKey(quote)}>
        <div className={styles.referenceHead}><div><span className={styles.referenceTag}>{row.market} CASH ↔ {quote.venue.toUpperCase()}</span><strong>{quote.symbol}</strong></div><span className={live ? styles.livePill : styles.indicativePill}>{live ? row.session === "AFTER-HOURS" ? "AFTER-HOURS BBO" : "LIVE BBO" : `${row.session} · INDICATIVE`}</span></div>
        <div className={styles.referencePrices}><span>CASH · USD EQUIV <b>{fmt(quoteBasis.cashBidUsd)} / {fmt(quoteBasis.cashAskUsd)}</b></span><span>PERP BID / ASK <b>{fmt(quote.bid)} / {fmt(quote.ask)}</b></span></div>
        <div className={styles.referenceEdges}><span className={toneClass(spreadTone(spreads.buyKoreaSellPerp))}>BUY {row.market} · SELL PERP<b>{pct(spreads.buyKoreaSellPerp)}</b></span><span className={toneClass(spreadTone(spreads.buyPerpSellKorea))}>BUY PERP · SELL {row.market}<b>{pct(spreads.buyPerpSellKorea)}</b></span></div>
        <small className={styles.referenceFoot}>{quote.venue} {time(quote.updatedAt)} HKT · 1 perp = {quote.sharesPerPerp ?? row.sharesPerPerp} ordinary shares · Top size {fmt(quote.bidQty)} / {fmt(quote.askQty)}{!live ? quoteBasis.usesLast ? " · Cash last / incomplete book" : row.session === "OPENING AUCTION" ? " · Auction book, not yet executable" : " · Indicative book" : ""}</small>
      </div>;
    });
    return <details className={`${styles.assetRow} ${row.market === "KRX" ? styles.koreaRow : styles.japanRow} ${rowTone === "high" ? styles.highSpreadRow : rowTone === "medium" ? styles.mediumSpreadRow : ""}`} key={row.code}>
      <summary className={styles.assetSummary}>
        <span className={styles.summaryIdentity}><small>{row.market} {row.code} · {row.session}</small><strong>{row.name}</strong>{row.chineseName && <small>{row.chineseName}</small>}<em>{row.currency} {displayLast ? `${fmt(row.cashLast, 0)} last` : `${fmt(row.cashBidKrw, 0)} / ${fmt(row.cashAskKrw, 0)}`}</em></span>
        <span className={styles.summarySignals}>
          {row.showPerpQuote && row.venues.map((quote) => <span className={styles.perpSignal} key={quoteKey(quote)}><small>{quote.venue.toUpperCase()} PERP · {isFresh(quote.updatedAt, clock) && quote.bid != null && quote.ask != null ? "LIVE BBO" : "STALE / INCOMPLETE"}</small><strong>{fmt(quote.bid)} / {fmt(quote.ask)} USDT</strong><em>{quote.symbol} · bid / ask · not cash</em></span>)}
          {pair && <span className={`${styles.perpSignal} ${toneClass(perpTone)}`}><small>BITGET PERP / PERP · {pair.live ? "LIVE" : "INDICATIVE"}</small><strong>{pct(pair.headline?.value ?? null)}</strong><em>{pair.headline?.direction ?? `${pair.left.symbol} / ${pair.right.symbol} · waiting for BBO`}</em></span>}
          <span className={`${styles.cashSignal} ${toneClass(cashTone)}`}><small>{row.market} CASH · {cashSummaryLive ? "BBO" : "INDICATIVE"}</small><strong>{pct(cashHeadline?.value ?? null)}</strong><em>{cashHeadline?.direction ?? "No comparable cash quote"}</em></span>
          {adr && <span className={`${styles.adrSignal} ${toneClass(adrTone)}`}><small>U.S. ADR {adr.symbol} · {adrLive ? "LIVE" : "IMPLIED USD"}</small><strong>{adrHeadline ? pct(adrHeadline.value) : fmt(impliedMid)}</strong><em>{adrHeadline?.direction ?? `Bitget-implied ADR bid / ask ${fmt(impliedHeadline?.bid ?? null)} / ${fmt(impliedHeadline?.ask ?? null)} · no ADR spread`}</em></span>}
        </span><span className={styles.summaryToggle}>Details <b>⌄</b></span>
      </summary>
      <div className={styles.assetDetails}><div className={styles.identity}><small>{row.market} {row.code}</small><strong>{row.name}</strong>{row.chineseName && <span>{row.chineseName}</span>}<span className={styles.cashPrice}>{row.currency} {displayLast ? `${fmt(row.cashLast, 0)} last` : `${fmt(row.cashBidKrw, 0)} bid / ${fmt(row.cashAskKrw, 0)} ask`}</span><span className={styles.sessionLabel}>{row.session} · {dateTime(row.cashUpdatedAt)} HKT{row.cashSource ? ` · ${row.cashSource}` : ""}</span></div>
        <div className={styles.references}>{perpCard}{row.market === "TSE" && adrActive && adrCards}{cashCards}{row.market === "TSE" && !adrActive && adrCards}</div>
        {row.mappingNote && <p className={styles.mapping}>{row.mappingNote}</p>}</div>
    </details>;
  };

  return <section className={styles.monitor} aria-label="Korean, Japanese and Taiwanese stock cross-venue basis">
    <header className={styles.monitorHeader}><div><p>KRX · TSE · TWSE · U.S. ADR / PERPETUALS</p><h1>Stock cross-venue basis</h1><span>Live quote edges first. Closed-market and Taiwan anchor comparisons are explicitly indicative.</span></div><div className={styles.monitorActions}><div className={styles.status}><i />{payload.sessions ? `KRX ${payload.sessions.KRX} · TSE ${payload.sessions.TSE} · US ${payload.sessions.US}` : "CONNECTING"}</div><PageSwitcher active="stock-basis" /></div></header>
    {effectiveMarket !== "TWSE" && <div className={styles.signalDeck}><div className={styles.signalIntro}><span>LIVE QUOTE RADAR</span><strong>{liveEdges.length ? `${liveEdges.length} positive edges` : "No live positive edge"}</strong><small>Card colors: positive spreads ≥1% amber, ≥0.5% teal, including closed-market comparisons. Radar ranks live edges only; INDICATIVE is not executable.</small></div><div className={styles.signalList}>{liveEdges.slice(0, 3).map((edge, index) => <div key={`${edge.code}:${edge.direction}`} className={`${styles.signalItem} ${toneClass(spreadTone(edge.value))}`}><small>0{index + 1} · {edge.source}</small><strong>{edge.name}<b>{pct(edge.value)}</b></strong><span>{edge.direction}</span></div>)}{!liveEdges.length && <p>{radarMessage}</p>}</div></div>}
    <div className={styles.toolRow}><div className={styles.filters} role="group" aria-label="Filter stock market">{(["ALL", "KRX", "TSE", "TWSE"] as const).map((market) => <button key={market} className={effectiveMarket === market ? styles.activeFilter : ""} onClick={() => setMarketFilter(market)}>{market === "ALL" ? "All stocks" : market === "KRX" ? "Korea" : market === "TWSE" ? "Taiwan" : "Japan + ADR"}</button>)}</div><div className={styles.fxGroup}><span>USD/KRW <b>{payload.fx?.bid != null && payload.fx?.ask != null ? `${fmt(payload.fx.bid)} / ${fmt(payload.fx.ask)}` : fmt(payload.fx?.last ?? null)}</b><small>{isFresh(payload.fx?.updatedAt, clock) && payload.fx?.bid && payload.fx.ask ? "LIVE BBO" : "LAST / INDICATIVE"}</small></span><span>USD/JPY <b>{payload.yenFx?.bid != null && payload.yenFx?.ask != null ? `${fmt(payload.yenFx.bid)} / ${fmt(payload.yenFx.ask)}` : fmt(payload.yenFx?.last ?? null)}</b><small>{isFresh(payload.yenFx?.updatedAt, clock) && payload.yenFx?.bid && payload.yenFx.ask ? "LIVE BBO" : payload.yenFx?.source.includes("index") ? "INDEX / INDICATIVE" : "LAST / INDICATIVE"}</small></span></div></div>
    {effectiveMarket !== "TWSE" && (loginError || error || payload.posley?.error) && <div className={styles.notice}><span>{loginError || error || payload.posley?.error}</span><button disabled={loginBusy} onClick={() => void connect()}>{loginBusy ? "Checking…" : "Connect Posley"}</button></div>}
    {(koreaRows.length > 0 || bitgetOnlyKorean.length > 0) && <div className={styles.marketGroup}><div className={styles.groupHead}><div><span>01 / KOREA</span><h3>KRX cash vs perpetuals</h3></div><small>{payload.sessions?.KRX ?? "—"} · {koreaRows.length} cash comparisons</small></div><div className={styles.rows}>{koreaRows.map(renderRow)}</div>
      {bitgetOnlyKorean.length > 0 && <div className={styles.perpOnlyBlock}><div className={styles.perpOnlyHead}><div><span>BITGET ONLY · CURRENCY CONVERSION</span><h4>New Korean stock perpetuals</h4><p>No live KRX cash quote for these names. The KRW amount is a converted Bitget contract-unit price, not a cash-stock quote or basis signal.</p></div><small>USD/KRW {fmt(krwConversion?.rate ?? null)} · {krwConversion?.live ? "LIVE FX" : krwConversion?.date ? `DAILY REFERENCE ${krwConversion.date}` : "FX UNAVAILABLE"}</small></div>
        <div className={styles.perpOnlyGrid}>{bitgetOnlyKorean.map((stock) => { const quoteFresh = isFresh(stock.updatedAt, clock); const hasBook = stock.bid !== null && stock.ask !== null; return <details className={styles.perpOnlyCard} key={stock.code}><summary className={styles.perpOnlySummary}><span><small>KRX {stock.code} · {stock.symbol}</small><strong>{stock.chineseName}</strong><em>{stock.name}</em></span><span><small>BITGET {quoteFresh ? "LIVE" : "STALE"}</small><strong>{hasBook ? `${fmt(stock.bid, 2)} / ${fmt(stock.ask, 2)}` : fmt(stock.last, 2)} USDT</strong><em>{hasBook ? "bid / ask" : "last"}</em></span><span className={styles.perpOnlySummaryKrw}><small>KRW EQUIVALENT</small><strong>{hasBook ? `${fmt(stock.impliedBidKrw, 0)} / ${fmt(stock.impliedAskKrw, 0)}` : fmt(stock.impliedLastKrw, 0)}</strong><em>{krwConversion?.live ? "live FX" : "reference FX"} · not cash</em></span><b aria-hidden="true">⌄</b></summary><div className={styles.perpOnlyDetail}><div className={styles.perpOnlyIdentity}><div><small>KRX {stock.code} · {stock.symbol}</small><strong>{stock.chineseName}</strong><span>{stock.name}</span></div><em className={quoteFresh ? styles.livePill : styles.indicativePill}>{quoteFresh ? "BITGET LIVE" : "BITGET STALE"}</em></div><div className={styles.perpOnlyPrices}><span>BITGET · USDT <b>{hasBook ? `${fmt(stock.bid, 4)} / ${fmt(stock.ask, 4)}` : fmt(stock.last, 4)}</b><small>{hasBook ? "bid / ask" : "last"}</small></span><span>KRW EQUIVALENT <b>{hasBook ? `${fmt(stock.impliedBidKrw, 0)} / ${fmt(stock.impliedAskKrw, 0)}` : fmt(stock.impliedLastKrw, 0)}</b><small>{hasBook ? "converted bid / ask" : "converted last"}</small></span></div><div className={styles.perpOnlyFoot}>Bitget {dateTime(stock.updatedAt)} HKT · 1 USDT ≈ 1 USD · {krwConversion?.source ?? "FX unavailable"}</div></div></details>; })}</div>
        <p className={styles.perpOnlyNote}>Converted per Bitget contract unit; contract-to-share ratios are not verified. A daily FX reference is indicative and not an executable FX quote. No cash/perp spread is calculated.</p></div>}
      <KoreanKrwPanel rows={koreaRows} conversion={krwConversion} now={clock} />
    </div>}
    {japanRows.length > 0 && <div className={styles.marketGroup}><div className={styles.groupHead}><div><span>02 / JAPAN + U.S. NIGHT</span><h3>TSE cash &amp; U.S. ADR vs Bitget</h3></div><small>TSE {payload.sessions?.TSE ?? "—"} · US {payload.sessions?.US ?? "—"} · {japanRows.length} names</small></div><div className={styles.rows}>{japanRows.map(renderRow)}</div></div>}
    <TaiwanStockPanel visible={effectiveMarket === "ALL" || effectiveMarket === "TWSE"} />
    <footer>Positive percentages are gross quoted differences, not guaranteed arbitrage. Japanese U.S. ADR comparisons use verified share ratios and do not need USD/JPY; TSE comparisons do. Taiwan cash/FX and oracle/ADR-return model comparisons are separate indicative views; Taiwan is excluded from the live quote radar. Pre-market, closed and stale books are INDICATIVE. The KRX stream is not verified as NXT-routable. Confirm venue, fees, funding, borrow, tax and latency before trading.</footer>
  </section>;
}
