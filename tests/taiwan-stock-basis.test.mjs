import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = await readFile(new URL("../app/lib/taiwanStockBasis.ts", import.meta.url), "utf8");
const model = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64"));
const at = (date) => Date.parse(date + "+08:00");
const ref = (price, timestamp, source = "test") => ({ price, timestamp, source });
const now = at("2026-10-20T10:00:00");
const target = at("2026-10-19T14:00:00");
const baseRow = { ...model.TAIWAN_STOCKS[1], adrSymbol: null, anchor: ref(100, target), anchorError: null,
  book: { bid: 109, ask: 111, last: 999, index: 108, timestamp: now } };
const tsm = { anchor: ref(200, target), current: ref(220, now - 60_000), error: null };

test("all ten Taiwan contracts map to distinct correct TWSE companies", () => {
  assert.deepEqual(model.TAIWAN_STOCKS.map((s) => [s.symbol, s.code]), [
    ["TWTSMUSDT", "2330"], ["TWDELTAUSDT", "2308"], ["TWASXUSDT", "3711"], ["TWUMCUSDT", "2303"],
    ["NANYAUSDT", "2408"], ["WINBONDUSDT", "2344"], ["YAGEOUSDT", "2327"], ["WALSINUSDT", "2492"],
    ["HONHAIUSDT", "2317"], ["MEDIATEKUSDT", "2454"],
  ]);
  assert.deepEqual(model.TAIWAN_STOCKS.filter((s) => s.adrSymbol).map((s) => [s.symbol, s.adrSymbol]), [
    ["TWTSMUSDT", "TSM"], ["TWUMCUSDT", "UMC"],
  ]);
  assert.equal(model.TAIWAN_STOCKS[7].name, "Walsin Technology");
});

test("opening-study prior trading DATE stays fixed, independently of the afternoon model reset", () => {
  const anchor = (date) => model.previousTaiwanAnchor(at(date), [model.TWSE_2026]);
  assert.equal(anchor("2026-10-20T10:00:00"), target);
  assert.equal(anchor("2026-10-20T18:00:00"), target);
  assert.equal(anchor("2026-10-19T10:00:00"), at("2026-10-16T14:00:00"));
  assert.equal(anchor("2026-10-18T10:00:00"), at("2026-10-16T14:00:00"));
  assert.equal(anchor("2026-10-12T10:00:00"), at("2026-10-08T14:00:00"));
  assert.equal(anchor("2026-10-27T10:00:00"), at("2026-10-23T14:00:00"));
  assert.equal(anchor("2026-02-23T10:00:00"), at("2026-02-11T14:00:00"));
  assert.equal(anchor("2027-01-05T10:00:00"), null, "unknown calendar year must not silently assume weekdays");
});

test("official calendar parser distinguishes trading-day notices and rejects wrong years", () => {
  const data = { stat: "ok", queryYear: 2026, data: [
    ["2026-01-01", "中華民國開國紀念日"], ["2026-01-02", "國曆新年開始交易日"],
    ["2026-02-11", "農曆春節前最後交易日"], ["2026-02-12", "市場無交易，僅辦理結算交割作業"],
  ] };
  assert.deepEqual(model.parseTaiwanCalendar(data, 2026).holidays, ["2026-01-01", "2026-02-12"]);
  assert.equal(model.parseTaiwanCalendar(data, 2027), null);
  assert.equal(model.parseTaiwanCalendar({ ...data, data: [] }, 2026), null);
});

test("opening input keeps today's 09:00 cutoff after open and advances over holidays/weekends", () => {
  const cutoff = (date) => model.taiwanOpeningCutoff(at(date), [model.TWSE_2026]);
  assert.equal(cutoff("2026-10-20T08:00:00"), at("2026-10-20T09:00:00"));
  assert.equal(cutoff("2026-10-20T18:00:00"), at("2026-10-20T09:00:00"));
  assert.equal(cutoff("2026-10-24T18:00:00"), at("2026-10-27T09:00:00"));
  assert.equal(cutoff("2027-01-04T08:00:00"), null);
});

