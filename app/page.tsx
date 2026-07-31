"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Venue = "Hyperliquid" | "Binance";
type Market = {
  venue: Venue;
  symbol: string;
  displaySymbol: string;
  category: string;
  mid: number | null;
  bid: number | null;
  ask: number | null;
  funding: number | null;
  fundingHours: number;
  updatedAt: number;
};

type Anchor = { price: number | null; timestamp: number | null; loading?: boolean; error?: boolean };
type LinkHealth = { online: boolean; lastActivity: number | null };

const REFRESH_MS = 5000;
const LIVE_QUOTE_MAX_AGE_MS = 30_000;

function mostRecentSaturdayNine() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const daysBack = (weekday - 6 + 7) % 7;
  const candidate = new Date(`${get("year")}-${get("month")}-${get("day")}T09:00:00+08:00`);
  candidate.setUTCDate(candidate.getUTCDate() - daysBack);
  if (candidate.getTime() > now.getTime()) candidate.setUTCDate(candidate.getUTCDate() - 7);
  return candidate.getTime();
}

const formatPrice = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return "—";
  const digits = value >= 1000 ? 2 : value >= 10 ? 3 : value >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) });
};

const formatPct = (value: number | null, digits = 2) =>
  value == null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;

const formatBeijing = (timestamp: number | null, withDate = true) =>
  timestamp == null
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        ...(withDate ? { month: "2-digit", day: "2-digit" } : {}),
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(timestamp);

const toDateInput = (timestamp: number) => {
  const date = new Date(timestamp + 8 * 3600_000);
  return date.toISOString().slice(0, 16);
};

const anchorKey = (market: Market) => `${market.venue}:${market.symbol}`;

async function loadBinanceDirect(): Promise<Market[]> {
  const [exchangeResponse, bookResponse, premiumResponse, fundingResponse] = await Promise.all([
    fetch("https://fapi.binance.com/fapi/v1/exchangeInfo"),
    fetch("https://fapi.binance.com/fapi/v1/ticker/bookTicker"),
    fetch("https://fapi.binance.com/fapi/v1/premiumIndex"),
    fetch("https://fapi.binance.com/fapi/v1/fundingInfo").catch(() => null),
  ]);
  if (!exchangeResponse.ok || !bookResponse.ok || !premiumResponse.ok) throw new Error("Binance unavailable");
  const exchangeInfo = await exchangeResponse.json() as {
    symbols: Array<{ symbol: string; status: string; underlyingType?: string; underlyingSubType?: string[] }>;
  };
  const bookTicker = await bookResponse.json() as Array<{ symbol: string; bidPrice: string; askPrice: string; time: number }>;
  const premiumIndex = await premiumResponse.json() as Array<{ symbol: string; lastFundingRate: string; time: number }>;
  const fundingInfo = fundingResponse?.ok
    ? await fundingResponse.json() as Array<{ symbol: string; fundingIntervalHours: number }>
    : [];
  const books = new Map(bookTicker.map((item) => [item.symbol, item]));
  const premiums = new Map(premiumIndex.map((item) => [item.symbol, item]));
  const intervals = new Map(fundingInfo.map((item) => [item.symbol, item.fundingIntervalHours]));
  const now = Date.now();

  return exchangeInfo.symbols
    .filter((item) => item.status === "TRADING" && item.underlyingSubType?.some((tag) => tag.toLowerCase() === "tradfi"))
    .map((item) => {
      const book = books.get(item.symbol);
      const premium = premiums.get(item.symbol);
      const bid = Number(book?.bidPrice);
      const ask = Number(book?.askPrice);
      return {
        venue: "Binance" as const,
        symbol: item.symbol,
        displaySymbol: item.symbol,
        category: `${item.underlyingType ?? "TradFi"} · TradFi`,
        bid: Number.isFinite(bid) && bid > 0 ? bid : null,
        ask: Number.isFinite(ask) && ask > 0 ? ask : null,
        mid: Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null,
        funding: Number.isFinite(Number(premium?.lastFundingRate)) ? Number(premium?.lastFundingRate) : null,
        fundingHours: intervals.get(item.symbol) ?? 8,
        updatedAt: book ? now : 0,
      };
    });
}

