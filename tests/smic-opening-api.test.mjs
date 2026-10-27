import assert from 'node:assert/strict';
import test from 'node:test';

test('SMIC page and authenticated real ETF feed update the forecast without freezing the signal',async()=>{
  const {default:worker}=await import('../dist/server/index.js');
  const ctx={waitUntil(){},passThroughOnException(){}};
  const page=await worker.fetch(new Request('http://localhost/smic-opening'),{ASSETS:{fetch:async()=>new Response('',{status:404})}},ctx);
  assert.equal(page.status,200);assert.match(await page.text(),/SMIC opening outlook/);
  const oldFetch=globalThis.fetch,oldSnapshot=globalThis.__FUTU_PUSH_SNAPSHOT__,oldState=globalThis.__SMIC_OPENING_MARKET__,oldClock=Date.now;
  const now=Date.parse('2026-10-27T11:00:00+08:00');Date.now=()=>now;
  globalThis.fetch=async()=>{throw new Error('History intentionally offline: exercise retained research data.');};
  delete globalThis.__SMIC_OPENING_MARKET__;
  try{
    const push=async(bid,ask,timestamp=now,symbol='US.SMH')=>{
      const response=await worker.fetch(new Request('http://localhost/api/hk-auction/ingest',{method:'POST',headers:{Authorization:'Bearer smic-test-ingest'},body:JSON.stringify({generatedAt:now,quotes:[{symbol,bid,ask,bidSize:10,askSize:10,marketTimestamp:timestamp}]})}),{FUTU_PUSH_TOKEN:'smic-test-ingest'},ctx);
      return response;
    };
    const get=async()=>{const r=await worker.fetch(new Request('http://localhost/api/smic-opening'),{},ctx);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store, max-age=0');return r.json();};
    assert.equal((await push(541,542)).status,202);
    const first=await get();assert.equal(first.target.date,'2026-10-28');assert.equal(first.smhAnchor.date,'2026-10-26');
    assert.equal(first.quote.price,541.5);assert.equal(first.quote.fresh,true);assert.ok(Number.isFinite(first.forecast.gap));
    assert.equal(first.hkAnchor,null);assert.equal(first.impliedOpen,null,'unfinished HK close must not be used as tomorrow\'s price anchor');
    assert.equal((await push(562,563)).status,202);
    const second=await get();assert.equal(second.quote.price,562.5);assert.notEqual(first.signal,second.signal);
    assert.ok(Math.abs(second.forecast.gap-first.forecast.gap-first.model.beta*(second.signal-first.signal))<1e-10);
    assert.equal(second.forecast.group.index,7);assert.equal(second.forecast.group.up,22);
    assert.equal((await push(562,563,now-60_000)).status,202);
    const stale=await get();assert.equal(stale.quote.fresh,false);assert.equal(stale.quote.timestamp,now-60_000);assert.ok(stale.forecast,'retain the dated estimate, mark it stale');
    assert.equal((await push(562,563,now,'US.SMHUSDT')).status,400,'reject a perpetual masquerading as the ETF');
    assert.equal((await push(562,563,now+60_000)).status,202);
    const future=await get();assert.equal(future.quote.price,null);assert.equal(future.signal,null);assert.equal(future.forecast,null,'future quote must not enter a forecast');
  }finally{
    globalThis.fetch=oldFetch;Date.now=oldClock;
    if(oldSnapshot)globalThis.__FUTU_PUSH_SNAPSHOT__=oldSnapshot;else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
    if(oldState)globalThis.__SMIC_OPENING_MARKET__=oldState;else delete globalThis.__SMIC_OPENING_MARKET__;
  }
});
