import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const additions = ['034020', '035420', '042700', '066570', '454910'];
const source = await readFile(new URL('../services/futu-pusher/posley-adr-pusher.mjs', import.meta.url), 'utf8');
const decoder = source.slice(0, source.indexOf('let pushing = false;'))
  .replace('import { readFile } from "node:fs/promises";', 'const readFile = async () => "x".repeat(32);')
  .replace('const TOKEN_FILE = process.env.FUTU_PUSH_TOKEN_FILE;', 'const TOKEN_FILE = "test-only";');
const { quoteFromEntry, selectKoreanQuote, KEY_GROUPS } = await import('data:text/javascript;base64,' +
  Buffer.from(decoder + '\nexport { quoteFromEntry, selectKoreanQuote, KEY_GROUPS };').toString('base64'));
const now = Date.parse('2026-10-27T07:40:00Z');
const futu = (code = '035420') => quoteFromEntry({
  key: `orderbook:futu:web_api:KR.${code}`,
  fields: { bids: '180100,209', asks: '180200,44', bids_receive_ts_ms: String(now), asks_receive_ts_ms: String(now),
    last_tick_ts_ms: String(now - 100), specific_data: '{"session":"after_hours","market":"KR","source":"futu_web_api_ws"}' },
});

test('all five previously IBKR-only stocks subscribe to actual Futu after-hours streams', () => {
  assert.equal(new Set(KEY_GROUPS.flat()).size, 42);
  assert.ok(KEY_GROUPS.every(g => g.length <= 25));
  for (const code of additions) {
    assert.ok(KEY_GROUPS.flat().includes(`orderbook:futu:web_api:KR.${code}`));
    const q = futu(code);
    assert.equal(q.symbol, `KRX.${code}`);
    assert.equal(q.source, 'Posley Futu Web API');
    assert.equal(q.marketState, 'AFTER-HOURS');
    assert.equal(q.marketTimestamp, now);
    assert.equal(q.bid, 180100); assert.equal(q.ask, 180200);
    assert.equal(q.bidSize, 209); assert.equal(q.askSize, 44);
  }
  assert.ok(KEY_GROUPS.flat().includes('orderbook:ibkr:STK:035420:KRX:KRW'));
});

test('old IBKR heartbeats and newer last-only prints cannot replace fresh Futu BBOs', () => {
  const book = futu();
  const heartbeat = quoteFromEntry({ key: 'orderbook:ibkr:STK:035420:KRX:KRW',
    fields: { bids: '174300,0', asks: '174300,0', last_price: '174300',
      last_tick_ts_ms: String(now - 3600000), event_emit_ts_ms: String(now + 1000),
      specific_data: '{"stale":"true"}' } });
  assert.equal(heartbeat.marketTimestamp, now - 3600000);
  assert.equal(selectKoreanQuote(book, heartbeat, now), book);
  assert.equal(selectKoreanQuote(book, { ...heartbeat, marketTimestamp: now + 1000 }, now + 1000), book);
  assert.equal(selectKoreanQuote(heartbeat, book, now), book);
  // Legitimate side deletion on the selected source is not hidden.
  const oneSided = { ...book, ask: null, askSize: null, marketTimestamp: now + 1 };
  assert.equal(selectKoreanQuote(book, oneSided, now + 1), oneSided);
  const resumedIbkr = { ...book, streamKey: heartbeat.streamKey, marketTimestamp: now + 120000 };
  assert.equal(selectKoreanQuote(book, resumedIbkr, now + 120000), resumedIbkr);
  // A stale feed remains stale; no time or side is synthesized.
  assert.equal(selectKoreanQuote(book, heartbeat, now + 120000).marketTimestamp, now);
});

test('remote discovery prefers verified Korean Futu streams independently of directory order', async () => {
  const text = await readFile(new URL('../app/lib/posleyAdr.ts', import.meta.url), 'utf8');
  const { streamPriority, symbolForStream } = await import('data:text/javascript;base64,' +
    Buffer.from(stripTypeScriptTypes(text) + '\nexport { streamPriority, symbolForStream };').toString('base64'));
  for (const code of additions) {
    const keys = [`orderbook:ibkr:STK:${code}:KRX:KRW`, `orderbook:futu:web_api:KR.${code}`];
    for (const order of [keys, [...keys].reverse()]) {
      order.sort((a, b) => streamPriority(b) - streamPriority(a));
      assert.equal(order[0], `orderbook:futu:web_api:KR.${code}`);
      assert.equal(symbolForStream(order[0], new Set([code])), code);
    }
  }
});

test('after-hours BBO passes authenticated ingest and produces two-way cash/FX/perp basis', async () => {
  const { default: worker } = await import('../dist/server/index.js');
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  await worker.fetch(new Request('http://localhost/basis'), { ASSETS: { fetch: async () => new Response('', { status: 404 }) } }, ctx);
  const originalFetch = globalThis.fetch, clock = Date.now, previous = globalThis.__FUTU_PUSH_SNAPSHOT__;
  Date.now = () => now;
  delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  globalThis.fetch = async url => {
    if (String(url).includes('api.bitget.com')) return Response.json({ code: '00000', data: [
      { symbol: 'NAVERUSDT', bidPr: '137', askPr: '138', bidSz: '20', askSz: '30', ts: String(now) },
    ] });
    if (String(url).includes('fapi.binance.com')) return Response.json([]);
    throw new Error('Unexpected upstream');
  };
  try {
    const ingest = await worker.fetch(new Request('http://localhost/api/hk-auction/ingest', {
      method: 'POST', headers: { Authorization: 'Bearer after-hours-test' },
      body: JSON.stringify({ generatedAt: now, quotes: [futu(), { symbol: 'FX.USDKRW', bid: 1320, ask: 1321, bidSize: 1, askSize: 1, marketTimestamp: now }] }),
    }), { FUTU_PUSH_TOKEN: 'after-hours-test' }, ctx);
    assert.equal(ingest.status, 202);
    const response = await worker.fetch(new Request('http://localhost/api/oracle-monitor/korean-bitget'), {}, ctx);
    assert.equal(response.status, 200);
    const data = await response.json(), row = data.rows.find(r => r.code === '035420');
    assert.equal(row.session, 'AFTER-HOURS'); assert.equal(row.cashFeedSession, 'AFTER-HOURS');
    assert.equal(row.cashSource, 'Posley Futu Web API');
    assert.equal(row.cashBidKrw, 180100); assert.equal(row.cashAskKrw, 180200);
    assert.equal(row.cashUpdatedAt, now);
    assert.equal(row.venues[0].buyKoreaSellPerp, (137 / (180200 / 1320) - 1) * 100);
    assert.equal(row.venues[0].buyPerpSellKorea, ((180100 / 1321) / 138 - 1) * 100);
    assert.equal(data.rows.filter(r => r.market === 'TSE').length, 12);
  } finally {
    globalThis.fetch = originalFetch; Date.now = clock;
    if (previous) globalThis.__FUTU_PUSH_SNAPSHOT__ = previous; else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  }
});
