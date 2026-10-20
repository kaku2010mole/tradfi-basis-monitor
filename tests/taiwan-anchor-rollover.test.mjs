import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const moduleUrl = (source) => "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64");
const modelUrl = moduleUrl(await readFile(new URL("../app/lib/taiwanStockBasis.ts", import.meta.url), "utf8"));
const model = await import(modelUrl);
const at = (date) => Date.parse(date + "+08:00");

test("Taiwan model reanchors exactly at 14:00, not midnight, and respects holiday runs", () => {
  const anchor = (date, calendars = [model.TWSE_2026]) => model.latestTaiwanAnchor(at(date), calendars);
  for (const date of ["2026-10-20T00:00:00", "2026-10-20T13:59:59", "2026-10-20T13:59:59.999"]) {
    assert.equal(anchor(date), at("2026-10-19T14:00:00"));
  }
  assert.equal(anchor("2026-10-20T14:00:00"), at("2026-10-20T14:00:00"));
  assert.equal(anchor("2026-10-20T23:59:59"), at("2026-10-20T14:00:00"));
  assert.equal(anchor("2026-10-21T00:00:00"), at("2026-10-20T14:00:00"));
  assert.equal(anchor("2026-10-21T14:00:00"), at("2026-10-21T14:00:00"));
  assert.equal(anchor("2026-10-23T23:59:59"), at("2026-10-23T14:00:00"));
  for (const date of ["2026-10-24T00:00:00", "2026-10-25T12:00:00", "2026-10-26T12:00:00", "2026-10-27T12:00:00"]) {
    assert.equal(anchor(date), at("2026-10-23T14:00:00"));
  }
  assert.equal(anchor("2026-10-26T14:00:00"), at("2026-10-23T14:00:00"), "holiday does not reset");
  assert.equal(anchor("2026-10-27T14:00:00"), at("2026-10-27T14:00:00"));
  assert.equal(anchor("2026-10-28T00:00:00"), at("2026-10-27T14:00:00"));
  assert.equal(anchor("2026-02-23T13:59:59"), at("2026-02-11T14:00:00"), "long holiday run");
  assert.equal(anchor("2026-02-23T14:00:00"), at("2026-02-23T14:00:00"));
  const calendars = [model.TWSE_2026, { year: 2027, holidays: ["2027-01-01"], source: "test" }];
  assert.equal(anchor("2027-01-04T13:59:59", calendars), at("2026-12-31T14:00:00"));
  assert.equal(anchor("2027-01-04T14:00:00", calendars), at("2027-01-04T14:00:00"));
  assert.equal(anchor("2027-01-04T14:00:00"), null, "missing calendar cannot invent a new anchor");
  assert.equal(model.latestTaiwanAnchor(NaN, calendars), null);
});

