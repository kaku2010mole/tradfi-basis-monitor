const BINANCE_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

type Venue = "binance" | "hyperliquid";
type Leg = { venue: Venue; symbol: string; label: string };
type Relationship = {
  id: string;
  title: string;
  short: string;
  kind: "same-benchmark" | "leveraged-inverse" | "risk-regime" | "cross-index";
  a: Leg;
  b: Leg;
  expectedBeta: number | null;
  thesis: string;
  caveat: string;
};

const RELATIONSHIPS: Relationship[] = [
  {
    id: "qqq-ustech",
    title: "QQQ ↔ USTECH",
    short: "Nasdaq technology proxy",
    kind: "same-benchmark",
    a: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" },
    b: { venue: "hyperliquid", symbol: "mkts:USTECH", label: "Hyperliquid USTECH" },
    expectedBeta: 1,
    thesis: "Both legs are intended to express large-cap US technology / Nasdaq risk. Their return paths should usually be close enough for a direct relative-value residual to be informative.",
    caveat: "They are different perpetual contracts with different oracle construction, liquidity, funding and venue risk; equal returns are a hypothesis, not a conversion guarantee.",
  },
  {
    id: "tbt-tmf",
    title: "TBT ↔ TMF",
    short: "Long-duration Treasury inverse",
    kind: "leveraged-inverse",
    a: { venue: "binance", symbol: "TBTUSDT", label: "Binance TBT" },
    b: { venue: "binance", symbol: "TMFUSDT", label: "Binance TMF" },
    expectedBeta: -2 / 3,
    thesis: "TBT targets −2× and TMF targets +3× the daily move of closely matched 20+ year US Treasury benchmarks. A −2:3 return hedge is the clean starting model.",
    caveat: "Daily resets, fees, financing and compounding make the −2:3 relationship progressively less exact outside a single trading session.",
  },
  {
    id: "uvxy-qqq",
    title: "UVXY ↔ QQQ",
    short: "Volatility versus growth risk",
    kind: "risk-regime",
    a: { venue: "binance", symbol: "UVXYUSDT", label: "Binance UVXY" },
    b: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" },
    expectedBeta: null,
    thesis: "Short-term VIX futures exposure often rises when growth equities sell off. The monitor estimates a live inverse beta instead of assuming a fixed hedge ratio.",
    caveat: "UVXY tracks VIX futures, not QQQ variance. Term structure, roll yield and volatility spikes can dominate the equity move, so this is a regime signal rather than hard arbitrage.",
  },
  {
    id: "soxl-tza",
    title: "SOXL ↔ TZA",
    short: "Leveraged risk-on / risk-off",
    kind: "cross-index",
    a: { venue: "binance", symbol: "SOXLUSDT", label: "Binance SOXL" },
    b: { venue: "binance", symbol: "TZAUSDT", label: "Binance TZA" },
    expectedBeta: null,
    thesis: "SOXL is a +3× semiconductor expression while TZA is a −3× small-cap expression. They often oppose each other when the dominant driver is broad US equity risk appetite.",
    caveat: "Semiconductors and Russell 2000 small caps are different baskets. Sector news, rates and factor rotation can create a legitimate divergence, so the fitted relationship is deliberately dynamic.",
  },
  {
    id: "iwm-tza",
    title: "IWM ↔ TZA",
    short: "Russell 2000 direct inverse",
    kind: "leveraged-inverse",
    a: { venue: "binance", symbol: "IWMUSDT", label: "Binance IWM" },
    b: { venue: "binance", symbol: "TZAUSDT", label: "Binance TZA" },
    expectedBeta: -1 / 3,
    thesis: "IWM represents Russell 2000 exposure while TZA targets −3× the Russell 2000 daily result, making −1:3 the structural return relationship.",
    caveat: "The Binance contracts remain 24/7 perpetuals and TZA resets daily; use short windows around the common US session for the cleanest comparison.",
  },
  {
    id: "qqq-tqqq",
    title: "QQQ ↔ TQQQ",
    short: "Nasdaq-100 +1× / +3×",
    kind: "same-benchmark",
    a: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" },
    b: { venue: "binance", symbol: "TQQQUSDT", label: "Binance TQQQ" },
    expectedBeta: 1 / 3,
    thesis: "QQQ and TQQQ share Nasdaq-100 exposure, with TQQQ targeting three times the benchmark's daily result. The return-space baseline is therefore 1:3.",
    caveat: "Compounding, daily rebalance and perpetual funding matter across multi-day windows.",
  },
  {
    id: "qqq-sqqq",
    title: "QQQ ↔ SQQQ",
    short: "Nasdaq-100 direct inverse",
    kind: "leveraged-inverse",
    a: { venue: "binance", symbol: "QQQUSDT", label: "Binance QQQ" },
    b: { venue: "binance", symbol: "SQQQUSDT", label: "Binance SQQQ" },
    expectedBeta: -1 / 3,
    thesis: "SQQQ targets −3× the Nasdaq-100 daily move while QQQ provides approximately +1× exposure.",
    caveat: "The theoretical beta is a daily objective and will not hold exactly after compounding or during thin perpetual liquidity.",
  },
  {
    id: "soxl-soxs",
    title: "SOXL ↔ SOXS",
    short: "Semiconductor +3× / −3×",
    kind: "leveraged-inverse",
    a: { venue: "binance", symbol: "SOXLUSDT", label: "Binance SOXL" },
    b: { venue: "binance", symbol: "SOXSUSDT", label: "Binance SOXS" },
    expectedBeta: -1,
    thesis: "Both funds target the same semiconductor benchmark at equal and opposite daily leverage, giving a −1 return baseline.",
    caveat: "Daily resets and separate perpetual market microstructure can still create persistent multi-day differences.",
  },
  {
    id: "ewy-koru",
    title: "EWY ↔ KORU",
    short: "Korea +1× / +3×",
    kind: "same-benchmark",
    a: { venue: "binance", symbol: "EWYUSDT", label: "Binance EWY" },
    b: { venue: "binance", symbol: "KORUUSDT", label: "Binance KORU" },
    expectedBeta: 1 / 3,
    thesis: "EWY and KORU express large- and mid-cap South Korean equity risk, with KORU targeting three times the benchmark's daily move.",
    caveat: "Index implementation, FX, reset timing and 24/7 perpetual pricing can all widen the residual outside the cash session.",
  },
];

