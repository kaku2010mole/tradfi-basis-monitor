import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const moduleUrl = text => "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(text)).toString("base64");
const cashUrl = moduleUrl(await readFile(new URL("../app/lib/taiwanCash.ts", import.meta.url), "utf8"));
const basisUrl = moduleUrl(await readFile(new URL("../app/lib/taiwanStockBasis.ts", import.meta.url), "utf8"));
const model = await import(cashUrl);
const server = (await readFile(new URL("../app/lib/fugleTaiwanMarket.ts", import.meta.url), "utf8"))
  .replace('"./taiwanCash"', JSON.stringify(cashUrl)).replace('"./taiwanStockBasis"', JSON.stringify(basisUrl));
const { createTaiwanCashClient } = await import(moduleUrl(server));
const at = text => Date.parse(text + "+08:00");
const now = at("2026-10-20T08:45:00");
const raw = (symbol = "2330", t = now) => ({ symbol, exchange: "TWSE", type: "EQUITY", date: "2026-10-20", previousClose: 100, referencePrice: 100,
  lastPrice: 102, lastTrade: { price: 99, size: 20, time: (t - 180000) * 1000 },
  lastTrial: { price: 102, size: 50, time: t * 1000 }, isTrial: true, lastUpdated: t * 1000,
  bids: [{ price: 101, size: 5 }], asks: [{ price: 103, size: 6 }] });
const anchor = { price: 10, timestamp: at("2026-10-19T14:00:00") };
const book = { bid: 10.2, ask: 10.4, timestamp: now };

test("Fugle identity, microsecond clock, quantities and bounded five-level books are validated", () => {
  const q = model.parseTaiwanCash(raw(), "2330", now);
  assert.equal(q.timestamp, now);
  assert.equal(q.trial.price, 102);
  assert.equal(q.last.price, 99, "lastPrice includes trial; do not treat it as executed trade");
  assert.equal(q.trial.size, 50);
  assert.equal(model.fugleTime(now, now), null);
  for (const patch of [{ symbol: "2308" }, { exchange: "TPEX" }, { date: "2026-10-19" }, { lastUpdated: (now + 60000) * 1000 }, { type: "INDEX" }])
    assert.equal(model.parseTaiwanCash({ ...raw(), ...patch }, "2330", now), null);
  assert.equal(model.parseTaiwanCash({ ...raw(), bids: Array(10).fill({ price: 101, size: -1 }) }, "2330", now).bids.length, 5);
  assert.equal(model.parseTaiwanCash({ ...raw(), lastTrial: { price: 102, time: (now - 86400000) * 1000 } }, "2330", now).trial, null);
});

test("current trial is separate from historical trial; freshness is observation-based", () => {
  const q = model.parseTaiwanCash(raw(), "2330", now);
  assert.equal(model.taiwanCashView(q, now).price, 102);
  assert.equal(model.taiwanCashView({ ...q, isTrial: false }, now).price, 99);
  assert.equal(model.taiwanCashView({ ...q, fetchedAt: now + 150000 }, now + 150000).fresh, false, "fetching an old observation cannot make it fresh");
  assert.equal(model.taiwanCashView(q, now + 86400000).phase, "LAST SESSION");
  assert.equal(model.taiwanCashView({ ...q, isTrial: false, isClose: true }, now).phase, "CLOSED");
});

