import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const INFO_URL = "https://api.hyperliquid.xyz/info";

async function info(body: unknown) {
  const response = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Hyperliquid returned ${response.status}`);
  return response.json();
}

export async function GET() {
  try {
    const now = Date.now();
    const [market, candles] = await Promise.all([
      info({ type: "metaAndAssetCtxs", dex: "xyz" }),
      info({
        type: "candleSnapshot",
        req: {
          coin: "xyz:SKHX",
          interval: "30m",
          startTime: now - 32 * 60 * 60 * 1_000,
          endTime: now,
        },
      }),
    ]);
    const [meta, contexts] = market;
    const index = meta.universe.findIndex((asset: { name: string }) => asset.name === "xyz:SKHX");
    if (index < 0) throw new Error("xyz:SKHX is not present in the xyz market universe");
    const context = contexts[index];
    return NextResponse.json({
      ok: true,
      serverTime: now,
      quote: {
        mark: Number(context.markPx),
        oracle: Number(context.oraclePx),
        mid: context.midPx ? Number(context.midPx) : null,
        funding: Number(context.funding),
        openInterest: Number(context.openInterest),
        dayVolume: Number(context.dayNtlVlm),
      },
      candles: candles.map((bar: { t: number; c: string; h: string; l: string; v: string }) => ({
        time: bar.t,
        close: Number(bar.c),
        high: Number(bar.h),
        low: Number(bar.l),
        volume: Number(bar.v),
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown upstream error" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
