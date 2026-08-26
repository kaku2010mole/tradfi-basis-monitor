type GammaMarket = {
  id?: string;
  question?: string;
  slug?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  orderPriceMinTickSize?: number | string;
  negRisk?: boolean;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  endDate?: string;
};

type GammaEvent = { title?: string; slug?: string; markets?: GammaMarket[] };
type BookLevel = { price?: string | number; size?: string | number };

const headers = { "Cache-Control": "no-store, max-age=0", "Access-Control-Allow-Origin": "*" };

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; }
  catch { return []; }
};

const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

async function fetchJson<T>(url: string, timeout = 8_000): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeout), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Polymarket HTTP ${response.status}`);
  return await response.json() as T;
}

export async function GET(request: Request) {
  try {
    const search = new URL(request.url).searchParams;
    const supplied = search.get("url")?.trim() ?? "";
    const outcomeName = search.get("outcome")?.trim() || "No";
    const target = new URL(supplied);
    if (!/(^|\.)polymarket\.com$/i.test(target.hostname)) throw new Error("Enter a polymarket.com market URL.");
    const parts = target.pathname.split("/").filter(Boolean);
    const eventIndex = parts.indexOf("event");
    const eventSlug = eventIndex >= 0 ? parts[eventIndex + 1] : "";
    const marketSlug = eventIndex >= 0 ? parts[eventIndex + 2] || eventSlug : "";
    if (!eventSlug || !marketSlug) throw new Error("The URL must include an event and market slug.");

    const event = await fetchJson<GammaEvent>(`https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(eventSlug)}`);
    const market = (event.markets ?? []).find((item) => item.slug === marketSlug)
      ?? (event.markets ?? []).find((item) => item.slug?.endsWith(marketSlug))
      ?? ((event.markets ?? []).length === 1 ? event.markets![0] : undefined);
    if (!market) throw new Error(`Market ${marketSlug} was not found inside this event.`);

    const outcomes = stringArray(market.outcomes);
    const tokenIds = stringArray(market.clobTokenIds);
    const outcomeIndex = outcomes.findIndex((item) => item.toLowerCase() === outcomeName.toLowerCase());
    if (outcomeIndex < 0 || !tokenIds[outcomeIndex]) throw new Error(`Outcome ${outcomeName} is unavailable. Available: ${outcomes.join(", ") || "none"}.`);
    const tokenId = tokenIds[outcomeIndex];
    const book = await fetchJson<{ bids?: BookLevel[]; asks?: BookLevel[]; min_order_size?: string; tick_size?: string }>(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
    const bids = (book.bids ?? []).map((level) => ({ price: positive(level.price), size: positive(level.size) })).filter((level): level is { price: number; size: number } => level.price !== null && level.size !== null).sort((a, b) => b.price - a.price);
    const asks = (book.asks ?? []).map((level) => ({ price: positive(level.price), size: positive(level.size) })).filter((level): level is { price: number; size: number } => level.price !== null && level.size !== null).sort((a, b) => a.price - b.price);
    const tickSize = String(market.orderPriceMinTickSize ?? book.tick_size ?? "0.01");

    return Response.json({
      eventTitle: event.title ?? market.question ?? eventSlug,
      question: market.question ?? marketSlug,
      eventSlug,
      marketSlug,
      marketId: market.id ?? null,
      outcome: outcomes[outcomeIndex],
      outcomes,
      tokenId,
      tickSize,
      negRisk: Boolean(market.negRisk),
      active: market.active !== false,
      closed: Boolean(market.closed),
      acceptingOrders: market.acceptingOrders !== false && market.active !== false && !market.closed,
      endDate: market.endDate ?? null,
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks[0]?.price ?? null,
      askSize: asks[0]?.size ?? null,
      bidSize: bids[0]?.size ?? null,
      minOrderSize: positive(book.min_order_size),
      timestamp: Date.now(),
    }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Polymarket market lookup failed.", timestamp: Date.now() }, { status: 400, headers });
  }
}
