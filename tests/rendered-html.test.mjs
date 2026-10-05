import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

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
  assert.doesNotMatch(html, /href="\/taker"/);
  assert.doesNotMatch(html, /Hyperliquid Taker–Taker/);
  assert.match(html, /href="\/blog"/);
  assert.doesNotMatch(html, /href="\/trade"/);
});

test("adds a daily OpenD-backed Treasury futures yield estimator", async () => {
  const [response, estimator, route, pusher] = await Promise.all([
    render(),
    readFile(new URL("../app/components/TreasuryYieldEstimator.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/treasury-yields/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/push.py", import.meta.url), "utf8"),
  ]);
  assert.match(await response.text(), /美债期货收益率估算/);
  assert.match(estimator, /\/api\/treasury-yields/);
  assert.match(estimator, /30 \* 60_000/);
  assert.match(route, /daily_treasury_yield_curve/);
  assert.match(route, /Futu OpenD previous close/);
  assert.match(route, /OpenD with public daily-close fallback/);
  assert.match(route, /query1\.finance\.yahoo\.com/);
  for (const symbol of ["ZT", "ZF", "ZN", "ZB"]) {
    assert.match(route, new RegExp(`US\\.${symbol}main`));
    assert.match(pusher, new RegExp(`US\\.${symbol}main`));
  }
});

