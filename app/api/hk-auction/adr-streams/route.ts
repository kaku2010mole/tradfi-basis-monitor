const DEFAULT_GATEWAY = "https://redis-data.posley.capital";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._-]{100,6000}$/.test(authorization)) {
    return Response.json({ error: "A valid Posley Cognito ID token is required." }, { status: 401 });
  }
  const configured = process.env.NEXT_PUBLIC_REDIS_BACKEND_URL?.trim() || DEFAULT_GATEWAY;
  const gateway = new URL(configured);
  if (gateway.protocol !== "https:") {
    return Response.json({ error: "Posley gateway must use HTTPS." }, { status: 503 });
  }
  try {
    const response = await fetch(new URL("/redis/streams", gateway), {
      headers: { Authorization: authorization, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.text();
    return new Response(body || JSON.stringify({ error: "Empty Posley stream directory response." }), {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Posley stream directory unavailable." }, { status: 502 });
  }
}
