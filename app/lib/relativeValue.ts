export type Venue = "binance" | "hyperliquid";
export type MarketLeg = { venue: Venue; symbol: string; label: string };
export type RelationshipKind = "same-benchmark" | "leveraged-inverse" | "leveraged-long" | "risk-regime" | "cross-index" | "same-company" | "sector-proxy" | "commodity-proxy";

export type Relationship = {
  id: string;
  title: string;
  short: string;
  kind: RelationshipKind;
  asset1: MarketLeg;
  asset2: MarketLeg;
  referenceBeta: number | null;
  leveraged: boolean;
  thesis: string;
  caveat: string;
};

export type PricePoint = { t: number; value: number };
export type TrainedModel = {
  alphaHourly: number;
  beta: number;
  referenceBeta: number | null;
  trainedAt: number;
  trainingStart: number;
  trainingEnd: number;
  validationStart: number;
  trainSamples: number;
  validationSamples: number;
  trainCorrelation: number;
  validationCorrelation: number;
  trainR2: number;
  validationR2: number;
  validationMaePct: number;
  validationResidualStd: number;
  validationBeta: number;
  betaDrift: number;
  quality: "validated" | "usable" | "weak";
};

export type ProjectionPoint = {
  t: number;
  asset1: number;
  asset2: number;
  asset1Return: number;
  asset2Actual: number;
  asset2Theoretical: number;
  predictionError: number;
  z: number;
};

export const TRAINING_DAYS = 45;
export const VALIDATION_FRACTION = .25;
export const MAX_OBSERVATION_MS = 3 * 24 * 60 * 60_000;
export const TRAINING_INTERVAL = "1h";

