import { cookies } from "next/headers";
import { TRADE_COOKIE, tradeAuthConfigured, verifyTradeToken } from "../lib/tradeAuth";
import TradeLogin from "../trade/TradeLogin";
import PolySniper from "./PolySniper";

export const dynamic = "force-dynamic";

export default async function PolySniperPage() {
  const store = await cookies();
  const configured = tradeAuthConfigured();
  const authenticated = configured && await verifyTradeToken(store.get(TRADE_COOKIE)?.value);
  return authenticated ? <PolySniper /> : <TradeLogin configured={configured} title="Polymarket Sniper" description="Protected live CLOB execution. Enter the execution password to open the continuous market watcher and one-shot live order controls." returnHref="/polymarket" />;
}
