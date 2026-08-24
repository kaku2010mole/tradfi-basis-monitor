"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_ORACLE_BINANCE,
  DEFAULT_ORACLE_PARA,
  ORACLE_CUSTOM_PAIRS_KEY,
  ORACLE_PAIRS_CHANGED_EVENT,
  ORACLE_THRESHOLD_CHANGED_EVENT,
  ORACLE_THRESHOLD_KEY,
  OracleCustomPair,
} from "../lib/oracleAlerts";
import {
  RELATIVE_VALUE_ALERT_THRESHOLD,
  RELATIVE_VALUE_SIGNAL_EVENT,
  RELATIVE_VALUE_SNAPSHOT_EVENT,
  RELATIVE_VALUE_SNAPSHOT_KEY,
  RelativeValueAlertSignal,
  RelativeValueAlertSnapshot,
} from "../lib/relativeValueAlerts";
import BroadcastAlert from "./BroadcastAlert";

type AlertState = { title: string; message: string; tone: "positive" | "negative" };
type AlertQuote = {
  id: string;
  venue: "Binance" | "Hyperliquid";
  symbol: string;
  deviation: number;
  updatedAt: number;
};
type BinanceBook = { symbol?: string; bidPrice?: string; askPrice?: string; time?: number };
type BinancePremium = { symbol?: string; indexPrice?: string; markPrice?: string; time?: number };

const POLL_MS = 5_000;
const MAX_QUOTE_AGE_MS = 30_000;
const MAX_RELATIVE_SNAPSHOT_AGE_MS = 18 * 60 * 60_000;

const loadPairs = () => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ORACLE_CUSTOM_PAIRS_KEY) || "[]") as OracleCustomPair[];
    return parsed.filter((pair) => pair && (pair.venue === "Binance" || pair.venue === "Hyperliquid") && typeof pair.apiSymbol === "string").slice(0, 24);
  } catch {
    return [];
  }
};

const loadThreshold = () => {
  const saved = Number(window.localStorage.getItem(ORACLE_THRESHOLD_KEY));
  return Number.isFinite(saved) && saved >= .001 ? Math.min(saved, 10) : .1;
};

const loadRelativeSnapshot = () => {
  try {
    const snapshot = JSON.parse(window.localStorage.getItem(RELATIVE_VALUE_SNAPSHOT_KEY) || "null") as RelativeValueAlertSnapshot | null;
    if (!snapshot || typeof snapshot.id !== "string" || !Number.isFinite(snapshot.savedAt) || Date.now() - snapshot.savedAt > MAX_RELATIVE_SNAPSHOT_AGE_MS) return null;
    if (![snapshot.start, snapshot.baseAsset1, snapshot.baseAsset2, snapshot.alphaHourly, snapshot.beta].every(Number.isFinite) || snapshot.baseAsset1 <= 0 || snapshot.baseAsset2 <= 0) return null;
    return snapshot;
  } catch {
    return null;
  }
};

