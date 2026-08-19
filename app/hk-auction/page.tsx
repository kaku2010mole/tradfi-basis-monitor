"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";
import styles from "./page.module.css";

type PairConfig = { stockSymbol: string; perpSymbol: string; sharesPerContract: number; adrSymbol?: string; hkSharesPerAdr?: number };
type Book = { bid: number; ask: number; bidSize: number | null; askSize: number | null; marketTimestamp: number; stale: boolean | null };
type FutuBook = Omit<Book, "marketTimestamp"> & {
  name: string | null;
  auctionPrice: number | null;
  marketState: string | null;
  marketTimestamp: number | null;
};
type Direction = { basisPct: number | null; capacityContracts: number | null; capacityUsdt: number | null };
type Quote = PairConfig & {
  id: string;
  futu: FutuBook | null;
  binance: (Book & { mid: number; fundingRate: number | null; nextFundingTime: number | null }) | null;
  metrics: {
    stockReferenceHkd: number | null;
    stockReferenceSource: "auction-price" | "book-mid" | "close-price" | null;
    fairUsdt: number | null;
    binanceMid: number | null;
    midBasisPct: number | null;
    depthUsdt: { stockBid: number | null; stockAsk: number | null; binanceBid: number | null; binanceAsk: number | null };
    sellPerpBuyStock: Direction;
    buyPerpSellStock: Direction;
  };
  status: "live" | "stale" | "partial";
};
type Payload = { quotes: Quote[]; usdHkd: number; timestamp: number; sources: { futu: boolean; binance: boolean }; errors: string[] };
type HistoryPoint = { t: number; value: number; stockCloseHkd?: number; perpClose?: number };
type AdrBook = { symbol: string; streamKey: string; bid: number | null; ask: number | null; last: number | null; bidSize: number | null; askSize: number | null; timestamp: number };
type AdrFeedState = "connecting" | "live" | "auth-required" | "partial" | "reconnecting";

const STORAGE_KEY = "hk-auction-pairs-v3";
const LEGACY_STORAGE_KEYS = ["hk-auction-pairs-v2", "hk-auction-pairs-v1"];
const OFFICE_RELAY = "ws://192.168.50.112:8787/ws";
const REMOTE_GATEWAY = process.env.NEXT_PUBLIC_REDIS_BACKEND_URL ?? "https://redis-data.posley.capital";
const COGNITO_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "5qup0una5tdma3l33pnn1gm87i";
const COGNITO_DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "posley.auth.us-east-1.amazoncognito.com";
const ADR_STALE_MS = 30_000;
const ADR_BENCHMARK_MAX_AGE_MS = 96 * 60 * 60_000;
const DEFAULT_ADR: Record<string, { adrSymbol: string; hkSharesPerAdr: number }> = {
  "HK.00700": { adrSymbol: "TCEHY", hkSharesPerAdr: 1 },
  "HK.01810": { adrSymbol: "XIACY", hkSharesPerAdr: 5 },
  "HK.01024": { adrSymbol: "KSHTY", hkSharesPerAdr: 0.2 },
  "HK.03690": { adrSymbol: "MPNGY", hkSharesPerAdr: 2 },
  "HK.09992": { adrSymbol: "PMRTY", hkSharesPerAdr: 1 },
  "HK.00100": { adrSymbol: "MMXGY", hkSharesPerAdr: 0.2 },
};
const DEFAULT_PAIRS: PairConfig[] = [
  { stockSymbol: "HK.00700", perpSymbol: "TENCENTUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.00700"] },
  { stockSymbol: "HK.01810", perpSymbol: "XIAOMIUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.01810"] },
  { stockSymbol: "HK.01024", perpSymbol: "KUAISHOUUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.01024"] },
  { stockSymbol: "HK.03690", perpSymbol: "MEITUANUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.03690"] },
  { stockSymbol: "HK.09992", perpSymbol: "POPMARTUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.09992"] },
  { stockSymbol: "HK.00100", perpSymbol: "MINIMAXUSDT", sharesPerContract: 1, ...DEFAULT_ADR["HK.00100"] },
  { stockSymbol: "HK.02513", perpSymbol: "ZHIPUUSDT", sharesPerContract: 1 },
  { stockSymbol: "HK.00700", perpSymbol: "HK0700USDT", sharesPerContract: 7.83, ...DEFAULT_ADR["HK.00700"] },
  { stockSymbol: "HK.01810", perpSymbol: "HK1810USDT", sharesPerContract: 7.83, ...DEFAULT_ADR["HK.01810"] },
];

const defaultShares = (perp: string) => ["HK0700USDT", "HK1810USDT"].includes(perp.toUpperCase()) ? 7.83 : 1;
const number = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const pct = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const time = (value: number | null | undefined) => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value) : "—";

