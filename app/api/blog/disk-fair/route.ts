import { getDiskCashModel } from "../../../lib/diskCashMarket";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getDiskCashModel(), { headers: { "Cache-Control": "no-store" } });
}