async function liveRelativeSignal(snapshot: RelativeValueAlertSnapshot): Promise<RelativeValueAlertSignal> {
  const dexMids = new Map<string, Promise<Record<string, string>>>();
  const midpoint = async (leg: RelativeValueAlertSnapshot["asset1"]) => {
    if (leg.venue === "binance") {
      const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(leg.symbol)}`, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(4_000) });
      if (!response.ok) throw new Error("Binance relative-value quote unavailable.");
      const book = await response.json() as BinanceBook;
      const bid = Number(book.bidPrice);
      const ask = Number(book.askPrice);
      if (![bid, ask].every((value) => Number.isFinite(value) && value > 0)) throw new Error(`${leg.symbol} midpoint unavailable.`);
      return (bid + ask) / 2;
    }
    const dex = leg.symbol.includes(":") ? leg.symbol.split(":", 1)[0] : "";
    if (!dexMids.has(dex)) dexMids.set(dex, fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dex ? { type: "allMids", dex } : { type: "allMids" }),
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Hyperliquid relative-value quote unavailable.");
      return await response.json() as Record<string, string>;
    }));
    const mids = await dexMids.get(dex)!;
    const value = Number(mids[leg.symbol]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${leg.symbol} midpoint unavailable.`);
    return value;
  };
  const [asset1, asset2] = await Promise.all([midpoint(snapshot.asset1), midpoint(snapshot.asset2)]);
  const updatedAt = Date.now();
  const elapsedHours = Math.max(0, (updatedAt - snapshot.start) / 60 / 60_000);
  const asset1LogReturn = Math.log(asset1 / snapshot.baseAsset1);
  const asset2Theoretical = Math.expm1(snapshot.alphaHourly * elapsedHours + snapshot.beta * asset1LogReturn) * 100;
  const asset2Actual = (asset2 / snapshot.baseAsset2 - 1) * 100;
  return { snapshot, predictionError: asset2Actual - asset2Theoretical, asset2Actual, asset2Theoretical, updatedAt };
}

const monitoredUniverse = () => {
  const binance = new Set(DEFAULT_ORACLE_BINANCE);
  const para = new Set(DEFAULT_ORACLE_PARA);
  for (const pair of loadPairs()) (pair.venue === "Binance" ? binance : para).add(pair.apiSymbol);
  return { binance: [...binance], para: [...para] };
};

async function directBinanceQuotes(symbols: string[], signal: AbortSignal): Promise<AlertQuote[]> {
  const [bookResponse, premiumResponse] = await Promise.all([
    fetch("https://fapi.binance.com/fapi/v1/ticker/bookTicker", { cache: "no-store", credentials: "omit", signal }),
    fetch("https://fapi.binance.com/fapi/v1/premiumIndex", { cache: "no-store", credentials: "omit", signal }),
  ]);
  if (!bookResponse.ok || !premiumResponse.ok) throw new Error("Binance browser snapshot unavailable.");
  const [books, premiums] = await Promise.all([
    bookResponse.json() as Promise<BinanceBook[]>,
    premiumResponse.json() as Promise<BinancePremium[]>,
  ]);
  const bookBySymbol = new Map(books.flatMap((book) => book.symbol ? [[book.symbol, book] as const] : []));
  const premiumBySymbol = new Map(premiums.flatMap((premium) => premium.symbol ? [[premium.symbol, premium] as const] : []));
  return symbols.flatMap((symbol) => {
    const book = bookBySymbol.get(symbol);
    const premium = premiumBySymbol.get(symbol);
    const bid = Number(book?.bidPrice);
    const ask = Number(book?.askPrice);
    const oracle = Number(premium?.indexPrice);
    const mark = Number(premium?.markPrice);
    if (![bid, ask, oracle, mark].every((value) => Number.isFinite(value) && value > 0)) return [];
    const sellDeviation = (bid / oracle - 1) * 100;
    const buyDeviation = (ask / oracle - 1) * 100;
    const deviation = sellDeviation > 0 && (buyDeviation >= 0 || sellDeviation >= Math.abs(buyDeviation)) ? sellDeviation : buyDeviation < 0 ? buyDeviation : 0;
    return [{
      id: `binance:${symbol}`,
      venue: "Binance" as const,
      symbol,
      deviation,
      updatedAt: Math.max(book?.time ?? 0, premium?.time ?? 0, Date.now()),
    }];
  });
}

