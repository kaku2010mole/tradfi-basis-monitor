import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
const url = text => "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(text)).toString("base64");
const cashUrl = url(await readFile(new URL("../app/lib/taiwanCash.ts", import.meta.url), "utf8"));
const liveUrl = url((await readFile(new URL("../app/lib/taiwanLiveBasis.ts", import.meta.url), "utf8")).replaceAll('from "./taiwanCash"', `from ${JSON.stringify(cashUrl)}`));
const { taiwanLiveComparison: compare, parseTaiwanFx } = await import(liveUrl);
const refreshUrl = url(await readFile(new URL("../app/lib/marketCacheRefresh.ts", import.meta.url), "utf8"));
const serverUrl = url((await readFile(new URL("../app/lib/taiwanFxMarket.ts", import.meta.url), "utf8")).replace('from "./taiwanLiveBasis"', `from ${JSON.stringify(liveUrl)}`).replace('from "./marketCacheRefresh"', `from ${JSON.stringify(refreshUrl)}`));
const { createTaiwanFxClient } = await import(serverUrl);
const now = Date.parse("2026-10-20T10:00:00+08:00");
const fx = { price: 32, timestamp: now, fetchedAt: now, source: "test FX" };
const book = { bid: 10.1, ask: 10.2, last: 999, index: 999, timestamp: now };
const quote = { code: "2330", date: "2026-10-20", last: { price: 300, timestamp: now, size: 1 }, trial: { price: 350, timestamp: now - 3600000, size: 1 },
  bids: [{ price: 319, size: 5 }], asks: [{ price: 321, size: 5 }], isTrial: false, isClose: false, isDelayedOpen: false, isDelayedClose: false, isHalted: false, timestamp: now, fetchedAt: now, previousClose: 300, referencePrice: 290 };

test("live comparison uses cash BBO and independent FX, never oracle or ADR returns", () => {
  const live = compare(quote, book, fx, now);
  assert.equal(live.cashPrice, 320);
  assert.equal(live.reference, 10);
  assert.ok(Math.abs(live.deviation - 1.5) < 1e-10);
  assert.equal(live.direction, "PERP RICH");
  assert.equal(live.kind, "CASH BBO MID");
  assert.ok(Math.abs(live.buyCashSellPerp - (10.1 * 32 / 321 - 1) * 100) < 1e-10);
  assert.ok(Math.abs(live.buyPerpSellCash - (319 / (10.2 * 32) - 1) * 100) < 1e-10);
  assert.deepEqual(compare({ ...quote, previousClose: 1, referencePrice: 1 }, { ...book, index: 1 }, fx, now), live);
});
test("auction uses current trial, ignores simulated BBO and hides directional edges", () => {
  const trial = compare({ ...quote, isTrial: true, trial: { price: 352, timestamp: now, size: 1 } }, book, fx, now);
  assert.equal(trial.reference, 11);
  assert.equal(trial.kind, "TRIAL PRICE");
  assert.equal(trial.buyCashSellPerp, null);
  assert.equal(trial.buyPerpSellCash, null);
  assert.match(trial.status, /TRIAL/);
  assert.equal(compare({ ...quote, isTrial: true }, book, fx, now).deviation, null, "old trial cannot be refreshed by snapshot timestamp");
});
test("missing, stale, future and halted inputs suppress live spreads without hiding raw prices", () => {
  for (const q of [null, { ...quote, timestamp: now - 121000 }, { ...quote, fetchedAt: now - 121000 }, { ...quote, isHalted: true }, { ...quote, date: "2026-10-19" }, { ...quote, timestamp: now + 10000 }]) assert.equal(compare(q, book, fx, now).deviation, null);
  for (const b of [{ ...book, timestamp: now - 61000 }, { ...book, timestamp: now + 10000 }, { ...book, ask: 10 }, { ...book, bid: null }]) assert.equal(compare(quote, b, fx, now).deviation, null);
  for (const f of [null, { ...fx, price: 0 }, { ...fx, timestamp: now - 901000 }, { ...fx, fetchedAt: now - 121000 }, { ...fx, timestamp: now + 10000 }]) assert.equal(compare(quote, book, f, now).deviation, null);
  assert.equal(compare(quote, book, null, now).cashPrice, 320);
  const closed = compare({ ...quote, isClose: true }, book, fx, now);
  assert.match(closed.status, /CLOSED/); assert.equal(closed.buyCashSellPerp, null);
  const last = compare({ ...quote, bids: [], asks: [] }, book, fx, now);
  assert.equal(last.reference, 300 / 32); assert.equal(last.buyCashSellPerp, null);
});
const fxData = (t = now) => ({ chart: { result: [{ meta: { symbol: "TWD=X", currency: "TWD", instrumentType: "CURRENCY", regularMarketPrice: 32, regularMarketTime: t / 1000 } }] } });
test("USD/TWD identity and original market timestamp are checked", () => {
  assert.equal(parseTaiwanFx(fxData(), now).timestamp, now);
  const alias = fxData(); alias.chart.result[0].meta.symbol = "USDTWD=X";
  assert.equal(parseTaiwanFx(alias, now).price, 32);
  alias.chart.result[0].meta.symbol = "TWDUSD=X";
  assert.equal(parseTaiwanFx(alias, now), null);
  assert.equal(parseTaiwanFx(fxData(now + 60000), now), null);
  assert.equal(parseTaiwanFx(fxData(now - 8 * 86400000), now), null);
  const wrong = fxData(); wrong.chart.result[0].meta.symbol = "JPY=X";
  assert.equal(parseTaiwanFx(wrong, now), null);
});
test("one FX request per minute is shared; failure preserves original timestamp and rate limit backs off", async () => {
  let t = now, count = 0, rateLimited = false;
  const get = createTaiwanFxClient({ clock: () => t, fetcher: async () => { count++; return rateLimited ? new Response("private upstream", { status: 429 }) : Response.json(fxData(t)); } });
  const all = await Promise.all(Array.from({ length: 20 }, () => get()));
  assert.equal(count, 1); assert.equal(all[0].quote.timestamp, now);
  t += 59999; await get(); assert.equal(count, 1);
  t++; rateLimited = true; const retained = await get({ waitForRefresh: true });
  assert.equal(retained.quote.timestamp, now); assert.equal(count, 3);
  await new Promise(resolve => setImmediate(resolve));
  t += 60000; const failed = await get(); assert.equal(count, 3);
  assert.equal(failed.quote.timestamp, now); assert.ok(!JSON.stringify(failed).includes("private upstream"));
});

