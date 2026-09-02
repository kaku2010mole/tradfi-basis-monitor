"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import PageSwitcher from "../components/PageSwitcher";

type Quote = {
  ok: boolean;
  source: "INDEX" | "FUTURES";
  sourceLabel: string;
  symbol: string;
  price: number;
  referencePrice: number;
  referenceTime: string;
  referenceTimestamp?: string | null;
  changePct: number;
  asOf: string;
  serverTime: string;
  sessionLabel: string;
  stale: boolean;
  ageSeconds: number;
  nightFutures?: {
    symbol: string;
    price: number;
    asOf: string;
    ageSeconds: number;
    ready: boolean;
    live: boolean;
  };
};

type HistoryPoint = {
  time: string;
  price: number;
  changePct: number;
  source: "INDEX" | "FUTURES";
};

type HistoryPayload = {
  ok: boolean;
  source: "INDEX" | "FUTURES";
  sourceLabel: string;
  referencePrice: number;
  referenceTime: string;
  points: HistoryPoint[];
};

type OosMetrics = {
  n?: number;
  auc?: number;
  accuracy?: number;
  baselineAccuracy?: number;
  brier?: number;
  baselineBrier?: number;
  logLoss?: number;
  confidenceTiers?: Array<{
    label: string;
    n: number;
    meanConfidence: number;
    hitRate: number;
  }>;
};

type ModelEntry = {
  source: "INDEX" | "FUTURES";
  n: number;
  intercept: number;
  slopePerPctPoint: number;
  covariance: [[number, number], [number, number]];
  historicalUpRate: number;
  oos: OosMetrics;
};

type ModelPayload = {
  version: number;
  dataStart: string;
  dataEnd: string;
  modelCount: number;
  models: Record<string, ModelEntry>;
};

type Prediction = {
  up: number;
  down: number;
  upLower: number;
  upUpper: number;
  downLower: number;
  downUpper: number;
};

const bridgeUrl = (path: string) =>
  ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? `${window.location.protocol}//${window.location.hostname}:8793${path}`
    : path === "/history" ? "/api/hsi?view=history" : "/api/hsi";

const HORIZON_CHECKPOINTS = [
  { horizon: "20–24h", key: "FUTURES|16:10", checkpoint: "16:10 · HSI FUT" },
  { horizon: "14–20h", key: "FUTURES|22:00", checkpoint: "22:00 · HSI FUT" },
  { horizon: "8–14h", key: "FUTURES|02:00", checkpoint: "02:00 · HSI FUT" },
  { horizon: "4–8h", key: "INDEX|09:30", checkpoint: "09:30 · HSI" },
  { horizon: "2–4h", key: "INDEX|13:05", checkpoint: "13:05 · HSI" },
  { horizon: "0–2h", key: "INDEX|15:00", checkpoint: "15:00 · HSI" },
  { horizon: "0–15m", key: "INDEX|15:50", checkpoint: "15:50 · HSI" },
] as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const logistic = (value: number) => 1 / (1 + Math.exp(-value));

const predict = (model: ModelEntry, signalPct: number): Prediction => {
  const eta = model.intercept + model.slopePerPctPoint * signalPct;
  const variance = Math.max(
    0,
    model.covariance[0][0]
      + 2 * signalPct * model.covariance[0][1]
      + signalPct * signalPct * model.covariance[1][1],
  );
  const standardError = Math.sqrt(variance);
  const up = logistic(eta) * 100;
  const upLower = logistic(eta - 1.96 * standardError) * 100;
  const upUpper = logistic(eta + 1.96 * standardError) * 100;
  return {
    up,
    down: 100 - up,
    upLower,
    upUpper,
    downLower: 100 - upUpper,
    downUpper: 100 - upLower,
  };
};

const formatPrice = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

const formatHktTime = (value: string | undefined) => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
};

const clockMinutes = (clock: string) => {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
};

const hktClock = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));

