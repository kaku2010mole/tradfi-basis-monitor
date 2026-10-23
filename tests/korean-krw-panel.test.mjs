import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const dataUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const helperUrl = dataUrl(stripTypeScriptTypes(await readFile(new URL('../app/lib/koreanPerpKrw.ts', import.meta.url), 'utf8')));
const { koreanPerpKrw, koreanDate } = await import(helperUrl);
const previousSource = stripTypeScriptTypes(await readFile(new URL('../app/lib/koreanPreviousClose.ts', import.meta.url), 'utf8')).replace('"./koreanPerpKrw"', JSON.stringify(helperUrl));
const { parseKoreanPreviousClose, koreanPreviousClose } = await import(dataUrl(previousSource));
const now = Date.parse('2026-10-23T06:00:00Z');
const naver = (code = '000270', direction = '5', delta = '-500') => ({ itemCode: code, closePrice: '100,000', compareToPreviousClosePrice: delta, compareToPreviousPrice: { code: direction }, localTradedAt: '2026-10-23T15:00:00+09:00' });

test('KRW conversion uses cash previous close, respects share ratios, and never invents missing sides', () => {
  const result = koreanPerpKrw(75, 77, 1, 1400, 100000);
  assert.deepEqual(result, { bidKrw: 105000, askKrw: 107800, midpointKrw: 106400,
    bidChangePct: (1.05 - 1) * 100, askChangePct: (1.078 - 1) * 100, midpointChangePct: (1.064 - 1) * 100 });
  assert.equal(koreanPerpKrw(150, 154, 2, 1400, 100000).midpointKrw, result.midpointKrw);
  assert.ok(koreanPerpKrw(60, 62, 1, 1400, 100000).midpointChangePct < 0);
  for (const bad of [0, -1, null, undefined, NaN, Infinity]) {
    assert.equal(koreanPerpKrw(75, 77, 1, 1400, bad).midpointChangePct, null);
    assert.equal(koreanPerpKrw(75, 77, 1, bad, 100000).midpointKrw, null);
  }
  assert.equal(koreanPerpKrw(75, 77, 0, 1400, 100000).bidKrw, null);
  assert.equal(koreanPerpKrw(75, null, 1, 1400, 100000).bidKrw, 105000);
  assert.equal(koreanPerpKrw(75, null, 1, 1400, 100000).midpointChangePct, null);
  assert.equal(koreanPerpKrw(77, 75, 1, 1400, 100000).midpointChangePct, null);
});

test('fallback close correctly decodes rising, falling and flat cash snapshots with dates', () => {
  for (const direction of ['1', '2']) assert.equal(parseKoreanPreviousClose(naver('000270', direction, '500'), '000270', now).price, 99500);
  for (const direction of ['4', '5']) assert.equal(parseKoreanPreviousClose(naver('000270', direction), '000270', now).price, 100500);
  assert.equal(parseKoreanPreviousClose(naver('000270', '3', '0'), '000270', now).price, 100000);
  assert.equal(parseKoreanPreviousClose(naver(), '000270', now).sessionDate, '2026-10-23');
  for (const bad of [naver('035720'), naver('000270', '9'), naver('000270', '3', '5'), { ...naver(), localTradedAt: 'invalid' }, { ...naver(), localTradedAt: '2026-10-24T15:00:00+09:00' }, { ...naver(), closePrice: null }]) assert.equal(parseKoreanPreviousClose(bad, '000270', now), null);
  assert.equal(parseKoreanPreviousClose(naver(), '000270', now + 8 * 86400_000), null);
  assert.equal(koreanDate(Date.parse('2026-10-23T15:01:00Z')), '2026-10-24');
});