const normalizeSavedPair = (pair: PairConfig): PairConfig => {
  const mapping = DEFAULT_ADR[pair.stockSymbol];
  if (!mapping || pair.adrSymbol) return pair;
  return { ...pair, ...mapping };
};

const parsePosleyLevels = (value?: string) => !value ? [] : value.split("|").flatMap((level) => {
  const [rawPrice, rawSize] = level.split(",", 2);
  const price = Number(rawPrice);
  const size = Number(rawSize);
  return Number.isFinite(price) && price > 0 && Number.isFinite(size) && size >= 0 ? [{ price, size }] : [];
});

const posleyTimestamp = (data: Record<string, string>) => {
  const values = [data.last_tick_ts_ms, data.bids_receive_ts_ms, data.asks_receive_ts_ms, data.event_emit_ts_ms].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : Date.now();
};

const streamAdrSymbol = (streamKey: string, symbols: Set<string>) => {
  const [category, venue, ...codeParts] = streamKey.toUpperCase().split(":");
  if (category !== "ORDERBOOK" || !["IBKR", "FUTU"].includes(venue)) return null;
  const code = codeParts.join(":");
  return [...symbols].find((symbol) => code === symbol || code === `US.${symbol}` || code.endsWith(`.${symbol}`)) ?? null;
};

const encodeBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function beginPosleyLogin() {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  sessionStorage.setItem("equity_monitor_pkce", verifier);
  sessionStorage.setItem("equity_monitor_return_to", "/hk-auction");
  const params = new URLSearchParams({
    client_id: COGNITO_CLIENT_ID,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: `${location.origin}/`,
    identity_provider: "Google",
    code_challenge_method: "S256",
    code_challenge: encodeBase64Url(new Uint8Array(digest)),
  });
  location.assign(`https://${COGNITO_DOMAIN}/oauth2/authorize?${params}`);
}

async function validPosleyToken() {
  const token = localStorage.getItem("equity_monitor_id_token");
  const expiresAt = Number(localStorage.getItem("equity_monitor_expires_at") || 0);
  if (token && expiresAt > Date.now() + 60_000) return token;
  const refreshToken = localStorage.getItem("equity_monitor_refresh_token");
  if (!refreshToken) return null;
  const response = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: COGNITO_CLIENT_ID, refresh_token: refreshToken }),
  });
  if (!response.ok) return null;
  const refreshed = await response.json() as { id_token?: string; expires_in?: number };
  if (!refreshed.id_token) return null;
  localStorage.setItem("equity_monitor_id_token", refreshed.id_token);
  localStorage.setItem("equity_monitor_expires_at", String(Date.now() + (refreshed.expires_in ?? 3600) * 1000));
  return refreshed.id_token;
}

function sessionState(now: number, futuState?: string | null) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const total = hour * 60 + minute;
  const official = futuState?.toUpperCase();
  if (official === "WAITING_OPEN") return { key: "blocking", label: "Auction locked / waiting open", detail: "Futu market state", progress: 100 };
  if (official && !["AUCTION", "ACTION"].includes(official)) return { key: "closed", label: official.replaceAll("_", " "), detail: "Futu market state", progress: 0 };
  if (["Sat", "Sun"].includes(weekday) || total < 540 || total >= 570) return { key: "closed", label: "Outside pre-opening session", detail: "Next monitored window 09:00–09:30 HKT", progress: 0 };
  if (total < 555) return { key: "input", label: "Order input", detail: "Orders may be amended or cancelled", progress: ((total - 540) / 15) * 25 };
  if (total < 560) return { key: "nocancel", label: "No-cancellation", detail: "New auction orders accepted; no cancel", progress: 25 + ((total - 555) / 5) * 25 };
  if (total < 562) return { key: "matching", label: "Random matching", detail: "Opening match may occur at any moment", progress: 50 + ((total - 560) / 2) * 25 };
  return { key: "blocking", label: "Blocking / waiting open", detail: "Auction result is locked until 09:30", progress: 75 + ((total - 562) / 8) * 25 };
}