const nearestModelAt = (
  payload: ModelPayload,
  source: "INDEX" | "FUTURES",
  timestamp: string,
) => {
  const current = clockMinutes(hktClock(timestamp));
  const candidates = Object.entries(payload.models)
    .filter(([, model]) => model.source === source)
    .map(([key, model]) => {
      const clock = key.includes("|") ? key.split("|")[1] : key;
      return { clock, model, minute: clockMinutes(clock) };
    });
  if (!candidates.length) return null;
  const past = candidates.filter((candidate) => candidate.minute <= current);
  const selected = past.length
    ? past.reduce((best, item) => (item.minute > best.minute ? item : best))
    : candidates.reduce((best, item) =>
        Math.abs(item.minute - current) < Math.abs(best.minute - current) ? item : best,
      );
  return selected;
};

const nearestModel = (payload: ModelPayload, quote: Quote) =>
  nearestModelAt(payload, quote.source, quote.serverTime);

const robustPredictAt = (
  payload: ModelPayload,
  source: "INDEX" | "FUTURES",
  timestamp: string,
  signalPct: number,
) => {
  const current = clockMinutes(hktClock(timestamp));
  const nearby = Object.entries(payload.models)
    .filter(([, model]) => model.source === source)
    .map(([key, model]) => {
      const clock = key.includes("|") ? key.split("|")[1] : key;
      return { clock, model, distance: Math.abs(clockMinutes(clock) - current) };
    })
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map(({ model }) => predict(model, signalPct));
  if (!nearby.length) return null;
  const mean = (key: keyof Prediction) =>
    nearby.reduce((total, item) => total + item[key], 0) / nearby.length;
  return {
    up: mean("up"),
    down: mean("down"),
    upLower: Math.min(...nearby.map((item) => item.upLower)),
    upUpper: Math.max(...nearby.map((item) => item.upUpper)),
    downLower: Math.min(...nearby.map((item) => item.downLower)),
    downUpper: Math.max(...nearby.map((item) => item.downUpper)),
  } satisfies Prediction;
};

function ProbabilityCurve({ model, signalPct }: { model: ModelEntry; signalPct: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);

      const pad = { left: 58, right: 24, top: 28, bottom: 48 };
      const plotWidth = width - pad.left - pad.right;
      const plotHeight = height - pad.top - pad.bottom;
      const x = (value: number) => pad.left + ((value + 3) / 6) * plotWidth;
      const y = (value: number) => pad.top + (1 - value / 100) * plotHeight;

      context.clearRect(0, 0, width, height);
      context.font = "12px system-ui";
      context.fillStyle = "#61727a";
      context.strokeStyle = "rgba(17,38,50,.12)";
      context.lineWidth = 1;

      [0, 25, 50, 75, 100].forEach((tick) => {
        context.beginPath();
        context.moveTo(pad.left, y(tick));
        context.lineTo(width - pad.right, y(tick));
        context.stroke();
        context.fillText(`${tick}%`, 16, y(tick) + 4);
      });
      [-3, -2, -1, 0, 1, 2, 3].forEach((tick) => {
        context.fillText(`${tick > 0 ? "+" : ""}${tick}%`, x(tick) - 10, height - 18);
      });

      const points = Array.from({ length: 121 }, (_, index) => -3 + index * 0.05);
      const bands = points.map((value) => ({ value, prediction: predict(model, value) }));

      context.beginPath();
      bands.forEach((point, index) => {
        const command = index === 0 ? "moveTo" : "lineTo";
        context[command](x(point.value), y(point.prediction.upUpper));
      });
      [...bands].reverse().forEach((point) => {
        context.lineTo(x(point.value), y(point.prediction.upLower));
      });
      context.closePath();
      context.fillStyle = "rgba(23,107,135,.16)";
      context.fill();

      context.beginPath();
      bands.forEach((point, index) => {
        const command = index === 0 ? "moveTo" : "lineTo";
        context[command](x(point.value), y(point.prediction.up));
      });
      context.strokeStyle = "#176b87";
      context.lineWidth = 3;
      context.stroke();

      const current = predict(model, signalPct).up;
      const currentX = x(clamp(signalPct, -3, 3));
      context.setLineDash([6, 5]);
      context.strokeStyle = "#c34832";
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(currentX, pad.top);
      context.lineTo(currentX, height - pad.bottom);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      context.arc(currentX, y(current), 6, 0, Math.PI * 2);
      context.fillStyle = "#c34832";
      context.fill();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [model, signalPct]);

  return <canvas className="chart-canvas" ref={canvasRef} aria-label="Probability curve" />;
}

