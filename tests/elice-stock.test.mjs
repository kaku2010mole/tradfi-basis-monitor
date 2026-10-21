import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

test('Elice uses the verified alphanumeric KOSDAQ stream and retains original heartbeat time', async () => {
  const source = await readFile(new URL('../services/futu-pusher/posley-adr-pusher.mjs', import.meta.url), 'utf8');
  const decoder = source.slice(0, source.indexOf('let pushing = false;'))
    .replace('import { readFile } from "node:fs/promises";', 'const readFile = async () => "x".repeat(32);')
    .replace('const TOKEN_FILE = process.env.FUTU_PUSH_TOKEN_FILE;', 'const TOKEN_FILE = "test-only";');
  const m = await import('data:text/javascript;base64,' + Buffer.from(decoder + '\nexport { quoteFromEntry, KEY_GROUPS };').toString('base64'));
  const key = 'orderbook:ibkr:STK:0158S0:KRX:KRW';
  assert.equal(m.KEY_GROUPS.flat().filter(k => k === key).length, 1);
  assert.ok(m.KEY_GROUPS.every(g => g.length <= 25));
  const timestamp = Date.now() - 120_000;
  const fields = { bids: '79900,101297', asks: '', last_price: '79900', prev_close: '61500',
    bids_receive_ts_ms: String(timestamp), asks_receive_ts_ms: String(timestamp),
    last_tick_ts_ms: String(timestamp), event_emit_ts_ms: String(Date.now()) };
  for (const specific_data of [undefined, '{"stale":"true","publish_reason":"heartbeat"}']) {
    const quote = m.quoteFromEntry({ key, fields: { ...fields, specific_data } });
    assert.equal(quote.symbol, 'KRX.0158S0');
    assert.equal(quote.bid, 79900); assert.equal(quote.bidSize, 101297);
    assert.equal(quote.ask, null); assert.equal(quote.askSize, null);
    assert.equal(quote.last, 79900); assert.equal(quote.marketTimestamp, timestamp);
  }
  const adr = await readFile(new URL('../app/lib/posleyAdr.ts', import.meta.url), 'utf8');
  const remote = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(adr) + '\nexport { normalizeSymbols, symbolForStream };').toString('base64'));
  assert.equal(remote.symbolForStream(key, new Set(remote.normalizeSymbols(['0158S0']))), '0158S0');
});

test('Elice cash basis never invents a missing ask, including outside regular hours', async () => {
  const source = await readFile(new URL('../app/lib/equityBasis.ts', import.meta.url), 'utf8');
  const { equityBasis, equitySpreads } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
  for (const preferLast of [false, true]) {
    const basis = equityBasis({ bid: 79900, ask: null, last: 79900 }, { bid: 1330, ask: 1332 }, 1, preferLast, true);
    assert.equal(basis.cashBidUsd, 79900 / 1332); assert.equal(basis.cashAskUsd, null);
    const spread = equitySpreads(basis.cashBidUsd, basis.cashAskUsd, { bid: 59.8, ask: 59.9 });
    assert.equal(spread.buyKoreaSellPerp, null);
    assert.equal(spread.buyPerpSellKorea, (79900 / 1332 / 59.9 - 1) * 100);
    const lastOnly = equityBasis({ last: 79900 }, { last: 1330 }, 1, preferLast, true);
    assert.equal(lastOnly.cashBidUsd, null); assert.equal(lastOnly.cashAskUsd, null);
  }
  // Existing instruments preserve their established last-price reference mode.
  assert.equal(equityBasis({ last: 79900 }, { last: 1330 }).cashAskUsd, 79900 / 1330);
});

test('authenticated Elice pushes clear removed sides and appear in the normal Korean group', async () => {
  const { default: worker } = await import('../dist/server/index.js');
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  await worker.fetch(new Request('http://localhost/basis'), { ASSETS: { fetch: async () => new Response('', { status: 404 }) } }, ctx);
  const previous = globalThis.__FUTU_PUSH_SNAPSHOT__, originalFetch = globalThis.fetch, clock = Date.now;
  const now = Date.parse('2026-10-21T08:30:00Z');
  Date.now = () => now;
  delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  globalThis.fetch = async url => {
    if (String(url).includes('api.bitget.com')) return Response.json({ code: '00000', data: [{ symbol: 'ELICEUSDT', bidPr: '59.8', askPr: '59.9', bidSz: '15', askSz: '20', ts: String(now) }] });
    if (String(url).includes('fapi.binance.com')) return Response.json([]);
    throw new Error(`Unexpected request: ${url}`);
  };
  const send = (quotes, token = 'test-elice-push') => worker.fetch(new Request('http://localhost/api/hk-auction/ingest', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ generatedAt: now, quotes }),
  }), { FUTU_PUSH_TOKEN: 'test-elice-push' }, ctx);
  const book = { symbol: 'KRX.0158S0', bid: 79900, ask: 80000, bidSize: 100, askSize: 2, last: 79900, marketTimestamp: now - 1000 };
  try {
    assert.equal((await send([book], 'wrong')).status, 401);
    assert.equal((await send([book, { symbol: 'FX.USDKRW', bid: 1330, ask: 1332, marketTimestamp: now }])).status, 202);
    assert.equal((await send([{ ...book, ask: null, askSize: null, marketTimestamp: now }])).status, 202);
    assert.equal((await send([book])).status, 202); // old two-sided book cannot reappear
    const response = await worker.fetch(new Request('http://localhost/api/oracle-monitor/korean-bitget'), {}, ctx);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const rows = payload.rows.filter(r => r.code === '0158S0');
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.name, 'Elice'); assert.equal(row.market, 'KRX'); assert.equal(row.currency, 'KRW');
    assert.equal(row.strictCashBook, true); assert.equal(row.cashUpdatedAt, now);
    assert.equal(row.cashBidKrw, 79900); assert.equal(row.cashAskKrw, null);
    assert.equal(row.venues.length, 1); assert.equal(row.venues[0].symbol, 'ELICEUSDT');
    assert.equal(row.venues[0].buyKoreaSellPerp, null);
    assert.equal(row.venues[0].buyPerpSellKorea, (79900 / 1332 / 59.9 - 1) * 100);
    assert.deepEqual(payload.bitgetOnlyKorean, []);
    assert.equal((await send([{ ...book, symbol: 'KRX.0158S1' }])).status, 400);
  } finally {
    Date.now = clock; globalThis.fetch = originalFetch;
    if (previous) globalThis.__FUTU_PUSH_SNAPSHOT__ = previous; else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  }
});
