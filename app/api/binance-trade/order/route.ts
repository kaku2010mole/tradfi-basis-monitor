import { tradeTokenFromRequest, verifyTradeToken } from "../../../lib/tradeAuth";

const BINANCE_API = "https://fapi.binance.com";
const SYMBOL_PATTERN = /^[A-Z0-9_]{2,32}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{16,160}$/;
const ALLOWED_PARAMETERS = new Set([
  "symbol", "side", "type", "timeInForce", "quantity", "price", "positionSide", "reduceOnly",
  "newClientOrderId", "newOrderRespType", "recvWindow", "timestamp",
]);

export async function POST(request: Request) {
  if (!await verifyTradeToken(tradeTokenFromRequest(request))) return Response.json({ error: "Trading access required." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { apiKey?: unknown; query?: unknown; signature?: unknown; live?: unknown };
  if (typeof body.apiKey !== "string" || !API_KEY_PATTERN.test(body.apiKey) || typeof body.query !== "string" || body.query.length > 700 || typeof body.signature !== "string" || !SIGNATURE_PATTERN.test(body.signature)) {
    return Response.json({ error: "Invalid signed order payload." }, { status: 400 });
  }
  const params = new URLSearchParams(body.query);
  if ([...params.keys()].some((key) => !ALLOWED_PARAMETERS.has(key))) return Response.json({ error: "Unsupported order parameter." }, { status: 400 });
  const symbol = params.get("symbol") ?? "";
  const side = params.get("side");
  const positionSide = params.get("positionSide");
  const timestamp = Number(params.get("timestamp"));
  const recvWindow = Number(params.get("recvWindow"));
  const price = Number(params.get("price"));
  const quantity = Number(params.get("quantity"));
  const valid = SYMBOL_PATTERN.test(symbol)
    && (side === "BUY" || side === "SELL")
    && (positionSide === "BOTH" || positionSide === "LONG" || positionSide === "SHORT")
    && params.get("type") === "LIMIT"
    && params.get("timeInForce") === "GTX"
    && params.get("newOrderRespType") === "RESULT"
    && Number.isFinite(price) && price > 0
    && Number.isFinite(quantity) && quantity > 0
    && Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) < 60_000
    && Number.isFinite(recvWindow) && recvWindow > 0 && recvWindow <= 10_000;
  if (!valid) return Response.json({ error: "Order validation failed. Refresh the preview and try again." }, { status: 400 });

  const live = body.live === true;
  const endpoint = live ? "/fapi/v1/order" : "/fapi/v1/order/test";
  try {
    const response = await fetch(`${BINANCE_API}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-MBX-APIKEY": body.apiKey,
      },
      body: `${body.query}&signature=${body.signature}`,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload === "object" && payload && "msg" in payload ? String(payload.msg) : "Binance rejected the order.";
      return Response.json({ error: message, binanceCode: typeof payload === "object" && payload && "code" in payload ? payload.code : null }, { status: response.status });
    }
    return Response.json({ ok: true, live, order: payload }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not reach Binance. Order status is unknown; verify in Binance before retrying." }, { status: 502 });
  }
}