test("pre-open reference uses trial return once, preserves oracle units and rejects unsafe inputs", () => {
  const q = model.parseTaiwanCash(raw(), "2330", now);
  const compare = (quote = q, a = anchor, b = book, t = now) => model.taiwanAuctionComparison(quote, a, b, t);
  const result = compare();
  assert.equal(result.reference, 10.2);
  assert.ok(Math.abs(result.trialReturn - 2) < 1e-10);
  assert.ok(Math.abs(result.deviation - (10.3 / 10.2 - 1) * 100) < 1e-10);
  for (const patch of [{ isTrial: false }, { trial: null }, { isHalted: true }, { timestamp: now - 121000 }, { fetchedAt: now - 121000 }, { referencePrice: 99 }, { previousClose: null }, { trial: { ...q.trial, timestamp: now - 121000 } }])
    assert.equal(compare({ ...q, ...patch }).reference, null);
  assert.equal(compare(q, null).reference, null);
  assert.equal(compare(q, anchor, { ...book, ask: 10 }).reference, null);
  assert.equal(compare(q, anchor, { ...book, timestamp: now - 61000 }).reference, null);
  assert.equal(compare(q, anchor, book, at("2026-10-20T09:00:00")).reference, null);
  const delayedNow = at("2026-10-20T09:01:00");
  const delayed = model.parseTaiwanCash({ ...raw("2330", delayedNow), isDelayedOpen: true }, "2330", delayedNow);
  assert.ok(compare(delayed, anchor, { ...book, timestamp: delayedNow }, delayedNow).reference);
});

test("many viewers share eight requests/min, stale-while-refresh, no secret output, independent failure retention", async () => {
  let t = now, count = 0, fail = false, gate;
  const get = createTaiwanCashClient({ getKey: () => "test-private-key", clock: () => t, fetcher: async (url, options) => {
    count++;
    assert.equal(options.headers["X-API-KEY"], "test-private-key");
    assert.ok(!url.includes("test-private-key"));
    if (gate) await gate;
    if (fail) throw new Error("Never echo test-private-key or this upstream exception");
    return Response.json(raw(url.split("/").pop(), t));
  } });
  const initial = await Promise.all(Array.from({ length: 30 }, () => get()));
  assert.equal(count, 8);
  assert.equal(Object.keys(initial[0].quotes).length, 8);
  assert.ok(!JSON.stringify(initial).includes("test-private-key"));
  t += 59999;
  await get(); assert.equal(count, 8);
  t++;
  let release;
  gate = new Promise(resolve => { release = resolve; });
  fail = true;
  const retained = await get();
  assert.equal(count, 16);
  assert.equal(retained.quotes["2330"].timestamp, now, "serve prior quote immediately while refreshing");
  await Promise.all(Array.from({ length: 30 }, () => get()));
  assert.equal(count, 16);
  release(); await new Promise(resolve => setImmediate(resolve));
  const outage = await get();
  assert.equal(outage.quotes["2330"].timestamp, now);
  assert.equal(outage.quotes["2330"].fetchedAt, now);
  assert.equal(outage.errors["2330"], "Fugle quote temporarily unavailable");
  assert.ok(!JSON.stringify(outage).includes("test-private-key"));
});

test("missing credentials make zero calls; auth and quota errors back off without leaking bodies", async () => {
  let t = now, count = 0;
  const missing = createTaiwanCashClient({ getKey: () => undefined, fetcher: async () => { throw new Error("should not fetch"); } });
  assert.equal((await missing()).configured, false);
  for (const status of [401, 429]) {
    count = 0; t = now;
    const get = createTaiwanCashClient({ getKey: () => "test", clock: () => t, fetcher: async () => {
      count++; return new Response("sensitive upstream body", { status, headers: { "Retry-After": "300" } });
    } });
    assert.ok(!JSON.stringify(await get()).includes("sensitive"));
    t += 60000; await get(); assert.equal(count, 8);
    t += 240000; await get(); assert.equal(count, 16);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test("UI retains the existing model, adds an indicative trial comparison and never imports the credential-bearing client", async () => {
  const panel = await readFile(new URL("../app/components/TaiwanStockPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /taiwanComparison\(row, tsm, clock\)/);
  assert.match(panel, /taiwanAuctionComparison\(cash, row.anchor, row.book, clock\)/);
  assert.match(panel, /perp 2s \/ cash 60s/);
  assert.doesNotMatch(panel, /FUGLE_API_KEY|fugleTaiwanMarket/);
});