function LiveSessionChart({ history, models }: { history: HistoryPayload; models: ModelPayload }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rangeMinutes, setRangeMinutes] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const fullSeries = useMemo(
    () =>
      history.points.flatMap((point) => {
        const selected = nearestModelAt(models, point.source, point.time);
        if (!selected) return [];
        const prediction = robustPredictAt(models, point.source, point.time, point.changePct);
        if (!prediction) return [];
        return [{
          ...point,
          modelClock: selected.clock,
          lowerProbability: prediction.down,
          higherProbability: prediction.up,
        }];
      }),
    [history, models],
  );
  const series = useMemo(() => {
    if (rangeMinutes === null || !fullSeries.length) return fullSeries;
    // Use trading observations rather than wall-clock minutes so session gaps
    // do not turn the short-range controls into an empty chart.
    return fullSeries.slice(-(rangeMinutes + 1));
  }, [fullSeries, rangeMinutes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || series.length < 2) return;

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);

      const pad = { left: 68, right: 28, top: 34, bottom: 42 };
      const gap = 54;
      const usableHeight = height - pad.top - pad.bottom - gap;
      const priceHeight = usableHeight * 0.57;
      const probabilityTop = pad.top + priceHeight + gap;
      const probabilityHeight = usableHeight - priceHeight;
      const plotWidth = width - pad.left - pad.right;
      const firstTime = new Date(series[0].time).getTime();
      const lastTime = new Date(series[series.length - 1].time).getTime();
      const timeRange = Math.max(1, lastTime - firstTime);
      const prices = series.map((point) => point.price);
      const rawMin = Math.min(...prices);
      const rawMax = Math.max(...prices);
      const pricePad = Math.max(8, (rawMax - rawMin) * 0.12);
      const priceMin = rawMin - pricePad;
      const priceMax = rawMax + pricePad;
      const x = (time: string) =>
        pad.left + ((new Date(time).getTime() - firstTime) / timeRange) * plotWidth;
      const priceY = (value: number) =>
        pad.top + (1 - (value - priceMin) / (priceMax - priceMin)) * priceHeight;
      const probabilityY = (value: number) =>
        probabilityTop + (1 - value / 100) * probabilityHeight;

      context.font = "12px system-ui";
      context.fillStyle = "#61727a";
      context.strokeStyle = "rgba(17,38,50,.11)";
      context.lineWidth = 1;

      const isGap = (index: number) =>
        index > 0
        && new Date(series[index].time).getTime() - new Date(series[index - 1].time).getTime() > 150_000;
      series.forEach((point, index) => {
        if (!isGap(index)) return;
        const left = x(series[index - 1].time);
        const right = x(point.time);
        context.fillStyle = "rgba(17,38,50,.035)";
        context.fillRect(left, pad.top, right - left, probabilityTop + probabilityHeight - pad.top);
        if (right - left > 72) {
          context.fillStyle = "#8b989d";
          context.font = "600 9px system-ui";
          context.textAlign = "center";
          context.fillText("NO TICKS", left + (right - left) / 2, pad.top + 14);
          context.textAlign = "left";
        }
      });

      [0, 0.5, 1].forEach((ratioValue) => {
        const price = priceMin + (priceMax - priceMin) * ratioValue;
        const y = priceY(price);
        context.beginPath();
        context.moveTo(pad.left, y);
        context.lineTo(width - pad.right, y);
        context.stroke();
        context.fillText(formatPrice(price), 8, y + 4);
      });

      [0, 50, 100].forEach((value) => {
        const y = probabilityY(value);
        context.beginPath();
        context.moveTo(pad.left, y);
        context.lineTo(width - pad.right, y);
        context.stroke();
        context.fillText(`${value}%`, 22, y + 4);
      });

      context.fillStyle = "#112632";
      context.font = "600 12px system-ui";
      context.fillText(`${history.sourceLabel} price`, pad.left, 18);
      context.fillText("Probability of a lower close", pad.left, probabilityTop - 18);

      context.beginPath();
      series.forEach((point, index) => {
        const pointX = x(point.time);
        const pointY = priceY(point.price);
        if (index === 0 || isGap(index)) context.moveTo(pointX, pointY);
        else context.lineTo(pointX, pointY);
      });
      context.strokeStyle = "#176b87";
      context.lineWidth = 2.5;
      context.stroke();

      context.beginPath();
      series.forEach((point, index) => {
        const pointX = x(point.time);
        const pointY = probabilityY(point.lowerProbability);
        if (index === 0 || isGap(index)) context.moveTo(pointX, pointY);
        else context.lineTo(pointX, pointY);
      });
      context.strokeStyle = "#c34832";
      context.lineWidth = 2.5;
      context.stroke();

      const focus = hoverIndex === null ? series[series.length - 1] : series[hoverIndex];
      const focusX = x(focus.time);
      if (hoverIndex !== null) {
        context.setLineDash([4, 4]);
        context.strokeStyle = "rgba(17,38,50,.42)";
        context.beginPath();
        context.moveTo(focusX, pad.top);
        context.lineTo(focusX, probabilityTop + probabilityHeight);
        context.stroke();
        context.setLineDash([]);
      }
      [[priceY(focus.price), "#176b87"], [probabilityY(focus.lowerProbability), "#c34832"]].forEach(
        ([pointY, color]) => {
          context.beginPath();
          context.arc(focusX, Number(pointY), 5, 0, Math.PI * 2);
          context.fillStyle = String(color);
          context.fill();
        },
      );

      context.font = "11px system-ui";
      context.fillStyle = "#61727a";
      Array.from({ length: 5 }, (_, index) => index / 4).forEach((ratioValue, index) => {
        const timestamp = firstTime + timeRange * ratioValue;
        const label = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Hong_Kong",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(timestamp));
        const labelX = pad.left + plotWidth * ratioValue;
        context.textAlign = index === 0 ? "left" : index === 4 ? "right" : "center";
        context.fillText(label, labelX, height - 14);
      });
      context.textAlign = "left";
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [history.sourceLabel, hoverIndex, series]);

  const latest = series.at(-1);
  const hovered = hoverIndex === null ? null : series[hoverIndex];
  const firstTime = series.length ? new Date(series[0].time).getTime() : 0;
  const lastTime = series.length ? new Date(series[series.length - 1].time).getTime() : 1;
  const hoverPosition = hovered
    ? ((new Date(hovered.time).getTime() - firstTime) / Math.max(1, lastTime - firstTime)) * 100
    : 0;
  return (
    <div className="live-chart-shell">
      <div className="live-chart-stats">
        <span><i className="legend-dot price" />Latest price <strong>{latest ? formatPrice(latest.price) : "—"}</strong></span>
        <span><i className="legend-dot probability" />Lower-close probability <strong>{latest ? `${latest.lowerProbability.toFixed(1)}%` : "—"}</strong></span>
        <div className="chart-range" aria-label="Chart time range">
          {[[30, "30M"], [60, "1H"], [null, "FULL"]].map(([value, label]) => (
            <button
              className={rangeMinutes === value ? "active" : ""}
              key={label}
              type="button"
              onClick={() => { setRangeMinutes(value as number | null); setHoverIndex(null); }}
            >{label}</button>
          ))}
        </div>
        <span className="chart-updated">{latest ? `${formatHktTime(latest.time)} HKT` : "—"}</span>
      </div>
      {series.length >= 2 ? (
        <div className="interactive-chart">
          <canvas
            className="live-chart-canvas"
            ref={canvasRef}
            aria-label="Today's interactive Hang Seng price and lower-close probability chart"
            onPointerLeave={() => setHoverIndex(null)}
            onPointerMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const plotLeft = 68;
              const plotRight = 28;
              const ratio = clamp((event.clientX - bounds.left - plotLeft) / Math.max(1, bounds.width - plotLeft - plotRight), 0, 1);
              const target = firstTime + (lastTime - firstTime) * ratio;
              let nearest = 0;
              for (let index = 1; index < series.length; index += 1) {
                if (Math.abs(new Date(series[index].time).getTime() - target) < Math.abs(new Date(series[nearest].time).getTime() - target)) nearest = index;
              }
              setHoverIndex(nearest);
            }}
          />
          {hovered && (
            <div
              className={`chart-tooltip ${hoverPosition > 70 ? "align-right" : ""}`}
              style={{ left: `${hoverPosition}%` }}
            >
              <strong>{formatHktTime(hovered.time)} HKT</strong>
              <span>Price <b>{formatPrice(hovered.price)}</b></span>
              <span>Move <b>{hovered.changePct >= 0 ? "+" : ""}{hovered.changePct.toFixed(3)}%</b></span>
              <span>Lower <b>{hovered.lowerProbability.toFixed(1)}%</b></span>
              <span>Higher <b>{hovered.higherProbability.toFixed(1)}%</b></span>
              <span>Model <b>{hovered.modelClock}</b></span>
            </div>
          )}
        </div>
      ) : (
        <div className="live-chart-loading">Collecting today&apos;s live points…</div>
      )}
    </div>
  );
}

