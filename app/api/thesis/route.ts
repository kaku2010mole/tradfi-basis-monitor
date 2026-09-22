export const dynamic = "force-dynamic";

type Direction = "LONG" | "SHORT";
type Market = "PERP" | "SPOT";
type Instrument = { venue: "BINANCE" | "OKX" | "BITGET" | "HYPERLIQUID"; symbol: string; market: Market };
type Proposal = { direction: Direction; symbol: string; venue?: string; reason?: string; role?: "PRIMARY" | "RELATED" | "HEDGE" };

const CACHE_MS = 5 * 60_000;
const runtime = globalThis as typeof globalThis & { __THESIS_UNIVERSE__?: { expiresAt: number; value: Promise<Instrument[]> } };
const timeout = (ms = 10_000) => AbortSignal.timeout(ms);

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", signal: timeout() });
  if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function loadUniverse() {
  const now = Date.now();
  if (runtime.__THESIS_UNIVERSE__ && runtime.__THESIS_UNIVERSE__.expiresAt > now) return runtime.__THESIS_UNIVERSE__.value;
  const value = (async () => {
    const results = await Promise.allSettled([
      json<{ symbols?: Array<{ symbol?: string; status?: string; contractType?: string }> }>("https://fapi.binance.com/fapi/v1/exchangeInfo"),
      json<{ data?: Array<{ instId?: string; state?: string }> }>("https://www.okx.com/api/v5/public/instruments?instType=SWAP"),
      json<{ data?: Array<{ instId?: string; state?: string }> }>("https://www.okx.com/api/v5/public/instruments?instType=SPOT"),
      json<{ data?: Array<{ symbol?: string; symbolStatus?: string }> }>("https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures"),
      json<[{ universe?: Array<{ name?: string }> }, unknown[]]>("https://api.hyperliquid.xyz/info", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      }),
      json<[{ universe?: Array<{ name?: string }> }, unknown[]]>("https://api.hyperliquid.xyz/info", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }),
      }),
    ]);
    const instruments: Instrument[] = [];
    const fulfilled = <T,>(index: number) => results[index].status === "fulfilled" ? results[index].value as T : null;
    fulfilled<{ symbols?: Array<{ symbol?: string; status?: string; contractType?: string }> }>(0)?.symbols?.forEach((item) => {
      if (item.symbol && item.status === "TRADING" && item.contractType === "PERPETUAL") instruments.push({ venue: "BINANCE", symbol: item.symbol, market: "PERP" });
    });
    for (const [index, market] of [[1, "PERP"], [2, "SPOT"]] as const) fulfilled<{ data?: Array<{ instId?: string; state?: string }> }>(index)?.data?.forEach((item) => {
      if (item.instId && item.state === "live") instruments.push({ venue: "OKX", symbol: item.instId, market });
    });
    fulfilled<{ data?: Array<{ symbol?: string; symbolStatus?: string }> }>(3)?.data?.forEach((item) => {
      if (item.symbol && (!item.symbolStatus || item.symbolStatus.toLowerCase() === "normal")) instruments.push({ venue: "BITGET", symbol: item.symbol, market: "PERP" });
    });
    for (const [index, prefix] of [[4, ""], [5, "xyz:"]] as const) fulfilled<[{ universe?: Array<{ name?: string }> }, unknown[]]>(index)?.[0]?.universe?.forEach((item) => {
      if (item.name) instruments.push({ venue: "HYPERLIQUID", symbol: item.name.includes(":") ? item.name : `${prefix}${item.name}`, market: "PERP" });
    });
    return [...new Map(instruments.map((item) => [`${item.venue}:${item.market}:${item.symbol}`, item])).values()];
  })();
  runtime.__THESIS_UNIVERSE__ = { expiresAt: now + CACHE_MS, value };
  return value;
}

const normalized = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(?:USDT|USDC|USD)$/g, "");

function resolveProposal(proposal: Proposal, universe: Instrument[]) {
  const venue = proposal.venue?.toUpperCase();
  const exact = universe.filter((item) => (!venue || item.venue === venue) && item.symbol.toUpperCase() === proposal.symbol.toUpperCase());
  const target = normalized(proposal.symbol);
  const matches = exact.length ? exact : universe.filter((item) => (!venue || item.venue === venue) && normalized(item.symbol) === target);
  return matches.slice(0, 2).map((instrument) => ({
    ...instrument,
    direction: proposal.direction,
    role: proposal.role ?? "RELATED",
    reason: proposal.reason?.slice(0, 160) || "Direct expression of the submitted thesis.",
  }));
}

