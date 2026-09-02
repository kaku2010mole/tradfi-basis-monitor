export type GridPoint = {
  time: number;
  x: number;
  y: number;
  fundingX: number;
  fundingY: number;
};

export type SignalPoint = GridPoint & {
  beta: number;
  z: number | null;
  residual: number | null;
};

export type GridParams = {
  capital: number;
  lookbackDays: number;
  entryZ: number;
  gridStepZ: number;
  exitZ: number;
  stopZ: number;
  maxLayers: number;
  layerGross: number;
  maxHoldHours: number;
  feeBps: number;
  slippageBps: number;
  includeFunding: boolean;
};

export type BacktestResult = {
  start: number;
  end: number;
  days: number;
  returnPct: number;
  annualizedPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  sortino: number;
  winRatePct: number;
  profitFactor: number;
  cycles: number;
  fills: number;
  avgHoldHours: number;
  exposurePct: number;
  feesPct: number;
  fundingPct: number;
  worstCyclePct: number;
  equity: Array<{ time: number; value: number }>;
};

export type Candidate = {
  params: GridParams;
  train: BacktestResult;
  test: BacktestResult;
  score: number;
};

type Layer = { direction: 1 | -1; beta: number; openedAt: number };

function cadence<T extends { time: number }>(points: T[]) {
  const intervalMs = points.length > 1 ? Math.max(60_000, points[1].time - points[0].time) : 15 * 60_000;
  return { intervalMs, barsPerDay: Math.max(1, Math.round(86_400_000 / intervalMs)) };
}

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

export function computeSignals(points: GridPoint[], lookbackDays: number): SignalPoint[] {
  const { barsPerDay } = cadence(points);
  const window = Math.max(2 * barsPerDay, Math.round(lookbackDays * barsPerDay));
  const lx = points.map((point) => Math.log(point.x));
  const ly = points.map((point) => Math.log(point.y));
  const prefix = (values: number[]) => {
    const result = [0];
    for (const value of values) result.push(result[result.length - 1] + value);
    return result;
  };
  const sx = prefix(lx);
  const sy = prefix(ly);
  const sxx = prefix(lx.map((value) => value * value));
  const syy = prefix(ly.map((value) => value * value));
  const sxy = prefix(lx.map((value, index) => value * ly[index]));
  const range = (series: number[], from: number, to: number) => series[to] - series[from];

  return points.map((point, index) => {
    if (index < window) return { ...point, beta: 1, z: null, residual: null };
    const from = index - window;
    const n = window;
    const meanX = range(sx, from, index) / n;
    const meanY = range(sy, from, index) / n;
    const varX = Math.max(0, range(sxx, from, index) / n - meanX * meanX);
    const varY = Math.max(1e-12, range(syy, from, index) / n - meanY * meanY);
    const covariance = range(sxy, from, index) / n - meanX * meanY;
    const beta = Math.max(0.2, Math.min(2.5, covariance / varY));
    const intercept = meanX - beta * meanY;
    const residualVariance = Math.max(1e-12, varX + beta * beta * varY - 2 * beta * covariance);
    const residual = lx[index] - intercept - beta * ly[index];
    return { ...point, beta, residual, z: residual / Math.sqrt(residualVariance) };
  });
}

function emptyResult(points: SignalPoint[], startIndex: number, endIndex: number): BacktestResult {
  const start = points[startIndex]?.time ?? 0;
  const end = points[Math.max(startIndex, endIndex - 1)]?.time ?? start;
  return {
    start, end, days: Math.max(0, (end - start) / 86_400_000), returnPct: 0, annualizedPct: 0,
    maxDrawdownPct: 0, sharpe: 0, sortino: 0, winRatePct: 0, profitFactor: 0, cycles: 0,
    fills: 0, avgHoldHours: 0, exposurePct: 0, feesPct: 0, fundingPct: 0, worstCyclePct: 0,
    equity: [],
  };
}

