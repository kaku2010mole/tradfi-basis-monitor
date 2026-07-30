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
type SortKey = "symbol" | "mid" | "deviation" | "funding";

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
        updatedAt: book?.time ?? premium?.time ?? now,
      };
    });
}

export default function Home() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [anchors, setAnchors] = useState<Record<string, Anchor>>({});
  const [venue, setVenue] = useState<"All" | Venue>("All");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("deviation");
  const [descending, setDescending] = useState(true);
  const [anchorAt, setAnchorAt] = useState(mostRecentSaturdayNine);
  const [anchorDraft, setAnchorDraft] = useState(() => toDateInput(mostRecentSaturdayNine()));
  const [anchorRevision, setAnchorRevision] = useState(0);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "stale">("connecting");
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [error, setError] = useState("");
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
    } catch {
      setStatus("stale");
      setError("实时行情暂时不可用，正在自动重连");
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
        } catch { /* ignore malformed frames */ }
      };

      binanceSocket = new WebSocket("wss://fstream.binance.com/ws/!bookTicker");
      binanceSocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as
            | { s?: string; b?: string; a?: string; E?: number; T?: number }
            | Array<{ s?: string; b?: string; a?: string; E?: number; T?: number }>;
          const updates = Array.isArray(payload) ? payload : [payload];
          updates.forEach((item) => {
            if (item.s) applyQuote("Binance", item.s, Number(item.b), Number(item.a), item.E ?? item.T ?? Date.now());
          });
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
      hyperSocket.onclose = reconnect;
      binanceSocket.onclose = reconnect;
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
        const params = new URLSearchParams({ venue: market.venue, symbol: market.symbol, at: String(anchorAt) });
        const response = await fetch(`/api/anchor?${params}`);
        if (!response.ok) {
          if (market.venue !== "Binance") throw new Error();
          const params = new URLSearchParams({
            symbol: market.symbol,
            interval: "1m",
            startTime: String(anchorAt - 3 * 24 * 3600_000),
            endTime: String(anchorAt + 60_000),
            limit: "1500",
          });
          const direct = await fetch(`https://fapi.binance.com/fapi/v1/klines?${params}`);
          if (!direct.ok) throw new Error();
          const candles = await direct.json() as Array<[number, string, string, string, string]>;
          const targetMinute = Math.floor(anchorAt / 60_000) * 60_000;
          const candle = candles.find((item) => item[0] === targetMinute);
          if (anchorGeneration.current === generation) {
            setAnchors((previous) => ({
              ...previous,
              [key]: { price: candle ? Number(candle[4]) : null, timestamp: candle?.[0] ?? null },
            }));
          }
          return;
        }
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
    return filtered.sort((a, b) => {
      const av = sort === "symbol" ? a.displaySymbol : sort === "deviation" ? a.deviation : a[sort];
      const bv = sort === "symbol" ? b.displaySymbol : sort === "deviation" ? b.deviation : b[sort];
      if (av == null) return 1;
      if (bv == null) return -1;
      const compared = typeof av === "string" ? av.localeCompare(String(bv)) : Number(av) - Number(bv);
      return descending ? -compared : compared;
    });
  }, [markets, anchors, venue, query, sort, descending]);

  const stats = useMemo(() => {
    const deviations = rows.map((row) => row.deviation).filter((value): value is number => value != null);
    return {
      total: rows.length,
      up: deviations.filter((value) => value > 0).length,
      down: deviations.filter((value) => value < 0).length,
      extreme: deviations.length ? Math.max(...deviations.map(Math.abs)) : null,
      anchorsReady: Object.values(anchors).filter((value) => !value.loading).length,
    };
  }, [rows, anchors]);

  const applyAnchor = () => {
    const parsed = Date.parse(`${anchorDraft}:00+08:00`);
    if (Number.isFinite(parsed)) {
      setAnchorAt(parsed);
      setAnchorRevision((value) => value + 1);
      setStarted(true);
      setStatus("connecting");
    }
  };

  const setSortKey = (key: SortKey) => {
    if (key === sort) setDescending((value) => !value);
    else {
      setSort(key);
      setDescending(key !== "symbol");
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
        <div className={`connection ${status}`}>
          <i />
          {status === "live" ? "LIVE" : status === "connecting" ? "CONNECTING" : "RECONNECTING"}
          <span>{lastRefresh ? formatBeijing(lastRefresh, false) : "—"} BJT</span>
        </div>
      </header>

      <section className={`hero ${started ? "compact" : ""}`}>
        <div>
          <div className="eyebrow">REAL-TIME DERIVATIVES MONITOR</div>
          <h1>{started ? "市场偏航监测" : "先锚定，再观察。"}</h1>
          <p>{started
            ? `当前锚点：${formatBeijing(anchorAt)} BJT · 中间价、偏离与资金费率每 5 秒更新`
            : "选择一个北京时间锚点。点击开始前不会请求或刷新任何行情数据。"}
          </p>
        </div>
        <div className={`anchor-card ${!started ? "attention" : ""}`}>
          <label>价格锚点 <span>北京时间</span></label>
          <div className="anchor-control">
            <input
              aria-label="价格锚点，北京时间"
              type="datetime-local"
              value={anchorDraft}
              onChange={(event) => setAnchorDraft(event.target.value)}
            />
            <button onClick={applyAnchor}>{started ? "重新锚定" : "开始监测"}</button>
          </div>
          <small>{started ? "修改后将重新加载全部锚点" : "已预填最近一个周六 09:00；可直接修改"}</small>
        </div>
      </section>

      {!started && (
        <section className="preflight">
          <div className="preflight-number">01</div>
          <div><strong>选择锚点时间</strong><span>所有偏离均以此时间为基准</span></div>
          <div className="preflight-arrow">→</div>
          <div className="preflight-number">02</div>
          <div><strong>开始实时监测</strong><span>启动后每 5 秒刷新行情</span></div>
        </section>
      )}

      {started && <section className="stat-strip">
        <div><span>监测合约</span><strong>{stats.total}</strong><small>当前筛选</small></div>
        <div><span>锚点上方</span><strong className="positive">{stats.up}</strong><small>偏离 &gt; 0</small></div>
        <div><span>锚点下方</span><strong className="negative">{stats.down}</strong><small>偏离 &lt; 0</small></div>
        <div><span>最大绝对偏离</span><strong>{formatPct(stats.extreme)}</strong><small>当前视图</small></div>
      </section>}

      {started && <section className="market-panel">
        <div className="toolbar">
          <div className="tabs" role="tablist" aria-label="交易所筛选">
            {(["All", "Hyperliquid", "Binance"] as const).map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={venue === item}
                className={venue === item ? "active" : ""}
                onClick={() => setVenue(item)}
              >
                {item === "All" ? "全部市场" : item}
                <span>{item === "All" ? markets.length : markets.filter((m) => m.venue === item).length}</span>
              </button>
            ))}
          </div>
          <div className="search">
            <span>⌕</span>
            <input aria-label="搜索合约" placeholder="搜索合约…" value={query} onChange={(event) => setQuery(event.target.value)} />
            <kbd>/</kbd>
          </div>
        </div>

        {error && <div className="notice">{error}</div>}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th onClick={() => setSortKey("symbol")}>合约 <SortMark active={sort === "symbol"} desc={descending} /></th>
                <th>市场</th>
                <th className="number">买一 / 卖一</th>
                <th className="number" onClick={() => setSortKey("mid")}>中间价 <SortMark active={sort === "mid"} desc={descending} /></th>
                <th className="number anchor-heading">锚点价格 <small>{formatBeijing(anchorAt)} BJT</small></th>
                <th className="number" onClick={() => setSortKey("deviation")}>偏离 <SortMark active={sort === "deviation"} desc={descending} /></th>
                <th className="number" onClick={() => setSortKey("funding")}>Funding <SortMark active={sort === "funding"} desc={descending} /></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={anchorKey(row)}>
                  <td>
                    <div className="symbol">
                      <span className={row.venue === "Hyperliquid" ? "hl" : "bn"}>{row.displaySymbol.slice(0, 2)}</span>
                      <div><strong>{row.displaySymbol}</strong><small>{row.category}</small></div>
                    </div>
                  </td>
                  <td><span className={`venue-pill ${row.venue === "Hyperliquid" ? "hl" : "bn"}`}>{row.venue}</span></td>
                  <td className="number quote-pair">
                    <span>{formatPrice(row.bid)}</span><em>/</em><span>{formatPrice(row.ask)}</span>
                  </td>
                  <td className="number mid">{formatPrice(row.mid)}</td>
                  <td className="number anchor-price">
                    {row.anchor?.loading ? <span className="shimmer" /> : formatPrice(row.anchor?.price ?? null)}
                  </td>
                  <td className={`number deviation ${(row.deviation ?? 0) > 0 ? "positive" : (row.deviation ?? 0) < 0 ? "negative" : ""}`}>
                    {formatPct(row.deviation)}
                    {row.deviation != null && <span className="bar"><i style={{ width: `${Math.min(Math.abs(row.deviation) * 5, 100)}%` }} /></span>}
                  </td>
                  <td className={`number funding ${(row.funding ?? 0) > 0 ? "positive" : (row.funding ?? 0) < 0 ? "negative" : ""}`}>
                    {formatPct(row.funding == null ? null : row.funding * 100, 4)}
                    <small>{row.fundingHours}h</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">{markets.length ? "没有匹配的合约" : "正在连接交易所行情…"}</div>}
        </div>
        <footer className="panel-footer">
          <span>显示 {rows.length} 个实时且具备精确锚点的合约 · 已检查 {stats.anchorsReady}/{markets.length}</span>
          <span><i className="dot" /> WebSocket 实时报价 · 陈旧超过 30 秒自动隐藏</span>
        </footer>
      </section>}
    </main>
  );
}

function SortMark({ active, desc }: { active: boolean; desc: boolean }) {
  return <span className={`sort-mark ${active ? "active" : ""}`}>{active ? (desc ? "↓" : "↑") : "↕"}</span>;
}
