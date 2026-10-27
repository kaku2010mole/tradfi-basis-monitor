import assert from 'node:assert/strict';
import test from 'node:test';

test('both HK assets use actual stock streams, session-specific opening anchors, fixed closes and honest quote ages', async () => {
  const {default: worker} = await import('../dist/server/index.js');
  const ctx = {waitUntil(){}, passThroughOnException(){}};
  const oldFetch=globalThis.fetch, oldClock=Date.now, oldSnapshot=globalThis.__FUTU_PUSH_SNAPSHOT__, oldState=globalThis.__HK_PEER_OPENING_MARKET__;
  let now=Date.parse('2026-10-27T12:00:00+08:00'); Date.now=()=>now;
  globalThis.fetch=async()=>{throw new Error('History offline in test.');}; delete globalThis.__HK_PEER_OPENING_MARKET__;
  const push=async(peer, s=542, p=300, t=now)=>worker.fetch(new Request('http://localhost/api/hk-auction/ingest',{method:'POST',headers:{Authorization:'Bearer peer-ingest-test'},body:JSON.stringify({generatedAt:now,quotes:[{symbol:'US.SMH',bid:s-.1,ask:s+.1,marketTimestamp:t},{symbol:`US.${peer}`,bid:p-.1,ask:p+.1,marketTimestamp:t}]})}),{FUTU_PUSH_TOKEN:'peer-ingest-test'},ctx);
  const get=async(asset)=>{const response=await worker.fetch(new Request(`http://localhost/api/peer-opening?asset=${asset}`),{},ctx);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store, max-age=0');return response.json();};
  try {
    const invalid=await worker.fetch(new Request('http://localhost/api/peer-opening?asset=other'),{},ctx); assert.equal(invalid.status,400);
    for (const [asset,peer,count] of [['zhongji','LITE',58],['gigadev','MU',183]]) {
      now=Date.parse('2026-10-27T12:00:00+08:00'); assert.equal((await push(peer)).status,202);
      const pre=await get(asset); assert.equal(pre.target.date,'2026-10-28'); assert.equal(pre.phase,'preopen_assumption'); assert.equal(pre.peer.return,null); assert.equal(pre.peer.effectiveReturn,0); assert.equal(pre.model.n,count); assert.ok(pre.forecast);
      await push(peer,542,400); assert.equal((await get(asset)).forecast.gap,pre.forecast.gap,'premarket stock quote is not the regular-session factor');
      const state=globalThis.__HK_PEER_OPENING_MARKET__[asset]; state.bars[pre.config.yahoo]=state.bars[pre.config.yahoo].map(b=>b.date==='2026-10-27'?{...b,complete:false}:b);
      assert.equal((await get(asset)).impliedOpen,null,'incomplete HK close cannot anchor the implied opening price');
      now=Date.parse('2026-10-27T22:00:00+08:00'); await push(peer); assert.equal((await get(asset)).forecast,null,'no previous-session opening substitution');
      state.bars[peer].push({date:'2026-10-27',open:290,close:300,complete:false});
      const live=await get(asset); assert.equal(live.phase,'live_session'); assert.ok(live.fresh); assert.ok(Math.abs(live.peer.return-100*(300/290-1))<1e-8);
      await push(peer,543,305); const moved=await get(asset); assert.ok(Math.abs(moved.forecast.gap-live.forecast.gap-live.model.smhBeta*(moved.signal-live.signal)-live.model.peerBeta*(moved.peer.return-live.peer.return))<1e-8);
      await push(peer,543,305,now-60_000);const stale=await get(asset);assert.equal(stale.fresh,false);assert.equal(stale.peerQuote.timestamp,now-60_000);assert.ok(stale.forecast);
      assert.equal((await push(`${peer}USDT`)).status,400);
      now=Date.parse('2026-10-28T06:00:00+08:00');await push(peer);assert.equal((await get(asset)).phase,'waiting_close');
      state.bars[peer]=state.bars[peer].map(b=>b.date==='2026-10-27'?{...b,close:310,complete:true}:b);
      const fixed=await get(asset);assert.equal(fixed.phase,'regular_close');assert.equal(fixed.smhAnchor.date,'2026-10-26');
      await push(peer,542,350);assert.equal((await get(asset)).peer.return,fixed.peer.return,'after-hours stock quotes cannot rewrite the completed intraday return');
      await push(peer,542,350,now+60_000);assert.equal((await get(asset)).forecast,null,'future timestamps rejected');
    }
  } finally {
    globalThis.fetch=oldFetch;Date.now=oldClock;
    if(oldSnapshot)globalThis.__FUTU_PUSH_SNAPSHOT__=oldSnapshot;else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
    if(oldState)globalThis.__HK_PEER_OPENING_MARKET__=oldState;else delete globalThis.__HK_PEER_OPENING_MARKET__;
  }
});
