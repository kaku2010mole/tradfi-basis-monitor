import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const url = text => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(text)).toString('base64');
const gdrUrl = url(await read('../app/lib/honHaiGdr.ts'));
const { honHaiGdrComparison: compare, parseHonHaiGdr: parse, HON_HAI_GDR } = await import(gdrUrl);
const serverUrl = url((await read('../app/lib/honHaiGdrMarket.ts')).replace('from "./honHaiGdr"', `from ${JSON.stringify(gdrUrl)}`));
const { createHonHaiGdrClient, pushedHonHaiGdr } = await import(serverUrl);
const now = Date.parse('2026-10-27T22:00:00+08:00');
const book = { bid: 8, ask: 8.1, last: 999, index: 999, timestamp: now };
const quote = { symbol: 'HNHPF', bid: 15.8, ask: 15.9, last: 999, timestamp: now, source: 'fixture BBO' };
const fixture = (time = now) => ({ chart: { result: [{ meta: { symbol: 'HNHPF', currency: 'USD', instrumentType: 'EQUITY', regularMarketPrice: 15.85, regularMarketTime: time / 1000 } }] } });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Hon Hai is a 2-share GDR; prices, midpoint and directional percentages scale consistently', () => {
  assert.equal(HON_HAI_GDR.sharesPerGdr, 2);
  const value = compare('HONHAIUSDT', book, quote, now);
  assert.equal(value.impliedBid, 16); assert.equal(value.impliedAsk, 16.2);
  assert.ok(Math.abs(value.reference - 15.85) < 1e-10);
  assert.ok(Math.abs(value.deviation - (16.1 / 15.85 - 1) * 100) < 1e-10);
  assert.ok(Math.abs(value.buyGdrSellPerp - (16 / 15.9 - 1) * 100) < 1e-10);
  assert.ok(Math.abs(value.buyPerpSellGdr - (15.8 / 16.2 - 1) * 100) < 1e-10);
  assert.equal(value.status, 'INDICATIVE BBO');
  assert.equal(compare('MEDIATEKUSDT', book, quote, now), null);
  assert.equal(compare('TWTSMUSDT', book, quote, now), null);
});

test('missing, delayed, stale and invalid inputs never become executable opportunities', () => {
  const last = parse(fixture(now - 18 * 3600000), now);
  assert.equal(last.bid, null); assert.equal(last.ask, null);
  const stale = compare('HONHAIUSDT', book, last, now);
  assert.equal(stale.status, 'STALE REFERENCE'); assert.notEqual(stale.deviation, null);
  assert.equal(stale.currentBooks, false); assert.equal(stale.buyGdrSellPerp, null);
  assert.equal(compare('HONHAIUSDT', book, parse(fixture(), now), now).status, 'LAST REFERENCE');
  assert.equal(compare('HONHAIUSDT', book, null, now).impliedBid, 16);
  assert.equal(compare('HONHAIUSDT', book, null, now).deviation, null);
  for (const bad of [{ ...book, timestamp: now - 61000 }, { ...book, timestamp: now + 6000 }, { ...book, bid: 9 }, { ...book, ask: null }, { ...book, bid: Infinity }]) {
    const value = compare('HONHAIUSDT', bad, quote, now);
    assert.equal(value.deviation, null); assert.equal(value.currentBooks, false);
  }
  for (const bad of [{ ...quote, symbol: 'TSM' }, { ...quote, timestamp: now + 6000 }, { ...quote, timestamp: now - 8 * 86400000 }]) assert.equal(compare('HONHAIUSDT', book, bad, now).deviation, null);
  assert.equal(compare('HONHAIUSDT', book, { ...quote, bid: 17 }, now).currentBooks, false);
});

test('Yahoo identity, currency and original quote time are validated', () => {
  assert.equal(parse(fixture(), now).timestamp, now);
  for (const time of [0, now + 6000, now - 8 * 86400000]) assert.equal(parse(fixture(time), now), null);
  for (const [key, value] of [['symbol', 'HNHAY'], ['currency', 'TWD'], ['instrumentType', 'CURRENCY'], ['regularMarketPrice', 0]]) {
    const data = fixture(); data.chart.result[0].meta[key] = value; assert.equal(parse(data, now), null);
  }
});