type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string];
type HyperCandle = { t?: number; c?: string };
type ExchangeInfo = { symbols?: Array<{ symbol?: string; status?: string; underlyingType?: string; underlyingSubType?: string[] }> };

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchBinance<T>(path: string) {
  let lastError: unknown;
  for (const host of BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, { cache: "no-store", signal: AbortSignal.timeout(7_000) });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      await wait(80);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Binance market data unavailable.");
}

const intervalForRange = (durationMs: number) => {
  const hour = 60 * 60_000;
  const day = 24 * hour;
  if (durationMs <= day) return "1m";
  if (durationMs <= 4 * day) return "5m";
  if (durationMs <= 14 * day) return "15m";
  if (durationMs <= 45 * day) return "1h";
  return "4h";
};

async function getSeries(leg: Leg, start: number, end: number, interval: string) {
  if (leg.venue === "binance") {
    const params = new URLSearchParams({ symbol: leg.symbol, interval, startTime: String(start), endTime: String(end), limit: "1500" });
    const rows = await fetchBinance<BinanceKline[]>(`/fapi/v1/klines?${params}`);
    return rows.flatMap((row) => {
      const value = Number(row[4]);
      return Number.isFinite(value) && value > 0 ? [{ t: row[0], value }] : [];
    });
  }
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: leg.symbol, interval, startTime: start, endTime: end } }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  const rows = await response.json() as HyperCandle[];
  return rows.flatMap((row) => {
    const time = Number(row.t);
    const value = Number(row.c);
    return Number.isFinite(time) && Number.isFinite(value) && value > 0 ? [{ t: time, value }] : [];
  });
}

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const deviation = (values: number[], average = mean(values)) => {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};