export default function GlobalOracleAlerts() {
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [threshold, setThreshold] = useState(() => typeof window === "undefined" ? .1 : loadThreshold());
  const [universeVersion, setUniverseVersion] = useState(0);
  const directions = useRef(new Map<string, -1 | 0 | 1>());
  const relativeDirection = useRef<-1 | 0 | 1>(0);
  const relativeSnapshot = useRef<RelativeValueAlertSnapshot | null>(null);
  const relativeInFlight = useRef(false);
  const primed = useRef(false);
  const inFlight = useRef(false);
  const dismiss = useCallback(() => setAlert(null), []);
  const applyRelativeSignal = useCallback((signal: RelativeValueAlertSignal) => {
    const next = signal.predictionError > RELATIVE_VALUE_ALERT_THRESHOLD ? 1 : signal.predictionError < -RELATIVE_VALUE_ALERT_THRESHOLD ? -1 : 0;
    const previous = relativeDirection.current;
    relativeDirection.current = next;
    if (next === 0 || next === previous) return;
    const asset2Side = next > 0 ? "SHORT" : "LONG";
    const asset1Side = signal.snapshot.beta >= 0 ? asset2Side === "LONG" ? "SHORT" : "LONG" : asset2Side;
    const signed = `${signal.predictionError >= 0 ? "+" : ""}${signal.predictionError.toFixed(3)}%`;
    setAlert({
      tone: next > 0 ? "positive" : "negative",
      title: `${signal.snapshot.title} PREDICTION ERROR`,
      message: `${signal.snapshot.asset2.symbol} is ${signed} versus theory, outside the ±${RELATIVE_VALUE_ALERT_THRESHOLD.toFixed(1)}% band · β-neutral direction: ${asset2Side} ${signal.snapshot.asset2.symbol} / ${asset1Side} ${signal.snapshot.asset1.symbol}.`,
    });
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ORACLE_THRESHOLD_KEY) setThreshold(loadThreshold());
      if (event.key === ORACLE_CUSTOM_PAIRS_KEY) setUniverseVersion((value) => value + 1);
      if (event.key === RELATIVE_VALUE_SNAPSHOT_KEY) {
        const nextSnapshot = loadRelativeSnapshot();
        if (nextSnapshot?.id !== relativeSnapshot.current?.id) relativeDirection.current = 0;
        relativeSnapshot.current = nextSnapshot;
      }
    };
    const onThreshold = (event: Event) => {
      const value = Number((event as CustomEvent<number>).detail);
      setThreshold(Number.isFinite(value) ? Math.max(.001, Math.min(value, 10)) : loadThreshold());
    };
    const onPairs = () => setUniverseVersion((value) => value + 1);
    const onRelativeSnapshot = (event: Event) => {
      const nextSnapshot = (event as CustomEvent<RelativeValueAlertSnapshot>).detail;
      if (nextSnapshot.id !== relativeSnapshot.current?.id) relativeDirection.current = 0;
      relativeSnapshot.current = nextSnapshot;
    };
    const onRelativeSignal = (event: Event) => applyRelativeSignal((event as CustomEvent<RelativeValueAlertSignal>).detail);
    relativeSnapshot.current = loadRelativeSnapshot();
    window.addEventListener("storage", onStorage);
    window.addEventListener(ORACLE_THRESHOLD_CHANGED_EVENT, onThreshold);
    window.addEventListener(ORACLE_PAIRS_CHANGED_EVENT, onPairs);
    window.addEventListener(RELATIVE_VALUE_SNAPSHOT_EVENT, onRelativeSnapshot);
    window.addEventListener(RELATIVE_VALUE_SIGNAL_EVENT, onRelativeSignal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ORACLE_THRESHOLD_CHANGED_EVENT, onThreshold);
      window.removeEventListener(ORACLE_PAIRS_CHANGED_EVENT, onPairs);
      window.removeEventListener(RELATIVE_VALUE_SNAPSHOT_EVENT, onRelativeSnapshot);
      window.removeEventListener(RELATIVE_VALUE_SIGNAL_EVENT, onRelativeSignal);
    };
  }, [applyRelativeSignal]);

  useEffect(() => {
    let cancelled = false;
    const pollRelative = async () => {
      const snapshot = relativeSnapshot.current;
      if (cancelled || relativeInFlight.current || document.visibilityState === "hidden" || !snapshot || Date.now() - snapshot.savedAt > MAX_RELATIVE_SNAPSHOT_AGE_MS) return;
      if (window.location.pathname === "/blog" || window.location.pathname === "/trade") return;
      relativeInFlight.current = true;
      try {
        const signal = await liveRelativeSignal(snapshot);
        if (!cancelled && relativeSnapshot.current?.id === snapshot.id) applyRelativeSignal(signal);
      } catch { /* Keep the last valid signal and retry automatically. */ }
      finally { relativeInFlight.current = false; }
    };
    const frame = window.requestAnimationFrame(() => void pollRelative());
    const timer = window.setInterval(() => void pollRelative(), 10_000);
    return () => { cancelled = true; window.cancelAnimationFrame(frame); window.clearInterval(timer); };
  }, [applyRelativeSignal]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (cancelled || inFlight.current || document.visibilityState === "hidden") return;
      inFlight.current = true;
      const { binance, para } = monitoredUniverse();
      const params = new URLSearchParams({ binance: binance.join(","), para: para.join(",") });
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 9_000);
      try {
        const [serverResult, browserResult] = await Promise.allSettled([
          fetch(`/api/oracle-monitor/quotes?${params}`, { cache: "no-store", signal: controller.signal })
            .then(async (response) => {
              const payload = await response.json() as { quotes?: AlertQuote[] };
              if (!response.ok) throw new Error("Oracle snapshot unavailable.");
              return payload.quotes ?? [];
            }),
          directBinanceQuotes(binance, controller.signal),
        ]);
        if (cancelled) return;
        const byId = new Map<string, AlertQuote>();
        if (serverResult.status === "fulfilled") for (const quote of serverResult.value) byId.set(quote.id, quote);
        if (browserResult.status === "fulfilled") for (const quote of browserResult.value) byId.set(quote.id, quote);
        const now = Date.now();
        const quotes = [...byId.values()].filter((quote) => Number.isFinite(quote.deviation) && now - quote.updatedAt <= MAX_QUOTE_AGE_MS);
        if (!quotes.length) return;

        const nextDirections = new Map<string, -1 | 0 | 1>();
        for (const quote of quotes) nextDirections.set(quote.id, quote.deviation >= threshold ? 1 : quote.deviation <= -threshold ? -1 : 0);
        if (!primed.current) {
          directions.current = nextDirections;
          primed.current = true;
          return;
        }

        const crossings = quotes.filter((quote) => {
          const next = nextDirections.get(quote.id) ?? 0;
          return next !== 0 && next !== (directions.current.get(quote.id) ?? 0);
        });
        directions.current = nextDirections;
        if (!crossings.length) return;
        const strongest = crossings.reduce((best, quote) => Math.abs(quote.deviation) > Math.abs(best.deviation) ? quote : best);
        const tone = strongest.deviation >= 0 ? "positive" as const : "negative" as const;
        const signed = `${strongest.deviation >= 0 ? "+" : ""}${strongest.deviation.toFixed(3)}%`;
        setAlert({
          tone,
          title: `${strongest.symbol} ${tone === "positive" ? "POSITIVE" : "NEGATIVE"} ORACLE TRIGGER`,
          message: `${strongest.venue} executable best bid/ask is ${signed} from oracle, outside the ±${threshold.toFixed(3)}% band${crossings.length > 1 ? ` · ${crossings.length - 1} additional trigger${crossings.length > 2 ? "s" : ""}` : ""}.`,
        });
      } finally {
        window.clearTimeout(timeout);
        inFlight.current = false;
      }
    };

    const frame = window.requestAnimationFrame(() => void poll());
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [threshold, universeVersion]);

  return <BroadcastAlert open={alert !== null} title={alert?.title ?? ""} message={alert?.message ?? ""} tone={alert?.tone ?? "positive"} onDismiss={dismiss} />;
}
