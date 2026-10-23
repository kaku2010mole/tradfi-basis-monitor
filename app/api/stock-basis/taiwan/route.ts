import { taiwanSnapshot } from "../../../lib/taiwanMarket";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const view = new URL(request.url).searchParams.get("view") === "prices" ? "prices" : "full";
    return Response.json(await taiwanSnapshot(Date.now(), view), { headers: { "Cache-Control": "no-store" } });
  } catch (reason) {
    return Response.json({ error: reason instanceof Error ? reason.message : "Taiwan reference feed unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
