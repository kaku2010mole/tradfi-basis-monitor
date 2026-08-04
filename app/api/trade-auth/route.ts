import { createTradeToken, passwordMatches, tradeAuthConfigured, tradeCookie, TRADE_COOKIE } from "../../lib/tradeAuth";

export async function POST(request: Request) {
  if (!tradeAuthConfigured()) return Response.json({ error: "Trading access is not configured." }, { status: 503 });
  const payload = await request.json().catch(() => ({})) as { password?: unknown };
  if (typeof payload.password !== "string" || !await passwordMatches(payload.password)) {
    return Response.json({ error: "Incorrect trading password." }, { status: 401 });
  }
  const token = await createTradeToken();
  if (!token) return Response.json({ error: "Trading access is not configured." }, { status: 503 });
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": tradeCookie(token, new URL(request.url).protocol === "https:"),
    },
  });
}

export async function DELETE(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${TRADE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    },
  });
}