export default function Home() {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [models, setModels] = useState<ModelPayload | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [scenarioPrice, setScenarioPrice] = useState<number | null>(null);
  const [scenarioTouched, setScenarioTouched] = useState(false);

  useEffect(() => {
    fetch("/hsi-models.json", { cache: "no-store" })
      .then((response) => response.json())
      .then(setModels)
      .catch(() => setModelError("Model file is unavailable or invalid."));
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(bridgeUrl("/quote"), { cache: "no-store" });
        if (!response.ok) throw new Error("Live quote bridge is unavailable.");
        const next = (await response.json()) as Quote;
        if (!active) return;
        setQuote(next);
        setQuoteError(null);
        if (!scenarioTouched) setScenarioPrice(next.price);
      } catch (error) {
        if (active) setQuoteError(error instanceof Error ? error.message : "Live quote unavailable.");
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [scenarioTouched]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(bridgeUrl("/history"), { cache: "no-store" });
        if (!response.ok) throw new Error("Today's live chart is unavailable.");
        const next = (await response.json()) as HistoryPayload;
        if (!active) return;
        setHistory(next);
        setHistoryError(null);
      } catch (error) {
        if (active) setHistoryError(error instanceof Error ? error.message : "Live chart unavailable.");
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const selectedModel = useMemo(() => {
    if (!quote || !models) return null;
    return nearestModel(models, quote);
  }, [models, quote]);

  const livePrediction = useMemo(() => {
    if (!quote || !models) return null;
    return robustPredictAt(models, quote.source, quote.serverTime, quote.changePct);
  }, [models, quote]);

  const scenario = useMemo(() => {
    if (!quote || !models || scenarioPrice === null) return null;
    const signalPct = (scenarioPrice / quote.referencePrice - 1) * 100;
    const prediction = robustPredictAt(models, quote.source, quote.serverTime, signalPct);
    return prediction ? { signalPct, prediction } : null;
  }, [models, quote, scenarioPrice]);

  const isDown = (livePrediction?.down ?? 50) >= 50;
  const sourceShort = !quote ? "—" : quote.source === "INDEX" ? "HSI" : "HSI FUT";
  const sliderMin = quote ? Math.round(quote.referencePrice * 0.97) : 0;
  const sliderMax = quote ? Math.round(quote.referencePrice * 1.03) : 100;
  const scenarioValue = scenarioPrice ?? sliderMin;
  const connectionError = modelError ?? quoteError;
  const horizonResults = useMemo(() => models ? HORIZON_CHECKPOINTS.flatMap((checkpoint) => {
    const model = models.models[checkpoint.key];
    return model?.oos?.n ? [{ ...checkpoint, ...model.oos }] : [];
  }) : [], [models]);

  return (
    <main className="hsi-page">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Back to top">
          <span className="brand-mark">16:08</span>
          <span>Hang Seng Probability Desk</span>
        </a>
        <PageSwitcher active="hsi" />
        <div className={`market-status ${connectionError ? "offline" : ""}`}>
          <span className="status-dot" aria-hidden="true" />
          {quote ? `${quote.sourceLabel} · ${formatHktTime(quote.asOf)} HKT` : "Connecting to live quotes…"}
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="source-row">
            <p className="eyebrow">LIVE HANG SENG · CLOSE DIRECTION</p>
            <span className="source-pill">{quote?.sessionLabel ?? "Detecting session"} · {sourceShort ?? "—"}</span>
          </div>
          <h1>
            The close still<br />leans {isDown ? "lower" : "higher"}.
          </h1>
          <p className="hero-lede">
            HSI in cash hours · HK.HSImain outside cash hours · 3-second refresh
          </p>

          {connectionError && <div className="live-error">{connectionError} Retrying automatically every three seconds.</div>}

          <div className="signal-strip" aria-label="Current signal summary">
            <div>
              <span>Reference</span>
              <strong>{quote ? formatPrice(quote.referencePrice) : "—"}</strong>
            </div>
            <span className="signal-arrow" aria-hidden="true">→</span>
            <div>
              <span>Live {sourceShort}</span>
              <strong>{quote ? formatPrice(quote.price) : "—"}</strong>
            </div>
            <div className={quote && quote.changePct < 0 ? "signal-negative" : "signal-positive"}>
              <span>Signal move</span>
              <strong>
                {quote ? `${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(3)}%` : "—"}
              </strong>
            </div>
          </div>
          <div className="live-meta">
            <span>{quote?.referenceTime ?? "Waiting for reference"}</span>
            <span>Model clock {selectedModel?.clock ?? "—"}</span>
            <span>Quote age {quote ? `${Math.round(quote.ageSeconds)}s` : "—"}</span>
          </div>
        </div>

        <aside className="probability-card" aria-label="Current prediction probability">
          <div className="card-kicker">LIVE · 3-CLOCK ENSEMBLE</div>
          <div
            className={`probability-ring ${livePrediction ? "" : "is-loading"}`}
            style={{ "--probability": `${livePrediction?.down ?? 0}%` } as CSSProperties}
          >
            <div className="ring-center">
              <strong>{livePrediction ? `${livePrediction.down.toFixed(1)}%` : "—"}</strong>
              <span>{livePrediction ? "probability of a lower close" : "waiting for live model"}</span>
            </div>
          </div>
          <div className="probability-split">
            <div>
              <span>Higher</span>
              <strong>{livePrediction ? `${livePrediction.up.toFixed(1)}%` : "—"}</strong>
            </div>
            <div>
              <span>Lower</span>
              <strong>{livePrediction ? `${livePrediction.down.toFixed(1)}%` : "—"}</strong>
            </div>
          </div>
          <div className="confidence-note">
            <span>95% model + clock interval</span>
            <strong>
              {livePrediction
                ? `Lower ${livePrediction.downLower.toFixed(1)}–${livePrediction.downUpper.toFixed(1)}%`
                : "—"}
            </strong>
          </div>
        </aside>
      </section>

      <section className="section live-chart-section" id="live-chart">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">TODAY · LIVE</p>
            <h2>Price and probability, moving together.</h2>
          </div>
          <p>Hover for price, move, odds and model clock.</p>
        </div>
        <div className="live-chart-frame">
          {historyError && <div className="chart-inline-error">{historyError} Retrying automatically.</div>}
          {history && models && (!quote || history.source === quote.source) ? (
            <LiveSessionChart history={history} models={models} />
          ) : (
            <div className="live-chart-loading">Loading today&apos;s live market path…</div>
          )}
        </div>
        <div className="feed-grid">
          <article><span>Active feed</span><strong>{quote?.symbol ?? "—"}</strong><em>{quote?.sourceLabel ?? "Connecting"}</em></article>
          <article><span>Reference</span><strong>{quote ? formatPrice(quote.referencePrice) : "—"}</strong><em>{quote?.referenceTime ?? "—"}</em></article>
          <article><span>Clock model</span><strong>{selectedModel?.clock ?? "—"}</strong><em>{selectedModel ? `${selectedModel.model.n.toLocaleString("en-US")} days · ±5m ensemble` : "—"}</em></article>
          <article className={quote?.nightFutures?.ready ? "feed-ready" : "feed-waiting"}>
            <span>Night futures standby</span>
            <strong>{quote?.nightFutures ? formatPrice(quote.nightFutures.price) : "—"}</strong>
            <em>{quote?.nightFutures ? `${quote.nightFutures.symbol} · ${quote.nightFutures.live ? "LIVE" : "CONNECTED / STANDBY"} · ${formatHktTime(quote.nightFutures.asOf)} HKT` : "Checking HK.HSImain"}</em>
          </article>
        </div>
      </section>

      <section className="section scenario-section" id="scenario">
        <div className="section-heading">
          <div>
            <p className="eyebrow">SCENARIO LAB</p>
            <h2>Price scenario.</h2>
          </div>
          <p>Adjust ±3% from the active reference.</p>
        </div>

        <div className="scenario-grid">
          <div className="scenario-control">
            <div className="price-readout">
              <span>Assumed live {sourceShort}</span>
              <strong>{scenarioPrice === null ? "—" : formatPrice(scenarioPrice)}</strong>
              <em className={(scenario?.signalPct ?? 0) < 0 ? "negative" : "positive"}>
                {scenario ? `${scenario.signalPct >= 0 ? "+" : ""}${scenario.signalPct.toFixed(3)}%` : "—"}
              </em>
            </div>

            <input
              aria-label="Adjust the live Hang Seng price"
              className="price-slider"
              type="range"
              min={sliderMin}
              max={sliderMax}
              step={1}
              disabled={!quote}
              value={scenarioValue}
              onChange={(event) => {
                setScenarioTouched(true);
                setScenarioPrice(Number(event.target.value));
              }}
              style={{
                "--slider-position": `${sliderMax === sliderMin ? 50 : ((scenarioValue - sliderMin) / (sliderMax - sliderMin)) * 100}%`,
              } as CSSProperties}
            />
            <div className="slider-labels">
              <span>−3%</span>
              <span>Reference {quote ? formatPrice(quote.referencePrice) : "—"}</span>
              <span>+3%</span>
            </div>

            <div className="preset-row" aria-label="Quick scenarios">
              {[-2, -1, 0, 1, 2].map((move) => (
                <button
                  key={move}
                  type="button"
                  disabled={!quote}
                  onClick={() => {
                    if (!quote) return;
                    setScenarioTouched(true);
                    setScenarioPrice(Math.round(quote.referencePrice * (1 + move / 100)));
                  }}
                >
                  {move > 0 ? "+" : ""}{move}%
                </button>
              ))}
              <button
                type="button"
                className="live-button"
                disabled={!quote}
                onClick={() => {
                  setScenarioTouched(false);
                  if (quote) setScenarioPrice(quote.price);
                }}
              >
                Return to live
              </button>
            </div>
          </div>

          <div className="scenario-result">
            <div
              className="mini-ring"
              style={{ "--scenario": `${scenario?.prediction.down ?? 50}%` } as CSSProperties}
            >
              <span>{scenario ? `${scenario.prediction.down.toFixed(1)}%` : "—"}</span>
            </div>
            <div>
              <span className="result-label">Scenario probability: lower close</span>
              <p>{scenario ? `Higher-close probability ${scenario.prediction.up.toFixed(1)}%` : "Waiting for live data"}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section evidence-section">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">OUT-OF-SAMPLE</p>
            <h2>Walk-forward backtest.</h2>
          </div>
          <p>2022–2026 · prior data only</p>
        </div>

        <div className="metric-grid">
          <article>
            <span>Out-of-sample AUC</span>
            <strong>{selectedModel?.model.oos.auc?.toFixed(3) ?? "—"}</strong>
            <p>Random ranking is 0.500</p>
          </article>
          <article>
            <span>Direction accuracy</span>
            <strong>{selectedModel?.model.oos.accuracy ? `${(selectedModel.model.oos.accuracy * 100).toFixed(1)}%` : "—"}</strong>
            <p>Baseline {selectedModel?.model.oos.baselineAccuracy ? `${(selectedModel.model.oos.baselineAccuracy * 100).toFixed(1)}%` : "—"}</p>
          </article>
          <article>
            <span>Brier score</span>
            <strong>{selectedModel?.model.oos.brier?.toFixed(3) ?? "—"}</strong>
            <p>Baseline {selectedModel?.model.oos.baselineBrier?.toFixed(3) ?? "—"}; lower is better</p>
          </article>
          <article>
            <span>Forward-test days</span>
            <strong>{selectedModel?.model.oos.n?.toLocaleString("en-US") ?? "—"}</strong>
            <p>2022 through 2026</p>
          </article>
        </div>

        <div className="tier-panel horizon-panel">
          <div className="tier-heading">
            <strong>Results by time to close</strong>
            <span>Fixed checkpoints · same next-day HSI close target</span>
          </div>
          <div className="tier-table" role="table" aria-label="Walk-forward performance by time remaining to the HSI close">
            <div className="tier-row horizon-row tier-header" role="row">
              <span>Time to close</span><span>Checkpoint</span><span>Test days</span><span>Accuracy</span><span>AUC</span><span>Brier</span><span>vs base</span>
            </div>
            {horizonResults.map((row) => {
              const better = (row.brier ?? 1) < (row.baselineBrier ?? 0);
              return (
                <div className="tier-row horizon-row" role="row" key={row.key}>
                  <strong>{row.horizon}</strong>
                  <span>{row.checkpoint}</span>
                  <span>{row.n?.toLocaleString("en-US") ?? "—"}</span>
                  <span>{row.accuracy ? `${(row.accuracy * 100).toFixed(1)}%` : "—"}</span>
                  <span>{row.auc?.toFixed(3) ?? "—"}</span>
                  <span>{row.brier?.toFixed(3) ?? "—"}</span>
                  <span className={better ? "calibrated" : "calibration-gap"}>{better ? "Better" : "No edge"}</span>
                </div>
              );
            })}
          </div>
          <p className="horizon-note">Accuracy rises as more of the trading day is observed. Treat the final minutes as confirmation of an almost-complete outcome—not as an equally early, equally tradable edge.</p>
        </div>

        <div className="tier-panel">
          <div className="tier-heading">
            <strong>Results by confidence tier</strong>
            <span>Predicted direction · current {selectedModel?.clock ?? "—"} model</span>
          </div>
          <div className="tier-table" role="table" aria-label="Walk-forward performance by model confidence tier">
            <div className="tier-row tier-header" role="row">
              <span>Confidence</span><span>Tests</span><span>Mean forecast</span><span>Hit rate</span><span>Calibration gap</span>
            </div>
            {(selectedModel?.model.oos.confidenceTiers ?? []).map((tier) => (
              <div className="tier-row" role="row" key={tier.label}>
                <strong>{tier.label}</strong>
                <span>{tier.n.toLocaleString("en-US")}</span>
                <span>{(tier.meanConfidence * 100).toFixed(1)}%</span>
                <span>{(tier.hitRate * 100).toFixed(1)}%</span>
                <span className={Math.abs(tier.hitRate - tier.meanConfidence) <= 0.05 ? "calibrated" : "calibration-gap"}>
                  {tier.hitRate - tier.meanConfidence >= 0 ? "+" : ""}{((tier.hitRate - tier.meanConfidence) * 100).toFixed(1)} pp
                </span>
              </div>
            ))}
            {!selectedModel?.model.oos.confidenceTiers?.length && <div className="tier-empty">Loading confidence tiers…</div>}
          </div>
        </div>
      </section>

      <section className="section chart-section">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">PROBABILITY CURVE</p>
            <h2>Probability curve.</h2>
          </div>
          <p>Live move · 95% parameter band</p>
        </div>
        <div className="chart-frame">
          {selectedModel && quote ? (
            <ProbabilityCurve model={selectedModel.model} signalPct={quote.changePct} />
          ) : (
            <div className="chart-loading">Waiting for the live model…</div>
          )}
        </div>
      </section>

      <footer>
        <div>
          <strong>Hang Seng Probability Desk · Live local edition</strong>
          <span>Historical coverage: Sep 2018–Sep 2026 · 1-minute HSI and active-futures data</span>
        </div>
        <p>Conditional estimates, not investment advice · quotes refresh every 3s</p>
      </footer>
    </main>
  );
}
