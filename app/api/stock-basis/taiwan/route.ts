import { taiwanSnapshot } from "../../../lib/taiwanMarket";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const view = params.get("view") === "prices" ? "prices" : "full";
    return Response.json(await taiwanSnapshot(Date.now(), view, params.get("refresh") === "resume"), { headers: { "Cache-Control": "no-store" } });
  } catch (reason) {
    return Response.json({ error: reason instanceof Error ? reason.message : "Taiwan reference feed unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
