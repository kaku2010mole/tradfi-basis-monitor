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

export default function Home() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [anchors, setAnchors] = useState<Record<string, Anchor>>({});
  const [venue, setVenue] = useState<"All" | Venue>("All");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("deviation");
  const [descending, setDescending] = useState(true);
  const [anchorAt, setAnchorAt] = useState(mostRecentSaturdayNine);
  const [anchorDraft, setAnchorDraft] = useState(() => toDateInput(mostRecentSaturdayNine()));
  const [status, setStatus] = useState<"connecting" | "live" | "stale">("connecting");
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [error, setError] = useState("");
  const anchorGeneration = useRef(0);

  const loadCurrent = useCallback(async () => {
    try {
      const response = await fetch("/api/markets", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { markets: Market[]; timestamp: number };
      setMarkets(data.markets);
      setLastRefresh(data.timestamp);
      setStatus("live");
      setError("");
    } catch {
      setStatus("stale");
      setError("实时行情暂时不可用，正在自动重连");
    }
  }, []);

  useEffect(() => {
    loadCurrent();
    const timer = window.setInterval(loadCurrent, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadCurrent]);

  useEffect(() => {
    if (!markets.length) return;
    const generation = ++anchorGeneration.current;
    const next: Record<string, Anchor> = {};
    for (const market of markets) next[anchorKey(market)] = { price: null, timestamp: null, loading: true };
    setAnchors(next);

    const queue = markets.map((market) => async () => {
      const key = anchorKey(market);
      try {
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
  }, [anchorAt, markets.length]);

  const rows = useMemo(() => {
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
    if (Number.isFinite(parsed)) setAnchorAt(parsed);
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

      <section className="hero">
        <div>
          <div className="eyebrow">REAL-TIME DERIVATIVES MONITOR</div>
          <h1>锚定一个时刻，观察市场偏航。</h1>
          <p>覆盖 Hyperliquid xyz 全部活跃合约与 Binance TradFi 标签合约；中间价、锚点偏离与资金费率同步更新。</p>
        </div>
        <div className="anchor-card">
          <label>价格锚点 <span>北京时间</span></label>
          <div className="anchor-control">
            <input
              aria-label="价格锚点，北京时间"
              type="datetime-local"
              value={anchorDraft}
              onChange={(event) => setAnchorDraft(event.target.value)}
            />
            <button onClick={applyAnchor}>应用</button>
          </div>
          <small>默认：最近一个周六 09:00 · 休市时取此前最近成交价</small>
        </div>
      </section>

      <section className="stat-strip">
        <div><span>监测合约</span><strong>{stats.total}</strong><small>当前筛选</small></div>
        <div><span>锚点上方</span><strong className="positive">{stats.up}</strong><small>偏离 &gt; 0</small></div>
        <div><span>锚点下方</span><strong className="negative">{stats.down}</strong><small>偏离 &lt; 0</small></div>
        <div><span>最大绝对偏离</span><strong>{formatPct(stats.extreme)}</strong><small>当前视图</small></div>
      </section>

      <section className="market-panel">
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
                <th className="number">锚点价格</th>
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
                    {row.anchor?.timestamp && <small>{formatBeijing(row.anchor.timestamp)} BJT</small>}
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
          <span>显示 {rows.length} 个合约 · 锚点已加载 {stats.anchorsReady}/{markets.length}</span>
          <span><i className="dot" /> 每 5 秒更新 · 数据源：Hyperliquid / Binance Futures</span>
        </footer>
      </section>
    </main>
  );
}

function SortMark({ active, desc }: { active: boolean; desc: boolean }) {
  return <span className={`sort-mark ${active ? "active" : ""}`}>{active ? (desc ? "↓" : "↑") : "↕"}</span>;
}