export function runBacktest(signals: SignalPoint[], params: GridParams, startIndex = 1, endIndex = signals.length): BacktestResult {
  const firstValid = signals.findIndex((point, index) => index >= startIndex && point.z !== null);
  if (firstValid < 0 || endIndex - firstValid < 3) return emptyResult(signals, startIndex, endIndex);
  const result = emptyResult(signals, firstValid, endIndex);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let layers: Layer[] = [];
  let cycleStartEquity = 1;
  let cycleOpenedAt = 0;
  let exposedBars = 0;
  let fills = 0;
  let feeTotal = 0;
  let fundingTotal = 0;
  let holdHours = 0;
  const cycleReturns: number[] = [];
  const barReturns: number[] = [];
  const equityCurve: Array<{ time: number; value: number }> = [];
  const fillCost = (params.feeBps + params.slippageBps) / 10_000;
  const { barsPerDay } = cadence(signals);
  const barsPerYear = barsPerDay * 365;

  const transact = (gross: number) => {
    const cost = gross * fillCost;
    equity *= Math.max(0.01, 1 - cost);
    feeTotal += cost;
    fills += 2;
  };
  const closeAll = (time: number) => {
    if (!layers.length) return;
    transact(layers.length * params.layerGross);
    const cycleReturn = equity / cycleStartEquity - 1;
    cycleReturns.push(cycleReturn);
    holdHours += (time - cycleOpenedAt) / 3_600_000;
    layers = [];
  };

  for (let index = firstValid + 1; index < endIndex; index += 1) {
    const current = signals[index];
    const previous = signals[index - 1];
    const before = equity;
    if (layers.length) {
      exposedBars += 1;
      const rx = current.x / previous.x - 1;
      const ry = current.y / previous.y - 1;
      let strategyReturn = 0;
      let fundingReturn = 0;
      for (const layer of layers) {
        const weightX = 1 / (1 + Math.abs(layer.beta));
        const weightY = Math.abs(layer.beta) / (1 + Math.abs(layer.beta));
        strategyReturn += params.layerGross * layer.direction * (weightX * rx - weightY * ry);
        if (params.includeFunding) {
          fundingReturn += params.layerGross * layer.direction * (-weightX * current.fundingX + weightY * current.fundingY);
        }
      }
      equity *= Math.max(0.01, 1 + strategyReturn + fundingReturn);
      fundingTotal += fundingReturn;
    }

    const z = current.z;
    if (z !== null && layers.length) {
      const ageHours = (current.time - cycleOpenedAt) / 3_600_000;
      if (Math.abs(z) <= params.exitZ || Math.abs(z) >= params.stopZ || ageHours >= params.maxHoldHours) {
        closeAll(current.time);
      } else {
        const side = z > 0 ? -1 : 1;
        const originalSide = layers[0].direction;
        const nextLevel = params.entryZ + layers.length * params.gridStepZ;
        if (side === originalSide && Math.abs(z) >= nextLevel && layers.length < params.maxLayers) {
          layers.push({ direction: originalSide, beta: current.beta, openedAt: current.time });
          transact(params.layerGross);
        }
      }
    }

    if (z !== null && !layers.length && Math.abs(z) >= params.entryZ && Math.abs(z) < params.stopZ) {
      const direction = (z > 0 ? -1 : 1) as 1 | -1;
      cycleStartEquity = equity;
      cycleOpenedAt = current.time;
      layers = [{ direction, beta: current.beta, openedAt: current.time }];
      transact(params.layerGross);
    }

    const barReturn = equity / before - 1;
    barReturns.push(barReturn);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
    if ((index - firstValid) % 16 === 0 || index === endIndex - 1) equityCurve.push({ time: current.time, value: equity });
  }
  if (layers.length) closeAll(signals[endIndex - 1].time);

  const days = Math.max(1 / barsPerDay, result.days);
  const totalReturn = equity - 1;
  const winners = cycleReturns.filter((value) => value > 0);
  const losers = cycleReturns.filter((value) => value < 0);
  const meanBar = barReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, barReturns.length);
  const volatility = stdev(barReturns);
  const downside = stdev(barReturns.filter((value) => value < 0));
  const grossProfit = winners.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losers.reduce((sum, value) => sum + value, 0));
  return {
    ...result,
    returnPct: totalReturn * 100,
    annualizedPct: (Math.pow(Math.max(0.01, equity), 365 / days) - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe: finite(volatility ? meanBar / volatility * Math.sqrt(barsPerYear) : 0),
    sortino: finite(downside ? meanBar / downside * Math.sqrt(barsPerYear) : 0),
    winRatePct: cycleReturns.length ? winners.length / cycleReturns.length * 100 : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
    cycles: cycleReturns.length,
    fills,
    avgHoldHours: cycleReturns.length ? holdHours / cycleReturns.length : 0,
    exposurePct: exposedBars / Math.max(1, endIndex - firstValid) * 100,
    feesPct: feeTotal * 100,
    fundingPct: fundingTotal * 100,
    worstCyclePct: cycleReturns.length ? Math.min(...cycleReturns) * 100 : 0,
    equity: equityCurve,
  };
}

