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
  const [response, alerts, config] = await Promise.all([
    render("/blog"),
    readFile(new URL("../app/components/GlobalOracleAlerts.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/relativeValueAlerts.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Relative Value Monitor/);
  assert.match(config, /RELATIVE_VALUE_ALERT_THRESHOLD = 2/);
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
  const [studio, livePanel, auth] = await Promise.all([
    readFile(new URL("../app/taker/TakerStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/taker/LiveDcaPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/taker/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(studio, /PAPER \+ LIVE/);
  assert.match(studio, /now - lastQuoteAt < 5_000/);
  assert.match(livePanel, /Two IOC orders · one signed exchange action/);
  assert.match(livePanel, /I authorize two real Hyperliquid mainnet IOC orders per slice/);
  assert.ok(livePanel.includes("UNHEDGED ${filled.coin} FILL"));
  assert.match(livePanel, /tif: "Ioc"/);
  assert.match(livePanel, /orders: \[/);
  assert.doesNotMatch(livePanel, /Binance/);
  assert.match(auth, /verifyTradeToken/);
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

test("renders an address-verified X Layer Uniswap V3 pool monitor", async () => {
  const [response, route, historyRoute, recorder, registry, page] = await Promise.all([
    render("/onchain"),
    readFile(new URL("../app/api/onchain-pools/quote/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/onchain-pools/history/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-render.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/onchainPools.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/onchain/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Onchain Pool Monitor/);
  assert.match(html, /HONG KONG RWA BASIS/);
  assert.match(page, /xiaox-usdc-005-xlayer/);
  assert.match(page, /Premium & discount ranking/);
  assert.match(page, /Futu official close/);
  assert.match(page, /Add a Hong Kong pair/);
  assert.match(page, /CUSTOM_STORAGE_KEY/);
  assert.match(route, /sqrtPriceX96/);
  assert.match(route, /buyPriceBeforeSlippage/);
  assert.match(route, /sellPriceBeforeSlippage/);
  assert.match(route, /group === "hk"/);
  assert.match(route, /customPoolFromUrl/);
  assert.match(historyRoute, /ONCHAIN_BASIS_DATA_DIR/);
  assert.match(historyRoute, /stockHkd \/ usdHkd/);
  assert.match(recorder, /ONCHAIN_CAPTURE_MS = 60_000/);
  assert.match(recorder, /minute >= 10 \* 60 && minute <= 15 \* 60/);
  assert.match(page, /SERVER HISTORY/);
  assert.match(page, /retained for 90 days/);
  assert.match(registry, /0xdc7f2f41b48cd4f482d8c900ac2fa1b5ad058417/);
  assert.match(registry, /HK\.02097/);
  assert.match(registry, /HK\.00388/);
  assert.match(registry, /HK\.00700/);
  assert.match(registry, /HK\.01024/);
  assert.match(registry, /HK\.03690/);
  assert.match(registry, /HK\.09992/);
  assert.match(registry, /https:\/\/rpc\.xlayer\.tech/);
});