export default function Home() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [anchors, setAnchors] = useState<Record<string, Anchor>>({});
  const [venue, setVenue] = useState<"All" | Venue>("All");
  const [query, setQuery] = useState("");
  const [threshold, setThreshold] = useState(1);
  const [mobileSide, setMobileSide] = useState<"positive" | "negative">("positive");
  const [anchorAt, setAnchorAt] = useState(mostRecentSaturdayNine);
  const [anchorDraft, setAnchorDraft] = useState(() => toDateInput(mostRecentSaturdayNine()));
  const [anchorRevision, setAnchorRevision] = useState(0);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "stale">("connecting");
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [links, setLinks] = useState<Record<"snapshot" | "hyperliquid" | "binance", LinkHealth>>({
    snapshot: { online: false, lastActivity: null },
    hyperliquid: { online: false, lastActivity: null },
    binance: { online: false, lastActivity: null },
  });
  const anchorGeneration = useRef(0);

  const loadCurrent = useCallback(async () => {
    try {
      const response = await fetch("/api/markets", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { markets: Market[]; timestamp: number; sources?: { binance?: boolean } };
      let nextMarkets = data.markets;
      if (!data.sources?.binance) {
        try {
          const binance = await loadBinanceDirect();
          nextMarkets = [...data.markets.filter((item) => item.venue !== "Binance"), ...binance];
        } catch {
          // Keep Hyperliquid live when Binance is unavailable from both routes.
        }
      }
      if (!nextMarkets.length) throw new Error("No market data");
      setMarkets((previous) => {
        const previousMap = new Map(previous.map((item) => [anchorKey(item), item]));
        return nextMarkets.map((item) => {
          const old = previousMap.get(anchorKey(item));
          return old && old.updatedAt > item.updatedAt
            ? { ...item, bid: old.bid, ask: old.ask, mid: old.mid, updatedAt: old.updatedAt }
            : item;
        });
      });
      setLastRefresh(data.timestamp);
      setStatus("live");
      setError("");
      setLinks((previous) => ({ ...previous, snapshot: { online: true, lastActivity: Date.now() } }));
    } catch {
      setStatus("stale");
      setError("Market snapshot unavailable. Reconnecting automatically.");
      setLinks((previous) => ({ ...previous, snapshot: { ...previous.snapshot, online: false } }));
    }
  }, []);

  useEffect(() => {
    if (!started) return;
    loadCurrent();
    const timer = window.setInterval(loadCurrent, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadCurrent, started]);

  const marketSignature = useMemo(
    () => markets.map((item) => `${item.venue}:${item.symbol}`).sort().join("|"),
    [markets],
  );

  useEffect(() => {
    if (!started || !marketSignature) return;
    const hyperSymbols = markets.filter((item) => item.venue === "Hyperliquid").map((item) => item.symbol);
    let hyperSocket: WebSocket | null = null;
    let binanceSocket: WebSocket | null = null;
    let stopped = false;
    let reconnectTimer: number | undefined;

    const applyQuote = (venueName: Venue, symbol: string, bid: number, ask: number, timestamp: number) => {
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
      setMarkets((previous) => previous.map((item) =>
        item.venue === venueName && item.symbol === symbol
          ? { ...item, bid, ask, mid: (bid + ask) / 2, updatedAt: timestamp }
          : item,
      ));
    };

    const connect = () => {
      if (stopped) return;
      hyperSocket = new WebSocket("wss://api.hyperliquid.xyz/ws");
      hyperSocket.onopen = () => {
        setLinks((previous) => ({ ...previous, hyperliquid: { online: true, lastActivity: Date.now() } }));
        hyperSymbols.forEach((coin) => {
          hyperSocket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin } }));
        });
      };
      hyperSocket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as {
            channel?: string;
            data?: { coin?: string; time?: number; levels?: Array<Array<{ px: string }>> };
          };
          if (message.channel !== "l2Book" || !message.data?.coin) return;
          const bid = Number(message.data.levels?.[0]?.[0]?.px);
          const ask = Number(message.data.levels?.[1]?.[0]?.px);
          applyQuote("Hyperliquid", message.data.coin, bid, ask, message.data.time ?? Date.now());
          setLinks((previous) => ({ ...previous, hyperliquid: { online: true, lastActivity: Date.now() } }));
        } catch { /* ignore malformed frames */ }
      };

      binanceSocket = new WebSocket("wss://fstream.binance.com/ws/!bookTicker");
      binanceSocket.onopen = () => {
        setLinks((previous) => ({ ...previous, binance: { online: true, lastActivity: Date.now() } }));
      };
      binanceSocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as
            | { s?: string; b?: string; a?: string; E?: number; T?: number }
            | Array<{ s?: string; b?: string; a?: string; E?: number; T?: number }>;
          const updates = Array.isArray(payload) ? payload : [payload];
          updates.forEach((item) => {
            if (item.s) applyQuote("Binance", item.s, Number(item.b), Number(item.a), item.E ?? item.T ?? Date.now());
          });
          setLinks((previous) => ({ ...previous, binance: { online: true, lastActivity: Date.now() } }));
        } catch { /* ignore malformed frames */ }
      };

      const reconnect = () => {
        if (!stopped && !reconnectTimer) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined;
            connect();
          }, 2500);
        }
      };
      hyperSocket.onclose = () => {
        setLinks((previous) => ({ ...previous, hyperliquid: { ...previous.hyperliquid, online: false } }));
        reconnect();
      };
      binanceSocket.onclose = () => {
        setLinks((previous) => ({ ...previous, binance: { ...previous.binance, online: false } }));
        reconnect();
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      hyperSocket?.close();
      binanceSocket?.close();
    };
  }, [started, marketSignature]);

  useEffect(() => {
    if (!started || !markets.length) return;
    const generation = ++anchorGeneration.current;
    const next: Record<string, Anchor> = {};
    for (const market of markets) next[anchorKey(market)] = { price: null, timestamp: null, loading: true };
    setAnchors(next);

    const queue = markets.map((market) => async () => {
      const key = anchorKey(market);
      try {
        if (market.venue === "Binance") {
          const targetMinute = Math.floor(anchorAt / 60_000) * 60_000;
          const directParams = new URLSearchParams({
            symbol: market.symbol,
            interval: "1m",
            startTime: String(targetMinute),
            endTime: String(targetMinute + 60_000),
            limit: "2",
          });
          const direct = await fetch(`https://fapi.binance.com/fapi/v1/markPriceKlines?${directParams}`);
          if (!direct.ok) throw new Error();
          const candles = await direct.json() as Array<[number, string, string, string, string]>;
          const candle = candles.find((item) => item[0] === targetMinute);
          if (anchorGeneration.current === generation) {
            setAnchors((previous) => ({
              ...previous,
              [key]: { price: candle ? Number(candle[4]) : null, timestamp: candle?.[0] ?? null },
            }));
          }
          return;
        }
        const params = new URLSearchParams({ venue: market.venue, symbol: market.symbol, at: String(anchorAt) });
        const response = await fetch(`/api/anchor?${params}`);
        if (!response.ok) throw new Error();
        const value = (await response.json()) as Anchor;
        if (anchorGeneration.current === generation) {
          setAnchors((previous) => ({ ...previous, [key]: value }));
        }
      } catch {
        if (anchorGeneration.current === generation) {
          setAnchors((previous) => ({ ...previous, [key]: { price: null, timestamp: null, error: true } }));
        }
      }
    });

    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length && anchorGeneration.current === generation) {
        const task = queue[cursor++];
        await task();
      }
    };
    Promise.all(Array.from({ length: 8 }, worker));
  }, [anchorAt, anchorRevision, markets.length, started]);

  const rows = useMemo(() => {
    const now = Date.now();
    const enriched = markets.map((market) => {
      const anchor = anchors[anchorKey(market)];
      const deviation =
        market.mid != null && anchor?.price != null && anchor.price !== 0
          ? ((market.mid - anchor.price) / anchor.price) * 100
          : null;
      return { ...market, anchor, deviation };
    });
    const filtered = enriched.filter(
      (row) =>
        row.mid != null &&
        now - row.updatedAt <= LIVE_QUOTE_MAX_AGE_MS &&
        !row.anchor?.loading &&
        row.anchor?.price != null &&
        (venue === "All" || row.venue === venue) &&
        (!query || `${row.displaySymbol} ${row.category}`.toLowerCase().includes(query.toLowerCase())),
    );
    return filtered.sort((a, b) => Math.abs(b.deviation ?? 0) - Math.abs(a.deviation ?? 0));
  }, [markets, anchors, venue, query]);

  const positiveAlerts = useMemo(
    () => rows.filter((row) => (row.deviation ?? 0) >= threshold),
    [rows, threshold],
  );
  const negativeAlerts = useMemo(
    () => rows.filter((row) => (row.deviation ?? 0) <= -threshold),
    [rows, threshold],
  );

  const stats = useMemo(() => {
    const deviations = rows.map((row) => row.deviation).filter((value): value is number => value != null);
    return {
      total: rows.length,
      up: positiveAlerts.length,
      down: negativeAlerts.length,
      extreme: deviations.length ? Math.max(...deviations.map(Math.abs)) : null,
      anchorsReady: Object.values(anchors).filter((value) => !value.loading).length,
    };
  }, [rows, anchors, positiveAlerts.length, negativeAlerts.length]);

  const applyAnchor = () => {
    const parsed = Date.parse(`${anchorDraft}:00+08:00`);
    if (Number.isFinite(parsed)) {
      setAnchorAt(parsed);
      setAnchorRevision((value) => value + 1);
      setStarted(true);
      setStatus("connecting");
    }
  };

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>TradFi Basis Monitor</strong>
            <span>Cross-venue market pulse</span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className={`connection ${status}`}>
            <i />
            {status === "live" ? "LIVE" : status === "connecting" ? "CONNECTING" : "RECONNECTING"}
            <span>{lastRefresh ? formatBeijing(lastRefresh, false) : "—"} BJT</span>
          </div>
          <form className="sign-out" action="/logout" method="post">
            <button type="submit">Lock</button>
          </form>
        </div>
      </header>

      <section className={`hero ${started ? "compact" : ""}`}>
        <div>
          <div className="eyebrow">REAL-TIME DERIVATIVES MONITOR</div>
          <h1>{started ? "Deviation alert board" : "Set the anchor. Then watch the drift."}</h1>
          <p>{started
            ? `Anchor: ${formatBeijing(anchorAt)} BJT · Live midpoint, deviation and funding monitoring`
            : "Choose a Beijing-time anchor. No market data is requested until monitoring starts."}
          </p>
        </div>
        <div className={`anchor-card ${!started ? "attention" : ""}`}>
          <label>Price anchor <span>BEIJING TIME</span></label>
          <div className="anchor-control">
            <input
              aria-label="Price anchor in Beijing time"
              type="datetime-local"
              value={anchorDraft}
              onChange={(event) => setAnchorDraft(event.target.value)}
            />
            <button onClick={applyAnchor}>{started ? "Re-anchor" : "Start monitoring"}</button>
          </div>
          <small>{started ? "Changing the anchor reloads every reference price" : "Preset to the latest Saturday at 09:00 BJT"}</small>
        </div>
      </section>

      {!started && (
        <section className="preflight">
          <div className="preflight-number">01</div>
          <div><strong>Choose an anchor</strong><span>Every deviation uses this exact minute</span></div>
          <div className="preflight-arrow">→</div>
          <div className="preflight-number">02</div>
          <div><strong>Start live monitoring</strong><span>Snapshots refresh every five seconds</span></div>
        </section>
      )}

      {started && <section className="stat-strip">
        <div><span>Eligible contracts</span><strong>{stats.total}</strong><small>LIVE + EXACT ANCHOR</small></div>
        <div><span>Positive alerts</span><strong className="positive">{stats.up}</strong><small>AT OR ABOVE +{threshold.toFixed(2)}%</small></div>
        <div><span>Negative alerts</span><strong className="negative">{stats.down}</strong><small>AT OR BELOW −{threshold.toFixed(2)}%</small></div>
        <div><span>Largest absolute drift</span><strong>{formatPct(stats.extreme)}</strong><small>CURRENT FILTER</small></div>
      </section>}

      {started && <section className="market-panel">
        <div className="link-monitor">
          <div className="link-monitor-title"><span>LINK STATUS</span><small>Independent feed health</small></div>
          <LinkBadge name="Snapshot API" state={links.snapshot} />
          <LinkBadge name="Hyperliquid WS" state={links.hyperliquid} />
          <LinkBadge name="Binance WS" state={links.binance} />
        </div>
        <div className="toolbar">
          <div className="tabs" role="tablist" aria-label="Venue filter">
            {(["All", "Hyperliquid", "Binance"] as const).map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={venue === item}
                className={venue === item ? "active" : ""}
                onClick={() => setVenue(item)}
              >
                {item === "All" ? "All venues" : item}
                <span>{item === "All" ? markets.length : markets.filter((m) => m.venue === item).length}</span>
              </button>
            ))}
          </div>
          <label className="threshold-control">
            <span>Alert threshold</span>
            <div>
              <input
                aria-label="Deviation alert threshold"
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={threshold}
                onChange={(event) => setThreshold(Math.max(0, Number(event.target.value) || 0))}
              />
              <b>%</b>
            </div>
          </label>
          <div className="search">
            <span>⌕</span>
            <input aria-label="Search contracts" placeholder="Search contracts…" value={query} onChange={(event) => setQuery(event.target.value)} />
            <kbd>/</kbd>
          </div>
        </div>

        {error && <div className="notice">{error}</div>}

        <div className="mobile-board-switch" role="group" aria-label="Deviation direction">
          <button
            type="button"
            aria-pressed={mobileSide === "positive"}
            className={mobileSide === "positive" ? "active positive-tab" : ""}
            onClick={() => setMobileSide("positive")}
          >
            <span>↗ Positive</span><b>{positiveAlerts.length}</b>
          </button>
          <button
            type="button"
            aria-pressed={mobileSide === "negative"}
            className={mobileSide === "negative" ? "active negative-tab" : ""}
            onClick={() => setMobileSide("negative")}
          >
            <span>↘ Negative</span><b>{negativeAlerts.length}</b>
          </button>
        </div>

        <div className="deviation-board">
          <section className={`deviation-side positive-side ${mobileSide === "positive" ? "mobile-active" : ""}`}>
            <header>
              <div><span className="side-arrow">↗</span><strong>Positive deviation</strong></div>
              <b>{positiveAlerts.length}</b>
            </header>
            <div className="alert-list">
              {positiveAlerts.map((row) => <DeviationCard key={anchorKey(row)} row={row} />)}
              {!positiveAlerts.length && <div className="side-empty">No contract exceeds +{threshold.toFixed(2)}%</div>}
            </div>
          </section>
          <section className={`deviation-side negative-side ${mobileSide === "negative" ? "mobile-active" : ""}`}>
            <header>
              <div><span className="side-arrow">↘</span><strong>Negative deviation</strong></div>
              <b>{negativeAlerts.length}</b>
            </header>
            <div className="alert-list">
              {negativeAlerts.map((row) => <DeviationCard key={anchorKey(row)} row={row} />)}
              {!negativeAlerts.length && <div className="side-empty">No contract exceeds −{threshold.toFixed(2)}%</div>}
            </div>
          </section>
        </div>
        <footer className="panel-footer">
          <span>{rows.length} live contracts with exact anchors · {stats.anchorsReady}/{markets.length} checked</span>
          <span><i className="dot" /> 5-second snapshots + WebSocket increments</span>
        </footer>
      </section>}
    </main>
  );
}