export const RELATIONSHIPS: Relationship[] = [
  {
    id: "qqq-ustech", title: "QQQ → USTECH", short: "Cross-venue Nasdaq technology proxy", kind: "same-benchmark",
    asset1: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" }, asset2: { venue: "hyperliquid", symbol: "mkts:USTECH", label: "Hyperliquid USTECH" },
    referenceBeta: 1, leveraged: false,
    thesis: "Use QQQ's move to estimate the USTECH perpetual's move across venues.",
    caveat: "Oracle construction, funding and trading liquidity differ even when the underlying technology exposure is similar.",
  },
  {
    id: "spy-us500", title: "SPY → US500", short: "Cross-venue US large-cap proxy", kind: "same-benchmark",
    asset1: { venue: "binance", symbol: "SPYUSDT", label: "Binance SPY" }, asset2: { venue: "hyperliquid", symbol: "mkts:US500", label: "Hyperliquid US500" },
    referenceBeta: 1, leveraged: false,
    thesis: "Use SPY as the liquid US large-cap input and estimate the Hyperliquid US500 return.",
    caveat: "The contracts can use different reference and funding mechanics, so the learned coefficient is tested rather than assumed to equal one.",
  },
  {
    id: "spy-qqq", title: "SPY → QQQ", short: "US large caps to Nasdaq growth", kind: "cross-index",
    asset1: { venue: "binance", symbol: "SPYUSDT", label: "Binance SPY" }, asset2: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" },
    referenceBeta: null, leveraged: false,
    thesis: "Learn QQQ's growth-heavy response to broad US large-cap market moves.",
    caveat: "Nasdaq sector concentration and factor rotation can change the coefficient even when both index contracts are functioning normally.",
  },
  {
    id: "tbt-tmf", title: "TBT → TMF", short: "−2× to +3× long-duration Treasury", kind: "leveraged-inverse",
    asset1: { venue: "binance", symbol: "TBTUSDT", label: "Binance TBT" }, asset2: { venue: "binance", symbol: "TMFUSDT", label: "Binance TMF" },
    referenceBeta: -1.5, leveraged: true,
    thesis: "TBT targets −2× while TMF targets +3× daily long-duration Treasury performance; TMF should move about −1.5 times TBT before frictions.",
    caveat: "Both reset daily. The learned hourly relationship is used only for observation windows up to three days.",
  },
  {
    id: "qqq-uvxy", title: "QQQ → UVXY", short: "Growth risk to short-volatility futures", kind: "risk-regime",
    asset1: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" }, asset2: { venue: "binance", symbol: "UVXYUSDT", label: "Binance UVXY" },
    referenceBeta: null, leveraged: true,
    thesis: "Estimate UVXY from QQQ using an empirically learned inverse coefficient.",
    caveat: "UVXY follows VIX futures rather than QQQ variance. A weak validation score means the regime relationship is not currently reliable.",
  },
  {
    id: "soxl-tza", title: "SOXL → TZA", short: "Leveraged semiconductor risk to small-cap hedge", kind: "cross-index",
    asset1: { venue: "binance", symbol: "SOXLUSDT", label: "Binance SOXL" }, asset2: { venue: "binance", symbol: "TZAUSDT", label: "Binance TZA" },
    referenceBeta: null, leveraged: true,
    thesis: "Learn the current risk-on/risk-off mapping from leveraged semiconductors to inverse small caps.",
    caveat: "The underlying indexes differ; sector rotation can make this model weak even when both products are functioning correctly.",
  },
  {
    id: "qqq-tza", title: "QQQ → TZA", short: "Nasdaq growth to inverse small caps", kind: "cross-index",
    asset1: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" }, asset2: { venue: "binance", symbol: "TZAUSDT", label: "Binance TZA" },
    referenceBeta: null, leveraged: true,
    thesis: "Estimate the current inverse small-cap response to large-cap growth moves.",
    caveat: "Russell 2000 and Nasdaq-100 factor exposure is different; validation quality determines whether the coefficient should be trusted.",
  },
  {
    id: "iwm-tza", title: "IWM → TZA", short: "Russell 2000 +1× to −3×", kind: "leveraged-inverse",
    asset1: { venue: "binance", symbol: "IWMUSDT", label: "Binance IWM" }, asset2: { venue: "binance", symbol: "TZAUSDT", label: "Binance TZA" },
    referenceBeta: -3, leveraged: true,
    thesis: "IWM supplies the Russell 2000 input; TZA targets three times its inverse daily move.",
    caveat: "The −3 reference is a daily objective and can drift with compounding, fees and perpetual funding.",
  },
  {
    id: "qqq-tqqq", title: "QQQ → TQQQ", short: "Nasdaq-100 +1× to +3×", kind: "leveraged-long",
    asset1: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" }, asset2: { venue: "binance", symbol: "TQQQUSDT", label: "Binance TQQQ" },
    referenceBeta: 3, leveraged: true,
    thesis: "Predict TQQQ from QQQ and compare the learned coefficient with the +3 daily reference.",
    caveat: "The +3 objective resets daily; cumulative returns beyond three days are intentionally excluded.",
  },
  {
    id: "qqq-sqqq", title: "QQQ → SQQQ", short: "Nasdaq-100 +1× to −3×", kind: "leveraged-inverse",
    asset1: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" }, asset2: { venue: "binance", symbol: "SQQQUSDT", label: "Binance SQQQ" },
    referenceBeta: -3, leveraged: true,
    thesis: "Predict SQQQ from QQQ against its −3 daily reference.",
    caveat: "The theoretical leverage is daily, not a multi-day guarantee.",
  },
  {
    id: "soxl-soxs", title: "SOXL → SOXS", short: "+3× to −3× semiconductor", kind: "leveraged-inverse",
    asset1: { venue: "binance", symbol: "SOXLUSDT", label: "Binance SOXL" }, asset2: { venue: "binance", symbol: "SOXSUSDT", label: "Binance SOXS" },
    referenceBeta: -1, leveraged: true,
    thesis: "Equal and opposite daily leverage on the same semiconductor benchmark should produce a coefficient near −1.",
    caveat: "Separate daily resets and market microstructure can still create prediction errors.",
  },
  {
    id: "ewy-koru", title: "EWY → KORU", short: "Korea +1× to +3×", kind: "leveraged-long",
    asset1: { venue: "binance", symbol: "EWYUSDT", label: "Binance EWY" }, asset2: { venue: "binance", symbol: "KORUUSDT", label: "Binance KORU" },
    referenceBeta: 3, leveraged: true,
    thesis: "Use EWY's Korea equity move to estimate KORU's +3× daily response.",
    caveat: "Index implementation, FX and daily reset timing can widen the result outside the common cash session.",
  },
  {
    id: "sndk-snxx", title: "SNDK → SNXX", short: "Single stock to +2× daily ETF", kind: "leveraged-long",
    asset1: { venue: "binance", symbol: "SNDKUSDT", label: "Binance SNDK" }, asset2: { venue: "binance", symbol: "SNXXUSDT", label: "Binance SNXX" },
    referenceBeta: 2, leveraged: true,
    thesis: "SNXX is designed as a +2× daily SNDK vehicle, making SNDK the natural predictor.",
    caveat: "Single-stock leveraged products can be thin and reset daily; validation and liquidity remain essential.",
  },
  {
    id: "mrvl-mvll", title: "MRVL → MVLL", short: "Single stock to +2× daily ETF", kind: "leveraged-long",
    asset1: { venue: "binance", symbol: "MRVLUSDT", label: "Binance MRVL" }, asset2: { venue: "binance", symbol: "MVLLUSDT", label: "Binance MVLL" },
    referenceBeta: 2, leveraged: true,
    thesis: "MVLL targets twice the daily percentage move of Marvell, so MRVL is the direct input asset.",
    caveat: "Daily compounding and separate perpetual liquidity make +2 a reference rather than a guaranteed fillable relationship.",
  },
  {
    id: "mu-muu", title: "MU → MUU", short: "Single stock to +2× daily ETF", kind: "leveraged-long",
    asset1: { venue: "binance", symbol: "MUUSDT", label: "Binance MU" }, asset2: { venue: "binance", symbol: "MUUUSDT", label: "Binance MUU" },
    referenceBeta: 2, leveraged: true,
    thesis: "MUU targets twice Micron's daily performance, so MU supplies the explanatory return.",
    caveat: "The +2 target resets daily and may be distorted by perpetual funding or thin off-hours trading.",
  },
  {
    id: "hk0700-tencent", title: "HK0700 → TENCENT", short: "Same company, two Binance references", kind: "same-company",
    asset1: { venue: "binance", symbol: "HK0700USDT", label: "Binance HK0700" }, asset2: { venue: "binance", symbol: "TENCENTUSDT", label: "Binance TENCENT" },
    referenceBeta: 1, leveraged: false,
    thesis: "Both contracts reference Tencent exposure, making return parity the starting point.",
    caveat: "Contract denomination, oracle methodology and market availability can differ even for the same company.",
  },
  {
    id: "skhynix-skhy", title: "SKHYNIX → SKHY", short: "Korean listing to US ADR proxy", kind: "same-company",
    asset1: { venue: "binance", symbol: "SKHYNIXUSDT", label: "Binance SKHYNIX" }, asset2: { venue: "binance", symbol: "SKHYUSDT", label: "Binance SKHY ADR" },
    referenceBeta: 1, leveraged: false,
    thesis: "Estimate the US ADR-style contract from the Korean SK Hynix reference.",
    caveat: "FX, market-hour gaps and ADR conversion effects mean a one-for-one return must be validated empirically.",
  },
  {
    id: "smh-soxl", title: "SMH → SOXL", short: "Semiconductor basket to +3× sector ETF", kind: "sector-proxy",
    asset1: { venue: "binance", symbol: "SMHUSDT", label: "Binance SMH" }, asset2: { venue: "binance", symbol: "SOXLUSDT", label: "Binance SOXL" },
    referenceBeta: null, leveraged: true,
    thesis: "Both represent US-listed semiconductor companies; the model learns the mapping despite different indexes.",
    caveat: "SMH and SOXL do not track the same semiconductor index, so the coefficient is empirical rather than a formal +3 ratio.",
  },
  {
    id: "cl-bz", title: "WTI CL → Brent BZ", short: "Two global crude-oil benchmarks", kind: "commodity-proxy",
    asset1: { venue: "binance", symbol: "CLUSDT", label: "Binance WTI CL" }, asset2: { venue: "binance", symbol: "BZUSDT", label: "Binance Brent BZ" },
    referenceBeta: null, leveraged: false,
    thesis: "Use WTI crude returns to estimate the related Brent benchmark move.",
    caveat: "Regional supply, transport constraints and futures curves can legitimately move the WTI-Brent spread.",
  },
  {
    id: "xau-xag", title: "Gold XAU → Silver XAG", short: "Precious-metals macro relationship", kind: "commodity-proxy",
    asset1: { venue: "binance", symbol: "XAUUSDT", label: "Binance Gold XAU" }, asset2: { venue: "binance", symbol: "XAGUSDT", label: "Binance Silver XAG" },
    referenceBeta: null, leveraged: false,
    thesis: "Estimate silver's typically higher-beta response to gold's macro move.",
    caveat: "Silver has substantial industrial demand, so the relationship can weaken during growth or supply shocks.",
  },
];

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const standardDeviation = (values: number[], center = mean(values)) => values.length < 2 ? 0 : Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));

