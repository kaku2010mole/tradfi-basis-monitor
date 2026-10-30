import { japanEstimateState } from "../../lib/japanEstimateMarket";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") && header.length < 16_384 ? header.slice(7) : undefined;
  try { return Response.json(await japanEstimateState(token), { headers: { "Cache-Control": "no-store, max-age=0" } }); }
  catch { return Response.json({ error: "估价面板暂时无法更新；请保留最后报价时间。" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