test('slow GDR requests never block perp polling; viewers share 60s cache and retained timestamps', async () => {
  let t = now, calls = 0, release, failed = false;
  const get = createHonHaiGdrClient({ clock: () => t, pushed: () => null, fetcher: async () => {
    calls++; if (failed) return new Response('private body', { status: 429, headers: { 'Retry-After': '600' } });
    await new Promise(resolve => { release = resolve; }); return Response.json(fixture(t));
  } });
  for (let i = 0; i < 50; i++) { const value = get(); assert.equal(value.quote, null); assert.equal(value.refreshing, true); }
  assert.equal(calls, 1); release(); await flush();
  assert.equal(get().quote.timestamp, now);
  t += 59999; get(); assert.equal(calls, 1);
  t++; failed = true; get(); await flush();
  assert.equal(calls, 2); assert.equal(get().quote.timestamp, now);
  assert.ok(!JSON.stringify(get()).includes('private body'));
  t += 599999; get(); assert.equal(calls, 2);
  t++; get(); await flush(); assert.equal(calls, 3);
});

test('existing office HNHPF BBO takes precedence without OAuth or substituting other receipts', async () => {
  const prior = globalThis.__FUTU_PUSH_SNAPSHOT__;
  try {
    globalThis.__FUTU_PUSH_SNAPSHOT__ = { payload: { quotes: [{ symbol: 'US.HNHAY', bid: 10, ask: 11, marketTimestamp: now }] } };
    assert.equal(pushedHonHaiGdr(now), null);
    globalThis.__FUTU_PUSH_SNAPSHOT__.payload.quotes.push({ symbol: 'US.HNHPF', bid: 15.8, ask: 15.9, marketTimestamp: now });
    assert.equal(pushedHonHaiGdr(now).bid, 15.8);
    let calls = 0;
    const get = createHonHaiGdrClient({ clock: () => now, fetcher: async () => { calls++; throw Error('should not fetch'); } });
    assert.equal(get().quote.bid, 15.8); assert.equal(calls, 0);
    globalThis.__FUTU_PUSH_SNAPSHOT__.payload.quotes[1].marketTimestamp += 6000;
    assert.equal(pushedHonHaiGdr(now), null);
  } finally { globalThis.__FUTU_PUSH_SNAPSHOT__ = prior; }
});

test('feed reconnect retains HNHPF without moving its timestamp or overwriting it with older data', async () => {
  const { mergeTaiwanFeed } = await import(url(await read('../app/lib/taiwanFeedState.ts')));
  const old = { rows: [], honHaiGdr: { quote, error: null } };
  for (const next of [{ rows: [] }, { rows: [], honHaiGdr: { quote: null, error: 'outage' } }, { rows: [], honHaiGdr: { quote: { ...quote, timestamp: now - 1 }, error: null } }]) {
    assert.equal(mergeTaiwanFeed(old, next).honHaiGdr.quote, quote);
  }
});

test('rendered GDR detail is explicit, compact, timestamped and not called an ADR', async () => {
  const fmtUrl = url(await read('../app/lib/numberFormat.ts'));
  const code = ts.transpileModule(await read('../app/components/HonHaiGdrCard.tsx'), { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext } }).outputText
    .replace('"../lib/honHaiGdr"', JSON.stringify(gdrUrl)).replace('"../lib/numberFormat"', JSON.stringify(fmtUrl))
    .replace('import styles from "./TaiwanCashCard.module.css";', 'const styles = new Proxy({}, {get: (_, k) => String(k)});');
  const { default: Card } = await import(url(`import React from ${JSON.stringify(import.meta.resolve('react'))};\n${code}`));
  const html = renderToStaticMarkup(React.createElement(Card, { book, now, feed: { quote: parse(fixture(now - 3600000), now), error: null } }));
  assert.match(html, /HNHPF vs HONHAIUSDT/); assert.match(html, /1 HNHPF GDR = 2 TWSE 2317/);
  assert.match(html, /16\.000 \/ 16\.200/); assert.match(html, /STALE REFERENCE/);
  assert.match(html, /not a live edge/); assert.match(html, /multiplier unverified/);
  assert.doesNotMatch(html, /ADR|Buy GDR · sell perp/);
});
