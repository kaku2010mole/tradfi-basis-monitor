import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
const load = async file => import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(await readFile(new URL(file, import.meta.url), "utf8"))).toString("base64"));
const { createMarketRefreshLease, waitForMarketRefresh } = await load("../app/lib/marketCacheRefresh.ts");
const { mergeTaiwanFeed } = await load("../app/lib/taiwanFeedState.ts");

test("one refresh lease survives brief tab switches and stops after five idle minutes", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let time = 1_000, count = 0;
  const lease = createMarketRefreshLease(async () => { count++; lease.schedule(time + 60_000); }, () => time);
  lease.touch();
  for (let i = 0; i < 30; i++) lease.schedule(time + 60_000);
  for (let i = 0; i < 10; i++) { time += 60_000; t.mock.timers.tick(60_000); }
  assert.equal(count, 4, "one timer, then no background work after idle expiry");
  lease.touch(); lease.schedule(time + 60_000);
  time += 60_000; t.mock.timers.tick(60_000); assert.equal(count, 5);
  lease.stop(); time += 60_000; t.mock.timers.tick(60_000); assert.equal(count, 5);
});

test("cold/resume refresh has a bounded wait and does not cancel shared work", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const started = performance.now(); await waitForMarketRefresh(pending, 10);
  assert.ok(performance.now() - started < 500);
  release(); await waitForMarketRefresh(pending);
});

test("partial server restart / older responses retain cash and FX observations without refreshing their clocks", () => {
  const quote = { timestamp: 100, fetchedAt: 105, bids: [{ price: 30 }], asks: [{ price: 31 }] };
  const row = { symbol: "TWTSMUSDT", book: { bid: 3, ask: 4, last: 3.5, timestamp: 100 } };
  const prior = { rows: [row], cash: { configured: true, quotes: { "2330": quote } }, fx: { quote: { price: 32, timestamp: 100, fetchedAt: 105 }, error: null } };
  const next = { rows: [{ ...row, book: { bid: null, ask: null, last: null, timestamp: null } }], cash: { configured: true, quotes: {}, refreshing: true }, fx: { quote: null, refreshing: true, error: null } };
  const retained = mergeTaiwanFeed(prior, next);
  assert.equal(retained.cash.quotes["2330"], quote);
  assert.equal(retained.fx.quote, prior.fx.quote);
  assert.equal(retained.rows[0].book, row.book);
  assert.equal(retained.cash.refreshing, true);
  const older = mergeTaiwanFeed(prior, { ...next, cash: { ...next.cash, quotes: { "2330": { ...quote, timestamp: 99 } } } });
  assert.equal(older.cash.quotes["2330"], quote);
  const newer = { ...quote, timestamp: 110, fetchedAt: 110 };
  const updated = mergeTaiwanFeed(prior, { ...next, cash: { ...next.cash, quotes: { "2330": newer } } });
  assert.equal(updated.cash.quotes["2330"], newer);
});
