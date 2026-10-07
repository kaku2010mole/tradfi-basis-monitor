export const dynamic = "force-dynamic";

const ENDPOINTS = new Set(["state", "history", "export.csv", "liquidations.csv"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ endpoint: string[] }> },
) {
  const { endpoint } = await params;
  if (endpoint.length !== 1 || !ENDPOINTS.has(endpoint[0])) {
    return new Response("Not found", { status: 404 });
  }

  const sourceUrl = new URL(request.url);
  const port = process.env.JLP_PORT || "8788";
  const upstreamUrl = `http://127.0.0.1:${port}/api/${endpoint[0]}${sourceUrl.search}`;
  try {
    const upstream = await fetch(upstreamUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(endpoint[0] === "state" ? 5_000 : 15_000),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "JLP data service unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
