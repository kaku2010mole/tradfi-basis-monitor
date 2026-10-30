import { japanEstimateState } from "../../lib/japanEstimateMarket";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") && header.length < 16_384 ? header.slice(7) : undefined;
  try { return Response.json(await japanEstimateState(token), { headers: { "Cache-Control": "no-store, max-age=0" } }); }
  catch { return Response.json({ error: "Estimates are temporarily unavailable. Retain the original quote time." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
