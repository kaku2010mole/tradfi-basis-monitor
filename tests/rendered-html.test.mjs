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
  assert.match(relativeValue, /id: "baba-hk09988"/);
  assert.match(relativeValue, /symbol: "BABAUSDT"/);
  assert.match(relativeValue, /symbol: "HK\.09988"/);
  assert.match(relativeValue, /usdHkd: 7\.84, sharesPerAdr: 8/);
  assert.match(alerts, /RELATIVE_VALUE_SIGNAL_EVENT/);
  assert.match(alerts, /window\.setInterval\(\(\) => void pollRelative\(\), 10_000\)/);
  assert.match(alerts, /PREDICTION ERROR/);
  assert.match(alerts, /leg\.venue === "futu"/);
});

test("uses Futu history and the 1 ADR to 8 HK share mapping for Alibaba", async () => {
  const [analysis, ranking, page, futu, pusher] = await Promise.all([
    readFile(new URL("../app/api/blog/analysis/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/blog/ranking/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/blog/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/futuMarket.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/push.py", import.meta.url), "utf8"),
  ]);
  assert.match(analysis, /leg\.venue === "futu"/);
  assert.match(ranking, /futuLivePrice/);
  assert.match(page, /\/api\/blog\/futu/);
  assert.match(futu, /price \/ rate/);
  assert.match(pusher, /HK\.09988/);
});

