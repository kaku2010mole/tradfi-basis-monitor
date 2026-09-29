export const dynamic = "force-dynamic";

type RawQuote = {
  symbol?: string;
  previousClose?: number | null;
  marketTimestamp?: number | null;
  exchangeTimestamp?: number | null;
};

type PushStore = typeof globalThis & {
  __FUTU_PUSH_SNAPSHOT__?: { payload: { quotes?: RawQuote[] }; receivedAt: number };
  __TREASURY_CURVE_CACHE__?: { value: TreasuryCurve; expiresAt: number };
};

type TreasuryCurve = { asOf: string; yields: Record<"ZT" | "ZF" | "ZN" | "ZB", number> };

const CONTRACTS = [
  { symbol: "ZT", futuSymbol: "US.ZTmain", tenor: "2Y", field: "BC_2YEAR", pointValue: 2_000, dv01: 38 },
  { symbol: "ZF", futuSymbol: "US.ZFmain", tenor: "5Y", field: "BC_5YEAR", pointValue: 1_000, dv01: 45 },
  { symbol: "ZN", futuSymbol: "US.ZNmain", tenor: "10Y", field: "BC_10YEAR", pointValue: 1_000, dv01: 61 },
  { symbol: "ZB", futuSymbol: "US.ZBmain", tenor: "30Y", field: "BC_30YEAR", pointValue: 1_000, dv01: 145 },
] as const;

const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

function tag(content: string, name: string) {
  const match = content.match(new RegExp(`<d:${name}(?:\\s[^>]*)?>([^<]+)</d:${name}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

async function latestTreasuryCurve() {
  const store = globalThis as PushStore;
  const cached = store.__TREASURY_CURVE_CACHE__;
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const year = new Date().getUTCFullYear();
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
  const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/xml" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Treasury feed HTTP ${response.status}`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
  for (const entry of entries.reverse()) {
    const date = tag(entry, "NEW_DATE")?.slice(0, 10);
    const values = Object.fromEntries(CONTRACTS.map((contract) => [contract.symbol, number(tag(entry, contract.field))]));
    if (date && CONTRACTS.every((contract) => values[contract.symbol] !== null)) {
      const value = { asOf: date, yields: values as TreasuryCurve["yields"] };
      store.__TREASURY_CURVE_CACHE__ = { value, expiresAt: Date.now() + 6 * 60 * 60_000 };
      return value;
    }
  }
  throw new Error("Treasury feed returned no complete curve.");
}

export async function GET() {
  try {
    const curve = await latestTreasuryCurve();
    const pushed = (globalThis as PushStore).__FUTU_PUSH_SNAPSHOT__;
    const quotes = new Map((pushed?.payload.quotes ?? []).flatMap((quote) => quote.symbol ? [[quote.symbol.toUpperCase(), quote] as const] : []));
    const contracts = CONTRACTS.map((contract) => {
      const quote = quotes.get(contract.futuSymbol.toUpperCase());
      return {
        symbol: contract.symbol,
        futuSymbol: contract.futuSymbol,
        tenor: contract.tenor,
        referencePrice: number(quote?.previousClose),
        referenceYield: curve.yields[contract.symbol],
        pointValue: contract.pointValue,
        dv01: contract.dv01,
        quoteAt: number(quote?.exchangeTimestamp) ?? number(quote?.marketTimestamp),
      };
    });
    const missing = contracts.filter((contract) => contract.referencePrice === null).map((contract) => contract.symbol);
    return Response.json({
      ok: missing.length === 0,
      asOf: curve.asOf,
      curveSource: "U.S. Treasury Daily Par Yield Curve",
      settlementSource: "Futu OpenD previous close",
      relayAt: pushed?.receivedAt ?? null,
      missing,
      contracts,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Daily Treasury baseline unavailable." }, { status: 502 });
  }
}
