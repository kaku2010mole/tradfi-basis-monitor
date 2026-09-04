"use client";

import { useEffect, useMemo, useState } from "react";
import type { GridParams, SignalPoint } from "./strategy";
import { advancePaper, createPaperState, paperMarkPnl, type PaperQuote, type PaperState } from "./paper";

type Props = {
  pairId: string;
  labelX: string;
  labelY: string;
  latest: SignalPoint | undefined;
  quote: { bidX: number; askX: number; bidY: number; askY: number } | null;
  params: GridParams;
};

const storageKey = (pairId: string) => `pair_grid_paper_v1_${pairId}`;
const usd = (value: number) => `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = (value: number, digits = 4) => value.toLocaleString("en-US", { maximumFractionDigits: digits });
const hkt = (value: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

function loadState(pairId: string) {
  const fresh = createPaperState(pairId);
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(pairId)) || "null") as Partial<PaperState> | null;
    if (!parsed || parsed.pairId !== pairId || parsed.version !== 1) return fresh;
    return { ...fresh, ...parsed, layers: Array.isArray(parsed.layers) ? parsed.layers : [], events: Array.isArray(parsed.events) ? parsed.events : [], equity: Array.isArray(parsed.equity) ? parsed.equity : fresh.equity };
  } catch { return fresh; }
}

function EquityChart({ state, floating }: { state: PaperState; floating: number }) {
  const points = [...state.equity.slice(-179), { time: state.lastProcessedAt || state.startedAt, equity: state.realizedPnl + floating }];
  const width = 740, height = 150, left = 12, right = 12, top = 14, bottom = 24;
  const min = Math.min(0, ...points.map((point) => point.equity));
  const max = Math.max(0, ...points.map((point) => point.equity));
  const pad = Math.max(1, (max - min) * 0.15);
  const t0 = points[0]?.time ?? 0, t1 = points.at(-1)?.time ?? 1;
  const x = (time: number) => left + (time - t0) / Math.max(1, t1 - t0) * (width - left - right);
  const y = (value: number) => top + (max + pad - value) / Math.max(1, max - min + 2 * pad) * (height - top - bottom);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.equity).toFixed(1)}`).join(" ");
  return <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Live paper trading equity curve">
    <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} className="paper-zero" />
    <path d={path} className="paper-equity-line" />
    <circle cx={x(points.at(-1)?.time ?? 0)} cy={y(points.at(-1)?.equity ?? 0)} r="4" className="paper-equity-point" />
    <text x={left} y={height - 6} className="paper-axis">{hkt(t0)}</text>
    <text x={width - right} y={height - 6} textAnchor="end" className="paper-axis">NOW</text>
  </svg>;
}

