import { isPeerAsset } from "../../lib/hkPeerOpening";
import { hkPeerOpeningState } from "../../lib/hkPeerOpeningMarket";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const asset = new URL(request.url).searchParams.get("asset");
  const headers = { "Cache-Control": "no-store, max-age=0" };
  if (!isPeerAsset(asset)) return Response.json({ error: "Unknown opening-outlook instrument." }, { status: 400, headers });
  try { return Response.json(await hkPeerOpeningState(asset), { headers }); }
  catch { return Response.json({ error: "Opening outlook is temporarily unavailable." }, { status: 503, headers }); }
}
