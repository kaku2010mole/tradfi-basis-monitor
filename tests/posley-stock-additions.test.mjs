import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const korean = ['207940', '000270', '373220', '035720', '105560'];
const japanese = ['6976', '6981'];
const contracts = ['SSBIOLOGICSUSDT', 'KIAUSDT', 'LGENERGYUSDT', 'KAKAOUSDT', 'KBFGUSDT'];

test('remote discovery matches Futu KR keys and retains both FX names beyond 24 symbols', async () => {
  const source = await readFile(new URL('../app/lib/posleyAdr.ts', import.meta.url), 'utf8');
  const module = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source) + '\nexport { normalizeSymbols, symbolForStream };').toString('base64'));
  const requested = ['034020','035420','042700','066570','454910', ...korean,
    '285A','5802','6758','6857','6920',...japanese,'7203','8035','8306','9984','SONY','TM','MUFG','USDKRW','USDJPY'];
  assert.equal(requested.length, 26);
  assert.deepEqual(module.normalizeSymbols(requested), requested);
  for (const code of korean) assert.equal(module.symbolForStream(`orderbook:futu:web_api:KR.${code}`, new Set(requested)), code);
  for (const code of japanese) assert.equal(module.symbolForStream(`orderbook:ibkr:STK:${code}:TSEJ:JPY`, new Set(requested)), code);
});

test('office pusher maps the actual sources and does not refresh closed Japanese heartbeats', async () => {
  const source = await readFile(new URL('../services/futu-pusher/posley-adr-pusher.mjs', import.meta.url), 'utf8');
  // Isolate the real decoder/registry without starting sockets, timers or reading credentials.
  const decoder = source.slice(0, source.indexOf('let pushing = false;'))
    .replace('import { readFile } from "node:fs/promises";', 'const readFile = async () => "x".repeat(32);')
    .replace('const TOKEN_FILE = process.env.FUTU_PUSH_TOKEN_FILE;', 'const TOKEN_FILE = "test-only";');
  const m = await import('data:text/javascript;base64,' + Buffer.from(decoder + '\nexport { quoteFromEntry, KEY_GROUPS };').toString('base64'));
  assert.ok(m.KEY_GROUPS.every(group => group.length <= 25));
  assert.equal(m.KEY_GROUPS.flat().length, 32);
  const old = Date.now() - 3600000, now = Date.now();
  for (const code of korean) {
    const key = `orderbook:futu:web_api:KR.${code}`;
    assert.ok(m.KEY_GROUPS.flat().includes(key));
    const q = m.quoteFromEntry({key, fields:{bids:'100000,5|99900,10',asks:'100100,7',bids_receive_ts_ms:String(now),asks_receive_ts_ms:String(now),last_tick_ts_ms:String(old)}});
    assert.equal(q.symbol, `KRX.${code}`); assert.equal(q.bid, 100000); assert.equal(q.ask, 100100);
    assert.equal(q.bidSize, 5); assert.equal(q.askSize, 7); assert.equal(q.marketTimestamp, now);
    assert.equal(q.source, 'Posley Futu Web API');
  }
  for (const code of japanese) {
    const key = `orderbook:ibkr:STK:${code}:TSEJ:JPY`;
    assert.ok(m.KEY_GROUPS.flat().includes(key));
    const q = m.quoteFromEntry({key, fields:{bids:'7501,0',asks:'7501,0',last_price:'7501',last_tick_ts_ms:String(old),bids_receive_ts_ms:String(old),asks_receive_ts_ms:String(old),event_emit_ts_ms:String(now),specific_data:'{"stale":"true"}'}});
    assert.equal(q.symbol, `TSE.${code}`); assert.equal(q.bid, null); assert.equal(q.ask, null);
    assert.equal(q.last, 7501); assert.equal(q.marketTimestamp, old);
  }
});

test('new authenticated cash pushes promote all five Korean names out of conversion-only cards', async () => {
  const {default: worker} = await import('../dist/server/index.js');
  // Initialize vinext's fetch wrapper before installing the endpoint mocks.
  await worker.fetch(new Request('http://localhost/basis'), {ASSETS:{fetch:async()=>new Response('',{status:404})}}, {waitUntil(){},passThroughOnException(){}});
  const originalFetch = globalThis.fetch, previous = globalThis.__FUTU_PUSH_SNAPSHOT__, clock = Date.now;
  const stamp = Date.parse('2026-10-14T07:00:00Z');
  Date.now = () => stamp;
  delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  const mockFetch = async (url) => {
    if (String(url).includes('api.bitget.com')) return Response.json({code:'00000',data:contracts.map(symbol=>({symbol,bidPr:'75',askPr:'76',bidSz:'20',askSz:'30',ts:String(stamp)}))});
    if (String(url).includes('fapi.binance.com')) return Response.json([]);
    throw new Error(`Unexpected request: ${url}`);
  };
  globalThis.fetch = mockFetch;
  const ctx = {waitUntil(){},passThroughOnException(){}};
  try {
    const quotes = [
      ...korean.map(code=>({symbol:`KRX.${code}`,bid:100000,ask:100100,bidSize:5,askSize:7,last:null,marketTimestamp:stamp,source:'Posley Futu Web API'})),
      ...japanese.map(code=>({symbol:`TSE.${code}`,bid:null,ask:null,last:7501,marketTimestamp:stamp-3600000})),
      {symbol:'FX.USDKRW',bid:1349,ask:1351,last:1350,marketTimestamp:stamp},
    ];
    const push = await worker.fetch(new Request('http://localhost/api/hk-auction/ingest',{method:'POST',headers:{Authorization:'Bearer test-stock-ingest'},body:JSON.stringify({generatedAt:stamp,quotes})}),{FUTU_PUSH_TOKEN:'test-stock-ingest'},ctx);
    assert.equal(push.status,202);
    globalThis.fetch = mockFetch;
    const response = await worker.fetch(new Request('http://localhost/api/oracle-monitor/korean-bitget'),{},ctx);
    const data = await response.json();
    assert.equal(response.status,200,JSON.stringify(data));
    assert.deepEqual(data.bitgetOnlyKorean,[]);
    for (const [i,code] of korean.entries()) {
      const row = data.rows.find(r=>r.code===code);
      assert.equal(row.venues[0].symbol,contracts[i]); assert.equal(row.cashBidKrw,100000); assert.equal(row.cashAskKrw,100100);
      assert.equal(row.cashSource,'Posley Futu Web API'); assert.ok(row.chineseName);
      assert.equal(row.cashBidUsd,100000/1351); assert.equal(row.cashAskUsd,100100/1349);
      assert.equal(row.venues[0].buyKoreaSellPerp,(75/(100100/1349)-1)*100);
      assert.equal(row.session,'AFTER-HOURS');
    }
    for (const code of japanese) {
      const row = data.rows.find(r=>r.code===code);
      assert.equal(row.cashLast,7501); assert.equal(row.cashBidKrw,null); assert.equal(row.cashUpdatedAt,stamp-3600000);
    }
    const rejected = await worker.fetch(new Request('http://localhost/api/hk-auction/ingest',{method:'POST',headers:{Authorization:'Bearer test-stock-ingest'},body:JSON.stringify({generatedAt:stamp,quotes:[{symbol:'KRX.999999'}]})}),{FUTU_PUSH_TOKEN:'test-stock-ingest'},ctx);
    assert.equal(rejected.status,400);
  } finally { globalThis.fetch=originalFetch; Date.now=clock; if(previous)globalThis.__FUTU_PUSH_SNAPSHOT__=previous;else delete globalThis.__FUTU_PUSH_SNAPSHOT__; }
});