export default function PaperGrid({ pairId, labelX, labelY, latest, quote, params }: Props) {
  const [state, setState] = useState<PaperState>(() => createPaperState(pairId));
  const [ready, setReady] = useState(false);
  const paperQuote = useMemo<PaperQuote | null>(() => latest && quote && latest.z !== null ? { ...latest, ...quote } : null, [latest, quote]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setState(loadState(pairId)); setReady(true); }, 0);
    return () => window.clearTimeout(timer);
  }, [pairId]);
  useEffect(() => {
    if (!ready || !paperQuote) return;
    const timer = window.setTimeout(() => setState((current) => {
        if (current.pairId !== pairId) return current;
        const seeded = current.lastProcessedAt ? current : { ...current, lastProcessedAt: paperQuote.time - 1 };
        return advancePaper(seeded, paperQuote, params);
      }), 0);
    return () => window.clearTimeout(timer);
  }, [pairId, paperQuote, params, ready]);
  useEffect(() => { if (ready && state.pairId === pairId) localStorage.setItem(storageKey(pairId), JSON.stringify(state)); }, [pairId, ready, state]);

  const floating = paperQuote ? paperMarkPnl(state, paperQuote, params) : 0;
  const totalPnl = state.realizedPnl + floating;
  const gross = state.layers.reduce((sum, layer) => sum + layer.grossUsd, 0);
  const side = state.layers[0]?.side ?? 0;
  const totalQtyX = state.layers.reduce((sum, layer) => sum + layer.qtyX, 0);
  const totalQtyY = state.layers.reduce((sum, layer) => sum + layer.qtyY, 0);
  const avgX = totalQtyX ? state.layers.reduce((sum, layer) => sum + layer.entryX * layer.qtyX, 0) / totalQtyX : 0;
  const avgY = totalQtyY ? state.layers.reduce((sum, layer) => sum + layer.entryY * layer.qtyY, 0) / totalQtyY : 0;
  const nextLayer = params.entryZ + state.layers.length * params.gridStepZ;
  const status = !state.running ? "PAUSED" : state.layers.length ? `${state.layers.length} LAYER${state.layers.length > 1 ? "S" : ""} OPEN` : "SCANNING GRID";

  const toggle = () => setState((current) => ({ ...current, running: !current.running }));
  const reset = () => setState(createPaperState(pairId));

  return <section className="paper-section">
    <div className="paper-head">
      <div><p className="grid-eyebrow">AUTOMATIC PAPER EXECUTION</p><h2>Live grid simulation</h2><span>Uses current BBO, configured fees, slippage and funding. No real orders are sent.</span></div>
      <div className="paper-actions"><span className={state.running ? "running" : "paused"}><i />{status}</span><button onClick={toggle}>{state.running ? "Pause" : "Resume"}</button><button onClick={reset}>Reset results</button></div>
    </div>

    <div className="paper-scoreboard">
      <div className={`paper-primary ${totalPnl >= 0 ? "profit" : "loss"}`}><span>LIVE SESSION P&amp;L</span><strong>{usd(totalPnl)}</strong><small>{params.capital ? `${(totalPnl / params.capital * 100).toFixed(3)}% of paper capital` : "—"}</small></div>
      <div><span>REALIZED + FUNDING</span><strong>{usd(state.realizedPnl)}</strong><small>Funding component {usd(state.fundingPnl)}</small></div>
      <div><span>OPEN P&amp;L</span><strong>{usd(floating)}</strong><small>Executable close at current BBO</small></div>
      <div><span>POSITION</span><strong>{state.layers.length ? `${state.layers.length}/${params.maxLayers} layers` : "FLAT"}</strong><small>{gross ? `$${number(gross, 0)} gross` : `Next entry ±${params.entryZ.toFixed(2)}σ`}</small></div>
      <div><span>CLOSED CYCLES</span><strong>{state.cycles}</strong><small>{state.cycles ? `${(state.wins / state.cycles * 100).toFixed(0)}% win rate` : "Waiting for first exit"}</small></div>
      <div><span>TRADING COST</span><strong>{usd(-state.feesPaid)}</strong><small>{params.feeBps.toFixed(1)} bps fee · {params.slippageBps.toFixed(1)} bps slip</small></div>
    </div>

    <div className="paper-live-grid">
      <article className="paper-position">
        <span>ACTIVE PAPER POSITION</span>
        <strong>{side > 0 ? `LONG ${labelX} / SHORT ${labelY}` : side < 0 ? `SHORT ${labelX} / LONG ${labelY}` : "WAITING FOR ENTRY"}</strong>
        {state.layers.length ? <dl>
          <div><dt>{labelX} quantity / average</dt><dd>{number(totalQtyX)} @ {number(avgX)}</dd></div>
          <div><dt>{labelY} quantity / average</dt><dd>{number(totalQtyY)} @ {number(avgY)}</dd></div>
          <div><dt>Current z-score</dt><dd>{latest?.z == null ? "—" : `${latest.z >= 0 ? "+" : ""}${latest.z.toFixed(3)}σ`}</dd></div>
          <div><dt>Next action</dt><dd>{state.layers.length < params.maxLayers ? `Add at |z| ≥ ${nextLayer.toFixed(2)}σ` : "Maximum layers reached"}</dd></div>
          <div><dt>Exit / stop</dt><dd>|z| ≤ {params.exitZ.toFixed(2)}σ / ≥ {params.stopZ.toFixed(2)}σ</dd></div>
        </dl> : <p>The engine starts automatically and opens the first beta-weighted layer when |z| reaches {params.entryZ.toFixed(2)}σ.</p>}
      </article>
      <article className="paper-equity"><div><span>SESSION EQUITY</span><strong>{usd(totalPnl)}</strong></div><EquityChart state={state} floating={floating} /></article>
    </div>

    <div className="paper-tape">
      <div className="paper-tape-head"><strong>Simulation tape</strong><span>{state.events.length} events · stored on this device</span></div>
      {!state.events.length ? <div className="paper-empty">Scanning live prices. The first simulated fill will appear when the configured entry grid is crossed.</div> : <div className="paper-table"><div className="paper-row header"><span>Time · HKT</span><span>Event</span><span>Pair direction</span><span>Z-score</span><span>Layers / gross</span><span>Cycle P&amp;L</span></div>{state.events.slice(0, 30).map((event) => <div className="paper-row" key={event.id}><span>{hkt(event.time)}</span><strong>{event.kind}</strong><span>{event.side > 0 ? `LONG ${labelX} / SHORT ${labelY}` : `SHORT ${labelX} / LONG ${labelY}`}</span><span>{event.z >= 0 ? "+" : ""}{event.z.toFixed(3)}σ</span><span>{event.layers} · ${number(event.grossUsd, 0)}</span><span className={event.pnl == null ? "" : event.pnl >= 0 ? "positive" : "negative"}>{event.pnl == null ? "—" : usd(event.pnl)}</span></div>)}</div>}
    </div>
  </section>;
}