type AlertRow = Market & { anchor?: Anchor; deviation: number | null };

function DeviationCard({ row }: { row: AlertRow }) {
  const isPositive = (row.deviation ?? 0) >= 0;
  return (
    <article className={`alert-card ${isPositive ? "is-positive" : "is-negative"}`}>
      <div className="alert-identity">
        <span className={row.venue === "Hyperliquid" ? "hl" : "bn"}>{row.displaySymbol.slice(0, 2)}</span>
        <div><strong>{row.displaySymbol}</strong><small>{row.venue} · {row.category}</small></div>
      </div>
      <div className="alert-deviation">{formatPct(row.deviation)}</div>
      <dl>
        <div><dt>Midpoint</dt><dd>{formatPrice(row.mid)}</dd></div>
        <div><dt>Anchor</dt><dd>{formatPrice(row.anchor?.price ?? null)}</dd></div>
        <div><dt>Funding / {row.fundingHours}h</dt><dd className={(row.funding ?? 0) >= 0 ? "positive" : "negative"}>{formatPct(row.funding == null ? null : row.funding * 100, 4)}</dd></div>
      </dl>
      <div className="alert-quote"><span>Bid {formatPrice(row.bid)}</span><span>Ask {formatPrice(row.ask)}</span></div>
    </article>
  );
}

function LinkBadge({ name, state }: { name: string; state: LinkHealth }) {
  return (
    <div className={`link-badge ${state.online ? "online" : "offline"}`}>
      <i />
      <div><strong>{name}</strong><small>{state.online ? "ONLINE" : "OFFLINE"} · {state.lastActivity ? `${formatBeijing(state.lastActivity, false)} BJT` : "No activity"}</small></div>
    </div>
  );
}