test("14:00 oracle uses the exact index candle OPEN, never later close, mark, or another date", () => {
  const rows = [[target - 60_000, "99", "99", "99", "100"], [target, "100", "104", "99", "102"], [target + 60_000, "102"]];
  assert.equal(model.indexAnchorFromCandles(rows, target).price, 100);
  assert.equal(model.indexAnchorFromCandles(rows.slice(0, 1), target), null);
  assert.equal(model.indexAnchorFromCandles([[target, "NaN"]], target), null);
});

test("TSM history cannot look ahead; unsorted data selects the last valid observation before anchor", () => {
  const points = [ref(999, target + 1), ref(200, target - 1000), ref(150, target - 60_000), ref(100, target - 5 * model.DAY_MS)];
  assert.equal(model.lastReferenceAtOrBefore(points, target).price, 200);
  assert.equal(model.lastReferenceAtOrBefore([points[0], points[3]], target), null);
  assert.equal(model.lastReferenceAtOrBefore([ref(200,target),ref(210,target)],target).price,200,"preserve first-source precedence on equal timestamps");
});

test("ADR model requires fresh 14:00, otherwise same-date 17:00 HKT, never the morning close or a future fallback", () => {
  const fallback = target + 3 * 3_600_000;
  const morning = ref(20.06, target - 6 * 3_600_000);
  const primary = ref(20, target);
  const secondary = ref(19.33, fallback);
  assert.deepEqual(model.adrModelAnchor([morning, secondary], target, fallback - 1), {
    anchor: null, anchorTargetTimestamp: null, anchorMode: "waiting",
  });
  assert.equal(model.adrModelAnchor([morning], target, now).anchor, null);
  assert.equal(model.adrModelAnchor([secondary, primary], target, now).anchor, primary);
  assert.equal(model.adrModelAnchor([secondary], target, now).anchorMode, "17:00 fallback");
  assert.equal(model.adrModelAnchor([secondary], target, now).anchorTargetTimestamp, fallback);
  assert.equal(model.adrModelAnchor([ref(20, target - 60_000)], target, now).anchorMode, "14:00");
  assert.equal(model.adrModelAnchor([ref(20, target - 60_001)], target, now).anchor, null);
  assert.equal(model.adrModelAnchor([ref(20, fallback + 1)], target, now).anchor, null);
  assert.equal(model.adrModelAnchor([ref(20, fallback - model.DAY_MS)], target, now).anchor, null);
  assert.equal(model.adrModelAnchor([ref(19.33, target + 2 * 3_600_000)], target, now).anchor, null, "16:00 is no longer an eligible fallback");
  const winter = at("2026-12-01T14:00:00");
  assert.equal(model.adrModelAnchor([ref(20, at("2026-12-01T17:00:00"))], winter, at("2026-12-01T18:00:00")).anchorMode, "17:00 fallback", "HKT fallback stays 17:00 after U.S. daylight saving ends");
  const row = { ...baseRow, adrSymbol: "UMC" };
  assert.equal(model.taiwanComparison(row, { symbol: "UMC", anchor: morning, current: secondary }, now).reference, null);
  assert.ok(Math.abs(model.taiwanComparison(row, { symbol: "UMC", anchor: secondary, current: ref(secondary.price * 1.1, now) }, now).reference - 110) < 1e-10);
  assert.equal(model.taiwanComparison(row, { symbol: "UMC", anchor: secondary, current: secondary }, fallback - 1).reference, null);
});

test("regular Taiwan rows use frozen oracle, not current index or last trade", () => {
  const actual = model.taiwanComparison(baseRow, tsm, now);
  assert.equal(actual.reference, 100);
  assert.equal(actual.mid, 110);
  assert.ok(Math.abs(actual.deviation - 10) < 1e-10);
  assert.ok(Math.abs(actual.sellVsReference - 9) < 1e-10);
  assert.equal(actual.direction, "PERP RICH");
  assert.equal(actual.freshBook, true);
});

test("TWTSM compares normalized relative changes, not the 5:1 ADR/share absolute ratio", () => {
  const row = { ...baseRow, adrSymbol: "TSM" };
  const actual = model.taiwanComparison(row, tsm, now);
  assert.ok(Math.abs(actual.reference - 110) < 1e-10);
  assert.ok(Math.abs(actual.deviation) < 1e-10);
  assert.ok(Math.abs(actual.adrReturn - 10) < 1e-10);
  for (const bad of [{ ...tsm, anchor: null }, { ...tsm, current: null }, { ...tsm, anchor: ref(200, target + 60_000) }, { ...tsm, current: ref(220, now + 60_000) }]) {
    assert.equal(model.taiwanComparison(row, bad, now).reference, null);
  }
});