test("a running server reanchors all eight names, TSM and UMC without a restart or stale-date fallback", async () => {
  const source = (await readFile(new URL("../app/lib/taiwanMarket.ts", import.meta.url), "utf8"))
    .replace('from "./taiwanStockBasis"', `from ${JSON.stringify(modelUrl)}`)
    .replace('import { bitgetBooks } from "./bitgetRelativeMarket";', "const bitgetBooks = async () => [];")
    .replace('import { taiwanCashSnapshot } from "./fugleTaiwanMarket";', "const taiwanCashSnapshot = async () => undefined;")
    .replace('import { taiwanFxSnapshot } from "./taiwanFxMarket";', "const taiwanFxSnapshot = async () => undefined;");
  const { taiwanSnapshot } = await import(moduleUrl(source));
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const firstTarget = at("2026-10-19T14:00:00"), secondTarget = at("2026-10-20T14:00:00");
  let now = at("2026-10-20T13:59:59"), failWinbond = false;
  const indexCalls = [], adrRequests = [];
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.host === "www.twse.com.tw") return Response.json({
      stat: "ok", queryYear: 2026, data: model.TWSE_2026.holidays.map((date) => [date, "休市"]),
    });
    if (url.pathname.endsWith("/history-index-candles")) {
      const target = Number(url.searchParams.get("startTime")) + 60_000;
      const symbol = url.searchParams.get("symbol");
      indexCalls.push({ symbol, target });
      if (failWinbond && symbol === "WINBONDUSDT") return new Response("offline", { status: 503 });
      return Response.json({ code: "00000", data: [[target, target === firstTarget ? "100" : "120"]] });
    }
    if (url.host === "query1.finance.yahoo.com") {
      const symbol = url.pathname.split("/").at(-1);
      adrRequests.push({ symbol, from: Number(url.searchParams.get("period1")) * 1000, to: Number(url.searchParams.get("period2")) * 1000 });
      return Response.json({ chart: { result: [{
        meta: { symbol, currency: "USD" },
        timestamp: [(firstTarget - 300_000) / 1000, (secondTarget - 300_000) / 1000],
        indicators: { quote: [{ close: symbol === "UMC" ? [10, 9] : [200, 220] }] },
      }] } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const first = await taiwanSnapshot(now);
    assert.equal(first.anchorTimestamp, firstTarget);
    assert.equal(indexCalls.length, 8);
    assert.ok(first.rows.every((row) => row.anchor?.price === 100 && row.anchor.timestamp === firstTarget));
    assert.equal(first.tsm.anchor.price, 200);
    assert.equal(first.adrs.UMC.anchor.price, 10);
    await taiwanSnapshot(now);
    assert.equal(indexCalls.length, 8, "unchanged anchors are shared, not re-fetched every 2 seconds");
    assert.equal(adrRequests.length, 2, "one cached history request per ADR, not per browser refresh");

    now = at("2026-10-20T14:00:00");
    failWinbond = true;
    const next = await taiwanSnapshot(now);
    assert.equal(next.anchorTimestamp, secondTarget);
    assert.equal(indexCalls.length, 16, "all eight cache keys must change at 14:00");
    assert.deepEqual(new Set(indexCalls.slice(8).map((call) => call.target)), new Set([secondTarget]));
    const winbond = next.rows.find((row) => row.symbol === "WINBONDUSDT");
    assert.equal(winbond.anchor, null, "a missing new anchor must not fall back to yesterday's cached anchor");
    assert.match(winbond.anchorError, /503/);
    assert.ok(next.rows.filter((row) => row !== winbond).every((row) => row.anchor?.price === 120 && row.anchor.timestamp === secondTarget));
    assert.equal(adrRequests.length, 4, "the model reset invalidates both 30-second ADR caches too");
    assert.ok(adrRequests.filter((request) => request.symbol === "TSM").every((request) => request.from === firstTarget - 4 * model.DAY_MS), "one TSM history fetch covers the model and opening-study anchors");
    assert.equal(next.tsm.anchor.price, 220, "TWTSM's ADR denominator rolls with the oracle anchor");
    assert.equal(next.tsm.anchor.timestamp, secondTarget);
    assert.equal(next.adrs.UMC.anchor.price, 9, "TWUMC's own ADR denominator rolls independently of TSM");
    assert.equal(next.adrs.UMC.anchor.timestamp, secondTarget);
    assert.equal(next.adrs.UMC.openingAnchor, null, "UMC must not be mixed into the TSM opening study");
    assert.equal(next.tsm.openingAnchor.price, 200, "afternoon model reset must not rewrite the morning study");
    assert.equal(next.tsm.openingAnchorTimestamp, firstTarget);
    assert.equal(next.tsm.preOpen.price, first.tsm.preOpen.price);
    assert.equal(next.tsm.cutoffTimestamp, at("2026-10-20T09:00:00"));

    failWinbond = false;
    now += 31_000;
    const recovered = await taiwanSnapshot(now);
    assert.ok(recovered.rows.every((row) => row.anchor?.price === 120 && row.anchor.timestamp === secondTarget));
    assert.equal(indexCalls.length, 17, "only the missing daily anchor needs retrying");
    now = at("2026-10-21T00:00:00");
    const midnight = await taiwanSnapshot(now);
    assert.equal(midnight.anchorTimestamp, secondTarget);
    assert.equal(indexCalls.length, 17, "midnight must not reset or re-fetch the price model");
    assert.equal(midnight.tsm.openingAnchorTimestamp, secondTarget, "the next opening study advances independently");
    assert.equal(midnight.adrs.UMC.anchor.price, 9);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("UI describes the 14:00 reset and gives the opening study its separate denominator", async () => {
  const panel = await readFile(new URL("../app/components/TaiwanStockPanel.tsx", import.meta.url), "utf8");
  const study = await readFile(new URL("../app/components/TaiwanAdrOutlook.tsx", import.meta.url), "utf8");
  assert.match(panel, /Automatically resets at 14:00 HKT/);
  assert.match(panel, /LATEST 14:00 ORACLE/);
  assert.doesNotMatch(panel, /Previous TWSE trading date|PREVIOUS 14:00 ORACLE/);
  assert.match(study, /adrReturn\(openingAnchor, tsm.preOpen, openingTarget,/);
});

test("UMC validates ticker identity, isolates outages and prefers its own fresh office data", async () => {
  const source = (await readFile(new URL("../app/lib/taiwanMarket.ts", import.meta.url), "utf8"))
    .replace('from "./taiwanStockBasis"', `from ${JSON.stringify(modelUrl)}`)
    .replace('import { bitgetBooks } from "./bitgetRelativeMarket";', "const bitgetBooks = async () => [];")
    .replace('import { taiwanCashSnapshot } from "./fugleTaiwanMarket";', "const taiwanCashSnapshot = async () => undefined;")
    .replace('import { taiwanFxSnapshot } from "./taiwanFxMarket";', "const taiwanFxSnapshot = async () => undefined;");
  const { taiwanSnapshot } = await import(moduleUrl(source + "\n// separate UMC feed isolation instance"));
  const originalFetch = globalThis.fetch, originalNow = Date.now, originalPush = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const target = at("2026-10-20T14:00:00");
  let now = at("2026-10-20T18:00:00"), scenario = "wrong ticker", umcCalls = 0;
  Date.now = () => now;
  globalThis.__FUTU_PUSH_SNAPSHOT__ = undefined;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.host === "www.twse.com.tw") return Response.json({
      stat: "ok", queryYear: 2026, data: model.TWSE_2026.holidays.map((date) => [date, "休市"]),
    });
    if (url.pathname.endsWith("/history-index-candles")) return Response.json({ code: "00000", data: [[target, "100"]] });
    if (url.host === "query1.finance.yahoo.com") {
      const symbol = url.pathname.split("/").at(-1);
      if (symbol === "UMC") {
        umcCalls++;
        if (scenario === "outage") return new Response("offline", { status: 503 });
      }
      return Response.json({ chart: { result: [{
        meta: { symbol: symbol === "UMC" && scenario === "wrong ticker" ? "TSM" : symbol, currency: "USD" },
        timestamp: [(target - 300_000) / 1000, (at("2026-10-20T17:55:00") - 300_000) / 1000],
        indicators: { quote: [{ close: symbol === "UMC" ? [10, 11] : [200, 220] }] },
      }] } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const wrong = await taiwanSnapshot(now);
    assert.equal(wrong.adrs.UMC.anchor, null);
    assert.equal(wrong.adrs.UMC.current, null);
    assert.match(wrong.adrs.UMC.error, /UMC ADR history identity invalid/);
    assert.equal(wrong.tsm.current.price, 220, "bad UMC response must not affect TSM");
    assert.equal(model.taiwanComparison(wrong.rows[3], wrong.adrs.UMC, now).reference, null);
    await taiwanSnapshot(now);
    assert.equal(umcCalls, 1, "bad UMC identity retries only after backoff");

    scenario = "valid";
    now += 31_000;
    const recovered = await taiwanSnapshot(now);
    assert.equal(recovered.adrs.UMC.anchor.price, 10);
    assert.equal(recovered.adrs.UMC.current.price, 11);
    scenario = "outage";
    now += 31_000;
    const retained = await taiwanSnapshot(now);
    assert.deepEqual(retained.adrs.UMC.current, recovered.adrs.UMC.current, "outages retain only UMC observations, including timestamp");
    assert.match(retained.adrs.UMC.error, /UMC.*503/);
    const beforeOffice = umcCalls;
    globalThis.__FUTU_PUSH_SNAPSHOT__ = { receivedAt: now, payload: {
      history: { "US.UMC": [[target - 60_000, 10]] },
      quotes: [
        { symbol: "US.TSM", bid: 500, ask: 502, marketTimestamp: now },
        { symbol: "US.UMC", bid: 12, ask: 12.2, marketTimestamp: now },
      ],
    } };
    const office = await taiwanSnapshot(now);
    assert.equal(office.adrs.UMC.current.price, 12.1);
    assert.equal(office.adrs.UMC.anchor.price, 10);
    assert.equal(office.adrs.UMC.error, null);
    assert.equal(umcCalls, beforeOffice, "complete fresh UMC office history avoids an external request");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    if (originalPush === undefined) delete globalThis.__FUTU_PUSH_SNAPSHOT__;
    else globalThis.__FUTU_PUSH_SNAPSHOT__ = originalPush;
  }
});
