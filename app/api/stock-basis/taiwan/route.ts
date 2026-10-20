import { taiwanSnapshot } from "../../../lib/taiwanMarket";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await taiwanSnapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch (reason) {
    return Response.json({ error: reason instanceof Error ? reason.message : "Taiwan reference feed unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