test("FX secondary endpoint accepts canonical USD/TWD and respects primary Retry-After", async () => {
  let t = now;
  const calls = [];
  const get = createTaiwanFxClient({ clock: () => t, fetcher: async address => {
    const host = new URL(address).hostname; calls.push(host);
    if (host.startsWith("query1")) return new Response("secret", { status: 429, headers: { "Retry-After": "600" } });
    const data = fxData(t); data.chart.result[0].meta.symbol = "USDTWD=X";
    return Response.json(data);
  } });
  let result = await get({ waitForRefresh: true });
  assert.equal(calls.length, 2); assert.equal(result.error, null);
  assert.match(result.quote.source, /secondary endpoint/);
  for (let i = 0; i < 9; i++) { t += 60_000; result = await get({ waitForRefresh: true }); }
  assert.equal(calls.filter(host => host.startsWith("query1")).length, 1);
  assert.equal(result.quote.timestamp, t);
  t += 60_000; await get({ waitForRefresh: true });
  assert.equal(calls.filter(host => host.startsWith("query1")).length, 2);
});

test("transient FX failures retry at 5/15/30/60 seconds without overwriting old timestamps", async () => {
  let t = now, failing = false, calls = 0;
  const get = createTaiwanFxClient({ clock: () => t, fetcher: async () => {
    calls++; if (failing) throw new Error("upstream private error");
    return Response.json(fxData(t));
  } });
  await get(); failing = true; t += 60_000;
  for (const delay of [5_000, 15_000, 30_000, 60_000]) {
    const result = await get({ waitForRefresh: true });
    assert.equal(result.quote.timestamp, now); assert.equal(result.quote.fetchedAt, now);
    assert.equal(result.nextRefreshAt, t + delay);
    assert.ok(!JSON.stringify(result).includes("upstream private"));
    const count = calls; t += delay - 1; await get(); assert.equal(calls, count); t++;
  }
  failing = false;
  const result = await get({ waitForRefresh: true });
  assert.equal(result.quote.timestamp, t); assert.equal(result.error, null);
});

test("slow FX recovery never blocks normal polling; resume waits for the same shared request", async () => {
  let t = now, release, calls = 0;
  let gate = null;
  const get = createTaiwanFxClient({ clock: () => t, fetcher: async () => {
    calls++; if (gate) await gate; return Response.json(fxData(t));
  } });
  await get(); t += 180_000;
  gate = new Promise(resolve => { release = resolve; });
  const retained = await get();
  assert.equal(retained.refreshing, true); assert.equal(retained.quote.timestamp, now);
  let resumed = false;
  const waits = get({ waitForRefresh: true }).then(result => { resumed = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, false); assert.equal(calls, 2);
  release(); const fresh = await waits;
  assert.equal(fresh.quote.timestamp, t); assert.equal(fresh.refreshing, false);
});

test("older FX responses cannot move the displayed observation backwards; fallback uses fresh data", async () => {
  let t = now, oldPrimary = false;
  const get = createTaiwanFxClient({ clock: () => t, fetcher: async address =>
    Response.json(fxData(oldPrimary && address.includes("query1.") ? now - 60_000 : t)) });
  await get(); oldPrimary = true; t += 60_000;
  const result = await get({ waitForRefresh: true });
  assert.equal(result.quote.timestamp, t); assert.match(result.quote.source, /secondary/);
});
