import type { GridParams, SignalPoint } from "./strategy";

export type PaperSide = 1 | -1;

export type PaperQuote = SignalPoint & {
  bidX: number;
  askX: number;
  bidY: number;
  askY: number;
};

export type PaperLayer = {
  id: string;
  openedAt: number;
  side: PaperSide;
  beta: number;
  entryZ: number;
  entryX: number;
  entryY: number;
  qtyX: number;
  qtyY: number;
  grossUsd: number;
};

export type PaperEvent = {
  id: string;
  time: number;
  kind: "OPEN" | "ADD" | "TAKE PROFIT" | "STOP" | "MAX HOLD";
  side: PaperSide;
  z: number;
  layers: number;
  priceX: number;
  priceY: number;
  grossUsd: number;
  pnl: number | null;
};

export type PaperSnapshot = { time: number; equity: number };

export type PaperState = {
  version: 1;
  pairId: string;
  running: boolean;
  startedAt: number;
  lastProcessedAt: number;
  layers: PaperLayer[];
  cycleStartPnl: number;
  realizedPnl: number;
  fundingPnl: number;
  feesPaid: number;
  cycles: number;
  wins: number;
  events: PaperEvent[];
  equity: PaperSnapshot[];
};

const weight = (beta: number) => ({ x: 1 / (1 + Math.abs(beta)), y: Math.abs(beta) / (1 + Math.abs(beta)) });
const buy = (ask: number, params: GridParams) => ask * (1 + params.slippageBps / 10_000);
const sell = (bid: number, params: GridParams) => bid * (1 - params.slippageBps / 10_000);

export function createPaperState(pairId: string, time = Date.now()): PaperState {
  return { version: 1, pairId, running: true, startedAt: time, lastProcessedAt: 0, layers: [], cycleStartPnl: 0, realizedPnl: 0, fundingPnl: 0, feesPaid: 0, cycles: 0, wins: 0, events: [], equity: [{ time, equity: 0 }] };
}

export function paperMarkPnl(state: PaperState, quote: PaperQuote, params: GridParams) {
  const gross = state.layers.reduce((sum, layer) => {
    if (layer.side > 0) return sum + layer.qtyX * (sell(quote.bidX, params) - layer.entryX) + layer.qtyY * (layer.entryY - buy(quote.askY, params));
    return sum + layer.qtyX * (layer.entryX - buy(quote.askX, params)) + layer.qtyY * (sell(quote.bidY, params) - layer.entryY);
  }, 0);
  const exitFees = state.layers.reduce((sum, layer) => sum + layer.grossUsd * params.feeBps / 10_000, 0);
  return gross - exitFees;
}

function openLayer(state: PaperState, quote: PaperQuote, params: GridParams, side: PaperSide) {
  const grossUsd = params.capital * params.layerGross;
  const weights = weight(quote.beta);
  const entryX = side > 0 ? buy(quote.askX, params) : sell(quote.bidX, params);
  const entryY = side > 0 ? sell(quote.bidY, params) : buy(quote.askY, params);
  const layer: PaperLayer = {
    id: `${quote.time}-${state.layers.length + 1}`,
    openedAt: quote.time,
    side,
    beta: quote.beta,
    entryZ: quote.z ?? 0,
    entryX,
    entryY,
    qtyX: grossUsd * weights.x / entryX,
    qtyY: grossUsd * weights.y / entryY,
    grossUsd,
  };
  const fee = grossUsd * params.feeBps / 10_000;
  const kind: PaperEvent["kind"] = state.layers.length ? "ADD" : "OPEN";
  return {
    ...state,
    cycleStartPnl: state.layers.length ? state.cycleStartPnl : state.realizedPnl,
    layers: [...state.layers, layer],
    realizedPnl: state.realizedPnl - fee,
    feesPaid: state.feesPaid + fee,
    events: [{ id: `${quote.time}-${kind}`, time: quote.time, kind, side, z: quote.z ?? 0, layers: state.layers.length + 1, priceX: entryX, priceY: entryY, grossUsd, pnl: null }, ...state.events].slice(0, 80),
  };
}

