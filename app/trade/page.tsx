import { cookies } from "next/headers";
import RelativeValueBlog from "../blog/page";
import { TRADE_COOKIE, tradeAuthConfigured, verifyTradeToken } from "../lib/tradeAuth";
import TradeLogin from "./TradeLogin";

export const dynamic = "force-dynamic";

export default async function TradePage() {
  const store = await cookies();
  const configured = tradeAuthConfigured();
  const authenticated = configured && await verifyTradeToken(store.get(TRADE_COOKIE)?.value);
  return authenticated ? <RelativeValueBlog trading /> : <TradeLogin configured={configured} />;
}