test("TWUMC follows only UMC's return; a missing UMC feed cannot use TSM or the bare oracle", () => {
  const row = { ...baseRow, ...model.TAIWAN_STOCKS[3] };
  const umc = { symbol: "UMC", anchor: ref(10, target), current: ref(9, now), error: null };
  const payload = { tsm, adrs: { TSM: { ...tsm, symbol: "TSM" }, UMC: umc } };
  const selected = model.taiwanAdrReference(row.adrSymbol, payload);
  assert.equal(selected, umc);
  const actual = model.taiwanComparison(row, selected, now);
  assert.equal(actual.reference, 90);
  assert.ok(Math.abs(actual.adrReturn + 10) < 1e-10);
  assert.ok(Math.abs(actual.deviation - (110 / 90 - 1) * 100) < 1e-10);
  assert.equal(model.taiwanComparison(row, tsm, now).reference, null);
  assert.equal(model.taiwanComparison(row, { ...tsm, symbol: "TSM" }, now).reference, null);
  for (const old of [null, { tsm }, { tsm, adrs: { TSM: payload.adrs.TSM } }]) {
    assert.equal(model.taiwanComparison(row, model.taiwanAdrReference("UMC", old), now).reference, null);
  }
  assert.equal(model.taiwanAdrReference("TSM", { tsm }), tsm, "legacy TSM payload still works");
});

test("stale/crossed/zero quotes are not live; reference remains visible without false executable edge", () => {
  const stale = model.taiwanComparison(baseRow, tsm, now + 120_000);
  assert.equal(stale.freshBook, false);
  assert.ok(stale.deviation !== null);
  const crossed = model.taiwanComparison({ ...baseRow, book: { ...baseRow.book, ask: 108 } }, tsm, now);
  assert.equal(crossed.freshBook, false);
  assert.equal(crossed.sellVsReference, null);
  assert.equal(crossed.buyVsReference, null);
  assert.equal(model.taiwanComparison({ ...baseRow, anchor: null }, tsm, now).reference, null);
  assert.equal(model.positive(Infinity), null);
  assert.equal(model.positive(0), null);
});

test("Taiwan is independently refreshed, foldable, filterable and outside the executable radar", async () => {
  const panel = await readFile(new URL("../app/components/TaiwanStockPanel.tsx", import.meta.url), "utf8");
  const parent = await readFile(new URL("../app/components/KoreanPerpMonitor.tsx", import.meta.url), "utf8");
  assert.match(panel, /2_000/);
  assert.match(panel, /<details key=\{`\$\{mode\}:\$\{row.symbol\}`\}/);
  assert.match(panel, /\/api\/stock-basis\/taiwan/);
  assert.doesNotMatch(panel, /browserIdToken|beginPosleyLogin/);
  assert.match(parent, /"ALL", "KRX", "TSE", "TWSE"/);
  assert.match(parent, /excluded from the live quote radar/);
});