export function alignPrices(asset1Rows: PricePoint[], asset2Rows: PricePoint[]) {
  const asset2ByTime = new Map(asset2Rows.map((row) => [row.t, row.value]));
  return asset1Rows.flatMap((row) => {
    const asset2 = asset2ByTime.get(row.t);
    return asset2 ? [{ t: row.t, asset1: row.value, asset2 }] : [];
  });
}

const regression = (x: number[], y: number[]) => {
  const meanX = mean(x);
  const meanY = mean(y);
  const covariance = x.reduce((sum, value, index) => sum + (value - meanX) * (y[index] - meanY), 0) / Math.max(1, x.length - 1);
  const varianceX = x.reduce((sum, value) => sum + (value - meanX) ** 2, 0) / Math.max(1, x.length - 1);
  const stdX = standardDeviation(x, meanX);
  const stdY = standardDeviation(y, meanY);
  const beta = varianceX > 0 ? covariance / varianceX : 0;
  const alpha = meanY - beta * meanX;
  const correlation = stdX > 0 && stdY > 0 ? covariance / (stdX * stdY) : 0;
  return { alpha, beta, correlation };
};

const modelMetrics = (x: number[], y: number[], alpha: number, beta: number) => {
  const center = mean(y);
  const residuals = y.map((value, index) => value - (alpha + beta * x[index]));
  const sse = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const sst = y.reduce((sum, value) => sum + (value - center) ** 2, 0);
  return {
    r2: sst > 0 ? 1 - sse / sst : 0,
    maePct: mean(residuals.map((value) => Math.abs(value))) * 100,
    residualStd: standardDeviation(residuals),
  };
};

