"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PageSwitcher from "../components/PageSwitcher";

type ClockModel = {
  offsetMinutes: number;
  minutesToClose: number;
  n: number;
  intercept: number;
  slope: number;
  mean: number;
  scale: number;
  baseHigher: number;
  shrink: number;
  evidenceWeight: number;
  bootstrap: number[][];
};

type ModelFile = {
  generatedAt: string;
  target: string;
  method: string;
  coverage: { first: string; last: string; candles: number; dailyCloses: number; targets: number; missing30mBars: number };
  latestAnchor: { time: number; price: number };
  baseHigher: number;
  clocks: ClockModel[];
  backtests: Array<{ horizon: string; n: number; accuracy: number; auc: number; brier: number; baselineBrier: number }>;
  fallbackHistory: Array<{ time: number; price: number; higher: number }>;
};

type LiveFile = {
  ok: boolean;
  serverTime: number;
  quote: { mark: number; oracle: number; mid: number | null; funding: number; openInterest: number; dayVolume: number };
  candles: Array<{ time: number; close: number; high: number; low: number; volume: number }>;
};

type ChartPoint = { time: number; price: number; higher: number };
type Prediction = { higher: number; lower: number; low: number; high: number; clock: ClockModel; signal: number };

const HALF_HOUR = 30 * 60 * 1_000;
const DAY = 24 * 60 * 60 * 1_000;

