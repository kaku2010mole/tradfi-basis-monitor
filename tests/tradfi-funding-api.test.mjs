import test from 'node:test';
import assert from 'node:assert/strict';

test('replaces the Japan page and protects the new funding API with the existing site login', async () => {
  const { default: worker } = await import('../dist/server/index.js');
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const page = await worker.fetch(new Request('http://localhost/japan-estimate'), { ASSETS: { fetch: async () => new Response('', { status: 404 }) } }, ctx);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /TradFi funding rates/);
  assert.match(html, /Highest 10/);
  assert.match(html, /Lowest 10/);
  assert.doesNotMatch(html, /Japanese stock estimates|KIOXIA REFERENCE/);
  const protectedApi = await worker.fetch(new Request('http://localhost/api/tradfi-funding'), { SITE_PASSWORD: 'fixture-password' }, ctx);
  assert.equal(protectedApi.status, 401);
});

test('coalesces viewers, refreshes rates without reloading instruments, and retains the original timestamp on failure', async () => {
  const { default: worker } = await import('../dist/server/index.js');
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const original = { fetch: globalThis.fetch, now: Date.now, cache: globalThis.__BITGET_TRADFI_FUNDING__ };
  let now = Date.parse('2026-11-12T06:00:00Z'), fail = false;
  const calls = [];
  Date.now = () => now;
  delete globalThis.__BITGET_TRADFI_FUNDING__;
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (fail) return new Response('', { status: 502 });
    if (url === 'https://api.bitget.com/api/v3/market/instruments?category=USDT-FUTURES') return Response.json({ code: '00000', requestTime: now, data: [
      { symbol: 'LGUSDT', isRwa: 'YES', status: 'online', type: 'perpetual', fullName: 'LG Energy', instrumentType: 'stock' },
      { symbol: 'UNITREEUSDT', isRwa: 'YES', status: 'online', type: 'perpetual', fullName: 'Unitree', instrumentType: 'stock' },
      { symbol: 'BTCUSDT', isRwa: 'NO', status: 'online', type: 'perpetual', instrumentType: 'crypto' },
    ] });
    if (url === 'https://api.bitget.com/api/v3/market/current-fund-rate?category=USDT-FUTURES') return Response.json({ code: '00000', requestTime: now - 500, data: [
      { symbol: 'LGUSDT', fundingRate: '.009', fundingRateInterval: '8', nextUpdate: String(now + 3600_000) },
      { symbol: 'UNITREEUSDT', fundingRate: '-.004', fundingRateInterval: '4', nextUpdate: String(now + 3600_000) },
      { symbol: 'BTCUSDT', fundingRate: '.01', fundingRateInterval: '8' },
    ] });
    throw Error('Unexpected URL ' + url);
  };
  const get = async () => {
    const response = await worker.fetch(new Request('http://localhost/api/tradfi-funding'), {}, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    return response.json();
  };
  try {
    const [first, same] = await Promise.all([get(), get(), get()]);
    assert.equal(calls.length, 2);
    assert.equal(first.universeCount, 2);
    assert.equal(first.rows.length, 2);
    assert.equal(first.timestamp, now - 500);
    assert.deepEqual(first, same);
    await get(); assert.equal(calls.length, 2);
    now += 20_000;
    const refreshed = await get();
    assert.equal(calls.length, 3);
    assert.equal(calls.filter(u => u.includes('/instruments?')).length, 1);
    assert.equal(refreshed.timestamp, now - 500);
    fail = true; now += 20_000;
    const retained = await get();
    assert.equal(retained.stale, true);
    assert.equal(retained.timestamp, refreshed.timestamp);
    assert.deepEqual(retained.rows, refreshed.rows);
    assert.match(retained.error, /original time/);
    const attempts = calls.length;
    await get(); assert.equal(calls.length, attempts, 'failed snapshots also share the retry backoff');
    delete globalThis.__BITGET_TRADFI_FUNDING__;
    const cold = await worker.fetch(new Request('http://localhost/api/tradfi-funding'), {}, ctx);
    assert.equal(cold.status, 503);
  } finally {
    globalThis.fetch = original.fetch; Date.now = original.now;
    if (original.cache) globalThis.__BITGET_TRADFI_FUNDING__ = original.cache;
    else delete globalThis.__BITGET_TRADFI_FUNDING__;
  }
});