test("rendered Taiwan API returns ten rows, isolates missing anchors and uses actual ADR data", async () => {
  const { default: worker } = await import("../dist/server/index.js");
  const env = { ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  // Initialize the framework's fetch wrapper before replacing it with fixtures.
  await worker.fetch(new Request("http://localhost/stock-basis"), env, ctx);
  const original = globalThis.fetch, originalNow = Date.now;
  Date.now = () => now;
  const calls = [];
  let failTsm = false;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.host === "www.twse.com.tw") return Response.json({ stat: "ok", queryYear: 2026, data: model.TWSE_2026.holidays.map((date) => [date, "休市"]) });
    if (url.pathname.endsWith("/tickers")) return Response.json({ code: "00000", data: model.TAIWAN_STOCKS.map((s) => ({ symbol: s.symbol, bidPr: "109", askPr: "111", indexPrice: "108", ts: String(now) })) });
    if (url.pathname.endsWith("/history-index-candles")) {
      assert.equal(url.searchParams.get("granularity"), "1m");
      if (url.searchParams.get("symbol") === "NANYAUSDT") return new Response("unavailable", { status: 503 });
      return Response.json({ code: "00000", data: [[target, "100", "105", "99", "104"]] });
    }
    if (url.pathname.includes("TWD")) return Response.json({ chart: { result: [{ meta: { symbol: "TWD=X", currency: "TWD", instrumentType: "CURRENCY", regularMarketPrice: 32.5, regularMarketTime: now / 1000 } }] } });
    if (url.host === "query1.finance.yahoo.com") {
      const symbol = url.pathname.split("/").at(-1);
      return failTsm ? new Response("offline", { status: 503 }) : Response.json({ chart: { result: [{ meta: { symbol, currency: "USD" }, timestamp: [(target - 300_000) / 1000, (now - 3_600_000 - 300_000) / 1000, (now - 300_000) / 1000], indicators: { quote: [{ close: symbol === "UMC" ? [10, 9.5, 9] : [200, 210, 220] }] } }] } });
    }
    throw new Error(`Unexpected external request: ${url}`);
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/stock-basis/taiwan"), env, ctx);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.rows.length, 10);
    assert.equal(data.fx.quote.price, 32.5);
    assert.equal(data.anchorTimestamp, target);
    assert.ok(data.rows[0].anchor, data.rows[0].anchorError);
    assert.equal(data.rows[0].anchor.price, 100);
    assert.equal(data.rows.find((r) => r.symbol === "NANYAUSDT").anchor, null);
    assert.match(data.rows.find((r) => r.symbol === "NANYAUSDT").anchorError, /503/);
    assert.equal(data.tsm.anchor.price, 200);
    assert.equal(data.tsm.current.price, 220);
    assert.equal(data.tsm.preOpen.price, 210, "10:00 quotes cannot rewrite the 09:00 opening input");
    assert.equal(data.tsm.cutoffTimestamp, now - 3_600_000);
    assert.deepEqual(data.adrs.TSM, data.tsm);
    assert.equal(data.adrs.UMC.symbol, "UMC");
    assert.equal(data.adrs.UMC.anchor.price, 10);
    assert.equal(data.adrs.UMC.current.price, 9);
    assert.equal(model.taiwanComparison(data.rows[3], data.adrs.UMC, now).reference, 90);
    assert.ok(Math.abs(model.taiwanComparison(data.rows[0], data.tsm, now).deviation) < 1e-10);
    const count = calls.length;
    await worker.fetch(new Request("http://localhost/api/stock-basis/taiwan"), env, ctx);
    assert.equal(calls.length, count, "2s refresh must not re-fetch anchors, calendar and TSM history");
    failTsm = true;
    Date.now = () => now + 31_000;
    const outage = await (await worker.fetch(new Request("http://localhost/api/stock-basis/taiwan"), env, ctx)).json();
    assert.equal(outage.tsm.current.price, 220, "a transient ADR outage must retain real observations");
    assert.equal(outage.tsm.current.timestamp, data.tsm.current.timestamp, "retained ADR must not be retimestamped");
    assert.match(outage.tsm.error, /503/);
    assert.equal(outage.adrs.UMC.current.price, 9);
    assert.equal(outage.adrs.UMC.current.timestamp, data.adrs.UMC.current.timestamp);
    assert.match(outage.adrs.UMC.error, /UMC.*503/);
    const rendered = await worker.fetch(new Request("http://localhost/stock-basis"), env, ctx);
    const html = await rendered.text();
    assert.match(html, /Live \/ Pre-open/);
    assert.match(html, /id="taiwan-live-tab"[^>]+aria-selected="true"/);
    assert.match(html, /role="tabpanel" id="taiwan-live-panel"/);
    assert.doesNotMatch(html, /DIRECTION HIT|LATEST 14:00 ORACLE|id="taiwan-model-tab"/);
    assert.match(html, /Change vs close/);
    assert.match(html, /TSM ADR → Taiwan opening outlook/);
    for (const stock of model.TAIWAN_STOCKS) assert.ok(html.includes(stock.symbol));
  } finally { globalThis.fetch = original; Date.now = originalNow; }
});