export function trainRelationshipModel(asset1Rows: PricePoint[], asset2Rows: PricePoint[], relationship: Relationship, trainingStart: number, trainingEnd: number): TrainedModel {
  const aligned = alignPrices(asset1Rows, asset2Rows);
  if (aligned.length < 80) throw new Error("Not enough aligned hourly candles to train and validate this relationship.");
  const x = aligned.slice(1).map((row, index) => Math.log(row.asset1 / aligned[index].asset1));
  const y = aligned.slice(1).map((row, index) => Math.log(row.asset2 / aligned[index].asset2));
  const split = Math.max(40, Math.min(x.length - 24, Math.floor(x.length * (1 - VALIDATION_FRACTION))));
  const trainX = x.slice(0, split);
  const trainY = y.slice(0, split);
  const validationX = x.slice(split);
  const validationY = y.slice(split);
  const fitted = regression(trainX, trainY);
  const validationFit = regression(validationX, validationY);
  const trainMetrics = modelMetrics(trainX, trainY, fitted.alpha, fitted.beta);
  const validationMetrics = modelMetrics(validationX, validationY, fitted.alpha, fitted.beta);
  const betaDrift = Math.abs(validationFit.beta - fitted.beta) / Math.max(Math.abs(fitted.beta), .1);
  const absoluteCorrelation = Math.abs(validationFit.correlation);
  const quality = absoluteCorrelation >= .75 && validationMetrics.r2 >= .45 && betaDrift <= .6 ? "validated"
    : absoluteCorrelation >= .5 && validationMetrics.r2 >= .18 && betaDrift <= 1.2 ? "usable"
      : "weak";
  return {
    alphaHourly: fitted.alpha,
    beta: fitted.beta,
    referenceBeta: relationship.referenceBeta,
    trainedAt: Date.now(),
    trainingStart,
    trainingEnd,
    validationStart: aligned[split]?.t ?? trainingEnd,
    trainSamples: trainX.length,
    validationSamples: validationX.length,
    trainCorrelation: fitted.correlation,
    validationCorrelation: validationFit.correlation,
    trainR2: trainMetrics.r2,
    validationR2: validationMetrics.r2,
    validationMaePct: validationMetrics.maePct,
    validationResidualStd: Math.max(validationMetrics.residualStd, 1e-8),
    validationBeta: validationFit.beta,
    betaDrift,
    quality,
  };
}

