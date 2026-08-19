import { posleyAdrSnapshot } from "../../../lib/posleyAdr";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbols = url.searchParams.getAll("symbol");
  if (!symbols.length || symbols.length > 24) {
    return Response.json({ error: "Provide between 1 and 24 ADR symbols." }, { status: 400 });
  }
  const snapshot = await posleyAdrSnapshot(symbols);
  return Response.json(snapshot, {
    status: snapshot.configured ? 200 : 503,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