function clamp(value: number, low: number, high: number) { return Math.max(low, Math.min(high, value)); }
function logistic(value: number) { return 1 / (1 + Math.exp(-value)); }
function percentile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function money(value: number, digits = 1) { return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }); }
function compact(value: number) { return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function hkt(value: number, withDate = false) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    ...(withDate ? { day: "2-digit", month: "short" } : {}),
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(value);
}
function dateOnly(value: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function predict(clock: ClockModel, signal: number): Prediction {
  const raw = logistic(clock.intercept + clock.slope * ((signal - clock.mean) / clock.scale));
  const robust = clamp(clock.baseHigher + clock.evidenceWeight * clock.shrink * (raw - clock.baseHigher), 0.15, 0.85);
  const boot = clock.bootstrap.map(([intercept, slope, mean, scale, base, shrink]) => {
    const p = logistic(intercept + slope * ((signal - mean) / scale));
    return clamp(base + clock.evidenceWeight * shrink * (p - base), 0.05, 0.95);
  });
  return {
    higher: robust * 100,
    lower: (1 - robust) * 100,
    low: percentile(boot, 0.025) * 100,
    high: percentile(boot, 0.975) * 100,
    clock,
    signal,
  };
}

function selectClock(clocks: ClockModel[], anchorClose: number, at: number) {
  const elapsed = Math.max(HALF_HOUR, at - anchorClose);
  const offset = clamp(Math.round(elapsed / HALF_HOUR), 1, 47) * 30;
  return clocks.reduce((best, clock) => Math.abs(clock.offsetMinutes - offset) < Math.abs(best.offsetMinutes - offset) ? clock : best);
}

function findAnchor(candles: LiveFile["candles"]) {
  return [...candles].reverse().find((bar) => {
    const date = new Date(bar.time);
    return date.getUTCHours() === 6 && date.getUTCMinutes() === 0;
  });
}

function LiveChart({ points }: { points: ChartPoint[] }) {
  const [range, setRange] = useState<"6H" | "12H" | "FULL">("FULL");
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const shown = useMemo(() => {
    if (!points.length || range === "FULL") return points;
    const hours = range === "6H" ? 6 : 12;
    const cutoff = points[points.length - 1].time - hours * 60 * 60 * 1_000;
    return points.filter((point) => point.time >= cutoff);
  }, [points, range]);
  const W = 1000, H = 390, L = 64, R = 22, topA = 28, bottomA = 178, topB = 235, bottomB = 360;
  const t0 = shown[0]?.time ?? 0, t1 = shown[shown.length - 1]?.time ?? 1;
  const prices = shown.map((d) => d.price);
  const pMin = prices.length ? Math.min(...prices) : 0, pMax = prices.length ? Math.max(...prices) : 1;
  const pad = Math.max((pMax - pMin) * 0.15, pMax * 0.001);
  const x = (time: number) => L + ((time - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const yPrice = (value: number) => bottomA - ((value - (pMin - pad)) / Math.max(1e-6, pMax - pMin + 2 * pad)) * (bottomA - topA);
  const yProb = (value: number) => bottomB - (value / 100) * (bottomB - topB);
  const pricePath = shown.map((d, i) => `${i ? "L" : "M"}${x(d.time).toFixed(1)},${yPrice(d.price).toFixed(1)}`).join(" ");
  const probPath = shown.map((d, i) => `${i ? "L" : "M"}${x(d.time).toFixed(1)},${yProb(d.higher).toFixed(1)}`).join(" ");
  const active = hover === null ? null : shown[hover];
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !shown.length) return;
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const target = t0 + clamp((px - L) / (W - L - R), 0, 1) * (t1 - t0);
    let best = 0;
    shown.forEach((point, i) => { if (Math.abs(point.time - target) < Math.abs(shown[best].time - target)) best = i; });
    setHover(best);
  };

  return (
    <div className="sk-chart-card">
      <div className="sk-chart-head">
        <div className="sk-legend"><span className="sk-dot blue" />Price <span className="sk-dot red" />Higher-close probability</div>
        <div className="sk-ranges">{(["6H", "12H", "FULL"] as const).map((item) => <button key={item} className={range === item ? "active" : ""} onClick={() => setRange(item)}>{item}</button>)}</div>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Interactive SKHX price and probability chart">
        {[topA, bottomA, topB, (topB + bottomB) / 2, bottomB].map((y, i) => <line key={i} x1={L} x2={W - R} y1={y} y2={y} className="sk-grid" />)}
        <text x={L} y={17} className="sk-axis-title">xyz:SKHX price</text>
        <text x={L} y={224} className="sk-axis-title">Probability of a higher 14:30 close</text>
        <text x={L - 10} y={topB + 4} textAnchor="end" className="sk-axis">100%</text>
        <text x={L - 10} y={(topB + bottomB) / 2 + 4} textAnchor="end" className="sk-axis">50%</text>
        <text x={L - 10} y={bottomB + 4} textAnchor="end" className="sk-axis">0%</text>
        <path d={pricePath} className="sk-price-line" />
        <path d={probPath} className="sk-prob-line" />
        {active && <>
          <line x1={x(active.time)} x2={x(active.time)} y1={topA} y2={bottomB} className="sk-crosshair" />
          <circle cx={x(active.time)} cy={yPrice(active.price)} r="4" className="sk-price-point" />
          <circle cx={x(active.time)} cy={yProb(active.higher)} r="4" className="sk-prob-point" />
          <g transform={`translate(${clamp(x(active.time) - 80, L, W - 185)},${topA + 8})`}>
            <rect width="166" height="61" rx="6" className="sk-tooltip-bg" />
            <text x="10" y="17" className="sk-tooltip-time">{hkt(active.time, true)} HKT</text>
            <text x="10" y="37" className="sk-tooltip">Price {money(active.price)}</text>
            <text x="10" y="54" className="sk-tooltip">Higher {active.higher.toFixed(1)}%</text>
          </g>
        </>}
        {shown.length > 1 && <>
          <text x={L} y={383} className="sk-axis">{hkt(t0)}</text>
          <text x={W - R} y={383} textAnchor="end" className="sk-axis">{hkt(t1)}</text>
        </>}
      </svg>
    </div>
  );
}

export default function SkhxPage() {
  const [model, setModel] = useState<ModelFile | null>(null);
  const [live, setLive] = useState<LiveFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/skhx-model.json", { cache: "no-store" }).then((r) => r.json()).then(setModel).catch(() => setError("Model file unavailable"));
  }, []);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/skhx", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Live feed unavailable");
        if (!stopped) { setLive(data); setError(null); }
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : "Live feed unavailable");
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);

  const state = useMemo(() => {
    if (!model) return null;
    const anchorBar = live ? findAnchor(live.candles) : null;
    const anchorPrice = anchorBar?.close ?? model.latestAnchor.price;
    const anchorClose = anchorBar ? anchorBar.time + HALF_HOUR : model.latestAnchor.time + HALF_HOUR;
    const now = live?.serverTime ?? model.fallbackHistory.at(-1)?.time ?? Date.now();
    const price = live?.quote.mark ?? model.fallbackHistory.at(-1)?.price ?? anchorPrice;
    const clock = selectClock(model.clocks, anchorClose, now);
    const signal = (price / anchorPrice - 1) * 100;
    const prediction = predict(clock, signal);
    const points: ChartPoint[] = live && anchorBar ? live.candles
      .filter((bar) => bar.time >= anchorBar.time)
      .map((bar) => {
        const at = Math.min(bar.time + HALF_HOUR, now);
        const c = selectClock(model.clocks, anchorClose, at);
        return { time: at, price: bar.close, higher: predict(c, (bar.close / anchorPrice - 1) * 100).higher };
      }) : model.fallbackHistory;
    if (live) {
      const livePoint = { time: now, price, higher: prediction.higher };
      if (points.length && points[points.length - 1].time >= now - 5_000) points[points.length - 1] = livePoint;
      else points.push(livePoint);
    }
    return { anchorPrice, anchorClose, now, price, signal, prediction, points, nextClose: anchorClose + DAY };
  }, [model, live]);

  const higher = state?.prediction.higher ?? 50;
  const circumference = 2 * Math.PI * 78;

  return (
    <main className="sk-page">
      <header className="sk-topbar">
        <a className="sk-brand" href="/skhx"><span className="sk-brand-mark">14:30</span><span>SKHX Probability Desk</span></a>
        <PageSwitcher active="skhx" />
        <div className={`sk-market-status ${error ? "offline" : ""}`}><span />{live ? `Hyperliquid · ${hkt(live.serverTime)} HKT` : "Connecting…"}</div>
      </header>

      <section className="sk-hero">
        <div>
          <p className="eyebrow">xyz:SKHX · NEXT DAILY CLOSE</p>
          <h1>{higher >= 50 ? "Higher" : "Lower"}<br />by 14:30?</h1>
          <div className="sk-signal-row">
            <div><span>14:30 reference</span><strong>{state ? money(state.anchorPrice) : "—"}</strong></div>
            <div><span>Live mark</span><strong>{state ? money(state.price) : "—"}</strong></div>
            <div><span>Move</span><strong className={(state?.signal ?? 0) >= 0 ? "up" : "down"}>{state ? `${state.signal >= 0 ? "+" : ""}${state.signal.toFixed(3)}%` : "—"}</strong></div>
          </div>
          {error && <div className="sk-live-error">{error}. Retrying automatically; the last complete snapshot remains visible.</div>}
        </div>

        <div className="sk-prob-card">
          <p>ROBUST MODEL OUTPUT</p>
          <div className="sk-ring">
            <svg viewBox="0 0 190 190" aria-hidden="true">
              <circle cx="95" cy="95" r="78" className="sk-ring-track" />
              <circle cx="95" cy="95" r="78" className="sk-ring-value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - higher / 100)} />
            </svg>
            <div><strong>{state ? `${higher.toFixed(1)}%` : "—"}</strong><span>probability of a<br />higher close</span></div>
          </div>
          <div className="sk-prob-split"><div><span>Higher</span><strong>{state ? `${higher.toFixed(1)}%` : "—"}</strong></div><div><span>Lower</span><strong>{state ? `${state.prediction.lower.toFixed(1)}%` : "—"}</strong></div></div>
          <div className="sk-interval"><span>95% parameter interval</span><strong>{state ? `${state.prediction.low.toFixed(1)}–${state.prediction.high.toFixed(1)}%` : "—"}</strong></div>
        </div>
      </section>

      <section className="sk-live-section">
        <div className="sk-section-head"><div><p className="eyebrow">TODAY · LIVE</p><h2>Price and probability</h2></div><div className="sk-clock"><span>Next close</span><strong>{state ? `${hkt(state.nextClose, true)} HKT` : "—"}</strong></div></div>
        <LiveChart points={state?.points ?? []} />
        <div className="sk-tape">
          <div><span>Mark / oracle</span><strong>{live ? `${money(live.quote.mark)} / ${money(live.quote.oracle)}` : "—"}</strong></div>
          <div><span>Funding / hour</span><strong>{live ? `${(live.quote.funding * 100).toFixed(4)}%` : "—"}</strong></div>
          <div><span>Open interest</span><strong>{live ? compact(live.quote.openInterest) : "—"}</strong></div>
          <div><span>24h notional</span><strong>{live ? `$${compact(live.quote.dayVolume)}` : "—"}</strong></div>
          <div><span>Model clock</span><strong>{state ? `${(state.prediction.clock.minutesToClose / 60).toFixed(1)}h left` : "—"}</strong></div>
        </div>
      </section>

      <section className="sk-evidence">
        <div className="sk-section-head"><div><p className="eyebrow">WALK-FORWARD TEST</p><h2>Evidence by horizon</h2></div><div className="sk-warning">Short sample · experimental</div></div>
        <div className="sk-table-wrap"><table><thead><tr><th>Time to close</th><th>Test days</th><th>Accuracy</th><th>AUC</th><th>Brier</th><th>vs base</th></tr></thead><tbody>
          {model?.backtests.map((row) => {
            const edge = row.brier < row.baselineBrier;
            return <tr key={row.horizon}><td>{row.horizon}</td><td>{row.n}</td><td>{(row.accuracy * 100).toFixed(1)}%</td><td>{row.auc.toFixed(3)}</td><td>{row.brier.toFixed(3)}</td><td className={edge ? "good" : "weak"}>{edge ? "Better" : "No edge"}</td></tr>;
          })}
        </tbody></table></div>
        <div className="sk-data-grid">
          <div><span>Coverage</span><strong>{model ? `${dateOnly(model.coverage.first)} – ${dateOnly(model.coverage.last)}` : "—"}</strong></div>
          <div><span>30m candles</span><strong>{model ? model.coverage.candles.toLocaleString() : "—"}</strong></div>
          <div><span>Daily closes</span><strong>{model?.coverage.dailyCloses ?? "—"}</strong></div>
          <div><span>Direction targets</span><strong>{model?.coverage.targets ?? "—"}</strong></div>
          <div><span>Missing 30m bars</span><strong>{model?.coverage.missing30mBars ?? "—"}</strong></div>
          <div><span>Unconditional higher</span><strong>{model ? `${(model.baseHigher * 100).toFixed(1)}%` : "—"}</strong></div>
        </div>
        <p className="sk-footnote">Close = the last 30-minute candle ending at 14:30 Beijing time. Probabilities use only SKHX perp price versus that close. With 104 targets, uncertainty is material; early-horizon signals are suppressed when walk-forward testing shows no measured edge.</p>
      </section>
    </main>
  );
}
