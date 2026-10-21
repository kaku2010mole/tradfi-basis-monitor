import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(await readFile(new URL('../app/lib/publicBinanceJson.ts', import.meta.url), 'utf8'));
const load = async (name) => import('data:text/javascript;base64,' + Buffer.from(source + `\n// ${name}`).toString('base64'));
const url = 'https://fapi.binance.com/fapi/v1/ticker/bookTicker';

test('concurrent quotes share network and parsing but never cache settled/stale snapshots', async () => {
  const { publicBinanceJson } = await load('concurrency');
  const original = globalThis.fetch;
  let finish, calls = 0, parses = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    await new Promise(resolve => { finish = resolve; });
    return { ok: true, json: async () => { parses++; return [{ symbol:'ELICEUSDT', time:123, bidPrice:'1.123456789', askPrice:'2.987654321' }]; } };
  };
  try {
    const requests = Array.from({length:20}, () => publicBinanceJson(url, 7000));
    assert.equal(calls,1);
    finish();
    const results = await Promise.all(requests);
    assert.equal(parses,1);
    assert.ok(results.every(result => result === results[0]));
    assert.equal(results[0][0].time,123);
    assert.equal(results[0][0].bidPrice,'1.123456789');
    const next = publicBinanceJson(url,7000);
    assert.equal(calls,2,'the very next poll starts a fresh fetch, with no added TTL');
    finish(); await next;
  } finally { globalThis.fetch = original; }
});

test('failures are released and different deadlines, symbols and private reads stay isolated', async () => {
  const { publicBinanceJson } = await load('failure');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', {status:503}); };
  try {
    const failures = await Promise.allSettled([publicBinanceJson(url,6000),publicBinanceJson(url,6000)]);
    assert.ok(failures.every(r => r.status === 'rejected'));
    assert.equal(calls,1);
    await assert.rejects(publicBinanceJson(url,6000), /503/);
    assert.equal(calls,2);
    globalThis.fetch = async () => { calls++; return Response.json([]); };
    await Promise.all([publicBinanceJson(url,6000),publicBinanceJson(url,7000),publicBinanceJson(url+'?symbol=BTCUSDT',6000)]);
    assert.equal(calls,5);
    for (const bad of [url+'?signature=private', url.replace('fapi.binance.com','other.example'), 'https://fapi.binance.com/fapi/v2/account', url.replace('https://','https://user:password@')]) {
      await assert.rejects(publicBinanceJson(bad,6000), /Only public/);
    }
    assert.equal(calls,5);
  } finally { globalThis.fetch = original; }
});

test('bounded in-flight storage never drops excess requests or holds failed parsing', async () => {
  const { publicBinanceJson } = await load('bounded');
  const original = globalThis.fetch;
  const finishes=[]; let calls=0;
  globalThis.fetch = async () => { calls++; await new Promise(r=>finishes.push(r)); return Response.json([]); };
  try {
    const requests=Array.from({length:130},(_,i)=>publicBinanceJson(url+'?symbol=S'+i,6000));
    requests.push(publicBinanceJson(url+'?symbol=S0',6000), publicBinanceJson(url+'?symbol=S129',6000));
    assert.equal(calls,131,'over capacity bypasses sharing, not the underlying request');
    finishes.forEach(fn=>fn()); await Promise.all(requests);
    globalThis.fetch=async()=>new Response('invalid json');
    await assert.rejects(publicBinanceJson(url,6000));
    globalThis.fetch=async()=>Response.json([{time:123}]);
    assert.deepEqual(await publicBinanceJson(url,6000),[{time:123}]);
  } finally { globalThis.fetch=original; }
});
