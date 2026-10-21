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
  const response = await render("/basis");
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
    render("/basis"),
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

test("JLP Research is the homepage and the original Basis Monitor remains available", async () => {
  const [home, basis, switcher, jlp, jlpApi] = await Promise.all([
    render("/"),
    render("/basis"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/jlp-app/app.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/jlp/[...endpoint]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /JLP Research dashboard/);
  assert.match(await basis.text(), /Set the anchor\. Then watch the drift\./);
  assert.match(switcher, /href="\/" aria-current=\{active === "jlp"/);
  assert.match(switcher, /href="\/basis"/);
  assert.match(jlp, /\/api\/jlp\/state/);
  assert.match(jlp, /\/api\/jlp\/history/);
  assert.match(jlpApi, /JLP data service unavailable/);
});

test("exports Jupiter liquidation events through the Render sidecar without allowing arbitrary endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const csv = "event_id,market,side\ntx:0:1,SOL,long\n";
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8" } });
  };
  try {
    const response = await render("/api/jlp/liquidations.csv");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), csv);
    assert.deepEqual(requests, ["http://127.0.0.1:8788/api/liquidations.csv"]);
    assert.equal((await render("/api/jlp/private.sqlite3")).status, 404);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("removes the Leveraged Pair Monitor page, navigation and dedicated API", async () => {
  const [page, quote, switcher, callback] = await Promise.all([
    render("/ewy-koru"),
    render("/api/ewy-koru/quote"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PosleyOAuthCallback.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(page.status, 404);
  assert.equal(quote.status, 404);
  assert.doesNotMatch(switcher, /Leveraged pairs|href="\/ewy-koru"/);
  assert.match(callback, /!returnTo\.startsWith\("\/ewy-koru"\)/);
  assert.match(callback, /: "\/oracle"/);
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

test("keeps exact Korean and Japanese stock comparisons on the standalone stock basis page", async () => {
  const [page, component, route, posley, officePusher, worker] = await Promise.all([
    readFile(new URL("../app/stock-basis/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/KoreanPerpMonitor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/oracle-monitor/korean-bitget/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/posleyAdr.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/posley-adr-pusher.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<KoreanPerpMonitor/);
  assert.match(component, /Stock cross-venue basis/);
  assert.match(component, /KRX \$\{payload\.sessions\.KRX\} · TSE \$\{payload\.sessions\.TSE\} · US \$\{payload\.sessions\.US\}/);
  assert.match(component, /U\.S\. ADR ↔ BITGET/);
  assert.match(component, /LIVE QUOTE RADAR/);
  assert.match(component, /cash BBO stale or missing/);
  assert.match(component, /executable FX BBO stale or missing/);
  assert.match(component, /INDEX \/ INDICATIVE/);
  assert.doesNotMatch(component, /Waiting for a positive edge with fresh cash\/FX/);
  assert.match(component, /USD\/JPY/);
  assert.match(component, /INDICATIVE/);
  assert.match(component, /Connect Posley/);
  assert.match(component, /New Korean stock perpetuals/);
  assert.match(component, /not a cash-stock quote or basis signal/);
  assert.match(component, /<details className=\{`\$\{styles\.assetRow\}/);
  assert.match(component, /<details className=\{styles\.perpOnlyCard\}/);
  assert.match(component, /KRW EQUIVALENT/);
  assert.match(component, /equity_monitor_id_token/);
  assert.doesNotMatch(component, /005935/);
  for (const code of ["034020", "035420", "042700", "066570", "454910"]) assert.match(route, new RegExp(code));
  for (const code of ["285A", "5802", "6758", "6857", "6920", "6976", "6981", "7203", "8035", "8306", "9983", "9984"]) assert.match(route, new RegExp(`code: "${code}"`));
  for (const symbol of ["TAIYOYUDENUSDT", "MURATAUSDT", "TOYOTAUSDT", "TMUSDT", "FASTRETAILINGUSDT"]) assert.match(route, new RegExp(symbol));
  assert.match(component, /row\.showPerpQuote && row\.venues\.map/);
  assert.match(component, /bid \/ ask · not cash/);
  for (const [code, jpSymbol, adrSymbol] of [["6758", "JPSONYUSDT", "SONYUSDT"], ["8306", "JPMUFGUSDT", "MUFGUSDT"]]) {
    assert.match(route, new RegExp(`code: "${code}"[^\\n]*bitgetSymbol: "${jpSymbol}"[^\\n]*additionalBitgetSymbol: "${adrSymbol}"[^\\n]*comparePerps: true`));
  }
  assert.match(component, /BITGET PERP \/ PERP/);
  assert.match(component, /No live cash, ADR or FX feed required/);
  assert.match(component, /priorVenues\.get\(quoteKey\(quote\)\)/);
  assert.match(component, /key=\{quoteKey\(quote\)\}/);
  assert.doesNotMatch(route, /005935/);
  assert.match(route, /DOOSENERUSDT/);
  assert.match(route, /DOOSBOTUSDT/);
  for (const [code, name, symbol] of [
    ["207940", "三星生物制剂", "SSBIOLOGICSUSDT"],
    ["000270", "起亚汽车", "KIAUSDT"],
    ["373220", "LG新能源", "LGENERGYUSDT"],
    ["035720", "卡考", "KAKAOUSDT"],
    ["105560", "KB金融集团", "KBFGUSDT"],
  ]) assert.match(route, new RegExp(`code: "${code}"[^\\n]*chineseName: "${name}"[^\\n]*symbol: "${symbol}"`));
  assert.match(route, /bitgetOnlyKorean/);
  assert.match(route, /Frankfurter daily reference/);
  assert.match(route, /const rows = KOREAN_STOCKS\.map/);
  assert.match(route, /binanceSymbol: "HANMIUSDT"/);
  assert.match(route, /bitgetSymbol: null, binanceSymbol: "HANMIUSDT"/);
  assert.match(route, /equitySpreads/);
  assert.match(posley, /FX:USD:KRW/);
  assert.match(posley, /FX:USD:JPY/);
  assert.match(officePusher, /STK:\$\{code\}:TSEJ:JPY/);
  assert.match(officePusher, /FX:USD:JPY/);
  assert.match(officePusher, /silent for 90s/);
  assert.match(officePusher, /KEY_GROUPS = \[KEYS\.slice\(0, 20\), KEYS\.slice\(20\)\]/);
  assert.match(officePusher, /"6976", "6981"/);
  assert.match(officePusher, /specific_data/);
  assert.match(officePusher, /if \(stale && \(last === null \|\| !staleMarketTimes\.length\)\) return null/);
  assert.match(officePusher, /const retainBook = !stale \|\| symbol === "KRX\.0158S0"/);
  assert.match(officePusher, /bid: retainBook && bid\.size !== null \? bid\.price : null/);
  assert.match(officePusher, /marketTimestamp: stale \? Math\.max\(\.\.\.staleMarketTimes\)/);
  assert.match(officePusher, /bookTimes = \[fields\.bids_receive_ts_ms, fields\.asks_receive_ts_ms\]/);
  assert.match(route, /quote\.symbol\?\.startsWith\("TSE\."\)/);
  assert.match(route, /quote\.symbol === "FX\.USDJPY"/);
  assert.match(route, /DISPLAY_MAX_AGE_MS/);
  assert.match(route, /marketSession/);
  assert.match(route, /officeCoversActiveMarkets/);
  assert.match(route, /QUOTE_MAX_AGE_MS && book\.timestamp - nowForSession < 5_000/);
  assert.match(route, /activeOfficeSymbols\.some\(\(symbol\) => unavailable\.includes\(symbol\)\) \? remote\.error : ""/);
  assert.match(route, /"PRE-MARKET"/);
  assert.match(route, /"AFTER-HOURS"/);
  assert.match(route, /14 \* 60 \+ 40\) return "AFTER-HOURS OPENING"/);
  assert.match(route, /cashSessionActive = sessions\.KRX === "REGULAR" \|\| sessions\.KRX === "AFTER-HOURS"/);
  assert.match(component, /row\.market === "KRX" && row\.session === "AFTER-HOURS"/);
  assert.match(component, /AFTER-HOURS BBO/);
  assert.match(route, /"OPENING AUCTION"/);
  assert.match(route, /preferCashLast\("TSE", sessions\.TSE, cash\?\.timestamp, now\)/);
  assert.match(component, /preferCashLast\(row\.market, row\.session, row\.cashUpdatedAt, clock\)/);
  assert.match(component, /Auction book, not yet executable/);
  assert.match(component, /bid \/ .*ask/);
  assert.match(posley, /if \(received\.length\) return Math\.max\(\.\.\.received\)/);
  assert.match(route, /USDJPYUSDT/);
  assert.match(route, /indexPrice/);
  assert.match(route, /cashLast: positive\(cash\?\.last\)/);
  assert.match(route, /equityBasis/);
  assert.match(worker, /TSE/);
  assert.match(worker, /285A/);
  assert.match(route, /code: "7203"[^\n]*sharesPerPerp: 1[^\n]*additionalBitgetSymbol: "TMUSDT"[^\n]*additionalSharesPerPerp: 10/);
  assert.match(route, /code: "6976"[^\n]*adrSymbol: "TYOYY", sharesPerAdr: 0\.25/);
  assert.match(route, /code: "6981"[^\n]*adrSymbol: "MRAAY", sharesPerAdr: 0\.5/);
  assert.match(component, /IMPLIED ADR BID \/ ASK/);
  assert.match(component, /impliedAdrBook\(perp, perp\.sharesPerPerp \?\? row\.sharesPerPerp, adr\.sharesPerAdr\)/);
  assert.match(route, /adrSymbol: "SONY", sharesPerAdr: 1/);
  assert.match(route, /adrSymbol: "TM", sharesPerAdr: 10/);
  assert.match(route, /adrSymbol: "MUFG", sharesPerAdr: 1/);
  assert.match(route, /America\/New_York/);
  assert.match(worker, /SONY\|TM\|MUFG/);
  assert.match(route, /fresh\(yenFx\?\.timestamp\)/);
  assert.match(posley, /saved Posley login has expired/);
});

test("Oracle Monitor omits the bottom deviation history chart", async () => {
  const page = await readFile(new URL("../app/oracle/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /KoreanPerpMonitor/);
  assert.doesNotMatch(page, /DeviationChart|DEVIATION HISTORY|chartPoints|loadHistory/);
});

test("cross-venue spread colors prioritize material edges even while markets are closed", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/components/KoreanPerpMonitor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/KoreanPerpMonitor.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /value == null \|\| value <= 0 \? "quiet"/);
  assert.match(component, /value >= 1 \? "high" : value >= 0\.3 \? "medium"/);
  assert.doesNotMatch(component, /!live \|\| value == null/);
  assert.match(component, /cashSummaryLive \? cashComparisons\.filter\(\(\{ live \}\) => live\) : cashComparisons/);
  assert.match(component, /const adrTone = adrComparisons\.reduce<SpreadTone>/);
  assert.match(component, /strongerTone\(spreadTone\(spreads\.buyAdrSellPerp\), spreadTone\(spreads\.buyPerpSellAdr\)\)/);
  assert.match(component, /const perpTone = spreadTone\(pair\?\.headline\?\.value\)/);
  assert.match(component, /including closed-market comparisons/);
  assert.match(css, /\.summarySignals \.spreadHigh\{background:#fff0d7/);
  assert.match(css, /\.referenceCard \.referenceEdges \.spreadQuiet\{background:#f7f9f9/);
});

test("converts Bitget-only Korean perps to KRW without inventing cash basis", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("bitget-only-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  const priorSnapshot = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const stamp = Date.now();
  const korean = ["034020", "035420", "042700", "066570", "454910"];
  const japanese = ["285A", "5802", "6758", "6857", "6920", "7203", "8035", "8306", "9984"];
  globalThis.__FUTU_PUSH_SNAPSHOT__ = {
    receivedAt: stamp,
    payload: { quotes: [
      ...korean.map((code) => ({ symbol: `KRX.${code}`, bid: 100000, ask: 100100, last: 100000, marketTimestamp: stamp })),
      ...japanese.map((code) => ({ symbol: `TSE.${code}`, bid: 1000, ask: 1001, last: 1000, marketTimestamp: stamp })),
      ...["SONY", "TM", "MUFG"].map((code) => ({ symbol: `US.${code}`, bid: 100, ask: 101, last: 100, marketTimestamp: stamp })),
      { symbol: "FX.USDKRW", bid: 1349, ask: 1351, last: 1350, marketTimestamp: stamp },
      { symbol: "FX.USDJPY", bid: 150, ask: 150.1, last: 150, marketTimestamp: stamp },
    ] },
  };
  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.includes("api.bitget.com")) return Response.json({ code: "00000", data: [
      ...["SSBIOLOGICSUSDT", "KIAUSDT", "LGENERGYUSDT", "KAKAOUSDT", "KBFGUSDT"].map((symbol) => ({ symbol, bidPr: "100", askPr: "101", lastPr: "100.5", ts: String(stamp) })),
    ] });
    if (endpoint.includes("fapi.binance.com")) return Response.json([]);
    throw new Error(`Unexpected external request: ${endpoint}`);
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/oracle-monitor/korean-bitget"), {}, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.krwConversion.rate, 1350);
    assert.equal(data.krwConversion.live, true);
    assert.deepEqual(data.bitgetOnlyKorean, []);
    for (const code of ["207940", "000270", "373220", "035720", "105560"]) {
      const row = data.rows.find((row) => row.code === code);
      assert.equal(row.market, "KRX");
      assert.equal(row.cashBidKrw, null);
      assert.equal(row.cashAskKrw, null);
      assert.equal(row.venues[0].bid, 100);
      assert.equal(row.venues[0].buyKoreaSellPerp, null);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (priorSnapshot) globalThis.__FUTU_PUSH_SNAPSHOT__ = priorSnapshot;
    else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  }
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

test("accepts verified Japanese ADR symbols from the Futu relay", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("japan-adr-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const previous = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const credential = "test-futu-push-token";
  const now = Date.now();
  const quotes = ["US.SONY", "US.TM", "US.MUFG"].map((symbol) => ({ symbol, bid: 20, ask: 21, bidSize: 10, askSize: 10, marketState: "MORNING", marketTimestamp: now }));
  try {
    const response = await worker.fetch(new Request("http://localhost/api/hk-auction/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ generatedAt: now, quotes }),
    }), { FUTU_PUSH_TOKEN: credential }, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 202);
    for (const quote of quotes) assert.ok(globalThis.__FUTU_PUSH_SNAPSHOT__?.payload.quotes.some((item) => item.symbol === quote.symbol));
  } finally {
    if (previous) globalThis.__FUTU_PUSH_SNAPSHOT__ = previous;
    else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  }
});

test("accepts a Futu relay payload with more than thirty HK symbols", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("hk-capacity-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const previous = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const credential = "test-futu-push-token";
  const now = Date.now();
  const symbols = Array.from({ length: 31 }, (_, index) => `HK.${String(index + 1).padStart(5, "0")}`);
  const quotes = symbols.map((symbol) => ({ symbol, bid: 20, ask: 21, bidSize: 10, askSize: 10, marketState: "AFTERNOON", marketTimestamp: now }));
  const orderbooks = symbols.map((symbol) => ({ symbol, bids: [{ price: 20, size: 10 }], asks: [{ price: 21, size: 10 }], marketTimestamp: now }));
  const history = Object.fromEntries(symbols.map((symbol) => [symbol, [[now, 20]]]));
  try {
    const response = await worker.fetch(new Request("http://localhost/api/hk-auction/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ generatedAt: now, quotes, orderbooks, history }),
    }), { FUTU_PUSH_TOKEN: credential }, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 202);
    assert.ok(globalThis.__FUTU_PUSH_SNAPSHOT__?.payload.quotes.some((item) => item.symbol === symbols.at(-1)));
  } finally {
    if (previous) globalThis.__FUTU_PUSH_SNAPSHOT__ = previous;
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
  for (const id of ["disk-soxl", "disk-dram", "euv-lyte", "ibb-xbi"]) assert.ok(relativeValue.includes(`id: "${id}"`));
  assert.doesNotMatch(relativeValue, /id: "baba-hk09988"|id: "smh-soxl"|id: "qqq-ustech"/);
  assert.match(alerts, /RELATIVE_VALUE_SIGNAL_EVENT/);
  assert.match(alerts, /window\.setInterval\(\(\) => void pollRelative\(\), 10_000\)/);
  assert.match(alerts, /PREDICTION ERROR/);
  assert.match(alerts, /leg\.venue === "futu"/);
});

test("isolates SK Hynix / 7709 with Futu cash and Binance perp choices and a fair-price chart", async () => {
  const [response, switcher, page, relativeValue, pusher, analysisRoute] = await Promise.all([
    render("/skhynix-7709"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/blog/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/relativeValue.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/push.py", import.meta.url), "utf8"),
    readFile(new URL("../app/api/blog/analysis/route.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /SK Hynix ↔ 7709/);
  assert.match(html, /HEDGE RATIO · FIRST/);
  assert.match(html.replaceAll("<!-- -->", ""), /1,000 shares of/);
  assert.match(html, /7709 shares to hedge/);
  assert.match(html.replaceAll("<!-- -->", ""), /Futu · HK\.07709 cash/);
  assert.match(html.replaceAll("<!-- -->", ""), /Binance · 7709 perp/);
  assert.match(html, /LIVE MONITORING/);
  assert.match(html, /Prices refresh automatically every 2 seconds/);
  assert.match(html, /View history/);
  assert.doesNotMatch(html, /History start · HKT|Backtest start · HKT/);
  assert.match(switcher, /href="\/skhynix-7709"/);
  assert.match(page, /THEORETICAL FAIR PRICE/);
  assert.match(page, /onPointerLeave=\{onPointerLeave\} onBlur=\{onBlur\}/);
  assert.match(page, /const hedge = hedgeQuote/);
  assert.match(page, /MODEL STOCK EXPOSURE/);
  assert.match(page, /leveragedKoreanHedge\(hedgeUnits,/);
  assert.match(page, /minimumFractionDigits: 3, maximumFractionDigits: 3/);
  assert.doesNotMatch(page, /leveragedKoreanHedge\(1_000, neutralPrices\.asset2/);
  assert.match(page, /FairPriceChart/);
  assert.match(relativeValue, /id: "skhynix-csop2l-futu"/);
  assert.match(relativeValue, /symbol: "HK\.07709"/);
  assert.match(pusher, /HK\.07709/);
  assert.match(analysisRoute, /SKHYNIX_7709_FUTU/);
});

test("adds a separate 7747 page and sizes both Korean stock and FX legs from a 1,000-unit ETF position", async () => {
  const [response, switcher, model, pusher, route, hedgeSource] = await Promise.all([
    render("/samsung-7747"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/relativeValue.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/futu-pusher/push.py", import.meta.url), "utf8"),
    readFile(new URL("../app/api/blog/analysis/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/leveragedKoreanHedge.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Samsung Electronics ↔ 7747/);
  assert.match(html.replaceAll("<!-- -->", ""), /1,000 shares of/);
  assert.match(html, /7747 shares to hedge/);
  assert.match(html.replaceAll("<!-- -->", ""), /Futu · HK\.07747 cash/);
  assert.match(html.replaceAll("<!-- -->", ""), /Binance · 7747 perp/);
  assert.match(html, /005930/);
  assert.match(switcher, /href="\/samsung-7747"/);
  assert.match(model, /id: "samsung-csop2l-futu"/);
  assert.match(model, /symbol: "HK\.07747"/);
  assert.match(pusher, /HK\.07747/);
  assert.match(route, /targetLeverage/);
  const { leveragedKoreanHedge } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(hedgeSource)).toString("base64")}`);
  const result = leveragedKoreanHedge(1_000, 20, 100, 1300, 8, 1.5);
  assert.equal(result.productHkd, 20_000);
  assert.equal(result.productUsd, 2_500);
  assert.equal(result.stockShares, 37.5);
  assert.equal(result.stockExposureUsd, 3_750);
  assert.equal(result.stockExposureKrw, 4_875_000);
  const twiceTheUnits = leveragedKoreanHedge(2_000, 20, 100, 1300, 8, 1.5);
  assert.equal(twiceTheUnits.stockShares, 75);
  assert.equal(twiceTheUnits.stockExposureUsd, 7_500);
  assert.equal(leveragedKoreanHedge(1_000, 0, 100, 1300, 8, 2), null);
});

test("estimates the current 7709 price from the KRW-local SK Hynix move", async () => {
  const source = stripTypeScriptTypes(await readFile(new URL("../app/lib/relativeValue.ts", import.meta.url), "utf8"));
  const { skhynix7709FairPrice } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.ok(Math.abs(skhynix7709FairPrice(10, 100, 105, 1300, 1313) - 11.21) < 1e-10);
  assert.equal(skhynix7709FairPrice(10, 100, 30, 1300, 1300), null);
});

test("Futu 7709 and 7747 keep cash history but never treat a closed or stale book as live", async () => {
  const prior = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const now = Date.now();
  const first = Math.floor((now - 3 * 60_000) / 60_000) * 60_000;
  globalThis.__FUTU_PUSH_SNAPSHOT__ = {
    receivedAt: now,
    payload: {
      generatedAt: now,
      quotes: [{ symbol: "HK.07709", marketState: "MORNING", bid: 79.9, ask: 80.1, marketTimestamp: now }, { symbol: "HK.07747", marketState: "MORNING", bid: 89.9, ask: 90.1, marketTimestamp: now }],
      history: { "HK.07709": [[first, 79], [first + 60_000, 79.5]], "HK.07747": [[first, 89], [first + 60_000, 89.5]] },
    },
  };
  try {
    const url = `http://localhost/api/blog/futu?symbol=HK.07709&usdHkd=7.84&start=${first - 60_000}&end=${now}&interval=1m`;
    const live = await render(url.slice("http://localhost".length));
    assert.equal(live.status, 200);
    assert.ok(Math.abs((await live.json()).live - 80 / 7.84) < 1e-10);
    const samsungUrl = `http://localhost/api/blog/futu?symbol=HK.07747&usdHkd=7.84&start=${first - 60_000}&end=${now}&interval=1m`;
    assert.ok(Math.abs((await (await render(samsungUrl.slice("http://localhost".length))).json()).live - 90 / 7.84) < 1e-10);
    globalThis.__FUTU_PUSH_SNAPSHOT__.payload.quotes[0].marketState = "CLOSED";
    globalThis.__FUTU_PUSH_SNAPSHOT__.payload.quotes[1].marketState = "CLOSED";
    const closed = await render(url.slice("http://localhost".length));
    assert.equal(closed.status, 200);
    const closedPayload = await closed.json();
    assert.equal(closedPayload.live, null);
    assert.equal((await (await render(samsungUrl.slice("http://localhost".length))).json()).live, null);
    assert.equal(closedPayload.points.at(-1).t, first + 60_000);
    const compactCash = await (await render(`${samsungUrl.slice("http://localhost".length)}&latestOnly=1`)).json();
    assert.equal(compactCash.points.length, 1);
    assert.equal(compactCash.points[0].t, first + 60_000);
    globalThis.__FUTU_PUSH_SNAPSHOT__.payload.quotes[0].marketState = "MORNING";
    globalThis.__FUTU_PUSH_SNAPSHOT__.payload.quotes[0].marketTimestamp = now - 60_000;
    assert.equal((await (await render(url.slice("http://localhost".length))).json()).live, null);
  } finally {
    if (prior) globalThis.__FUTU_PUSH_SNAPSHOT__ = prior;
    else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  }
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
  assert.match(auction, /\{perpVenue\}-implied ADR/);
  assert.match(auction, /FUTU ↔ \{perpVenue\}/);
  assert.match(auction, /US references \{freshReferences\.length\}/);
  assert.match(auction, /const adrActionable = adrBasisPct !== null && adrFresh && adrBid !== null && adrAsk !== null/);
  assert.match(auction, /INDICATIVE ONLY/);
  assert.doesNotMatch(quotes, /delayedAdrBenchmarks/);
  assert.match(auction, /HK\.01211.*BYDUSDT.*BYDDY.*hkSharesPerAdr: 1/);
  assert.match(auction, /ASSET_TIERS/);
  assert.match(auction, /Tier for \$\{pair\.perpVenue \?\? "binance"\} \$\{pair\.perpSymbol\}/);
  assert.match(auction, /updateTier/);
  assert.match(auction, /tierGroups/);
  assert.match(auction, /grouped by your tags/);
  assert.match(auction, /NVDA REFERENCE · SINCE HK CLOSE/);
  assert.match(auction, /hktHour >= 21 \|\| hktHour < 6/);
  assert.match(auction, /night ranking by \|ADR\/perp basis\|/);
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
  for (const symbol of ["SMICSTOCK_USDT", "KBLAMSTOCK_USDT", "WUXIBIOSTOCK_USDT", "INNOVENTSTOCK_USDT", "GENSCRIPTSTOCK_USDT", "AKESOSTOCK_USDT"]) {
    assert.ok(auction.includes(symbol));
    assert.ok(quotes.includes(symbol));
  }
  assert.match(quotes, /getMexcQuotes/);
  assert.match(pusher, /HK\.01888.*HK\.02269.*HK\.09926/);
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
  assert.doesNotMatch(switcher, /href="\/polymarket"|Funding &amp; Basis/);
});

test("stock basis replaces Funding & Basis navigation without duplicating the Oracle monitor", async () => {
  const [response, oracle, component, switcher] = await Promise.all([
    render("/stock-basis"),
    render("/oracle"),
    readFile(new URL("../app/components/KoreanPerpMonitor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageSwitcher.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Stock cross-venue basis · TradFi Monitor<\/title>/);
  assert.match(html, /<h1>Stock cross-venue basis<\/h1>/);
  assert.match(html, /href="\/stock-basis" aria-current="page"/);
  assert.match(html, /LIVE QUOTE RADAR/);
  assert.match(html, /Filter stock market/);
  assert.match(html, /USD\/KRW/);
  assert.match(html, /USD\/JPY/);
  assert.equal((html.match(/aria-label="Korean, Japanese and Taiwanese stock cross-venue basis"/g) ?? []).length, 1);
  const oracleHtml = await oracle.text();
  assert.match(oracleHtml, /Oracle Monitor/);
  assert.match(oracleHtml, /href="\/stock-basis"/);
  assert.doesNotMatch(oracleHtml, /LIVE QUOTE RADAR|aria-label="Korean, Japanese and Taiwanese stock cross-venue basis"/);
  assert.match(switcher, /href="\/stock-basis" aria-current=\{active === "stock-basis"/);
  assert.doesNotMatch(switcher, /href="\/polymarket"|Funding &amp; Basis/);
  assert.match(component, /equity_monitor_return_to", "\/stock-basis"/);
  assert.match(component, /const POLL_MS = 2_000/);
  assert.match(component, /fetch\("\/api\/oracle-monitor\/korean-bitget"/);
  assert.match(component, /visiblePolling\(/);
  assert.match(component, /stopPolling\(\); controller\?\.abort\(\)/);
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
  const generalRelationships = model.split("// This optional cash comparison")[0];
  assert.equal((generalRelationships.match(/predictorFx: \{ symbol: "KRW=X"/g) ?? []).length, 2, "the general monitor still has only the two Korean single-stock models");
  assert.match(model, /SKHYNIX_7709_FUTU:[\s\S]*predictorFx: \{ symbol: "KRW=X"/);
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
  const { equityBasis, equitySpreads, impliedAdrBook, preferCashLast } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
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
  const japaneseAuctionBook = equityBasis({ bid: 2535, ask: 2536, last: 2500 }, fx, 1, false);
  assert.equal(japaneseAuctionBook.cashBidUsd, 2535 / 157);
  assert.equal(japaneseAuctionBook.cashAskUsd, 2536 / 156);
  assert.equal(japaneseAuctionBook.usesLast, false);
  const now = Date.now();
  assert.equal(preferCashLast("TSE", "OPENING AUCTION", now - 1000, now), false);
  assert.equal(preferCashLast("TSE", "REGULAR", now - 1000, now), false);
  assert.equal(preferCashLast("TSE", "OPENING AUCTION", now - 61_000, now), true);
  assert.equal(preferCashLast("TSE", "CLOSED", now - 1000, now), true);
  assert.equal(preferCashLast("TSE", "LUNCH", now - 1000, now), true);
  assert.equal(preferCashLast("KRX", "PRE-MARKET", now - 1000, now), true);
  const reference = equityBasis({ last: 3000 }, { last: 150 }, 10, true);
  assert.equal(reference.cashBidUsd, 200); // Toyota: ten ordinary shares per ADS.
  assert.equal(reference.cashAskUsd, 200);
  assert.equal(reference.usesLast, true);
  assert.equal(reference.usesFxLast, true);
  const missing = equityBasis({ last: 3000 }, {});
  assert.equal(equitySpreads(missing.cashBidUsd, missing.cashAskUsd, { bid: 200, ask: 201 }).buyKoreaSellPerp, null);
  assert.equal(equityBasis({ last: 0 }, { last: 150 }).cashBidUsd, null);
  assert.deepEqual(impliedAdrBook({ bid: 67.45, ask: 67.51 }, 1, 0.25), { bid: 16.8625, ask: 16.8775 }); // TYOYY
  assert.deepEqual(impliedAdrBook({ bid: 47.84, ask: 47.87 }, 1, 0.5), { bid: 23.92, ask: 23.935 }); // MRAAY
  const toyotaAdr = impliedAdrBook({ bid: 18.865, ask: 18.879 }, 1, 10);
  assert.ok(Math.abs(toyotaAdr.bid - 188.65) < 1e-9 && Math.abs(toyotaAdr.ask - 188.79) < 1e-9); // TOYOTAUSDT -> TM
  assert.deepEqual(impliedAdrBook({ bid: 187.73, ask: 189.27 }, 10, 10), { bid: 187.73, ask: 189.27 }); // TMUSDT -> TM
  assert.deepEqual(impliedAdrBook({ bid: null, ask: null }, 1, 10), { bid: null, ask: null });
});

test("compares JP and ADR-linked perps using normalized BBO, independent of cash and FX", async () => {
  const source = stripTypeScriptTypes(await readFile(new URL("../app/lib/equityBasis.ts", import.meta.url), "utf8"));
  const { perpetualPairBasis } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const now = Date.now();
  const jp = { bid: 22.464, ask: 22.489, bidQty: 10, askQty: 20, sharesPerPerp: 1, updatedAt: now };
  const adr = { bid: 22.55, ask: 22.6, bidQty: 30, askQty: 40, sharesPerPerp: 1, updatedAt: now };
  const result = perpetualPairBasis(jp, adr, now);
  assert.ok(Math.abs(result.buyLeftSellRight - (22.55 / 22.489 - 1) * 100) < 1e-10);
  assert.ok(Math.abs(result.buyRightSellLeft - (22.464 / 22.6 - 1) * 100) < 1e-10);
  assert.equal(result.live, true);
  const normalized = perpetualPairBasis(jp, { ...adr, bid: adr.bid * 10, ask: adr.ask * 10, sharesPerPerp: 10 }, now);
  assert.ok(Math.abs(normalized.buyLeftSellRight - result.buyLeftSellRight) < 1e-10);
  const stale = perpetualPairBasis(jp, { ...adr, updatedAt: now - 61_000 }, now);
  assert.equal(stale.live, false);
  assert.equal(stale.buyLeftSellRight, result.buyLeftSellRight, "retain stale basis as indicative");
  for (const invalid of [{ bidQty: 0 }, { updatedAt: now + 10_000 }, { bid: 23, ask: 22 }, { sharesPerPerp: 0 }]) {
    assert.equal(perpetualPairBasis(jp, { ...adr, ...invalid }, now).live, false);
  }
  const missing = perpetualPairBasis(jp, { ...adr, bid: null, ask: null, last: 22.6 }, now);
  assert.equal(missing.buyLeftSellRight, null);
  assert.equal(missing.buyRightSellLeft, null);
  assert.equal(missing.live, false, "last must not substitute for a perpetual BBO");
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

test("keeps same-symbol Bitget and Bybit SMIC separate and converts MEXC depth contracts", async () => {
  const source = stripTypeScriptTypes(await readFile(new URL("../app/api/hk-auction/quotes/route.ts", import.meta.url), "utf8"));
  const { GET } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const now = Date.now();
  const originalFetch = globalThis.fetch;
  const originalPush = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const originalRelay = process.env.FUTU_RELAY_URL;
  delete process.env.FUTU_RELAY_URL;
  globalThis.__FUTU_PUSH_SNAPSHOT__ = {
    receivedAt: now,
    payload: { quotes: [
      { symbol: "HK.00981", marketState: "AUCTION", auctionPrice: 60, bid: 59.9, ask: 60.1, bidSize: 200, askSize: 200, marketTimestamp: now },
      { symbol: "HK.01888", marketState: "AUCTION", auctionPrice: 53, bid: 52.9, ask: 53.1, bidSize: 200, askSize: 200, marketTimestamp: now },
    ] },
  };
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes("api.bybit.com")) return Response.json({ retCode: 0, time: now, result: { list: [{ symbol: "SMICUSDT", bid1Price: "7.60", ask1Price: "7.62", bid1Size: "20", ask1Size: "30" }] } });
    if (path.includes("api.bitget.com")) return Response.json({ code: "00000", data: [{ symbol: "SMICUSDT", bidPr: "7.70", askPr: "7.72", bidSz: "15", askSz: "25", ts: String(now) }] });
    if (path.endsWith("/contract/ticker")) return Response.json({ success: true, code: 0, data: [
      { symbol: "SMICSTOCK_USDT", bid1: 7.74, ask1: 7.76, timestamp: now, fundingRate: 0.0002 },
      { symbol: "KBLAMSTOCK_USDT", bid1: 6.80, ask1: 6.82, timestamp: now, fundingRate: 0.0001 },
    ] });
    if (path.endsWith("/contract/detail")) return Response.json({ success: true, code: 0, data: [
      { symbol: "SMICSTOCK_USDT", state: 0, contractSize: 0.01 },
      { symbol: "KBLAMSTOCK_USDT", state: 0, contractSize: 0.01 },
    ] });
    if (path.includes("/contract/depth/SMICSTOCK_USDT")) return Response.json({ success: true, code: 0, data: { bids: [[7.74, 1000]], asks: [[7.76, 1500]], timestamp: now } });
    if (path.includes("/contract/depth/KBLAMSTOCK_USDT")) return Response.json({ success: true, code: 0, data: { bids: [[6.80, 2000]], asks: [[6.82, 2500]], timestamp: now } });
    throw new Error(`Unexpected fetch: ${path}`);
  };
  try {
    const query = new URLSearchParams({ usdhkd: "7.84" });
    for (const pair of [
      "HK.00981|SMICUSDT|1|bybit", "HK.00981|SMICUSDT|1|bitget",
      "HK.00981|SMICSTOCK_USDT|1|mexc", "HK.01888|KBLAMSTOCK_USDT|1|mexc",
    ]) query.append("pair", pair);
    const response = await GET(new Request(`http://localhost/api/hk-auction/quotes?${query}`));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.quotes.length, 4);
    assert.equal(result.sources.mexc, true);
    assert.deepEqual(result.quotes.map((quote) => quote.id), [
      "HK.00981:bybit:SMICUSDT", "HK.00981:bitget:SMICUSDT",
      "HK.00981:mexc:SMICSTOCK_USDT", "HK.01888:mexc:KBLAMSTOCK_USDT",
    ]);
    assert.equal(result.quotes[0].binance.bid, 7.60);
    assert.equal(result.quotes[1].binance.bid, 7.70);
    assert.equal(result.quotes[2].binance.bidSize, 10);
    assert.equal(result.quotes[2].binance.askSize, 15);
    assert.equal(result.quotes[2].metrics.sellPerpBuyStock.capacityContracts, 10);
    assert.equal(result.quotes[3].status, "live");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__FUTU_PUSH_SNAPSHOT__ = originalPush;
    if (originalRelay === undefined) delete process.env.FUTU_RELAY_URL;
    else process.env.FUTU_RELAY_URL = originalRelay;
    delete globalThis.__MEXC_BATCH_CACHE__;
    delete globalThis.__MEXC_CONTRACT_CACHE__;
    delete globalThis.__BITGET_BATCH_CACHE__;
    delete globalThis.__BYBIT_BATCH_CACHE__;
  }
});


test("server-renders HK auction after removing the card history controls", async () => {
  const response = await render("/hk-auction");
  const html = await response.text();
  const visibleText = html.replace(/<!-- -->/g, "");
  assert.equal(response.status, 200);
  assert.match(html, /HK Auction Basis/);
  assert.match(html, /io:TCNT/);
  assert.match(html, /HK CLOSE ANCHOR/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(visibleText, /HK CASH \/ /);
  assert.match(visibleText, /ADR TCEHY \/ /);
  assert.match(html, /DIRECTION UNAVAILABLE/);
  assert.doesNotMatch(html, /Open spread history|>Overview</);
});

test("keeps issuer record dates separate from ex-dates and parses per-share amounts", async () => {
  const source = stripTypeScriptTypes(await readFile(new URL("../app/lib/issuerDividends.ts", import.meta.url), "utf8"));
  const { parseIssuerDates, ASIAN_ISSUERS } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const samsung = ASIAN_ISSUERS.find((issuer) => issuer.symbols.includes("SAMSUNG"));
  assert.deepEqual(parseIssuerDates("Notice of Record Date September 21, 2026. We would like to inform you that September 30, 2026 will be the record date to determine the list of shareholders eligible to receive the next quarterly dividend.", samsung, 2026).map((date) => date.recordDate), ["2026-09-30"]);
  const hyundai = ASIAN_ISSUERS.find((issuer) => issuer.symbols.includes("HYUNDAI"));
  const dates = parseIssuerDates('<table><tr><th>Dividend record date</th><th>Dividend payment date</th><th>Common share</th></tr><tr><td>2026.08.31</td><td>2026.09.30</td><td>2,500</td></tr></table>', hyundai, 2026);
  assert.equal(dates[0].recordDate, "2026-08-31");
  assert.equal(dates[0].paymentDate, "2026-09-30");
  assert.equal(dates[0].amount, 2500);
  assert.equal(parseIssuerDates('<table><tr><td>Annual meeting publication</td><td>2026.08.31</td><td>2026.09.30</td></tr></table>', hyundai, 2026).length, 0);
  const mufg = ASIAN_ISSUERS.find((issuer) => issuer.symbols.includes("MUFG"));
  assert.equal(parseIssuerDates("Record Dates for Determination of Dividends March 31 and September 30 (Interim dividend)", mufg, 2026).length, 2);
  assert.equal(parseIssuerDates("March 31 fiscal year end. No dividend dates disclosed.", mufg, 2026).length, 0);
});

test("shows independent company schedules and available Nasdaq dates when one Nasdaq day is incomplete", async () => {
  const originalFetch = globalThis.fetch;
  const originalCache = globalThis.__DIVIDEND_MONTH_CACHE__;
  globalThis.__DIVIDEND_MONTH_CACHE__ = new Map();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/exchangeInfo")) return Response.json({ symbols: [{ symbol: "SAMSUNGUSDT", status: "TRADING", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY" }, { symbol: "AAPLUSDT", status: "TRADING", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY" }] });
    if (url.includes("/premiumIndex")) return Response.json([{ symbol: "AAPLUSDT", markPrice: "200" }]);
    if (url.includes("api.bitget.com")) return Response.json({ data: [] });
    if (url.includes("query1.finance.yahoo.com")) return Response.json({ chart: { result: [{ meta: { regularMarketPrice: 50000 } }] } });
    if (url.includes("api.nasdaq.com")) {
      const date = new URL(url).searchParams.get("date");
      if (date === "2026-09-01" || date === "2026-12-01") return Response.json({ status: { rCode: 200 }, data: {} });
      return Response.json({ status: { rCode: 200 }, data: { calendar: { rows: date === "2026-09-02" ? [{ symbol: "AAPL", companyName: "Apple", dividend_Ex_Date: "09/02/2026", dividend_Rate: "1.00" }] : null } } });
    }
    if (url.includes("binance.com/bapi")) return Response.json({ data: { catalogs: [] } });
    if (url.includes("hkexnews.hk")) return new Response("Dividends & Other Entitlements");
    if (url.includes("samsung.com/global/ir")) return new Response("We would like to inform you that September 30, 2026 will be the record date to determine the list of shareholders eligible to receive the next quarterly dividend.");
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const response = await render("/api/dividend-calendar?month=2026-09");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.missingNasdaqDates, ["2026-09-01"]);
    assert.match(result.warning, /Other sources and available dates are shown/);
    assert.ok(result.events.some((event) => event.contract === "AAPLUSDT" && event.exDate === "2026-09-02"));
    const samsung = result.events.find((event) => event.contract === "SAMSUNGUSDT" && event.recordDate === "2026-09-30");
    assert.equal(samsung.exDate, null);
    assert.equal(samsung.calendarDate, "2026-09-30");
    assert.equal(samsung.settlementConfirmed, false);
    assert.equal(samsung.amount, null);
    assert.match(samsung.sourceUrl, /samsung.com/);
    assert.ok(result.coverage.jp);
    const december = await render("/api/dividend-calendar?month=2026-12");
    assert.equal(december.status, 200);
    const decemberResult = await december.json();
    assert.deepEqual(decemberResult.missingNasdaqDates, ["2026-12-01"]);
    assert.equal(decemberResult.error, undefined);
    assert.match(decemberResult.warning, /2026-12-01/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__DIVIDEND_MONTH_CACHE__ = originalCache;
  }
});


test('luxury comparison is removed from the original dashboard and its routes', async () => {
  const home = await render('/');
  assert.equal(home.status, 200);
  const switcher = await readFile(new URL('../app/components/PageSwitcher.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(switcher, /luxury|奢侈品/);
  assert.match(switcher, /href="\/dividends"/);
  for (const path of ['/luxury', '/api/luxury/rates']) {
    const response = await render(path);
    assert.equal(response.status, 404, path);
  }
});