const reasoningPrompt = "You are an independent cross-asset trading researcher. For every new thesis, reason from first principles: identify the causal transmission chain, direct beneficiaries/losers, second-order expressions and useful hedges. Do not rely on a fixed scenario table or merely repeat symbols from the user. Search your market knowledge for concrete instruments that may trade on Binance, OKX, Bitget or Hyperliquid, including equity, ETF, commodity, rates, FX, volatility and crypto proxies. Return at most 12 candidate listings. Never output categories, prose placeholders, OTC-only instruments or fabricated tickers. Use only LONG or SHORT. Return only JSON: {\"items\":[{\"direction\":\"LONG\",\"symbol\":\"...\",\"venue\":\"BINANCE|OKX|BITGET|HYPERLIQUID\",\"role\":\"PRIMARY|RELATED|HEDGE\",\"reason\":\"causal link in one sentence\"}]}";

async function geminiProposals(thesis: string, apiKey: string): Promise<Proposal[]> {
  const configured = process.env.GEMINI_THESIS_MODEL?.trim();
  const models = configured ? [configured] : ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite"];
  let lastStatus = 503;
  for (const model of models) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: reasoningPrompt }] },
        contents: [{ role: "user", parts: [{ text: thesis }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.25 },
      }),
      signal: timeout(25_000),
    });
    if (!response.ok) {
      lastStatus = response.status;
      if ([404, 429, 503].includes(response.status) && models.length > 1) continue;
      throw new Error(`Gemini reasoning HTTP ${response.status}`);
    }
    const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as { items?: Proposal[] };
    return Array.isArray(parsed.items) ? parsed.items.slice(0, 12) : [];
  }
  throw new Error(`Gemini reasoning HTTP ${lastStatus}`);
}

async function openAiProposals(thesis: string, apiKey: string): Promise<Proposal[]> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_THESIS_MODEL?.trim() || "gpt-5-mini",
      input: [
        { role: "system", content: reasoningPrompt },
        { role: "user", content: thesis },
      ],
    }),
    signal: timeout(20_000),
  });
  if (!response.ok) throw new Error(`Thesis model HTTP ${response.status}`);
  const body = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  const text = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text ?? "";
  const objectText = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
  const parsed = JSON.parse(objectText) as { items?: Proposal[] };
  return Array.isArray(parsed.items) ? parsed.items.slice(0, 12) : [];
}

async function modelProposals(thesis: string): Promise<{ items: Proposal[]; provider: "GEMINI" | "OPENAI" }> {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) return { items: await geminiProposals(thesis, geminiKey), provider: "GEMINI" };
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiKey) return { items: await openAiProposals(thesis, openAiKey), provider: "OPENAI" };
  throw new Error("Reasoning engine is not configured. Add GEMINI_API_KEY to the server environment.");
}

export async function GET() {
  try {
    const universe = await loadUniverse();
    const venues = Object.fromEntries(["BINANCE", "OKX", "BITGET", "HYPERLIQUID"].map((venue) => [venue, universe.filter((item) => item.venue === venue).length]));
    const provider = process.env.GEMINI_API_KEY ? "GEMINI" : process.env.OPENAI_API_KEY ? "OPENAI" : null;
    return Response.json({ ok: true, venues, instruments: universe.length, aiReady: Boolean(provider), provider }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Market directory unavailable." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let thesis = "";
  try { thesis = String((await request.json() as { thesis?: unknown }).thesis ?? "").trim(); } catch { /* handled below */ }
  if (thesis.length < 3 || thesis.length > 1_000) return Response.json({ error: "Enter a thesis between 3 and 1,000 characters." }, { status: 400 });
  try {
    const universe = await loadUniverse();
    const reasoning = await modelProposals(thesis);
    const proposals = reasoning.items;
    const source = `${reasoning.provider} REASONING + LIVE DIRECTORY`;
    const items = proposals.flatMap((proposal) => resolveProposal(proposal, universe));
    const unique = [...new Map(items.map((item) => [`${item.direction}:${item.venue}:${item.market}:${item.symbol}`, item])).values()].slice(0, 10);
    return Response.json({ ok: true, thesis, source, items: unique, checked: universe.length, timestamp: Date.now(), message: unique.length ? null : "No currently tradeable symbol passed exchange-directory verification." }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Thesis mapping unavailable." }, { status: 502 });
  }
}