function closeAll(state: PaperState, quote: PaperQuote, params: GridParams, kind: "TAKE PROFIT" | "STOP" | "MAX HOLD") {
  if (!state.layers.length) return state;
  const grossPnl = state.layers.reduce((sum, layer) => {
    if (layer.side > 0) return sum + layer.qtyX * (sell(quote.bidX, params) - layer.entryX) + layer.qtyY * (layer.entryY - buy(quote.askY, params));
    return sum + layer.qtyX * (layer.entryX - buy(quote.askX, params)) + layer.qtyY * (sell(quote.bidY, params) - layer.entryY);
  }, 0);
  const grossUsd = state.layers.reduce((sum, layer) => sum + layer.grossUsd, 0);
  const fee = grossUsd * params.feeBps / 10_000;
  const netClosePnl = grossPnl - fee;
  const cyclePnl = state.realizedPnl + netClosePnl - state.cycleStartPnl;
  const side = state.layers[0].side;
  const event: PaperEvent = {
    id: `${quote.time}-${kind}`,
    time: quote.time,
    kind,
    side,
    z: quote.z ?? 0,
    layers: state.layers.length,
    priceX: side > 0 ? sell(quote.bidX, params) : buy(quote.askX, params),
    priceY: side > 0 ? buy(quote.askY, params) : sell(quote.bidY, params),
    grossUsd,
    pnl: cyclePnl,
  };
  return {
    ...state,
    layers: [],
    realizedPnl: state.realizedPnl + netClosePnl,
    feesPaid: state.feesPaid + fee,
    cycles: state.cycles + 1,
    wins: state.wins + (cyclePnl > 0 ? 1 : 0),
    events: [event, ...state.events].slice(0, 80),
  };
}

export function advancePaper(previous: PaperState, quote: PaperQuote, params: GridParams): PaperState {
  if (!previous.running || quote.z === null || quote.time <= previous.lastProcessedAt) return previous;
  let state = { ...previous };
  if (state.layers.length && params.includeFunding && state.lastProcessedAt > 0) {
    const hours = Math.max(0, Math.min(24, (quote.time - state.lastProcessedAt) / 3_600_000));
    const funding = state.layers.reduce((sum, layer) => {
      const weights = weight(layer.beta);
      return sum + layer.grossUsd * layer.side * (-weights.x * quote.fundingX + weights.y * quote.fundingY) * hours;
    }, 0);
    state.realizedPnl += funding;
    state.fundingPnl += funding;
  }

  const absZ = Math.abs(quote.z);
  let closed = false;
  if (state.layers.length) {
    const oldest = Math.min(...state.layers.map((layer) => layer.openedAt));
    const ageHours = (quote.time - oldest) / 3_600_000;
    if (absZ <= params.exitZ) { state = closeAll(state, quote, params, "TAKE PROFIT"); closed = true; }
    else if (absZ >= params.stopZ) { state = closeAll(state, quote, params, "STOP"); closed = true; }
    else if (ageHours >= params.maxHoldHours) { state = closeAll(state, quote, params, "MAX HOLD"); closed = true; }
    else {
      const side = (quote.z > 0 ? -1 : 1) as PaperSide;
      const nextLevel = params.entryZ + state.layers.length * params.gridStepZ;
      if (side === state.layers[0].side && absZ >= nextLevel && state.layers.length < params.maxLayers) state = openLayer(state, quote, params, side);
    }
  }
  if (!state.layers.length && !closed && absZ >= params.entryZ && absZ < params.stopZ) state = openLayer(state, quote, params, quote.z > 0 ? -1 : 1);

  state.lastProcessedAt = quote.time;
  const equity = state.realizedPnl + paperMarkPnl(state, quote, params);
  state.equity = [...state.equity, { time: quote.time, equity }].slice(-720);
  return state;
}
