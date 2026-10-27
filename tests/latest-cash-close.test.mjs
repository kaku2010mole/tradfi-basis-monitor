import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const dataUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const source = async path => stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8'));
const krwUrl = dataUrl(await source('../app/lib/koreanPerpKrw.ts'));
const krSource = (await source('../app/lib/koreanLatestClose.ts')).replace('"./koreanPerpKrw"', JSON.stringify(krwUrl));
const { parseKoreanLatestClose, koreanLatestClose } = await import(dataUrl(krSource));
const twModelUrl = dataUrl(await source('../app/lib/taiwanStockBasis.ts'));
const twConversionUrl = dataUrl(await source('../app/lib/taiwanPerpTwd.ts'));
const { latestTaiwanCashClose, TWSE_2026 } = await import(twModelUrl);
const { taiwanCashClose, taiwanPerpTwd } = await import(twConversionUrl);
const twSource = (await source('../app/lib/taiwanLatestClose.ts')).replace('"./taiwanStockBasis"', JSON.stringify(twModelUrl)).replace('"./taiwanPerpTwd"', JSON.stringify(twConversionUrl));
const { parseTaiwanDailyCloses, taiwanLatestCloses } = await import(dataUrl(twSource));
const at = text => Date.parse(text + '+08:00');
const krClose = at('2026-10-23T14:30:00');
const chart = (code = '035420') => ({ code, stockExchangeType: 'KRX', periodType: 'day', tradeBaseAt: '20261023', lastTradeBaseAt: '20261022', lastClosePrice: 176400,
  openTime: '20261023090000', closeTime: '20261023200000', priceInfos: [
    { localDateTime: '20261023152900', currentPrice: 173500 },
    { localDateTime: '20261023153000', currentPrice: 173600 },
    { localDateTime: '20261023154000', currentPrice: 173400 },
    { localDateTime: '20261023200000', currentPrice: 170000 },
  ] });

test('KRX switches exactly at completed 15:30 KST auction, never to after-hours latest', () => {
  const before = parseKoreanLatestClose(chart(), '035420', krClose - 1);
  assert.equal(before.price, 176400); assert.equal(before.closeDate, '2026-10-22');
  for (const now of [krClose, krClose + 4 * 3600000, krClose + 2 * 86400000]) {
    const ref = parseKoreanLatestClose(chart(), '035420', now);
    assert.equal(ref.price, 173600); assert.equal(ref.closeDate, '2026-10-23');
    assert.equal(ref.observedAt, krClose);
    assert.equal(ref.pendingCloseDate, undefined);
  }
  const missing = { ...chart(), priceInfos: chart().priceInfos.filter(b => !b.localDateTime.endsWith('153000')) };
  const pending = parseKoreanLatestClose(missing, '035420', krClose + 60000);
  assert.equal(pending.price, 176400); assert.equal(pending.pendingCloseDate, '2026-10-23');
  const special = parseKoreanLatestClose({ ...chart(), openTime: '20261023100000' }, '035420', krClose + 60000);
  assert.equal(special.price, 176400, 'non-standard session must not treat an intraday 15:30 print as close');
  for (const bad of [{ ...chart(), code: '000270' }, { ...chart(), stockExchangeType: 'NXT' }, { ...chart(), periodType: 'week' }]) assert.equal(parseKoreanLatestClose(bad, '035420', krClose), null);
  assert.equal(parseKoreanLatestClose(chart(), '035420', krClose - 2 * 86400000), null);
});

