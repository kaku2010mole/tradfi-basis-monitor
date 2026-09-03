import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the TradFi dashboard shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>TradFi Basis Monitor<\/title>/i);
  assert.match(html, /Set the anchor\. Then watch the drift\./);
  assert.match(html, /href="\/taker"/);
  assert.match(html, /Hyperliquid Taker–Taker/);
  assert.match(html, /href="\/blog"/);
  assert.doesNotMatch(html, /href="\/trade"/);
});

test("restores the Relative Value Monitor and its global prediction-error broadcast", async () => {
  const [response, alerts, config, relativeValue] = await Promise.all([
    render("/blog"),
    readFile(new URL("../app/components/GlobalOracleAlerts.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/relativeValueAlerts.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/relativeValue.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Relative Value Monitor/);
  assert.match(config, /RELATIVE_VALUE_ALERT_THRESHOLD = 2/);
  assert.match(relativeValue, /id: "kodex200-kr200"/);
  assert.match(relativeValue, /symbol: "KODEX200USDT"/);
  assert.match(relativeValue, /symbol: "xyz:KR200"/);
  assert.match(alerts, /RELATIVE_VALUE_SIGNAL_EVENT/);
  assert.match(alerts, /window\.setInterval\(\(\) => void pollRelative\(\), 10_000\)/);
  assert.match(alerts, /PREDICTION ERROR/);
});

test("discovers and normalizes Posley ADR streams for HK auction basis", async () => {
  const [auction, quotes, pusher] = await Promise.all([
    readFile(new URL("../app/hk-auction/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/hk-auction/quotes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/push.py", import.meta.url), "utf8"),
  ]);
  assert.match(auction, /\/api\/hk-auction\/adr-quotes/);
  assert.doesNotMatch(auction, /beginPosleyLogin/);
  assert.match(auction, /TCEHY/);
  assert.match(auction, /XIACY/);
  assert.match(auction, /KSHTY/);
  assert.match(auction, /MPNGY/);
  assert.match(auction, /PMRTY/);
  assert.match(auction, /MMXGY/);
  assert.match(auction, /Binance-implied ADR/);
  assert.match(auction, /FUTU ↔ BINANCE/);
  assert.match(auction, /POSLEY ADR ↔ BINANCE/);
  assert.match(auction, /hktHour >= 21 \|\| hktHour < 6/);
  assert.match(auction, /night ranking by \|ADR\/Binance basis\|/);
  assert.doesNotMatch(auction, /perpSymbol: "XIAOMIUSDT"/);
  assert.match(auction, /withoutRemovedPairs/);
  assert.doesNotMatch(auction, /className=\{styles\.tradeSignal\}/);
  assert.match(auction, /SHORT \$\{pair\.adrSymbol\} → LONG \$\{pair\.perpSymbol\}/);
  assert.ok(auction.includes("const perpsPerAdr = adrRatio !== null ? adrRatio / pair.sharesPerContract : null;"));
  assert.doesNotMatch(auction, /SHORT \$\{pair\.adrSymbol\} \/ LONG FUTU/);
  assert.match(auction, /ADR_BENCHMARK_MAX_AGE_MS/);
  assert.match(auction, /HK\.03308.*ZHONGJIUSDT/);
  assert.match(auction, /HK\.03986.*GIGADEVUSDT/);
  assert.match(quotes, /HK\.03308.*ZHONGJIUSDT/);
  assert.match(quotes, /HK\.03986.*GIGADEVUSDT/);
  assert.match(pusher, /HK\.03308/);
  assert.match(pusher, /HK\.03986/);
  assert.match(pusher, /LIVE_BOOK_STATES = \{"AUCTION", "ACTION", "WAITING_OPEN", "MORNING", "AFTERNOON"\}/);
  assert.match(pusher, /book_required or last is None/);
  assert.match(quotes, /useOfficialLast/);
  assert.match(quotes, /getBinanceQuotes/);
  assert.match(quotes, /\/fapi\/v1\/ticker\/bookTicker"/);
  assert.match(quotes, /\/fapi\/v1\/premiumIndex"/);
  assert.match(quotes, /__BINANCE_BATCH_PROMISE__/);
  assert.match(quotes, /BINANCE_BATCH_CACHE_MS/);
  assert.doesNotMatch(quotes, /bookTicker\?symbol=/);
  assert.doesNotMatch(quotes, /premiumIndex\?symbol=/);
});

test("keeps the Posley refresh token on the server", async () => {
  const [auction, proxy] = await Promise.all([
    readFile(new URL("../app/hk-auction/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/posleyAdr.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(auction, /POSLEY_REFRESH_TOKEN/);
  assert.match(proxy, /process\.env\.POSLEY_REFRESH_TOKEN/);
  assert.doesNotMatch(proxy, /refreshToken[^\n]*return/);
});

test("does not proxy the Posley stream directory without a Cognito token", async () => {
  const response = await render("/api/hk-auction/adr-streams");
  assert.equal(response.status, 401);
});

test("keeps live taker execution explicitly gated", async () => {
  const [studio, livePanel, quoteRoute, auth] = await Promise.all([
    readFile(new URL("../app/taker/TakerStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/taker/LiveDcaPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/taker/quote/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/taker/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(studio, /PAPER \+ LIVE/);
  assert.match(studio, /now - lastQuoteAt < 5_000/);
  assert.match(livePanel, /Perp \/ spot ready · two IOC orders · one signed action/);
  assert.match(livePanel, /I authorize two real Hyperliquid mainnet IOC orders per slice/);
  assert.ok(livePanel.includes("UNHEDGED ${filled.coin} FILL"));
  assert.match(livePanel, /tif: "Ioc"/);
  assert.match(livePanel, /orders: \[/);
  assert.match(livePanel, /10_000 \+ Number\(market\.index\)/);
  assert.match(livePanel, /formatPrice\(paddedA, assetA\.szDecimals, assetA\.marketType\)/);
  assert.match(quoteRoute, /type: "spotMeta"/);
  assert.match(quoteRoute, /only USDC-quoted spot markets/);
  assert.match(studio, /Leg A market type/);
  assert.match(studio, /typeA: marketTypeA/);
  assert.doesNotMatch(livePanel, /Binance/);
  assert.match(auth, /verifyTradeToken/);
});

test("compares Polymarket, Binance and Hyperliquid funding and price spreads in one view", async () => {
  const [response, page, markets, switcher] = await Promise.all([
    render("/polymarket"),
    readFile(new URL("../app/polymarket/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/polymarket-perps/markets/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Funding &amp; Basis/);
  assert.match(page, /POLY ↔ \{venue\.toUpperCase\(\)\}/);
  assert.match(page, /FUNDING SPREAD · 1H/);
  assert.match(page, /PRICE SPREAD/);
  assert.match(page, /SHORT POLY \/ LONG \$\{venueShort\}/);
  assert.match(page, /largestAbsoluteFundingSpread/);
  assert.match(page, /activeAssetCtx/);
  assert.match(page, /markPrice@1s/);
  assert.match(markets, /\/fapi\/v1\/premiumIndex/);
  assert.match(markets, /\/fapi\/v1\/fundingInfo/);
  assert.match(markets, /binanceFundingRate \/ binanceFundingHours/);
  assert.match(markets, /fundingRate: finite\(contexts\[index\]\?\.funding\)/);
  assert.match(switcher, /Poly ↔ HL ↔ Binance funding and price spreads/);
});

test("removes the Polymarket sniper and pins a real-time SHEIN HKD monitor", async () => {
  const [response, page, quotes, alerts, switcher] = await Promise.all([
    render("/oracle"),
    readFile(new URL("../app/oracle/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/oracle-monitor/quotes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/oracleAlerts.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Oracle Monitor/);
  assert.doesNotMatch(switcher, /poly-sniper|Polymarket Sniper/);
  assert.match(alerts, /"xyz:SHEIN"/);
  assert.match(quotes, /\(\?:para\|xyz\)/);
  assert.match(quotes, /metaAndAssetCtxs", dex/);
  assert.match(page, /const SHEIN_SYMBOL = "xyz:SHEIN"/);
  assert.match(page, /const USD_HKD_RATE = 7\.84/);
  assert.match(page, /wss:\/\/api\.hyperliquid\.xyz\/ws/);
  assert.match(page, /type: "l2Book", coin: SHEIN_SYMBOL/);
  assert.match(page, /type: "activeAssetCtx", coin: SHEIN_SYMBOL/);
  assert.match(page, /TEMPORARY · PINNED/);
  assert.match(page, /1 USD = HK\$7\.84/);
});

test("retries the Futu LaunchAgent registration after replacing the relay", async () => {
  const installer = await readFile(new URL("../services/futu-pusher/Install Futu Relay.command", import.meta.url), "utf8");
  assert.match(installer, /for attempt in 1 2 3 4 5/);
  assert.match(installer, /launchctl bootstrap/);
  assert.match(installer, /exec \"\$runtime_dir\/run-macos\.sh\"/);
});

test("ships a lightweight Futu symbol updater", async () => {
  const [installer, updater, pusher] = await Promise.all([
    readFile(new URL("../services/futu-pusher/Install Futu Relay.command", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/Update Futu Symbols.command", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/push.py", import.meta.url), "utf8"),
  ]);
  assert.match(installer, /Reuse it on symbol/);
  assert.match(updater, /launchctl kickstart -k/);
  assert.match(pusher, /HK\.00388/);
  assert.match(pusher, /HK\.02097/);
});

test("uses executable best bid or ask for live Oracle Monitor deviations", async () => {
  const [page, quotes, alerts] = await Promise.all([
    readFile(new URL("../app/oracle/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/oracle-monitor/quotes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/GlobalOracleAlerts.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const sellDeviation = \(bid \/ oracle - 1\) \* 100/);
  assert.match(page, /executableSide: "NONE" as const/);
  assert.match(page, /SELL · BEST BID/);
  assert.match(page, /BUY · BEST ASK/);
  assert.doesNotMatch(page, /const live = \(bid \+ ask\) \/ 2/);
  assert.match(quotes, /const sellable = sellDeviation > 0/);
  assert.match(quotes, /"NONE" as const/);
  assert.doesNotMatch(quotes, /const live = \(bid \+ ask\) \/ 2/);
  assert.match(alerts, /const deviation = sellDeviation > 0 && \(buyDeviation >= 0 \|\| sellDeviation >= Math\.abs\(buyDeviation\)\) \? sellDeviation : buyDeviation < 0 \? buyDeviation : 0/);
  assert.match(alerts, /executable best bid\/ask/);
});

test("removes the liquidation map and uses visible-window depth bands", async () => {
  const [page, heatmap] = await Promise.all([
    readFile(new URL("../app/oracle/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/oracle/ParaDepthHeatmap.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /LiquidationPriceMap/);
  assert.match(heatmap, /DEPTH_PERCENTILES = \[\.25, \.5, \.75, \.9\]/);
  assert.match(heatmap, /Resting USD intensity/);
  assert.match(heatmap, /five high-contrast light levels/);
  assert.match(heatmap, /depthBucket\(cell\.usd, depthScale\)/);
  assert.match(heatmap, /const depthColors = \["#102c40"/);
  assert.match(heatmap, /One base colour · five high-contrast light levels/);
});

test("ships the SKHX next-close probability desk and removes onchain pools", async () => {
  const [response, page, route, switcher, recorder] = await Promise.all([
    render("/skhx"),
    readFile(new URL("../app/skhx/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/skhx/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-render.mjs", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /SKHX Probability Desk/);
  assert.match(page, /NEXT DAILY CLOSE/);
  assert.match(page, /95% parameter interval/);
  assert.match(route, /candleSnapshot/);
  assert.match(route, /metaAndAssetCtxs/);
  assert.match(switcher, /href="\/skhx"/);
  assert.doesNotMatch(switcher, /onchain|Onchain pools/i);
  assert.doesNotMatch(recorder, /onchain/i);
});

test("ships the HSI close-probability desk with horizon evidence and a Futu live feed", async () => {
  const [response, page, route, switcher, pusher, worker] = await Promise.all([
    render("/hsi"),
    readFile(new URL("../app/hsi/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/hsi/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/push.py", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Hang Seng Probability Desk/);
  assert.match(page, /Results by time to close/);
  assert.match(page, /FUTURES\|16:10/);
  assert.match(page, /INDEX\|15:50/);
  assert.match(route, /Previous official cash close/);
  assert.match(route, /findFuturesAnchor/);
  assert.match(switcher, /href="\/hsi"/);
  assert.match(pusher, /HK\.800000,HK\.HSImain/);
  assert.match(worker, /HSImain/);
});

test("ships a multi-pair grid lab with live SK and Binance gold backtests", async () => {
  const [response, page, route, strategy, switcher] = await Promise.all([
    render("/sk-grid"),
    readFile(new URL("../app/sk-grid/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/sk-grid/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/sk-grid/strategy.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Trade the relationship/);
  assert.match(page, /Apply recommended/);
  assert.match(page, /Training-ranked alternatives/);
  assert.match(page, /Include historical hourly funding/);
  assert.match(route, /"skhx-skhy"/);
  assert.match(route, /"xau-xaut"/);
  assert.match(route, /XAUTUSDT/);
  assert.match(route, /PAXGUSDT/);
  assert.doesNotMatch(route, /QQQUSDT|SPYUSDT/);
  assert.match(route, /conversionRatio: 10/);
  assert.match(page, /Sell \$\{labelY\} \/ buy \$\{labelX\}/);
  assert.match(page, /conversion-adjusted/);
  assert.match(page, /DYNAMIC PREMIUM BAND/);
  assert.match(page, /Most-travelled levels/);
  assert.match(page, /1 ADS = 5 Taiwan shares/);
  assert.match(strategy, /Rolling log-price OLS residual|computeSignals/);
  assert.match(strategy, /splitIndex/);
  assert.match(strategy, /slippageBps/);
  assert.match(switcher, /Pair Grid Lab/);
});
