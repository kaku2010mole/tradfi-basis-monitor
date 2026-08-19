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
type BinancePremium = { symbol?: string; indexPrice?: string; time?: number };

const POLL_MS = 5_000;
const MAX_QUOTE_AGE_MS = 30_000;

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
    if (![bid, ask, oracle].every((value) => Number.isFinite(value) && value > 0)) return [];
    const live = (bid + ask) / 2;
    return [{
      id: `binance:${symbol}`,
      venue: "Binance" as const,
      symbol,
      deviation: (live / oracle - 1) * 100,
      updatedAt: Math.max(book?.time ?? 0, premium?.time ?? 0, Date.now()),
    }];
  });
}

export default function GlobalOracleAlerts() {
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [threshold, setThreshold] = useState(() => typeof window === "undefined" ? .1 : loadThreshold());
  const [universeVersion, setUniverseVersion] = useState(0);
  const directions = useRef(new Map<string, -1 | 0 | 1>());
  const primed = useRef(false);
  const inFlight = useRef(false);
  const dismiss = useCallback(() => setAlert(null), []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ORACLE_THRESHOLD_KEY) setThreshold(loadThreshold());
      if (event.key === ORACLE_CUSTOM_PAIRS_KEY) setUniverseVersion((value) => value + 1);
    };
    const onThreshold = (event: Event) => {
      const value = Number((event as CustomEvent<number>).detail);
      setThreshold(Number.isFinite(value) ? Math.max(.001, Math.min(value, 10)) : loadThreshold());
    };
    const onPairs = () => setUniverseVersion((value) => value + 1);
    window.addEventListener("storage", onStorage);
    window.addEventListener(ORACLE_THRESHOLD_CHANGED_EVENT, onThreshold);
    window.addEventListener(ORACLE_PAIRS_CHANGED_EVENT, onPairs);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ORACLE_THRESHOLD_CHANGED_EVENT, onThreshold);
      window.removeEventListener(ORACLE_PAIRS_CHANGED_EVENT, onPairs);
    };
  }, []);

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
          message: `${strongest.venue} live midpoint is ${signed} from oracle, outside the ±${threshold.toFixed(3)}% band${crossings.length > 1 ? ` · ${crossings.length - 1} additional trigger${crossings.length > 2 ? "s" : ""}` : ""}.`,
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