test("normalizes Futu OpenD US references for HK auction basis", async () => {
  const [auction, quotes, pusher, adrPusher, worker] = await Promise.all([
    readFile(new URL("../app/hk-auction/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/hk-auction/quotes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/push.py", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/posley-adr-pusher.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(auction, /\/api\/hk-auction\/adr-quotes/);
  assert.doesNotMatch(auction, /beginPosleyLogin/);
  assert.match(auction, /TCEHY/);
  assert.match(auction, /XIACY/);
  assert.match(auction, /KSHTY/);
  assert.match(auction, /MPNGY/);
  assert.match(auction, /PMRTY/);
  assert.match(auction, /MMXGY/);
  assert.match(auction, /LNVGY/);
  assert.match(auction, /"HK\.00992".*hkSharesPerAdr: 20/);
  assert.match(auction, /Binance-implied ADR/);
  assert.match(auction, /FUTU ↔ \{perpVenue\}/);
  assert.match(auction, /US references live/);
  assert.match(auction, /HK\.01211.*BYDUSDT.*BYDDY.*hkSharesPerAdr: 1/);
  assert.match(auction, /ASSET_TIERS/);
  assert.match(auction, /Tier for \$\{pair\.perpSymbol\}/);
  assert.match(auction, /updateTier/);
  assert.match(auction, /tierGroups/);
  assert.match(auction, /grouped by your tags/);
  assert.match(auction, /NVDA REFERENCE · SINCE HK CLOSE/);
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
  assert.match(auction, /LITE REFERENCE · SINCE HK CLOSE/);
  assert.match(auction, /\/api\/hk-auction\/lite-reference/);
  assert.match(auction, /HK\.03986.*GIGADEVUSDT/);
  assert.match(auction, /HK\.01211.*BYDUSDT/);
  assert.match(auction, /HK\.00992.*HK0992USDT/);
  assert.match(auction, /HK\.00625.*HK0625USDT/);
  assert.match(auction, /HK\.00981.*SMICUSDT.*perpVenue: "bybit"/);
  assert.match(auction, /HK\.06181.*LAOPUUSDT.*perpVenue: "bybit"/);
  assert.match(auction, /HK\.01347.*HUAHONGUSDT.*perpVenue: "bybit"/);
  assert.match(auction, /styles\.futuVenue/);
  assert.match(auction, /styles\.binanceVenue/);
  assert.match(auction, /styles\.bybitVenue/);
  assert.match(auction, /isHkQuotedPerp\(pair\.perpSymbol\).*7\.84/);
  assert.match(auction, /1 Binance perp ↔.*HK shares/);
  assert.match(auction, /useState\("7\.84"\)/);
  assert.match(quotes, /HK\.03308.*ZHONGJIUSDT/);
  assert.match(quotes, /HK\.03986.*GIGADEVUSDT/);
  assert.match(quotes, /HK\.01211.*BYDUSDT/);
  assert.match(quotes, /HK\.00992.*HK0992USDT/);
  assert.match(quotes, /HK\.00625.*HK0625USDT/);
  assert.match(quotes, /HK\.00981.*SMICUSDT.*perpVenue: "bybit"/);
  assert.match(quotes, /HK\.06181.*LAOPUUSDT.*perpVenue: "bybit"/);
  assert.match(quotes, /HK\.01347.*HUAHONGUSDT.*perpVenue: "bybit"/);
  assert.match(quotes, /\/v5\/market\/tickers\?category=linear/);
  assert.match(quotes, /const marketTimestamp = timestamp\(payload\.time\) \?\? receivedAt/);
  assert.doesNotMatch(quotes, /marketTimestamp: timestamp\(payload\.time\).*stale: stale\(marketTimestamp/s);
  assert.match(quotes, /\^HK\\d\+USDT\$.*7\.84/);
  assert.match(pusher, /HK\.03308/);
  assert.match(pusher, /HK\.03986/);
  assert.match(pusher, /HK\.01211/);
  assert.match(pusher, /HK\.00992/);
  assert.match(pusher, /HK\.00625/);
  assert.match(pusher, /HK\.00981/);
  assert.match(pusher, /HK\.06181/);
  assert.match(pusher, /HK\.01347/);
  for (const symbol of ["TCEHY", "XIACY", "KSHTY", "MPNGY", "PMRTY", "MMXGY", "LNVGY", "BYDDY"]) {
    assert.match(adrPusher, new RegExp(symbol));
    assert.match(quotes, new RegExp(symbol));
  }
  for (const symbol of ["LITE", "NVDA"]) assert.match(pusher, new RegExp(`US\\.${symbol}`));
  assert.match(adrPusher, /ws:\/\/192\.168\.50\.112:8787\/ws/);
  assert.match(adrPusher, /snapshot: 1/);
  assert.match(worker, /mergeBySymbol/);
  assert.match(pusher, /def subscribe_available/);
  assert.match(pusher, /skipped \{', '\.join\(skipped\)\}/);
  assert.match(pusher, /extended_time=symbol\.startswith\("US\."\)/);
  assert.match(worker, /TCEHY\|XIACY\|KSHTY\|MPNGY\|PMRTY\|MMXGY\|LNVGY\|BYDDY\|LITE\|NVDA/);
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

test("keeps a selectable 21:00–04:00 ADR versus perp basis tape on HK Auction Basis", async () => {
  const [auction, panel, route] = await Promise.all([
    readFile(new URL("../app/hk-auction/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/hk-auction/AdrPerpNightPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/hk-auction/adr-basis-history/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(auction, /<AdrPerpNightPanel pairs=\{nightBasisPairs\}/);
  assert.match(panel, /Overnight basis tape/);
  assert.match(panel, /21:00–04:00 HKT/);
  assert.match(panel, /LAST COMPLETED NIGHT/);
  assert.match(panel, /ADR premium \/ discount to Binance-implied ADR/);
  assert.match(panel, /window\.setInterval\(\(\) => void load\(\), 30_000\)/);
  assert.match(route, /NIGHT_START_HOUR = 21/);
  assert.match(route, /NIGHT_END_HOUR = 4/);
  assert.match(route, /openDHistory/);
  assert.match(route, /Futu OpenD live/);
  assert.doesNotMatch(route, /posleyAdrSnapshot|Posley ADR live/);
  assert.match(route, /includePrePost=true/);
  assert.match(route, /interval: "1m"/);
  assert.match(route, /hkSharesPerAdr \/ sharesPerContract/);
  assert.match(route, /offset < 7/);
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
  const [response, page, markets, accountFunding, switcher] = await Promise.all([
    render("/polymarket"),
    readFile(new URL("../app/polymarket/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/polymarket-perps/markets/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/hyperliquid/user-funding/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  const renderedPage = await response.text();
  assert.match(renderedPage, /Funding &amp; Basis/);
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
  assert.match(page, /Cumulative funding income/);
  assert.match(page, /0xa590a393CC3e1776a47f32fD99ef5fc7c464a243/i);
  assert.match(page, /Settlement history/);
  assert.match(page, /window\.setInterval\(load, 60_000\)/);
  assert.match(page, /Daily funding income/);
  assert.match(page, /Weekly funding income/);
  assert.match(page, /TODAY · HKT/);
  assert.match(page, /THIS WEEK · HKT/);
  assert.match(page, /startOfHktWeek/);
  assert.match(page, /NEXT 1H ESTIMATE/);
  assert.match(page, /allDexsClearinghouseState/);
  assert.match(page, /-size \* oracle \* fundingRate/);
  assert.match(page, /PERIOD NET · REBASED TO \$0/);
  assert.match(page, /baselineTime/);
  assert.match(accountFunding, /type: "userFunding"/);
  assert.match(accountFunding, /PAGE_SIZE = 500/);
  assert.match(accountFunding, /cursor = lastTime > previousLast \? lastTime : lastTime \+ 1/);
  assert.match(accountFunding, /process\.env\.SITE_PASSWORD/);
  assert.match(accountFunding, /cumulativeUsdc/);
  assert.match(accountFunding, /__HL_FUNDING_RECORDS__/);
  assert.doesNotMatch(renderedPage, /Lighter funding income/);
  assert.doesNotMatch(page, /LighterFundingPanel|api\/lighter|LIGHTER ACCOUNT FUNDING/);
  await assert.rejects(readFile(new URL("../app/api/lighter/user-funding/route.ts", import.meta.url), "utf8"), /ENOENT/);
  assert.match(switcher, /Poly ↔ HL ↔ Binance funding and price spreads/);
});

test("accepts every Hyperliquid DEX namespace and keeps SHEIN in the normal Oracle ranking", async () => {
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
  assert.match(alerts, /\["para:OTHERS"[\s\S]*"xyz:SHEIN"\]/);
  assert.match(quotes, /\[A-Z\]\[A-Z0-9_-\]\{1,15\}:/);
  assert.match(quotes, /metaAndAssetCtxs", dex/);
  assert.match(page, /const SHEIN_SYMBOL = "xyz:SHEIN"/);
  assert.match(page, /const USD_HKD_RATE = 7\.84/);
  assert.match(page, /normalizeHyperliquidSymbol/);
  assert.match(page, /isHyperliquidSymbol/);
  assert.match(page, /mkts:TLT, para:OTHERS or xyz:SHEIN/);
  assert.match(page, /wss:\/\/api\.hyperliquid\.xyz\/ws/);
  assert.match(page, /for \(const symbol of hyperliquidSymbols\)/);
  assert.match(page, /type: "l2Book", coin: symbol/);
  assert.match(page, /type: "activeAssetCtx", coin: symbol/);
  assert.doesNotMatch(page, /TEMPORARY · PINNED|sheinSpotlight|applySheinStreamPatch/);
  assert.match(page, /quote\.apiSymbol === SHEIN_SYMBOL/);
  assert.match(page, /SHEIN MARK · HKD/);
  assert.match(page, /fixed 1 USD = HK\$7\.84/);
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

test("removes the Oracle orderbook recorder, heatmap, APIs and legacy disk data", async () => {
  const [page, recorder] = await Promise.all([
    readFile(new URL("../app/oracle/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-render.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /ParaDepthHeatmap|Liquidity heatmap|orderbook-history/);
  await assert.rejects(readFile(new URL("../app/oracle/ParaDepthHeatmap.tsx", import.meta.url), "utf8"));
  await assert.rejects(readFile(new URL("../app/api/oracle-monitor/orderbook/route.ts", import.meta.url), "utf8"));
  await assert.rejects(readFile(new URL("../app/api/oracle-monitor/orderbook-history/route.ts", import.meta.url), "utf8"));
  assert.match(recorder, /legacyOrderbookDirectories/);
  assert.doesNotMatch(recorder, /recorderLoop|appendFile|para-recorder/);
});

test("removes the SKHX close desk and its unused background recorder", async () => {
  const [switcher, globals, recorder] = await Promise.all([
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-render.mjs", import.meta.url), "utf8"),
  ]);
  await assert.rejects(readFile(new URL("../app/skhx/page.tsx", import.meta.url), "utf8"));
  await assert.rejects(readFile(new URL("../app/api/skhx/route.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(switcher, /href="\/skhx"|SKHX close probability/);
  assert.doesNotMatch(globals, /skhx\/skhx\.css/);
  assert.doesNotMatch(recorder, /HYPERTRACKER|liquidationRecorderLoop|captureLiquidations/);
});

test("scans OKX stock spot books against executable Binance perpetual prices", async () => {
  const [response, page, monitor, route, switcher, recorder] = await Promise.all([
    render("/onchain"),
    readFile(new URL("../app/onchain/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/XstockPerpMonitor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/xstock-perp/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-render.mjs", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /xStock–Perp/);
  assert.match(page, /centralized-exchange xStock spot/);
  assert.match(monitor, /OKX SPOT · BINANCE FUTURES/);
  assert.match(monitor, /MAX BINANCE 24H VOLUME/);
  assert.match(monitor, /Add exchange pair/);
  assert.match(route, /instCategory === "3"/);
  assert.match(route, /XSHEIN-USDT/);
  assert.match(route, /XPOPMART-USDT/);
  assert.match(route, /XXIAOMI-USDT.*HK1810USDT.*7\.84/s);
  assert.match(route, /TRADIFI_PERPETUAL/);
  assert.match(route, /exchangeInfo/);
  assert.match(route, /scale < 0\.5 \|\| scale > 2/);
  assert.match(switcher, /href="\/onchain"/);
  assert.doesNotMatch(recorder, /onchainRecorderLoop|onchain-pools/);
});

test("loads route-scoped styles for the HSI and Shanghai dashboards", async () => {
  const [hsiLayout, shanghaiLayout] = await Promise.all([
    readFile(new URL("../app/hsi/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/shanghai/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(hsiLayout, /import\s+["']\.\/hsi\.css["']/);
  assert.match(shanghaiLayout, /import\s+["']\.\.\/hsi\/hsi\.css["']/);
});

test("FX-adjusts SKHX to CSOP 2L prediction error everywhere", async () => {
  const [model, analysis, ranking, page, alerts, fx] = await Promise.all([
    readFile(new URL("../app/lib/relativeValue.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/blog/analysis/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/blog/ranking/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/blog/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/GlobalOracleAlerts.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/fxMarket.ts", import.meta.url), "utf8"),
  ]);
  assert.match(model, /predictorFx: \{ symbol: "KRW=X"/);
  assert.equal((model.match(/predictorFx: \{ symbol: "KRW=X"/g) ?? []).length, 2, "only the two Korean single-stock models should load USD\/KRW");
  assert.match(model, /asset1LogReturn \+ .*Math\.log\(fxValue \/ firstFx\)/s);
  assert.match(analysis, /usdKrwSeries/);
  assert.match(ranking, /\(currentFx \/ baseFx\)/);
  assert.match(page, /fxSymbol: current\.relationship\.predictorFx\?\.symbol/);
  assert.match(alerts, /currentFx \/ snapshot\.baseFx!/);
  assert.match(fx, /FX\.USDKRW/);
  assert.match(fx, /Fresh Posley IBKR USD\/KRW is unavailable/);
  assert.match(model, /1 \+ model\.beta \* \(predictorGrossReturn - 1\)/);
  assert.match(model, /asset2TheoreticalPrice: first\.asset2 \* theoreticalGrossReturn/);
  assert.match(page, /USD\/KRW AT ANCHOR/);
  assert.match(page, /USD\/KRW NOW/);
  assert.match(page, /FX CHANGE USED/);
  assert.match(page, /function FxChart/);
  assert.match(page, /USD\/KRWₜ \/ USD\/KRW₀/);
  assert.match(ranking, /model\.beta \* \(predictorGross - 1\)/);
  assert.match(alerts, /snapshot\.beta \* \(predictorGross - 1\)/);
});