test('direct Posley parsing forwards previous close without altering the orderbook', async () => {
  const source = stripTypeScriptTypes(await readFile(new URL('../app/lib/posleyAdr.ts', import.meta.url), 'utf8'));
  const { acceptBook } = await import(dataUrl(source + '\nexport { acceptBook };'));
  const key = 'orderbook:ibkr:STK:035420:KRX:KRW';
  const state = { books: new Map(), streamBySymbol: new Map([['035420', key]]), wanted: new Set(['035420']) };
  for (const field of ['prev_close', 'previous_close']) {
    acceptBook(state, key, { bids: '172900,10', asks: '173000,12', last_price: '172900', [field]: '176400', bids_receive_ts_ms: String(now), asks_receive_ts_ms: String(now) });
    assert.equal(state.books.get('035420').previousClose, 176400);
    assert.equal(state.books.get('035420').bid, 172900);
    assert.equal(state.books.get('035420').timestamp, now);
  }
});

test('cash fallback is non-blocking, coalesced, cached and refreshes after the Korean date changes', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let count = 0, stamp = now, resolveFetch;
  Date.now = () => stamp;
  globalThis.fetch = async () => { count++; return new Promise(resolve => { resolveFetch = resolve; }); };
  try {
    assert.equal(koreanPreviousClose('000270', 101000, now, 'Posley', now).price, 101000);
    assert.equal(count, 0);
    for (let i = 0; i < 20; i++) assert.equal(koreanPreviousClose('000270', null, now, 'Posley', now), null);
    await Promise.resolve(); assert.equal(count, 1);
    resolveFetch(Response.json(naver())); await new Promise(resolve => setImmediate(resolve));
    assert.equal(koreanPreviousClose('000270', null, now, 'Posley', now).price, 100500);
    for (let i = 0; i < 20; i++) koreanPreviousClose('000270', null, now, 'Posley', now + 2000);
    assert.equal(count, 1);
    stamp = Date.parse('2026-10-23T15:01:00Z');
    assert.equal(koreanPreviousClose('000270', null, null, 'Posley', stamp).sessionDate, '2026-10-23');
    await Promise.resolve(); assert.equal(count, 2);
    resolveFetch(Response.json({ ...naver(), localTradedAt: '2026-10-24T00:00:00+09:00' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(koreanPreviousClose('000270', null, null, 'Posley', stamp).sessionDate, '2026-10-24');
    assert.equal(koreanPreviousClose('../../invalid', null, null, 'Posley', stamp), null);
    globalThis.fetch = () => { count++; throw new Error('offline'); };
    koreanPreviousClose('035720', null, null, 'Posley', stamp);
    await new Promise(resolve => setImmediate(resolve));
    const calls = count;
    koreanPreviousClose('035720', null, null, 'Posley', stamp + 2000);
    await Promise.resolve(); assert.equal(count, calls); // no retry per 2s quote poll
    stamp += 61000; koreanPreviousClose('035720', null, null, 'Posley', stamp);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(count, calls + 1);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('independent table displays all venues, three decimals and explicit old/missing reference states', async () => {
  const source = await readFile(new URL('../app/components/KoreanKrwPanel.tsx', import.meta.url), 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext } }).outputText
    .replace('"../lib/koreanPerpKrw"', JSON.stringify(helperUrl))
    .replace('import styles from "./KoreanKrwPanel.module.css";', 'const styles = new Proxy({}, { get: (_, key) => String(key) });');
  js = `import React from ${JSON.stringify(import.meta.resolve('react'))};\n` + js;
  const { default: Panel } = await import(dataUrl(js));
  const rows = [{ code: '035420', name: 'NAVER', sharesPerPerp: 1, previousClose: { price: 100000, source: 'Posley', observedAt: now, sessionDate: '2026-10-23' }, venues: ['Bitget', 'Binance'].map(venue => ({ venue, symbol: 'NAVERUSDT', bid: 75, ask: 77, updatedAt: now })) }];
  const conversion = { rate: 1400, live: true, updatedAt: now, source: 'Posley USD/KRW', date: null };
  const render = (r = rows, fx = conversion) => renderToStaticMarkup(React.createElement(Panel, { rows: r, conversion: fx, now }));
  const html = render();
  assert.match(html, /105,000\.000 \/ 107,800\.000/); assert.match(html, /\+6\.400%/);
  assert.match(html, /Bitget/); assert.match(html, /Binance/); assert.match(html, /CURRENT PERP/);
  assert.match(render([{ ...rows[0], previousClose: null }]), /Previous close unavailable/);
  assert.match(render([{ ...rows[0], previousClose: { ...rows[0].previousClose, sessionDate: '2026-10-22' } }]), /OLDER REFERENCE/);
  assert.match(render(rows, { ...conversion, live: false, source: 'Daily reference' }), /REFERENCE \/ STALE/);
  const monitor = await readFile(new URL('../app/components/KoreanPerpMonitor.tsx', import.meta.url), 'utf8');
  assert.ok(monitor.indexOf('<KoreanKrwPanel') > monitor.indexOf('{koreaRows.map(renderRow)}'));
  assert.ok(monitor.indexOf('<KoreanKrwPanel') < monitor.indexOf('{japanRows.length > 0'));
  assert.match(monitor, /const POLL_MS = 2_000/);
  assert.doesNotMatch(source, /setInterval|fetch\(|useEffect/);
});

test('previous close reaches the existing quote API without changing cash/perp edges', async () => {
  const { default: worker } = await import('../dist/server/index.js');
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  await worker.fetch(new Request('http://localhost/basis'), { ASSETS: { fetch: async () => new Response('', { status: 404 }) } }, ctx);
  const originalFetch = globalThis.fetch, originalNow = Date.now, previous = globalThis.__FUTU_PUSH_SNAPSHOT__;
  Date.now = () => now;
  delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  globalThis.fetch = async url => {
    if (String(url).includes('api.bitget.com')) return Response.json({ code: '00000', data: [{ symbol: 'ELICEUSDT', bidPr: '70', askPr: '71', bidSz: '10', askSz: '12', ts: String(now) }] });
    if (String(url).includes('fapi.binance.com')) return Response.json([]);
    if (String(url).includes('m.stock.naver.com')) return new Response('', { status: 503 });
    throw new Error('Unexpected URL');
  };
  try {
    const quotes = [{ symbol: 'KRX.0158S0', bid: 93400, ask: null, bidSize: 10, askSize: null, last: 93400, previousClose: 93600, marketTimestamp: now }, { symbol: 'FX.USDKRW', bid: 1330, ask: 1332, marketTimestamp: now }];
    const push = await worker.fetch(new Request('http://localhost/api/hk-auction/ingest', { method: 'POST', headers: { Authorization: 'Bearer test-krw-token' }, body: JSON.stringify({ generatedAt: now, quotes }) }), { FUTU_PUSH_TOKEN: 'test-krw-token' }, ctx);
    assert.equal(push.status, 202);
    const response = await worker.fetch(new Request('http://localhost/api/oracle-monitor/korean-bitget'), {}, ctx);
    const payload = await response.json(), row = payload.rows.find(r => r.code === '0158S0');
    assert.equal(row.previousClose.price, 93600); assert.equal(row.previousClose.sessionDate, '2026-10-23');
    assert.equal(row.cashAskKrw, null); assert.equal(row.venues[0].buyKoreaSellPerp, null);
    assert.equal(payload.krwConversion.rate, 1331); assert.equal(payload.rows.filter(r => r.market === 'KRX').length, 11);
    assert.ok(payload.rows.filter(r => r.market === 'TSE').every(r => !Object.hasOwn(r, 'previousClose')));
    await new Promise(resolve => setImmediate(resolve));
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; if (previous) globalThis.__FUTU_PUSH_SNAPSHOT__ = previous; else delete globalThis.__FUTU_PUSH_SNAPSHOT__; }
});
