import zhongjiSeed from "../data/zhongjiOpeningStudy.json";
import gigadevSeed from "../data/gigadevOpeningStudy.json";
import { dayKey, hkClose, nextSmicWindow, usClose, usOpen } from "./smicOpening";
import type { SmicBar, SmicWindow } from "./smicOpening";
import { alignedPeerRows, PEER_ASSETS, peerEstimate, peerStudy } from "./hkPeerOpening";
import type { PeerAsset, PeerRow } from "./hkPeerOpening";
import type { SmicLiveQuote } from "./smicOpeningMarket";
import { posleyAdrSnapshot } from "./posleyAdr";

type QuoteRecord = { symbol?: string; bid?: number | null; ask?: number | null; marketTimestamp?: number | null };
const SEEDS = { zhongji: zhongjiSeed, gigadev: gigadevSeed };
function initialState(asset: PeerAsset) {
  const seed = SEEDS[asset];
  return { rows: seed.rows as PeerRow[], bars: seed.bars as Record<string, SmicBar[]>, asOf: seed.asOf,
    fetchedAt: 0, retryAt: 0, pending: null as Promise<void> | null, error: "", version: 0,
    sessionPending: null as Promise<void> | null, sessionRetryAt: 0, sessionError: "",
    modelCache: null as { key: string; value: ReturnType<typeof peerStudy> } | null };
}
type Root = typeof globalThis & {
  __FUTU_PUSH_SNAPSHOT__?: { receivedAt: number; payload: { quotes?: QuoteRecord[] } };
  __HK_PEER_OPENING_MARKET__?: Partial<Record<PeerAsset, ReturnType<typeof initialState>>>;
};
function shared(asset: PeerAsset) {
  const states = (globalThis as Root).__HK_PEER_OPENING_MARKET__ ??= {};
  return states[asset] ??= initialState(asset);
}
type YahooResult = { meta?: { symbol?: string; longName?: string }; timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> } };
export function parsePeerDaily(payload: unknown, symbol: string, asset: PeerAsset, now: number, minRows = 1): SmicBar[] {
  const result = (payload as { chart?: { result?: YahooResult[] } })?.chart?.result?.[0];
  const config = PEER_ASSETS[asset], hk = symbol === config.yahoo;
  if (result?.meta?.symbol !== symbol || !result.timestamp?.length) throw new Error("Invalid daily history.");
  if (hk && result.meta.longName && !result.meta.longName.toLowerCase().includes(asset === "zhongji" ? "zhongji" : "gigadevice")) throw new Error("Unexpected HK issuer.");
  const q = result.indicators?.quote?.[0];
  const bars = result.timestamp.flatMap((t, i) => {
    const open = q?.open?.[i], close = q?.close?.[i], volume = q?.volume?.[i];
    if (typeof open !== "number" || typeof close !== "number" || !Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0 || !(Number(volume) > 0)) return [];
    const date = dayKey(t * 1000, hk ? "Asia/Hong_Kong" : "America/New_York");
    if (hk && date < config.listed) return [];
    return [{ date, open, close, complete: now >= (hk ? hkClose(date) : usClose(date)) + 10 * 60_000 }];
  });
  if (bars.length < minRows) throw new Error("Incomplete daily history.");
  return bars;
}
async function daily(symbol: string, asset: PeerAsset, now: number, range = "5y") {
  let error: unknown;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const response = await fetch(`https://${host}/v8/finance/chart/${symbol}?range=${range}&interval=1d&events=div%2Csplits`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(6_000) });
      if (!response.ok) throw new Error(`History HTTP ${response.status}`);
      return parsePeerDaily(await response.json(), symbol, asset, now, range === "5y" && symbol !== PEER_ASSETS[asset].yahoo ? 200 : 1);
    } catch (e) { error = e; }
  }
  throw error;
}
function refreshHistory(asset: PeerAsset, now: number) {
  const state = shared(asset), config = PEER_ASSETS[asset];
  if (state.pending || now < state.retryAt || now - state.fetchedAt < 30 * 60_000) return;
  state.retryAt = now + 60_000;
  state.pending = (async () => {
    const [hk, smh, peer] = await Promise.all([daily(config.yahoo, asset, now), daily("SMH", asset, now), daily(config.peer, asset, now)]);
    const rows = alignedPeerRows(hk, smh, peer, now, asset);
    if (rows.length < config.minTraining || (rows.at(-1)?.date ?? "") < state.asOf) throw new Error("History older than retained sample.");
    const merged = new Map(state.rows.map(row => [row.date, row]));
    rows.forEach(row => merged.set(row.date, row));
    state.rows = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
    state.bars = { [config.yahoo]: hk, SMH: smh, [config.peer]: peer };
    state.asOf = state.rows.at(-1)!.date; state.fetchedAt = Date.now(); state.error = ""; state.version++;
  })().catch(() => { state.error = "History refresh unavailable; the dated research sample is retained."; state.retryAt = Date.now() + 5 * 60_000; }).finally(() => { state.pending = null; });
}
function refreshPeerSession(asset: PeerAsset, now: number, window: SmicWindow | null) {
  const state = shared(asset), symbol = PEER_ASSETS[asset].peer, date = window?.signalDate;
  if (!date || now < usOpen(date) || state.sessionPending || state.pending || now < state.sessionRetryAt) return;
  const bar = state.bars[symbol].find(b => b.date === date);
  if (bar && (now < usClose(date) || bar.complete)) return;
  state.sessionRetryAt = now + 15_000;
  state.sessionPending = daily(symbol, asset, now, "5d").then(bars => {
    const merged = new Map(state.bars[symbol].map(b => [b.date, b]));
    bars.forEach(b => merged.set(b.date, b));
    state.bars[symbol] = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)); state.sessionError = "";
  }).catch(() => { state.sessionError = `${symbol} session open/close confirmation is temporarily unavailable.`; state.sessionRetryAt = Date.now() + 30_000; }).finally(() => { state.sessionPending = null; });
}
export function selectPeerBook(records: QuoteRecord[], receivedAt: number, now: number, symbol: "SMH" | "LITE" | "MU"): SmicLiveQuote | null {
  const record = records.find(q => q.symbol === `US.${symbol}`);
  if (!record) return null;
  const bid = Number(record.bid), ask = Number(record.ask), timestamp = Number(record.marketTimestamp);
  if (!(bid > 0 && ask >= bid && Number.isFinite(bid) && Number.isFinite(ask) && timestamp > 0 && timestamp <= now + 5_000)) return null;
  const fresh = now - timestamp <= 30_000 && now - receivedAt <= 30_000;
  return { price: (bid + ask) / 2, bid, ask, timestamp, receivedAt, source: `Posley Futu · US.${symbol} BBO midpoint`, fresh, error: fresh ? null : `${symbol} retained quote: live updates are stale.` };
}
async function liveQuotes(asset: PeerAsset, now: number) {
  const peer = PEER_ASSETS[asset].peer, push = (globalThis as Root).__FUTU_PUSH_SNAPSHOT__;
  let smh = push ? selectPeerBook(push.payload.quotes ?? [], push.receivedAt, now, "SMH") : null;
  let peerQuote = push ? selectPeerBook(push.payload.quotes ?? [], push.receivedAt, now, peer) : null;
  if (!smh || !peerQuote) {
    try {
      const remote = await posleyAdrSnapshot(["SMH", peer]);
      for (const symbol of ["SMH", peer] as const) {
        if (symbol === "SMH" ? smh : peerQuote) continue;
        const book = remote.books.find(b => b.symbol === symbol && (b.streamKey === `orderbook:futu:US.${symbol}` || b.streamKey === `orderbook:ibkr:STK:${symbol}:SMART:USD`));
        if (!book) continue;
        const quote = selectPeerBook([{ symbol: `US.${symbol}`, bid: book.bid, ask: book.ask, marketTimestamp: book.timestamp }], remote.timestamp, now, symbol);
        if (symbol === "SMH") smh = quote; else peerQuote = quote;
      }
    } catch { /* Genuine retained observations remain available during a gateway outage. */ }
  }
  const missing = (symbol: string): SmicLiveQuote => ({ price: null, bid: null, ask: null, timestamp: null, receivedAt: null, source: `Posley Futu · US.${symbol}`, fresh: false, error: `Waiting for the ${symbol} stock feed.` });
  return { smh: smh ?? missing("SMH"), peer: peerQuote ?? missing(peer) };
}
export function peerSessionInput(window: SmicWindow | null, bars: SmicBar[], quote: SmicLiveQuote, now: number, symbol: string) {
  const date = window?.signalDate ?? null, bar = bars.find(b => b.date === date), open = bar?.open ?? null;
  if (!date) return { mode: "waiting", return: null, effectiveReturn: null, open: null, close: null, sessionDate: date, message: "Waiting for an eligible U.S. session." };
  if (now < usOpen(date)) return { mode: "preopen_assumption", return: null, effectiveReturn: 0, open: null, close: null, sessionDate: date, message: `Before U.S. open: ${symbol} intraday is assumed 0%, not an observed return.` };
  if (!bar) return { mode: "waiting_open", return: null, effectiveReturn: null, open: null, close: null, sessionDate: date, message: `Waiting for the target session’s reported ${symbol} regular opening price.` };
  if (now >= usClose(date)) {
    const value = bar.complete ? 100 * (bar.close / bar.open - 1) : null;
    return { mode: value === null ? "waiting_close" : "regular_close", return: value, effectiveReturn: value, open, close: bar.complete ? bar.close : null, sessionDate: date, message: value === null ? `Waiting for confirmation of ${symbol} regular closing price.` : `${symbol} regular open-to-close return is fixed; SMH continues to use its live quote.` };
  }
  const value = quote.price !== null && quote.timestamp !== null && quote.timestamp >= usOpen(date) ? 100 * (quote.price / bar.open - 1) : null;
  return { mode: "live_session", return: value, effectiveReturn: value, open, close: null, sessionDate: date, message: value === null ? `Waiting for a ${symbol} quote from this regular session.` : `Live ${symbol} midpoint / this U.S. regular-session opening price − 1.` };
}
export async function hkPeerOpeningState(asset: PeerAsset, now = Date.now()) {
  const state = shared(asset), config = PEER_ASSETS[asset];
  refreshHistory(asset, now);
  const window = nextSmicWindow(now), target = window?.date ?? dayKey(now);
  refreshPeerSession(asset, now, window);
  const key = `${target}:${state.version}`;
  if (state.modelCache?.key !== key) state.modelCache = { key, value: peerStudy(state.rows, target, asset) };
  const study = state.modelCache.value, quotes = await liveQuotes(asset, now);
  const peer = peerSessionInput(window, state.bars[config.peer], quotes.peer, now, config.peer);
  const anchor = window?.anchorDate ? state.bars.SMH.find(b => b.date === window.anchorDate && b.complete) : null;
  const hkAnchor = window ? state.bars[config.yahoo].find(b => b.date === window.previousHkDate && b.complete) : null;
  const quoteInWindow = Boolean(window?.anchorDate && quotes.smh.timestamp !== null && quotes.smh.timestamp >= usClose(window.anchorDate));
  const signal = anchor && quoteInWindow && quotes.smh.price !== null ? 100 * (quotes.smh.price / anchor.close - 1) : null;
  const modelStale = Date.parse(`${target}T12:00:00Z`) - Date.parse(`${state.asOf}T12:00:00Z`) > 10 * 86_400_000;
  const forecast = window && !window.error && !modelStale ? peerEstimate(study.model, study.groups, signal, peer.effectiveReturn) : null;
  const fresh = quotes.smh.fresh && (peer.mode === "preopen_assumption" || peer.mode === "regular_close" || (peer.mode === "live_session" && quotes.peer.fresh));
  return { asset, config, timestamp: now, target: window, phase: peer.mode, quote: quotes.smh, peerQuote: quotes.peer, peer, signal, fresh, forecast,
    smhAnchor: anchor ? { date: anchor.date, price: anchor.close } : null, hkAnchor: hkAnchor ? { date: hkAnchor.date, price: hkAnchor.close } : null,
    impliedOpen: forecast && hkAnchor ? hkAnchor.close * (1 + forecast.gap / 100) : null, ...study, lastOutcome: study.backtest.recent[0] ?? null,
    history: { asOf: state.asOf, fetchedAt: state.fetchedAt || null, refreshing: Boolean(state.pending), error: state.error, sessionError: state.sessionError, modelStale },
    error: !window ? "Trading calendar coverage unavailable." : window.error ?? (modelStale ? "Historical model is out of date." : !anchor ? "Waiting for the required SMH regular close anchor." : !quoteInWindow ? "Waiting for an SMH quote after the required close anchor." : peer.effectiveReturn === null ? peer.message : !study.model ? "Insufficient training history." : null) };
}
export type HkPeerOpeningPayload = Awaited<ReturnType<typeof hkPeerOpeningState>>;