export function projectRelationship(asset1Rows: PricePoint[], asset2Rows: PricePoint[], model: TrainedModel) {
  const aligned = alignPrices(asset1Rows, asset2Rows);
  if (aligned.length < 2) throw new Error("Not enough overlapping candles in the selected observation window.");
  const first = aligned[0];
  const points = aligned.map<ProjectionPoint>((row) => {
    const elapsedHours = Math.max(0, (row.t - first.t) / 60 / 60_000);
    const asset1LogReturn = Math.log(row.asset1 / first.asset1);
    const theoreticalLogReturn = model.alphaHourly * elapsedHours + model.beta * asset1LogReturn;
    const actualLogReturn = Math.log(row.asset2 / first.asset2);
    const asset2Theoretical = Math.expm1(theoreticalLogReturn) * 100;
    const asset2Actual = (row.asset2 / first.asset2 - 1) * 100;
    const errorLog = actualLogReturn - theoreticalLogReturn;
    const expectedError = model.validationResidualStd * Math.sqrt(Math.max(1, elapsedHours));
    return {
      t: row.t,
      asset1: row.asset1,
      asset2: row.asset2,
      asset1Return: (row.asset1 / first.asset1 - 1) * 100,
      asset2Actual,
      asset2Theoretical,
      predictionError: asset2Actual - asset2Theoretical,
      z: errorLog / expectedError,
    };
  });
  const latest = points.at(-1)!;
  const magnitude = Math.abs(latest.z);
  return {
    points,
    stats: {
      asset1Return: latest.asset1Return,
      asset2Actual: latest.asset2Actual,
      asset2Theoretical: latest.asset2Theoretical,
      predictionError: latest.predictionError,
      zScore: latest.z,
      status: magnitude >= 2 ? "dislocation" as const : magnitude >= 1.5 ? "watch" as const : "normal" as const,
      samples: points.length,
    },
  };
}

export function fixedTrainingWindow(now: number) {
  const day = 24 * 60 * 60_000;
  const hktDayStart = Math.floor((now + 8 * 60 * 60_000) / day) * day - 8 * 60 * 60_000;
  const trainingEnd = hktDayStart - MAX_OBSERVATION_MS;
  return { trainingStart: trainingEnd - TRAINING_DAYS * day, trainingEnd };
}
