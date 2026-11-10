import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const asModule = (source) => "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64");
const calendar = asModule(await readFile(new URL("../app/lib/smicOpening.ts", import.meta.url), "utf8"));
const model = await import(asModule((await readFile(new URL("../app/lib/diskCashModel.ts", import.meta.url), "utf8"))
  .replace('"./smicOpening"', JSON.stringify(calendar))));

test("DISK uses the last completed New York close across DST, weekends, and shortened sessions", () => {
  assert.deepEqual(model.latestDiskCashClose(Date.parse("2026-11-10T01:50:00Z")), {
    date: "2026-11-09", at: Date.parse("2026-11-09T21:00:00Z"),
  });
  assert.deepEqual(model.latestDiskCashClose(Date.parse("2026-10-19T17:00:00Z")), {
    date: "2026-10-16", at: Date.parse("2026-10-16T20:00:00Z"),
  });
  assert.deepEqual(model.latestDiskCashClose(Date.parse("2026-11-27T19:00:00Z")), {
    date: "2026-11-27", at: Date.parse("2026-11-27T18:00:00Z"),
  });
});

test("a verified regular-close price can precede publication of the daily candle", () => {
  const at = Date.parse("2026-11-09T21:00:00Z");
  const chart = {
    meta: {
      symbol: "DISK", currency: "USD", regularMarketPrice: 24.45,
      regularMarketTime: at / 1000, currentTradingPeriod: { regular: { end: at / 1000 } },
    },
    timestamp: [Date.parse("2026-11-06T14:30:00Z") / 1000],
    indicators: { quote: [{ close: [22.83] }] },
  };
  assert.equal(model.regularEtfClose(chart, "2026-11-09", at), 24.45);
  chart.meta.regularMarketTime -= 60;
  assert.equal(model.regularEtfClose(chart, "2026-11-09", at), null);
  assert.equal(model.readEtfChart({ chart: { result: [chart] } }, "DRAM"), null);
});

test("only completed, current DRAM minute closes can be cash references", () => {
  const now = Date.parse("2026-11-10T00:59:38Z");
  const chart = {
    timestamp: ["00:55", "00:58", "00:59"].map((time) => Date.parse(`2026-11-10T${time}:00Z`) / 1000),
    indicators: { quote: [{ close: [41.5, 41.44, 42.1] }] },
  };
  assert.deepEqual(model.latestDramMinute(chart, now, now - 6 * 60_000), {
    price: 41.44, at: Date.parse("2026-11-10T00:59:00Z"),
  });
  assert.equal(model.latestDramMinute(chart, now + 5 * 60_000, now - 6 * 60_000), null);
});

test("the fitted DRAM return implies a DISK fair price and distinct bid and ask deviations", () => {
  const anchor = { date: "2026-11-06", at: 100, disk: 22.83, dram: 39.29 };
  const reference = { source: "futu", price: 39.76, base: 39.29, at: 200 };
  const book = { bid: 23.25, ask: 23.35, mid: 23.30, at: 200 };
  const sample = model.diskCashSnapshot(201, anchor, book, reference);
  assert.equal(sample.fair.toFixed(2), "23.11");
  assert.ok(sample.bidDeviation < sample.deviation && sample.deviation < sample.askDeviation);
  assert.equal(model.diskCashSnapshot(201, anchor, book, { ...reference, at: 99 }).deviation, null);
  assert.equal(model.diskCashSnapshot(201, anchor, book, null).fair, null);
});

test("the Blog quote uses a fresh DRAM cash book from the existing office relay", async () => {
  const now = Date.parse("2026-11-10T01:50:00Z");
  const at = Date.parse("2026-11-09T21:00:00Z");
  const env = { SITE_PASSWORD: "", FUTU_PUSH_TOKEN: "fixture-token" };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const originalFetch = globalThis.fetch;
  const originalClock = Date.now;
  const priorPush = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const requests = [];
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.pathname);
    if (url.hostname === "api.bitget.com" && url.pathname.endsWith("/tickers")) {
      return Response.json({ code: "00000", data: [{ symbol: "DISKUSDT", bidPr: "24.44", askPr: "24.63", ts: String(now) }] });
    }
    if (url.hostname.startsWith("query") && url.searchParams.get("interval") === "1d") {
      const symbol = url.pathname.split("/").at(-1);
      return Response.json({ chart: { result: [{ meta: {
        symbol, currency: "USD", regularMarketTime: at / 1000, regularMarketPrice: symbol === "DISK" ? 24.45 : 41.78,
        currentTradingPeriod: { regular: { end: at / 1000 } },
      } }] } });
    }
    throw new Error(`Unexpected source ${url.hostname}${url.pathname}`);
  };
  try {
    const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
    const push = await worker.fetch(new Request("http://localhost/api/hk-auction/ingest", {
      method: "POST",
      headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
      body: JSON.stringify({ generatedAt: now, quotes: [
        { symbol: "US.DRAM", bid: 41.4, ask: 41.48, bidSize: 100, askSize: 100, marketTimestamp: now - 1000 },
      ] }),
    }), env, ctx);
    assert.equal(push.status, 202);
    const response = await worker.fetch(new Request("http://localhost/api/blog/disk-fair"), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const quote = await response.json();
    assert.equal(quote.reference.source, "futu");
    assert.equal(quote.reference.price.toFixed(2), "41.44");
    assert.equal(quote.fair.toFixed(3), "24.246");
    assert.ok(quote.book, `No Bitget book from requests: ${requests.join(", ")}`);
    assert.equal(quote.deviation.toFixed(3), "1.192");
  } finally {
    globalThis.__FUTU_PUSH_SNAPSHOT__ = priorPush;
    globalThis.fetch = originalFetch;
    Date.now = originalClock;
  }
});