test('KRX cache coalesces and refreshes immediately across closing boundary without slowing BBO polls', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = krClose - 1000, calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => { calls++; return Response.json(chart()); };
  try {
    for (let i = 0; i < 20; i++) assert.equal(koreanLatestClose('035420', now), null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1); assert.equal(koreanLatestClose('035420', now).price, 176400);
    now = krClose;
    assert.equal(koreanLatestClose('035420', now).pendingCloseDate, '2026-10-23');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2); assert.equal(koreanLatestClose('035420', now).price, 173600);
    for (let i = 0; i < 30; i++) koreanLatestClose('035420', now + 2000);
    assert.equal(calls, 2);
    now += 601000;
    globalThis.fetch = async () => { calls++; throw Error('offline'); };
    assert.equal(koreanLatestClose('035420', now).price, 173600);
    await new Promise(resolve => setImmediate(resolve));
    koreanLatestClose('035420', now + 2000); await Promise.resolve();
    assert.equal(calls, 3);
    assert.equal(koreanLatestClose('bad-code', now), null);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('TWSE closing target rolls at 13:30, respects holidays/weekends and has no future anchor', () => {
  const close = date => new Date(latestTaiwanCashClose(at(date), [TWSE_2026])).toISOString();
  assert.equal(close('2026-10-23T13:29:59'), '2026-10-22T05:30:00.000Z');
  assert.equal(close('2026-10-23T13:30:00'), '2026-10-23T05:30:00.000Z');
  assert.equal(close('2026-10-26T15:00:00'), '2026-10-23T05:30:00.000Z');
  assert.equal(close('2026-10-27T08:30:00'), '2026-10-23T05:30:00.000Z');
  assert.equal(latestTaiwanCashClose(at('2027-10-27T15:00:00'), [TWSE_2026]), null);
});

const twClose = at('2026-10-23T13:30:00');
const cash = { code: '2330', date: '2026-10-23', previousClose: 2385, referencePrice: 2385, timestamp: twClose, fetchedAt: twClose,
  isClose: true, isTrial: false, isHalted: false, last: { price: 2400, timestamp: twClose, size: 10 } };
test('TWSE uses confirmed today close before previousClose; delayed/trial/after-hours never relabeled', () => {
  const read = (quote, now = twClose + 60000) => taiwanCashClose(quote, '2330', '2026-10-22', now);
  assert.equal(read(cash).price, 2400); assert.equal(read(cash).date, '2026-10-23');
  for (const patch of [{ isClose: false }, { isTrial: true }, { isHalted: true }, { last: { price: 2500, timestamp: twClose + 3600000 } }]) {
    const ref = read({ ...cash, ...patch, timestamp: twClose + 3600000 }, twClose + 3600000);
    assert.equal(ref.price, 2385); assert.equal(ref.date, '2026-10-22');
  }
  const old = { ...cash, date: '2026-10-22', timestamp: twClose - 86400000, last: { price: 2385, timestamp: twClose - 86400000 }, previousClose: 2420 };
  assert.equal(read(old).price, 2385); assert.equal(read(old).date, '2026-10-22');
  assert.equal(read({ ...cash, code: '2303' }), null);
  assert.equal(read(cash, twClose - 60000), null);
  assert.equal(read({ ...cash, timestamp: twClose - 86400000 }), null);
});

test('TWSE bulk close fallback is bounded, dated and coalesced; retained closes never go backwards', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  Date.now = () => twClose + 60000;
  const daily = [{ Code: '2330', Date: '1151023', ClosingPrice: '2,400.00' }, { Code: '2303', Date: '1151022', ClosingPrice: '125.50' }, { Code: '9999', Date: '1151023', ClosingPrice: '100' }];
  const parsed = parseTaiwanDailyCloses(daily, Date.now());
  assert.deepEqual(Object.keys(parsed), ['2303', '2330']);
  assert.equal(parsed['2330'].date, '2026-10-23');
  assert.equal(Object.keys(parseTaiwanDailyCloses(daily.slice(0, 1), twClose - 1)).length, 0);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(daily); };
  try {
    for (let i = 0; i < 20; i++) taiwanLatestCloses({}, '2026-10-23', '2026-10-22', Date.now());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    const refs = taiwanLatestCloses({}, '2026-10-23', '2026-10-22', Date.now());
    assert.equal(refs['2330'].price, 2400); assert.equal(refs['2303'].date, '2026-10-22');
    const old = { ...cash, date: '2026-10-22', timestamp: twClose - 86400000, last: { price: 2385, timestamp: twClose - 86400000 } };
    assert.equal(taiwanLatestCloses({ '2330': old }, '2026-10-23', '2026-10-22', Date.now())['2330'].price, 2400);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('TWD math keeps full precision, no model/ADR, missing/crossed/stale inputs remain honest', () => {
  const book = { bid: 70.123, ask: 70.456, timestamp: twClose };
  const fx = { price: 32.581, timestamp: twClose, fetchedAt: twClose };
  const result = taiwanPerpTwd(book, fx, 2385, twClose);
  assert.equal(result.bidTwd, 70.123 * 32.581);
  assert.equal(result.midpointChangePct, (((70.123 * 32.581 + 70.456 * 32.581) / 2) / 2385 - 1) * 100);
  assert.equal(result.perpFresh, true); assert.equal(result.fxFresh, true);
  assert.equal(taiwanPerpTwd(book, fx, null, twClose).midpointChangePct, null);
  assert.equal(taiwanPerpTwd({ ...book, bid: 80 }, fx, 2385, twClose).midpointTwd, null);
  assert.equal(taiwanPerpTwd(book, null, 2385, twClose).midpointTwd, null);
  assert.equal(taiwanPerpTwd(book, fx, 2385, twClose + 121000).fxFresh, false);
});

test('TWD panel labels latest close, pending date, precision and 0.5% color threshold', async () => {
  const raw = await readFile(new URL('../app/components/TaiwanTwdPanel.tsx', import.meta.url), 'utf8');
  const fmtUrl = dataUrl(await source('../app/lib/numberFormat.ts'));
  const js = ts.transpileModule(raw, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext } }).outputText
    .replace('"../lib/taiwanPerpTwd"', JSON.stringify(twConversionUrl)).replace('"../lib/numberFormat"', JSON.stringify(fmtUrl))
    .replace('import styles from "./KoreanKrwPanel.module.css";', 'const styles = new Proxy({}, {get: (_, k) => String(k)});');
  const { default: Panel } = await import(dataUrl(`import React from ${JSON.stringify(import.meta.resolve('react'))};\n${js}`));
  const render = (price = 100.6, date = '2026-10-23') => renderToStaticMarkup(React.createElement(Panel, {
    rows: [{ symbol: 'TWTSMUSDT', code: '2330', name: 'TSMC', chineseName: '台積電', book: { bid: price, ask: price, timestamp: twClose } }],
    payload: { fx: { quote: { price: 1, timestamp: twClose, fetchedAt: twClose } }, latestCloseDate: '2026-10-23', closes: { '2330': { price: 100, date, source: 'TWSE', adjusted: false } } }, now: twClose,
  }));
  assert.match(render(), /Latest cash close · TWD/); assert.match(render(), /Close date: 2026-10-23/);
  assert.match(render(), /100\.60 \/ 100\.60/); assert.match(render(), /\+0\.600%/);
  assert.match(render(), /class="change up"/); assert.match(render(100.49), /class="change neutral"/);
  assert.match(render(99), /class="change down"/); assert.match(render(101, '2026-10-22'), /OLDER REFERENCE · awaiting/);
  assert.doesNotMatch(raw, /fetch\(|useEffect|setInterval|taiwanComparison/);
});

test('lightweight Taiwan API retains all ten pairs and cash/FX, with no oracle/ADR history calls', async () => {
  const { default: worker } = await import('../dist/server/index.js');
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  await worker.fetch(new Request('http://localhost/stock-basis'), {}, ctx);
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  Date.now = () => twClose + 60000;
  const urls = [];
  globalThis.fetch = async input => {
    const url = String(input); urls.push(url);
    if (url.includes('holidaySchedule')) return Response.json({ stat: 'ok', queryYear: 2026, data: TWSE_2026.holidays.map(d => [d, '休市']) });
    if (url.includes('/tickers')) return Response.json({ code: '00000', data: [{ symbol: 'TWTSMUSDT', bidPr: '70', askPr: '71', ts: String(Date.now()) }] });
    if (url.includes('STOCK_DAY_ALL')) return Response.json([{ Code: '2330', Date: '1151023', ClosingPrice: '2400' }]);
    if (url.includes('chart/HNHPF')) return Response.json({ chart: { result: [{ meta: { symbol: 'HNHPF', currency: 'USD', instrumentType: 'EQUITY', regularMarketPrice: 15, regularMarketTime: Date.now() / 1000 } }] } });
    if (url.includes('TWD')) return Response.json({ chart: { result: [{ meta: { symbol: 'TWD=X', currency: 'TWD', instrumentType: 'CURRENCY', regularMarketPrice: 32.5, regularMarketTime: Date.now() / 1000 } }] } });
    throw Error('Unexpected request ' + url);
  };
  try {
    let response = await worker.fetch(new Request('http://localhost/api/stock-basis/taiwan?view=prices'), {}, ctx);
    await new Promise(resolve => setImmediate(resolve));
    response = await worker.fetch(new Request('http://localhost/api/stock-basis/taiwan?view=prices'), {}, ctx);
    const payload = await response.json();
    assert.equal(payload.rows.length, 10); assert.equal(payload.view, 'prices'); assert.equal(payload.fx.quote.price, 32.5);
    assert.equal(payload.latestCloseDate, '2026-10-23'); assert.equal(payload.closes['2330'].price, 2400);
    assert.equal(payload.honHaiGdr.quote.last, 15);
    assert.equal(payload.honHaiGdr.quote.bid, null, 'last trade is never invented as a BBO');
    assert.deepEqual(payload.rows.slice(-2).map(r => [r.symbol, r.code]), [['HONHAIUSDT', '2317'], ['MEDIATEKUSDT', '2454']]);
    assert.equal(payload.anchorTimestamp, null); assert.ok(payload.rows.every(r => r.anchor === null));
    assert.ok(!urls.some(u => /history-index|chart\/TSM|chart\/UMC/.test(u)));
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});
