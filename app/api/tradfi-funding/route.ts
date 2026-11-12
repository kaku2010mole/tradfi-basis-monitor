import { bitgetTradfiFundingState } from "../../lib/bitgetTradfiFundingMarket";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, max-age=0" };

export async function GET() {
  try { return Response.json(await bitgetTradfiFundingState(), { headers }); }
  catch { return Response.json({ error: "Bitget funding rates are temporarily unavailable. Try again shortly." }, { status: 503, headers }); }
}