test("scans Binance and Bitget TradFi stock and ETF contracts into an English dividend calendar", async () => {
  const [response, page, route, switcher] = await Promise.all([
    render("/dividends"),
    readFile(new URL("../app/dividends/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dividend-calendar/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Dividend Calendar/);
  assert.match(route, /contractType === "TRADIFI_PERPETUAL"/);
  assert.match(route, /isRwa === "YES"/);
  assert.match(route, /api\.bitget\.com\/api\/v2\/mix\/market/);
  assert.match(route, /instrument\.symbol === "STRCUSDT"/);
  assert.match(route, /12560603887627/);
  assert.match(route, /api\.nasdaq\.com\/api\/calendar\/dividends/);
  assert.match(route, /dividend adjustment process/i);
  assert.match(route, /amount \/ markPrice \* 100/);
  assert.match(page, /MONTHLY EX-DIVIDEND VIEW/);
  assert.match(page, /BINANCE \+ BITGET TRADFI CORPORATE ACTIONS/);
  assert.match(page, /Stocks and ETFs included/);
  assert.match(page, /Dividend treatment/);
  assert.match(page, /No special dividend settlement/);
  assert.match(page, /aria-expanded=\{expanded\}/);
  assert.match(page, /Show less/);
  assert.match(switcher, /href="\/dividends"/);
});

test("adds exact Korean and Japanese stock cross-venue basis rows to Oracle Monitor", async () => {
  const [page, component, route, posley, officePusher, worker] = await Promise.all([
    readFile(new URL("../app/oracle/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/KoreanPerpMonitor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/oracle-monitor/korean-bitget/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/posleyAdr.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/posley-adr-pusher.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<KoreanPerpMonitor/);
  assert.match(component, /Korean &amp; Japanese stock cross-venue basis/);
  assert.match(component, /KRX \$\{payload\.sessions\.KRX\} · TSE \$\{payload\.sessions\.TSE\}/);
  assert.match(component, /Last cash price/);
  assert.match(component, /FX index fallback is used for indicative basis/);
  assert.match(component, /INDICATIVE/);
  assert.match(component, /Connect Posley/);
  assert.match(component, /equity_monitor_id_token/);
  assert.doesNotMatch(component, /005935/);
  for (const code of ["034020", "035420", "042700", "066570", "454910"]) assert.match(route, new RegExp(code));
  for (const code of ["285A", "5802", "6758", "6857", "6920", "7203", "8035", "8306", "9984"]) assert.match(route, new RegExp(`code: "${code}"`));
  assert.doesNotMatch(route, /005935/);
  assert.match(route, /DOOSENERUSDT/);
  assert.match(route, /DOOSBOTUSDT/);
  assert.match(route, /binanceSymbol: "HANMIUSDT"/);
  assert.match(route, /bitgetSymbol: null, binanceSymbol: "HANMIUSDT"/);
  assert.match(route, /equitySpreads/);
  assert.match(posley, /FX:USD:KRW/);
  assert.match(posley, /FX:USD:JPY/);
  assert.match(officePusher, /STK:\$\{code\}:TSEJ:JPY/);
  assert.match(officePusher, /FX:USD:JPY/);
  assert.match(officePusher, /relay silent for 90s/);
  assert.match(officePusher, /specific_data/);
  assert.match(officePusher, /if \(stale\) return null/);
  assert.match(route, /quote\.symbol\?\.startsWith\("TSE\."\)/);
  assert.match(route, /quote\.symbol === "FX\.USDJPY"/);
  assert.match(route, /DISPLAY_MAX_AGE_MS/);
  assert.match(route, /marketSession/);
  assert.match(route, /"PRE-MARKET"/);
  assert.match(route, /"AFTER-HOURS"/);
  assert.match(route, /14 \* 60 \+ 40\) return "AFTER-HOURS OPENING"/);
  assert.match(route, /cashSessionActive = sessions\.KRX === "REGULAR" \|\| sessions\.KRX === "AFTER-HOURS"/);
  assert.match(component, /row\.market === "KRX" && row\.session === "AFTER-HOURS"/);
  assert.match(component, /AFTER-HOURS BBO/);
  assert.match(route, /"OPENING AUCTION"/);
  assert.match(route, /USDJPYUSDT/);
  assert.match(route, /indexPrice/);
  assert.match(route, /cashLast: positive\(cash\?\.last\)/);
  assert.match(route, /equityBasis/);
  assert.match(worker, /TSE/);
  assert.match(worker, /285A/);
  assert.match(route, /code: "7203"[^\n]*sharesPerPerp: 10/);
  assert.match(route, /fresh\(yenFx\?\.timestamp\)/);
  assert.match(posley, /saved Posley login has expired/);
});

test("last-only relay heartbeats cannot erase or refresh a recent executable book", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("heartbeat-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const credential = "test-futu-push-token";
  const environment = { FUTU_PUSH_TOKEN: credential };
  const context = { waitUntil() {}, passThroughOnException() {} };
  const priorSnapshot = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const bookTimestamp = Date.now() - 3_000;
  const book = { symbol: "KRX.035420", bid: 192100, ask: 192200, bidSize: 598, askSize: 362, last: 192100, marketTimestamp: bookTimestamp };
  const send = (quote) => worker.fetch(new Request("http://localhost/api/hk-auction/ingest", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ generatedAt: Date.now(), quotes: [quote] }),
  }), environment, context);
  try {
    delete globalThis.__FUTU_PUSH_SNAPSHOT__;
    assert.equal((await send(book)).status, 202);
    assert.equal((await send({ ...book, bid: null, ask: null, last: 192200 })).status, 202);
    const merged = globalThis.__FUTU_PUSH_SNAPSHOT__?.payload.quotes.find((quote) => quote.symbol === book.symbol);
    assert.equal(merged?.bid, book.bid);
    assert.equal(merged?.ask, book.ask);
    assert.equal(merged?.last, 192200);
    assert.equal(merged?.marketTimestamp, bookTimestamp);
    assert.equal((await send({ ...book, bid: 192300, ask: 192400, marketTimestamp: Date.now() })).status, 202);
    const refreshed = globalThis.__FUTU_PUSH_SNAPSHOT__?.payload.quotes.find((quote) => quote.symbol === book.symbol);
    assert.equal(refreshed?.bid, 192300);
    const expiredBook = { ...book, marketTimestamp: Date.now() - 70_000 };
    assert.equal((await send(expiredBook)).status, 202);
    assert.equal((await send({ ...expiredBook, bid: null, ask: null, marketTimestamp: Date.now() })).status, 202);
    const expired = globalThis.__FUTU_PUSH_SNAPSHOT__?.payload.quotes.find((quote) => quote.symbol === book.symbol);
    assert.equal(expired?.bid, null);
  } finally {
    if (priorSnapshot) globalThis.__FUTU_PUSH_SNAPSHOT__ = priorSnapshot;
    else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  }
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
  const [auction, quotes, history, pusher, adrPusher, worker] = await Promise.all([
    readFile(new URL("../app/hk-auction/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/hk-auction/quotes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/hk-auction/history/route.ts", import.meta.url), "utf8"),
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
  assert.match(auction, /US references \{freshReferences\.length\}/);
  assert.match(auction, /const adrActionable = adrBasisPct !== null && adrFresh && adrBid !== null && adrAsk !== null/);
  assert.match(auction, /INDICATIVE ONLY/);
  assert.doesNotMatch(quotes, /delayedAdrBenchmarks/);
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
  assert.match(auction, /HK\.09999.*NETEASEUSDT.*perpVenue: "bitget"/);
  assert.match(auction, /hk-auction-pairs-v7/);
  assert.match(auction, /styles\.bitgetVenue/);
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
  assert.match(quotes, /HK\.09999.*NETEASEUSDT.*perpVenue: "bitget"/);
  assert.match(quotes, /getBitgetQuotes/);
  assert.match(quotes, /api\/v2\/mix\/market\/tickers\?productType=usdt-futures/);
  assert.match(history, /getBitgetKlines/);
  assert.match(history, /api\/v2\/mix\/market\/candles/);
  assert.match(pusher, /HK\.09999/);
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

test("removed execution and account income endpoints are unavailable", async () => {
  for (const path of ["/taker", "/api/taker/quote", "/api/trade-auth", "/api/hyperliquid/user-funding"]) {
    assert.equal((await render(path)).status, 404, path);
  }
});

test("compares Polymarket, Binance and Hyperliquid funding and price spreads in one view", async () => {
  const [response, page, markets, switcher] = await Promise.all([
    render("/polymarket"),
    readFile(new URL("../app/polymarket/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/polymarket-perps/markets/route.ts", import.meta.url), "utf8"),
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
  assert.doesNotMatch(renderedPage, /Cumulative funding income|NEXT 1H ESTIMATE|Settlement history/);
  assert.doesNotMatch(page, /AccountFundingPanel|allDexsClearinghouseState|api\/hyperliquid\/user-funding/);
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
  assert.match(updater, /dirname -- "\$0"/);
  assert.doesNotMatch(updater, /2026-07-30\/ban/);
  assert.match(pusher, /HK\.00388/);
  assert.match(pusher, /HK\.02097/);
  assert.match(pusher, /HK\.09999/);
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

test("removes the HSI, Shanghai and xStock dashboards and their navigation labels", async () => {
  const switcher = await readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(switcher, /href="\/(?:hsi|shanghai|onchain)"|HSI close probability|Shanghai close probability|xStock–Perp/);
  for (const path of ["/hsi", "/shanghai", "/onchain", "/api/hsi", "/api/shanghai", "/api/xstock-perp", "/hsi-models.json", "/shanghai-models.json"]) {
    const response = await render(path);
    assert.equal(response.status, 404, `${path} should no longer be available`);
  }
  const oracle = await render("/oracle");
  assert.doesNotMatch(await oracle.text(), /xStock ↔ Perp/);
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


test("keeps numeric basis through closed, pre-market and stale cash quotes", async () => {
  const source = await readFile(new URL("../app/lib/equityBasis.ts", import.meta.url), "utf8");
  const { equityBasis, equitySpreads } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
  const cash = { bid: 19000, ask: 19200, last: 19120 };
  const fx = { bid: 156, ask: 157 };
  for (const session of ["CLOSED", "PRE-MARKET", "OPENING AUCTION", "LUNCH", "AFTER-HOURS OPENING"]) {
    const basis = equityBasis(cash, fx, 1, true);
    const spreads = equitySpreads(basis.cashBidUsd, basis.cashAskUsd, { bid: 122.22, ask: 122.28 });
    assert.equal(basis.cashBidUsd, 19120 / 157, session);
    assert.equal(basis.cashAskUsd, 19120 / 156, session);
    assert.ok(Number.isFinite(spreads.buyKoreaSellPerp), session);
    assert.ok(Number.isFinite(spreads.buyPerpSellKorea), session);
  }
  const live = equityBasis(cash, fx);
  assert.equal(live.cashBidUsd, 19000 / 157);
  assert.equal(live.cashAskUsd, 19200 / 156);
  const reference = equityBasis({ last: 3000 }, { last: 150 }, 10, true);
  assert.equal(reference.cashBidUsd, 200); // Toyota: ten ordinary shares per ADS.
  assert.equal(reference.cashAskUsd, 200);
  assert.equal(reference.usesLast, true);
  assert.equal(reference.usesFxLast, true);
  const missing = equityBasis({ last: 3000 }, {});
  assert.equal(equitySpreads(missing.cashBidUsd, missing.cashAskUsd, { bid: 200, ask: 201 }).buyKoreaSellPerp, null);
  assert.equal(equityBasis({ last: 0 }, { last: 150 }).cashBidUsd, null);
});

test("routes Tencent aliases to Hyperliquid and computes HK auction and historical basis", async () => {
  const importRoute = async (path) => {
    const source = stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), "utf8"));
    return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  };
  const quotes = await importRoute("../app/api/hk-auction/quotes/route.ts");
  const history = await importRoute("../app/api/hk-auction/history/route.ts");
  const now = Date.now();
  const minute = Math.floor(now / 60_000) * 60_000;
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalPush = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const originalRelay = process.env.FUTU_RELAY_URL;
  delete process.env.FUTU_RELAY_URL;
  globalThis.__FUTU_PUSH_SNAPSHOT__ = {
    receivedAt: now,
    payload: {
      quotes: [{ symbol: "HK.00700", marketState: "AUCTION", auctionPrice: 392, bid: 391, ask: 393, bidSize: 100, askSize: 200, marketTimestamp: now }],
      history: { "HK.00700": [[minute, 392]] },
    },
  };
  let bookTime = now;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.hyperliquid.xyz/info");
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.type === "metaAndAssetCtxs") return Response.json([{ universe: [{ name: "io:TCNT" }] }, [{ funding: "0.00000625" }]]);
    if (body.type === "l2Book") {
      assert.equal(body.coin, "io:TCNT");
      return Response.json({ time: bookTime, levels: [[{ px: "51", sz: "10" }], [{ px: "52", sz: "20" }]] });
    }
    assert.equal(body.type, "candleSnapshot");
    assert.equal(body.req.coin, "io:TCNT");
    return Response.json([{ t: minute, o: "51", h: "52", l: "50", c: "51" }]);
  };
  try {
    const query = new URLSearchParams({ pair: "HK.00700|io:TENCENT|1|hyperliquid", usdhkd: "7.84" });
    const response = await quotes.GET(new Request(`http://localhost/api/hk-auction/quotes?${query}`));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.errors, []);
    assert.equal(result.sources.hyperliquid, true);
    const quote = result.quotes[0];
    assert.equal(quote.perpSymbol, "io:TCNT");
    assert.equal(quote.perpVenue, "hyperliquid");
    assert.equal(quote.status, "live");
    assert.equal(quote.binance.bid, 51);
    assert.equal(quote.binance.askSize, 20);
    assert.equal(quote.binance.fundingRate, 0.00000625);
    assert.equal(quote.metrics.fairUsdt, 50);
    assert.ok(Math.abs(quote.metrics.midBasisPct - 3) < 1e-10);
    assert.ok(Math.abs(quote.metrics.sellPerpBuyStock.basisPct - (51 / (393 / 7.84) - 1) * 100) < 1e-10);
    assert.equal(quote.metrics.sellPerpBuyStock.capacityContracts, 10);
    const historical = await history.GET(new Request("http://localhost/api/hk-auction/history?stock=HK.00700&perp=io%3ATENCENT&shares=1&usdhkd=7.84"));
    assert.equal(historical.status, 200);
    const historicalResult = await historical.json();
    assert.match(historicalResult.source, /Hyperliquid/);
    assert.ok(Math.abs(historicalResult.points[0].value - 2) < 1e-10);
    bookTime = now - 60_000;
    const staleResult = await (await quotes.GET(new Request(`http://localhost/api/hk-auction/quotes?${query}`))).json();
    assert.equal(staleResult.quotes[0].status, "stale");
    assert.equal(staleResult.quotes[0].metrics.midBasisPct, null);
    assert.equal(requests.filter((request) => request.type === "candleSnapshot").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__FUTU_PUSH_SNAPSHOT__ = originalPush;
    if (originalRelay === undefined) delete process.env.FUTU_RELAY_URL;
    else process.env.FUTU_RELAY_URL = originalRelay;
  }
});


test("server-renders HK auction after removing the card history controls", async () => {
  const response = await render("/hk-auction");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /HK Auction Basis/);
  assert.match(html, /io:TCNT/);
  assert.match(html, /HK CLOSE ANCHOR/);
  assert.doesNotMatch(html, /Open spread history|>Overview</);
});