function SpreadHistory({ points, cursor, onCursor }: { points: HistoryPoint[]; cursor?: number; onCursor: (index: number) => void }) {
  if (!points.length) return <div className={styles.emptyChart}>History starts after both real feeds produce a valid basis.</div>;
  const width = 720;
  const height = 218;
  const plotTop = 18;
  const plotBottom = 178;
  const values = points.map((point) => point.value);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const padding = Math.max((rawMax - rawMin) * .12, .04);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const x = (index: number) => points.length === 1 ? width / 2 : 18 + index / (points.length - 1) * (width - 36);
  const y = (value: number) => plotTop + (max - value) / (max - min) * (plotBottom - plotTop);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const selectedIndex = Math.min(points.length - 1, Math.max(0, cursor ?? points.length - 1));
  const selected = points[selectedIndex];
  return <div className={styles.chartWrap}>
    <div className={styles.chartReadout}><div><span>SELECTED BASIS</span><strong className={selected.value < 0 ? styles.negative : styles.positive}>{pct(selected.value)}</strong></div><div><span>FUTU / BINANCE CLOSE</span><strong>{number(selected.stockCloseHkd)} / {number(selected.perpClose)}</strong></div><div><span>TIME · 1 MINUTE</span><strong>{time(selected.t)} HKT</strong></div></div>
    <svg className={styles.chart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Historical midpoint basis trend">
      <defs><linearGradient id="basisFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#248e69" stopOpacity=".22"/><stop offset="1" stopColor="#248e69" stopOpacity="0"/></linearGradient></defs>
      <line x1="18" x2={width - 18} y1={y(0)} y2={y(0)} className={styles.zeroLine}/>
      <path d={`${path} L${x(points.length - 1)},${plotBottom} L${x(0)},${plotBottom} Z`} className={styles.areaPath}/>
      <path d={path} className={styles.linePath}/>
      <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={plotTop} y2={plotBottom} className={styles.cursorLine}/>
      <circle cx={x(selectedIndex)} cy={y(selected.value)} r="5" className={styles.cursorDot}/>
      <text x="18" y="208">{time(points[0].t)}</text><text x={width - 18} y="208" textAnchor="end">{time(points.at(-1)?.t)}</text>
    </svg>
    <input className={styles.chartSlider} type="range" min="0" max={Math.max(0, points.length - 1)} value={selectedIndex} onChange={(event) => onCursor(Number(event.target.value))} aria-label="Select a historical basis sample" />
    <p>{points.length.toLocaleString()} aligned Futu + Binance one-minute bars · range {pct(rawMin)} → {pct(rawMax)}</p>
  </div>;
}

export default function HkAuctionPage() {
  const [pairs, setPairs] = useState<PairConfig[]>(DEFAULT_PAIRS);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [usdHkd, setUsdHkd] = useState("7.83");
  const [threshold, setThreshold] = useState("0.50");
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [managerOpen, setManagerOpen] = useState(false);
  const [draft, setDraft] = useState({ stockSymbol: "HK.", perpSymbol: "", sharesPerContract: "1", adrSymbol: "", hkSharesPerAdr: "1" });
  const [pairError, setPairError] = useState("");
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [historyError, setHistoryError] = useState<Record<string, string>>({});
  const [cardTabs, setCardTabs] = useState<Record<string, "overview" | "history">>({});
  const [historyCursor, setHistoryCursor] = useState<Record<string, number>>({});
  const [adrBooks, setAdrBooks] = useState<Record<string, AdrBook>>({});
  const [adrFeedState, setAdrFeedState] = useState<AdrFeedState>("connecting");
  const [adrFeedError, setAdrFeedError] = useState("");
  const [missingAdrStreams, setMissingAdrStreams] = useState<string[]>([]);
  const requestRef = useRef(false);

  useEffect(() => {
    try {
      const current = window.localStorage.getItem(STORAGE_KEY);
      if (current !== null) {
        const saved = JSON.parse(current) as PairConfig[];
        if (Array.isArray(saved)) setPairs(saved.slice(0, 24));
        return;
      }
      const legacyRaw = LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean);
      const legacy = JSON.parse(legacyRaw || "[]") as PairConfig[];
      const merged = new Map(DEFAULT_PAIRS.map((pair) => [`${pair.stockSymbol}:${pair.perpSymbol}`, pair]));
      if (Array.isArray(legacy)) legacy.forEach((pair) => merged.set(`${pair.stockSymbol}:${pair.perpSymbol}`, normalizeSavedPair(pair)));
      const migrated = [...merged.values()].map(normalizeSavedPair).slice(0, 24);
      setPairs(migrated);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    } catch { /* Keep safe defaults. */ }
  }, []);

  const adrSymbolsKey = useMemo(() => [...new Set(pairs.flatMap((pair) => pair.adrSymbol ? [pair.adrSymbol.toUpperCase()] : []))].sort().join(","), [pairs]);

  useEffect(() => {
    const symbols = new Set(adrSymbolsKey.split(",").filter(Boolean));
    if (!symbols.size) {
      setAdrFeedState("partial");
      setMissingAdrStreams([]);
      return;
    }
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let hasMissingStreams = false;
    const symbolByStream = new Map<string, string>();

    const resolveStreams = (keys: string[]) => {
      symbolByStream.clear();
      for (const key of keys) {
        const symbol = streamAdrSymbol(key, symbols);
        if (symbol && ![...symbolByStream.values()].includes(symbol)) symbolByStream.set(key, symbol);
      }
      const found = new Set(symbolByStream.values());
      const missing = [...symbols].filter((symbol) => !found.has(symbol));
      hasMissingStreams = missing.length > 0;
      setMissingAdrStreams(missing);
      return [...symbolByStream.keys()];
    };

    const acceptBook = (streamKey: string, data: Record<string, string>) => {
      const symbol = symbolByStream.get(streamKey);
      if (!symbol) return;
      const bids = parsePosleyLevels(data.bids);
      const asks = parsePosleyLevels(data.asks);
      const bid = bids[0]?.price ?? null;
      const ask = asks[0]?.price ?? null;
      const last = Number(data.last_price);
      if (bid === null && ask === null && (!Number.isFinite(last) || last <= 0)) return;
      const marketTimestamp = posleyTimestamp(data);
      setAdrBooks((current) => ({ ...current, [symbol]: {
        symbol,
        streamKey,
        bid,
        ask,
        last: Number.isFinite(last) && last > 0 ? last : null,
        bidSize: bids[0]?.size ?? null,
        askSize: asks[0]?.size ?? null,
        timestamp: marketTimestamp,
      } }));
      setAdrFeedState(!hasMissingStreams && Date.now() - marketTimestamp <= ADR_STALE_MS ? "live" : "partial");
      setAdrFeedError("");
    };

    const retry = (connect: () => void, delay = 3_000) => {
      if (cancelled || retryTimer !== null) return;
      setAdrFeedState("reconnecting");
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      retryTimer = window.setTimeout(() => { retryTimer = null; connect(); }, delay);
    };

    const connectRemote = async () => {
      setAdrFeedState("connecting");
      try {
        const token = await validPosleyToken();
        if (!token) {
          setAdrFeedState("auth-required");
          setAdrFeedError("Connect your Posley account to read ADR streams.");
          return;
        }
        const directoryResponse = await fetch("/api/hk-auction/adr-streams", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        });
        if (directoryResponse.status === 401) {
          localStorage.removeItem("equity_monitor_id_token");
          localStorage.removeItem("equity_monitor_expires_at");
          setAdrFeedState("auth-required");
          setAdrFeedError("Posley session expired. Reconnect to continue.");
          return;
        }
        if (!directoryResponse.ok) throw new Error(`Posley stream directory HTTP ${directoryResponse.status}`);
        const directory = await directoryResponse.json() as { streamKeys?: Array<string | { key?: string }> };
        const streamKeys = resolveStreams((directory.streamKeys ?? []).flatMap((item) => typeof item === "string" ? [item] : item.key ? [item.key] : []));
        if (!streamKeys.length) {
          setAdrFeedState("partial");
          setAdrFeedError("No matching live ADR stream is currently published by Posley.");
          retry(() => void connectRemote(), 15_000);
          return;
        }
        const url = new URL("/socket.io/", REMOTE_GATEWAY);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.search = "EIO=4&transport=websocket";
        socket = new WebSocket(url);
        socket.onopen = () => socket?.send(`40${JSON.stringify({ token })}`);
        socket.onmessage = (message) => {
          const frame = String(message.data);
          if (frame === "2") return socket?.send("3");
          if (frame.startsWith("40")) {
            streamKeys.forEach((streamKey) => socket?.send(`42${JSON.stringify(["stream:subscribe", { streamKey, region: "tokyo" }])}`));
            setAdrFeedState("connecting");
            return;
          }
          if (!frame.startsWith("42")) return;
          const [eventName, event] = JSON.parse(frame.slice(2)) as [string, { streamKey?: string; entries?: Array<{ data?: Record<string, string> }> }];
          if (eventName !== "stream:data" || !event.streamKey) return;
          const data = event.entries?.at(-1)?.data;
          if (data) acceptBook(event.streamKey, data);
        };
        socket.onerror = () => retry(() => void connectRemote());
        socket.onclose = () => retry(() => void connectRemote());
      } catch (error) {
        setAdrFeedError(error instanceof Error ? error.message : "Posley ADR feed unavailable.");
        retry(() => void connectRemote());
      }
    };

    const connectOffice = () => {
      setAdrFeedState("connecting");
      socket = new WebSocket(OFFICE_RELAY);
      socket.onopen = () => socket?.send(JSON.stringify({ action: "list", pattern: "orderbook:*" }));
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as { type?: string; keys?: string[]; key?: string; fields?: Record<string, string> };
        if (event.type === "streams") {
          const keys = resolveStreams(event.keys ?? []);
          if (!keys.length) {
            setAdrFeedState("partial");
            setAdrFeedError("No matching live ADR stream is currently published by Posley.");
            retry(connectOffice, 15_000);
            return;
          }
          socket?.send(JSON.stringify({ action: "subscribe", keys, snapshot: 1 }));
        }
        if (event.type === "entry" && event.key && event.fields) acceptBook(event.key, event.fields);
      };
      socket.onerror = () => retry(connectOffice);
      socket.onclose = () => retry(connectOffice);
    };

    if (location.protocol === "http:") connectOffice();
    else void connectRemote();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [adrSymbolsKey]);

  const load = useCallback(async () => {
    if (requestRef.current || document.visibilityState === "hidden") return;
    const fx = Number(usdHkd);
    if (!Number.isFinite(fx) || fx <= 0) return;
    requestRef.current = true;
    try {
      const params = new URLSearchParams({ usdhkd: String(fx) });
      pairs.forEach((pair) => params.append("pair", `${pair.stockSymbol}|${pair.perpSymbol}|${pair.sharesPerContract}`));
      const response = await fetch(`/api/hk-auction/quotes?${params}`, { cache: "no-store" });
      const next = await response.json() as Payload & { error?: string };
      if (!response.ok) throw new Error(next.error || "Auction quotes unavailable.");
      setPayload(next);
    } catch (error) {
      setPayload((current) => current ? { ...current, errors: [error instanceof Error ? error.message : "Auction quotes unavailable."] } : null);
    } finally {
      requestRef.current = false;
      setLoading(false);
    }
  }, [pairs, usdHkd]);

  const loadHistory = useCallback(async (id: string, pair: PairConfig) => {
    setHistoryLoading((current) => ({ ...current, [id]: true }));
    setHistoryError((current) => ({ ...current, [id]: "" }));
    try {
      const params = new URLSearchParams({
        stock: pair.stockSymbol,
        perp: pair.perpSymbol,
        shares: String(pair.sharesPerContract),
        usdhkd: usdHkd,
      });
      const response = await fetch(`/api/hk-auction/history?${params}`, { cache: "no-store" });
      const result = await response.json() as { points?: HistoryPoint[]; error?: string };
      if (!response.ok || !Array.isArray(result.points)) throw new Error(result.error || "Historical spread is unavailable.");
      setHistory((current) => ({ ...current, [id]: result.points ?? [] }));
      setHistoryCursor((current) => ({ ...current, [id]: Math.max(0, (result.points?.length ?? 1) - 1) }));
    } catch (error) {
      setHistoryError((current) => ({ ...current, [id]: error instanceof Error ? error.message : "Historical spread is unavailable." }));
    } finally {
      setHistoryLoading((current) => ({ ...current, [id]: false }));
    }
  }, [usdHkd]);

  useEffect(() => {
    void load();
    const quoteTimer = window.setInterval(() => void load(), 1_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearInterval(quoteTimer); window.clearInterval(clockTimer); };
  }, [load]);

  const savePairs = (next: PairConfig[]) => {
    setPairs(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };
  const addPair = () => {
    const stockSymbol = draft.stockSymbol.trim().toUpperCase();
    const perpSymbol = draft.perpSymbol.trim().toUpperCase();
    const sharesPerContract = Number(draft.sharesPerContract);
    const adrSymbol = draft.adrSymbol.trim().toUpperCase();
    const hkSharesPerAdr = Number(draft.hkSharesPerAdr);
    if (!/^HK\.\d{5}$/.test(stockSymbol) || !/^[A-Z0-9_]{3,32}USDT$/.test(perpSymbol) || !Number.isFinite(sharesPerContract) || sharesPerContract <= 0) {
      setPairError("Use Futu format HK.00700, a Binance USDT symbol, and positive shares per contract.");
      return;
    }
    if (adrSymbol && (!/^[A-Z0-9.]{1,16}$/.test(adrSymbol) || !Number.isFinite(hkSharesPerAdr) || hkSharesPerAdr <= 0)) {
      setPairError("ADR ticker must be valid and HK shares per ADR must be positive.");
      return;
    }
    if (pairs.some((pair) => pair.stockSymbol === stockSymbol && pair.perpSymbol === perpSymbol)) {
      setPairError("That mapping is already monitored.");
      return;
    }
    savePairs([...pairs, { stockSymbol, perpSymbol, sharesPerContract, ...(adrSymbol ? { adrSymbol, hkSharesPerAdr } : {}) }].slice(-24));
    setDraft({ stockSymbol: "HK.", perpSymbol: "", sharesPerContract: "1", adrSymbol: "", hkSharesPerAdr: "1" });
    setPairError("");
  };
  const updatePerpDraft = (value: string) => {
    const perpSymbol = value.toUpperCase();
    setDraft((current) => ({ ...current, perpSymbol, sharesPerContract: String(defaultShares(perpSymbol)) }));
  };

  const quoteById = useMemo(() => new Map(payload?.quotes.map((quote) => [quote.id, quote]) ?? []), [payload]);
  const orderedPairs = useMemo(() => [...pairs].sort((left, right) => {
    const leftQuote = quoteById.get(`${left.stockSymbol}:${left.perpSymbol}`);
    const rightQuote = quoteById.get(`${right.stockSymbol}:${right.perpSymbol}`);
    const leftScore = leftQuote?.metrics.midBasisPct === null || leftQuote?.metrics.midBasisPct === undefined
      ? -1
      : Math.abs(leftQuote.metrics.midBasisPct);
    const rightScore = rightQuote?.metrics.midBasisPct === null || rightQuote?.metrics.midBasisPct === undefined
      ? -1
      : Math.abs(rightQuote.metrics.midBasisPct);
    return rightScore - leftScore;
  }), [pairs, quoteById]);
  const futuState = payload?.quotes.find((quote) => quote.futu?.marketState)?.futu?.marketState;
  const session = sessionState(now, futuState);
  const alert = Number(threshold) || 0;

  return <main className={styles.shell}>
    <header className={styles.topbar}>
      <div><p>HKEX PRE-OPEN / CROSS-VENUE BASIS</p><h1>HK Auction Basis</h1><small>Futu auction versus Binance perpetuals and Posley ADRs</small></div>
      <div className={styles.topActions}><span className={styles.clock}>{time(now)} HKT</span><PageSwitcher active="auction" /></div>
    </header>

    <section className={styles.sessionHero}>
      <div><span>ACTIVE SESSION PHASE</span><h2>{session.label}</h2><p>{session.detail}</p></div>
      <div className={styles.sessionTrack}><i style={{ width: `${session.progress}%` }} /><div><span>09:00 INPUT</span><span>09:15 NO CANCEL</span><span>09:20 MATCH</span><span>09:30 OPEN</span></div></div>
      <div className={styles.links}>
        <span className={payload?.sources.futu ? styles.online : ""}><i />Futu {payload?.sources.futu ? "connected" : "waiting for relay"}</span>
        <span className={payload?.sources.binance ? styles.online : ""}><i />Binance {payload?.sources.binance ? "live" : "reconnecting"}</span>
        <button className={adrFeedState === "live" || (adrFeedState === "partial" && !adrFeedError) ? styles.online : ""} onClick={() => adrFeedState === "auth-required" ? void beginPosleyLogin() : undefined}><i />{adrFeedState === "live" ? "Posley ADR live" : adrFeedState === "auth-required" ? "Connect Posley ADR" : adrFeedState === "partial" ? missingAdrStreams.length ? "ADR partial" : "ADR benchmark" : "ADR reconnecting"}</button>
      </div>
    </section>

    <section className={styles.controls}>
      <label><span>USD / HKD</span><input type="number" min="1" max="20" step="0.0001" value={usdHkd} onChange={(event) => setUsdHkd(event.target.value)} /><small>FX conversion · separate from shares/contract</small></label>
      <label><span>Alert threshold</span><input type="number" min="0" max="100" step="0.05" value={threshold} onChange={(event) => setThreshold(event.target.value)} /><small>Absolute midpoint basis %</small></label>
      <div className={styles.formula}><span>CROSS-VENUE NORMALIZATION</span><strong>HK fair: stock × perp shares · ADR fair: stock × ADR shares</strong><small>Both are converted with the same USD/HKD input.</small></div>
      <button onClick={() => setManagerOpen((open) => !open)}>{managerOpen ? "Close pair setup" : "Manage pairs"}</button>
    </section>

    {managerOpen && <section className={styles.manager}>
      <label>Futu stock<input value={draft.stockSymbol} onChange={(event) => setDraft((current) => ({ ...current, stockSymbol: event.target.value }))} placeholder="HK.00700" /></label>
      <label>Binance perp<input value={draft.perpSymbol} onChange={(event) => updatePerpDraft(event.target.value)} placeholder="HK0700USDT" /></label>
      <label>Shares per contract<input type="number" min="0.000001" step="0.01" value={draft.sharesPerContract} onChange={(event) => setDraft((current) => ({ ...current, sharesPerContract: event.target.value }))} /></label>
      <label>ADR ticker · optional<input value={draft.adrSymbol} onChange={(event) => setDraft((current) => ({ ...current, adrSymbol: event.target.value.toUpperCase() }))} placeholder="TCEHY" /></label>
      <label>HK shares per ADR<input type="number" min="0.000001" step="0.01" value={draft.hkSharesPerAdr} onChange={(event) => setDraft((current) => ({ ...current, hkSharesPerAdr: event.target.value }))} /></label>
      <button onClick={addPair}>Add mapping</button>
      {pairError && <p>{pairError}</p>}
    </section>}

    {payload?.errors?.length ? <div className={styles.notice}><strong>Partial data</strong><span>{payload.errors.join(" · ")}</span></div> : null}
    {adrFeedError || missingAdrStreams.length ? <div className={styles.notice}><strong>Posley ADR</strong><span>{adrFeedError || "Some configured ADR streams are not currently published."}{missingAdrStreams.length ? ` Missing: ${missingAdrStreams.join(", ")}.` : ""}</span>{adrFeedState === "auth-required" && <button onClick={() => void beginPosleyLogin()}>Connect</button>}</div> : null}

    <section className={styles.board}>
      <div className={styles.boardHead}><div><span>MONITORED MAPPINGS</span><h2>Executable auction basis</h2></div><p>{loading ? "Connecting…" : `${payload?.quotes.filter((quote) => quote.status === "live").length ?? 0}/${pairs.length} fully live`} · sorted by |mid basis|</p></div>
      <div className={styles.cards}>{orderedPairs.map((pair) => {
        const id = `${pair.stockSymbol}:${pair.perpSymbol}`;
        const quote = quoteById.get(id);
        const basisValue = quote?.metrics.midBasisPct ?? null;
        const hot = basisValue !== null && Math.abs(basisValue) >= alert;
        const sellPerpBasis = quote?.metrics.sellPerpBuyStock.basisPct ?? null;
        const buyPerpBasis = quote?.metrics.buyPerpSellStock.basisPct ?? null;
        const richEdge = sellPerpBasis ?? basisValue;
        const cheapEdge = buyPerpBasis === null ? (basisValue === null ? null : -basisValue) : -buyPerpBasis;
        const shortPerp = richEdge !== null && (cheapEdge === null || richEdge >= cheapEdge);
        const signalReady = basisValue !== null;
        const shortVenue = shortPerp ? "BINANCE" : "FUTU";
        const longVenue = shortPerp ? "FUTU" : "BINANCE";
        const shortSymbol = shortPerp ? pair.perpSymbol : pair.stockSymbol;
        const longSymbol = shortPerp ? pair.stockSymbol : pair.perpSymbol;
        const signalEdge = signalReady ? Math.max(richEdge ?? -Infinity, cheapEdge ?? -Infinity) : null;
        const activeTab = cardTabs[id] ?? "overview";
        const fundingPct = quote?.binance?.fundingRate === null || quote?.binance?.fundingRate === undefined ? null : quote.binance.fundingRate * 100;
        const adr = pair.adrSymbol ? adrBooks[pair.adrSymbol] : undefined;
        const adrFresh = Boolean(adr && now - adr.timestamp <= ADR_STALE_MS);
        const adrUsable = Boolean(adr && now - adr.timestamp <= ADR_BENCHMARK_MAX_AGE_MS);
        const adrMid = adrUsable && adr ? adr.bid !== null && adr.ask !== null ? (adr.bid + adr.ask) / 2 : adr.last : null;
        const adrRatio = pair.hkSharesPerAdr ?? null;
        const adrFairUsd = quote?.metrics.stockReferenceHkd !== null && quote?.metrics.stockReferenceHkd !== undefined && adrRatio !== null
          ? quote.metrics.stockReferenceHkd * adrRatio / Number(usdHkd) : null;
        const adrBasisPct = adrMid !== null && adrFairUsd !== null && adrFairUsd > 0 ? (adrMid / adrFairUsd - 1) * 100 : null;
        const adrImpliedHkd = adrMid !== null && adrRatio !== null ? adrMid * Number(usdHkd) / adrRatio : null;
        const adrRich = adrBasisPct !== null && adrBasisPct >= 0;
        return <article key={id} className={`${styles.card} ${hot ? styles.hotCard : ""}`}>
          <header><div><span>FUTU {pair.stockSymbol}</span><h3>{pair.perpSymbol}</h3><small>{pair.sharesPerContract.toLocaleString()} shares / perp{pair.adrSymbol ? ` · ${pair.adrSymbol} ${pair.hkSharesPerAdr} shares / ADR` : ""}</small></div><div className={`${styles.status} ${quote?.status === "live" ? styles.live : quote?.status === "stale" ? styles.stale : ""}`}><i />{quote?.status ?? "waiting"}</div></header>
          <div className={styles.basisHero}><span>MID BASIS</span><strong className={basisValue !== null && basisValue < 0 ? styles.negative : styles.positive}>{pct(basisValue)}</strong><small>{quote?.metrics.stockReferenceSource === "close-price" ? "Futu official close · overnight benchmark" : quote?.metrics.stockReferenceSource === "auction-price" ? "Futu auction / IEP reference" : quote?.metrics.stockReferenceSource === "book-mid" ? "Futu BBO midpoint proxy" : "No valid stock benchmark"}</small></div>
          <div className={`${styles.tradeSignal} ${!signalReady ? styles.signalWaiting : ""}`}>
            <div><span>SHORT LEG</span><strong>{signalReady ? `SHORT ${shortVenue}` : "WAITING"}</strong><small>{signalReady ? `${shortSymbol} · ${shortPerp ? "perpetual" : "Hong Kong stock"}` : "Awaiting both venues"}</small></div>
            <i>→</i>
            <div><span>LONG LEG</span><strong>{signalReady ? `LONG ${longVenue}` : "WAITING"}</strong><small>{signalReady ? `${longSymbol} · ${shortPerp ? "Hong Kong stock" : "perpetual"}` : "Awaiting both venues"}</small></div>
            <b>{signalReady ? `${signalEdge !== null && signalEdge >= 0 ? "EXECUTABLE EDGE" : "DIRECTIONAL BASIS"} ${pct(signalEdge)}` : "AWAITING BOTH VENUES"}</b>
          </div>
          <div className={styles.cardTabs} role="tablist" aria-label={`${pair.perpSymbol} card view`}>
            <button role="tab" aria-selected={activeTab === "overview"} onClick={() => setCardTabs((current) => ({ ...current, [id]: "overview" }))}>Overview</button>
            <button role="tab" aria-selected={activeTab === "history"} onClick={() => { setCardTabs((current) => ({ ...current, [id]: "history" })); void loadHistory(id, pair); }}>Spread history <span>{history[id]?.length ?? 0}</span></button>
          </div>
          {activeTab === "overview" ? <div className={styles.tabPanel} role="tabpanel">
            <dl className={styles.coreMetrics}>
              <div><dt>Futu benchmark · HKD</dt><dd>{number(quote?.metrics.stockReferenceHkd)}</dd></div>
              <div><dt>Fair perp · USDT</dt><dd>{number(quote?.metrics.fairUsdt)}</dd></div>
              <div><dt>Perp midpoint</dt><dd>{number(quote?.metrics.binanceMid)}</dd></div>
              <div><dt>Latest funding</dt><dd className={fundingPct !== null && fundingPct < 0 ? styles.negative : styles.positive}>{pct(fundingPct, 4)}</dd><small>Next {time(quote?.binance?.nextFundingTime)} HKT</small></div>
            </dl>
            {pair.adrSymbol ? <div className={`${styles.adrPanel} ${adrBasisPct !== null && Math.abs(adrBasisPct) >= alert ? styles.adrHot : ""}`}>
              <div><span>POSLEY ADR BASIS</span><strong className={adrBasisPct !== null && adrBasisPct < 0 ? styles.negative : styles.positive}>{pct(adrBasisPct)}</strong><small>{adrFresh ? `Live · ${adr?.streamKey} · ${time(adr?.timestamp)} HKT` : adrUsable && adr ? `Latest US benchmark · ${time(adr.timestamp)} HKT` : adr ? `Too old · ${time(adr.timestamp)} HKT` : "Waiting for the matching Posley stream"}</small></div>
              <dl><div><dt>{pair.adrSymbol} midpoint · USD</dt><dd>{number(adrMid, 4)}</dd></div><div><dt>ADR-implied HK share · HKD</dt><dd>{number(adrImpliedHkd, 3)}</dd></div><div><dt>ADR conversion</dt><dd>1 : {number(adrRatio, 3)}</dd><small>ADR : HK shares</small></div></dl>
              <div className={styles.adrDirection}><span>RELATIVE DIRECTION</span><strong>{adrBasisPct === null ? "WAITING FOR ADR" : adrRich ? `SHORT ${pair.adrSymbol} / LONG FUTU` : `LONG ${pair.adrSymbol} / SHORT FUTU`}</strong><small>{adrBasisPct === null ? "Unavailable or expired data is excluded" : `${adrFresh ? "Live" : "Latest US benchmark"} midpoint indication ${pct(Math.abs(adrBasisPct))}`}</small></div>
            </div> : null}
            <div className={styles.referenceNote}><span>LIVE REFERENCE</span><strong>{quote?.metrics.stockReferenceSource?.replaceAll("-", " ") ?? "Waiting for Futu"}</strong><small>Futu {time(quote?.futu?.marketTimestamp)} HKT · Binance {time(quote?.binance?.marketTimestamp)} HKT</small></div>
          </div> : <div className={styles.tabPanel} role="tabpanel">{historyLoading[id] ? <div className={styles.emptyChart}>Reading Futu and Binance one-minute history…</div> : historyError[id] ? <div className={styles.historyFailure}><strong>History unavailable</strong><span>{historyError[id]}</span><button onClick={() => void loadHistory(id, pair)}>Retry</button></div> : <SpreadHistory points={history[id] ?? []} cursor={historyCursor[id]} onCursor={(index) => setHistoryCursor((current) => ({ ...current, [id]: index }))} />}</div>}
          <footer><span>Futu {time(quote?.futu?.marketTimestamp)} HKT</span><span>Binance {time(quote?.binance?.marketTimestamp)} HKT</span><button aria-label={`Remove ${pair.perpSymbol}`} onClick={() => savePairs(pairs.filter((item) => item.stockSymbol !== pair.stockSymbol || item.perpSymbol !== pair.perpSymbol))}>Remove</button></footer>
        </article>;
      })}</div>
    </section>

    <footer className={styles.pageFooter}>Raw basis excludes fees, funding, FX execution cost, ADR fees and stock-lot rounding. ADR data older than 96 hours and missing venue data remain blank.</footer>
  </main>;
}
