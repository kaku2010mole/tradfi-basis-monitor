import { cookies } from "next/headers";
import { TRADE_COOKIE, tradeAuthConfigured, verifyTradeToken } from "../lib/tradeAuth";
import TradeLogin from "../trade/TradeLogin";
import TakerStudio from "./TakerStudio";

export const dynamic = "force-dynamic";

export default async function TakerPage() {
  const store = await cookies();
  const configured = tradeAuthConfigured();
  const authenticated = configured && await verifyTradeToken(store.get(TRADE_COOKIE)?.value);
  return authenticated
    ? <TakerStudio />
    : <TradeLogin
        configured={configured}
        title="Taker–Taker DCA"
        description="Protected Hyperliquid ↔ Binance DCA. Enter the separate execution password to view live spreads, stage paper runs, or explicitly arm mainnet orders."
        returnHref="/"
      />;
}