function analyze(aRows: Array<{ t: number; value: number }>, bRows: Array<{ t: number; value: number }>, expectedBeta: number | null) {
  const bByTime = new Map(bRows.map((row) => [row.t, row.value]));
  const aligned = aRows.flatMap((row) => {
    const b = bByTime.get(row.t);
    return b ? [{ t: row.t, a: row.value, b }] : [];
  });
  if (aligned.length < 12) throw new Error("Not enough overlapping candles for this window.");

  const returnsA: number[] = [];
  const returnsB: number[] = [];
  for (let index = 1; index < aligned.length; index += 1) {
    returnsA.push(Math.log(aligned[index].a / aligned[index - 1].a));
    returnsB.push(Math.log(aligned[index].b / aligned[index - 1].b));
  }
  const averageA = mean(returnsA);
  const averageB = mean(returnsB);
  const covariance = returnsA.reduce((sum, value, index) => sum + (value - averageA) * (returnsB[index] - averageB), 0) / Math.max(1, returnsA.length - 1);
  const varianceB = returnsB.reduce((sum, value) => sum + (value - averageB) ** 2, 0) / Math.max(1, returnsB.length - 1);
  const stdA = deviation(returnsA, averageA);
  const stdB = deviation(returnsB, averageB);
  const fittedBeta = varianceB > 0 ? covariance / varianceB : 0;
  const correlation = stdA > 0 && stdB > 0 ? covariance / (stdA * stdB) : 0;
  const modelBeta = expectedBeta ?? fittedBeta;
  const first = aligned[0];
  const residuals = aligned.map((row) => Math.log(row.a / first.a) - modelBeta * Math.log(row.b / first.b));
  const baselineSize = Math.max(10, Math.min(residuals.length - 1, Math.floor(residuals.length * .8)));
  const baseline = residuals.slice(0, baselineSize);
  const residualMean = mean(baseline);
  const residualStd = deviation(baseline, residualMean);
  const points = aligned.map((row, index) => ({
    t: row.t,
    a: row.a,
    b: row.b,
    returnA: (row.a / first.a - 1) * 100,
    returnB: (row.b / first.b - 1) * 100,
    residual: residuals[index] * 100,
    z: residualStd > 0 ? (residuals[index] - residualMean) / residualStd : 0,
  }));
  const latest = points.at(-1)!;
  const absoluteZ = Math.abs(latest.z);
  return {
    points,
    stats: {
      correlation,
      fittedBeta,
      modelBeta,
      returnA: latest.returnA,
      returnB: latest.returnB,
      relativeGap: latest.residual,
      zScore: latest.z,
      status: absoluteZ >= 2 ? "dislocation" : absoluteZ >= 1.5 ? "watch" : "normal",
      samples: points.length,
    },
  };
}

async function scanUniverse() {
  const payload = await fetchBinance<ExchangeInfo>("/fapi/v1/exchangeInfo");
  const symbols = (payload.symbols ?? []).filter((item) => item.status === "TRADING" && item.underlyingSubType?.some((tag) => tag.toLowerCase() === "tradfi"));
  const active = new Set(symbols.map((item) => item.symbol).filter(Boolean) as string[]);
  const typeCounts = symbols.reduce<Record<string, number>>((counts, item) => {
    const type = item.underlyingType || "OTHER";
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
  return {
    count: symbols.length,
    symbols: [...active].sort(),
    typeCounts,
    candidates: RELATIONSHIPS.map((relationship) => ({
      id: relationship.id,
      available: [relationship.a, relationship.b].every((leg) => leg.venue === "hyperliquid" || active.has(leg.symbol)),
    })),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const relationship = RELATIONSHIPS.find((item) => item.id === (url.searchParams.get("relationship") || "qqq-ustech"));
  const end = Math.min(Number(url.searchParams.get("end") || Date.now()), Date.now());
  const start = Number(url.searchParams.get("start") || end - 24 * 60 * 60_000);
  const maximumRange = 90 * 24 * 60 * 60_000;
  if (!relationship) return Response.json({ error: "Unknown relationship." }, { status: 400 });
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || start >= end || end - start > maximumRange) {
    return Response.json({ error: "Choose a valid window of up to 90 days." }, { status: 400 });
  }
  const interval = intervalForRange(end - start);
  try {
    const [aRows, bRows, universe] = await Promise.all([
      getSeries(relationship.a, start, end, interval),
      getSeries(relationship.b, start, end, interval),
      scanUniverse().catch(() => null),
    ]);
    const analysis = analyze(aRows, bRows, relationship.expectedBeta);
    return Response.json({
      generatedAt: Date.now(),
      interval,
      relationship,
      relationships: RELATIONSHIPS,
      universe,
      ...analysis,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Relative-value history is temporarily unavailable.",
      relationships: RELATIONSHIPS,
    }, { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
