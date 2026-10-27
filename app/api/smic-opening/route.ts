import { smicOpeningState } from "../../lib/smicOpeningMarket";
export const dynamic="force-dynamic";
export async function GET() {
  try {return Response.json(await smicOpeningState(),{headers:{"Cache-Control":"no-store, max-age=0"}});}
  catch {return Response.json({error:"Opening outlook is temporarily unavailable."},{status:503,headers:{"Cache-Control":"no-store"}});}
}