export function splitIndex(signals: SignalPoint[], fraction = 0.65) {
  const first = signals.findIndex((point) => point.z !== null);
  if (first < 0) return 0;
  return Math.max(first + 1, Math.round(first + (signals.length - first) * fraction));
}

export function recommend(points: GridPoint[], template: GridParams): Candidate[] {
  const candidates: Candidate[] = [];
  const lookbacks = [5, 7, 10, 14];
  const entries = [1.25, 1.5, 1.75, 2];
  const steps = [0.4, 0.6, 0.8];
  const exits = [0.25, 0.5];
  const holds = [24, 48, 72];
  for (const lookbackDays of lookbacks) {
    const signals = computeSignals(points, lookbackDays);
    const split = splitIndex(signals);
    for (const entryZ of entries) for (const gridStepZ of steps) for (const exitZ of exits) for (const maxHoldHours of holds) {
      const params = { ...template, lookbackDays, entryZ, gridStepZ, exitZ, maxHoldHours };
      const train = runBacktest(signals, params, 1, split);
      if (train.cycles < 3) continue;
      const test = runBacktest(signals, params, split, signals.length);
      const calmar = train.maxDrawdownPct > 0 ? train.returnPct / train.maxDrawdownPct : 0;
      const tradePenalty = Math.min(1, train.cycles / 6);
      const score = tradePenalty * (0.55 * Math.max(-3, Math.min(5, train.sharpe)) + 0.45 * Math.max(-3, Math.min(5, calmar))) - train.feesPct * 0.15;
      candidates.push({ params, train, test, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function diagnostics(signals: SignalPoint[]) {
  const valid = signals.filter((point): point is SignalPoint & { z: number; residual: number } => point.z !== null && point.residual !== null);
  const { intervalMs, barsPerDay } = cadence(signals);
  const recent = valid.slice(-Math.min(valid.length, 14 * barsPerDay));
  const xReturns = recent.slice(1).map((point, index) => Math.log(point.x / recent[index].x));
  const yReturns = recent.slice(1).map((point, index) => Math.log(point.y / recent[index].y));
  const meanX = xReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, xReturns.length);
  const meanY = yReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, yReturns.length);
  const covariance = xReturns.reduce((sum, value, index) => sum + (value - meanX) * (yReturns[index] - meanY), 0);
  const varianceX = xReturns.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  const varianceY = yReturns.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
  const correlation = covariance / Math.max(1e-12, Math.sqrt(varianceX * varianceY));
  const residuals = recent.map((point) => point.residual);
  const lag = residuals.slice(0, -1);
  const delta = residuals.slice(1).map((value, index) => value - residuals[index]);
  const lagMean = lag.reduce((sum, value) => sum + value, 0) / Math.max(1, lag.length);
  const deltaMean = delta.reduce((sum, value) => sum + value, 0) / Math.max(1, delta.length);
  const slope = lag.reduce((sum, value, index) => sum + (value - lagMean) * (delta[index] - deltaMean), 0) /
    Math.max(1e-12, lag.reduce((sum, value) => sum + (value - lagMean) ** 2, 0));
  const halfLifeBars = slope < 0 ? -Math.log(2) / slope : Number.POSITIVE_INFINITY;
  return {
    correlation: finite(correlation),
    beta: recent.at(-1)?.beta ?? 1,
    halfLifeHours: finite(halfLifeBars * intervalMs / 3_600_000, 999),
    z: recent.at(-1)?.z ?? 0,
  };
}
