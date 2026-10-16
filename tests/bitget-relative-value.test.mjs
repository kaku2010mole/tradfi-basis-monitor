import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const moduleFrom = async (file) => import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(await readFile(new URL(file, import.meta.url), "utf8"))).toString("base64"));
const config = await moduleFrom("../app/lib/relativeValue.ts");
const market = await moduleFrom("../app/lib/bitgetRelativeMarket.ts");
const ids = ["kodex200-kr200", "disk-soxl", "disk-dram", "euv-lyte", "ibb-xbi"];

test("exactly five monitor pairs; dedicated Korean pages do not depend on array positions", () => {
  assert.deepEqual(config.RELATIONSHIPS.map((r) => r.id), ids);
  for (const r of config.RELATIONSHIPS.slice(1)) {
    assert.equal(r.asset1.venue, "bitget");
    assert.equal(r.asset2.venue, "bitget");
    assert.equal(r.referenceBeta, null);
  }
  assert.deepEqual(config.SKHYNIX_7709_CHOICES.map((r) => r.id), ["skhynix-csop2l", "skhynix-csop2l-futu"]);
  assert.deepEqual(config.SAMSUNG_7747_CHOICES.map((r) => r.id), ["samsung-csop2l", "samsung-csop2l-futu"]);
});

test("Bitget midpoint rejects stale, crossed, missing and non-finite books", () => {
  const now = Date.now();
  const good = { bidPr: "100", askPr: "102", ts: String(now), lastPr: "999" };
  assert.equal(market.bitgetMidpoint(good, now), 101);
  for (const override of [{ bidPr: "0" }, { askPr: "99" }, { askPr: "NaN" }, { ts: String(now - 31_000) }, { ts: String(now + 10_000) }]) {
    assert.equal(market.bitgetMidpoint({ ...good, ...override }, now), null);
  }
  assert.equal(market.bitgetMidpoint(undefined, now), null);
});

test("Bitget history paginates on exact boundaries, sorts and preserves real gaps", async () => {
  const original = globalThis.fetch;
  const step = 60_000, start = 1_780_000_020_000, end = start + step * 249;
  const cursors = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const cursor = Number(parsed.searchParams.get("endTime"));
    cursors.push(cursor);
    assert.equal(parsed.searchParams.get("granularity"), "1m");
    const rows = Array.from({ length: 250 }, (_, i) => [String(start + i * step), "1", "1", "1", String(10 + i)]);
    return Response.json({ code: "00000", data: rows.filter((r) => Number(r[0]) < cursor).slice(-200).reverse() });
  };
  try {
    const rows = await market.bitgetSeries("TESTUSDT", start, end, "1m");
    assert.equal(rows.length, 250);
    assert.equal(rows[0].t, start);
    assert.equal(rows.at(-1).t, end);
    assert.equal(cursors[1], start + 50 * step);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].t - rows[i - 1].t, step);
    assert.deepEqual(await market.bitgetSeries("TESTUSDT", start, end, "1m"), rows);
    assert.equal(cursors.length, 2, "cached history should not repeat requests");
    globalThis.fetch = async () => Response.json({ code: "00000", data: [[start, "", "", "", "10"], [start + step * 2, "", "", "", "12"]] });
    assert.equal((await market.bitgetSeries("GAPUSDT", start, start + step * 2, "1m")).length, 2);
  } finally { globalThis.fetch = original; }
});

test("Bitget request failure is retried on next call; hourly request uses 1H", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).searchParams.get("granularity"), "1H");
    if (++calls === 1) return Response.json({ code: "429", msg: "rate limit" });
    return Response.json({ code: "00000", data: [] });
  };
  try {
    await assert.rejects(market.bitgetSeries("RETRYUSDT", 1_780_000_000_000, 1_780_001_000_000, "1h"), /rate limit/);
    assert.deepEqual(await market.bitgetSeries("RETRYUSDT", 1_780_000_000_000, 1_780_001_000_000, "1h"), []);
  } finally { globalThis.fetch = original; }
});

test("a Binance outage does not mark Bitget contracts as missing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: "00000", data: [{ symbol: "DISKUSDT" }, { symbol: "SOXLUSDT" }] });
  try {
    const scan = await market.relativeUniverse(config.RELATIONSHIPS, async () => { throw new Error("offline"); });
    assert.equal(scan.candidates.find((r) => r.id === "disk-soxl").available, true);
    assert.equal(scan.candidates.find((r) => r.id === "kodex200-kr200").available, null);
    assert.equal(scan.candidates.find((r) => r.id === "disk-dram").available, false);
  } finally { globalThis.fetch = original; }
});

test("transient Bitget rate limits retry without losing a history page", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response("rate limited", { status: 429 })
    : Response.json({ code: "00000", data: [[1_780_000_020_000, "", "", "", "42"]] });
  try {
    const rows = await market.bitgetSeries("LIMITUSDT", 1_780_000_020_000, 1_780_000_080_000, "1m");
    assert.deepEqual(rows, [{ t: 1_780_000_020_000, value: 42 }]);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("page resets legacy pair preferences and wires Bitget through server, fallback and alerts", async () => {
  const page = await readFile(new URL("../app/blog/page.tsx", import.meta.url), "utf8");
  assert.match(page, /relative-value-custom-relationships-v2-etf/);
  assert.match(page, /relative-value-hidden-relationships-v2-etf/);
  assert.match(page, /perpRelationship \?\? "kodex200-kr200"/);
  assert.match(page, /bitgetLivePrice\(leg.symbol\)/);
  assert.match(page, /bitgetSeries\(leg.symbol, start, end, interval\)/);
  const api = await readFile(new URL("../app/api/blog/analysis/route.ts", import.meta.url), "utf8");
  assert.match(api, /SKHYNIX_7709_PERP/);
  assert.match(api, /SAMSUNG_7747_PERP/);
  assert.match(api, /bitgetSeries\(leg.symbol, start, end, interval\)/);
});

test("rendered monitor has only the requested pair buttons; Bitget ranking survives other venues failing", async () => {
  const { default: worker } = await import("../dist/server/index.js");
  const env = { ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };
  const rendered = await worker.fetch(new Request("http://localhost/blog"), env, context);
  const html = await rendered.text();
  for (const title of ["KODEX200 → KR200", "DISK ↔ SOXL", "DISK ↔ DRAM", "EUV ↔ LYTE", "IBB ↔ XBI"]) assert.ok(html.includes(title));
  assert.doesNotMatch(html, /SMH → SOXL|QQQ → USTECH|BABAUSDT ↔ HK.09988/);
  const original = globalThis.fetch;
  const now = Date.now(), start = Math.floor((now - 3_600_000) / 60_000) * 60_000;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith("https://api.bitget.com/")) throw new Error("other venue offline");
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/tickers")) return Response.json({ code: "00000", data: [
      { symbol: "DISKUSDT", bidPr: "109", askPr: "111", ts: String(Date.now()) },
      { symbol: "SOXLUSDT", bidPr: "119", askPr: "121", ts: String(Date.now()) },
    ] });
    return Response.json({ code: "00000", data: [[start, "100", "100", "100", "100"]] });
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/blog/ranking", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start, end: now, relationships: [config.RELATIONSHIPS[0], { ...config.RELATIONSHIPS[1], referenceBeta: 1 }] }),
    }), env, context);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.rankings.length, 1);
    assert.equal(data.rankings[0].id, "disk-soxl");
    assert.ok(Math.abs(data.rankings[0].predictionError - 10) < 1e-8);
  } finally { globalThis.fetch = original; }
});
